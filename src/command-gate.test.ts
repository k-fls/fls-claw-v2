import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

async function seedUser(id: string): Promise<void> {
  await createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedAgentGroup('ag-1');
  await seedAgentGroup('ag-2');
});

afterEach(async () => {
  await closeDb();
});

describe('filtered commands', () => {
  it('drops /start before it reaches the container', async () => {
    expect(await gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', async () => {
    expect(await gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', async () => {
    expect(await gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', async () => {
    expect(await gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', async () => {
    await seedUser('telegram:owner');
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', async () => {
    await seedUser('telegram:admin');
    await grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(await gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', async () => {
    expect(await gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', async () => {
    expect(await gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

/**
 * Fork-specific: slash commands arriving @-mention-prefixed in a Slack group
 * channel must be classified from the boundary the adapter marked
 * (`mentionPrefixEnd`), not from the raw '@…' text.
 */
describe('gateCommand — mention-prefixed slash commands', () => {
  it('classifies a mention-prefixed filtered command when mentionPrefixEnd is set', async () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X /help', mentionPrefixEnd: 13 });
    expect(await gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('without the annotation, the mention-prefixed command falls through (the bug)', async () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X /help' });
    expect(await gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('still classifies a plain (DM-style) filtered command with no mention', async () => {
    const content = JSON.stringify({ text: '/help' });
    expect(await gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('passes ordinary chatter through', async () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X how are you?', mentionPrefixEnd: 13 });
    expect(await gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('ignores an out-of-range mentionPrefixEnd rather than throwing', async () => {
    const content = JSON.stringify({ text: '/help', mentionPrefixEnd: 999 });
    expect(await gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });
});
