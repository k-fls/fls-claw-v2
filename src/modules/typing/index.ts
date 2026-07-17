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
 * Channels with no native typing indicator in a non-threaded chat (Slack's
 * `assistant.threads.setStatus` only renders inside assistant threads, so a
 * plain DM shows nothing). For these, in a non-threaded conversation we fake
 * "still working" by toggling a reaction on the agent's last message on each
 * refresh tick instead of calling `setTyping` (a silent no-op there).
 */
const REACTION_PSEUDO_TYPING_CHANNELS = new Set(['slack']);
/** ⏳ — flickered on/off on the agent's last message as the pseudo-indicator. */
const PSEUDO_TYPING_EMOJI = 'hourglass_flowing_sand';

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
   * Reaction pseudo-typing state (Slack non-thread only). `lastAgentMessageId`
   * is the platform id of the agent's most-recently-delivered user-facing
   * message — the message we flicker the ⏳ reaction on. Null until the agent
   * has delivered its first message this session (nothing to react to yet).
   * `reactionOn` tracks whether the ⏳ is currently shown, so each tick knows
   * whether to add or remove, and so cleanup knows whether to remove.
   */
  lastAgentMessageId: string | null;
  reactionOn: boolean;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

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

/**
 * True when this session should signal typing via a toggled reaction rather
 * than `setTyping`: a non-threaded chat on a channel with no native non-thread
 * indicator, and the agent has already delivered a message to react to.
 */
function usesReactionPseudoTyping(entry: TypingTarget): boolean {
  return (
    entry.threadId === null &&
    entry.lastAgentMessageId !== null &&
    REACTION_PSEUDO_TYPING_CHANNELS.has(entry.channelType)
  );
}

async function triggerReactionPulse(entry: TypingTarget, on: boolean): Promise<void> {
  if (!entry.lastAgentMessageId) return;
  try {
    await adapter?.pulseReaction?.(
      entry.channelType,
      entry.platformId,
      entry.lastAgentMessageId,
      PSEUDO_TYPING_EMOJI,
      on,
      entry.instance,
    );
  } catch {
    // Best-effort — never let a pseudo-typing toggle break the refresh loop.
  }
}

/**
 * Fire one "still working" signal for an active refresher: a reaction toggle
 * on channels that need it, otherwise a normal `setTyping`. Shared by the
 * interval tick and the immediate re-trigger so both stay in sync.
 */
function fireTypingSignal(entry: TypingTarget): void {
  if (usesReactionPseudoTyping(entry)) {
    entry.reactionOn = !entry.reactionOn;
    triggerReactionPulse(entry, entry.reactionOn).catch(() => {});
    return;
  }
  triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
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

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Reset the grace window — the new message restarts
    // the container-wake latency budget — and clear any lingering
    // post-delivery pause: a new inbound means the user expects the signal
    // to show immediately.
    const addressChanged = existing.platformId !== platformId || existing.channelType !== channelType;
    // A re-trigger can arrive from a different chat address (agent-shared
    // sessions span messaging groups, possibly on different platforms). The
    // pending ⏳ (if any) belongs to the OLD address's last message — clear it
    // there before the address moves, then drop the now-foreign message id so
    // we don't later toggle a Slack message id against another platform.
    if (addressChanged && existing.reactionOn) {
      triggerReactionPulse(existing, false).catch(() => {});
    }
    if (addressChanged) {
      existing.lastAgentMessageId = null;
      existing.reactionOn = false;
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
    // Immediate tick for the new inbound, fired from the now-updated entry so
    // reaction pseudo-typing and setTyping stay in sync.
    fireTypingSignal(existing);
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      fireTypingSignal(entry);
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    // A reaction indicator persists until removed (unlike a native typing
    // indicator that expires on its own), so clear it before we drop the entry.
    if (entry.reactionOn) triggerReactionPulse(entry, false).catch(() => {});
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    pausedUntil: 0,
    lastAgentMessageId: null,
    reactionOn: false,
  });
}

/**
 * Record the platform id of the agent's just-delivered user-facing message.
 * On channels that use reaction pseudo-typing (Slack non-thread), the refresh
 * toggles the ⏳ on THIS message. Moving to a newer message first clears the
 * reaction off the previously-marked one, so the indicator never gets stranded
 * on an older message. No-op if no refresh is active for the session or the
 * delivery returned no platform message id.
 *
 * Delivery calls this only for user-facing messages (not system / agent-to-
 * agent traffic) — see src/delivery.ts.
 */
export function noteAgentMessageDelivered(sessionId: string, platformMessageId: string | null): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry || !platformMessageId) return;
  if (entry.lastAgentMessageId === platformMessageId) return;

  // Clear the ⏳ off the message we were toggling before we retarget the new
  // one. Fire directly against the OLD id (not via triggerReactionPulse, which
  // reads entry.lastAgentMessageId) since we're about to overwrite it.
  if (entry.reactionOn && entry.lastAgentMessageId) {
    adapter
      ?.pulseReaction?.(
        entry.channelType,
        entry.platformId,
        entry.lastAgentMessageId,
        PSEUDO_TYPING_EMOJI,
        false,
        entry.instance,
      )
      .catch(() => {});
  }
  entry.lastAgentMessageId = platformMessageId;
  entry.reactionOn = false;
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
  // Clear the ⏳ during the pause so it visibly goes quiet after a reply lands
  // (mirrors letting a native indicator clear). It resumes toggling on the
  // next tick once the pause expires.
  if (entry.reactionOn) {
    entry.reactionOn = false;
    triggerReactionPulse(entry, false).catch(() => {});
  }
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  // A reaction indicator does not expire on its own — remove it on the way out
  // so it isn't stranded on the agent's last message.
  if (entry.reactionOn) triggerReactionPulse(entry, false).catch(() => {});
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}
