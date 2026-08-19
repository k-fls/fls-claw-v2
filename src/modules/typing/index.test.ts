/**
 * Typing-refresh tests: instance forwarding, and the Slack reaction indicator.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 *
 * On Slack the same three sites drive a held reaction instead, because
 * setTyping renders nothing there. Its contract is different in kind: a
 * reaction does not expire on its own, so every exit edge must remove it, and
 * one inbound message fans out to N agents that must not fight over it.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

// Pin the indicator emoji to its default: these arms are about lifecycle, and
// a developer with SLACK_TYPING_EMOJI set in their own .env would otherwise
// fail them. Resolution itself is covered in emoji-config.test.ts.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

import { pauseTypingRefreshAfterDelivery, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

const TEST_DATA_DIR = '/tmp/nanoclaw-test-typing';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };
type ReactionCall = {
  channelType: string;
  platformId: string;
  messageId: string;
  emoji: string;
  on: boolean;
  instance?: string;
};

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

/** Capture both signals: on Slack they are mutually exclusive. */
function captureBoth() {
  const typing: Call[] = [];
  const reactions: ReactionCall[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      typing.push({ channelType, platformId, threadId, instance });
    },
    async pulseReaction(channelType, platformId, messageId, emoji, on, instance) {
      reactions.push({ channelType, platformId, messageId, emoji, on, instance });
      return 'ok';
    },
  });
  return { typing, reactions };
}

/**
 * Stamp the heartbeat file at the CURRENT (faked) clock so isHeartbeatFresh
 * reads fresh. Fake timers move Date.now() but not the filesystem, so a
 * heartbeat written earlier goes stale exactly as it would in production —
 * which is how the idle-timeout arms are driven.
 */
function touchHeartbeat(agentGroupId: string, sessionId: string): void {
  const dir = path.join(TEST_DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const hb = path.join(dir, '.heartbeat');
  fs.writeFileSync(hb, '');
  const secs = Date.now() / 1000;
  fs.utimesSync(hb, secs, secs);
}

/** Advance the clock with the agent visibly working (heartbeat kept fresh). */
async function advanceWorking(ms: number, agentGroupId: string, sessionId: string): Promise<void> {
  const STEP = 2_000;
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) {
    touchHeartbeat(agentGroupId, sessionId);
    await vi.advanceTimersByTimeAsync(Math.min(STEP, ms - elapsed));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('Slack reaction indicator — hold-one lifecycle', () => {
  const EMOJI = 'hourglass_flowing_sand';

  afterEach(() => {
    // Every arm's sessions, not just sess-1: the reference counter is
    // module-level, so a session left running would leak a held count into
    // the next test.
    for (const id of ['sess-1', 'sess-2', 'sess-3']) stopTypingRefresh(id);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('adds once on start and holds it across ticks (AE1)', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([
      {
        channelType: 'slack',
        platformId: 'slack:D1',
        messageId: 'ts-100',
        emoji: EMOJI,
        on: true,
        instance: undefined,
      },
    ]);

    // Three more interval ticks, all inside the grace window: the refresher
    // keeps running but the reaction is held, not re-issued (R2).
    await vi.advanceTimersByTimeAsync(12_500);
    expect(reactions).toHaveLength(1);
    expect(typing).toHaveLength(0); // reaction path replaces setTyping on Slack
  });

  it('takes the reaction path in a channel thread too — thread shape is not a gate (AE2)', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1700.1', undefined, 'ts-200');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([
      {
        channelType: 'slack',
        platformId: 'slack:C1',
        messageId: 'ts-200',
        emoji: EMOJI,
        on: true,
        instance: undefined,
      },
    ]);
    expect(typing).toHaveLength(0);
  });

  it('leaves channels with a working native indicator on setTyping (R7)', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, undefined, 'tg-msg-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toHaveLength(0);
    expect(typing).toHaveLength(1);
  });

  it('issues no reaction calls when the inbound message carried no id', async () => {
    // messageIdForAgent synthesizes an id when the platform gave none, and a
    // synthesized id is not a Slack ts — reacting to it fails as
    // invalid_timestamp. Absent means "no indicator", not "make one up".
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, undefined);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(reactions).toHaveLength(0);
  });

  it('removes the reaction when the agent goes idle rather than stranding it (AE5)', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(1);

    // Past the grace window with no heartbeat ever written: the agent never
    // came back. A native indicator would expire on its own; a reaction
    // would sit on the user's message forever.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reactions.map((r) => r.on)).toEqual([true, false]);
    expect(reactions.at(-1)).toMatchObject({ messageId: 'ts-100', on: false });
  });

  it('stopTypingRefresh issues exactly one remove for a held reaction', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([
      {
        channelType: 'slack',
        platformId: 'slack:D1',
        messageId: 'ts-100',
        emoji: EMOJI,
        on: false,
        instance: undefined,
      },
    ]);

    // Idempotent: the entry is gone, so a second stop is silent.
    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(1);
  });

  it('stopTypingRefresh issues no remove when the reaction was already cleared', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1'); // reply landed → reaction cleared
    await await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(0);
  });

  it('clears against the OLD address before a re-trigger moves the session (R12)', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-tester', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    // Agent-shared sessions span messaging groups, possibly across platforms.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram', 'tg-msg-1');
    await vi.advanceTimersByTimeAsync(0);
    await await vi.advanceTimersByTimeAsync(0);

    // The remove must go to the OLD Slack address and instance — sending it
    // with the new address would strand the reaction and poke Telegram with
    // a Slack ts.
    expect(reactions).toEqual([
      {
        channelType: 'slack',
        platformId: 'slack:D1',
        messageId: 'ts-100',
        emoji: EMOJI,
        on: false,
        instance: 'slack-tester',
      },
    ]);

    // And the foreign target is dropped: no later tick toggles a Slack ts.
    reactions.length = 0;
    await vi.advanceTimersByTimeAsync(12_500);
    expect(reactions).toHaveLength(0);
  });

  it('keeps the interval alive when a reaction call rejects', async () => {
    const reactions: ReactionCall[] = [];
    let failNext = true;
    setTypingAdapter({
      async setTyping() {},
      async pulseReaction(channelType, platformId, messageId, emoji, on, instance) {
        if (failNext) {
          failNext = false;
          throw new Error('slack exploded');
        }
        reactions.push({ channelType, platformId, messageId, emoji, on, instance });
        return 'ok';
      },
    });

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0); // the add rejects
    expect(reactions).toHaveLength(0);

    // The loop must still be evaluating heartbeat freshness: with no
    // heartbeat, the idle branch fires past the grace window and cleans up.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reactions).toEqual([
      {
        channelType: 'slack',
        platformId: 'slack:D1',
        messageId: 'ts-100',
        emoji: EMOJI,
        on: false,
        instance: undefined,
      },
    ]);
  });

  it('fans out to one add and one remove no matter how many agents engage (KTD7)', async () => {
    // One inbound Slack message is evaluated against every wired agent, so N
    // agents means N refreshers pointed at one message. Without reference
    // counting the first agent to finish strips the indicator off the others.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    startTypingRefresh('sess-2', 'ag-2', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: true })]);

    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(1); // still one holder — indicator stays lit

    stopTypingRefresh('sess-2');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions.map((r) => r.on)).toEqual([true, false]);
  });

  it('counts per adapter instance — two Slack bots are two Slack users', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester', 'ts-100');
    startTypingRefresh('sess-2', 'ag-2', 'slack', 'slack:C1', null, 'slack-worker', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([
      expect.objectContaining({ instance: 'slack-tester', on: true }),
      expect.objectContaining({ instance: 'slack-worker', on: true }),
    ]);

    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions.at(-1)).toMatchObject({ instance: 'slack-tester', on: false });
    stopTypingRefresh('sess-2');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions.at(-1)).toMatchObject({ instance: 'slack-worker', on: false });
  });

  it('re-adds once when the post-delivery pause expires with the agent still working (AE3)', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    await advanceWorking(20_000, 'ag-1', 'sess-1'); // out of grace, heartbeat carrying it
    expect(reactions).toHaveLength(1); // still held, never re-issued

    pauseTypingRefreshAfterDelivery('sess-1'); // an interim reply landed
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions.at(-1)).toMatchObject({ messageId: 'ts-100', on: false });
    reactions.length = 0;

    // Pause is 10s; the first tick past it with a fresh heartbeat re-lights
    // the indicator exactly once, giving a quiet-then-working rhythm.
    await advanceWorking(12_000, 'ag-1', 'sess-1');
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: true })]);

    await advanceWorking(8_000, 'ag-1', 'sess-1');
    expect(reactions).toHaveLength(1);
  });

  it('keeps the reaction on the message that started the burst (AE1)', async () => {
    // The target is the message that triggered the work, seeded at routing
    // time — not the agent's last reply, and not moved by a follow-up inbound
    // inside the same burst. Holding it is what makes turn one work at all:
    // on turn one there is no agent reply to react to.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-200');
    await vi.advanceTimersByTimeAsync(4_500);
    expect(reactions).toHaveLength(0); // no remove/add churn to chase ts-200

    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: false })]);
  });

  it('removes the reaction when the container never wakes', async () => {
    // routeInbound starts the refresher, then stops it if wakeContainer
    // reports a transient spawn failure. Without a removal on that edge the
    // user is left looking at an indicator for work that never began.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    stopTypingRefresh('sess-1');
    await await vi.advanceTimersByTimeAsync(0);

    expect(reactions.map((r) => r.on)).toEqual([true, false]);
  });

  it('waits for the delivery adapter instead of claiming a hold it cannot honor', async () => {
    // index.ts starts channel adapters — and so can route inbound — before it
    // calls setDeliveryAdapter, so a first turn can arrive with nothing behind
    // the seam. Claiming a hold there would suppress the indicator for the
    // whole burst and then fire a remove for a reaction never added.
    setTypingAdapter({});
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    const { reactions } = captureBoth(); // adapter binds late
    await vi.advanceTimersByTimeAsync(4_500);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: true })]);

    // And teardown removes exactly what was added — no phantom remove.
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions.map((r) => r.on)).toEqual([true, false]);
  });

  it('moves to the new message when a fresh turn starts after a reply landed', async () => {
    // Delivery ends a burst: it clears the indicator but leaves the old target
    // id behind. The next inbound is a new turn and must light up on ITS
    // message — otherwise the user sees the indicator appear on something they
    // sent minutes ago.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-200');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-200', on: true })]);

    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions.at(-1)).toMatchObject({ messageId: 'ts-200', on: false });
  });

  it('serializes a re-acquire behind the release it follows', async () => {
    // The router can stop a refresher and immediately start it again on the
    // same message (a failed wake, then the sweep retry). If the release ran
    // unordered against the new add, it would resolve last and strip an
    // indicator that a live holder still wants.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    stopTypingRefresh('sess-1');
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    // Whatever the interleaving, the last word on this message must be "on".
    expect(reactions.map((r) => r.on)).toEqual([true, false, true]);
    expect(reactions.at(-1)).toMatchObject({ messageId: 'ts-100', on: true });
  });

  it('treats a thread move as an address change', async () => {
    // A reaction is addressed by channel + ts, but the fallback placeholder is
    // POSTED into the thread — so a thread move has to release against the old
    // thread rather than carry the hold across.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:aaa', undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:bbb', undefined, 'ts-200');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions.map((r) => [r.messageId, r.on])).toEqual([
      ['ts-100', false],
      ['ts-200', true],
    ]);
  });

  it('ignores an empty inbound message id the same as an absent one', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, '');
    await vi.advanceTimersByTimeAsync(12_500);
    expect(reactions).toHaveLength(0);
  });

  it('does not re-add after the pause when the agent has gone quiet', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    await advanceWorking(20_000, 'ag-1', 'sess-1');

    pauseTypingRefreshAfterDelivery('sess-1');
    await await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    // Pause expires with a stale heartbeat and out of grace: that was the
    // final reply, so the refresher stops without relighting anything.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(reactions).toHaveLength(0);

    // Proof the interval really stopped: a fresh heartbeat does not revive it.
    await advanceWorking(12_000, 'ag-1', 'sess-1');
    expect(reactions).toHaveLength(0);
  });
});

describe('Slack working indicator — placeholder fallback', () => {
  // reactions:write is a bot scope the Slack app was probably never installed
  // with, and adding it needs a reinstall that mints a new token. Until that
  // happens every reaction call fails, so the indicator falls back to posting
  // a message and deleting it — which needs no scope beyond the chat:write
  // the app already holds to reply at all.
  type Posted = { platformId: string; threadId: string | null; content: string; instance?: string };
  type Deleted = { platformId: string; threadId: string | null; messageId: string; instance?: string };

  function captureFallback(opts: { reaction?: 'ok' | 'failed' | 'unsupported'; postFails?: boolean } = {}) {
    const reactions: ReactionCall[] = [];
    const posted: Posted[] = [];
    const deleted: Deleted[] = [];
    let postSeq = 0;
    setTypingAdapter({
      async setTyping() {},
      async pulseReaction(channelType, platformId, messageId, emoji, on, instance) {
        reactions.push({ channelType, platformId, messageId, emoji, on, instance });
        return opts.reaction ?? 'unsupported';
      },
      async deliver(_channelType, platformId, threadId, _kind, content, _files, instance) {
        posted.push({ platformId, threadId, content, instance });
        if (opts.postFails) throw new Error('post failed');
        return `placeholder-${++postSeq}`;
      },
      async deleteMessage(_channelType, platformId, threadId, messageId, instance) {
        deleted.push({ platformId, threadId, messageId, instance });
      },
    });
    return { reactions, posted, deleted };
  }

  afterEach(() => {
    for (const id of ['sess-1', 'sess-2', 'sess-3']) stopTypingRefresh(id);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('latches on a permission-class refusal and posts a placeholder instead (AE6)', async () => {
    const { reactions, posted, deleted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-latch-a', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ platformId: 'slack:D1', threadId: null, instance: 'inst-latch-a' });

    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toEqual([
      { platformId: 'slack:D1', threadId: null, messageId: 'placeholder-1', instance: 'inst-latch-a' },
    ]);
  });

  it('stops attempting reactions on a latched instance', async () => {
    const { reactions, posted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-latch-b', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    // A later burst on the same instance goes straight to the placeholder —
    // one doomed API call per turn forever is exactly what the latch avoids.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D2', null, 'inst-latch-b', 'ts-200');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(0);
    expect(posted).toHaveLength(2);
  });

  it('does not latch on benign drift', async () => {
    const { reactions, posted } = captureFallback({ reaction: 'failed' });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-drift', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-drift', 'ts-200');
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toHaveLength(0); // never fell back
    expect(reactions.filter((r) => r.on)).toHaveLength(2); // tried again
  });

  it('latches per instance — a sibling bot still tries reactions', async () => {
    const { reactions, posted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'inst-solo-a', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toHaveLength(1);
    reactions.length = 0;

    // A second Slack app in the same workspace is a different install with a
    // different token, so its scopes are its own question.
    startTypingRefresh('sess-2', 'ag-2', 'slack', 'slack:C1', null, 'inst-solo-b', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ instance: 'inst-solo-b', on: true })]);
  });

  it('deletes the placeholder when a reply lands, and re-posts if work continues', async () => {
    const { posted, deleted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-reply', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    await advanceWorking(20_000, 'ag-1', 'sess-1');
    expect(posted).toHaveLength(1);

    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toEqual([expect.objectContaining({ messageId: 'placeholder-1' })]);

    await advanceWorking(12_000, 'ag-1', 'sess-1');
    expect(posted).toHaveLength(2); // still working → indicator returns
  });

  it('deletes the placeholder when the agent goes idle rather than stranding it', async () => {
    const { posted, deleted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-idle', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000); // no heartbeat ever
    expect(deleted).toEqual([expect.objectContaining({ messageId: 'placeholder-1' })]);
  });

  it('posts one placeholder for a message that fanned out to several agents', async () => {
    const { posted, deleted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'inst-fan', 'ts-100');
    startTypingRefresh('sess-2', 'ag-2', 'slack', 'slack:C1', null, 'inst-fan', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toHaveLength(1);

    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toHaveLength(0); // one agent still working

    stopTypingRefresh('sess-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toEqual([expect.objectContaining({ messageId: 'placeholder-1' })]);
  });

  it('issues no delete when the placeholder post itself failed', async () => {
    const { reactions, deleted } = captureFallback({ postFails: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-postfail', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    const reactionCallsAfterLatch = reactions.length;

    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toHaveLength(0);
    // And no reaction-removal either: the instance is latched, so the teardown
    // must not go back to the very API the latch says is unavailable.
    expect(reactions).toHaveLength(reactionCallsAfterLatch);
  });

  it('posts fixed placeholder text, not a progress surface', async () => {
    const { posted } = captureFallback();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-text', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].content)).toEqual({ text: expect.any(String) });
    expect(JSON.parse(posted[0].content).text.length).toBeGreaterThan(0);
  });

  it('survives a rejecting deleteMessage without breaking teardown', async () => {
    // A stranded placeholder is the worst case here; an escaping rejection
    // would be worse still.
    const posted: string[] = [];
    setTypingAdapter({
      async setTyping() {},
      async pulseReaction() {
        return 'unsupported';
      },
      async deliver() {
        posted.push('placeholder');
        return 'placeholder-1';
      },
      async deleteMessage() {
        throw new Error('slack rejected the delete');
      },
    });

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'inst-delfail', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toHaveLength(1);

    expect(() => stopTypingRefresh('sess-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    // The refresher is gone and the module still works for the next burst.
    startTypingRefresh('sess-2', 'ag-1', 'slack', 'slack:D2', null, 'inst-delfail', 'ts-200');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toHaveLength(2);
    stopTypingRefresh('sess-2');
    await vi.advanceTimersByTimeAsync(0);
  });
});
