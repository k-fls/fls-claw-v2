# Spawn-failure classification

## Summary

A two-class model for container-spawn failures and an in-memory
"poisoned" flag that stops the host-sweep from re-waking a session that
has hit a non-retryable error.

- **Retryable** failures (plain `Error`, e.g. the OneCLI gateway
  momentarily unreachable) keep the silent-retry behavior: the inbound
  row stays pending and the sweep tries again on its next tick.
- **Non-retryable** failures (`FatalSpawnError`, e.g. a buggy
  contribution callback, a missing mount source, a misconfigured proxy
  URL) mark the session poisoned so the sweep does not loop on it.

The poison set is in-memory and per-process. On host restart everything
is forgotten and the next inbound triggers a fresh spawn attempt.

## Capabilities

- Producers of spawn-time errors can opt into "non-retryable" semantics
  by throwing `FatalSpawnError` instead of a plain `Error`.
- The container-runner classifies every caught spawn error: a plain
  `Error` resolves `wakeContainer` to `false` (retryable); a
  `FatalSpawnError` marks the session poisoned and rethrows.
- A session marked spawn-poisoned short-circuits subsequent
  `wakeContainer` calls (host-sweep, internal system wakes) until the
  flag is cleared.
- The poison set exposes public mutators and a predicate so callers that
  hold channel context can build user-notification and retry flows on
  top of it.

## Public contract

### `class FatalSpawnError`

```ts
class FatalSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}
```

A subclass of `Error` with `name === 'FatalSpawnError'`. Throw it from
any code path that runs during a container spawn to mark the failure as
non-retryable. `cause` carries the original error for diagnostics.

### `markSpawnPoisoned(sessionId)` / `isSpawnPoisoned(sessionId)` / `clearSpawnPoison(sessionId)`

```ts
function markSpawnPoisoned(sessionId: string): void;
function isSpawnPoisoned(sessionId: string): boolean;
function clearSpawnPoison(sessionId: string): boolean;   // returns prior membership
```

Direct access to the in-memory poison set. The container-runner calls
`markSpawnPoisoned` on any caught `FatalSpawnError`. `clearSpawnPoison`
returns whether the flag had been set, so a caller can use it as a
fetch-and-clear. Consumers that need to inspect or override the state
(admin commands, debug tooling, a "retry on next inbound" flow) use the
predicates directly.

### `_resetSpawnPoisonForTesting()`

Test-only. Drops all poison flags.

### `wakeContainer` (contract)

```ts
function wakeContainer(session: Session): Promise<boolean>;
```

- Returns `true` when a container is already running or the spawn
  succeeds.
- Returns `false` immediately, without spawning, when the session is
  currently spawn-poisoned.
- Returns `false` on a retryable failure — a plain `Error` thrown from
  the spawn path (e.g. OneCLI gateway down), or admission-control
  deferral at the concurrency cap. The inbound row stays pending.
- On a `FatalSpawnError` from the spawn path, marks the session poisoned
  and rethrows the error.

Every caught error — both classes — is logged at `error` level before
classification.

## Behavior guarantees

- The host-sweep cannot wake a poisoned session. The sweep's
  `dueCount > 0 && !isContainerRunning` check still fires, but
  `wakeContainer` short-circuits on `isSpawnPoisoned`, so no spam and no
  new spawn attempt.
- A plain `Error` thrown from the spawn path keeps existing semantics:
  `wakeContainer` resolves `false`, the message stays pending, the sweep
  retries on its next tick. No notification.
- The poison set is in-memory and per-process. Restarting the host
  clears every flag, and the next inbound triggers a fresh spawn.
- `clearSpawnPoison` is idempotent and reports prior membership, so the
  first clear returns `true` and a redundant clear returns `false`.

## Consumer usage

### Producing a fatal error

Code that runs inside the spawn path (provider container-config,
agent-group contributions, future spawn-time hooks) throws
`FatalSpawnError` directly:

```ts
import { FatalSpawnError } from './spawn-failure.js';

if (!fs.existsSync(mountSource)) {
  throw new FatalSpawnError(`Required mount source missing: ${mountSource}`);
}
```

The agent-group contributions registry does this automatically by
wrapping any callback throw.

### Consuming a fatal error in a background caller

Callers that wake a session without channel context (host-sweep, an
internal system wake) `.catch()` so the rethrown `FatalSpawnError` does
not become an unhandled rejection — the session is already marked
poisoned, so the sweep will not loop on it:

```ts
wakeContainer(session).catch((err) => {
  log.error('Background wake failed', { sessionId: session.id, err });
});
```

### Building a retry / notification flow

The poison set's public mutators let a caller with channel context build
a user-visible flow: check `isSpawnPoisoned` to surface the prior error,
`clearSpawnPoison` to mark a retry as intentional, and route the
`FatalSpawnError` message to the user through a direct-delivery path.

## Boundaries

**Not in scope:**

- Persistent poison state. Restart clears everything; that is the
  intended behavior.
- A per-session attempt counter or backoff for retryable failures. The
  sweep's 60-second tick is the only pacing.
- Notifying the user on plain (retryable) failures. The system
  self-heals on the next sweep tick; surfacing every transient hiccup
  would be noisy.
- Admin-facing commands to inspect or clear the poison set. The
  predicates are available to build that on top later.

**Dependencies / required peers:**

- `FatalSpawnError` is the boundary type between spawn-time producers
  (provider container-config, agent-group contributions) and the
  container-runner's classification.

## Failure modes

| Situation | Signal |
| --------- | ------ |
| Retryable error in spawn path | `log.error`; `wakeContainer` resolves `false`; inbound stays pending; sweep retries. |
| Non-retryable error in spawn path | `log.error`; session marked poisoned; `wakeContainer` rethrows `FatalSpawnError`. |
| Wake attempt while poisoned | `log.debug`; `wakeContainer` resolves `false` immediately, no spawn. |

## Extension points

- `FatalSpawnError` accepts `{ cause }` for structured chaining;
  consumers can attach additional fields by subclassing if a more
  specific class is useful later (admin commands could branch on
  `instanceof`).
- The poison set's public mutators (`markSpawnPoisoned`,
  `clearSpawnPoison`) and predicate (`isSpawnPoisoned`) let future admin
  commands or a retry-on-inbound flow clear individual flags or list
  poisoned sessions without touching the storage shape.

## Test coverage

- `FatalSpawnError` is an `Error` with stable `name` and preserves
  `cause`.
- Poison set: empty by default; `mark` / `isPoisoned` / `clear`
  round-trip; `clear` returns whether the flag was set.
