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

import {
  noteAgentMessageDelivered,
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} from './index.js';

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

/** Capture both signals so reaction pseudo-typing can be asserted against
 *  setTyping (the two paths are mutually exclusive per tick). */
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

describe('reaction pseudo-typing (Slack non-thread)', () => {
  it('before any agent message, ticks still use setTyping (nothing to react to)', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(reactions).toHaveLength(0);
    expect(typing.length).toBeGreaterThanOrEqual(2); // immediate + interval
  });

  it('after a delivered agent message, interval ticks toggle the ⏳ instead of setTyping', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    await vi.advanceTimersByTimeAsync(0);
    noteAgentMessageDelivered('sess-1', 'msg-100');
    typing.length = 0;
    reactions.length = 0;

    await vi.advanceTimersByTimeAsync(4_500); // first tick → add
    expect(reactions.at(-1)).toMatchObject({
      channelType: 'slack',
      platformId: 'slack:C1',
      messageId: 'msg-100',
      emoji: 'hourglass_flowing_sand',
      on: true,
    });

    await vi.advanceTimersByTimeAsync(4_000); // second tick → remove
    expect(reactions.at(-1)).toMatchObject({ messageId: 'msg-100', on: false });
    expect(typing).toHaveLength(0); // never setTyping while reacting
  });

  it('a newer delivered message clears the ⏳ off the previous one before retargeting', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    await vi.advanceTimersByTimeAsync(0);
    noteAgentMessageDelivered('sess-1', 'msg-100');
    await vi.advanceTimersByTimeAsync(4_500); // reaction now ON for msg-100
    expect(reactions.at(-1)).toMatchObject({ messageId: 'msg-100', on: true });
    reactions.length = 0;

    noteAgentMessageDelivered('sess-1', 'msg-200');
    // The move removes ⏳ from the old message immediately…
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'msg-100', on: false })]);
    reactions.length = 0;

    // …and the next tick toggles the NEW message on.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reactions.at(-1)).toMatchObject({ messageId: 'msg-200', on: true });
  });

  it('post-delivery pause clears the ⏳', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    await vi.advanceTimersByTimeAsync(0);
    noteAgentMessageDelivered('sess-1', 'msg-100');
    await vi.advanceTimersByTimeAsync(4_500); // ⏳ ON
    reactions.length = 0;

    pauseTypingRefreshAfterDelivery('sess-1');
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'msg-100', on: false })]);
  });

  it('stopTypingRefresh removes a lingering ⏳', async () => {
    const { reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    await vi.advanceTimersByTimeAsync(0);
    noteAgentMessageDelivered('sess-1', 'msg-100');
    await vi.advanceTimersByTimeAsync(4_500); // ⏳ ON
    reactions.length = 0;

    stopTypingRefresh('sess-1');
    expect(reactions).toEqual([expect.objectContaining({ messageId: 'msg-100', on: false })]);
  });

  it('threaded Slack keeps native setTyping — no reaction fallback', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    await vi.advanceTimersByTimeAsync(0);
    noteAgentMessageDelivered('sess-1', 'msg-100');
    typing.length = 0;
    reactions.length = 0;

    await vi.advanceTimersByTimeAsync(4_500);
    expect(reactions).toHaveLength(0);
    expect(typing.length).toBeGreaterThanOrEqual(1);
  });

  it('non-thread on a channel with native typing (telegram) does not use reactions', async () => {
    const { typing, reactions } = captureBoth();
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:1', null);
    await vi.advanceTimersByTimeAsync(0);
    noteAgentMessageDelivered('sess-1', 'msg-100');
    typing.length = 0;
    reactions.length = 0;

    await vi.advanceTimersByTimeAsync(4_500);
    expect(reactions).toHaveLength(0);
    expect(typing.length).toBeGreaterThanOrEqual(1);
  });
});
