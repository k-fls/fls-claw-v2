import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { asGroupScope } from './types.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { proxyPipe, proxyBuffered, setUpstreamAgent } from './credential-proxy.js';

// ---------------------------------------------------------------------------
// proxyPipe / proxyBuffered — tested against a local HTTPS upstream
// ---------------------------------------------------------------------------

describe('proxy helpers', () => {
  let upstreamServer: https.Server;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamBody: string;
  let lastUpstreamPath: string;
  let upstreamResponseBody: string;
  let upstreamStatusCode: number;

  // Self-signed cert for the mock upstream
  let caDir: string;

  beforeAll(async () => {
    // Use a permissive agent so proxyPipe/proxyBuffered accept the self-signed upstream cert.
    setUpstreamAgent(new https.Agent({ rejectUnauthorized: false }));

    // Generate self-signed cert via node-forge
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
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);

    caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
    fs.writeFileSync(path.join(caDir, 'key.pem'), keyPem);
    fs.writeFileSync(path.join(caDir, 'cert.pem'), certPem);

    upstreamServer = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString();
        res.writeHead(upstreamStatusCode, {
          'content-type': 'application/json',
        });
        res.end(upstreamResponseBody);
      });
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    lastUpstreamHeaders = {};
    lastUpstreamBody = '';
    lastUpstreamPath = '';
    upstreamResponseBody = JSON.stringify({ ok: true });
    upstreamStatusCode = 200;
  });

  describe('proxyPipe', () => {
    it('injects headers and pipes body', async () => {
      const {
        statusCode,
        body,
        headers: resHeaders,
      } = await pipeRequest(
        upstreamPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json', 'x-api-key': 'fake' },
        },
        '{"prompt":"hello"}',
        (h) => {
          h['x-api-key'] = 'real-key';
        },
      );

      expect(statusCode).toBe(200);
      expect(lastUpstreamHeaders['x-api-key']).toBe('real-key');
      expect(lastUpstreamBody).toBe('{"prompt":"hello"}');
      expect(JSON.parse(body)).toEqual({ ok: true });
    });

    it('strips connection and keep-alive headers', async () => {
      await pipeRequest(
        upstreamPort,
        {
          method: 'GET',
          path: '/',
          headers: { 'keep-alive': 'timeout=5', 'x-custom': 'preserved' },
        },
        '',
        () => {},
      );

      expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
      expect(lastUpstreamHeaders['x-custom']).toBe('preserved');
    });
  });

  describe('proxyBuffered', () => {
    it('transforms request and response bodies', async () => {
      upstreamResponseBody = JSON.stringify({
        access_token: 'real-access',
        refresh_token: 'real-refresh',
        expires_in: 28800,
      });

      const { statusCode, body } = await bufferedRequest(
        upstreamPort,
        {
          method: 'POST',
          path: '/api/oauth/token',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'substitute',
        }),
        () => {},
        (reqBody) => reqBody.replace('substitute', 'real-refresh-token'),
        (resBody) => resBody.replace('real-access', 'sub-access').replace('real-refresh', 'sub-refresh'),
      );

      expect(statusCode).toBe(200);
      // Request was transformed
      expect(lastUpstreamBody).toContain('real-refresh-token');
      expect(lastUpstreamBody).not.toContain('substitute');
      // Response was transformed
      const parsed = JSON.parse(body);
      expect(parsed.access_token).toBe('sub-access');
      expect(parsed.refresh_token).toBe('sub-refresh');
    });

    it('does not transform non-2xx responses', async () => {
      upstreamStatusCode = 400;
      upstreamResponseBody = JSON.stringify({ error: 'bad_request' });

      const transformResponse = vi.fn((body: string) => 'should-not-be-called');

      const { statusCode, body } = await bufferedRequest(
        upstreamPort,
        {
          method: 'POST',
          path: '/api/oauth/token',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
        () => {},
        (b) => b,
        transformResponse,
      );

      expect(statusCode).toBe(400);
      expect(transformResponse).not.toHaveBeenCalled();
      expect(JSON.parse(body)).toEqual({ error: 'bad_request' });
    });

    it('sets correct content-length after transform', async () => {
      upstreamResponseBody = JSON.stringify({ token: 'short' });

      const { headers } = await bufferedRequest(
        upstreamPort,
        {
          method: 'POST',
          path: '/',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
        () => {},
        (b) => b,
        () => JSON.stringify({ token: 'much-longer-replacement-value-here' }),
      );

      const cl = parseInt(headers['content-length'] as string, 10);
      expect(cl).toBe(Buffer.byteLength(JSON.stringify({ token: 'much-longer-replacement-value-here' })));
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers — create an HTTP server that calls proxyPipe/proxyBuffered
// and make requests to it. Uses per-request rejectUnauthorized: false
// instead of global NODE_TLS_REJECT_UNAUTHORIZED to avoid test pollution.
// ---------------------------------------------------------------------------

function pipeRequest(
  upstreamPort: number,
  options: http.RequestOptions,
  body: string,
  injectHeaders: (headers: Record<string, string | number | string[] | undefined>) => void,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise(async (resolve, reject) => {
    const server = http.createServer((req, res) => {
      proxyPipe(req, res, '127.0.0.1', upstreamPort, injectHeaders, asGroupScope('test'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const req = http.request({ ...options, hostname: '127.0.0.1', port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        server.close();
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        });
      });
    });
    req.on('error', (err) => {
      server.close();
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function bufferedRequest(
  upstreamPort: number,
  options: http.RequestOptions,
  body: string,
  injectHeaders: (headers: Record<string, string | number | string[] | undefined>) => void,
  transformRequest: (body: string) => string,
  transformResponse: (body: string, statusCode: number) => string,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise(async (resolve, reject) => {
    const server = http.createServer((req, res) => {
      proxyBuffered(req, res, '127.0.0.1', upstreamPort, injectHeaders, transformRequest, transformResponse);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const req = http.request({ ...options, hostname: '127.0.0.1', port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        server.close();
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        });
      });
    });
    req.on('error', (err) => {
      server.close();
      reject(err);
    });
    req.write(body);
    req.end();
  });
}
