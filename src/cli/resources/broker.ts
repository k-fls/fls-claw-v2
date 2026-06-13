/**
 * `ncl brokers` — credential broker routing config (C3). Global-admin only:
 * `broker_config` is not in the group-scope CLI whitelist, so container agents
 * in `group` scope can't reach it; mutations are `approval`-gated for any
 * non-host caller. See `docs/fls/specs/onecli-broker.md` §6.
 *
 * Routes a group's requests to a centralized broker (OneCLI):
 *   - overtake specific providers/hosts (covered space),
 *   - catch-all the uncovered space,
 * with a global default + per-group overrides. The grantable `onecli`
 * agent-identifier lives in the credential store, not here.
 *
 * list/get/delete are generic; set / set-group / clear-group are custom so the
 * JSON routing is edited ergonomically and round-trips through
 * `db/broker-config.ts` (parse/serialize + per-field merge).
 */
import {
  type BrokerConfig,
  type RoutingPolicy,
  type WriteAuthority,
  getBrokerConfig,
  upsertBrokerConfig,
} from '../../db/broker-config.js';
import { registerResource } from '../crud.js';

const WRITE_AUTHORITIES: WriteAuthority[] = ['global-admin', 'group-admin'];

function brokerId(args: Record<string, unknown>): string {
  const id = (args.id ?? args.broker_id) as string | undefined;
  if (!id) throw new Error('--id (broker id, e.g. onecli) is required');
  return id;
}

/** Comma-separated list → string[]; `undefined` when the flag was absent. */
function parseCsv(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s === ''
    ? []
    : s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
}

/** Tri-state bool: `undefined` when absent (so it inherits, not overwrites). */
function parseBool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  return v === true || v === 'true' || v === '1';
}

registerResource({
  name: 'broker',
  plural: 'brokers',
  table: 'broker_config',
  description:
    'Credential broker routing (C3, global-admin). Routes a group’s requests to a centralized broker (OneCLI) — overtake providers/hosts, or catch-all uncovered space — with a global default + per-group overrides. See docs/fls/specs/onecli-broker.md.',
  idColumn: 'broker_id',
  columns: [
    { name: 'broker_id', type: 'string', description: 'Broker id, e.g. "onecli".' },
    {
      name: 'write_authority',
      type: 'string',
      description: 'Who may change this broker’s per-group bits.',
      enum: WRITE_AUTHORITIES,
    },
    { name: 'default_routing', type: 'json', description: 'Global default {overtake, catchAll} (JSON).' },
    { name: 'group_overrides', type: 'json', description: 'Per-group {folder: {overtake?, catchAll?}} (JSON).' },
    { name: 'enabled', type: 'boolean', description: 'Broker on/off without dropping config.' },
    { name: 'updated_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', delete: 'approval' },
  customOperations: {
    set: {
      access: 'approval',
      description:
        'Create/update a broker’s DEFAULT routing. --id <broker>; optional --overtake a,b,c  --catch-all true|false  --write-authority global-admin|group-admin  --enabled true|false. Unspecified fields keep their current value.',
      handler: async (args) => {
        const id = brokerId(args);
        const existing = getBrokerConfig(id);
        const overtake = parseCsv(args.overtake);
        const catchAll = parseBool(args.catch_all);
        const wa = args.write_authority as WriteAuthority | undefined;
        if (wa && !WRITE_AUTHORITIES.includes(wa)) {
          throw new Error(`--write-authority must be one of: ${WRITE_AUTHORITIES.join(', ')}`);
        }
        const enabled = parseBool(args.enabled);
        const next: BrokerConfig = {
          brokerId: id,
          writeAuthority: wa ?? existing?.writeAuthority ?? 'global-admin',
          defaultRouting: {
            overtake: overtake ?? existing?.defaultRouting.overtake ?? [],
            catchAll: catchAll ?? existing?.defaultRouting.catchAll ?? false,
          },
          groupOverrides: existing?.groupOverrides ?? {},
          enabled: enabled ?? existing?.enabled ?? true,
        };
        upsertBrokerConfig(next);
        return getBrokerConfig(id);
      },
    },
    'set-group': {
      access: 'approval',
      description:
        'Set a per-group routing override. --id <broker> --group <folder>; optional --overtake a,b,c  --catch-all true|false. Unspecified fields inherit the default.',
      handler: async (args) => {
        const id = brokerId(args);
        const folder = args.group as string | undefined;
        if (!folder) throw new Error('--group (agent group folder) is required');
        const existing = getBrokerConfig(id);
        if (!existing) throw new Error(`broker not found: ${id} (run \`brokers set\` first)`);
        const override: Partial<RoutingPolicy> = {};
        const overtake = parseCsv(args.overtake);
        const catchAll = parseBool(args.catch_all);
        if (overtake !== undefined) override.overtake = overtake;
        if (catchAll !== undefined) override.catchAll = catchAll;
        upsertBrokerConfig({
          ...existing,
          groupOverrides: { ...existing.groupOverrides, [folder]: override },
        });
        return getBrokerConfig(id);
      },
    },
    'clear-group': {
      access: 'approval',
      description: 'Remove a per-group override. --id <broker> --group <folder>.',
      handler: async (args) => {
        const id = brokerId(args);
        const folder = args.group as string | undefined;
        if (!folder) throw new Error('--group (agent group folder) is required');
        const existing = getBrokerConfig(id);
        if (!existing) throw new Error(`broker not found: ${id}`);
        const overrides = { ...existing.groupOverrides };
        delete overrides[folder];
        upsertBrokerConfig({ ...existing, groupOverrides: overrides });
        return getBrokerConfig(id);
      },
    },
  },
});
