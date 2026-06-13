/**
 * Tests for the container-ip registry — allocate/release semantics,
 * lookup, event hooks, and pool exhaustion behavior via stubbed pool.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { asContainerScope } from './types.js';

// Stub the pool — registry.ts imports allocateIPFromPool / releaseIPToPool
// from network.ts; we drive both deterministically here.
let poolCounter = 0;
const released: string[] = [];

vi.mock('./network.js', () => ({
  allocateIPFromPool: (isFree: (ip: string) => boolean): string => {
    for (let i = 0; i < 1000; i++) {
      poolCounter++;
      const ip = `10.0.0.${poolCounter}`;
      if (isFree(ip)) return ip;
    }
    throw new Error('Pool exhausted in test stub');
  },
  releaseIPToPool: (ip: string): void => {
    released.push(ip);
  },
}));

import {
  allocateContainerIP,
  lookupContainerIP,
  lookupIPsForScope,
  onAllocate,
  onRelease,
  __resetRegistryForTests,
} from './ip-registry.js';

beforeEach(() => {
  __resetRegistryForTests();
  poolCounter = 0;
  released.length = 0;
});

describe('container-ip registry', () => {
  it('allocate records ip→scope in the map', () => {
    const scope = asContainerScope('agent-A');
    const a = allocateContainerIP(scope);
    expect(a.ip).toBe('10.0.0.1');
    expect(lookupContainerIP('10.0.0.1')).toBe(scope);
  });

  it('lookupContainerIP returns null for unknown ip', () => {
    expect(lookupContainerIP('192.0.2.1')).toBeNull();
  });

  it('release removes the registry entry and returns the IP to the pool', () => {
    const scope = asContainerScope('agent-A');
    const a = allocateContainerIP(scope);
    a.release();
    expect(lookupContainerIP(a.ip)).toBeNull();
    expect(released).toEqual(['10.0.0.1']);
  });

  it('release is idempotent — second call is a no-op', () => {
    const a = allocateContainerIP(asContainerScope('agent-A'));
    a.release();
    a.release();
    expect(released).toEqual(['10.0.0.1']);
  });

  it('lookupIPsForScope lists all IPs belonging to one scope', () => {
    const A = asContainerScope('agent-A');
    const B = asContainerScope('agent-B');
    const a1 = allocateContainerIP(A);
    const a2 = allocateContainerIP(A);
    allocateContainerIP(B);
    expect(new Set(lookupIPsForScope(A))).toEqual(new Set([a1.ip, a2.ip]));
    expect(lookupIPsForScope(B).length).toBe(1);
  });

  it('onAllocate fires synchronously on allocation', () => {
    const events: Array<[string, string]> = [];
    onAllocate((ip, scope) => events.push([ip, scope]));
    const scope = asContainerScope('agent-A');
    const a = allocateContainerIP(scope);
    expect(events).toEqual([[a.ip, scope]]);
  });

  it('onRelease fires synchronously on release', () => {
    const events: Array<[string, string]> = [];
    onRelease((ip, scope) => events.push([ip, scope]));
    const scope = asContainerScope('agent-A');
    const a = allocateContainerIP(scope);
    a.release();
    expect(events).toEqual([[a.ip, scope]]);
  });

  it('onRelease fires at most once even when release() is called twice', () => {
    const events: string[] = [];
    onRelease((ip) => events.push(ip));
    const a = allocateContainerIP(asContainerScope('agent-A'));
    a.release();
    a.release();
    expect(events).toEqual([a.ip]);
  });

  it('listener unsubscribe stops further notifications', () => {
    const events: string[] = [];
    const off = onAllocate((ip) => events.push(ip));
    allocateContainerIP(asContainerScope('agent-A'));
    off();
    allocateContainerIP(asContainerScope('agent-B'));
    expect(events.length).toBe(1);
  });

  it('listener throw is isolated — does not break allocation or other listeners', () => {
    const seen: string[] = [];
    onAllocate(() => {
      throw new Error('boom');
    });
    onAllocate((ip) => seen.push(ip));
    const a = allocateContainerIP(asContainerScope('agent-A'));
    expect(a.ip).toBe('10.0.0.1');
    expect(seen).toEqual([a.ip]);
  });
});
