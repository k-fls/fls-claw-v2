/**
 * pickOptionOn — origin-driven numbered picker. Drives the real A1a
 * interaction machinery and simulates user replies.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _resetHostInteractionsForTesting,
  deliverToActiveInteraction,
  type InteractionOrigin,
} from '../../host-interactions.js';
import { pickOptionOn } from './pick-option.js';

function makeOrigin(replies: string[]): InteractionOrigin {
  return {
    key: { channelType: 'telegram', platformId: 'telegram:123', threadId: null, userId: 'telegram:42' },
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    replyAddr: { channelType: 'telegram', platformId: 'telegram:123', threadId: null },
    writeReply: (t) => replies.push(t),
  };
}

function userSays(origin: InteractionOrigin, text: string): Promise<boolean> {
  return deliverToActiveInteraction(origin.key, JSON.stringify({ text }), 'chat');
}

beforeEach(() => _resetHostInteractionsForTesting());

describe('pickOptionOn', () => {
  it('renders a numbered menu and resolves the chosen 0-based index', async () => {
    const replies: string[] = [];
    const origin = makeOrigin(replies);
    const p = pickOptionOn(origin, { prompt: 'Pick a mode', options: ['Apple', 'Banana', 'Cherry'] });

    expect(replies[0]).toContain('Pick a mode');
    expect(replies[0]).toContain('1. Apple');
    expect(replies[0]).toContain('3. Cherry');

    await userSays(origin, '2');
    expect(await p).toEqual({ index: 1, reason: 'submitted' });
  });

  it('re-prompts on out-of-range and non-numeric replies', async () => {
    const replies: string[] = [];
    const origin = makeOrigin(replies);
    const p = pickOptionOn(origin, { prompt: 'Pick', options: ['A', 'B'] });

    await userSays(origin, '9'); // out of range
    expect(replies).toHaveLength(2);
    await userSays(origin, '1.'); // not a bare integer
    expect(replies).toHaveLength(3);
    await userSays(origin, '1');
    expect(await p).toEqual({ index: 0, reason: 'submitted' });
  });

  it('resolves cancelled on a cancel keyword', async () => {
    const origin = makeOrigin([]);
    const p = pickOptionOn(origin, { prompt: 'Pick', options: ['A', 'B'] });
    await userSays(origin, 'cancel');
    expect(await p).toEqual({ index: null, reason: 'cancelled' });
  });

  it('throws on an empty option list', () => {
    expect(() => pickOptionOn(makeOrigin([]), { prompt: 'x', options: [] })).toThrow();
  });
});
