/**
 * `ncl undelivered` — the outbound dead-letter surface.
 *
 * Covers the two properties that make the surface worth having: a permanently
 * failed reply is visible with enough context to act on, and requeuing it is
 * safe. The dangerous direction is a requeue that resurrects an already-sent
 * message into a duplicate delivery, so that case is asserted through dispatch
 * rather than only at the DB layer.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-undelivered' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-undelivered';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath, initSessionFolder, outboundDbPath } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers `undelivered-list` / `undelivered-requeue`.
import './undelivered.js';

const GROUP = 'ag-undeliv';
const SESSION = 'sess-undeliv-1';
const EMPTY_SESSION = 'sess-undeliv-2';

/** Narrow a ResponseFrame to its success payload, surfacing the error message
 *  when a command fails — `resp.data` is only present on the ok variant. */
function okData<T = Record<string, unknown>>(resp: Awaited<ReturnType<typeof dispatch>>): T {
  if (!resp.ok) throw new Error(`dispatch failed: ${resp.error.code} ${resp.error.message}`);
  return resp.data as T;
}

function now(): string {
  return new Date().toISOString();
}

function seedOutbound(id: string, text: string): void {
  const db = new Database(outboundDbPath(GROUP, SESSION));
  db.prepare(
    `INSERT INTO messages_out (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', ?, 'slack:C1', 'slack', NULL, ?)`,
  ).run(id, Math.floor(Math.random() * 1e6) * 2 + 1, now(), JSON.stringify({ text }));
  db.close();
}

function seedDelivered(id: string, status: 'delivered' | 'failed', at: string): void {
  const db = new Database(inboundDbPath(GROUP, SESSION));
  db.prepare(
    'INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, ?, ?)',
  ).run(id, status === 'delivered' ? 'platform-1' : null, status, at);
  db.close();
}

function deliveredRow(id: string): { status: string } | undefined {
  const db = new Database(inboundDbPath(GROUP, SESSION), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(id) as
    | { status: string }
    | undefined;
  db.close();
  return row;
}

describe('ncl undelivered', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: GROUP, name: 'undeliv', folder: 'undeliv', agent_provider: null, created_at: now() });

    for (const sid of [SESSION, EMPTY_SESSION]) {
      createSession({
        id: sid,
        agent_group_id: GROUP,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now(),
      });
      initSessionFolder(GROUP, sid);
    }

    seedOutbound('out-lost', 'the answer nobody received');
    seedOutbound('out-sent', 'the answer that landed');
    seedDelivered('out-lost', 'failed', '2026-08-19T10:00:00Z');
    seedDelivered('out-sent', 'delivered', '2026-08-19T11:00:00Z');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('list surfaces the failed reply with its content, and never the delivered one', async () => {
    const resp = await dispatch({ id: 'r1', command: 'undelivered-list', args: {} }, { caller: 'host' });
    const data = okData<{ count: number; messages: Array<Record<string, unknown>> }>(resp);
    expect(data.count).toBe(1);
    const [msg] = data.messages;
    expect(msg).toMatchObject({
      messageOutId: 'out-lost',
      sessionId: SESSION,
      agentGroupId: GROUP,
      channelType: 'slack',
      platformId: 'slack:C1',
      recoverable: true,
    });
    // The preview is the whole point of listing: without it an operator has a
    // message id and no way to judge whether the loss mattered.
    expect(msg.preview).toBe('the answer nobody received');
  });

  it('requeue clears the failed row so the delivery poll can pick the reply up again', async () => {
    const resp = await dispatch(
      { id: 'r2', command: 'undelivered-requeue', args: { id: 'out-lost' } },
      { caller: 'host' },
    );
    expect(okData(resp)).toMatchObject({ requeued: true, messageOutId: 'out-lost', sessionId: SESSION });

    // Gone from `delivered` entirely — which is what makes drainSession's
    // undelivered filter see the message again.
    expect(deliveredRow('out-lost')).toBeUndefined();

    const after = await dispatch({ id: 'r3', command: 'undelivered-list', args: {} }, { caller: 'host' });
    expect(okData<{ count: number }>(after).count).toBe(0);
  });

  it('refuses to requeue a delivered message, so it cannot cause a duplicate send', async () => {
    const resp = await dispatch(
      { id: 'r4', command: 'undelivered-requeue', args: { id: 'out-sent' } },
      { caller: 'host' },
    );
    expect(okData(resp)).toMatchObject({ requeued: false });

    // Still settled — the poll must not send it a second time.
    expect(deliveredRow('out-sent')).toMatchObject({ status: 'delivered' });
  });

  it('reports an unknown id without touching anything', async () => {
    const resp = await dispatch(
      { id: 'r5', command: 'undelivered-requeue', args: { id: 'out-nonexistent' } },
      { caller: 'host' },
    );
    expect(okData(resp)).toMatchObject({ requeued: false });
    expect(deliveredRow('out-lost')).toMatchObject({ status: 'failed' });
  });

  it('requires --id rather than silently listing or clearing everything', async () => {
    const resp = await dispatch({ id: 'r6', command: 'undelivered-requeue', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(false);
  });

  it('survives a session whose databases are missing, instead of hiding every other loss', async () => {
    // A session row with no folder on disk — the shape left behind when a
    // session is deleted from disk but not from the central DB. One such
    // session must not abort the scan and mask real dead letters.
    createSession({
      id: 'sess-ghost',
      agent_group_id: GROUP,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const resp = await dispatch({ id: 'r7', command: 'undelivered-list', args: {} }, { caller: 'host' });
    expect(okData<{ count: number }>(resp).count).toBe(1);
  });
});
