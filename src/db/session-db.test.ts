/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  clearFailedDelivery,
  getDeliveredIds,
  getFailedDeliveries,
  getInboundSourceSessionId,
  markDelivered,
  markDeliveryFailed,
  migrateMessagesInTable,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('failed-delivery dead letters', () => {
  function freshDeliveredDb(): Database.Database {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE delivered (
        message_out_id      TEXT PRIMARY KEY,
        platform_message_id TEXT,
        status              TEXT NOT NULL DEFAULT 'delivered',
        delivered_at        TEXT NOT NULL
      );
    `);
    return db;
  }

  it('surfaces only failed rows, newest first, leaving delivered ones alone', () => {
    const db = freshDeliveredDb();
    try {
      markDelivered(db, 'out-sent', 'platform-1');
      markDeliveryFailed(db, 'out-dead-a');
      markDeliveryFailed(db, 'out-dead-b');
      // markDeliveryFailed stamps datetime('now') at second granularity, so
      // order within one second is not guaranteed — assert membership, and
      // pin ordering separately below with explicit timestamps.
      const ids = getFailedDeliveries(db).map((r) => r.message_out_id);
      expect(ids.sort()).toEqual(['out-dead-a', 'out-dead-b']);
      expect(ids).not.toContain('out-sent');
    } finally {
      db.close();
    }
  });

  it('orders newest first', () => {
    const db = freshDeliveredDb();
    try {
      const ins = db.prepare(
        "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'failed', ?)",
      );
      ins.run('out-older', '2026-08-19T10:00:00Z');
      ins.run('out-newer', '2026-08-19T12:00:00Z');
      expect(getFailedDeliveries(db).map((r) => r.message_out_id)).toEqual(['out-newer', 'out-older']);
    } finally {
      db.close();
    }
  });

  it('requeues a failed row so the delivery poll sees the message again', () => {
    const db = freshDeliveredDb();
    try {
      markDeliveryFailed(db, 'out-dead');
      // getDeliveredIds is what drainSession filters against — a failed row is
      // in it, which is exactly why the reply was unreachable.
      expect(getDeliveredIds(db).has('out-dead')).toBe(true);

      expect(clearFailedDelivery(db, 'out-dead')).toBe(true);

      expect(getDeliveredIds(db).has('out-dead')).toBe(false);
      expect(getFailedDeliveries(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('refuses to clear a delivered row, so a requeue can never cause a duplicate send', () => {
    const db = freshDeliveredDb();
    try {
      markDelivered(db, 'out-sent', 'platform-1');

      expect(clearFailedDelivery(db, 'out-sent')).toBe(false);
      // Still settled: the poll must not pick it up and send it a second time.
      expect(getDeliveredIds(db).has('out-sent')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reports false for an id that is not recorded at all', () => {
    const db = freshDeliveredDb();
    try {
      expect(clearFailedDelivery(db, 'out-never-existed')).toBe(false);
    } finally {
      db.close();
    }
  });
});
