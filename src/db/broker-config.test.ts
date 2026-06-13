import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type BrokerConfig,
  deleteBrokerConfig,
  effectiveRouting,
  getAllBrokerConfigs,
  getBrokerConfig,
  listEnabledBrokerIds,
  upsertBrokerConfig,
} from './broker-config.js';
import { closeDb, initTestDb, runMigrations } from './index.js';

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => {
  closeDb();
});

const base: BrokerConfig = {
  brokerId: 'onecli',
  writeAuthority: 'global-admin',
  defaultRouting: { overtake: ['github'], catchAll: false },
  groupOverrides: {},
  enabled: true,
};

describe('broker_config DB', () => {
  it('migration creates the table — empty to start', () => {
    expect(getAllBrokerConfigs()).toEqual([]);
    expect(listEnabledBrokerIds()).toEqual([]);
    expect(getBrokerConfig('onecli')).toBeUndefined();
  });

  it('upserts and round-trips parsed config', () => {
    upsertBrokerConfig({
      ...base,
      defaultRouting: { overtake: ['github', 'api.stripe.com'], catchAll: true },
      groupOverrides: { 'team-x': { catchAll: false }, 'team-y': { overtake: ['anthropic'] } },
    });
    const got = getBrokerConfig('onecli');
    expect(got).toEqual({
      brokerId: 'onecli',
      writeAuthority: 'global-admin',
      defaultRouting: { overtake: ['github', 'api.stripe.com'], catchAll: true },
      groupOverrides: { 'team-x': { catchAll: false }, 'team-y': { overtake: ['anthropic'] } },
      enabled: true,
    });
  });

  it('upsert updates an existing row', () => {
    upsertBrokerConfig(base);
    upsertBrokerConfig({ ...base, writeAuthority: 'group-admin', enabled: false });
    const got = getBrokerConfig('onecli')!;
    expect(got.writeAuthority).toBe('group-admin');
    expect(got.enabled).toBe(false);
    expect(getAllBrokerConfigs()).toHaveLength(1);
  });

  it('listEnabledBrokerIds reflects the enabled flag (demand set)', () => {
    upsertBrokerConfig(base);
    upsertBrokerConfig({ ...base, brokerId: 'other', enabled: false });
    expect(listEnabledBrokerIds()).toEqual(['onecli']);
  });

  it('delete removes the row', () => {
    upsertBrokerConfig(base);
    deleteBrokerConfig('onecli');
    expect(getBrokerConfig('onecli')).toBeUndefined();
  });

  describe('effectiveRouting (per-field merge)', () => {
    it('returns default when no override', () => {
      upsertBrokerConfig({ ...base, defaultRouting: { overtake: ['github'], catchAll: true } });
      expect(effectiveRouting('onecli', 'any-group')).toEqual({ overtake: ['github'], catchAll: true });
    });

    it('override wins per-field; unspecified fields inherit default', () => {
      upsertBrokerConfig({
        ...base,
        defaultRouting: { overtake: ['github'], catchAll: true },
        groupOverrides: { 'team-x': { catchAll: false } }, // overtake inherits
      });
      expect(effectiveRouting('onecli', 'team-x')).toEqual({ overtake: ['github'], catchAll: false });
    });

    it('override may remove an overtake (single authority — no extend-only rule)', () => {
      upsertBrokerConfig({
        ...base,
        defaultRouting: { overtake: ['github', 'anthropic'], catchAll: true },
        groupOverrides: { 'team-x': { overtake: [] } },
      });
      expect(effectiveRouting('onecli', 'team-x')).toEqual({ overtake: [], catchAll: true });
    });

    it('disabled or unconfigured broker → empty routing', () => {
      expect(effectiveRouting('nope', 'g')).toEqual({ overtake: [], catchAll: false });
      upsertBrokerConfig({ ...base, enabled: false });
      expect(effectiveRouting('onecli', 'g')).toEqual({ overtake: [], catchAll: false });
    });
  });
});
