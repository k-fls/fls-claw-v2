import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-broker config for the OneCLI-as-broker feature (C3). Global,
 * non-secret, global-admin-managed routing/policy — the central-DB home per
 * `docs/fls/specs/onecli-broker.md` §6. The secret/grantable `onecli`
 * agentIdentifier lives in the credential store, NOT here.
 *
 * One row per broker id:
 *   - write_authority — who may change this broker's per-group bits
 *     ('global-admin' | 'group-admin'); the flag is global so it's set once.
 *   - default_routing  — JSON {overtake?: string[], catchAll?: boolean};
 *     the global default applied to every group.
 *   - group_overrides  — JSON {<folder>: {overtake?, catchAll?}}; per-group
 *     per-field overrides. effectiveRouting = {...default, ...overrides[folder]}.
 *   - enabled          — broker on/off without dropping its config.
 *
 * Connection (url/apiKey/gatewayUrl) is NOT stored here — it stays in env
 * (ONECLI_URL / ONECLI_API_KEY), matching the existing wiring.
 */
export const flsMigration002: Migration = {
  // Fork migration (fls sequence #002). Binding mirrors upstream's `migrationNNN`
  // style, fork-namespaced (`flsMigrationNNN`), so it never collides with an
  // upstream import. `version` is unused by the runner (array order + `name` are
  // authoritative) — kept at the upstream epoch (16) this was reconciled against,
  // matching the `16-fls-02-` filename. `name` carries the `fls-` namespace so it
  // can never collide with an upstream migration name. IF NOT EXISTS makes the
  // rename safe: a DB that already applied the old `broker-config` name re-runs
  // this harmlessly under the new name.
  version: 16,
  name: 'fls-broker-config',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS broker_config (
        broker_id        TEXT PRIMARY KEY,
        write_authority  TEXT NOT NULL DEFAULT 'global-admin',
        default_routing  TEXT NOT NULL DEFAULT '{}',
        group_overrides  TEXT NOT NULL DEFAULT '{}',
        enabled          INTEGER NOT NULL DEFAULT 1,
        updated_at       TEXT NOT NULL
      );
    `);
  },
};
