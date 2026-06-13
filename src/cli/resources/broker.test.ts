/**
 * `ncl brokers` resource — driven through dispatch as a host caller (the path a
 * real operator / approved command takes). Covers set (create + field-preserving
 * update), get/list, set-group / clear-group overrides, and delete.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';

import './broker.js';

let seq = 0;
async function run(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await dispatch({ id: `t${seq++}`, command, args }, { caller: 'host' });
  if (!res.ok) throw new Error(`${command} failed: ${res.error.message}`);
  return res.data;
}

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => {
  closeDb();
});

describe('ncl brokers', () => {
  it('set creates a broker with default routing', async () => {
    const data = await run('brokers-set', {
      id: 'onecli',
      overtake: 'github,anthropic',
      'catch-all': 'true',
    });
    expect(data).toMatchObject({
      brokerId: 'onecli',
      writeAuthority: 'global-admin',
      defaultRouting: { overtake: ['github', 'anthropic'], catchAll: true },
      enabled: true,
    });
  });

  it('set preserves unspecified fields on update', async () => {
    await run('brokers-set', { id: 'onecli', overtake: 'github', 'catch-all': 'true' });
    const data = (await run('brokers-set', { id: 'onecli', enabled: 'false' })) as {
      defaultRouting: { overtake: string[]; catchAll: boolean };
      enabled: boolean;
    };
    expect(data.defaultRouting).toEqual({ overtake: ['github'], catchAll: true }); // inherited
    expect(data.enabled).toBe(false);
  });

  it('set --write-authority validates the enum', async () => {
    const res = await dispatch(
      { id: 'x', command: 'brokers-set', args: { id: 'onecli', 'write-authority': 'nonsense' } },
      { caller: 'host' },
    );
    expect(res.ok).toBe(false);
  });

  it('set-group adds a per-field override; clear-group removes it', async () => {
    await run('brokers-set', { id: 'onecli', overtake: 'github', 'catch-all': 'true' });
    const set = (await run('brokers-set-group', { id: 'onecli', group: 'team-x', 'catch-all': 'false' })) as {
      groupOverrides: Record<string, unknown>;
    };
    expect(set.groupOverrides).toEqual({ 'team-x': { catchAll: false } });

    const cleared = (await run('brokers-clear-group', { id: 'onecli', group: 'team-x' })) as {
      groupOverrides: Record<string, unknown>;
    };
    expect(cleared.groupOverrides).toEqual({});
  });

  it('set-group on an unknown broker errors', async () => {
    const res = await dispatch(
      { id: 'x', command: 'brokers-set-group', args: { id: 'ghost', group: 'g' } },
      { caller: 'host' },
    );
    expect(res.ok).toBe(false);
  });

  it('list and delete', async () => {
    await run('brokers-set', { id: 'onecli', 'catch-all': 'true' });
    const list = (await run('brokers-list')) as unknown[];
    expect(list).toHaveLength(1);
    await run('brokers-delete', { id: 'onecli' });
    const after = (await run('brokers-list')) as unknown[];
    expect(after).toHaveLength(0);
  });
});
