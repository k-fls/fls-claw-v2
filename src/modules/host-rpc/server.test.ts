/**
 * Integration tests for the host-rpc HTTP server.
 *
 * The server binds a real loopback socket; tests issue real HTTP via
 * `fetch`. The container-ip registry is stubbed so 127.0.0.1 resolves
 * to a known scope (or doesn't, for the 403 case).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { asContainerScope } from '../container-bootstrap/types.js';

// network.ts shells out to docker and parses env at module load. Stub it
// so the registry can hand out arbitrary "allocated" IPs in tests.
let nextPoolValue = '127.0.0.1';
vi.mock('../container-bootstrap/network.js', () => ({
  allocateIPFromPool: () => nextPoolValue,
  releaseIPToPool: () => {},
  gatewayIP: () => '172.29.0.1',
}));

import {
  __resetRegistryForTests,
  allocateContainerIP as allocateContainerIPRaw,
} from '../container-bootstrap/ip-registry.js';
import type { ContainerScope } from '../container-bootstrap/types.js';

let testSessionCounter = 0;
function allocateContainerIP(scope: ContainerScope) {
  return allocateContainerIPRaw(scope, `test-session-${++testSessionCounter}`);
}
import { __resetHostRpcRegistryForTests, registerHostRpc } from './registry.js';
import { startHostRpcServer, stopHostRpcServer, __isHostRpcServerRunning } from './server.js';

const SCOPE = asContainerScope('test-scope');

// Pick a fresh port per test. Reusing a port across tests trips undici's
// connection pool — it caches a keep-alive socket to the prior server
// instance, then fails the next fetch when the socket is dead.
let nextPort = 27381;

async function startOnFreePort(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = nextPort++;
    try {
      await startHostRpcServer({ port, bind: '127.0.0.1' });
      return `http://127.0.0.1:${port}`;
    } catch {
      /* port in use, try next */
    }
  }
  throw new Error('No free port found for host-rpc test');
}

beforeEach(() => {
  __resetRegistryForTests();
  __resetHostRpcRegistryForTests();
  nextPoolValue = '127.0.0.1';
});

afterEach(async () => {
  await stopHostRpcServer();
});

describe('host-rpc server', () => {
  it('dispatches to the matching prefix handler with scope + request info', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();

    const seen: Array<{ method: string; path: string; body: unknown; scope: string; ip: string }> = [];
    registerHostRpc('/echo', async (req, scope) => {
      seen.push({ method: req.method, path: req.path, body: req.body, scope, ip: req.callerIP });
      return { got: req.body };
    });

    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { got: { hello: 'world' } } });
    expect(seen).toEqual([
      { method: 'POST', path: '/echo', body: { hello: 'world' }, scope: 'test-scope', ip: '127.0.0.1' },
    ]);
  });

  it('routes sub-paths to the longest-matching prefix', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();

    const sshSeen: string[] = [];
    registerHostRpc('/ssh', (req) => {
      sshSeen.push(`${req.method} ${req.path}`);
      return 'ssh';
    });

    const r1 = await fetch(`${baseUrl}/ssh/connect`, { method: 'POST', body: '{}' });
    const r2 = await fetch(`${baseUrl}/ssh/connections`, { method: 'GET' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(sshSeen).toEqual(['POST /ssh/connect', 'GET /ssh/connections']);
  });

  it('accepts any HTTP method', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();
    const methods: string[] = [];
    registerHostRpc('/m', (req) => {
      methods.push(req.method);
      return 'ok';
    });
    await fetch(`${baseUrl}/m`, { method: 'GET', headers: { Connection: 'close' } });
    await fetch(`${baseUrl}/m`, { method: 'DELETE', headers: { Connection: 'close' } });
    await fetch(`${baseUrl}/m`, {
      method: 'PUT',
      headers: { Connection: 'close', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(methods).toEqual(['GET', 'DELETE', 'PUT']);
  });

  it('rejects unknown caller IP with 403 before any handler runs', async () => {
    const baseUrl = await startOnFreePort();
    let handlerCalled = false;
    registerHostRpc('/echo', () => {
      handlerCalled = true;
      return 'should not get here';
    });

    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'unknown-caller' });
    expect(handlerCalled).toBe(false);
  });

  it('returns 404 when no prefix matches', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();

    const res = await fetch(`${baseUrl}/nope`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'no-handler' });
  });

  it('returns 400 for invalid JSON body', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();
    registerHostRpc('/echo', () => 'ok');

    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid-json' });
  });

  it('accepts empty body (undefined)', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();
    let received: unknown = 'sentinel';
    registerHostRpc('/echo', (req) => {
      received = req.body;
      return 'ok';
    });

    const res = await fetch(`${baseUrl}/echo`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(received).toBeUndefined();
  });

  it('returns 500 with error message when handler throws', async () => {
    allocateContainerIP(SCOPE);
    const baseUrl = await startOnFreePort();
    registerHostRpc('/boom', () => {
      throw new Error('handler-failed');
    });

    const res = await fetch(`${baseUrl}/boom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'handler-failed' });
  });

  it('refuses double-start', async () => {
    await startOnFreePort();
    await expect(startHostRpcServer({ port: 0, bind: '127.0.0.1' })).rejects.toThrow(/already running/i);
  });

  it('stopHostRpcServer is idempotent', async () => {
    await startOnFreePort();
    await stopHostRpcServer();
    await stopHostRpcServer();
    expect(__isHostRpcServerRunning()).toBe(false);
  });
});
