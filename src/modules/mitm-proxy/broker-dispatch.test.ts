/**
 * Proxy broker dispatch resolution: resolveBrokerRoute + shouldIntercept.
 *
 * Covers overtake-by-host-pattern, overtake-by-provider-id (overrides the
 * native rule), catch-all over uncovered space (but NOT covered space), and
 * the no-routing / not-matched fall-through to native. shouldIntercept gains
 * broker hosts (catch-all + overtake patterns) without losing provider hosts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { upsertBrokerConfig, type BrokerConfig } from '../../db/broker-config.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';

import { _resetBrokerRegistryForTests, registerCredentialBroker } from './broker-registry.js';
import { _resetBrokerRoutingForTests, snapshotBrokerRouting } from './broker-routing.js';
import { CredentialProxy } from './credential-proxy.js';

const IP = '172.17.0.9';
const FOLDER = 'grp';

function config(routing: Partial<Pick<BrokerConfig, 'defaultRouting'>>): void {
  upsertBrokerConfig({
    brokerId: 'onecli',
    writeAuthority: 'global-admin',
    defaultRouting: routing.defaultRouting ?? {},
    groupOverrides: {},
    enabled: true,
  });
}

let proxy: CredentialProxy;

beforeEach(() => {
  runMigrations(initTestDb());
  _resetBrokerRegistryForTests();
  _resetBrokerRoutingForTests();
  registerCredentialBroker({ id: 'onecli', tryForward: async () => {} });
  proxy = new CredentialProxy();
  // Native provider 'claude' claims api.anthropic.com.
  proxy._addHostRuleForTests(/^api\.anthropic\.com$/, /^\//, async () => {}, 'claude');
});
afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('resolveBrokerRoute', () => {
  it('returns null when no routing snapshot for the ip', () => {
    config({ defaultRouting: { catchAll: true } }); // configured, but not snapshotted for IP
    expect(proxy.resolveBrokerRoute(IP, 'api.example.com', '/')).toBeNull();
  });

  it('catch-all routes an UNcovered host to the broker', () => {
    config({ defaultRouting: { catchAll: true } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.resolveBrokerRoute(IP, 'api.example.com', '/')?.id).toBe('onecli');
  });

  it('catch-all does NOT take a covered host (native owns it)', () => {
    config({ defaultRouting: { catchAll: true } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.resolveBrokerRoute(IP, 'api.anthropic.com', '/')).toBeNull();
  });

  it('overtake by host-pattern routes that host (covered or not)', () => {
    config({ defaultRouting: { overtake: ['api.example.com'], catchAll: false } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.resolveBrokerRoute(IP, 'api.example.com', '/')?.id).toBe('onecli');
    // a registrable suffix also matches
    expect(proxy.resolveBrokerRoute(IP, 'sub.api.example.com', '/')?.id).toBe('onecli');
  });

  it('overtake by provider-id overrides the native provider on its host', () => {
    config({ defaultRouting: { overtake: ['claude'], catchAll: false } });
    snapshotBrokerRouting(IP, FOLDER);
    // api.anthropic.com is claimed by provider 'claude' → overtaken to broker
    expect(proxy.resolveBrokerRoute(IP, 'api.anthropic.com', '/')?.id).toBe('onecli');
  });

  it('does not route a host that is neither overtaken nor catch-all', () => {
    config({ defaultRouting: { overtake: ['github'], catchAll: false } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.resolveBrokerRoute(IP, 'api.anthropic.com', '/')).toBeNull(); // claude, not github
    expect(proxy.resolveBrokerRoute(IP, 'api.example.com', '/')).toBeNull(); // uncovered, no catch-all
  });
});

describe('shouldIntercept with brokers', () => {
  it('still intercepts provider-covered hosts', () => {
    config({ defaultRouting: { catchAll: true } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.shouldIntercept('api.anthropic.com', IP)).toBe(true);
  });

  it('intercepts an uncovered host under catch-all', () => {
    config({ defaultRouting: { catchAll: true } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.shouldIntercept('api.example.com', IP)).toBe(true);
  });

  it('intercepts an overtake host-pattern even when uncovered', () => {
    config({ defaultRouting: { overtake: ['api.example.com'], catchAll: false } });
    snapshotBrokerRouting(IP, FOLDER);
    expect(proxy.shouldIntercept('api.example.com', IP)).toBe(true);
  });

  it('does not intercept an uncovered host with no broker routing', () => {
    expect(proxy.shouldIntercept('api.example.com', IP)).toBe(false);
  });
});
