/**
 * Credential broker registry.
 *
 * Verifies registration semantics (warn-and-overwrite on duplicate id, unlike
 * the provider registry which throws), priority-ascending ordering with a
 * registration-order tiebreak, and the cheap `hasCredentialBrokers` gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CredentialBroker,
  _resetBrokerRegistryForTests,
  getCredentialBroker,
  getCredentialBrokers,
  hasCredentialBrokers,
  registerCredentialBroker,
} from './broker-registry.js';

const stub = (id: string, priority?: number): CredentialBroker => ({
  id,
  ...(priority !== undefined && { priority }),
  tryForward: async () => {},
});

afterEach(() => {
  _resetBrokerRegistryForTests();
  vi.restoreAllMocks();
});

describe('broker registry', () => {
  it('starts empty', () => {
    expect(hasCredentialBrokers()).toBe(false);
    expect(getCredentialBrokers()).toEqual([]);
  });

  it('registers and reports presence', () => {
    registerCredentialBroker(stub('onecli'));
    expect(hasCredentialBrokers()).toBe(true);
    expect(getCredentialBrokers().map((b) => b.id)).toEqual(['onecli']);
  });

  it('looks up a broker by id (delegation names one)', () => {
    const b = stub('onecli');
    registerCredentialBroker(b);
    expect(getCredentialBroker('onecli')).toBe(b);
    expect(getCredentialBroker('nope')).toBeUndefined();
  });

  it('orders by ascending priority (default 0)', () => {
    registerCredentialBroker(stub('hi', 100));
    registerCredentialBroker(stub('lo', -5));
    registerCredentialBroker(stub('mid')); // default 0
    expect(getCredentialBrokers().map((b) => b.id)).toEqual(['lo', 'mid', 'hi']);
  });

  it('breaks priority ties by registration order', () => {
    registerCredentialBroker(stub('a', 10));
    registerCredentialBroker(stub('b', 10));
    registerCredentialBroker(stub('c', 10));
    expect(getCredentialBrokers().map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('warn-and-overwrites a duplicate id (does not throw, unlike providers)', () => {
    const first = stub('onecli', 1);
    const second = stub('onecli', 2);
    registerCredentialBroker(first);
    expect(() => registerCredentialBroker(second)).not.toThrow();
    const all = getCredentialBrokers();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(second);
  });

  it('a re-register moves the broker to the back of its priority band', () => {
    registerCredentialBroker(stub('x', 0));
    registerCredentialBroker(stub('y', 0));
    // Re-register x → fresh seq → now ordered after y.
    registerCredentialBroker(stub('x', 0));
    expect(getCredentialBrokers().map((b) => b.id)).toEqual(['y', 'x']);
  });

  it('reset clears everything', () => {
    registerCredentialBroker(stub('a'));
    _resetBrokerRegistryForTests();
    expect(hasCredentialBrokers()).toBe(false);
    expect(getCredentialBrokers()).toEqual([]);
  });
});
