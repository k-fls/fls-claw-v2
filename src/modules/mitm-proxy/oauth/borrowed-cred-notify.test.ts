/**
 * Spam-control + routing tests for the borrowed-credential expiry notifier.
 * The delivery seams (db, approvals, delivery adapter) are mocked; we assert
 * the once-per-episode guard, heal-clears-it, the 24h backstop, and the
 * owner-DM → channel fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  approvers: ['discord:owner'] as string[],
  dmTarget: { userId: 'discord:owner', messagingGroup: { channel_type: 'discord', platform_id: 'dm-1' } } as {
    userId: string;
    messagingGroup: { channel_type: string; platform_id: string };
  } | null,
  channels: [] as Array<{ id: string; channel_type: string; platform_id: string }>,
  deliver: vi.fn(),
  now: 1_000_000,
}));

vi.mock('../../../db/agent-groups.js', () => ({
  getAgentGroupByFolder: (folder: string) => ({ id: `id-${folder}`, folder }),
}));
vi.mock('../../../db/messaging-groups.js', () => ({
  getMessagingGroupsByAgentGroup: () => h.channels,
}));
vi.mock('../../../delivery.js', () => ({
  deliverDirect: (...a: unknown[]) => h.deliver(...a),
}));
vi.mock('../../approvals/primitive.js', () => ({
  pickApprover: () => h.approvers,
  pickApprovalDelivery: async () => h.dmTarget,
}));
vi.mock('../../../log.js', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }));

import { borrowedCredentialNotifier, _resetBorrowedCredNotifyForTests } from './borrowed-cred-notify.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.approvers = ['discord:owner'];
  h.dmTarget = { userId: 'discord:owner', messagingGroup: { channel_type: 'discord', platform_id: 'dm-1' } };
  h.channels = [];
  h.deliver = vi.fn();
  h.now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => h.now);
  _resetBorrowedCredNotifyForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('borrowedCredentialNotifier', () => {
  it('alerts the grantor owner via DM, once per episode', async () => {
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith('discord', 'dm-1', null, expect.stringContaining('claude'));

    // Same episode (not healed, within backstop) — suppressed.
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('re-alerts after the credential heals', async () => {
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    borrowedCredentialNotifier.onCredentialHealed({ credentialScope: 'grantor', providerId: 'claude' });
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('re-alerts after the 24h backstop when never healed', async () => {
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    h.now += 24 * 60 * 60 * 1000 + 1; // past the backstop
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('keys episodes per (scope, provider) independently', async () => {
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'github' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('falls back to the grantor channel when no owner DM is reachable', async () => {
    h.dmTarget = null;
    h.channels = [{ id: 'mg-1', channel_type: 'slack', platform_id: 'chan-1' }];
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith('slack', 'chan-1', null, expect.stringContaining('claude'));
  });

  it('does nothing deliverable when neither an owner DM nor a channel exists', async () => {
    h.dmTarget = null;
    h.channels = [];
    borrowedCredentialNotifier.onBorrowedRefreshFailed({ owningScope: 'grantor', providerId: 'claude' });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });
});
