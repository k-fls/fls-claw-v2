/**
 * Central-DB CRUD for per-broker config (C3) — the global, non-secret,
 * global-admin-managed routing/policy for credential brokers. See
 * `docs/fls/specs/onecli-broker.md` §6. The secret/grantable `onecli`
 * agentIdentifier lives in the credential store, not here.
 */
import { getDb } from './connection.js';

export type WriteAuthority = 'global-admin' | 'group-admin';

/** One broker's routing policy, as applied to a group. */
export interface RoutingPolicy {
  /** Provider ids and/or host patterns this broker overtakes (covered space). */
  overtake: string[];
  /** Whether this broker also handles uncovered space (catch-all). */
  catchAll: boolean;
}

/** Raw `broker_config` row (JSON columns unparsed). */
export interface BrokerConfigRow {
  broker_id: string;
  write_authority: WriteAuthority;
  default_routing: string;
  group_overrides: string;
  enabled: number;
  updated_at: string;
}

/** Parsed broker config. */
export interface BrokerConfig {
  brokerId: string;
  writeAuthority: WriteAuthority;
  defaultRouting: Partial<RoutingPolicy>;
  /** folder → per-field overrides. */
  groupOverrides: Record<string, Partial<RoutingPolicy>>;
  enabled: boolean;
}

const EMPTY_ROUTING: RoutingPolicy = { overtake: [], catchAll: false };

function parseRoutingObject(raw: string): Partial<RoutingPolicy> {
  try {
    const o = JSON.parse(raw) as Partial<RoutingPolicy>;
    if (!o || typeof o !== 'object') return {};
    const out: Partial<RoutingPolicy> = {};
    if (Array.isArray(o.overtake)) out.overtake = o.overtake.filter((s) => typeof s === 'string');
    if (typeof o.catchAll === 'boolean') out.catchAll = o.catchAll;
    return out;
  } catch {
    return {};
  }
}

function parseGroupOverrides(raw: string): Record<string, Partial<RoutingPolicy>> {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return {};
    const out: Record<string, Partial<RoutingPolicy>> = {};
    for (const [folder, val] of Object.entries(o)) {
      out[folder] = parseRoutingObject(JSON.stringify(val));
    }
    return out;
  } catch {
    return {};
  }
}

function parseRow(row: BrokerConfigRow): BrokerConfig {
  return {
    brokerId: row.broker_id,
    writeAuthority: row.write_authority,
    defaultRouting: parseRoutingObject(row.default_routing),
    groupOverrides: parseGroupOverrides(row.group_overrides),
    enabled: row.enabled !== 0,
  };
}

export function getBrokerConfig(brokerId: string): BrokerConfig | undefined {
  const row = getDb().prepare('SELECT * FROM broker_config WHERE broker_id = ?').get(brokerId) as
    | BrokerConfigRow
    | undefined;
  return row ? parseRow(row) : undefined;
}

export function getAllBrokerConfigs(): BrokerConfig[] {
  return (getDb().prepare('SELECT * FROM broker_config').all() as BrokerConfigRow[]).map(parseRow);
}

/** Broker ids that are configured AND enabled — the demand set for registration. */
export function listEnabledBrokerIds(): string[] {
  return (
    getDb().prepare('SELECT broker_id FROM broker_config WHERE enabled = 1').all() as {
      broker_id: string;
    }[]
  ).map((r) => r.broker_id);
}

/** Upsert a broker's full config. JSON fields are serialized here. */
export function upsertBrokerConfig(config: BrokerConfig): void {
  getDb()
    .prepare(
      `INSERT INTO broker_config (broker_id, write_authority, default_routing, group_overrides, enabled, updated_at)
       VALUES (@broker_id, @write_authority, @default_routing, @group_overrides, @enabled, @updated_at)
       ON CONFLICT(broker_id) DO UPDATE SET
         write_authority = excluded.write_authority,
         default_routing = excluded.default_routing,
         group_overrides = excluded.group_overrides,
         enabled         = excluded.enabled,
         updated_at      = excluded.updated_at`,
    )
    .run({
      broker_id: config.brokerId,
      write_authority: config.writeAuthority,
      default_routing: JSON.stringify(config.defaultRouting ?? {}),
      group_overrides: JSON.stringify(config.groupOverrides ?? {}),
      enabled: config.enabled ? 1 : 0,
      updated_at: new Date().toISOString(),
    });
}

export function deleteBrokerConfig(brokerId: string): void {
  getDb().prepare('DELETE FROM broker_config WHERE broker_id = ?').run(brokerId);
}

/**
 * Effective routing for (broker, group folder): the global default merged
 * per-field with the group's override. Both authored by global-admin, so the
 * override may add OR remove relative to the default — no extend-only rule (see
 * spec §6). Returns empty routing when the broker is unconfigured or disabled.
 */
export function effectiveRouting(brokerId: string, folder: string): RoutingPolicy {
  const cfg = getBrokerConfig(brokerId);
  if (!cfg || !cfg.enabled) return { ...EMPTY_ROUTING };
  const override = cfg.groupOverrides[folder] ?? {};
  return {
    overtake: override.overtake ?? cfg.defaultRouting.overtake ?? [],
    catchAll: override.catchAll ?? cfg.defaultRouting.catchAll ?? false,
  };
}
