import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(() => {
  closeDb();
});

describe('filtered commands', () => {
  it('drops /start before it reaches the container', () => {
    expect(gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', () => {
    expect(gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', () => {
    expect(gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', () => {
    expect(gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', () => {
    seedUser('telegram:owner');
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', () => {
    seedUser('telegram:admin');
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', () => {
    expect(gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', () => {
    expect(gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

/**
 * Fork-specific: slash commands arriving @-mention-prefixed in a Slack group
 * channel must be classified from the boundary the adapter marked
 * (`mentionPrefixEnd`), not from the raw '@…' text.
 */
describe('gateCommand — mention-prefixed slash commands', () => {
  it('classifies a mention-prefixed filtered command when mentionPrefixEnd is set', () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X /help', mentionPrefixEnd: 13 });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('without the annotation, the mention-prefixed command falls through (the bug)', () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X /help' });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('still classifies a plain (DM-style) filtered command with no mention', () => {
    const content = JSON.stringify({ text: '/help' });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('passes ordinary chatter through', () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X how are you?', mentionPrefixEnd: 13 });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('ignores an out-of-range mentionPrefixEnd rather than throwing', () => {
    const content = JSON.stringify({ text: '/help', mentionPrefixEnd: 999 });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });
});
