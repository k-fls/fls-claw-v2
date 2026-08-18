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

  /** Advance the clock with the agent visibly working (heartbeat kept fresh). */
  async function advanceWorking(ms: number, agentGroupId: string, sessionId: string): Promise<void> {
    const STEP = 2_000;
    for (let elapsed = 0; elapsed < ms; elapsed += STEP) {
      touchHeartbeat(agentGroupId, sessionId);
      await vi.advanceTimersByTimeAsync(Math.min(STEP, ms - elapsed));
    }
  }

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
    expect(reactions).toHaveLength(1);
  });

  it('stopTypingRefresh issues no remove when the reaction was already cleared', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1'); // reply landed → reaction cleared
    reactions.length = 0;

    stopTypingRefresh('sess-1');
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
    expect(reactions).toHaveLength(1); // still one holder — indicator stays lit

    stopTypingRefresh('sess-2');
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
    expect(reactions.at(-1)).toMatchObject({ instance: 'slack-tester', on: false });
    stopTypingRefresh('sess-2');
    expect(reactions.at(-1)).toMatchObject({ instance: 'slack-worker', on: false });
  });

  it('re-adds once when the post-delivery pause expires with the agent still working (AE3)', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    await advanceWorking(20_000, 'ag-1', 'sess-1'); // out of grace, heartbeat carrying it
    expect(reactions).toHaveLength(1); // still held, never re-issued

    pauseTypingRefreshAfterDelivery('sess-1'); // an interim reply landed
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
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: false })]);
  });

  it('removes the reaction when the container never wakes', async () => {
    // routeInbound starts the refresher, then stops it if wakeContainer
    // reports a transient spawn failure. Without a removal on that edge the
    // user is left looking at an indicator for work that never began.
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    stopTypingRefresh('sess-1');

    expect(reactions.map((r) => r.on)).toEqual([true, false]);
  });

  it('does not re-add after the pause when the agent has gone quiet', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    await advanceWorking(20_000, 'ag-1', 'sess-1');

    pauseTypingRefreshAfterDelivery('sess-1');
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
