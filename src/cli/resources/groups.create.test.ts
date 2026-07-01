/**
 * Regression test for #4 — `ncl groups create` must also provision the
 * matching `container_configs` row, otherwise the new group is unspawnable:
 * `materializeContainerJson` throws "Container config not found for agent
 * group: <id>" at spawn time.
 *
 * The bug pre-fix: `create` was a generic single-table INSERT into
 * `agent_groups` only. The non-CLI creation paths (`group-init.ts`,
 * `commands/agent-runtime.ts`) call `ensureContainerConfig(id)` right after;
 * the CLI path skipped it.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch with
 * the host caller — the same code path a real approval would take.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups-create' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups-create';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including create).
import './groups.js';

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI create provisions a container_configs row (#4)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('creates the agent_groups row AND its container_configs row', async () => {
    const resp = await dispatch(
      { id: 'req-create', command: 'groups-create', args: { name: 'newbie', folder: 'newbie' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { id: string } }).data;
    const id = data.id;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    // The agent_groups row exists.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', id)).toBe(1);

    // The container_configs row must exist — without it the group is unspawnable.
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', id)).toBe(1);
  });

  it('errors when required fields are missing', async () => {
    const resp = await dispatch(
      { id: 'req-create-bad', command: 'groups-create', args: { folder: 'orphan' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
  });
});
