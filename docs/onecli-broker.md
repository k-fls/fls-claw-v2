# OneCLI credential broker

The MITM proxy is the credential boundary in front of every agent container.
Behind that boundary, two credential-management models meet:

| | **Local providers** | **Broker (OneCLI)** |
|---|---|---|
| Source | per-group local store / OAuth capture / discovery | central vault |
| Who sets creds | the group, ad-hoc | the operator, per OneCLI agent (CLI / web UI, outside NanoClaw) |
| No valid key → | **fails open** — request forwarded unmodified, still egresses | **can deny** — gateway returns `app_not_connected` / 403 |
| Role | credential source | credential source **+ enforcement layer** |

The defining difference is verifiable in the code: a local swap handler with no
resolvable key forwards the request unmodified (an empty swap forwards as-is). A
broker can refuse. So a broker is not merely another credential source; it is
the means to put a region of host-space under **enforcement** — "no access
without an authorized key."

A broker is a centralized, operator-assigned credential vault sitting behind the
proxy. The first (and currently only) broker is OneCLI.

## The dispatch seam (broker-agnostic)

The broker registry and dispatch contract are OneCLI-agnostic. A
`CredentialBroker` is registered host-side and consulted by the proxy on a
per-request basis; OneCLI is one implementation of that contract.

### Registry — `modules/mitm-proxy/broker-registry.ts`

A `CredentialBroker` has an `id`, an optional `priority`, a `tryForward`
handler, and optional per-container lifecycle hooks:

```ts
export type BrokerForward = (
  clientReq, clientRes, targetHost, targetPort, scope, sourceIP?,
) => Promise<void>;

export interface CredentialBroker {
  readonly id: string;
  readonly priority?: number;           // lower runs first; default 0
  tryForward: BrokerForward;
  onContainerRouted?(ip, scope): void | Promise<void>;
  onContainerReleased?(ip): void;
}
```

`tryForward` has the same argument shape and contract as a proxy `HostHandler`:
it owns the full round-trip and writes the response. It is invoked **only** when
routing has already chosen this broker for the request, so the broker is always
the **terminal owner** — there is no "decline and hand back." If the broker's
backend has no key it returns its own error (e.g. `app_not_connected`), and that
error *is* the response. A broker therefore never buffers a body and never
signals a decline; it is a plain pipe-style handler.

The registry deliberately differs from the provider registry: providers **throw**
on a duplicate id (always a bug), brokers **warn-and-overwrite** —
re-registering replaces the prior one (last-write-wins, with a fresh
registration index). `priority` orders brokers; it only matters once a single
delegation can fan out to several brokers (a future "walk by priority"). Today
exactly one explicitly-delegated broker is in play.

Registry surface: `registerCredentialBroker`, `getCredentialBroker(id)`,
`getCredentialBrokers()` (priority-sorted, registration order tiebreak), and
`hasCredentialBrokers()`.

### Two decision points in the proxy

- **Interception** (CONNECT / transparent time, host-only): the proxy
  TLS-terminates host `H` if a provider rule claims `H` **or** `H` is routed to a
  broker for that container's scope. `shouldIntercept` consults the broker
  routing snapshot in addition to the provider anchor rules: a catch-all or an
  overtake host-pattern makes an otherwise-uncovered host interceptable.

- **Dispatch** (per request, host + path) — `resolveBrokerRoute(ip, host, path)`:
  1. **Broker-routed?** `H` is in this container's effective overtake set, or it
     is uncovered and catch-all is on → route to the broker (terminal pipe),
     **overriding** any native provider. A provider-id overtake resolves to that
     provider's host rules, so `overtake: ['claude']` overtakes the host(s)
     `claude` owns.
  2. else **native rule** matches → the native handler owns it.
  3. else **plain pipe**.

A matched native rule always owns the request unless routing explicitly
overtakes it. There is no "no-token ⇒ yield to broker" heuristic: which
credential serves a request must not depend on token state, because that would
silently shadow a native OAuth bootstrap mid-setup. Overtake is the explicit,
deterministic alternative. The consequence is accepted: a
registered-but-unconfigured discovery provider still owns its host unless
explicitly overtaken — the way to route a host to the broker is to delegate or
overtake it, never a heuristic.

## Routing model — `broker_config`

Routing is a **global default + optional per-group overrides**, all written by
the same authority, so a global-admin is never forced to configure every group.
It lives in the central DB (`data/v2.db`), table `broker_config`, one row per
broker:

```
broker_config[brokerId] = {
  writeAuthority: 'global-admin' | 'group-admin',
  defaultRouting: { overtake: string[], catchAll: boolean },
  groupOverrides: { <folder>: Partial<routing> },
  enabled: boolean,
}

effectiveRouting(folder) = { ...defaultRouting, ...groupOverrides[folder] }  // per-field
```

- **Merge is per-field**: a group inherits the default and overrides only the
  fields it specifies (`overtake`, `catchAll`).
- **No extend-only restriction.** Both the default and the per-group overrides
  are authored by the same authority, so an override may add *or* remove an
  overtake relative to the default.
- A separate routing-policy tier that must merge with a *second* authority's
  layer is not modeled — connection is global, routing is one global object with
  per-group overrides.

The DB layer (`db/broker-config.ts`) exposes `getBrokerConfig`,
`getAllBrokerConfigs`, `listEnabledBrokerIds`, `upsertBrokerConfig`,
`deleteBrokerConfig`, and `effectiveRouting(brokerId, folder)`. JSON columns are
parsed defensively; `effectiveRouting` returns empty routing when the broker is
unconfigured or disabled.

The broker **connection** (`ONECLI_URL` / `ONECLI_API_KEY`) is *not* stored in
the table — it stays in the environment, matching the existing wiring. Two kinds
of "global" are kept distinct: the broker connection (just the registration; no
merge) and the routing default (per-field-merged).

### `writeAuthority`

Each broker's config carries `writeAuthority: 'global-admin' | 'group-admin'` —
who may change *that broker's* per-group settings. The flag lives in the
broker's global storage specifically so it is set **once**, not per group (a
per-credential authority flag would itself be per-group, recreating the very
problem this avoids). Default: `global-admin`.

## Per-container init (demand-gated)

The OneCLI broker does no work, and is not even constructed, unless some group's
effective routing targets it. Two layers enforce this:

- **Registration is demand-gated by connection.** `registerOneCliBroker` only
  registers when OneCLI is configured (`ONECLI_URL` present). With no OneCLI
  connection there is nothing to broker to, so a `broker_config` row naming
  `onecli` is inert.
- **Per-container setup is demand-gated by routing.** At IP-allocate the proxy
  observer snapshots a container's **effective routing**
  (`snapshotBrokerRouting(ip, folder)` in `modules/mitm-proxy/broker-routing.ts`).
  A container is recorded **only if** it routes to at least one enabled broker
  (some overtake target or catch-all). For each routed broker the snapshot fires
  that broker's `onContainerRouted` hook — its per-container setup. A container
  that delegates to no broker gets no entry and no broker work runs.

The snapshot is keyed by IP and read by the proxy at dispatch, so a request
never touches the DB on the hot path. Lifecycle mirrors the per-group OAuth
tier: snapshot on allocate (`onAllocate`), drop on release (`onRelease`, via
`dropBrokerRouting`, which also fires `onContainerReleased`).

`onContainerRouted` runs eagerly so init failures surface at spawn rather than
mid-request. The broker caches the in-flight promise per IP; a request arriving
mid-init awaits it.

## Fail-closed dispatch

Once a request is routed to the broker (overtake or catch-all) it **never
silently falls back to direct upstream**:

- gateway unreachable, or `ensureAgent` / `getContainerConfig` fails → the
  broker returns an error to the container; it does not pipe direct.
- gateway returns `app_not_connected` / 403 (no secret) → that response is
  surfaced.

The operator delegated this host *expecting* the broker to serve it; degrading
to direct egress would bypass the intended enforcement and send the container's
own (absent or placeholder) credentials. The OneCLI broker's `tryForward`
enforces this: if no forward config was cached for the IP (init never ran), it
throws; if the cached init promise rejected, awaiting it rejects — either way
the caller fails closed.

## The OneCLI broker provider

### Two grantable / configurable pieces

Routing and forward-identity have different write authorities, so they are
separate objects:

**`onecli` — agentIdentifier (a grantable credential), `providers/onecli-credential.ts`.**
A credential under provider id `onecli` whose value is the OneCLI
agentIdentifier the broker forwards as for a group. It lives in the credential
store (host-only XDG tree), is resolved scope-aware through the existing
resolver, and is **grantable / borrowable** via the existing grant machinery.
Granting `onecli` means "you may forward as me" — the grantee's broker requests
use the grantor's vault, subject to bilateral `canAccess`. Routing itself is not
a grantable resource; the agentIdentifier is the one grantable thing, consistent
with "only credentials are grantable."

The **default** is `agentGroup.id` — preserving the existing behavior with no
mandatory per-group setup. `resolveAgentIdentifier(folder, default)` resolves
own-scope → granted borrow source (resolver-enforced `canAccess`) → default.

An id-vs-folder subtlety: OneCLI keys on `agentGroup.id`; the credential stack
keys on `agentGroup.folder`. So the `onecli` credential is **looked up by
folder-scope** (like every credential) but its **value is an OneCLI agent id**.
Cross-agent use must go through grant/borrow, never a free-set of an arbitrary
foreign identifier — otherwise a group could forward as another and use its
vault without consent.

**`onecli_broker` — routing (overtake / catch-all).** This is the
`broker_config` routing policy above. It is *not* a registered
`CredentialProvider` (registering it would pollute the provider-id set and the
manifest pipeline) and it is *not* grantable (it is operator policy, not a
shareable resource). Matching a host against `overtake` — resolving a provider
id to its host rules and the covered/uncovered split — is the proxy's job; the
storage holds only the raw config.

### Forward transport — CONNECT-tunnel re-forward

`providers/onecli-broker.ts` splits the broker in two so the forward mechanism
is provable without a live OneCLI:

- `forwardViaConnectProxy(proxy, clientReq, clientRes, targetHost, targetPort)`
  — the transport. The MITM proxy has already terminated the container's TLS
  with the NanoClaw CA (which the container trusts). The broker re-issues the
  decrypted request as HTTPS to the target host **through the gateway as an HTTP
  CONNECT proxy**: open a CONNECT tunnel to the gateway, run TLS to the target
  over that tunnel, speak HTTP over the encrypted socket, and pipe the response
  back. The gateway's own cert is **not** verified
  (`rejectUnauthorized: false`) — the gateway address is all that is needed, no
  gateway CA is fetched or stored. The cost is one loopback TLS hop
  broker→gateway. This transport is exercised by a unit test against a stub
  CONNECT proxy.

- `createOneCliBroker(resolveForwardConfig)` — the broker, with the per-agent
  gateway address injected via a resolver. `onContainerRouted` kicks off
  resolution eagerly and caches the promise by IP; `tryForward` awaits it and
  fails closed on rejection.

The production resolver (`makeOneCliResolver`) for a container:
1. resolves the group's agent identifier (own → granted-borrow → default
   `agentGroup.id`);
2. calls `ensureAgent` to provision the per-group OneCLI agent (the
   container-runner's `applyContainerConfig` is **not** called — the MITM proxy
   owns egress unconditionally);
3. calls `getContainerConfig(agentId)` and reads the **per-agent** egress proxy
   address from its `env` (`HTTPS_PROXY` / `HTTP_PROXY`). The address is treated
   as per-agent — the gateway may hand a different address per agent identity, so
   the broker resolves and caches per agent rather than sharing one URL across
   scopes. (This is distinct from the single global approval-gateway URL.)

> **Integration seam.** The live-gateway forward — the exact `env` key carrying
> the egress proxy address, whether it is per-agent, and the gateway's secret
> gating — depends on OneCLI server behavior outside this repo. `makeOneCliResolver`
> is the only part not covered by the stub-based unit test; it is exercised only
> against a live OneCLI. Treat the live forward as an integration point, not a
> tested path.

### Egress wiring

The MITM proxy owns egress unconditionally — the observer injects `HTTP_PROXY` +
CA at spawn, and the proxy starts before router / sweep / delivery (a failed
start aborts boot). The earlier container-runner OneCLI path (`new OneCLI` +
`ensureAgent` + `applyContainerConfig`) was removed: it was dead behind the
always-on proxy and would re-collide on `HTTPS_PROXY`. The broker now owns the
OneCLI side — `ensureAgent` runs in `onContainerRouted` (at IP-allocate,
demand-gated to delegated groups); `applyContainerConfig` is never called.

## Substitutability

No new per-credential flag is needed to keep some credentials from being
substituted. Substitutability is already a provider decision: the engine
consults `isSubstitutingProvider` + `generateSubstitute(value, credentialPath)`,
and returning `null` already means "don't substitute" per credentialPath. A
broker-served credential is handled by routing alone: an overtaken host routes
to the broker, so the local swap handler is never invoked and no substitution
occurs.

## `ncl brokers`

Broker config is managed through `ncl brokers` (`cli/resources/broker.ts`). It is
global-admin only: `broker_config` is not in the group-scope CLI whitelist, so
container agents in `group` scope cannot reach it, and mutations are
approval-gated for any non-host caller. There is **no `/broker` in-chat command** —
`ncl brokers` is the only interface.

| Verb | Access | What it does |
|------|--------|--------------|
| `list` | open | List all broker configs |
| `get <id>` | open | Get one broker's config |
| `set --id <broker>` | approval | Create/update the broker's **default** routing. Optional `--overtake a,b,c`, `--catch-all true\|false`, `--write-authority`, `--enabled`. Unspecified fields keep their current value. |
| `set-group --id <broker> --group <folder>` | approval | Set a per-group routing override. Optional `--overtake`, `--catch-all`. Unspecified fields inherit the default. |
| `clear-group --id <broker> --group <folder>` | approval | Remove a per-group override. |
| `delete <id>` | approval | Drop the broker's config row. |

`--overtake` takes a comma-separated list (empty string clears it); the
`--catch-all` and `--enabled` flags are tri-state (absent ⇒ inherit, not
overwrite). The custom `set` / `set-group` / `clear-group` verbs exist so the
JSON routing round-trips ergonomically through the per-field merge.

## Authority model

| Concern | Authority |
|---|---|
| Broker registration (host-side, in-process) | code / global only — an agent can never register a broker |
| Broker connection + routing default + per-group routing overrides | global-admin (central DB) |
| `writeAuthority` flag per broker | global-admin (the flag itself is global) |
| `onecli` agentIdentifier (own; cross-agent via grant) | per the broker's `writeAuthority`; cross-agent only via consensual grant |
