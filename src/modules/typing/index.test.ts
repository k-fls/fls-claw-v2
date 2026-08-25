/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { pauseTypingRefreshAfterDelivery, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

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

/** Capture both signals so the working indicator can be asserted against
 *  setTyping (the two paths are mutually exclusive). */
function captureBoth() {
  const typing: Call[] = [];
  const reactions: ReactionCall[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      typing.push({ channelType, platformId, threadId, instance });
    },
    async pulseReaction(channelType, platformId, messageId, emoji, on, instance) {
      reactions.push({ channelType, platformId, messageId, emoji, on, instance });
    },
  });
  return { typing, reactions };
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

/**
 * The working indicator: a single reaction HELD for the length of a work
 * burst, on the user's triggering message.
 *
 * The three properties that matter, and that a toggle-on-every-tick design
 * does not have: it is up on turn one (before any agent output exists), it
 * costs two API calls per turn rather than one per tick, and every edge that
 * ends the work — reply delivered, session stopped, agent gone quiet — takes
 * it back down. A reaction does not expire on its own, so a missed edge is a
 * permanently stranded indicator.
 */
describe('working indicator (Slack)', () => {
  afterEach(() => {
    stopTypingRefresh('sess-2');
  });

  it('is up on turn one, on the user message, before any agent reply exists', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: true })]);
    expect(reactions[0].channelType).toBe('slack');
    expect(reactions[0].platformId).toBe('slack:C1');
    expect(typing).toHaveLength(0); // never both
  });

  it('is HELD, not toggled — many ticks produce exactly one add', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    // Three interval ticks, all inside the 15s grace window.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(reactions.filter((r) => r.on)).toHaveLength(1);
    expect(reactions.filter((r) => !r.on)).toHaveLength(0);
  });

  it('covers channel threads too — setStatus does not render there either', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: true })]);
    expect(typing).toHaveLength(0);
  });

  it('comes down when the reply is delivered', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: false })]);
  });

  it('comes down when the session stops', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: false })]);
  });

  it('comes down when the agent goes quiet — no heartbeat past the grace window', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    // No heartbeat file is ever written (DATA_DIR is mocked to an empty dir),
    // so once the 15s grace expires the agent counts as gone.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: false })]);
  });

  it('fan-out: N agents on one message means one add and one remove, not N', async () => {
    const { reactions } = captureBoth();
    // Same inbound message evaluated against two wired agent groups.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    startTypingRefresh('sess-2', 'ag-2', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions.filter((r) => r.on)).toHaveLength(1);

    // The first agent finishing must NOT strip the indicator off the second.
    reactions.length = 0;
    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(0);

    // Only the last holder releasing takes it down.
    pauseTypingRefreshAfterDelivery('sess-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-100', on: false })]);
  });

  it('the next turn re-seeds onto the new message', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1'); // burst ends
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-200');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'ts-200', on: true })]);
  });

  it('mid-burst re-trigger keeps the indicator on the message that opened it', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    // A second message arrives while the agent is still working on the first.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-200');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(0); // still held on ts-100, no churn
  });

  it('a re-trigger from a different chat releases against the OLD address', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-a', 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    reactions.length = 0;

    // agent-shared sessions span messaging groups and instances.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C2', null, 'slack-b', 'ts-999');
    await vi.advanceTimersByTimeAsync(0);

    const off = reactions.find((r) => !r.on);
    expect(off).toMatchObject({ platformId: 'slack:C1', messageId: 'ts-100', instance: 'slack-a' });
    const on = reactions.find((r) => r.on);
    expect(on).toMatchObject({ platformId: 'slack:C2', messageId: 'ts-999', instance: 'slack-b' });
  });

  it('no trigger message id means no indicator — falls back to setTyping', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(0);
    expect(typing).toHaveLength(1);
  });

  it('channels with a working native indicator are untouched', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:1', null, undefined, 'mid-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reactions).toHaveLength(0);
    expect(typing).toHaveLength(1);
  });

  it('an adapter without the reaction seam falls back rather than faking a hold', async () => {
    // index.ts can route inbound before delivery binds the adapter; taking a
    // hold then would fire a bogus remove at teardown.
    const typing: Call[] = [];
    setTypingAdapter({
      async setTyping(channelType, platformId, threadId, instance) {
        typing.push({ channelType, platformId, threadId, instance });
      },
    });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, 'ts-100');
    await vi.advanceTimersByTimeAsync(0);
    expect(typing).toHaveLength(0); // indicator path chosen, but nothing behind it
    expect(() => stopTypingRefresh('sess-1')).not.toThrow();
  });
});
