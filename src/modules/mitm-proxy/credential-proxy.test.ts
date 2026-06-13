import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { connect as netConnect } from 'net';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { CredentialProxy } from './credential-proxy.js';
import { asGroupScope } from './types.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, hostname: '127.0.0.1', port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Class unit tests — no server needed
// ---------------------------------------------------------------------------

describe('CredentialProxy class', () => {
  let proxy: CredentialProxy;

  beforeEach(() => {
    proxy = new CredentialProxy();
  });

  describe('shouldIntercept', () => {
    it('matches registered hostnames', () => {
      proxy._addHostRuleForTests(/^api\.anthropic\.com$/, /^\//, async () => {}, 'claude');
      proxy._addHostRuleForTests(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, async () => {}, 'claude');

      expect(proxy.shouldIntercept('api.anthropic.com')).toBe(true);
      expect(proxy.shouldIntercept('console.anthropic.com')).toBe(true);
    });

    it('does not match unregistered hostnames', () => {
      proxy._addHostRuleForTests(/^api\.anthropic\.com$/, /^\//, async () => {}, 'claude');

      expect(proxy.shouldIntercept('github.com')).toBe(false);
      expect(proxy.shouldIntercept('example.com')).toBe(false);
    });

    it('does not partial-match hostnames', () => {
      proxy._addHostRuleForTests(/^api\.anthropic\.com$/, /^\//, async () => {}, 'claude');

      expect(proxy.shouldIntercept('evil-api.anthropic.com')).toBe(false);
      expect(proxy.shouldIntercept('api.anthropic.com.evil.com')).toBe(false);
    });
  });

  describe('matchHostRule', () => {
    it('matches host + path', () => {
      proxy._addHostRuleForTests(/^api\.anthropic\.com$/, /^\//, async () => {}, 'claude');
      proxy._addHostRuleForTests(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, async () => {}, 'claude');

      expect(proxy.matchHostRule('api.anthropic.com', '/v1/messages')).not.toBeNull();
      expect(proxy.matchHostRule('console.anthropic.com', '/api/oauth/token')).not.toBeNull();
    });

    it('does not match console.anthropic.com for non-token paths', () => {
      proxy._addHostRuleForTests(/^console\.anthropic\.com$/, /^\/api\/oauth\/token/, async () => {}, 'claude');

      expect(proxy.matchHostRule('console.anthropic.com', '/dashboard')).toBeNull();
      expect(proxy.matchHostRule('console.anthropic.com', '/')).toBeNull();
    });

    it('returns null for unregistered hosts', () => {
      expect(proxy.matchHostRule('github.com', '/api/v3')).toBeNull();
    });
  });

  describe('findMatchingRule anchor specificity', () => {
    it('resolves most-specific anchor first', () => {
      // Register broad anchor (2-part suffix)
      proxy._addAnchoredRuleForTests('auth0.com', /^.*\.auth0\.com$/, /^\//, async () => {}, 'auth0-generic');
      // Register more specific anchor (exact host)
      proxy._addAnchoredRuleForTests('myco.auth0.com', /^myco\.auth0\.com$/, /^\//, async () => {}, 'auth0-myco');

      // Most specific should win
      const myco = proxy.findMatchingRule('myco.auth0.com', '/token');
      expect(myco).not.toBeNull();
      expect(myco!.providerId).toBe('auth0-myco');

      // Broader anchor catches other subdomains
      const other = proxy.findMatchingRule('other.auth0.com', '/token');
      expect(other).not.toBeNull();
      expect(other!.providerId).toBe('auth0-generic');
    });

    it('exact host takes priority over suffix', () => {
      proxy._addAnchoredRuleForTests('anthropic.com', /^.*\.anthropic\.com$/, /^\//, async () => {}, 'anthropic-broad');
      proxy._addAnchoredRuleForTests('api.anthropic.com', /^api\.anthropic\.com$/, /^\//, async () => {}, 'claude');

      const api = proxy.findMatchingRule('api.anthropic.com', '/v1/messages');
      expect(api).not.toBeNull();
      expect(api!.providerId).toBe('claude');

      const console = proxy.findMatchingRule('console.anthropic.com', '/');
      expect(console).not.toBeNull();
      expect(console!.providerId).toBe('anthropic-broad');
    });

    it('deeper subdomain matches more specific anchor', () => {
      proxy._addAnchoredRuleForTests('example.com', /\.example\.com$/, /^\//, async () => {}, 'example-broad');
      proxy._addAnchoredRuleForTests('api.example.com', /\.api\.example\.com$/, /^\//, async () => {}, 'example-api');

      // "v2.api.example.com" should match "api.example.com" anchor (more specific)
      const deep = proxy.findMatchingRule('v2.api.example.com', '/');
      expect(deep).not.toBeNull();
      expect(deep!.providerId).toBe('example-api');

      // "cdn.example.com" only matches the broad anchor
      const cdn = proxy.findMatchingRule('cdn.example.com', '/');
      expect(cdn).not.toBeNull();
      expect(cdn!.providerId).toBe('example-broad');
    });
  });

  describe('resolveScope', () => {
    it('returns null for unknown IPs', () => {
      expect(proxy.resolveScope('10.99.99.99')).toBeNull();
    });

    it('returns registered scope', () => {
      proxy.registerContainerIP('172.17.0.5', asGroupScope('test-group'));
      expect(proxy.resolveScope('172.17.0.5')).toBe('test-group');
    });

    it('normalizes IPv4-mapped IPv6', () => {
      proxy.registerContainerIP('172.17.0.6', asGroupScope('ipv6-group'));
      expect(proxy.resolveScope('::ffff:172.17.0.6')).toBe('ipv6-group');
    });
  });

  describe('unregisterContainerIP', () => {
    it('removes the mapping', () => {
      proxy.registerContainerIP('172.17.0.7', asGroupScope('temp'));
      proxy.unregisterContainerIP('172.17.0.7');
      expect(proxy.resolveScope('172.17.0.7')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy integration tests
// ---------------------------------------------------------------------------

describe('credential-proxy HTTP server', () => {
  let proxy: CredentialProxy;
  let proxyServer: import('net').Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamPath: string;

  beforeEach(async () => {
    proxy = new CredentialProxy();
    lastUpstreamHeaders = {};
    lastUpstreamPath = '';

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
  });

  it('serves /health without caller validation', async () => {
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/health',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('rejects HTTP proxy requests from unknown container IP with 403', async () => {
    // 127.0.0.1 is NOT registered as a container IP
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/v1/test`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('forwards HTTP proxy requests from known container IP', async () => {
    proxy.registerContainerIP('127.0.0.1', asGroupScope('my-group'));
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/v1/test`,
    });

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamPath).toBe('/v1/test');
  });

  it('does not inject credentials on HTTP proxy requests', async () => {
    proxy.registerContainerIP('127.0.0.1', asGroupScope('my-group'));
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/v1/test`,
      headers: { 'x-api-key': 'placeholder' },
    });

    // HTTP proxy is transparent — no credential injection
    expect(lastUpstreamHeaders['x-api-key']).toBe('placeholder');
  });

  it('survives client destroying socket mid-request', async () => {
    // Upstream that delays response so the client has time to disconnect
    const slowServer = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 200);
    });
    await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', r));
    const slowPort = (slowServer.address() as AddressInfo).port;

    proxy.registerContainerIP('127.0.0.1', asGroupScope('my-group'));
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // Connect, send partial request, then destroy
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`GET http://127.0.0.1:${slowPort}/v1/test HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      setTimeout(() => sock.destroy(), 50);
    });
    await new Promise<void>((r) => sock.on('close', r));

    // Proxy should still be alive — verify with /health
    await new Promise((r) => setTimeout(r, 300));
    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/health',
    });
    expect(res.statusCode).toBe(200);

    slowServer.close();
  });

  it('survives client destroying socket mid-response', async () => {
    // Upstream that sends a large response to ensure piping is in progress
    const bigServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(64 * 1024, 'x'));
      setTimeout(() => res.end(Buffer.alloc(64 * 1024, 'y')), 100);
    });
    await new Promise<void>((r) => bigServer.listen(0, '127.0.0.1', r));
    const bigPort = (bigServer.address() as AddressInfo).port;

    proxy.registerContainerIP('127.0.0.1', asGroupScope('my-group'));
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // Start request, destroy client as soon as we get first data
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`GET http://127.0.0.1:${bigPort}/big HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    sock.once('data', () => sock.destroy());
    await new Promise<void>((r) => sock.on('close', r));

    // Proxy should still be alive
    await new Promise((r) => setTimeout(r, 200));
    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/health',
    });
    expect(res.statusCode).toBe(200);

    bigServer.close();
  });

  it('survives upstream reset during HTTP proxy forwarding', async () => {
    // Upstream that immediately destroys the connection
    const resetServer = http.createServer((req) => {
      req.socket.destroy();
    });
    await new Promise<void>((r) => resetServer.listen(0, '127.0.0.1', r));
    const resetPort = (resetServer.address() as AddressInfo).port;

    proxy.registerContainerIP('127.0.0.1', asGroupScope('my-group'));
    proxyServer = await proxy.start({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // This will get a connection error — that's expected
    try {
      await makeRequest(proxyPort, {
        method: 'GET',
        path: `http://127.0.0.1:${resetPort}/v1/test`,
      });
    } catch {
      // connection error expected
    }

    // Proxy should still be alive
    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/health',
    });
    expect(res.statusCode).toBe(200);

    resetServer.close();
  });
});
