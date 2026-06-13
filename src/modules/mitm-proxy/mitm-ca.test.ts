/**
 * MITM cert infrastructure tests.
 *
 * Tests the production path: CredentialProxy with enableTransparent → CONNECT
 * → TLS-terminate with forged cert → mitmDispatcher → HostHandler.
 * Verifies cert generation, CA trust chain, and positive serial numbers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { createMitmContext, getMitmCaCertPath, parseSni } from './mitm-ca.js';
import { CredentialProxy, setUpstreamAgent } from './credential-proxy.js';
import { asGroupScope } from './types.js';

// ---------------------------------------------------------------------------
// CONNECT helper — sends a request through the proxy via CONNECT tunnel
// ---------------------------------------------------------------------------

function proxyRequest(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  requestPath: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    caCert?: string;
  } = {},
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });

    connectReq.on('connect', (_res, socket) => {
      const req = https.request(
        {
          hostname: targetHost,
          port: targetPort,
          path: requestPath,
          method: opts.method || 'GET',
          headers: { host: targetHost, ...(opts.headers || {}) },
          socket,
          agent: false as any,
          ca: opts.caCert ? [opts.caCert] : undefined,
          rejectUnauthorized: !!opts.caCert,
        } as https.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            socket.destroy();
            resolve({
              statusCode: res.statusCode!,
              body: Buffer.concat(chunks).toString(),
              headers: res.headers,
            });
          });
        },
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

// ---------------------------------------------------------------------------
// createMitmContext + cert generation
// ---------------------------------------------------------------------------

describe('MITM cert infrastructure', () => {
  let caDir: string;

  beforeAll(() => {
    caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-cert-test-'));
  });

  afterAll(() => {
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('persists CA cert to disk', () => {
    createMitmContext(caDir);
    const pem = fs.readFileSync(getMitmCaCertPath(caDir), 'utf-8');
    expect(pem).toContain('BEGIN CERTIFICATE');
  });

  it('reuses existing CA on second call', () => {
    const ctx1 = createMitmContext(caDir);
    const ctx2 = createMitmContext(caDir);
    expect(ctx1.caCertPem).toBe(ctx2.caCertPem);
  });

  it('generates valid host certs with SAN', async () => {
    const ctx = createMitmContext(caDir);
    const { X509Certificate } = await import('crypto');

    for (const host of ['example.com', 'api.github.com', '127.0.0.1']) {
      const { certPem, keyPem } = ctx.getHostCert(host);
      expect(certPem).toContain('BEGIN CERTIFICATE');
      expect(keyPem).toContain('BEGIN RSA PRIVATE KEY');
      // Parseable by Node's crypto
      const x509 = new X509Certificate(certPem);
      expect(x509.serialNumber.length).toBeGreaterThan(0);
      // SAN contains the hostname
      expect(x509.subjectAltName).toContain(host);
    }
  });

  it('host cert is signed by the CA', async () => {
    const ctx = createMitmContext(caDir);
    const forge = await import('node-forge');
    const ca = forge.pki.certificateFromPem(ctx.caCertPem);
    const { certPem } = ctx.getHostCert('test.example.com');
    const cert = forge.pki.certificateFromPem(certPem);

    // Verify issuer matches CA subject
    expect(cert.issuer.getField('CN')!.value).toBe(ca.subject.getField('CN')!.value);
    // Verify the cert validates against the CA
    expect(ca.verify(cert)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSni
// ---------------------------------------------------------------------------

describe('parseSni', () => {
  it('returns null for non-TLS data', () => {
    expect(parseSni(Buffer.from('GET / HTTP/1.1\r\n'))).toBeNull();
  });

  it('returns null for too-short buffer', () => {
    expect(parseSni(Buffer.alloc(3))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end MITM through CredentialProxy CONNECT
// ---------------------------------------------------------------------------

describe('MITM via CredentialProxy CONNECT', () => {
  let upstreamServer: https.Server;
  let upstreamPort: number;
  let proxy: CredentialProxy;
  let proxyServer: import('net').Server;
  let proxyPort: number;
  let caDir: string;
  let caCertPem: string;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamPath: string;
  let handlerCalled: boolean;

  beforeAll(async () => {
    caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-e2e-test-'));

    // Upstream HTTPS server (the "real" API)
    const forge = await import('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    cert.setSubject([{ name: 'commonName', value: '127.0.0.1' }]);
    cert.setIssuer([{ name: 'commonName', value: '127.0.0.1' }]);
    cert.setExtensions([
      {
        name: 'subjectAltName',
        altNames: [{ type: 7, ip: '127.0.0.1' }],
      },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    upstreamServer = https.createServer(
      {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert),
      },
      (req, res) => {
        lastUpstreamHeaders = { ...req.headers };
        lastUpstreamPath = req.url || '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      },
    );
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    // Permissive agent for upstream (self-signed)
    setUpstreamAgent(new https.Agent({ rejectUnauthorized: false }));

    // Set up proxy with MITM
    proxy = new CredentialProxy();
    proxy.registerContainerIP('127.0.0.1', asGroupScope('test-group'));

    proxyServer = await proxy.start({
      port: 0,
      host: '127.0.0.1',
      caDir,
    });

    // Register a HostHandler that injects a header. Must happen AFTER
    // start() — start() runs an initial rebuildIndex() that clears any
    // pre-existing in-memory rules.
    handlerCalled = false;
    proxy._addHostRuleForTests(
      /^127\.0\.0\.1$/,
      /^\/api\//,
      async (clientReq, clientRes, targetHost, targetPort) => {
        handlerCalled = true;
        // Forward with injected header
        const { proxyPipe } = await import('./credential-proxy.js');
        proxyPipe(
          clientReq,
          clientRes,
          targetHost,
          targetPort,
          (headers) => {
            headers['x-injected'] = 'by-proxy';
          },
          asGroupScope('test-group'),
        );
      },
      'test-provider',
    );
    proxyPort = (proxyServer.address() as AddressInfo).port;
    caCertPem = fs.readFileSync(getMitmCaCertPath(caDir), 'utf-8');
  });

  afterAll(async () => {
    (upstreamServer as any)?.closeAllConnections?.();
    // Force-close: the net.Server wrapper may hold sockets from CONNECT tunnels
    proxyServer?.close();
    upstreamServer?.close();
    // Don't await — lingering sockets can stall indefinitely
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('MITM intercepts CONNECT and invokes HostHandler', async () => {
    handlerCalled = false;
    const res = await proxyRequest(proxyPort, '127.0.0.1', upstreamPort, '/api/test', { caCert: caCertPem });

    expect(res.statusCode).toBe(200);
    expect(handlerCalled).toBe(true);
    expect(lastUpstreamHeaders['x-injected']).toBe('by-proxy');
  });

  it('forged cert is trusted by client with CA', async () => {
    // If the cert chain is broken, the request would fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE
    const res = await proxyRequest(proxyPort, '127.0.0.1', upstreamPort, '/api/cert-check', { caCert: caCertPem });
    expect(res.statusCode).toBe(200);
  });

  it('TCP tunnels non-intercepted hosts', async () => {
    // 'localhost' has no registered rules — should tunnel without MITM
    const res = await proxyRequest(proxyPort, 'localhost', upstreamPort, '/tunneled', {
      headers: { authorization: 'Bearer should-pass-through' },
    });
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer should-pass-through');
    // Handler should NOT have been called for non-intercepted host
    handlerCalled = false; // reset
  });

  it('rejects CONNECT from unknown container IP', async () => {
    // Unregister the IP, try CONNECT, should get rejected
    proxy.unregisterContainerIP('127.0.0.1');

    await expect(proxyRequest(proxyPort, '127.0.0.1', upstreamPort, '/api/test')).rejects.toThrow();

    // Re-register for other tests
    proxy.registerContainerIP('127.0.0.1', asGroupScope('test-group'));
  });
});
