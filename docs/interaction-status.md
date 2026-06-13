# Interaction Status Registry

A reusable, host-side observability primitive for tracking multi-stage
interactions and broadcasting their progress to subscribers. Any host feature
whose work proceeds through distinct stages — an OAuth handshake, a device-code
flow, a notification that is queued and later presented — can emit timestamped
events keyed by an interaction id. Consumers read that progress either by
polling the registry directly or by subscribing over Server-Sent Events (SSE).

The registry is domain-agnostic: it imposes no meaning on interaction ids or
explanations, and it does not know who emits or why. State is held purely in
memory — there is no persistence, no database, and no IO outside the SSE
response writes.

## Module shape

`src/modules/interaction-status/`:

| File | Purpose |
|------|---------|
| `types.ts` | `InteractionEventKind`, `InteractionState`, `InteractionEvent` |
| `registry.ts` | `InteractionStatusRegistry` class |
| `index.ts` | Barrel: re-exports + the process-wide singleton accessor |

This module is not side-effecting. It does not register itself in
`src/modules/index.ts`, and it wires no HTTP routes on its own. A caller that
wants to expose the SSE and list endpoints is responsible for routing requests
to `handleSSE` and `handleListInteractions`.

## Model

An **interaction** is identified by an opaque string id (e.g. `github:12345`,
`google:1`). Each interaction owns an ordered list of **events**. An event
records:

```ts
interface InteractionEvent {
  state: InteractionState;       // 'queued' | 'active' | 'completed' | 'failed' | 'removed'
  eventType: InteractionEventKind; // 'notification' | 'oauth-start' | 'oauth-refresh' | 'device-code'
  explanation: string;           // human-readable description of this event
  timestamp: number;             // Date.now() at emit time
}
```

`InteractionState` is the lifecycle stage the interaction is in as of that
event. The **current state** of an interaction is the state of its most recent
event.

`InteractionEventKind` is the category of the event, controlling how a consumer
formats or routes it. The set is open by design — new kinds are added in place
as features need them.

Both enums are deliberately small string unions so that consumers can switch on
them exhaustively.

## API

### `emit(interactionId, eventType, state, explanation)`

Appends a new event to the interaction, creating the interaction record on
first emit. The event's timestamp is set to `Date.now()`. After recording, the
event is broadcast to every SSE subscriber of that interaction. A subscriber
whose write throws (e.g. a closed connection) is dropped from the subscriber
set.

### `currentState(interactionId): InteractionState | null`

Returns the state of the most recent event, or `null` if the interaction is
unknown or has no events.

### `events(interactionId): InteractionEvent[]`

Returns the full ordered event list for an interaction, or an empty array if
unknown.

### `listInteractions(): Array<{ interactionId, state, eventType }>`

Returns one entry per tracked interaction that has at least one event, carrying
the id alongside the current state and the current event's kind. Interactions
created without any events (see `handleSSE` below) are omitted.

### `destroy()`

Closes every open SSE connection across all interactions and clears all state.
Used to tear the registry down cleanly.

## HTTP handlers

The registry provides two Node `http` request handlers. They are not bound to
any server here; the embedding application maps routes to them.

### `handleSSE(interactionId, req, res)` — `GET /interaction/{interactionId}/events`

Opens an SSE stream:

1. Writes the SSE headers (`content-type: text/event-stream`,
   `cache-control: no-cache`, `connection: keep-alive`).
2. Ensures an interaction record exists, creating an empty one if needed. (A
   subscription to an id that has never emitted therefore creates a record with
   no events — such a record has `currentState` of `null` and does not appear
   in `listInteractions`.)
3. Replays all existing events to the new subscriber so it sees the full
   history on connect.
4. Adds the response to the interaction's subscriber set and removes it again
   when the connection closes.

Each event is written in SSE wire format with the interaction **state** as the
event name and a JSON payload carrying `eventType` and `explanation`:

```
event: active
data: {"eventType":"notification","explanation":"presenting to user"}

```

### `handleListInteractions(req, res)` — `GET /interactions`

Writes a `200` with `content-type: application/json` and a body equal to the
result of `listInteractions()`.

## Usage

Most callers share a single registry through the lazy process-wide singleton:

```ts
import { getInteractionStatusRegistry } from '../modules/interaction-status/index.js';

const registry = getInteractionStatusRegistry();
registry.emit('github:12345', 'notification', 'queued', 'new event');
registry.emit('github:12345', 'notification', 'active', 'presenting to user');
```

The singleton is created on first access and reused thereafter. Tests and
scoped lifetimes can instead construct `InteractionStatusRegistry` directly to
get an isolated instance.
