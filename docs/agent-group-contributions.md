# Agent-group contributions

## Summary

A per-agent-group, dynamic container-config hook. Modules register a
synchronous callback that returns `{ env, mounts }` for a spawn, and the
container-runner merges every registered callback's result into the spawn
args alongside the static `container.json` mounts, the channel-adapter
contribution, and the provider contribution.

Three other hooks already cover the adjacent granularities:

- `ChannelRegistration.containerConfig` — per-channel-adapter.
- `ProviderContainerContribution` — per-provider-type.
- `readContainerConfig(folder)` (static file) — per-agent-group, static.

This registry fills the remaining gap: per-agent-group, but resolved
*dynamically* at spawn time — a value only known once a host service has
started (a proxy URL), or a host path derived from `agentGroup.folder` —
without inventing a bespoke hook each time.

## Capabilities

- Register a callback by id and have it run on every container spawn for
  every agent group, with access to the spawn's `AgentGroup`, `Session`,
  and the live `process.env`.
- Contribute extra volume mounts that land in the spawn args after the
  static `container.json` mounts and the provider contribution.
- Contribute env vars that are passed to the container as `-e KEY=VALUE`,
  with collisions across registrants resolved last-write-wins and logged.
- Reject a spawn by throwing — the registry wraps the throw in
  `FatalSpawnError` so the spawn path classifies it as non-retryable.

## Public contract

### `registerAgentGroupContribution(id, fn)`

```ts
function registerAgentGroupContribution(
  id: string,
  fn: AgentGroupContributionFn,
): void;
```

Registers `fn` under `id`. Registration is monotonic — there is no
`unregister`. Throws if `id` is already taken. Registration order is
preserved and observable: callbacks run in the order they registered, so
env-key collisions resolve last-write-wins on the registration order.

### `AgentGroupContributionContext`

```ts
interface AgentGroupContributionContext {
  agentGroup: AgentGroup;
  session: Session;
  hostEnv: NodeJS.ProcessEnv;
}
```

What every callback receives at spawn time. `hostEnv` is the live
`process.env` — callbacks read passthrough values from there. The fields
are non-null; a callback is only invoked when a real spawn is about to
happen.

### `AgentGroupContribution`

```ts
interface AgentGroupContribution {
  env?: Record<string, string>;
  mounts?: VolumeMount[];
}
```

`VolumeMount` is the same shape used by the provider registry:
`{ hostPath: string; containerPath: string; readonly: boolean }`. Both
fields are optional; returning `{}` is a valid no-op contribution.

### `AgentGroupContributionFn`

```ts
type AgentGroupContributionFn =
  (ctx: AgentGroupContributionContext) => AgentGroupContribution;
```

**Synchronous.** Callbacks must not `await` and must not perform I/O.
Reading module-level state set up at host startup (a proxy URL captured
when the proxy started, a cached cert path) is fine. A throw is treated
as a non-retryable spawn failure — see *Failure modes*.

### `invokeAgentGroupContributions(ctx)`

```ts
function invokeAgentGroupContributions(
  ctx: AgentGroupContributionContext,
): AgentGroupContribution;
```

The merge entry point the container-runner calls. Consumers do not call
it directly. Returns merged `{ env, mounts }`; throws `FatalSpawnError`
if any callback throws.

### `clearAgentGroupContributions()`

Test-only. Empties the registry.

## Behavior guarantees

- Callbacks run in registration order, on every spawn, with no
  deduplication of mounts across registrants. The final mount array
  preserves order across all sources: `container.json` mounts → provider
  contribution → agent-group contributions.
- Env keys merge across contributions with last-write-wins. A collision
  between two contributions setting *different* values logs a `warn` with
  both ids and values (`{ key, priorId, priorValue, newId, newValue }`);
  same-value re-registrations do not log.
- A throw from any callback aborts the spawn and is converted to
  `FatalSpawnError` annotated with the contributing id and the original
  error as `cause`. No partial spawn results.
- The registry is empty in a fresh process. Nothing self-registers at
  import time — consumers register from their own registration site.
- No persistence: the registry is in-memory only.

## Consumer usage

### Registering a static contribution

```ts
import { registerAgentGroupContribution } from '../../agent-group-contributions.js';

registerAgentGroupContribution('telemetry', () => ({
  env: { TELEMETRY_ENDPOINT: 'http://host.docker.internal:4318' },
}));
```

### Contributing per-agent-group state

```ts
import path from 'path';
import { registerAgentGroupContribution } from '../../agent-group-contributions.js';

registerAgentGroupContribution('socket-mount', ({ agentGroup }) => ({
  mounts: [
    {
      hostPath: path.join(SOCKET_ROOT, agentGroup.folder),
      containerPath: '/sockets',
      readonly: false,
    },
  ],
}));
```

### Rejecting a spawn

```ts
registerAgentGroupContribution('group-oauth', ({ hostEnv }) => {
  const proxyUrl = hostEnv.GROUP_OAUTH_PROXY_URL;
  if (!proxyUrl) {
    throw new Error('GROUP_OAUTH_PROXY_URL is not set — proxy is not running');
  }
  return { env: { HTTPS_PROXY: proxyUrl } };
});
```

The thrown `Error` is wrapped in `FatalSpawnError` with a message of the
form `Agent-group contribution "group-oauth" failed: <original message>`
and the original error as `cause`. The spawn path then marks the session
spawn-poisoned so the sweep stops re-waking it.

## Boundaries

**Not in scope:**

- Asynchronous / streaming contributions. The mechanism is sync by
  design; consumers that need async setup should do that setup at host
  startup and read the cached result from the callback.
- Removal / re-registration. There is no `unregister`; registering the
  same id twice on one process is an error.
- Channel-level or provider-level contributions — already covered by
  `ChannelRegistration.containerConfig` and the provider container
  registry.
- DB-backed contributions. Consumers that need persistent state own
  their own storage.

**Dependencies / required peers:**

- `FatalSpawnError` from [`spawn-failure.ts`](./spawn-failure.md). The
  registry wraps callback throws in this type; the spawn path classifies
  the throw as non-retryable on that basis.

## Failure modes

| Situation | Signal |
| --------- | ------ |
| Duplicate `id` at registration | `registerAgentGroupContribution` throws synchronously: `Agent-group contribution already registered: <id>`. |
| Callback throws at spawn | `invokeAgentGroupContributions` throws `FatalSpawnError` with the contributing id and the original error as `cause`. |
| Env-key collision between contributions | Last-write-wins; `log.warn` records `{ key, priorId, priorValue, newId, newValue }`. |

## Test coverage

- Empty registry returns `{ env: {}, mounts: [] }`.
- A single contribution passes through unchanged.
- Mounts concatenate in registration order with no dedup.
- Env merges last-write-wins; differing-value collisions log a single
  `warn` with both ids/values; same-value collisions do not log.
- A callback throw produces a `FatalSpawnError` whose message names the
  contributing id and whose `cause` is the original error.
- Duplicate-id registration throws.
- `clearAgentGroupContributions` empties the registry.
