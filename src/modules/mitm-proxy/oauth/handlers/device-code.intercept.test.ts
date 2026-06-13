/**
 * Device-code on-the-wire intercept test (no Docker, fully local).
 *
 * Proves the real path through `proxyBuffered`: a local HTTPS "device
 * authorization endpoint" returns a device-auth JSON; the real
 * `CredentialProxy` MITMs `localhost` (device-code hostRule) and forwards
 * the POST to it; a raw CONNECT + TLS client posts the grant. We assert:
 *   - the client receives the upstream body UNCHANGED (device-code is
 *     notification-only — nothing is swapped);
 *   - the handler surfaced `user_code` + the COMPLETE verification URI to
 *     the `oauthEvents` seam.
 *
 * Harness mirrors `token-exchange.intercept.test.ts`.
 */
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CredentialResolver } from '../../../credentials/index.js';
import { registerCredentialProvider, _resetProviderRegistryForTests } from '../../../credentials/providers/registry.js';
import { CredentialProxy, clearProxyInstance, setProxyInstance } from '../../credential-proxy.js';
import { defaultSubstitutes } from '../../defaults.js';
import { initTokenEngine, getTokenEngine, _resetTokenEngineForTests } from '../../token-substitute.js';
import { DEFAULT_SUBSTITUTE_CONFIG, asGroupScope } from '../../types.js';
import type { EngineCredentialResolver, GroupScope, SubstitutingProvider } from '../../types.js';
import type { HandlerContext, OAuthEvents } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildDeviceCodeHandler } from './device-code.js';

const SCOPE: GroupScope = asGroupScope('devcode-e2e');
const PROVIDER_ID = 'devcode-provider';
const CLIENT_IP = '127.0.0.1';
const USER_CODE = 'WDJB-MJHT';
const VERIFY_URI = 'https://example.com/device';
const VERIFY_URI_COMPLETE = 'https://example.com/device?user_code=WDJB-MJHT';

let tmpRoot = '';
let upstream: https.Server | null = null;
let upstreamPort = 0;
let proxy: CredentialProxy | null = null;
let proxyServer: import('net').Server | null = null;
let proxyPort = 0;
let prevTlsReject: string | undefined;

const notices: Array<{ providerId: string; userCode: string; verificationUri: string }> = [];
const oauthEvents: OAuthEvents = {
  notifyDeviceCode({ providerId, userCode, verificationUri }) {
    notices.push({ providerId, userCode, verificationUri });
  },
  beginAuthorizeStub() {
    return null;
  },
};

const resolver = {
  resolve() {
    return null;
  },
  store() {},
};

function makeSelfSignedCert(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(dir, 'up.key');
  const certPath = path.join(dir, 'up.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'pipe' },
  );
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** POST a body to `host:port`/`path` THROUGH the proxy via CONNECT + raw TLS. */
function postThroughProxy(
  host: string,
  port: number,
  reqPath: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, CLIENT_IP);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('postThroughProxy timed out'));
    }, 10_000);
    let connectBuf = '';
    const onConnect = (chunk: Buffer) => {
      connectBuf += chunk.toString('latin1');
      if (!connectBuf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onConnect);
      if (!/^HTTP\/1\.[01] 200/.test(connectBuf)) {
        clearTimeout(timer);
        sock.destroy();
        reject(new Error('CONNECT rejected: ' + connectBuf.split('\r\n')[0]));
        return;
      }
      const tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
        tlsSock.write(
          `POST ${reqPath} HTTP/1.1\r\nHost: ${host}\r\n` +
            `Content-Type: application/x-www-form-urlencoded\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n\r\n${body}`,
        );
      });
      let raw = Buffer.alloc(0);
      let done = false;
      const split = () => {
        const text = raw.toString('utf8');
        const sep = text.indexOf('\r\n\r\n');
        return sep < 0 ? null : { head: text.slice(0, sep), body: text.slice(sep + 4) };
      };
      const settle = (head: string, respBody: string) => {
        done = true;
        clearTimeout(timer);
        const statusMatch = /^HTTP\/1\.[01] (\d+)/.exec(head);
        tlsSock.destroy();
        resolve({ status: statusMatch ? parseInt(statusMatch[1], 10) : 0, body: respBody });
      };
      const tryResolve = () => {
        if (done) return;
        const parts = split();
        if (!parts) return;
        const { head, body: b } = parts;
        const cl = /content-length:\s*(\d+)/i.exec(head);
        if (!cl) return;
        if (Buffer.byteLength(b, 'utf8') < parseInt(cl[1], 10)) return;
        settle(head, b.slice(0, parseInt(cl[1], 10)));
      };
      const finishOnClose = () => {
        if (done) return;
        const parts = split() ?? { head: '', body: '' };
        settle(parts.head, parts.body);
      };
      tlsSock.on('data', (d: Buffer) => {
        raw = Buffer.concat([raw, d]);
        tryResolve();
      });
      tlsSock.on('end', finishOnClose);
      tlsSock.on('close', finishOnClose);
      tlsSock.on('error', (e) => {
        clearTimeout(timer);
        if (!done) reject(e);
      });
    };
    sock.on('data', onConnect);
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
}

describe('device-code on-the-wire intercept (real proxy → real device endpoint)', () => {
  beforeAll(async () => {
    prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devcode-intercept-'));

    const { key: tlsKey, cert } = makeSelfSignedCert(tmpRoot);
    upstream = https.createServer({ key: tlsKey, cert }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            device_code: 'dev_ABC123',
            user_code: USER_CODE,
            verification_uri: VERIFY_URI,
            verification_uri_complete: VERIFY_URI_COMPLETE,
            expires_in: 900,
            interval: 5,
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream!.address() as net.AddressInfo).port;

    _resetTokenEngineForTests();
    initTokenEngine(() => resolver as unknown as EngineCredentialResolver);

    const ctx: HandlerContext = {
      tokenEngine: getTokenEngine(),
      resolverFor: () => resolver as unknown as CredentialResolver,
      fetchImpl: fetch,
      inFlightRefresh: new Map(),
      oauthEvents,
    };
    const oauthProvider = {
      id: PROVIDER_ID,
      rules: [],
      scopeKeys: [],
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      refreshStrategy: 'redirect',
    } as unknown as OAuthProvider;
    const rule: InterceptRule = {
      anchor: 'localhost',
      hostPattern: /^localhost$/,
      pathPattern: /^\/device$/,
      mode: 'device-code',
    };
    const handler = buildDeviceCodeHandler(oauthProvider, rule, ctx);
    const provider: SubstitutingProvider = {
      id: PROVIDER_ID,
      buildManifest: () => [],
      onManifestWritten: () => {},
      onManifestDeleted: () => {},
      substitutes: defaultSubstitutes({
        substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
        envBindings: [],
        hostRules: [{ hostPattern: /^localhost$/, pathPattern: /^\/device$/, handler }],
      }),
    };
    _resetProviderRegistryForTests();
    registerCredentialProvider(provider);

    proxy = new CredentialProxy();
    setProxyInstance(proxy);
    proxy.registerContainerIP(CLIENT_IP, SCOPE);
    proxyServer = await proxy.start({
      host: '127.0.0.1',
      port: 0,
      caDir: path.join(tmpRoot, 'ca'),
    });
    proxyPort = proxy.getBoundPort();
  }, 30_000);

  afterAll(async () => {
    if (proxyServer) await new Promise<void>((r) => proxyServer!.close(() => r()));
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    clearProxyInstance();
    _resetTokenEngineForTests();
    _resetProviderRegistryForTests();
    if (prevTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsReject;
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('forwards the device-auth response unchanged and notifies the user with the code + complete URI', async () => {
    const res = await postThroughProxy('localhost', upstreamPort, '/device', 'client_id=x&scope=openid');
    expect(res.status).toBe(200);

    // (a) Body passes through untouched — device-code swaps nothing.
    const parsed = JSON.parse(res.body) as { user_code: string; device_code: string };
    expect(parsed.user_code).toBe(USER_CODE);
    expect(parsed.device_code).toBe('dev_ABC123');

    // (b) The user was notified with the user_code and the COMPLETE verify URI
    //     (verification_uri_complete preferred over verification_uri).
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      providerId: PROVIDER_ID,
      userCode: USER_CODE,
      verificationUri: VERIFY_URI_COMPLETE,
    });
  });
});
