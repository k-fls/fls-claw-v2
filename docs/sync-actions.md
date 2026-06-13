# Sync actions

## Summary

A **sync action** is a synchronous, response-bearing request a container makes
to the host, with all business data kept inside the two session DBs. The
existing container→host action channel (delivery actions written to
`messages_out`, dispatched by `registerDeliveryAction`) is async and
fire-and-forget — no value returns to the caller. Sync actions layer a
synchronous round-trip on the *same* registry: the container writes the request
to its outbound DB, triggers a content-free host-rpc wakeup, and the host writes
the result to the inbound DB and returns only its row id. host-rpc carries no
business payload in either direction — it is a doorbell that returns a DB
pointer. This lets a container fetch a value from the host mid-tool-call
(e.g. `get_credential`) without a bespoke HTTP endpoint and without business
data leaving the DB surface.

## Capabilities

- Any registered delivery action is invocable synchronously by a container
  (sync is just a transport — the container can already trigger any action
  async); response-bearing actions return a value, fire-and-forget ones return
  nothing.
- A container can invoke an action synchronously and receive its result within a
  single tool call, via one helper (`callSyncAction`).
- The request and the result are both durable, auditable rows in the session
  DBs (`messages_out` and `messages_in`); the host-rpc wakeup transmits only
  `{ requestId }` out and `{ inboundId }` back. The caller's session is resolved
  host-side from its IP, not taken from the request.
- `get_credential` lets an in-container agent pull a (non-sensitive) substitute
  token for any registered substituting provider, optionally publishing it to a
  shell env var for subsequent `Bash` calls.

## Public contract

### `registerDeliveryAction(action, handler)`

```ts
type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<unknown>;

function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void;
```

The existing async registry, extended only so handlers may **return a value**.
The async delivery-poll path ignores the return (fire-and-forget, as before);
the sync-action wakeup surfaces it as the result. Re-registration overwrites.

### `dispatchSyncAction(action, content, session, inDb)`

```ts
function dispatchSyncAction(
  action: string, content: Record<string, unknown>, session: Session, inDb: Database.Database,
): Promise<unknown>;
```

Synchronously runs a registered action and returns its result. Throws only if
the action is unknown. (Sync is just a transport; no separate opt-in — the
container can already trigger any action async.) Used by the wakeup handler.

### host-rpc `POST /action`

Request body `{ requestId: string }` — a pointer only. The handler resolves the
caller's session from its IP (`lookupContainerSession`, 1:1 with the container),
reads the sync-marked `messages_out` row `requestId`, dispatches the action, and
writes the result as a `kind='system'` `messages_in` row. Returns
`{ inboundId: string }` — the result row's id.

### `callSyncAction(action, payload?, opts?)` (container)

```ts
function callSyncAction(
  action: string, payload?: Record<string, unknown>, opts?: { timeoutMs?: number },
): Promise<unknown>;
```

Writes the sync request to `outbound.db`, fires the wakeup, reads the result row
from `inbound.db` by the returned id, and returns its payload. Throws on host
error, unknown action, or a handler-reported failure. Requires
`NANOCLAW_HOST_RPC_PORT` in the container env (injected at spawn).

### `get_credential` (container MCP tool)

Inputs `{ providerId, credentialPath, envVar? }`. Returns a substitute token for
the credential, minting one if needed. With `envVar`, also publishes the
substitute into the session's `BASH_ENV` file. Backed by the `get_credential`
sync action.

### `publishEnvVar(name, value)` (container) / `env-custom.jsonl` (host)

`publishEnvVar` appends `export NAME=value` (last-write-wins, shell-escaped) to
the `BASH_ENV` file so later `Bash` calls see it. On the host, the
`container-env` module injects `groups/<folder>/env-custom.jsonl`
(`{"name","value"}` lines) at spawn via the agent-group contribution registry,
after format + reserved-name curation.

## Behavior guarantees

- A sync-marked request row (`kind='system'`, `content.sync === true`) is
  **skipped by the delivery poll** and processed **only** by the wakeup —
  exactly-once.
- The single-writer-per-file invariant holds: the container writes the request
  (`outbound.db`); the host writes the result (`inbound.db`). The host never
  writes `outbound.db`.
- The result row is `kind='system'`, so it is **excluded from the agent's prompt
  poll** and never becomes a user turn; the waiting tool reads it by id.
- The wakeup returns only a row id; no business payload crosses host-rpc.
- The caller's session is resolved host-side from its IP (1:1 with the
  container), never from the request body — a container cannot drive another
  session, even a sibling in its own scope.
- A second wakeup for a `requestId` already in flight **fails** (no
  double-dispatch); the claim is released when the first settles. The claim is
  race-free (single-threaded host; no `await` between the check and the set).
- Substitute tokens are non-sensitive placeholders (swapped for the real secret
  only at the proxy boundary), so persisting them in the result row leaks
  nothing; real credentials never enter the session DBs.

## Consumer usage

### Register a sync action (host)

```ts
registerDeliveryAction('get_credential', async (content, session) => {
  // ... resolve and return a JSON-serializable result ...
  return { substitute, providerId, credentialPath, envNames };
});
```

### Call it (container)

```ts
const result = await callSyncAction('get_credential', { providerId: 'github', credentialPath: 'oauth' });
```

## Boundaries

**Not in scope:**
- A generic synchronous RPC for arbitrary host services — only registered
  delivery actions are reachable (the same set the container can trigger async).
- A request/response primitive over the DB *without* the host-rpc trigger (the
  wakeup is required; async-only actions keep using the poll).
- The credential proxy / substitution mechanics themselves (see the
  [mitm-proxy spec](mitm-proxy.md)); this spec covers retrieval transport only.

**Dependencies / required peers:**
- host-rpc server (`src/modules/host-rpc/`) running on the host.
- The container↔session 1:1 spawn model (the wakeup resolves one session per
  caller).
- For `get_credential`: a registered `SubstitutingProvider` (the OAuth module
  registers the discovery providers; Claude registers its own).

## Failure modes

| Situation | Signal |
| --------- | ------ |
| Unknown action | Wakeup throws; host-rpc returns `{ ok:false }`; `callSyncAction` throws. |
| Caller IP has no bound session | Wakeup throws (`no session bound to caller IP`); container call throws. |
| Duplicate in-flight `requestId` | Wakeup throws (`duplicate in-flight request`); container call throws. |
| Action handler throws | Captured into the result row as `{ ok:false, error }`; `callSyncAction` throws with that message. |
| `get_credential` unknown provider / no credential | `ok:false` with `Unknown provider` / `No credentials found`. |
| Reserved/malformed `envVar` | Rejected before minting; `ok:false` with the validation message. |

## Extension points

- Any future container→host synchronous need registers a delivery action and
  calls `callSyncAction(name, …)` — no new HTTP surface.
- `env-custom.jsonl` curation reuses `container-bootstrap`'s reserved-name
  registry, so new host-injected names automatically become ineligible for
  custom env without touching this module.

## Test coverage

- Host-stack e2e (no Docker): a real `fetch` from loopback → real host-rpc
  `/action` → session-from-IP → `get_credential` → token engine → real
  `outbound.db`→`inbound.db` round-trip; substitute returned, unknown-provider
  surfaced as a structured error, missing row + unknown-caller rejected.
- Registry: dispatch of registered actions (response-bearing + fire-and-forget),
  result propagation, handler errors, unknown action.
- Wakeup: in-flight duplicate `requestId` fails (concurrency test); missing
  requestId rejected.
- Substitute resolver core: unknown provider, missing path, reserved/malformed
  env name, envNames mapping, `mergeEnvNames` on custom `envVar`.
- Container env: `publishEnvVar` write/overwrite/escape/validation;
  `env-custom.jsonl` parse + curation (format, reserved, last-write-wins, bad
  lines).

## Related

- [MITM credential proxy](mitm-proxy.md)
- [Host commands](host-commands.md)
- [Container lifecycle peer](container-bootstrap.md)
- [Agent-group contributions](agent-group-contributions.md)
