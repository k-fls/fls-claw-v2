# Host commands

## Summary

Modules running on the host can register slash-command handlers that
intercept inbound chat messages before they reach the container agent.
A registered command is handled entirely on the host: the container is
never woken, never sees the message, and never participates in the
reply. Handlers receive parsed arguments and the originating channel
address, and reply to the user through a single closure call. A
built-in `/help` handler composes its output from the same registry,
plus a static table of well-known container-side commands, so users
can discover everything available to them with one command.

This unlocks any host-only feature whose payload must not transit the
container (credential management, account linking, host-level admin
operations) without each feature needing its own routing machinery.

A host command can also open a multi-turn **interaction**: it seizes
the inbound routing slot for a `(channelType, platformId, threadId,
userId)` so the user's next messages flow to the interaction handler
instead of the classifier or container, until the handler finishes,
cancels, or the slot times out.

## Capabilities

- Consumers can register a host-side handler for any slash-command
  prefix, and it will be invoked before any container routing happens.
- Registrations declare a **scope** — `agent` (default), `channel`,
  or `host` — that determines how the command fans out:
  - `agent`: dispatched once per **engaging** agent wired to the
    channel. Disambiguation in multi-agent channels is the engage
    rules already configured on each wiring. The handler sees the
    specific agent in `ctx.agentGroupId`.
  - `channel`: dispatched once per inbound message, regardless of
    how many agents are wired. `ctx.agentGroupId` is null.
  - `host`: dispatched once per inbound message, regardless of channel
    or agent (same routing as `channel`, semantic distinction only).
    `ctx.agentGroupId` is null.
- Handlers receive the issuing user's id, parsed argv tokens, the
  messaging group, the dispatch scope, and (for `agent` scope) the
  agent group.
- Handlers can reply to the originating channel via `replyText(string)`
  — no session or delivery knowledge required. Replies are sent
  straight to the channel adapter (via `deliverDirect` in
  `delivery.ts`), bypassing `messages_out` and the polling loop. This
  keeps host-command content out of the per-session DBs and gives
  channel/host-scope replies the same latency as agent-scope ones
  even when no container has ever been woken for the session.
  Transient adapter failures are retried (3 attempts with short
  backoff). Permanent failures are logged.
- Handlers can call `ctx.beginInteraction({ handler, ... })` to seize
  the `(channelType, platformId, threadId, userId)` routing slot for a
  multi-turn flow. The user's next chat messages are delivered to the
  interaction handler — not classified, not written to the session,
  not given to the container — until the handler calls `finish` /
  `cancel`, or the timeout fires. Interaction handlers can swap
  themselves between turns to model a state machine.
- While an interaction is active for a `(channelType, platformId,
  threadId)`, outbound delivery from the container to that channel
  address is **paused** (rows stay in `messages_out` until the slot
  releases). The interaction's own `ask` / `finish` / `cancel` replies
  go through `deliverDirect` straight to the adapter, so they never
  enter `messages_out` and are not subject to the pause.
- Consumers can attach a one-line description to a registration; the
  built-in `/help` command surfaces it to users automatically.
- Consumers can call `isAdmin(userId, agentGroupId?)` to gate operations
  on host-level role (owner / global-admin / scoped-admin). Pass
  `ctx.agentGroupId` from `agent` scope; omit for `channel`/`host`
  scope to check global owner/admin only.
- The gate guarantees a registered handler is never invoked for an
  anonymous platform event — the call is denied with a permission
  message before dispatch.

## Public contract

All command symbols are exported from `src/command-gate.js`; the
interaction primitive is exported from `src/host-interactions.js`.

### `registerHostCommand(prefix, handler, options?)`

```ts
type HostCommandScope = 'agent' | 'channel' | 'host';
type HostCommandAccess = 'any' | 'group-admin' | 'global-admin';

function registerHostCommand(
  prefix: string,
  handler: HostCommandHandler,
  options?: { help?: string; scope?: HostCommandScope; access?: HostCommandAccess },
): void;
```

Registers `handler` for the slash-command `prefix`. `prefix` must start
with `/`. Matching is case-insensitive on the first whitespace-delimited
token of the inbound message. Re-registering an existing prefix logs a
warning and overwrites (last writer wins).

`options.help`, if provided, is a one-line description shown by `/help`
(both in the overview list and in `/help <prefix>`). Omit `help` to
register a handler that doesn't appear in the help output.

`options.scope` defaults to `'agent'`. See the Capabilities section
above for the dispatch implications of each scope.

`options.access` defaults to `'any'` and declares the privilege required
to invoke the command:

| Access | Who passes | Enforced where |
|--------|-----------|----------------|
| `'any'` | any identifiable user | — (anonymous senders are always denied) |
| `'group-admin'` | owner, global admin, or admin scoped to the target agent group | gate, for `'agent'`-scope commands (`gateCommand` knows the group). For `'channel'`/`'host'` scope the gate cannot know the group — the handler resolves it itself (e.g. `/auth <scope>`) and must check `isAdmin(userId, resolvedGroupId)`; the flag then drives `/help` visibility only |
| `'global-admin'` | owner or global admin only — scoped-admin rows do **not** qualify (e.g. a command that exposes cross-group state) | gate, at both classifier tiers |

A failed access check produces the same `deny` result as an anonymous
sender: the router replies "Permission denied: <command> requires admin
access." and the handler never runs.

**`/help` is role-aware**: the overview lists only commands whose access
level the caller clears, and `/help <prefix>` reports inaccessible
commands as unknown. With no group resolvable at `/help`'s channel
scope, `'group-admin'` visibility is evaluated as "admin of any group"
(`hasAnyAdminRole`).

Introspection: `getHostCommandScope(prefix)` and
`getHostCommandAccess(prefix)` return the registered scope and access
level; `getRegisteredHostCommands()` lists the registered prefixes.

### `HostCommandContext`

```ts
interface HostCommandContext {
  command: string;                  // lowercased command word, e.g. "/auth"
  argsRaw: string;                  // everything after the command word
  args: string[];                   // whitespace-split argsRaw (no quoting)
  userId: string | null;            // always non-null at dispatch time
  agentGroupId: string | null;      // set for 'agent' scope, null otherwise
  messagingGroupId: string;         // channel the command originated in
  scope: HostCommandScope;          // dispatch scope ('agent' | 'channel' | 'host')
  reply: DeliveryAddress;           // channel / platform / thread to reply to
  replyText(text: string): void;
  beginInteraction(opts: BeginInteractionOptions): void;
}
```

- `agentGroupId` is the target agent only for `agent`-scope dispatch.
  For `channel`/`host` scope it is `null` — in those scopes the command
  is not associated with any particular wired agent.
- `userId` is typed nullable for forward compatibility, but the gate
  denies anonymous events before dispatch — a handler that runs always
  sees a non-null id.
- `args` is a plain whitespace split. No quoting, escapes, or shell-like
  parsing.
- `reply` mirrors the router's effective reply address, including any
  `replyTo` override carried by the inbound event.
- `replyText` sends the reply straight to the channel adapter via
  `deliverDirect` (no `messages_out` write, no polling latency). Up
  to 3 attempts with short backoff on transient adapter failure.

### `HostCommandHandler`

```ts
type HostCommandHandler = (ctx: HostCommandContext) => void | Promise<void>;
```

The router awaits the handler. Exceptions are caught by the router,
logged, and surfaced to the user as a generic `"Command failed."` reply
— the error message itself is never sent to chat.

### `beginInteraction(opts)` / `HostInteractionContext` / `HostInteractionHandler`

Exported from `src/host-interactions.js`. The `HostCommandContext.beginInteraction`
method is a thin wrapper that fills in the key, agent group, messaging
group, and reply writer from the current dispatch.

```ts
interface HostInteractionKey {
  channelType: string;
  platformId: string;
  threadId: string | null;
  userId: string | null;        // must be non-null at begin time
}

interface BeginInteractionOptions {
  handler: HostInteractionHandler;
  initialPrompt?: string;        // optional text sent right after begin
  timeoutMs?: number;            // default 10 * 60 * 1000
  onTimeout?: (key: HostInteractionKey, replyAddr: DeliveryAddress) => void;
  mode?: 'reject' | 'replace';   // conflict policy; default 'reject'
}

interface HostInteractionContext {
  readonly key: Readonly<HostInteractionKey>;
  readonly agentGroupId: string | null;  // captured at begin time
  readonly messagingGroupId: string;
  readonly reply: DeliveryAddress;
  readonly inboundContent: string;
  readonly inboundKind: 'chat' | 'chat-sdk';

  ask(text: string, nextHandler?: HostInteractionHandler): void;
  finish(text?: string): void;
  cancel(text?: string): void;
}

type HostInteractionHandler = (ctx: HostInteractionContext) => void | Promise<void>;

class BeginInteractionConflictError extends Error {}
```

Each turn the handler must call exactly one of `ask`, `finish`, or
`cancel`. A second lifecycle call within the same turn is ignored with
a warning. Returning without a decision releases the slot with a warning
logged. Throwing releases the slot with the error logged.

#### Beginning an interaction outside a command

`beginInteraction` is a plain function export, not tied to a
`HostCommandContext`. The `HostCommandContext.beginInteraction` method is
only a convenience wrapper that captures the key, agent group, messaging
group, and reply writer from the current dispatch. A host-side caller
that already has those values can open an interaction directly:

```ts
function beginInteraction(
  key: HostInteractionKey,
  agentGroupId: string | null,
  messagingGroupId: string,
  replyAddr: DeliveryAddress,
  writeReply: (text: string) => void,
  opts: BeginInteractionOptions,
): void;
```

The caller supplies the routing key (a non-null `userId` is required),
the agent/messaging group the interaction is associated with, the reply
address, and a `writeReply` closure that delivers text to the channel.
This is the same path the command-context wrapper uses; nothing about it
depends on a slash command having been issued.

### `parseSlashCommand(content)`

```ts
function parseSlashCommand(content: string): {
  command: string;             // lowercased, e.g. "/auth"
  argsRaw: string;             // everything after the command word
  args: string[];              // whitespace-split argsRaw
} | null;
```

Returns `null` if `content` doesn't begin with a slash command. Accepts
either a raw string or a JSON-wrapped chat payload (`{"text": "..."}`,
the shape chat adapters stamp). Whitespace before the leading `/` is
tolerated.

### `isAdmin(userId, agentGroupId?)`

```ts
function isAdmin(userId: string | null, agentGroupId?: string | null): boolean;
```

- With `agentGroupId`: true if `userId` has `owner` or `admin` role
  either globally (`agent_group_id IS NULL`) or scoped to
  `agentGroupId`.
- Without `agentGroupId` (or `null`): true only for global owner/admin.
  This is the natural form for messaging-group-scoped host commands.

False for `null` userId. If the permissions module is not installed
(no `user_roles` table), returns true — matches the host's standard
allow-all degradation when no permissions module is wired.

`hasAnyAdminRole(userId)` is the related predicate used where a
`'group-admin'` requirement must be evaluated with no resolvable group
(`/help` visibility at messaging-group level): true when `userId` holds
any owner/admin row at all, global or scoped to any group.

### `GateResult`

```ts
type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'handle'; command: string; handler: HostCommandHandler };
```

Consumers don't normally see `GateResult` — the router does. Listed
here because the `handle` variant is the public contract between the
gate and the router. The pre-fanout classifier returns a parallel
`MessagingGroupGateResult` for `channel`/`host`-scope commands.

## Behavior guarantees

- The container is never woken and never sees an inbound message that
  matched a registered host command. No row is written to the session
  inbound DB for that message.
- Dispatch cardinality depends on scope:
  - `agent`: once per **engaging** agent (engage_mode, engage_pattern,
    access gate, sender scope all apply, same as normal routing). An
    accumulating-but-not-engaging agent does not see the command.
  - `channel` / `host`: exactly once per inbound message, before
    fan-out, regardless of how many agents are wired.
- A handler's reply lands on the same channel address as the
  originating message (or the inbound's `replyTo` override, if any).
- Anonymous platform events (no `userId`) never invoke a handler.
  They produce a `deny` and a "Permission denied" reply.
- Handler exceptions are caught and produce a generic
  `"Command failed."` reply; the error and stack are logged but never
  delivered to chat.
- Classification precedence is stable: filter > registered host
  command > legacy admin commands > pass. A host registration with the
  same prefix as a built-in admin command wins.
- `/help` is always registered. Removing it requires a code change in
  `command-gate.ts`.
- Host interactions consume inbound **before** both classifier paths
  (`classifyAtMessagingGroup` and per-agent `gateCommand`). Slash
  commands a user types while a flow is active are delivered to the
  interaction handler as plain inbound — it is the handler's job to
  recognize patterns like `/cancel` if it wants to act on them.
- An interaction is keyed by `(channelType, platformId, threadId,
  userId)`. Two users in the same thread have independent slots. Two
  inbounds against the same slot are serialized — the second turn
  runs only after the first turn's `ask` / `finish` / `cancel`
  resolves.
- Outbound suppression matches by `(channelType, platformId, threadId)`
  — `messages_out` rows don't carry a per-recipient userId. In a
  shared thread, an interaction with user A pauses container output
  that may have been intended for everyone. Host-side reply traffic
  (commands / interactions / gate denials) is not affected: it never
  enters `messages_out` — it goes through `deliverDirect`, so the
  suppression predicate only ever sees container output and needs no
  exemption list.
- When any interaction releases, the active delivery poll is kicked
  immediately so paused rows drain without waiting a full poll
  interval.
- `'reject'` (default) conflict mode throws
  `BeginInteractionConflictError` if a slot is already active for the
  key. `'replace'` cancels the existing slot internally (no
  user-visible reply, no `onTimeout` for the displaced handler) and
  installs the new one.
- Interactions are in-memory. On host restart they are lost; the user
  sees their next message routed normally.
- Adapter button responses (`onAction`) bypass the interaction
  pipeline entirely — they continue to flow to the `interactive` /
  `approvals` modules.

## Consumer usage

### Agent-scope command (default)

```ts
import { registerHostCommand, isAdmin } from '../../command-gate.js';

registerHostCommand(
  '/auth',
  async (ctx) => {
    // ctx.agentGroupId is non-null here — agent-scope dispatch.
    if (ctx.args[0] === 'status') {
      ctx.replyText(
        `You have ${countGrants(ctx.userId, ctx.agentGroupId)} active grants.`,
      );
      return;
    }
    if (ctx.args[0] === 'grant') {
      if (!isAdmin(ctx.userId, ctx.agentGroupId)) {
        ctx.replyText('Permission denied.');
        return;
      }
      // ... grant flow scoped to ctx.agentGroupId ...
    }
  },
  { help: 'Manage credential grants' },
);
```

### Channel-scope command

```ts
registerHostCommand(
  '/quota',
  (ctx) => {
    // ctx.agentGroupId is null — query channel-level quota state.
    ctx.replyText(channelQuotaSummary(ctx.messagingGroupId));
  },
  { help: 'Show channel usage / quota', scope: 'channel' },
);
```

### Host-scope command

```ts
registerHostCommand(
  '/claude-update',
  async (ctx) => {
    // Affects all agents in the host process; global admin only.
    if (!isAdmin(ctx.userId)) {
      ctx.replyText('Permission denied: admin only.');
      return;
    }
    await runUpdate();
    ctx.replyText('Update complete.');
  },
  { help: 'Update the Claude Code CLI (admin only)', scope: 'host' },
);
```

### Multi-turn flow via `beginInteraction`

```ts
registerHostCommand('/auth', (ctx) => {
  if (ctx.args[0] !== 'import') {
    ctx.replyText('Usage: /auth import');
    return;
  }
  ctx.beginInteraction({
    initialPrompt: 'Paste your token (will not be logged):',
    timeoutMs: 2 * 60 * 1000,
    handler: async (ictx) => {
      const token = JSON.parse(ictx.inboundContent).text;
      try {
        await storeCredential(token, ctx.agentGroupId);
        ictx.finish('Stored.');
      } catch (e) {
        ictx.cancel(`Failed: ${(e as Error).message}`);
      }
    },
  });
});
```

The command returns immediately after `beginInteraction`. The user's
next chat message in this `(channelType, platformId, threadId)` arrives
at the interaction handler with `inboundContent` set to the raw message
content. The handler calls `finish` (or `cancel`) to release the slot
and resume normal routing.

### Discovering registered commands

`/help` (no argument) returns a composed list of every host command
registered with a `help` string plus the static container-command
table. `/help <name>` returns the one-line description for a single
command; the leading `/` is optional in the argument.

## Boundaries

**Not in scope:**

- Quoting / escape parsing for command arguments. `args` is always a
  plain whitespace split.
- Persistence of registrations. They live in memory and are
  re-established on every process start.
- DB-backed persistence of interactions. Slots live in memory only;
  on process restart they are dropped and the user's next message
  routes normally.
- Resuming an interaction across process restarts.
- Per-turn varying `timeoutMs`. The timeout is set once at
  `beginInteraction` and reused across `ask` turns.
- Cross-channel handoff of an interaction. An interaction is fixed to
  its begin-time key for its entire lifetime.
- Cancelling an active interaction from another command (e.g. a
  generic host-level `/cancel`). The active handler must recognize and
  act on it itself.
- Per-handler authorization beyond `isAdmin`. Handlers do their own
  domain-specific auth (credential ownership, grant membership, etc.)
  in their own code.
- Forwarding `/help` to the container. The host owns the help output;
  the container's native `/help` is not invoked.

**Disambiguation:**

- In a multi-agent channel, an `agent`-scope command dispatches to
  every agent that engages on the inbound. The engage rules
  (engage_mode, engage_pattern) are the disambiguation surface. If a
  user wants the command to land on exactly one agent, configure the
  wirings so only that agent engages on the relevant prefix or
  mention. There is no separate routing concept for host commands —
  they share the engage layer with normal messages.

**Known asymmetry:**

- `ADMIN_COMMANDS` denial (the legacy admin gate for built-ins like
  `/clear`) runs per-agent inside the fan-out: in a multi-agent
  channel, a non-admin who types `/clear` receives one
  "Permission denied" reply per engaging agent.

**Dependencies / required peers:**

- Expects the `user_roles` table from the permissions module to exist
  if `isAdmin` is to do anything meaningful; degrades to "always
  admin" if absent (host-wide allow-all when no permissions module).

## Failure modes

| Situation                                 | Signal                                                       |
| ----------------------------------------- | ------------------------------------------------------------ |
| Handler throws                            | Generic `"Command failed."` reply; error logged via `log.error`. |
| Anonymous caller hits a registered prefix | `deny` with `"Permission denied: <prefix> requires admin access."` |
| Prefix not registered                     | Falls through to legacy admin / pass classification.         |
| Re-registration of same prefix            | Warning logged; latest registration wins.                    |
| Registering a prefix without leading `/`  | `registerHostCommand` throws synchronously.                  |
| Interaction handler throws or returns without a decision | Slot released; error/warning logged. |
| Adapter delivery fails for a host reply   | Up to 3 attempts with short backoff; permanent failure logged (no `messages_out` row to mark failed). |

## Extension points

- `HostCommandContext` is a TypeScript `interface`, so future fields or
  methods can be added without breaking existing handlers (the
  `beginInteraction` method was added this way).
- `registerHostCommand` accepts an options object; new options can be
  added without changing the existing signature.
- The container-command help table is a static map inside
  `command-gate.ts`. New built-ins (or removed ones) are a one-line
  edit there.

## Test coverage

- Classifier precedence: filter > registered host > legacy admin >
  pass; including the deliberate `/cost` overlap test that asserts
  host registration overrides the built-in admin entry.
- Authentication: anonymous denied; authenticated dispatched.
- Re-registration: warning logged + last writer wins.
- Case-insensitive matching on both the registration prefix and the
  inbound command word.
- Argument parsing: bare command (no args), whitespace-only split,
  JSON-wrapped chat content, leading whitespace in the text.
- `isAdmin` exported and resolves owner / global-admin / scoped-admin
  the same as the internal classifier path.
- `/help` behaviors: overview output includes registered hosts and
  container commands; `/help <known>` returns the entry; arg with or
  without leading `/`; `/help <unknown>` returns "Unknown command";
  role-aware listing hides commands the caller can't access.
- Router integration: handler invoked with parsed args; inbound DB
  unchanged; container not woken; reply delivered; handler exception
  produces the generic reply text and does not crash the router.
- Scope routing:
  - `agent`-scope command in a multi-agent channel where both agents
    engage on `pattern='.'` dispatches twice, with each call receiving
    its own `agentGroupId`.
  - `agent`-scope command in a multi-agent channel where only one
    agent's engage rule matches dispatches once, on that agent only.
  - `channel`-scope command in a multi-agent channel dispatches once
    with `agentGroupId=null`; only one reply is delivered.
- Host interactions (`src/host-interactions.test.ts`):
  - `beginInteraction` registers a slot; `getActiveInteraction`
    returns the current handler.
  - `ask` replies and keeps the slot; `ask(text, nextHandler)` swaps
    the handler for the next turn.
  - `finish` / `cancel` release the slot; further inbounds aren't
    consumed.
  - Timeout: slot released, `onTimeout` fires once.
  - `'reject'` (default) throws `BeginInteractionConflictError`;
    `'replace'` swaps handlers without firing the displaced
    `onTimeout`.
  - Two users in the same thread have independent slots.
  - Handler returning without ask/finish/cancel releases the slot
    with a warning.
  - Concurrent inbounds against the same slot are serialized.
  - `beginInteraction` with `userId: null` throws;
    `deliverToActiveInteraction` with `userId: null` returns false and
    does not touch the slot map.
  - Outbound pause matches by `(channel, platform, thread)`; host-owned
    reply traffic is unaffected because it never enters `messages_out`.
- Host-interaction router/delivery integration:
  - A host command begins an interaction; the user's next chat goes
    to the handler — not the session inbound, not `gateCommand`,
    no container wake.
  - After `finish`, the next chat flows normally to the session and
    wakes the container.
  - Outbound suppression: with a flow active, a container-emitted
    `messages_out` row stays paused and host-owned reply rows
    deliver immediately; once the flow ends, the paused row drains.
  - A second invocation of the same slash-command while a flow is
    active is consumed by the flow rather than re-entering the
    command handler.
