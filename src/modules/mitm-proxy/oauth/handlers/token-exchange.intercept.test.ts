/**
 * Token-exchange on-the-wire intercept test (no Docker, fully local).
 *
 * The companion to `bearer-swap.intercept.test.ts`, for the token
 * endpoint path. Proves the full real path through `proxyBuffered`:
 *   - request:  a substitute refresh_token is swapped for the REAL value
 *               before it reaches the (real, local) token endpoint;
 *   - response: the REAL access/refresh tokens the endpoint returns are
 *               captured + persisted via the resolver, and only
 *               SUBSTITUTES are returned to the client.
 *
 * Shape: a local HTTPS "token endpoint" upstream records the
 * refresh_token it received and returns a canned token response; the real
 * `CredentialProxy` MITMs `localhost` (token-exchange hostRule) and
 * forwards to it; a raw CONNECT + TLS client POSTs the grant carrying the
 * SUBSTITUTE; a stateful resolver lets us observe the persisted real
 * tokens. `NODE_TLS_REJECT_UNAUTHORIZED=0` for the duration (restored in
 * afterAll).
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
import { CRED_OAUTH, CRED_OAUTH_REFRESH, DEFAULT_SUBSTITUTE_CONFIG, asGroupScope } from '../../types.js';
import type {
  Credential,
  CredentialScope,
  EngineCredentialResolver,
  GroupScope,
  SubstitutingProvider,
} from '../../types.js';
import type { HandlerContext } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildTokenExchangeHandler } from './token-exchange.js';

const SCOPE: GroupScope = asGroupScope('tokex-e2e');
const PROVIDER_ID = 'tokex-provider';
const OLD_ACCESS = 'tok_OLD_access_AaBbCcDdEeFfGgHh';
const OLD_REFRESH = 'rt_OLD_refresh_IiJjKkLlMmNnOoPp';
const NEW_ACCESS = 'tok_NEW_access_QqRrSsTtUuVvWwXx';
const NEW_REFRESH = 'rt_NEW_refresh_YyZz0011223344556677';
const CLIENT_IP = '127.0.0.1';

let tmpRoot = '';
let upstream: https.Server | null = null;
let upstreamPort = 0;
let proxy: CredentialProxy | null = null;
let proxyServer: import('net').Server | null = null;
let proxyPort = 0;
let subRefresh = '';
let prevTlsReject: string | undefined;

// Stateful resolver: store() updates, resolve() reads — so the substitutes
// minted in the response transform reflect the freshly-stored tokens.
const credStore = new Map<string, Credential>();
const storeCalls: Array<{ credentialId: string; credential: Credential }> = [];
let receivedGrantType: string | null = null;
let receivedRefreshToken: string | null = null;

function key(scope: unknown, provider: string, id: string): string {
  return `${String(scope)}|${provider}|${id}`;
}

const resolver = {
  resolve(credScope: CredentialScope, providerId: string, credentialId: string): Credential | null {
    return credStore.get(key(credScope, providerId, credentialId)) ?? null;
  },
  store(credScope: CredentialScope, providerId: string, credentialId: string, credential: Credential): void {
    credStore.set(key(credScope, providerId, credentialId), credential);
    storeCalls.push({ credentialId, credential });
  },
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

/** Decode an HTTP/1.1 chunked-transfer body (ASCII payloads only). */
function decodeChunked(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(body.slice(i, nl), 16);
    if (Number.isNaN(size) || size === 0) break;
    const start = nl + 2;
    out += body.slice(start, start + size);
    i = start + size + 2;
  }
  return out;
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
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          if (!b.includes('0\r\n\r\n')) return;
          settle(head, decodeChunked(b));
        } else {
          const cl = /content-length:\s*(\d+)/i.exec(head);
          if (!cl) return;
          if (Buffer.byteLength(b, 'utf8') < parseInt(cl[1], 10)) return;
          settle(head, b.slice(0, parseInt(cl[1], 10)));
        }
      };
      const finishOnClose = () => {
        if (done) return;
        const parts = split() ?? { head: '', body: '' };
        const b = /transfer-encoding:\s*chunked/i.test(parts.head) ? decodeChunked(parts.body) : parts.body;
        settle(parts.head, b);
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

describe('token-exchange on-the-wire intercept (real proxy → real token endpoint)', () => {
  beforeAll(async () => {
    prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokex-intercept-'));

    // Local HTTPS "token endpoint" — records the refresh_token it got,
    // returns a canned token response.
    const { key: tlsKey, cert } = makeSelfSignedCert(tmpRoot);
    upstream = https.createServer({ key: tlsKey, cert }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        receivedGrantType = params.get('grant_type');
        receivedRefreshToken = params.get('refresh_token');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: NEW_ACCESS,
            refresh_token: NEW_REFRESH,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream!.address() as net.AddressInfo).port;

    // Seed the resolver with the current (old) credential — its refresh
    // sub-field is what the minted substitute resolves to.
    credStore.set(key(SCOPE, PROVIDER_ID, CRED_OAUTH), {
      value: OLD_ACCESS,
      updated_ts: Date.now(),
      refresh: { value: OLD_REFRESH, updated_ts: Date.now() },
    });

    _resetTokenEngineForTests();
    initTokenEngine(() => resolver as unknown as EngineCredentialResolver);

    const ctx: HandlerContext = {
      tokenEngine: getTokenEngine(),
      resolverFor: () => resolver as unknown as CredentialResolver,
      fetchImpl: fetch,
      inFlightRefresh: new Map(),
    };
    const oauthProvider: OAuthProvider = {
      id: PROVIDER_ID,
      rules: [],
      scopeKeys: [],
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      refreshStrategy: 'redirect',
    } as OAuthProvider;
    const rule: InterceptRule = {
      anchor: 'localhost',
      hostPattern: /^localhost$/,
      pathPattern: /^\//,
      mode: 'token-exchange',
    };
    const handler = buildTokenExchangeHandler(oauthProvider, rule, ctx);
    const provider: SubstitutingProvider = {
      id: PROVIDER_ID,
      buildManifest: () => [],
      onManifestWritten: () => {},
      onManifestDeleted: () => {},
      substitutes: defaultSubstitutes({
        substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
        envBindings: [{ envName: 'ACC', credentialPath: CRED_OAUTH }],
        hostRules: [{ hostPattern: /^localhost$/, pathPattern: /^\//, handler }],
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

    subRefresh = getTokenEngine().getOrCreateSubstitute(PROVIDER_ID, {}, SCOPE, CRED_OAUTH_REFRESH) ?? '';
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

  it('mints a format-preserving refresh-token substitute (not the real refresh token)', () => {
    expect(subRefresh).not.toBe('');
    expect(subRefresh).not.toBe(OLD_REFRESH);
    expect(subRefresh.length).toBe(OLD_REFRESH.length);
  });

  it('swaps the substitute refresh_token for the real one upstream; client gets substitutes; resolver persists the real new tokens', async () => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(subRefresh)}`;
    const res = await postThroughProxy('localhost', upstreamPort, '/token', body);
    expect(res.status).toBe(200);

    // (a) The token endpoint received the REAL old refresh token, not the substitute.
    expect(receivedGrantType).toBe('refresh_token');
    expect(receivedRefreshToken).toBe(OLD_REFRESH);
    expect(receivedRefreshToken).not.toBe(subRefresh);

    // (b) The client got substitutes — never the real new tokens.
    expect(res.body).not.toContain(NEW_ACCESS);
    expect(res.body).not.toContain(NEW_REFRESH);
    const echoed = JSON.parse(res.body) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(typeof echoed.access_token).toBe('string');
    expect(echoed.access_token).not.toBe(NEW_ACCESS);
    expect(echoed.refresh_token).not.toBe(NEW_REFRESH);
    expect(echoed.token_type).toBe('Bearer'); // untouched field preserved

    // (c) The real new tokens were captured + persisted via the resolver.
    const persisted = storeCalls.find((c) => c.credentialId === CRED_OAUTH);
    expect(persisted).toBeTruthy();
    expect(persisted!.credential.value).toBe(NEW_ACCESS);
    expect(persisted!.credential.refresh?.value).toBe(NEW_REFRESH);
  });
});
