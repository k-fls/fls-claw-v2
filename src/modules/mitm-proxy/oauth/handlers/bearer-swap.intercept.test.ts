/**
 * Bearer-swap on-the-wire intercept test (no Docker, fully local).
 *
 * Closes the seam the unit tests can't: the REAL `CredentialProxy` MITM
 * path → REAL `buildBearerSwapHandler` → REAL upstream, with the swap
 * applied on the forwarded request. Where the live-container e2e proves
 * the MITM TLS interception with a stub handler, this proves the actual
 * substitute→real-token swap reaches a real upstream and the substitute
 * never does.
 *
 * Shape:
 *   - a local HTTPS "upstream" (self-signed) echoes the Authorization
 *     header it receives;
 *   - the real proxy MITMs `localhost` (registered bearer-swap hostRule)
 *     and forwards to that upstream;
 *   - a raw CONNECT + TLS client (the proxy's "container") sends a
 *     request carrying the SUBSTITUTE;
 *   - we assert the upstream echoed back the REAL token, not the
 *     substitute.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for the duration so (a) the client
 * trusts the MITM-forged cert and (b) bearer-swap's own https.request
 * trusts the upstream's self-signed cert. Restored in afterAll.
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
import { CRED_OAUTH, DEFAULT_SUBSTITUTE_CONFIG, asGroupScope } from '../../types.js';
import type {
  Credential,
  CredentialScope,
  EngineCredentialResolver,
  GroupScope,
  SubstitutingProvider,
} from '../../types.js';
import type { HandlerContext } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildBearerSwapHandler } from './bearer-swap.js';

const SCOPE: GroupScope = asGroupScope('intercept-e2e');
const PROVIDER_ID = 'intercept-provider';
const REAL_TOKEN = 'tok_REAL_intercept_AbCdEfGhIjKlMnOpQrSt';
const CLIENT_IP = '127.0.0.1';

let tmpRoot = '';
let upstream: https.Server | null = null;
let upstreamPort = 0;
let proxy: CredentialProxy | null = null;
let proxyServer: import('net').Server | null = null;
let proxyPort = 0;
let substitute = '';
let prevTlsReject: string | undefined;

/** Resolver that hands out exactly one credential under (SCOPE, provider, oauth). */
function makeResolver(): EngineCredentialResolver & Pick<CredentialResolver, 'store'> {
  return {
    resolve(credScope: CredentialScope, providerId: string, credentialId: string): Credential | null {
      if (
        (credScope as unknown as string) === (SCOPE as unknown as string) &&
        providerId === PROVIDER_ID &&
        credentialId === CRED_OAUTH
      ) {
        return { value: REAL_TOKEN, updated_ts: Date.now() };
      }
      return null;
    },
    store() {
      /* no refresh in this test — never called */
    },
  };
}

/** Self-signed cert for the local upstream (CN=localhost). */
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

/**
 * Make an HTTPS request to `host:port` THROUGH the proxy via CONNECT,
 * then a raw TLS GET. Returns the MITM'd response status + body. Resolves
 * once the full body (per content-length) has arrived; rejects on timeout.
 */
function requestThroughProxy(
  host: string,
  port: number,
  authHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, CLIENT_IP);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('requestThroughProxy timed out'));
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
          `GET / HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${authHeader}\r\n` + `Connection: close\r\n\r\n`,
        );
      });
      let raw = Buffer.alloc(0);
      let done = false;
      const split = () => {
        const text = raw.toString('utf8');
        const sep = text.indexOf('\r\n\r\n');
        return sep < 0 ? null : { head: text.slice(0, sep), body: text.slice(sep + 4) };
      };
      const settle = (head: string, body: string) => {
        done = true;
        clearTimeout(timer);
        const statusMatch = /^HTTP\/1\.[01] (\d+)/.exec(head);
        tlsSock.destroy();
        resolve({ status: statusMatch ? parseInt(statusMatch[1], 10) : 0, body });
      };
      // Resolve as soon as the body is provably complete (terminal chunk
      // or content-length reached); `close`/`end` is the fallback.
      const tryResolve = () => {
        if (done) return;
        const parts = split();
        if (!parts) return;
        const { head, body } = parts;
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          if (!body.includes('0\r\n\r\n')) return;
          settle(head, decodeChunked(body));
        } else {
          const cl = /content-length:\s*(\d+)/i.exec(head);
          if (!cl) return;
          if (Buffer.byteLength(body, 'utf8') < parseInt(cl[1], 10)) return;
          settle(head, body.slice(0, parseInt(cl[1], 10)));
        }
      };
      const finishOnClose = () => {
        if (done) return;
        const parts = split() ?? { head: '', body: '' };
        const body = /transfer-encoding:\s*chunked/i.test(parts.head) ? decodeChunked(parts.body) : parts.body;
        settle(parts.head, body);
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

describe('bearer-swap on-the-wire intercept (real proxy → real upstream)', () => {
  beforeAll(async () => {
    prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bswap-intercept-'));

    // Local HTTPS upstream — echoes the Authorization header it received.
    const { key, cert } = makeSelfSignedCert(tmpRoot);
    upstream = https.createServer({ key, cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream!.address() as net.AddressInfo).port;

    // Token engine + provider with a REAL bearer-swap handler for localhost.
    _resetTokenEngineForTests();
    const resolver = makeResolver();
    initTokenEngine(() => resolver);

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
      refreshStrategy: 'passthrough',
    } as OAuthProvider;
    const rule: InterceptRule = {
      anchor: 'localhost',
      hostPattern: /^localhost$/,
      pathPattern: /^\//,
      mode: 'bearer-swap',
    };
    const handler = buildBearerSwapHandler(oauthProvider, rule, ctx);

    const provider: SubstitutingProvider = {
      id: PROVIDER_ID,
      buildManifest: () => [],
      onManifestWritten: () => {},
      onManifestDeleted: () => {},
      substitutes: defaultSubstitutes({
        substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
        envBindings: [{ envName: 'TOK', credentialPath: CRED_OAUTH }],
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

    // Mint the substitute the "container" will carry.
    substitute = getTokenEngine().getOrCreateSubstitute(PROVIDER_ID, {}, SCOPE, CRED_OAUTH) ?? '';
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

  it('mints a format-preserving substitute that is not the real token', () => {
    expect(substitute).not.toBe('');
    expect(substitute).not.toBe(REAL_TOKEN);
    expect(substitute.length).toBe(REAL_TOKEN.length);
    // Prefix preserved per DEFAULT_SUBSTITUTE_CONFIG.
    expect(substitute.slice(0, DEFAULT_SUBSTITUTE_CONFIG.prefixLen)).toBe(
      REAL_TOKEN.slice(0, DEFAULT_SUBSTITUTE_CONFIG.prefixLen),
    );
  });

  it('swaps the substitute for the real token on the MITM-forwarded request; upstream sees REAL, never the substitute', async () => {
    const res = await requestThroughProxy('localhost', upstreamPort, `Bearer ${substitute}`);
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as { authorization: string | null };
    // The upstream received the REAL token...
    expect(echoed.authorization).toBe(`Bearer ${REAL_TOKEN}`);
    // ...and never the substitute.
    expect(res.body).not.toContain(substitute);
  });

  it('leaves a non-substitute bearer token untouched through the proxy', async () => {
    const res = await requestThroughProxy('localhost', upstreamPort, 'Bearer not-a-substitute');
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as { authorization: string | null };
    expect(echoed.authorization).toBe('Bearer not-a-substitute');
  });
});
