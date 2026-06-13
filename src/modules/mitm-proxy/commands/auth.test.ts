import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { HostCommandContext } from '../../../command-gate.js';

const h = vi.hoisted(() => ({
  REAUTH: Symbol('reauth') as unknown,
  wirings: [] as Array<{ agent_group_id: string }>,
  groups: new Map<string, { id: string; folder: string }>(),
  admins: new Set<string>(), // `${userId}::${groupId}`
  providerProvider: 'claude',
  hasReauth: true,
  reauth: vi.fn((..._a: unknown[]) => new Promise<boolean>(() => {})), // pending by default
  restarts: [] as string[],
}));

vi.mock('../../../command-gate.js', () => ({
  isAdmin: (userId: string | null, groupId?: string | null) => h.admins.has(`${userId}::${groupId}`),
}));
vi.mock('../../../container-restart.js', () => ({
  restartAgentGroupContainers: (id: string) => h.restarts.push(id),
}));
vi.mock('../../../container-config.js', () => ({
  resolveProviderName: () => h.providerProvider,
}));
vi.mock('../../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => h.groups.get(id),
}));
vi.mock('../../../db/container-configs.js', () => ({ getContainerConfig: () => undefined }));
vi.mock('../../../db/messaging-groups.js', () => ({ getMessagingGroupAgents: () => h.wirings }));
vi.mock('../../credentials/index.js', () => ({
  REAUTH: h.REAUTH,
  asCredentialScope: (s: string) => s,
  getCredentialProvider: (id: string) =>
    id === h.providerProvider
      ? { id, getExtension: (t: unknown) => (t === h.REAUTH && h.hasReauth ? { reauth: h.reauth } : undefined) }
      : undefined,
}));

import { handleAuthCommand, _resetAuthCommandForTests } from './auth.js';

function run(args: string[], opts: { userId?: string | null } = {}): string[] {
  const replies: string[] = [];
  handleAuthCommand({
    command: '/auth',
    args,
    argsRaw: args.join(' '),
    userId: opts.userId === undefined ? 'discord:op' : opts.userId,
    agentGroupId: null,
    messagingGroupId: 'mg1',
    scope: 'channel',
    reply: { channelType: 'discord', platformId: 'chan1', threadId: null },
    replyText: (t: string) => replies.push(t),
    beginInteraction: () => {},
  } as unknown as HostCommandContext);
  return replies;
}

function wire(...folders: string[]): void {
  h.wirings = folders.map((f) => ({ agent_group_id: `id-${f}` }));
  for (const f of folders) h.groups.set(`id-${f}`, { id: `id-${f}`, folder: f });
}

beforeEach(() => {
  _resetAuthCommandForTests();
  h.wirings = [];
  h.groups = new Map();
  h.admins = new Set();
  h.providerProvider = 'claude';
  h.hasReauth = true;
  h.reauth = vi.fn((..._a: unknown[]) => new Promise<boolean>(() => {}));
  h.restarts = [];
});

describe('/auth command', () => {
  it('rejects anonymous callers', () => {
    expect(run([], { userId: null })[0]).toMatch(/identifiable user/);
  });

  it('reports when no agent group is wired to the channel', () => {
    expect(run([])[0]).toMatch(/No agent groups are wired/);
  });

  it('runs reauth for the sole engaged group when caller is admin', () => {
    wire('alpha');
    h.admins.add('discord:op::id-alpha');
    run([]);
    expect(h.reauth).toHaveBeenCalledTimes(1);
    const ctxArg = h.reauth.mock.calls[0][0] as { credentialScope: string; origin: { agentGroupId: string } };
    expect(ctxArg.credentialScope).toBe('alpha');
    expect(ctxArg.origin.agentGroupId).toBe('id-alpha');
  });

  it('denies a non-admin caller', () => {
    wire('alpha');
    expect(run([])[0]).toMatch(/Permission denied/);
    expect(h.reauth).not.toHaveBeenCalled();
  });

  it('asks for disambiguation when multiple groups are engaged', () => {
    wire('alpha', 'beta');
    h.admins.add('discord:op::id-alpha');
    const r = run([]);
    expect(r[0]).toMatch(/multiple agent groups/);
    expect(r[0]).toContain('/auth alpha');
    expect(r[0]).toContain('/auth beta');
    expect(h.reauth).not.toHaveBeenCalled();
  });

  it('resolves an explicit folder among multiple engaged groups', () => {
    wire('alpha', 'beta');
    h.admins.add('discord:op::id-beta');
    run(['beta']);
    expect(h.reauth).toHaveBeenCalledTimes(1);
    expect((h.reauth.mock.calls[0][0] as { credentialScope: string }).credentialScope).toBe('beta');
  });

  it('errors on an unknown folder', () => {
    wire('alpha');
    h.admins.add('discord:op::id-alpha');
    expect(run(['nope'])[0]).toMatch(/No engaged agent group with folder/);
    expect(h.reauth).not.toHaveBeenCalled();
  });

  it('rejects providers without a REAUTH extension', () => {
    wire('alpha');
    h.admins.add('discord:op::id-alpha');
    h.hasReauth = false;
    expect(run([])[0]).toMatch(/does not support interactive/);
  });

  it('dedups a concurrent in-flight episode', () => {
    wire('alpha');
    h.admins.add('discord:op::id-alpha');
    run([]); // reauth pending → inFlight stays set
    const r = run([]);
    expect(r[0]).toMatch(/already in progress/);
    expect(h.reauth).toHaveBeenCalledTimes(1);
  });

  it('restarts the group on a successful (re)auth', async () => {
    wire('alpha');
    h.admins.add('discord:op::id-alpha');
    h.reauth = vi.fn(() => Promise.resolve(true));
    run([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.restarts).toEqual(['id-alpha']);
  });

  it('does NOT restart when (re)auth was cancelled', async () => {
    wire('alpha');
    h.admins.add('discord:op::id-alpha');
    h.reauth = vi.fn(() => Promise.resolve(false));
    run([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.restarts).toEqual([]);
  });
});
