/**
 * Unit tests for the host-interactions primitive (task A1a).
 *
 * Router/delivery integration coverage (inbound capture, outbound
 * suppression, resume-on-release) lives in host-core.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  beginInteraction,
  deliverToActiveInteraction,
  getActiveInteraction,
  isOutboundPaused,
  onInteractionRelease,
  BeginInteractionConflictError,
  _resetHostInteractionsForTesting,
  type HostInteractionContext,
  type HostInteractionHandler,
  type HostInteractionKey,
} from './host-interactions.js';

const REPLY_ADDR = { channelType: 'discord', platformId: 'chan-1', threadId: null };
const KEY: HostInteractionKey = {
  channelType: 'discord',
  platformId: 'chan-1',
  threadId: null,
  userId: 'discord:alice',
};

function makeKey(userId: string, threadId: string | null = null): HostInteractionKey {
  return { channelType: 'discord', platformId: 'chan-1', threadId, userId };
}

beforeEach(() => {
  _resetHostInteractionsForTesting();
});

afterEach(() => {
  _resetHostInteractionsForTesting();
  vi.useRealTimers();
});

describe('host-interactions — begin / deliver / release', () => {
  it('beginInteraction registers a slot; getActiveInteraction returns the handler', () => {
    const handler: HostInteractionHandler = (ctx) => ctx.finish();
    beginInteraction(KEY, 'ag-1', 'mg-1', REPLY_ADDR, () => {}, { handler });
    expect(getActiveInteraction(KEY)).toBe(handler);
  });

  it('deliver runs the handler; ask replies and keeps the slot', async () => {
    const writes: string[] = [];
    const handler: HostInteractionHandler = (ctx) => ctx.ask('next?');
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, (t) => writes.push(t), { handler });

    const consumed = await deliverToActiveInteraction(KEY, JSON.stringify({ text: 'hi' }), 'chat');
    expect(consumed).toBe(true);
    expect(writes).toEqual(['next?']);
    expect(getActiveInteraction(KEY)).toBe(handler);
  });

  it('ask(text, nextHandler) swaps the handler for the next turn', async () => {
    const writes: string[] = [];
    const second: HostInteractionHandler = (ctx) => ctx.finish('done');
    const first: HostInteractionHandler = (ctx) => ctx.ask('q1', second);

    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, (t) => writes.push(t), { handler: first });
    await deliverToActiveInteraction(KEY, 'a', 'chat');
    expect(getActiveInteraction(KEY)).toBe(second);
    await deliverToActiveInteraction(KEY, 'b', 'chat');
    expect(writes).toEqual(['q1', 'done']);
    expect(getActiveInteraction(KEY)).toBeUndefined();
  });

  it('finish releases the slot; further inbounds are not consumed', async () => {
    const handler: HostInteractionHandler = (ctx) => ctx.finish('bye');
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, { handler });
    await deliverToActiveInteraction(KEY, 'x', 'chat');
    expect(getActiveInteraction(KEY)).toBeUndefined();
    const consumed = await deliverToActiveInteraction(KEY, 'y', 'chat');
    expect(consumed).toBe(false);
  });

  it('cancel releases the slot', async () => {
    const handler: HostInteractionHandler = (ctx) => ctx.cancel('nope');
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, { handler });
    await deliverToActiveInteraction(KEY, 'x', 'chat');
    expect(getActiveInteraction(KEY)).toBeUndefined();
  });

  it('timeout releases the slot and fires onTimeout once', () => {
    vi.useFakeTimers();
    const handler: HostInteractionHandler = (ctx) => ctx.ask('still waiting');
    const onTimeout = vi.fn();
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler,
      timeoutMs: 1000,
      onTimeout,
    });
    vi.advanceTimersByTime(1001);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(getActiveInteraction(KEY)).toBeUndefined();
  });

  it("mode: 'reject' (default) throws on conflict", () => {
    const handler: HostInteractionHandler = (ctx) => ctx.finish();
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, { handler });
    expect(() => beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, { handler })).toThrow(
      BeginInteractionConflictError,
    );
  });

  it("mode: 'replace' swaps handlers without firing displaced onTimeout", () => {
    vi.useFakeTimers();
    const displacedTimeout = vi.fn();
    const replacedTimeout = vi.fn();
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.ask('one'),
      timeoutMs: 1000,
      onTimeout: displacedTimeout,
    });
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.ask('two'),
      timeoutMs: 1000,
      onTimeout: replacedTimeout,
      mode: 'replace',
    });
    vi.advanceTimersByTime(1001);
    expect(displacedTimeout).not.toHaveBeenCalled();
    expect(replacedTimeout).toHaveBeenCalledTimes(1);
  });

  it('two different users in the same thread have independent slots', async () => {
    const aliceKey = makeKey('discord:alice', 'thread-1');
    const bobKey = makeKey('discord:bob', 'thread-1');
    const writes: string[] = [];
    beginInteraction(aliceKey, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.ask('alice-next'),
    });
    beginInteraction(bobKey, null, 'mg-1', REPLY_ADDR, (t) => writes.push(`bob:${t}`), {
      handler: (ctx) => ctx.finish('bob-done'),
    });
    expect(getActiveInteraction(aliceKey)).toBeDefined();
    expect(getActiveInteraction(bobKey)).toBeDefined();
    await deliverToActiveInteraction(bobKey, 'x', 'chat');
    expect(getActiveInteraction(bobKey)).toBeUndefined();
    expect(getActiveInteraction(aliceKey)).toBeDefined();
    expect(writes).toEqual(['bob:bob-done']);
  });

  it('handler returning without ask/finish/cancel releases the slot with a warning', async () => {
    const handler: HostInteractionHandler = () => {
      // no decision
    };
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, { handler });
    const consumed = await deliverToActiveInteraction(KEY, 'x', 'chat');
    expect(consumed).toBe(true);
    expect(getActiveInteraction(KEY)).toBeUndefined();
  });

  it('concurrent inbounds against the same slot are serialized', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const writes: string[] = [];

    const handler: HostInteractionHandler = async (ctx: HostInteractionContext) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((res) => setTimeout(res, 10));
      ctx.ask(`reply:${ctx.inboundContent}`);
      inflight--;
    };

    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, (t) => writes.push(t), { handler });

    const a = deliverToActiveInteraction(KEY, 'A', 'chat');
    const b = deliverToActiveInteraction(KEY, 'B', 'chat');
    await Promise.all([a, b]);

    expect(maxInflight).toBe(1);
    expect(writes).toEqual(['reply:A', 'reply:B']);
  });

  // — edge cases from § 6 —

  it('beginInteraction with null userId throws (interactions require an identifiable user)', () => {
    const anonKey: HostInteractionKey = { ...KEY, userId: null };
    expect(() =>
      beginInteraction(anonKey, null, 'mg-1', REPLY_ADDR, () => {}, {
        handler: (ctx) => ctx.finish(),
      }),
    ).toThrow(/non-null userId/);
  });

  it('deliverToActiveInteraction with null userId never consults the slot map', async () => {
    // Begin a slot keyed by a real user.
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.finish('shouldnt run'),
    });
    const anonKey: HostInteractionKey = { ...KEY, userId: null };
    const consumed = await deliverToActiveInteraction(anonKey, 'x', 'chat');
    expect(consumed).toBe(false);
    // The real slot remains untouched.
    expect(getActiveInteraction(KEY)).toBeDefined();
  });
});

describe('host-interactions — outbound suppression', () => {
  it('isOutboundPaused returns true while a slot covers the address', () => {
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.finish(),
    });
    expect(isOutboundPaused('discord', 'chan-1', null)).toBe(true);
  });

  it('isOutboundPaused returns false for different channel/platform/thread', () => {
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.finish(),
    });
    expect(isOutboundPaused('slack', 'chan-1', null)).toBe(false);
    expect(isOutboundPaused('discord', 'other', null)).toBe(false);
    expect(isOutboundPaused('discord', 'chan-1', 'thread-x')).toBe(false);
  });

  it('pause clears after finish; onInteractionRelease fires once', async () => {
    const released = vi.fn();
    beginInteraction(KEY, null, 'mg-1', REPLY_ADDR, () => {}, {
      handler: (ctx) => ctx.finish(),
    });
    onInteractionRelease(KEY, released);
    expect(isOutboundPaused('discord', 'chan-1', null)).toBe(true);
    await deliverToActiveInteraction(KEY, 'x', 'chat');
    expect(released).toHaveBeenCalledTimes(1);
    expect(isOutboundPaused('discord', 'chan-1', null)).toBe(false);
  });
});
