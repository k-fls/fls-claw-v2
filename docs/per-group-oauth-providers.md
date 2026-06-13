# Per-group OAuth providers

## Summary

Agent groups can **add** OAuth provider rules on top of the global
discovery baseline — a new service the baseline doesn't cover. Additions
are **scoped to the container**: they apply only to that container's egress
and are dropped when the container exits. The Claude browser-auth container
is the motivating ephemeral case.

This is purely additive. There is no allowlist / opt-out: a group cannot
*remove* or *override* a global provider, nor widen a global provider's
domain set.

## Two rule tiers, two lifecycles

Host rules live in two maps on the proxy:

| Tier | Store (`credential-proxy.ts`) | Key | Lifecycle | Source |
|------|-------------------------------|-----|-----------|--------|
| global | `anchorRules` | anchor | process | in-tree `oauth/discovery/` + `~/.config/nanoclaw/auth-discovery/` |
| container | `containerRules` | normalized source IP | container lifetime; installed on IP-allocate, dropped on IP-release | `groups/<folder>/.auth-discovery/*.json` (+ programmatic, e.g. the auth container) |

There is **no separate group tier**. A group's declared providers are
*loaded* (the group's `.auth-discovery/` dir is the source) and *installed*
into the per-container store of each container that group spawns, keyed by
that container's IP. Rebuilding on every spawn means persistence across
container churn buys nothing, and per-IP keying gives a clean O(1) teardown
on exit with no stale rules.

### Lifecycle wiring

The container-bootstrap IP registry exposes `onAllocate(ip, scope)` /
`onRelease(ip, scope)`. The mitm-proxy observer subscribes:

- **allocate** → `loadGroupProvidersForContainer(scope, ip, proxy)` reads
  `groups/<scope>/.auth-discovery/`, filters, and
  `proxy.registerContainerRules(ip, accepted)`.
- **release** → `proxy.unregisterContainerIP(ip)` drops the tier.

This is the right seam because at `onSpawnPre` the IP isn't known yet (a
different observer allocates it); at allocate time both IP and scope are in
hand. `loadGroupProvidersForContainer` never throws — a missing dir / bad
file installs nothing.

## Matching — global always wins, by sequence

Lookup tries the tiers **in order** and returns the first hit:

```
findMatchingRule(host, path, ip?):
  matchIn(anchorRules, host, path)              // global    — first
  ?? matchIn(containerRules.get(ip), host, path) // container
```

Global is consulted to completion first, so a container rule can never
override a global one — not even with a more-specific anchor.
`shouldIntercept(host, ip?)` is true iff this connection's tiers
(global ∪ container[ip]) own the anchor; another container's IP tier is
invisible here. `ip` omitted → global only (preserves prior behavior).

## Anchor ownership — name-based, guards the global/local boundary

A credential's authorized domains are fixed by the provider that owns them.
An anchor remembers its owning **provider name** (derived from the rules in
`anchorRules`). `containerRuleViolation(providerId, anchor)` is the single
predicate enforced both as a throw (`registerContainerRules` →
`assertContainerMayOwn`) and as a graceful reject
(`loadGroupProvidersForContainer`). A container rule is rejected when:

1. the anchor is owned by a **different** provider name — adding a rule
   under another name would route that name's credential to a domain fixed
   by the owner's definition; **or**
2. the provider name is a **global** provider but the anchor is **not one it
   already owns** — a container may not extend a global provider's anchor
   set with new domains.

Same provider name on an anchor it already owns is **allowed** (not a
hijack — and a dead rule anyway, since global wins by sequence).

**Global co-ownership is unchanged.** The baseline intentionally points
several variants at one host — `login.microsoftonline.com`
(`microsoft-common`/`-consumers`/`-organizations`), `canva`/`canva-docs`,
`paypal`/`paypal-sandbox`, `vercel`/`vercel-docs`. All global, all trusted;
the invariant only guards the global↔container boundary, never
single-ownership within the global tier.

## ENV collisions — checked at load (host rules can't)

Host-rule collisions resolve for free by match order, but published env var
names are a **flat namespace** injected as `-e` flags — match order can't
disambiguate two `FOO=` flags. So env names are checked when a container's
providers load:

- against the **global** reserved set via `isEnvNameReserved(name)` (covers
  the dangerous list, container-runner statics, and every global provider's
  env) → reject + warn;
- against **this container's** already-accepted providers (a local set built
  during the load) → reject the later one.

Scope-aware by construction: two *different* containers both publishing e.g.
`GITHUB_TOKEN` is fine (different containers, different env). Container-tier
env is checked, never globally reserved (which would create cross-container
false positives).

## Loading — one procedure

A group JSON loads identically regardless of intent: parse →
`toSubstitutingProvider` → rules → `containerRules[ip]`, subject to the
ownership + env filters above. Group-tier providers never enter the global
credentials registry, so their ids may coincide with a local one across
containers — credentials resolve under `{scope}/{providerId}`.

Every load of an existing dir writes a **load report** back to it as
`.auth-discovery/_load-report.json`: `{ registered, rejected[{id,reason}], ip,
scope, generatedAt }`. It is the agent's feedback channel — a rejected def shows
up there with the reason. The prior report is **deleted before the (re)load** and
a fresh one written on every load path, so the report on disk always corresponds
to the latest load — never a stale one if the fresh write fails. Best-effort
(delete + write failures are logged, never fatal); the loader skips this file by
name (`OAUTH_LOAD_REPORT_FILENAME`) so it is never parsed as a provider def.

## Mid-session reload

Provider defs normally load once, at IP-allocate (container start). The
`reload_auth_providers` MCP tool lets an agent apply edits/additions to its
`.auth-discovery/` dir **without a container restart**. It fires a
`reload_auth_providers` sync action; the host handler resolves the caller's own
IP from its session (`lookupIPForSession` — 1:1, unspoofable, so a container can
only reload its own tier) and re-runs `loadGroupProvidersForContainer` for that
IP, replacing the per-container tier in place. Returns `{ registered, rejected }`
(and writes the load report). Files:
`container/agent-runner/src/mcp-tools/auth-providers.ts`,
`src/modules/mitm-proxy/reload-providers-action.ts`.

## Public surface

- `CredentialProxy.registerContainerRules(ip, providers)` — install (throws
  on ownership violation); cleared by `unregisterContainerIP(ip)`.
- `CredentialProxy.shouldIntercept(host, ip?)` / `findMatchingRule(host, path, ip?)`.
- `CredentialProxy.isGlobalProvider(id)` / `globalAnchorOwners(anchor)` /
  `containerRuleViolation(providerId, anchor)`.
- `loadGroupProvidersForContainer(scope, ip, proxy)` (oauth module) — load +
  filter + install, returns `{ registered, rejected }`; writes the load report.
- `groupDiscoveryDir(scope)` — `groups/<folder>/.auth-discovery/` (dot-prefixed:
  hidden from a default `ls` in the agent's `/workspace/agent` mount).
- `OAUTH_LOAD_REPORT_FILENAME` — `_load-report.json`, the per-load report.
- `reload_auth_providers` — MCP tool + sync action for mid-session reload.
- `lookupIPForSession(sessionId)` (container-bootstrap) — reverse of
  `lookupContainerSession`; resolves the caller's IP for the reload handler.

## Credential bound-domain confinement

`groups/<folder>/.auth-discovery/` is mounted **read-write** into the
container, so a mis-instructed agent can author or edit its own provider
definitions between spawns. Without a guard it could route a user-authorized
credential to an attacker domain — and because the definition is mutable, a
TOCTOU edit (`api.acme.com` → `evil.com`) defeats any provider-level binding.
The credential itself must remember where it may go.

Three layers, non-global providers only (globals are curated and
legitimately multi-domain, so they are exempt throughout):

1. **Anchor shape (load).** A container anchor must be **≥2 labels** (`x.y`
   or deeper) — enforced in `containerRuleViolation`, so both
   `registerContainerRules` (throw) and the load filter reject a bare TLD.
2. **Stamp (store).** When a non-global provider's credential is stored,
   token-exchange capture stamps `Credential.boundDomain` = the sourcing
   host. Globals are skipped (`HandlerContext.isGlobalProvider`), so they
   never get a `boundDomain` and layer 3 naturally ignores them.
3. **Guard (inject).** Before bearer-swap injects a real token, if the
   credential has a `boundDomain` and the request host's **registrable
   domain (last two labels)** differs, it does **not** inject — it forwards
   the substitute unswapped (a useless fake) and logs a `warn`.

This confines a real credential to the registrable domain it was sourced for
regardless of later provider-def edits. The capture/use split
(`auth.acme.com` mints, `api.acme.com` uses) works because matching is by
registrable domain, not exact host.

**No PSL.** The registrable domain is approximated as the last two labels
(`src/modules/mitm-proxy/domain.ts`). Deliberate residual: hosts sharing a
two-label public suffix — `a.herokuapp.com` vs `b.herokuapp.com`,
`*.s3.amazonaws.com` — count as the same domain, so a credential bound to
one could inject at a sibling. Accepted trade-off.

**Lowercase convention.** Domains are lowercased at every input boundary —
the proxy host entry (CONNECT host split, transparent SNI parse) and the
oauth-file parse (`buildHostMatch`) — and the `domain.ts` helpers assume
lowercase input (they do not re-lowercase).

## Related

- [MITM credential proxy](mitm-proxy.md)
- [Container lifecycle peer](container-bootstrap.md)
- [Sync actions](sync-actions.md)
