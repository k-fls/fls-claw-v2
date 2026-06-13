import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { hasTable } from '../connection.js';
import { runMigrations } from './index.js';

/**
 * Guards the class of bug where a migration is *imported* into this module but
 * left out of the ordered `migrations` array — it then never runs, so its table
 * is silently absent and only an unrelated boot-time query (e.g.
 * `startRuntimeUpdaters` → `getRuntimeAutoUpdate`) reveals it. The pre-existing
 * suite missed this because it never queried the latest table; assert the
 * end-state schema directly instead.
 */
describe('runMigrations end-state schema', () => {
  it('creates the tables of the latest migrations', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // 016 — the F2 runtime-version migration; absent if not registered.
    expect(hasTable(db, 'runtime_auto_update')).toBe(true);
    // A couple of earlier tables, so a wholesale regression is also caught.
    expect(hasTable(db, 'container_configs')).toBe(true);
    expect(hasTable(db, 'agent_groups')).toBe(true);
  });
});
