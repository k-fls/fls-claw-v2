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
 * Channels whose native typing signal does not render, so the indicator is a
 * held reaction on the user's own message instead.
 *
 * Slack is the whole set. `assistant.threads.setStatus` — what the adapter's
 * startTyping wraps — only draws inside the app's assistant surface, and the
 * adapter returns early when there is no threadTs at all. Both the DM path and
 * the ordinary channel-thread path therefore produce nothing, which is why
 * this is gated on channel and NOT on thread shape.
 *
 * Deliberately a set here rather than a capability declared on the adapter:
 * Slack installs from the `channels` branch, so an adapter-side declaration
 * would need a coordinated change there before this could ship. See the plan's
 * KTD3.
 */
const WORKING_INDICATOR_CHANNELS = new Set(['slack']);

const INDICATOR_EMOJI_KEY = 'SLACK_TYPING_EMOJI';
/**
 * ⏳ — present in every workspace, so a fresh install shows a correct static
 * indicator with no setup. The animated experience wants a custom emoji
 * uploaded to the workspace, which the host cannot provision.
 */
const DEFAULT_INDICATOR_EMOJI = 'hourglass_flowing_sand';

/**
 * Emoji held on the triggering message for the duration of a work burst.
 *
 * Read once at module load through readEnvFile, so it never enters
 * process.env and never reaches a child process — the same treatment the
 * Slack tokens get. Three states: unset → the default above; a name → that
 * name verbatim; empty (`SLACK_TYPING_EMOJI=` in .env) → the feature is off
 * and no reaction call is ever made. That last one is the kill switch: turn
 * it off and restart the host, no redeploy.
 */
const INDICATOR_EMOJI =
  readEnvFile([INDICATOR_EMOJI_KEY], { keepEmpty: true })[INDICATOR_EMOJI_KEY] ?? DEFAULT_INDICATOR_EMOJI;

/**
 * Fallback indicator for an app that cannot place reactions: posted when work
 * starts, deleted when it ends. Fixed text on purpose — it is a "something is
 * happening" signal, not a progress surface, and it costs a message plus an
 * unread badge per turn, which is why it is the fallback and not the primary
 * path.
 */
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
  /**
   * Platform id of the message that triggered this burst — the message the
   * indicator reaction sits on. Null when the channel does not use the
   * reaction path, or when the inbound event carried no usable id.
   */
  indicatorMessageId: string | null;
  /** Whether THIS session currently holds a count on that message. */
  indicatorShown: boolean;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * How many sessions currently want the indicator on a given target message,
 * keyed by `instance|chat|message`.
 *
 * One inbound Slack message is evaluated against every agent wired to the
 * messaging group, so N engaging agents means N refreshers aimed at one
 * message. The reaction is added on the 0→1 transition and removed on 1→0;
 * without that, the first agent to finish strips the indicator while the rest
 * are still working. The instance is part of the key because two Slack apps in
 * one workspace are two distinct Slack users whose reactions are independent.
 */
const indicatorHolders = new Map<string, number>();

/**
 * Adapter instances whose app cannot place reactions, latched on the first
 * permission-class refusal (`missing_scope` and friends). Adding the
 * `reactions:write` scope requires reinstalling the Slack app, which mints a
 * new token and therefore needs a host restart anyway — so a process-lifetime
 * latch costs nothing and saves one doomed API call per turn forever.
 */
const reactionUnsupportedInstances = new Set<string>();

/**
 * What an acquire actually did, so the matching release undoes exactly that.
 * A bare message id cannot express this: "no placeholder id" is true both when
 * the reaction path was taken and when the instance latched but the
 * placeholder post failed, and those want opposite teardowns.
 */
type IndicatorHold = { kind: 'reaction' } | { kind: 'placeholder'; messageId?: string };

/**
 * Tail of the serialized operation chain per target. `null` means nothing is
 * held right now.
 *
 * Every acquire and release for one key runs through this chain, in order.
 * Both are async and either can still be in flight when the other is
 * requested — a burst can end before its own add lands, and the router can
 * stop and immediately restart a refresher (failed wake, then a sweep retry).
 * Without serialization an older release resolves after a newer acquire and
 * strips an indicator a live holder still wants.
 */
const indicatorOps = new Map<string, Promise<IndicatorHold | null>>();

/**
 * The full address of one indicator, snapshotted so async teardown is immune
 * to the entry moving underneath it (agent-shared sessions can be re-triggered
 * from another chat, or another platform, mid-flight).
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

/**
 * True when this session signals work with the held indicator rather than
 * `setTyping`. Gated on the channel and on having a real target message —
 * NOT on thread shape, because neither Slack code path renders natively.
 */
function usesWorkingIndicator(entry: TypingTarget): boolean {
  return (
    INDICATOR_EMOJI !== '' && entry.indicatorMessageId !== null && WORKING_INDICATOR_CHANNELS.has(entry.channelType)
  );
}

/**
 * Snapshot the entry's indicator address; see IndicatorTarget. Only called
 * from paths that already established a target: show checks
 * usesWorkingIndicator, and hide runs only for a holder, which implies one.
 */
function targetOf(entry: TypingTarget): IndicatorTarget {
  return {
    channelType: entry.channelType,
    platformId: entry.platformId,
    threadId: entry.threadId,
    instance: entry.instance,
    messageId: entry.indicatorMessageId!,
  };
}

/** The registry key an instance-addressed call resolves through. */
function instanceKey(t: IndicatorTarget): string {
  return t.instance ?? t.channelType;
}

/** Reference-count key: the indicator's full identity on the platform. */
function indicatorKey(t: IndicatorTarget): string {
  return `${instanceKey(t)}|${t.platformId}|${t.messageId}`;
}

/**
 * Fire one add/remove. Never throws: the indicator must not be able to break
 * routing or delivery. A dropped call self-corrects on the next work burst.
 */
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
    // Best-effort, exactly like the reaction path: no indicator this turn.
    return undefined;
  }
}

/** Remove the fallback placeholder. Never throws. */
async function deletePlaceholder(t: IndicatorTarget, messageId: string): Promise<void> {
  try {
    await adapter?.deleteMessage?.(t.channelType, t.platformId, t.threadId, messageId, t.instance);
  } catch {
    // A stranded placeholder is the worst case here, and it is still better
    // than letting a cleanup failure escape into the refresh loop.
  }
}

/**
 * Light the indicator for a target nobody was holding. Prefers the reaction;
 * on a permission-class refusal it latches the instance and falls back to a
 * placeholder message, this turn included.
 */
async function acquireIndicator(t: IndicatorTarget): Promise<IndicatorHold> {
  if (!reactionUnsupportedInstances.has(instanceKey(t))) {
    const outcome = await pulseIndicator(t, true);
    if (outcome !== 'unsupported') return { kind: 'reaction' };
    reactionUnsupportedInstances.add(instanceKey(t));
  }
  // Latched: never attempt a reaction on this instance again, including on
  // the teardown side — that is what the latch promises.
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
  // The add side degrades invisibly by design, but a failed REMOVE strands a
  // reaction on the user's message with nothing to ever revisit it — a native
  // typing indicator would have expired on its own. Best-effort still, but the
  // operator gets to see it.
  log.warn('Working indicator could not be cleared', {
    channelType: t.channelType,
    platformId: t.platformId,
    messageId: t.messageId,
    instance: t.instance,
    outcome,
  });
}

/**
 * Take this session's hold on the indicator, lighting it if this is the first.
 * Idempotent: a session that already holds one issues nothing, which is what
 * makes the interval tick a liveness check rather than a reaction driver.
 */
function showIndicator(entry: TypingTarget): void {
  if (entry.indicatorShown || !usesWorkingIndicator(entry)) return;
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

/**
 * Release this session's hold, taking the indicator down when it was the last.
 * Must run BEFORE any mutation of the entry's address fields — the key it
 * releases is the one it acquired, and the snapshot it tears down with is the
 * address it acquired against.
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
  // Chain off the acquire so teardown matches setup even when the burst ends
  // before the platform answered, and so a re-acquire queues behind this
  // release rather than racing it.
  const prior = indicatorOps.get(key) ?? Promise.resolve(null);
  const settled: Promise<IndicatorHold | null> = prior
    .then(async (hold) => {
      if (hold) await releaseIndicator(t, hold);
      return null;
    })
    .catch(() => null);
  indicatorOps.set(key, settled);
  // Drop the entry once the chain goes idle, so a long-lived host does not
  // accumulate one resolved promise per message it ever reacted to.
  void settled.then(() => {
    if (indicatorOps.get(key) === settled) indicatorOps.delete(key);
  });
}

/**
 * One "still working" signal for an active refresher: hold the reaction on
 * channels that need it, otherwise a normal `setTyping`. Shared by the
 * immediate tick, the interval tick, and the re-trigger so all three agree.
 */
function fireWorkingSignal(entry: TypingTarget): void {
  if (usesWorkingIndicator(entry)) {
    showIndicator(entry);
    return;
  }
  triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
}

/**
 * @param triggerMessageId Platform id of the inbound message that engaged the
 *   agent — the message the indicator reaction is placed on. Pass the RAW
 *   inbound id, not the agent-namespaced id written to messages_in: on Slack
 *   the raw id is the `ts` that reactions.add needs. Omit (or pass null) when
 *   the event carried none; the router synthesizes an id in that case and a
 *   synthesized id is not a `ts`, so the correct behavior is no indicator
 *   rather than a doomed call. Ignored on channels with a native indicator.
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
    // A re-trigger can arrive from a different chat address (agent-shared
    // sessions span messaging groups, possibly on different platforms or
    // instances). The held indicator belongs to the OLD address, so release
    // it there before the address moves and drop the now-foreign target id —
    // otherwise a later tick would toggle a Slack ts against Telegram.
    //
    // threadId counts as part of the address even though a reaction is
    // addressed by channel + ts: the fallback placeholder is POSTED into the
    // thread, so a thread move would delete against the new thread using an
    // id created in the old one.
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
    // Re-seed whenever this session is not currently holding the indicator.
    //
    // While it IS held, the target stays put: the indicator is added once and
    // held for the burst, so a follow-up message mid-burst does not pay a
    // remove+add to chase itself. But delivery ends a burst too — it clears
    // the indicator and leaves the old id behind — so without this the next
    // turn would light up on the PREVIOUS turn's message.
    if (triggerMessageId && (existing.indicatorMessageId === null || !existing.indicatorShown)) {
      existing.indicatorMessageId = triggerMessageId;
    }
    // Immediate signal for the new inbound, fired from the now-updated entry.
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
    // Past the pause. Clearing it here makes this tick the pause-expiry edge:
    // delivery took the reaction down, and a still-working agent gets exactly
    // one add back — a visible quiet-then-working rhythm instead of an
    // indicator that never goes out.
    entry.pausedUntil = 0;

    const withinGrace = now - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      fireWorkingSignal(entry);
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    // A reaction does not expire the way a native indicator does, so it has
    // to come off before the entry goes.
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
  // Immediate signal, fired from the stored entry so the reaction path and
  // the setTyping path start from the same state the ticks will read.
  fireWorkingSignal(entry);
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS, and take the indicator
 * reaction down. Called after a user-facing message is delivered so the
 * client-side indicator has a chance to visually clear before the agent's
 * next SDK event pushes it back on. No-op if no refresh is active for this
 * session.
 *
 * The reaction clears here rather than at a separate call site because this
 * IS the delivered-a-reply edge: delivery calls it exactly once per
 * user-facing send, already filtered against system and agent-to-agent
 * traffic. If the agent keeps working, the first tick past the pause puts the
 * reaction back (see the interval).
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
  // Unlike a native typing indicator, a reaction stays until removed — so
  // every exit edge (idle timeout, container exit, failed wake, shutdown)
  // has to take it off or it strands on the user's message.
  hideIndicator(entry);
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}
