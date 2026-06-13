import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { HostCommandContext } from '../command-gate.js';

const h = vi.hoisted(() => ({
  admins: new Set<string>(), // global-admin user ids
  groupAdmins: new Set<string>(), // "userId::groupId" pairs
  groups: [] as Array<{ id: string; folder: string; name: string }>,
  providers: new Map<string, string>(), // agentGroupId → provider string (may carry :version)
  fetched: ['2.1.100', '2.1.154'] as string[],
  scalarUpdates: [] as Array<{ id: string; updates: Record<string, unknown> }>,
  fetchVersionCalls: [] as string[],
  fetchLatestCalls: 0,
  reconfigureCalls: [] as string[],
  removed: [] as string[],
  removable: true,
}));

vi.mock('../command-gate.js', () => ({
  registerHostCommand: () => {},
  isAdmin: (userId: string | null, groupId?: string | null) =>
    groupId == null
      ? h.admins.has(userId ?? '')
      : h.admins.has(userId ?? '') || h.groupAdmins.has(`${userId}::${groupId}`),
}));
vi.mock('../container-config.js', () => ({
  resolveProviderName: (_s: unknown, p: string | undefined) => (p ? p.split(':')[0].toLowerCase() : 'claude'),
  parseProviderSpec: (raw: string) => {
    const i = raw.indexOf(':');
    return i === -1
      ? { id: raw.toLowerCase() }
      : { id: raw.slice(0, i).toLowerCase(), version: raw.slice(i + 1) || undefined };
  },
}));
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => h.groups.find((g) => g.id === id),
}));
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (id: string) => ({ provider: h.providers.get(id) ?? 'claude' }),
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: (id: string, updates: Record<string, unknown>) => h.scalarUpdates.push({ id, updates }),
}));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupAgents: () => h.groups.map((g) => ({ agent_group_id: g.id })),
}));
vi.mock('../modules/runtime-updater/index.js', () => ({
  parseRuntimeUpdate: (raw: string) => {
    if (/^\d+\s*(h|d|m)$/i.test(raw)) return { mode: 'latest', intervalMs: 1, version: '' };
    if (/^\d+\.\d+(\.\d+)?$/.test(raw)) return { mode: 'pinned', intervalMs: 0, version: raw };
    return { mode: 'off', intervalMs: 0, version: '' };
  },
  canRemoveVersion: () => (h.removable ? { ok: true } : { ok: false, reason: 'in use' }),
  getRuntimeUpdateManager: (providerId: string) =>
    providerId === 'claude'
      ? {
          updater: {
            label: 'Claude Code',
            packageName: '@anthropic-ai/claude-code',
            installedVersions: () => h.fetched,
            remove: (v: string) => h.removed.push(v),
          },
          getSetting: () => '',
          fetchVersion: async (v: string) => {
            h.fetchVersionCalls.push(v);
            return true;
          },
          fetchLatest: async () => {
            h.fetchLatestCalls++;
            return '2.1.200';
          },
          reconfigure: async (s: string) => {
            h.reconfigureCalls.push(s);
          },
        }
      : undefined,
}));

import { handleAgentRuntimeCommand } from './agent-runtime.js';

function run(userId: string | null, args: string[]): string[] {
  const replies: string[] = [];
  handleAgentRuntimeCommand({
    userId,
    messagingGroupId: 'mg1',
    args,
    replyText: (t: string) => replies.push(t),
  } as unknown as HostCommandContext);
  return replies;
}

beforeEach(() => {
  h.admins = new Set();
  h.groupAdmins = new Set();
  h.groups = [{ id: 'g1', folder: 'team', name: 'Team' }];
  h.providers = new Map([['g1', 'claude']]);
  h.fetched = ['2.1.100', '2.1.154'];
  h.scalarUpdates = [];
  h.fetchVersionCalls = [];
  h.fetchLatestCalls = 0;
  h.reconfigureCalls = [];
  h.removed = [];
  h.removable = true;
});

describe('/agent-runtime', () => {
  it('reports when no groups are wired', () => {
    h.groups = [];
    expect(run('u1', [])[0]).toMatch(/No agent groups/);
  });

  it('denies status to a non-admin', () => {
    expect(run('u1', [])[0]).toMatch(/Permission denied/);
  });

  it('shows status to a group admin', () => {
    h.groupAdmins.add('u1::g1');
    h.providers.set('g1', 'claude:2.1.154');
    const out = run('u1', [])[0];
    expect(out).toMatch(/Claude Code/);
    expect(out).toMatch(/selection: 2.1.154/);
    expect(out).toMatch(/2.1.100, 2.1.154/);
  });

  it('lets a group admin select a fetched version (writes provider string)', () => {
    h.groupAdmins.add('u1::g1');
    run('u1', ['select', '2.1.154']);
    expect(h.scalarUpdates).toEqual([{ id: 'g1', updates: { provider: 'claude:2.1.154' } }]);
  });

  it('lets a group admin select latest', () => {
    h.groupAdmins.add('u1::g1');
    run('u1', ['select', 'latest']);
    expect(h.scalarUpdates[0].updates).toEqual({ provider: 'claude:latest' });
  });

  it('refuses selecting a version that is not fetched', () => {
    h.groupAdmins.add('u1::g1');
    const out = run('u1', ['select', '9.9.9']);
    expect(out[0]).toMatch(/not fetched/);
    expect(h.scalarUpdates).toEqual([]);
  });

  it('denies select to a non-admin', () => {
    expect(run('u1', ['select', '2.1.154'])[0]).toMatch(/Permission denied/);
  });

  it('requires global admin to fetch', () => {
    h.groupAdmins.add('u1::g1');
    expect(run('u1', ['fetch', '2.1.200'])[0]).toMatch(/global admin/);
    expect(h.fetchVersionCalls).toEqual([]);
  });

  it('lets a global admin fetch an exact version', () => {
    h.admins.add('u1');
    run('u1', ['fetch', '2.1.200']);
    expect(h.fetchVersionCalls).toEqual(['2.1.200']);
  });

  it('lets a global admin fetch latest', () => {
    h.admins.add('u1');
    run('u1', ['fetch', 'latest']);
    expect(h.fetchLatestCalls).toBe(1);
  });

  it('requires global admin to set auto-update', () => {
    h.groupAdmins.add('u1::g1');
    expect(run('u1', ['auto', '24h'])[0]).toMatch(/global admin/);
  });

  it('lets a global admin set + clear auto-update', () => {
    h.admins.add('u1');
    run('u1', ['auto', '24h']);
    run('u1', ['auto', 'off']);
    expect(h.reconfigureCalls).toEqual(['24h', '']);
  });

  it('removes a fetched version when safe (global admin)', () => {
    h.admins.add('u1');
    run('u1', ['remove', '2.1.100']);
    expect(h.removed).toEqual(['2.1.100']);
  });

  it('refuses removal when canRemoveVersion says no', () => {
    h.admins.add('u1');
    h.removable = false;
    const out = run('u1', ['remove', '2.1.100']);
    expect(out[0]).toMatch(/Cannot remove/);
    expect(h.removed).toEqual([]);
  });

  it('disambiguates when multiple groups are wired and no folder is given', () => {
    h.groups = [
      { id: 'g1', folder: 'team', name: 'Team' },
      { id: 'g2', folder: 'ops', name: 'Ops' },
    ];
    h.providers.set('g2', 'claude');
    expect(run('u1', [])[0]).toMatch(/multiple agent groups/i);
  });
});
