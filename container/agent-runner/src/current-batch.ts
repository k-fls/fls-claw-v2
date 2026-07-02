/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

/**
 * Turn-scoped flag: did this turn deliver a user-facing message via the
 * `send_message` MCP tool?
 *
 * The poll-loop's `result` handler uses this to decide whether the
 * "your response wasn't delivered — re-wrap it" nudge should fire. Without
 * it, an agent that answers via `send_message` and then ends the turn with
 * bare text (no `<message>` block) gets nudged and re-sends the same content,
 * producing a duplicate reply.
 *
 * The flag is captured in-process by *observing* the tool call in the
 * PreToolUse hook (which runs in the poll-loop process even though
 * `send_message` itself executes in the MCP subprocess). It is module-level
 * state for the same reason `currentInReplyTo` is: the agent-runner is
 * single-process and processes one turn at a time.
 *
 * Lifecycle: reset at turn start (initial batch and every follow-up push),
 * set (only ever set, never cleared) when `send_message` is observed. It must
 * NOT be reset on other tool calls — agents routinely run follow-up tools
 * after `send_message`, and clearing there would let the nudge fire again and
 * reintroduce the duplicate.
 */
let sentUserMsgThisTurn = false;

export function markSentUserMsgThisTurn(): void {
  sentUserMsgThisTurn = true;
}

export function resetSentUserMsgThisTurn(): void {
  sentUserMsgThisTurn = false;
}

export function hasSentUserMsgThisTurn(): boolean {
  return sentUserMsgThisTurn;
}

