import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Global per-provider auto-update cadence persistence (inventory F2).
 *
 * The per-group *selected* version is NOT a column: it rides in the existing
 * agent-runtime identity string (`sessions.agent_provider` /
 * `container_configs.provider`) after a colon — `claude:2.1.154`,
 * `claude:latest`, or bare `claude` (→ default = latest). A group admin sets it
 * via `/agent-runtime select`; it can only name a version a global admin has
 * already fetched.
 *
 * This table holds the global, per-provider auto-update cadence (the setting
 * string, e.g. '24h') — global-admin state set via `/agent-runtime auto`, keyed
 * by provider id so each runtime tracks its own cadence and survives restarts.
 */
export const migration016: Migration = {
  version: 16,
  name: 'runtime-auto-update',
  up(db: Database.Database) {
    db.prepare(
      `
      CREATE TABLE runtime_auto_update (
        provider   TEXT PRIMARY KEY,
        setting    TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    ).run();
  },
};
