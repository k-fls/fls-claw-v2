/**
 * Per-container broker-routing snapshot + the per-container broker setup hook.
 *
 * Verifies the snapshot reflects effectiveRouting, is demand-gated (no entry
 * when a scope routes nowhere), and fires onContainerRouted/onContainerReleased
 * only for the brokers a container actually routes to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertBrokerConfig } from '../../db/broker-config.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';

import { type CredentialBroker, _resetBrokerRegistryForTests, registerCredentialBroker } from './broker-registry.js';
import {
  _resetBrokerRoutingForTests,
  dropBrokerRouting,
  getBrokerRouting,
  hasAnyBrokerRouting,
  snapshotBrokerRouting,
} from './broker-routing.js';

function brokerWithHooks(id: string): CredentialBroker & {
  routed: ReturnType<typeof vi.fn>;
  released: ReturnType<typeof vi.fn>;
} {
  const routed = vi.fn();
  const released = vi.fn();
  return { id, tryForward: async () => {}, onContainerRouted: routed, onContainerReleased: released, routed, released };
}

beforeEach(() => {
  runMigrations(initTestDb());
  _resetBrokerRegistryForTests();
  _resetBrokerRoutingForTests();
});
afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('snapshotBrokerRouting', () => {
  it('records nothing when the scope routes to no enabled broker (demand)', () => {
    snapshotBrokerRouting('10.0.0.1', 'grp');
    expect(getBrokerRouting('10.0.0.1')).toEqual([]);
    expect(hasAnyBrokerRouting()).toBe(false);
  });

  it('snapshots effective routing for a routed scope', () => {
    upsertBrokerConfig({
      brokerId: 'onecli',
      writeAuthority: 'global-admin',
      defaultRouting: { overtake: ['github'], catchAll: true },
      groupOverrides: { grp: { overtake: ['anthropic'] } },
      enabled: true,
    });
    snapshotBrokerRouting('10.0.0.2', 'grp');
    expect(getBrokerRouting('10.0.0.2')).toEqual([{ brokerId: 'onecli', overtake: ['anthropic'], catchAll: true }]);
    expect(hasAnyBrokerRouting()).toBe(true);
  });

  it('disabled broker is not snapshotted', () => {
    upsertBrokerConfig({
      brokerId: 'onecli',
      writeAuthority: 'global-admin',
      defaultRouting: { overtake: ['github'], catchAll: false },
      groupOverrides: {},
      enabled: false,
    });
    snapshotBrokerRouting('10.0.0.3', 'grp');
    expect(getBrokerRouting('10.0.0.3')).toEqual([]);
  });

  it('fires onContainerRouted only for the routed broker', () => {
    upsertBrokerConfig({
      brokerId: 'onecli',
      writeAuthority: 'global-admin',
      defaultRouting: { overtake: ['github'], catchAll: false },
      groupOverrides: {},
      enabled: true,
    });
    const onecli = brokerWithHooks('onecli');
    const other = brokerWithHooks('other'); // registered but not configured/routed
    registerCredentialBroker(onecli);
    registerCredentialBroker(other);

    snapshotBrokerRouting('10.0.0.4', 'grp');
    expect(onecli.routed).toHaveBeenCalledWith('10.0.0.4', 'grp');
    expect(other.routed).not.toHaveBeenCalled();
  });

  it('drop fires onContainerReleased for the routed broker and clears the entry', () => {
    upsertBrokerConfig({
      brokerId: 'onecli',
      writeAuthority: 'global-admin',
      defaultRouting: { catchAll: true },
      groupOverrides: {},
      enabled: true,
    });
    const onecli = brokerWithHooks('onecli');
    registerCredentialBroker(onecli);

    snapshotBrokerRouting('10.0.0.5', 'grp');
    dropBrokerRouting('10.0.0.5');
    expect(onecli.released).toHaveBeenCalledWith('10.0.0.5');
    expect(getBrokerRouting('10.0.0.5')).toEqual([]);
    expect(hasAnyBrokerRouting()).toBe(false);
  });
});
