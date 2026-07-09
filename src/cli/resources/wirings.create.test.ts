/**
 * Regression test for #5 — `ncl wirings create` must route through the domain
 * helper `createMessagingGroupAgent`, which auto-creates the matching
 * `agent_destinations` row so the agent can deliver to the wired chat as a
 * target. The generic single-table INSERT used by `operations.create` skips
 * that side effect, leaving `destinations list` empty and causing the agent's
 * `<message to="...">` blocks to be dropped ("Unknown destination").
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch with the
 * host caller — same code path a real approval would take.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-wirings-dest' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-wirings-dest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `wirings-*` commands (including create).
import './wirings.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('wirings CLI create auto-creates agent_destinations row (#5)', () => {
  const GID = 'ag-handler';
  const MGID = 'mg-chat-1';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: GID, name: 'handler', folder: 'handler', agent_provider: null, created_at: now() });
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('creates the channel destination for the wired agent group', async () => {
    const resp = await dispatch(
      {
        id: 'req-wire',
        command: 'wirings-create',
        args: { messaging_group_id: MGID, agent_group_id: GID },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);

    // The wiring row exists.
    expect(
      count(
        'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?',
        MGID,
        GID,
      ),
    ).toBe(1);

    // …and the matching channel destination was auto-created.
    const dest = getDb()
      .prepare(
        'SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ?',
      )
      .get(GID, 'channel', MGID) as { target_type: string; target_id: string } | undefined;
    expect(dest).toBeDefined();
    expect(dest).toMatchObject({ target_type: 'channel', target_id: MGID });
  });

  it('does not create a duplicate destination when re-wiring the same pair', async () => {
    await dispatch(
      { id: 'req-wire-1', command: 'wirings-create', args: { messaging_group_id: MGID, agent_group_id: GID } },
      { caller: 'host' },
    );

    // Re-wire the same pair (idempotent destination side effect).
    await dispatch(
      { id: 'req-wire-2', command: 'wirings-create', args: { messaging_group_id: MGID, agent_group_id: GID } },
      { caller: 'host' },
    );

    expect(
      count(
        'SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ?',
        GID,
        'channel',
        MGID,
      ),
    ).toBe(1);
  });
});
