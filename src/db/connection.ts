import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import type { DbDriver } from './driver.js';
import { SqliteDriver } from './drivers/sqlite.js';

let _db: DbDriver | null = null;

export function getDb(): DbDriver {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export async function initDb(dbPath: string): Promise<DbDriver> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  _db = new SqliteDriver(raw);
  log.info('Central DB initialized', { path: dbPath });
  return _db;
}

/** For tests only — creates an in-memory DB and runs migrations. */
export async function initTestDb(): Promise<DbDriver> {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  _db = new SqliteDriver(raw);
  return _db;
}

export async function closeDb(): Promise<void> {
  await _db?.close();
  _db = null;
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Cheap: a single indexed lookup on
 * sqlite_master. Results are not cached — a module install adds the
 * table at runtime (next service start), and callers may run before
 * or after that boundary.
 */
export async function hasTable(db: DbDriver, name: string): Promise<boolean> {
  return db.hasTable(name);
}
