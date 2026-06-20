import { describe, it, expect, beforeEach } from 'vitest';

import { asContainerScope } from '../container-bootstrap/types.js';
import {
  registerHostRpc,
  registerScopedHostRpc,
  matchHostRpc,
  listHostRpcHandlers,
  __resetHostRpcRegistryForTests,
} from './registry.js';
import type { HostRpcRequest } from './types.js';

beforeEach(() => {
  __resetHostRpcRegistryForTests();
});

// The registry stores a uniform `invoke` wrapper, not the raw handler, so
// matching is asserted by behavior (invoke routes to the registered handler)
// rather than function identity.
const REQ: HostRpcRequest = { method: 'GET', path: '/', body: undefined, callerIP: '127.0.0.1' };
const SCOPE = asContainerScope('s');
function invoke(path: string): Promise<unknown> | unknown {
  return matchHostRpc(path)?.invoke(REQ, SCOPE, 'sess');
}

describe('host-rpc registry', () => {
  it('register + match roundtrip on exact path', async () => {
    registerHostRpc('/echo', async () => 'ok');
    expect(await invoke('/echo')).toBe('ok');
  });

  it('matches sub-paths under the registered prefix', async () => {
    registerHostRpc('/ssh', () => 0);
    expect(await invoke('/ssh')).toBe(0);
    expect(await invoke('/ssh/connect')).toBe(0);
    expect(await invoke('/ssh/connections')).toBe(0);
    expect(await invoke('/ssh/a/b/c')).toBe(0);
  });

  it('does not match across path-segment boundaries', () => {
    registerHostRpc('/ssh', () => 0);
    expect(matchHostRpc('/sshd')).toBeUndefined();
    expect(matchHostRpc('/ssh-other')).toBeUndefined();
  });

  it('longest-prefix wins when multiple match', async () => {
    registerHostRpc('/api', () => 'a');
    registerHostRpc('/api/v2', () => 'b');
    expect(await invoke('/api/v2/things')).toBe('b');
    expect(await invoke('/api/v1/things')).toBe('a');
  });

  it('root "/" matches everything', async () => {
    registerHostRpc('/', () => 1);
    expect(await invoke('/anything/at/all')).toBe(1);
  });

  it('unknown path returns undefined', () => {
    expect(matchHostRpc('/nope')).toBeUndefined();
  });

  it('listHostRpcHandlers reflects registered prefixes', () => {
    registerHostRpc('/a', () => 0);
    registerHostRpc('/b/c', () => 0);
    expect(new Set(listHostRpcHandlers())).toEqual(new Set(['/a', '/b/c']));
  });

  it('re-registering the same prefix overwrites', async () => {
    registerHostRpc('/x', () => 1);
    registerHostRpc('/x', () => 2);
    expect(await invoke('/x')).toBe(2);
  });

  it('scope-only registration carries requiresSession=false; session-bound is true', () => {
    registerScopedHostRpc('/auth', () => 'scoped');
    registerHostRpc('/action', () => 'sess');
    expect(matchHostRpc('/auth')?.requiresSession).toBe(false);
    expect(matchHostRpc('/action')?.requiresSession).toBe(true);
  });

  it('trailing slash on registration is normalized', async () => {
    registerHostRpc('/x/', () => 1);
    expect(await invoke('/x')).toBe(1);
    expect(await invoke('/x/y')).toBe(1);
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
