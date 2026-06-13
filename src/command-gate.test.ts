/**
 * Unit tests for the command-gate classifier and the host-command registry.
 *
 * Router-integration coverage for `action: 'handle'` lives in host-core.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb, createAgentGroup } from './db/index.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function ensureUser(id: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`)
    .run(id, id, now());
}

function ensureAgentGroup(id: string): void {
  try {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  } catch {
    // already exists
  }
}
import {
  gateCommand,
  isAdmin,
  parseSlashCommand,
  registerHostCommand,
  getRegisteredHostCommands,
  getHostCommandScope,
  getHostCommandAccess,
  classifyAtMessagingGroup,
  _resetHostCommandsForTesting,
  type HostCommandHandler,
} from './command-gate.js';
import { log } from './log.js';

function jsonChat(text: string): string {
  return JSON.stringify({ text });
}

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _resetHostCommandsForTesting();
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('parseSlashCommand', () => {
  it('returns null for non-slash content', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand(JSON.stringify({ text: 'hello' }))).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  it('parses a bare command with no args', () => {
    expect(parseSlashCommand('/auth')).toEqual({ command: '/auth', argsRaw: '', args: [] });
  });

  it('lowercases the command word', () => {
    const r = parseSlashCommand('/Auth STATUS');
    expect(r?.command).toBe('/auth');
    expect(r?.args).toEqual(['STATUS']); // args case is preserved
  });

  it('whitespace-splits args without quoting', () => {
    const r = parseSlashCommand('/auth grant @user provider');
    expect(r).toEqual({
      command: '/auth',
      argsRaw: 'grant @user provider',
      args: ['grant', '@user', 'provider'],
    });
  });

  it('strips leading whitespace before the slash', () => {
    expect(parseSlashCommand('   /auth')?.command).toBe('/auth');
  });

  it('extracts text from a JSON chat payload', () => {
    const r = parseSlashCommand(JSON.stringify({ text: '/auth grant' }));
    expect(r?.command).toBe('/auth');
    expect(r?.args).toEqual(['grant']);
  });

  it('handles JSON payload with leading whitespace inside text', () => {
    const r = parseSlashCommand(JSON.stringify({ text: '   /auth' }));
    expect(r?.command).toBe('/auth');
  });
});

describe('gateCommand — existing behaviors', () => {
  it('non-slash content passes', () => {
    expect(gateCommand('hello', 'user-1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('filtered commands return filter', () => {
    expect(gateCommand(jsonChat('/login'), 'user-1', 'ag-1')).toEqual({ action: 'filter' });
    expect(gateCommand(jsonChat('/logout'), 'user-1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('admin commands: admin user passes', () => {
    ensureUser('admin-1');
    grantRole({ user_id: 'admin-1', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(gateCommand(jsonChat('/clear'), 'admin-1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('admin commands: non-admin denied', () => {
    expect(gateCommand(jsonChat('/clear'), 'user-1', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('unknown slash commands pass through', () => {
    expect(gateCommand(jsonChat('/unknown-thing'), 'user-1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

describe('isAdmin', () => {
  it('returns false for null userId', () => {
    expect(isAdmin(null, 'ag-1')).toBe(false);
  });

  it('returns true for global admin', () => {
    ensureUser('g');
    grantRole({ user_id: 'g', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(isAdmin('g', 'ag-1')).toBe(true);
    expect(isAdmin('g', 'ag-2')).toBe(true);
  });

  it('returns true for scoped admin in the right group only', () => {
    ensureUser('s');
    ensureAgentGroup('ag-1');
    grantRole({ user_id: 's', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    expect(isAdmin('s', 'ag-1')).toBe(true);
    expect(isAdmin('s', 'ag-2')).toBe(false);
  });

  it('returns true for owner', () => {
    ensureUser('o');
    grantRole({ user_id: 'o', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(isAdmin('o', 'ag-1')).toBe(true);
  });
});

describe('host-command registry', () => {
  it('handle returned for registered prefix with non-null userId', () => {
    const handler: HostCommandHandler = vi.fn();
    registerHostCommand('/a1-test-cmd', handler);
    const result = gateCommand(jsonChat('/a1-test-cmd hello'), 'user-1', 'ag-1');
    expect(result.action).toBe('handle');
    if (result.action === 'handle') {
      expect(result.command).toBe('/a1-test-cmd');
      expect(result.handler).toBe(handler);
    }
  });

  it('deny returned when userId is null', () => {
    registerHostCommand('/a1-anon-cmd', vi.fn());
    expect(gateCommand(jsonChat('/a1-anon-cmd'), null, 'ag-1')).toEqual({
      action: 'deny',
      command: '/a1-anon-cmd',
    });
  });

  it('case-insensitive matching on both registration prefix and inbound', () => {
    const handler: HostCommandHandler = vi.fn();
    registerHostCommand('/A1-CaseTest', handler);
    const result = gateCommand(jsonChat('/a1-casetest'), 'user-1', 'ag-1');
    expect(result.action).toBe('handle');
  });

  it('re-registering same prefix logs a warning and overwrites', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const first: HostCommandHandler = vi.fn();
    const second: HostCommandHandler = vi.fn();
    registerHostCommand('/a1-overwrite', first);
    registerHostCommand('/a1-overwrite', second);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('re-registered'),
      expect.objectContaining({ prefix: '/a1-overwrite' }),
    );
    const result = gateCommand(jsonChat('/a1-overwrite'), 'user-1', 'ag-1');
    if (result.action === 'handle') expect(result.handler).toBe(second);
    else throw new Error('expected handle action');
  });

  it('throws when prefix does not start with /', () => {
    expect(() => registerHostCommand('noslash', vi.fn())).toThrow(/start with/);
  });

  it('host registration overrides a same-prefix ADMIN_COMMANDS entry', () => {
    // /cost is in ADMIN_COMMANDS — host registration should win.
    const handler: HostCommandHandler = vi.fn();
    registerHostCommand('/cost', handler);
    const result = gateCommand(jsonChat('/cost'), 'user-1', 'ag-1');
    // Non-admin would normally be denied for /cost; host handler accepts.
    expect(result.action).toBe('handle');
  });

  it('getRegisteredHostCommands lists registered prefixes (lowercased)', () => {
    registerHostCommand('/A1-Listed', vi.fn());
    expect(getRegisteredHostCommands()).toContain('/a1-listed');
  });
});

describe('scope', () => {
  it('default scope is agent', () => {
    registerHostCommand('/a1-default-scope', vi.fn());
    expect(getHostCommandScope('/a1-default-scope')).toBe('agent');
  });

  it('agent-scope: matched by gateCommand, not classifyAtMessagingGroup', () => {
    registerHostCommand('/a1-agent-scope', vi.fn(), { scope: 'agent' });
    expect(gateCommand(jsonChat('/a1-agent-scope'), 'user-1', 'ag-1').action).toBe('handle');
    expect(classifyAtMessagingGroup(jsonChat('/a1-agent-scope'), 'user-1').action).toBe('none');
  });

  it('channel-scope: matched by classifyAtMessagingGroup, not gateCommand', () => {
    registerHostCommand('/a1-channel-scope', vi.fn(), { scope: 'channel' });
    const mg = classifyAtMessagingGroup(jsonChat('/a1-channel-scope'), 'user-1');
    expect(mg.action).toBe('handle');
    if (mg.action === 'handle') expect(mg.scope).toBe('channel');
    // gateCommand falls through to default-pass for non-agent scope.
    expect(gateCommand(jsonChat('/a1-channel-scope'), 'user-1', 'ag-1').action).toBe('pass');
  });

  it('host-scope: matched by classifyAtMessagingGroup, not gateCommand', () => {
    registerHostCommand('/a1-host-scope', vi.fn(), { scope: 'host' });
    const mg = classifyAtMessagingGroup(jsonChat('/a1-host-scope'), 'user-1');
    expect(mg.action).toBe('handle');
    if (mg.action === 'handle') expect(mg.scope).toBe('host');
    expect(gateCommand(jsonChat('/a1-host-scope'), 'user-1', 'ag-1').action).toBe('pass');
  });

  it('anonymous user denied for channel-scope command', () => {
    registerHostCommand('/a1-chan-anon', vi.fn(), { scope: 'channel' });
    expect(classifyAtMessagingGroup(jsonChat('/a1-chan-anon'), null)).toEqual({
      action: 'deny',
      command: '/a1-chan-anon',
    });
  });

  it('FILTERED command returns filter from classifyAtMessagingGroup', () => {
    expect(classifyAtMessagingGroup(jsonChat('/login'), 'user-1')).toEqual({ action: 'filter' });
  });

  it('non-slash content returns none from classifyAtMessagingGroup', () => {
    expect(classifyAtMessagingGroup('hello', 'user-1')).toEqual({ action: 'none' });
  });
});

describe('access', () => {
  function grantAdmin(userId: string, agentGroupId: string | null): void {
    ensureUser(userId);
    if (agentGroupId) ensureAgentGroup(agentGroupId);
    grantRole({ user_id: userId, role: 'admin', agent_group_id: agentGroupId, granted_by: null, granted_at: now() });
  }

  it('default access is any — any identified user handles', () => {
    registerHostCommand('/a1d-default', vi.fn());
    expect(getHostCommandAccess('/a1d-default')).toBe('any');
    expect(gateCommand(jsonChat('/a1d-default'), 'user-1', 'ag-1').action).toBe('handle');
  });

  it('agent-scope group-admin: scoped admin handles in their group only', () => {
    registerHostCommand('/a1d-gadm', vi.fn(), { scope: 'agent', access: 'group-admin' });
    grantAdmin('s', 'ag-1');
    expect(gateCommand(jsonChat('/a1d-gadm'), 's', 'ag-1').action).toBe('handle');
    expect(gateCommand(jsonChat('/a1d-gadm'), 's', 'ag-2')).toEqual({ action: 'deny', command: '/a1d-gadm' });
    expect(gateCommand(jsonChat('/a1d-gadm'), 'nobody', 'ag-1')).toEqual({ action: 'deny', command: '/a1d-gadm' });
  });

  it('agent-scope group-admin: owner and global admin handle for any group', () => {
    registerHostCommand('/a1d-gadm2', vi.fn(), { scope: 'agent', access: 'group-admin' });
    ensureUser('o');
    grantRole({ user_id: 'o', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantAdmin('g', null);
    expect(gateCommand(jsonChat('/a1d-gadm2'), 'o', 'ag-9').action).toBe('handle');
    expect(gateCommand(jsonChat('/a1d-gadm2'), 'g', 'ag-9').action).toBe('handle');
  });

  it('agent-scope global-admin: scoped admin denied even in their own group', () => {
    registerHostCommand('/a1d-glob', vi.fn(), { scope: 'agent', access: 'global-admin' });
    grantAdmin('s', 'ag-1');
    grantAdmin('g', null);
    expect(gateCommand(jsonChat('/a1d-glob'), 's', 'ag-1')).toEqual({ action: 'deny', command: '/a1d-glob' });
    expect(gateCommand(jsonChat('/a1d-glob'), 'g', 'ag-1').action).toBe('handle');
  });

  it('channel-scope global-admin enforced pre-fanout', () => {
    registerHostCommand('/a1d-chglob', vi.fn(), { scope: 'channel', access: 'global-admin' });
    grantAdmin('s', 'ag-1');
    grantAdmin('g', null);
    expect(classifyAtMessagingGroup(jsonChat('/a1d-chglob'), 'user-1')).toEqual({
      action: 'deny',
      command: '/a1d-chglob',
    });
    expect(classifyAtMessagingGroup(jsonChat('/a1d-chglob'), 's')).toEqual({
      action: 'deny',
      command: '/a1d-chglob',
    });
    expect(classifyAtMessagingGroup(jsonChat('/a1d-chglob'), 'g').action).toBe('handle');
  });

  it('channel-scope group-admin passes through — the handler owns the check', () => {
    registerHostCommand('/a1d-chgadm', vi.fn(), { scope: 'channel', access: 'group-admin' });
    expect(classifyAtMessagingGroup(jsonChat('/a1d-chgadm'), 'user-1').action).toBe('handle');
  });
});

describe('built-in /help handler', () => {
  // /help is registered with scope: 'channel', so it lands via
  // classifyAtMessagingGroup and not gateCommand.
  const helpCtxStub = {
    userId: 'user-1',
    agentGroupId: null as string | null,
    messagingGroupId: 'mg-test',
    scope: 'channel' as const,
    reply: { channelType: 'discord', platformId: 'c', threadId: null },
    beginInteraction: () => {
      throw new Error('beginInteraction not used in /help tests');
    },
  };

  it('is auto-registered with channel scope', () => {
    expect(getRegisteredHostCommands()).toContain('/help');
    expect(getHostCommandScope('/help')).toBe('channel');
  });

  it('/help (no args) replies with a composed overview', () => {
    const result = classifyAtMessagingGroup(jsonChat('/help'), 'user-1');
    expect(result.action).toBe('handle');
    if (result.action !== 'handle') return;
    const replies: string[] = [];
    result.handler({
      command: '/help',
      argsRaw: '',
      args: [],
      ...helpCtxStub,
      replyText: (t) => replies.push(t),
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Available commands');
    expect(replies[0]).toContain('/help');
    expect(replies[0]).toContain('Container commands');
    expect(replies[0]).toContain('/clear');
  });

  it('/help <registered-host-command> replies with the host registration help', () => {
    registerHostCommand('/a1-helptest', vi.fn(), { help: 'a1 help-test description' });
    const result = classifyAtMessagingGroup(jsonChat('/help a1-helptest'), 'user-1');
    if (result.action !== 'handle') throw new Error('expected handle');
    const replies: string[] = [];
    result.handler({
      command: '/help',
      argsRaw: 'a1-helptest',
      args: ['a1-helptest'],
      ...helpCtxStub,
      replyText: (t) => replies.push(t),
    });
    expect(replies[0]).toBe('/a1-helptest — a1 help-test description');
  });

  it('/help overview combines host and container commands in one reply', () => {
    registerHostCommand('/a1-overview', vi.fn(), { help: 'a1 overview description' });
    registerHostCommand('/a1-hidden', vi.fn()); // no help — should not appear
    const result = classifyAtMessagingGroup(jsonChat('/help'), 'user-1');
    if (result.action !== 'handle') throw new Error('expected handle');
    const replies: string[] = [];
    result.handler({
      command: '/help',
      argsRaw: '',
      args: [],
      ...helpCtxStub,
      replyText: (t) => replies.push(t),
    });
    const out = replies[0];

    expect(out).toMatch(/Host commands:/);
    expect(out).toContain('/a1-overview');
    expect(out).toContain('a1 overview description');
    expect(out).toContain('/help');
    expect(out).not.toContain('/a1-hidden');

    expect(out).toMatch(/Container commands:/);
    expect(out).toContain('/clear');
    expect(out).toContain('Clear the conversation context');
    expect(out).toContain('/compact');
    expect(out).toContain('/cost');

    expect(out.indexOf('Host commands:')).toBeLessThan(out.indexOf('Container commands:'));
  });

  it('/help <known-container> replies with that entry', () => {
    const result = classifyAtMessagingGroup(jsonChat('/help clear'), 'user-1');
    if (result.action !== 'handle') throw new Error('expected handle');
    const replies: string[] = [];
    result.handler({
      command: '/help',
      argsRaw: 'clear',
      args: ['clear'],
      ...helpCtxStub,
      replyText: (t) => replies.push(t),
    });
    expect(replies[0]).toMatch(/^\/clear —/);
  });

  it('/help with leading slash on arg also works', () => {
    const result = classifyAtMessagingGroup(jsonChat('/help /clear'), 'user-1');
    if (result.action !== 'handle') throw new Error('expected handle');
    const replies: string[] = [];
    result.handler({
      command: '/help',
      argsRaw: '/clear',
      args: ['/clear'],
      ...helpCtxStub,
      replyText: (t) => replies.push(t),
    });
    expect(replies[0]).toMatch(/^\/clear —/);
  });

  it('/help <unknown> replies with "Unknown command"', () => {
    const result = classifyAtMessagingGroup(jsonChat('/help nope-not-real'), 'user-1');
    if (result.action !== 'handle') throw new Error('expected handle');
    const replies: string[] = [];
    result.handler({
      command: '/help',
      argsRaw: 'nope-not-real',
      args: ['nope-not-real'],
      ...helpCtxStub,
      replyText: (t) => replies.push(t),
    });
    expect(replies[0]).toMatch(/^Unknown command:/);
  });

  describe('role-aware visibility', () => {
    function runHelp(argsRaw: string, userId: string): string {
      const result = classifyAtMessagingGroup(jsonChat(`/help${argsRaw ? ` ${argsRaw}` : ''}`), userId);
      if (result.action !== 'handle') throw new Error('expected handle');
      const replies: string[] = [];
      result.handler({
        command: '/help',
        argsRaw,
        args: argsRaw.length === 0 ? [] : argsRaw.split(/\s+/),
        ...helpCtxStub,
        userId,
        replyText: (t) => replies.push(t),
      });
      return replies[0];
    }

    beforeEach(() => {
      registerHostCommand('/a1d-help-glob', vi.fn(), {
        scope: 'host',
        access: 'global-admin',
        help: 'global-admin-only command',
      });
      registerHostCommand('/a1d-help-gadm', vi.fn(), {
        access: 'group-admin',
        help: 'group-admin command',
      });
      ensureUser('scoped');
      ensureAgentGroup('ag-1');
      grantRole({ user_id: 'scoped', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
      ensureUser('global');
      grantRole({ user_id: 'global', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    });

    it('plain user sees neither gated command in the overview', () => {
      const out = runHelp('', 'user-1');
      expect(out).not.toContain('/a1d-help-glob');
      expect(out).not.toContain('/a1d-help-gadm');
      expect(out).toContain('/help'); // access 'any' still listed
    });

    it('scoped admin sees group-admin commands but not global-admin ones', () => {
      const out = runHelp('', 'scoped');
      expect(out).toContain('/a1d-help-gadm');
      expect(out).not.toContain('/a1d-help-glob');
    });

    it('global admin sees both', () => {
      const out = runHelp('', 'global');
      expect(out).toContain('/a1d-help-gadm');
      expect(out).toContain('/a1d-help-glob');
    });

    it('/help <cmd> on an inaccessible command replies Unknown command', () => {
      expect(runHelp('a1d-help-glob', 'user-1')).toMatch(/^Unknown command:/);
      expect(runHelp('a1d-help-glob', 'global')).toBe('/a1d-help-glob — global-admin-only command');
    });
  });
});
