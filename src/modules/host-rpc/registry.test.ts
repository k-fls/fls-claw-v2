import { describe, it, expect, beforeEach } from 'vitest';

import { registerHostRpc, matchHostRpc, listHostRpcHandlers, __resetHostRpcRegistryForTests } from './registry.js';

beforeEach(() => {
  __resetHostRpcRegistryForTests();
});

describe('host-rpc registry', () => {
  it('register + match roundtrip on exact path', () => {
    const fn = async () => 'ok';
    registerHostRpc('/echo', fn);
    expect(matchHostRpc('/echo')?.handler).toBe(fn);
  });

  it('matches sub-paths under the registered prefix', () => {
    const fn = () => 0;
    registerHostRpc('/ssh', fn);
    expect(matchHostRpc('/ssh')?.handler).toBe(fn);
    expect(matchHostRpc('/ssh/connect')?.handler).toBe(fn);
    expect(matchHostRpc('/ssh/connections')?.handler).toBe(fn);
    expect(matchHostRpc('/ssh/a/b/c')?.handler).toBe(fn);
  });

  it('does not match across path-segment boundaries', () => {
    registerHostRpc('/ssh', () => 0);
    expect(matchHostRpc('/sshd')).toBeUndefined();
    expect(matchHostRpc('/ssh-other')).toBeUndefined();
  });

  it('longest-prefix wins when multiple match', () => {
    const a = () => 'a';
    const b = () => 'b';
    registerHostRpc('/api', a);
    registerHostRpc('/api/v2', b);
    expect(matchHostRpc('/api/v2/things')?.handler).toBe(b);
    expect(matchHostRpc('/api/v1/things')?.handler).toBe(a);
  });

  it('root "/" matches everything', () => {
    const fn = () => 1;
    registerHostRpc('/', fn);
    expect(matchHostRpc('/anything/at/all')?.handler).toBe(fn);
  });

  it('unknown path returns undefined', () => {
    expect(matchHostRpc('/nope')).toBeUndefined();
  });

  it('listHostRpcHandlers reflects registered prefixes', () => {
    registerHostRpc('/a', () => 0);
    registerHostRpc('/b/c', () => 0);
    expect(new Set(listHostRpcHandlers())).toEqual(new Set(['/a', '/b/c']));
  });

  it('re-registering the same prefix overwrites', () => {
    const first = () => 1;
    const second = () => 2;
    registerHostRpc('/x', first);
    registerHostRpc('/x', second);
    expect(matchHostRpc('/x')?.handler).toBe(second);
  });

  it('trailing slash on registration is normalized', () => {
    const fn = () => 1;
    registerHostRpc('/x/', fn);
    expect(matchHostRpc('/x')?.handler).toBe(fn);
    expect(matchHostRpc('/x/y')?.handler).toBe(fn);
  });

  it.each([[''], ['foo'], ['/has space'], ['/has?query']])('rejects invalid prefix %j', (prefix) => {
    expect(() => registerHostRpc(prefix, () => 0)).toThrow(/invalid host-rpc prefix/i);
  });

  it.each([['/'], ['/foo'], ['/foo/bar'], ['/with-dash'], ['/with_under'], ['/with.dots']])(
    'accepts valid prefix %j',
    (prefix) => {
      expect(() => registerHostRpc(prefix, () => 0)).not.toThrow();
    },
  );
});
