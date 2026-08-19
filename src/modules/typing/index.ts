/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';
import { readEnvFile } from '../../env.js';
import type { OutboundFile, ReactionOutcome } from '../../channels/adapter.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

/**
 * Channels whose native typing signal does not render, so a held reaction is
 * used instead. Slack's `setStatus` only draws inside its assistant surface,
 * so DMs and channel threads are equally blind — hence gated on channel, not
 * on thread shape.
 */
const WORKING_INDICATOR_CHANNELS = new Set(['slack']);

const INDICATOR_EMOJI_KEY = 'SLACK_TYPING_EMOJI';
/** Built-in, so a fresh install gets a correct (static) indicator unconfigured. */
const DEFAULT_INDICATOR_EMOJI = 'hourglass_flowing_sand';

/**
 * Unset → the default. A name → used verbatim. Empty → the feature is off,
 * which is the kill switch; `keepEmpty` is what preserves that distinction.
 */
const INDICATOR_EMOJI =
  readEnvFile([INDICATOR_EMOJI_KEY], { keepEmpty: true })[INDICATOR_EMOJI_KEY] ?? DEFAULT_INDICATOR_EMOJI;

/** Fallback for an app without the reaction scope; fixed text, not a progress surface. */
const PLACEHOLDER_TEXT = '_working…_';

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
  pulseReaction?(
    channelType: string,
    platformId: string,
    messageId: string,
    emoji: string,
    on: boolean,
    instance?: string,
  ): Promise<ReactionOutcome>;
  deliver?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    instance?: string,
  ): Promise<string | undefined>;
  deleteMessage?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    messageId: string,
    instance?: string,
  ): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /** Message the indicator sits on; null when there is no usable target. */
  indicatorMessageId: string | null;
  /** Whether THIS session holds a count on that message. */
  indicatorShown: boolean;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Holders per `instance|chat|message`; add on 0→1, remove on 1→0.
 *
 * One inbound message fans out to every wired agent, so N agents mean N
 * refreshers on one message — without counting, the first to finish strips the
 * indicator from the rest. The instance is in the key because two Slack apps
 * are two distinct users whose reactions cannot cancel each other.
 */
const indicatorHolders = new Map<string, number>();

/**
 * Instances whose app lacks the reaction scope, latched on first refusal.
 * Process-lifetime is safe: granting the scope needs an app reinstall, whose
 * new token needs a host restart anyway.
 */
const reactionUnsupportedInstances = new Set<string>();

/**
 * What an acquire did, so the release undoes that. A bare message id cannot
 * express it: "no placeholder id" is true both for the reaction path and for a
 * latched instance whose placeholder post failed, which want opposite teardowns.
 */
type IndicatorHold = { kind: 'reaction' } | { kind: 'placeholder'; messageId?: string };

/**
 * Tail of the per-target operation chain; `null` means nothing is held.
 *
 * Acquire and release are both async and either can be in flight when the
 * other is requested (a burst can end before its add lands; the router can
 * stop and restart a refresher on a failed wake). Unserialized, an older
 * release resolves after a newer acquire and strips a live indicator.
 */
const indicatorOps = new Map<string, Promise<IndicatorHold | null>>();

/**
 * Snapshotted address, so async teardown is immune to the entry moving
 * underneath it — agent-shared sessions can be re-triggered from another chat.
 */
interface IndicatorTarget {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
  messageId: string;
}

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

/** Gated on channel and on having a target — deliberately NOT on thread shape. */
function usesWorkingIndicator(entry: TypingTarget): boolean {
  return (
    INDICATOR_EMOJI !== '' && entry.indicatorMessageId !== null && WORKING_INDICATOR_CHANNELS.has(entry.channelType)
  );
}

function targetOf(entry: TypingTarget): IndicatorTarget {
  return {
    channelType: entry.channelType,
    platformId: entry.platformId,
    threadId: entry.threadId,
    instance: entry.instance,
    messageId: entry.indicatorMessageId!,
  };
}

function instanceKey(t: IndicatorTarget): string {
  return t.instance ?? t.channelType;
}

function indicatorKey(t: IndicatorTarget): string {
  return `${instanceKey(t)}|${t.platformId}|${t.messageId}`;
}

/** Never throws: an indicator must not be able to break routing or delivery. */
async function pulseIndicator(t: IndicatorTarget, on: boolean): Promise<ReactionOutcome> {
  try {
    const outcome = await adapter?.pulseReaction?.(
      t.channelType,
      t.platformId,
      t.messageId,
      INDICATOR_EMOJI,
      on,
      t.instance,
    );
    return outcome ?? 'failed';
  } catch {
    return 'failed';
  }
}

/** Post the fallback placeholder, returning its id — or undefined if it failed. */
async function postPlaceholder(t: IndicatorTarget): Promise<string | undefined> {
  try {
    return await adapter?.deliver?.(
      t.channelType,
      t.platformId,
      t.threadId,
      'chat',
      JSON.stringify({ text: PLACEHOLDER_TEXT }),
      undefined,
      t.instance,
    );
  } catch {
    return undefined;
  }
}

/** Never throws; a stranded placeholder beats breaking the refresh loop. */
async function deletePlaceholder(t: IndicatorTarget, messageId: string): Promise<void> {
  try {
    await adapter?.deleteMessage?.(t.channelType, t.platformId, t.threadId, messageId, t.instance);
  } catch {
    // swallowed — see above
  }
}

/** Reaction first; a permission refusal latches the instance onto the placeholder. */
async function acquireIndicator(t: IndicatorTarget): Promise<IndicatorHold> {
  if (!reactionUnsupportedInstances.has(instanceKey(t))) {
    const outcome = await pulseIndicator(t, true);
    if (outcome !== 'unsupported') return { kind: 'reaction' };
    reactionUnsupportedInstances.add(instanceKey(t));
  }
  return { kind: 'placeholder', messageId: await postPlaceholder(t) };
}

/** Undo exactly what the matching acquire did. */
async function releaseIndicator(t: IndicatorTarget, hold: IndicatorHold): Promise<void> {
  if (hold.kind === 'placeholder') {
    if (hold.messageId !== undefined) await deletePlaceholder(t, hold.messageId);
    return;
  }
  const outcome = await pulseIndicator(t, false);
  if (outcome === 'ok') return;
  // A failed remove strands a reaction permanently: nothing revisits that
  // message, and unlike a native indicator it does not expire.
  log.warn('Working indicator could not be cleared', {
    channelType: t.channelType,
    platformId: t.platformId,
    messageId: t.messageId,
    instance: t.instance,
    outcome,
  });
}

/** Idempotent — this is what makes the tick a liveness check, not a driver. */
function showIndicator(entry: TypingTarget): void {
  if (entry.indicatorShown || !usesWorkingIndicator(entry)) return;
  // Nothing behind the seam yet: index.ts starts channels — and so can route
  // inbound — before it binds the delivery adapter. Taking a hold here would
  // claim a reaction nothing placed, suppress the indicator for the rest of
  // the burst, and fire a bogus remove at teardown. Skipping leaves
  // indicatorShown false, so the next tick retries once the adapter is bound.
  if (!adapter?.pulseReaction && !adapter?.deliver) return;
  const t = targetOf(entry);
  const key = indicatorKey(t);
  const held = indicatorHolders.get(key) ?? 0;
  indicatorHolders.set(key, held + 1);
  entry.indicatorShown = true;
  if (held > 0) return;
  const prior = indicatorOps.get(key) ?? Promise.resolve(null);
  indicatorOps.set(
    key,
    prior.then(() => acquireIndicator(t)).catch(() => null),
  );
}

/** Must run BEFORE any mutation of the entry's address: it releases the key it acquired. */
function hideIndicator(entry: TypingTarget): void {
  if (!entry.indicatorShown) return;
  const t = targetOf(entry);
  const key = indicatorKey(t);
  const remaining = (indicatorHolders.get(key) ?? 1) - 1;
  entry.indicatorShown = false;
  if (remaining > 0) {
    indicatorHolders.set(key, remaining);
    return;
  }
  indicatorHolders.delete(key);
  // Chained so teardown matches setup, and a re-acquire queues behind it.
  const prior = indicatorOps.get(key) ?? Promise.resolve(null);
  const settled: Promise<IndicatorHold | null> = prior
    .then(async (hold) => {
      if (hold) await releaseIndicator(t, hold);
      return null;
    })
    .catch(() => null);
  indicatorOps.set(key, settled);
  // Drop once idle so the map does not grow per message ever reacted to.
  void settled.then(() => {
    if (indicatorOps.get(key) === settled) indicatorOps.delete(key);
  });
}

/** Shared by the immediate tick, the interval tick, and the re-trigger. */
function fireWorkingSignal(entry: TypingTarget): void {
  if (usesWorkingIndicator(entry)) {
    showIndicator(entry);
    return;
  }
  triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
}

/**
 * @param triggerMessageId RAW inbound message id, not the agent-namespaced one
 *   written to messages_in — on Slack the raw id is the `ts` reactions need.
 *   Absent means no indicator: the router synthesizes an id when the event
 *   carries none, and a synthesized id is not a `ts`.
 */
export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  triggerMessageId?: string | null,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // A re-trigger can arrive from a different chat (agent-shared sessions span
    // messaging groups and platforms), so release the held indicator against the
    // OLD address before moving. threadId counts as address because the fallback
    // placeholder is posted INTO the thread.
    const addressChanged =
      existing.channelType !== channelType ||
      existing.platformId !== platformId ||
      existing.instance !== instance ||
      existing.threadId !== threadId;
    if (addressChanged) {
      hideIndicator(existing);
      existing.indicatorMessageId = null;
    }
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    // Keep the stored entry self-consistent: the address fields and the
    // owning instance must move together — a torn entry (old address + new
    // instance) would hand e.g. a telegram platformId to a Slack instance's
    // setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    // Held means mid-burst, so the target stays put. Not held means the burst
    // ended — delivery clears the indicator but leaves the id, so re-seeding
    // here is what stops the next turn lighting up on the previous message.
    if (triggerMessageId && (existing.indicatorMessageId === null || !existing.indicatorShown)) {
      existing.indicatorMessageId = triggerMessageId;
    }
    fireWorkingSignal(existing);
    return;
  }

  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip the signal but keep the
    // interval running so we resume automatically once the pause
    // expires.
    const now = Date.now();
    if (entry.pausedUntil > now) return;
    // Clearing here makes this tick the pause-expiry edge: a still-working
    // agent gets exactly one add back after delivery took the indicator down.
    entry.pausedUntil = 0;

    const withinGrace = now - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      fireWorkingSignal(entry);
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    // A reaction does not expire on its own, so take it off before the entry goes.
    hideIndicator(entry);
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  const entry: TypingTarget = {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    pausedUntil: 0,
    indicatorMessageId: triggerMessageId || null,
    indicatorShown: false,
  };
  typingRefreshers.set(sessionId, entry);
  // Fired from the stored entry so it starts from the state the ticks will read.
  fireWorkingSignal(entry);
}

/**
 * Pause the refresh for POST_DELIVERY_PAUSE_MS and take the indicator down.
 * No-op if no refresh is active.
 *
 * The indicator clears here rather than at a separate call site because this
 * IS the delivered-a-reply edge — delivery calls it once per user-facing send,
 * already filtered against system and agent-to-agent traffic.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
  hideIndicator(entry);
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  // A reaction stays until removed, so every exit edge (idle, container exit,
  // failed wake, shutdown) has to take it off or it strands.
  hideIndicator(entry);
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}
