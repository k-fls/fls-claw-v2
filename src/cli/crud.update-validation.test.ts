/**
 * Regression test for #6 — `ncl wirings update --id <w> --agent-group-id <x>`
 * was a SILENT NO-OP. `agent_group_id` is declared `required` (not `updatable`)
 * on the wirings resource, and `genericUpdate` only iterated `updatable`
 * columns — so a flag naming a non-updatable (or unknown) column was silently
 * ignored. The fix makes `genericUpdate` validate provided flags up front and
 * reject non-updatable / unknown fields with a clear error.
 *
 * Dispatch is invoked with `caller: 'host'` (same path a real approved
 * `wirings update` would take, since the resource is approval-gated and the
 * approval handler re-enters dispatch as host).
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-crud-update' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-crud-update';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../db/index.js';
import { dispatch } from './dispatch.js';
// Side-effect import: registers the `wirings-*` commands.
import './resources/wirings.js';

function now(): string {
  return new Date().toISOString();
}

const GID_A = 'ag-a';
const GID_B = 'ag-b';
const MGID = 'mg-1';
const WID = 'wiring-1';

function seed(): void {
  createAgentGroup({ id: GID_A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
  createAgentGroup({ id: GID_B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });
  const db = getDb();
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
     VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
  ).run(MGID, now());
  db.prepare(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
     VALUES (?, ?, ?, 'mention', NULL, 'all', 'drop', 'shared', 0, ?)`,
  ).run(WID, MGID, GID_A, now());
}

describe('genericUpdate flag validation (#6)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    seed();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('rejects a non-updatable column (agent_group_id) instead of silently ignoring it', async () => {
    const resp = await dispatch(
      { id: 'r1', command: 'wirings-update', args: { id: WID, 'agent-group-id': GID_B } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/not updatable/i);

    // The row must be unchanged.
    const row = getDb().prepare('SELECT agent_group_id FROM messaging_group_agents WHERE id = ?').get(WID) as {
      agent_group_id: string;
    };
    expect(row.agent_group_id).toBe(GID_A);
  });

  it('rejects an unknown flag', async () => {
    const resp = await dispatch(
      { id: 'r2', command: 'wirings-update', args: { id: WID, bogus_field: 'x' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/unknown field/i);
  });

  it('still applies a legitimate update (does not over-reject)', async () => {
    const resp = await dispatch(
      { id: 'r3', command: 'wirings-update', args: { id: WID, 'engage-mode': 'pattern', 'engage-pattern': '.' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const row = getDb()
      .prepare('SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = ?')
      .get(WID) as { engage_mode: string; engage_pattern: string };
    expect(row.engage_mode).toBe('pattern');
    expect(row.engage_pattern).toBe('.');
  });
});
