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
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

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
 * Channels whose native typing signal does not render in a NON-threaded chat,
 * so a reaction stands in for it there. Slack's `assistant.threads.setStatus`
 * draws in a thread but shows nothing in a plain DM or a top-level channel
 * message, which is why this is gated on thread shape as well as channel:
 * inside a thread the native indicator works and the reaction would be noise.
 */
const WORKING_INDICATOR_CHANNELS = new Set(['slack']);

const INDICATOR_EMOJI_KEY = 'SLACK_TYPING_EMOJI';
/** Present in every workspace, so a fresh install gets a correct indicator unconfigured. */
const DEFAULT_INDICATOR_EMOJI = 'hourglass_flowing_sand';
/** Opt-out for an app that will not be granted `reactions:write`. */
const INDICATOR_OFF = 'none';

const INDICATOR_EMOJI = readEnvFile([INDICATOR_EMOJI_KEY])[INDICATOR_EMOJI_KEY] ?? DEFAULT_INDICATOR_EMOJI;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
  pulseReaction?(
    channelType: string,
    platformId: string,
    messageId: string,
    emoji: string,
    on: boolean,
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
  /**
   * The message the indicator sits on — the USER's message that triggered this
   * burst of work, so the signal is up from the moment routing starts rather
   * than only after a first reply exists. Null when there is nothing to mark.
   */
  indicatorMessageId: string | null;
  /** Whether THIS session currently holds a count on that message. */
  indicatorShown: boolean;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Holders per `instance|chat|message`; add on 0→1, remove on 1→0.
 *
 * One inbound message fans out to every wired agent, so N agents mean N
 * refreshers pointed at one message — without counting, the first agent to
 * finish strips the indicator while the others are still working. The instance
 * is in the key because two Slack apps in one workspace are two distinct users
 * whose reactions cannot cancel each other.
 */
const indicatorHolders = new Map<string, number>();

/**
 * Tail of the per-key add/remove chain; serialises the two so an in-flight
 * remove cannot land after a newer add and strip a live indicator. A burst can
 * end and the next one begin inside a single API round-trip.
 */
const indicatorOps = new Map<string, Promise<void>>();

/** Instances already warned about a failed reaction, so the log stays one line per install. */
const warnedInstances = new Set<string>();

/**
 * Snapshotted address, so async teardown is immune to the entry moving
 * underneath it — agent-shared sessions can be re-triggered from another chat.
 */
interface IndicatorTarget {
  channelType: string;
  platformId: string;
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

/**
 * Non-threaded chat, on a channel whose native indicator does not render there,
 * with a message to mark. Inside a thread `setTyping` works, so the indicator
 * stays out of the way.
 */
function usesWorkingIndicator(entry: TypingTarget): boolean {
  return (
    INDICATOR_EMOJI !== INDICATOR_OFF &&
    entry.threadId === null &&
    entry.indicatorMessageId !== null &&
    WORKING_INDICATOR_CHANNELS.has(entry.channelType)
  );
}

function targetOf(entry: TypingTarget): IndicatorTarget {
  return {
    channelType: entry.channelType,
    platformId: entry.platformId,
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

/**
 * Add or remove the indicator reaction. Never throws — an indicator must not be
 * able to break routing or delivery. The bridge already swallows benign drift
 * (already_reacted / no_reaction / message_not_found); anything that gets here
 * is worth one warning per instance, because the overwhelmingly likely cause on
 * a fresh install is a missing `reactions:write` scope.
 */
async function pulseIndicator(t: IndicatorTarget, on: boolean): Promise<void> {
  try {
    await adapter?.pulseReaction?.(t.channelType, t.platformId, t.messageId, INDICATOR_EMOJI, on, t.instance);
  } catch (err) {
    const key = instanceKey(t);
    if (!warnedInstances.has(key)) {
      warnedInstances.add(key);
      log.warn('Working-indicator reaction failed — does the app have the reactions:write scope?', {
        instance: key,
        channelType: t.channelType,
        emoji: INDICATOR_EMOJI,
        err,
      });
    }
  }
}

/** Queue an op behind whatever is already pending for this key. */
function enqueue(key: string, op: () => Promise<void>): void {
  const prior = indicatorOps.get(key) ?? Promise.resolve();
  const next = prior.then(op).catch(() => {});
  indicatorOps.set(key, next);
  // Drop once idle so the map does not grow per message ever marked.
  void next.then(() => {
    if (indicatorOps.get(key) === next) indicatorOps.delete(key);
  });
}

/**
 * Take a hold on the indicator for this session. Idempotent — which is what
 * makes the interval tick a liveness CHECK rather than a driver: while the
 * agent keeps working the tick re-asserts nothing and no API call is made.
 */
function showIndicator(entry: TypingTarget): void {
  if (entry.indicatorShown || !usesWorkingIndicator(entry)) return;
  // Nothing behind the seam yet: index.ts starts channels — and so can route
  // inbound — before it binds the delivery adapter. Claiming a hold now would
  // mark an indicator nothing placed and fire a bogus remove at teardown.
  // Skipping leaves indicatorShown false, so the next tick simply retries.
  if (!adapter?.pulseReaction) return;
  const t = targetOf(entry);
  const key = indicatorKey(t);
  const held = indicatorHolders.get(key) ?? 0;
  indicatorHolders.set(key, held + 1);
  entry.indicatorShown = true;
  if (held === 0) enqueue(key, () => pulseIndicator(t, true));
}

/**
 * Release this session's hold, removing the reaction when the last holder goes.
 * Must run BEFORE any mutation of the entry's address — it releases the key it
 * acquired.
 */
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
  enqueue(key, () => pulseIndicator(t, false));
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
 * @param triggerMessageId RAW inbound platform message id — on Slack the `ts`
 *   a reaction is addressed by. NOT the agent-namespaced id written to
 *   messages_in. Omit it and the session simply gets no indicator.
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
    // Already refreshing. Reset the grace window — the new message restarts
    // the container-wake latency budget — and clear any lingering
    // post-delivery pause: a new inbound means the user expects the signal
    // to show immediately.
    //
    // A re-trigger can arrive from a different chat (agent-shared sessions span
    // messaging groups and platforms), so release the held indicator against the
    // OLD address before anything moves.
    //
    // threadId counts as address even though the reaction is not addressed by
    // thread: it decides WHETHER the indicator applies. A session that moves
    // from a DM into a thread stops using the indicator, so a hold taken in the
    // DM would never reach a release edge and would strand.
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
    // Keep the stored entry self-consistent: the address fields and the owning
    // instance must move together — a torn entry (old address + new instance)
    // would hand e.g. a telegram platformId to a Slack instance's setTyping on
    // the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    // Held means we are mid-burst, so the indicator stays on the message that
    // opened it. Not held means the burst ended, and re-seeding here is what
    // stops the next turn lighting up the previous turn's message.
    if (triggerMessageId && !existing.indicatorShown) {
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
    entry.pausedUntil = 0;

    const withinGrace = now - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      fireWorkingSignal(entry);
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle or dead, stop refreshing.
    // A reaction does not expire on its own, so it has to come off here: this is
    // the edge that keeps the indicator honest when a container dies mid-turn.
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
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS and take the indicator
 * down. Called after a user-facing message is delivered so the signal visibly
 * goes quiet once the reply lands. No-op if no refresh is active.
 *
 * The indicator clears here rather than at a separate call site because this IS
 * the delivered-a-reply edge — delivery calls it once per user-facing send,
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
