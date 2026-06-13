/**
 * Host-side interaction primitive (task A1a).
 *
 * A host command can call `beginInteraction` to seize the inbound routing
 * slot for `(channelType, platformId, threadId, userId)`. While the slot
 * is active, the user's next chat messages on that key are delivered to
 * the interaction's handler instead of being classified by command-gate
 * or written to the session inbound. The handler decides each turn:
 *
 *   - `ask(text, nextHandler?)` — reply, keep the slot open, optionally
 *     swap in a new handler for the next turn.
 *   - `finish(text?)`          — reply (optional), release the slot.
 *   - `cancel(text?)`          — reply (optional), release the slot.
 *
 * A per-slot timeout (default 10 min) releases the slot if the user goes
 * idle. Slots are in-memory; on process restart they are gone.
 *
 * While a slot is active for `(channelType, platformId, threadId)` (note:
 * outbound rows don't carry userId), outbound delivery for that channel
 * address is **paused** so the container's chatter doesn't interleave
 * with the flow's prompts. Reply traffic from the interaction itself is
 * exempt via the `host-int-` id prefix (see `isOutboundPaused`).
 *
 * Concurrency: per-slot async mutex. Two inbounds arriving fast against
 * the same key are serialized — the second runs after the first
 * `ask`/`finish`/`cancel` completes.
 *
 * Imports of this module are limited to `command-gate.ts` (for the
 * `beginInteraction` method on HostCommandContext), `router.ts` (inbound
 * dispatch), and `delivery.ts` + `session-manager.ts` (outbound-suppression
 * predicate + resume subscription).
 */
import { log } from './log.js';
import type { DeliveryAddress } from './channels/adapter.js';

// ── Public types ──

export interface HostInteractionKey {
  channelType: string;
  platformId: string;
  threadId: string | null;
  userId: string | null;
}

export interface HostInteractionContext {
  /** The key this interaction is bound to. */
  readonly key: Readonly<HostInteractionKey>;
  /** Agent group captured at begin time. Non-null for `agent`-scope commands; null for `channel`/`host` scope. */
  readonly agentGroupId: string | null;
  /** Messaging group of the originating channel. */
  readonly messagingGroupId: string;
  /** Where replies are written to. Equals the originating event's deliveryAddr. */
  readonly reply: DeliveryAddress;
  /** Raw content of the user's latest inbound message. */
  readonly inboundContent: string;
  /** Message kind, mirrors the router's event.message.kind. */
  readonly inboundKind: 'chat' | 'chat-sdk';

  /**
   * Reply (if `text` non-empty) and keep the interaction open. If
   * `nextHandler` is provided, it replaces the current handler for the
   * next turn; otherwise the current handler is reused.
   */
  ask(text: string, nextHandler?: HostInteractionHandler): void;
  /** Reply (optional) and release the slot. */
  finish(text?: string): void;
  /** Reply (optional) and release the slot. */
  cancel(text?: string): void;
}

export type HostInteractionHandler = (ctx: HostInteractionContext) => void | Promise<void>;

export interface BeginInteractionOptions {
  handler: HostInteractionHandler;
  /** Optional text to send right after begin. */
  initialPrompt?: string;
  /** Slot timeout in ms. Default 10 * 60 * 1000. */
  timeoutMs?: number;
  /** Called once when the slot is released by timeout (before the slot is freed). */
  onTimeout?: (key: HostInteractionKey, replyAddr: DeliveryAddress) => void;
  /** Behavior when a slot is already active for the key. Default 'reject'. */
  mode?: 'reject' | 'replace';
}

export class BeginInteractionConflictError extends Error {
  constructor(key: HostInteractionKey) {
    super(`Host interaction already active for key ${serializeKey(key)}`);
    this.name = 'BeginInteractionConflictError';
  }
}

// ── Internals ──

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Write closure used to send a reply from inside an interaction turn.
 * Bound at begin time to a direct-adapter sender (see `deliverDirect`
 * in delivery.ts) — interaction replies never enter `messages_out`, so
 * `isOutboundPaused` only ever sees container traffic.
 */
type ReplyWriter = (text: string) => void;

interface InteractionState {
  key: HostInteractionKey;
  agentGroupId: string | null;
  messagingGroupId: string;
  replyAddr: DeliveryAddress;
  /** Writer captured at begin time (bound to the anchor session). */
  writeReply: ReplyWriter;
  handler: HostInteractionHandler;
  timeoutMs: number;
  onTimeout?: (key: HostInteractionKey, replyAddr: DeliveryAddress) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Serializes concurrent inbounds against the same slot. */
  mutex: AsyncMutex;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function serializeKey(k: HostInteractionKey): string {
  return `${k.channelType}|${k.platformId}|${k.threadId ?? ''}|${k.userId ?? ''}`;
}

const slots = new Map<string, InteractionState>();

/** Per-key release subscribers. Fired and cleared on each release. */
const releaseSubscribers = new Map<string, Set<() => void>>();
/** Global release subscribers (used by the delivery loop). Persist across releases. */
const anyReleaseSubscribers = new Set<() => void>();

// ── API ──

export function getActiveInteraction(key: HostInteractionKey): HostInteractionHandler | undefined {
  if (key.userId == null) return undefined;
  return slots.get(serializeKey(key))?.handler;
}

export function getActiveInteractionKeys(): readonly HostInteractionKey[] {
  return Array.from(slots.values()).map((s) => ({ ...s.key }));
}

/**
 * Begin a host interaction.
 *
 * @throws BeginInteractionConflictError if a slot is already active for
 * the key and `opts.mode !== 'replace'`.
 */
export function beginInteraction(
  key: HostInteractionKey,
  agentGroupId: string | null,
  messagingGroupId: string,
  replyAddr: DeliveryAddress,
  writeReply: ReplyWriter,
  opts: BeginInteractionOptions,
): void {
  if (key.userId == null) {
    throw new Error('beginInteraction requires a non-null userId — interactions need an identifiable user');
  }
  const skey = serializeKey(key);
  const existing = slots.get(skey);
  if (existing) {
    if (opts.mode === 'replace') {
      // Internal release — no user-visible reply, no onTimeout firing.
      clearTimer(existing);
      slots.delete(skey);
      log.info('Host interaction replaced', { key: skey });
      fireReleaseSubscribers(skey);
    } else {
      throw new BeginInteractionConflictError(key);
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state: InteractionState = {
    key,
    agentGroupId,
    messagingGroupId,
    replyAddr,
    writeReply,
    handler: opts.handler,
    timeoutMs,
    onTimeout: opts.onTimeout,
    timer: null,
    mutex: new AsyncMutex(),
  };
  state.timer = setTimeout(() => fireTimeout(skey), timeoutMs);
  slots.set(skey, state);
  log.info('Host interaction begin', {
    key: skey,
    agentGroupId,
    messagingGroupId,
    timeoutMs,
  });

  if (opts.initialPrompt && opts.initialPrompt.length > 0) {
    try {
      writeReply(opts.initialPrompt);
    } catch (err) {
      log.error('Host interaction initialPrompt write failed', { key: skey, err });
    }
  }
}

/**
 * Router pipeline entry point. Returns true if the inbound was consumed
 * by an active interaction (router must skip command-gate /
 * writeSessionMessage / wakeContainer for this event).
 *
 * No-op (returns false) when:
 *   - `key.userId` is null (interactions require an identifiable user).
 *   - no slot is registered for the key.
 */
export async function deliverToActiveInteraction(
  key: HostInteractionKey,
  inboundContent: string,
  inboundKind: 'chat' | 'chat-sdk',
): Promise<boolean> {
  if (key.userId == null) return false;
  const skey = serializeKey(key);
  const state = slots.get(skey);
  if (!state) return false;

  await state.mutex.run(async () => {
    // Re-check after acquiring the lock — a previous turn may have released.
    if (!slots.has(skey)) return;
    clearTimer(state);

    let action: 'ask' | 'finish' | 'cancel' | null = null;
    let nextHandler: HostInteractionHandler | undefined;

    const ctx: HostInteractionContext = {
      key,
      agentGroupId: state.agentGroupId,
      messagingGroupId: state.messagingGroupId,
      reply: state.replyAddr,
      inboundContent,
      inboundKind,
      ask: (text, nh) => {
        if (action) {
          log.warn('Host interaction ctx.ask called after lifecycle decision', { key: skey, prior: action });
          return;
        }
        action = 'ask';
        nextHandler = nh;
        if (text.length > 0) state.writeReply(text);
      },
      finish: (text) => {
        if (action) {
          log.warn('Host interaction ctx.finish called after lifecycle decision', { key: skey, prior: action });
          return;
        }
        action = 'finish';
        if (text && text.length > 0) state.writeReply(text);
      },
      cancel: (text) => {
        if (action) {
          log.warn('Host interaction ctx.cancel called after lifecycle decision', { key: skey, prior: action });
          return;
        }
        action = 'cancel';
        if (text && text.length > 0) state.writeReply(text);
      },
    };

    try {
      await state.handler(ctx);
    } catch (err) {
      log.error('Host interaction handler threw — cancelling slot', { key: skey, err });
      slots.delete(skey);
      log.info('Host interaction release', { key: skey, reason: 'handler-threw' });
      fireReleaseSubscribers(skey);
      return;
    }

    if (action == null) {
      log.warn('Host interaction handler returned without ask/finish/cancel — releasing slot', { key: skey });
      slots.delete(skey);
      log.info('Host interaction release', { key: skey, reason: 'no-decision' });
      fireReleaseSubscribers(skey);
      return;
    }

    if (action === 'ask') {
      if (nextHandler) state.handler = nextHandler;
      state.timer = setTimeout(() => fireTimeout(skey), state.timeoutMs);
      log.info('Host interaction turn (ask)', { key: skey, handlerSwapped: nextHandler != null });
    } else {
      slots.delete(skey);
      log.info('Host interaction release', { key: skey, reason: action });
      fireReleaseSubscribers(skey);
    }
  });

  return true;
}

/**
 * Should outbound delivery be paused for this row?
 *
 * Returns true when an interaction is active for any `(channelType,
 * platformId, threadId, *)` matching the row's address — outbound rows
 * don't carry userId, so the userId field of the active slot is ignored
 * here.
 *
 * Host-side reply traffic (host commands, interactions, gate denials)
 * does NOT enter `messages_out` at all — it goes through
 * `deliverDirect` straight to the channel adapter — so this predicate
 * only ever sees container output and never needs an exemption list.
 *
 * Known limitation: two users in the same group thread share the same
 * outbound key from this predicate's perspective, so an interaction with
 * user A pauses delivery of agent output that may have been intended for
 * everyone in the thread. Revisit if/when outbound rows acquire a
 * per-recipient field.
 */
export function isOutboundPaused(
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
): boolean {
  if (!channelType || !platformId) return false;
  for (const state of slots.values()) {
    if (
      state.key.channelType === channelType &&
      state.key.platformId === platformId &&
      state.key.threadId === threadId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Subscribe to release events for a specific key. The callback fires
 * **once** when any interaction for `key` releases (finish/cancel/
 * timeout/replace) and is then removed. Returns an unsubscribe handle.
 */
export function onInteractionRelease(key: HostInteractionKey, cb: () => void): () => void {
  const skey = serializeKey(key);
  let set = releaseSubscribers.get(skey);
  if (!set) {
    set = new Set();
    releaseSubscribers.set(skey, set);
  }
  set.add(cb);
  return () => {
    const s = releaseSubscribers.get(skey);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) releaseSubscribers.delete(skey);
  };
}

/**
 * Subscribe to **any** interaction release. The callback persists across
 * releases (does NOT auto-remove) — caller must use the returned
 * unsubscribe handle. Used by the delivery loop to kick a re-drain
 * whenever any slot frees.
 */
export function onAnyInteractionRelease(cb: () => void): () => void {
  anyReleaseSubscribers.add(cb);
  return () => anyReleaseSubscribers.delete(cb);
}

/** Test-only: drop all slots and subscribers without firing anything. */
export function _resetHostInteractionsForTesting(): void {
  for (const state of slots.values()) clearTimer(state);
  slots.clear();
  releaseSubscribers.clear();
  anyReleaseSubscribers.clear();
}

// ── Helpers ──

function clearTimer(state: InteractionState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function fireTimeout(skey: string): void {
  const state = slots.get(skey);
  if (!state) return;
  slots.delete(skey);
  log.info('Host interaction release', { key: skey, reason: 'timeout' });
  if (state.onTimeout) {
    try {
      state.onTimeout(state.key, state.replyAddr);
    } catch (err) {
      log.error('Host interaction onTimeout threw', { key: skey, err });
    }
  }
  fireReleaseSubscribers(skey);
}

function fireReleaseSubscribers(skey: string): void {
  const set = releaseSubscribers.get(skey);
  if (set) {
    releaseSubscribers.delete(skey);
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        log.error('onInteractionRelease subscriber threw', { key: skey, err });
      }
    }
  }
  for (const cb of anyReleaseSubscribers) {
    try {
      cb();
    } catch (err) {
      log.error('onAnyInteractionRelease subscriber threw', { err });
    }
  }
}
