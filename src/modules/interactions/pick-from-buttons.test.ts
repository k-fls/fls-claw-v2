/**
 * Unit tests for pickFromButtons. Mocks the approvals primitive,
 * messaging-group lookup, and the delivery adapter — the helper is
 * pure composition + an in-memory pending map.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../approvals/primitive.js', () => ({
  pickApprover: vi.fn(),
  pickApprovalDelivery: vi.fn(),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(),
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: vi.fn(),
}));

import { pickApprover, pickApprovalDelivery } from '../approvals/primitive.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getResponseHandlers, type ResponsePayload } from '../../response-registry.js';
import { _resetPickFromButtonsForTesting, pickFromButtons } from './pick-from-buttons.js';
import type { Session } from '../../types.js';

const SESSION: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: null,
  state: 'active',
  created_at: new Date().toISOString(),
  last_active_at: new Date().toISOString(),
} as unknown as Session;

function makeApproverTarget(): { userId: string; messagingGroup: { channel_type: string; platform_id: string } } {
  return { userId: 'discord:admin', messagingGroup: { channel_type: 'discord', platform_id: 'dm-1' } as any };
}

beforeEach(() => {
  _resetPickFromButtonsForTesting();
  vi.mocked(pickApprover).mockReset();
  vi.mocked(pickApprovalDelivery).mockReset();
  vi.mocked(getMessagingGroup).mockReset();
  vi.mocked(getDeliveryAdapter).mockReset();
});

async function fireLatestResponse(payload: ResponsePayload): Promise<boolean> {
  for (const h of getResponseHandlers()) {
    if (await h(payload)) return true;
  }
  return false;
}

describe('pickFromButtons', () => {
  it('returns reason=declined when no approver is configured', async () => {
    vi.mocked(pickApprover).mockReturnValue([]);
    const result = await pickFromButtons({
      session: SESSION,
      agentName: 'test',
      title: 't',
      question: 'q',
      options: [{ value: 'a', label: 'A' }],
    });
    expect(result).toEqual({ value: null, reason: 'declined' });
  });

  it('returns reason=declined when no DM destination is reachable', async () => {
    vi.mocked(pickApprover).mockReturnValue(['discord:admin']);
    vi.mocked(getMessagingGroup).mockReturnValue({ channel_type: 'discord' } as any);
    vi.mocked(pickApprovalDelivery).mockResolvedValue(null);
    const result = await pickFromButtons({
      session: SESSION,
      agentName: 'test',
      title: 't',
      question: 'q',
      options: [{ value: 'a', label: 'A' }],
    });
    expect(result).toEqual({ value: null, reason: 'declined' });
  });

  it('delivers a card and resolves with the picked value when the response handler fires', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    vi.mocked(pickApprover).mockReturnValue(['discord:admin']);
    vi.mocked(getMessagingGroup).mockReturnValue({ channel_type: 'discord' } as any);
    vi.mocked(pickApprovalDelivery).mockResolvedValue(makeApproverTarget() as any);
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as any);

    const promise = pickFromButtons({
      session: SESSION,
      agentName: 'test',
      title: 'Choose',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });

    // Wait one microtask so the helper has had a chance to call deliver and register the questionId.
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliver.mock.calls[0][4] as string);
    expect(payload.type).toBe('ask_question');
    expect(payload.options).toHaveLength(2);
    const questionId = payload.questionId as string;

    const claimed = await fireLatestResponse({
      questionId,
      value: 'b',
      userId: 'discord:admin',
      channelType: 'discord',
      platformId: 'dm-1',
      threadId: null,
    });
    expect(claimed).toBe(true);

    const result = await promise;
    expect(result).toEqual({ value: 'b', reason: 'picked' });
  });

  it('treats a response with an unknown value as declined', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    vi.mocked(pickApprover).mockReturnValue(['discord:admin']);
    vi.mocked(getMessagingGroup).mockReturnValue({ channel_type: 'discord' } as any);
    vi.mocked(pickApprovalDelivery).mockResolvedValue(makeApproverTarget() as any);
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as any);

    const promise = pickFromButtons({
      session: SESSION,
      agentName: 'test',
      title: 'Choose',
      question: 'pick',
      options: [{ value: 'a', label: 'A' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    const questionId = JSON.parse(deliver.mock.calls[0][4] as string).questionId as string;
    await fireLatestResponse({
      questionId,
      value: 'nonexistent',
      userId: 'discord:admin',
      channelType: 'discord',
      platformId: 'dm-1',
      threadId: null,
    });
    expect(await promise).toEqual({ value: null, reason: 'declined' });
  });

  it("response handler returns false for unknown questionIds (does not claim other modules' responses)", async () => {
    // No pending picks — handler must decline.
    const claimed = await fireLatestResponse({
      questionId: 'unknown-id',
      value: 'whatever',
      userId: null,
      channelType: 'discord',
      platformId: 'p',
      threadId: null,
    });
    expect(claimed).toBe(false);
  });

  it('returns reason=declined when adapter.deliver rejects', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('boom'));
    vi.mocked(pickApprover).mockReturnValue(['discord:admin']);
    vi.mocked(getMessagingGroup).mockReturnValue({ channel_type: 'discord' } as any);
    vi.mocked(pickApprovalDelivery).mockResolvedValue(makeApproverTarget() as any);
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as any);

    const result = await pickFromButtons({
      session: SESSION,
      agentName: 'test',
      title: 't',
      question: 'q',
      options: [{ value: 'a', label: 'A' }],
    });
    expect(result).toEqual({ value: null, reason: 'declined' });
  });
});
