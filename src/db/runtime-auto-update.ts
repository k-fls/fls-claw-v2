/**
 * Global per-provider auto-update cadence (inventory F2). The setting string
 * (e.g. '24h') is global-admin state set via `/agent-runtime auto`; persisting
 * it in the central DB lets a configured cadence survive restarts. Keyed by
 * provider id. See migration 016 (`runtime_auto_update`).
 */
import { getDb } from './connection.js';

/** The persisted auto-update setting for a provider, or null if none set. */
export function getRuntimeAutoUpdate(provider: string): string | null {
  const row = getDb().prepare('SELECT setting FROM runtime_auto_update WHERE provider = ?').get(provider) as
    | { setting: string }
    | undefined;
  return row?.setting ?? null;
}

/** Upsert the auto-update setting for a provider. */
export function setRuntimeAutoUpdate(provider: string, setting: string): void {
  getDb()
    .prepare(
      `INSERT INTO runtime_auto_update (provider, setting, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET setting = excluded.setting, updated_at = excluded.updated_at`,
    )
    .run(provider, setting, new Date().toISOString());
}
