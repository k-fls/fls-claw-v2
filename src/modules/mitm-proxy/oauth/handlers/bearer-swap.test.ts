/**
 * Bearer-swap handler tests. These exercise the security-critical core:
 * the substitute → real-token swap on outbound headers, and that the
 * substitute NEVER travels upstream. The real `https.request` is mocked
 * so we can capture the exact headers sent to the provider and drive the
 * upstream status (200 vs 401) + refresh-strategy branches.
 *
 * `tryRefresh` is mocked — its own logic is covered in refresh.test.ts;
 * here we only assert how bearer-swap reacts to refresh success/failure.
 */
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialResolver } from '../../../credentials/index.js';
import { asGroupScope, type Credential, type GroupScope } from '../../types.js';
import type { TokenSubstituteEngine } from '../../token-substitute.js';
import type { HandlerContext } from '../handler-context.js';
import type { CredentialTransportCodec, InterceptRule, OAuthProvider, RefreshStrategy } from '../types.js';

import { buildBearerSwapHandler } from './bearer-swap.js';
import { tryRefresh } from './refresh.js';

// ── upstream (https.request) mock ──────────────────────────────────────
const up = vi.hoisted(() => ({
  captured: null as null | { options: Record<string, unknown>; body: Buffer },
  response: null as null | {
    statusCode: number;
    headers: Record<string, unknown>;
    body: Buffer;
    mode: 'pipe' | 'events';
  },
}));

vi.mock('https', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    request: (options: Record<string, unknown>, cb: (res: unknown) => void) => {
      const chunks: Buffer[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.write = (c: unknown) => {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
        return true;
      };
      req.end = (c?: unknown) => {
        if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
        up.captured = { options, body: Buffer.concat(chunks) };
        const r = up.response!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = new EventEmitter();
        res.statusCode = r.statusCode;
        res.headers = r.headers;
        if (r.mode === 'pipe') {
          res.pipe = (dest: { end: (b: Buffer) => void }) => {
            dest.end(r.body);
            return dest;
          };
        }
        cb(res);
        if (r.mode === 'events') {
          queueMicrotask(() => {
            if (r.body.length) res.emit('data', r.body);
            res.emit('end');
          });
        }
      };
      return req;
    },
  };
});

vi.mock('./refresh.js', () => ({ tryRefresh: vi.fn() }));

const SCOPE: GroupScope = asGroupScope('test-group');

function provider(refreshStrategy: RefreshStrategy = 'redirect', extra: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: 'example',
    rules: [],
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
    refreshStrategy,
    ...extra,
  } as OAuthProvider;
}

function rule(): InterceptRule {
  return { anchor: 'api.example.com', pathPattern: /^\//, mode: 'bearer-swap' };
}

function makeEngine(overrides: Partial<Record<keyof TokenSubstituteEngine, unknown>>): TokenSubstituteEngine {
  return {
    resolveWithRestriction: vi.fn(() => null),
    resolveSubstitute: vi.fn(() => null),
    resolveCredential: vi.fn(() => null),
    ...overrides,
  } as unknown as TokenSubstituteEngine;
}

function makeCtx(engine: TokenSubstituteEngine): HandlerContext {
  return {
    tokenEngine: engine,
    resolverFor: () => ({ store: vi.fn() }) as unknown as CredentialResolver,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    inFlightRefresh: new Map(),
  };
}

// Minimal IncomingMessage/ServerResponse fakes.
function makeReq(headers: Record<string, string>, { url = '/v1/thing', method = 'GET' } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = new EventEmitter();
  req.headers = headers;
  req.url = url;
  req.method = method;
  return req;
}

function makeRes() {
  const chunks: Buffer[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = new EventEmitter();
  res.headersSent = false;
  res.statusCode = undefined;
  res.outHeaders = undefined;
  res.writeHead = (status: number, hdrs?: Record<string, unknown>) => {
    res.statusCode = status;
    res.outHeaders = hdrs;
    res.headersSent = true;
    return res;
  };
  res.write = (c: unknown) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return true;
  };
  res.end = (c?: unknown) => {
    if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    res.ended = true;
  };
  Object.defineProperty(res, 'body', {
    get: () => Buffer.concat(chunks).toString('utf8'),
  });
  return res;
}

/** Run the handler and drive the client request to completion. */
async function run(
  handler: ReturnType<typeof buildBearerSwapHandler>,
  req: ReturnType<typeof makeReq>,
  res: ReturnType<typeof makeRes>,
) {
  const p = handler(req as never, res as never, 'api.example.com', 443, SCOPE);
  req.emit('end');
  await p;
}

const entry = (realToken: string, credentialPath = 'oauth') => ({
  realToken,
  mapping: {
    providerId: 'example',
    credentialPath,
    scopeAttrs: {},
    credentialScope: 'cs',
  },
});

afterEach(() => {
  up.captured = null;
  up.response = null;
  vi.clearAllMocks();
});

describe('buildBearerSwapHandler — outbound swap', () => {
  it('swaps the substitute for the real token upstream and never leaks the substitute', async () => {
    const SUB = 'sk-SUBSTITUTE-aaaa';
    const REAL = 'sk-REALTOKEN-9999';
    const engine = makeEngine({
      resolveWithRestriction: vi.fn((cand: string) => (cand === SUB ? entry(REAL) : null)),
    });
    up.response = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ok":true}'),
      mode: 'pipe',
    };

    const req = makeReq({ authorization: `Bearer ${SUB}`, 'x-plain': 'keepme' });
    const res = makeRes();
    await run(buildBearerSwapHandler(provider(), rule(), makeCtx(engine)), req, res);

    const h = up.captured!.options.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${REAL}`); // swapped
    expect(h['x-plain']).toBe('keepme'); // non-credential header untouched
    expect(h.host).toBe('api.example.com'); // host rewritten to target
    expect(JSON.stringify(h)).not.toContain(SUB); // substitute never goes upstream
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}'); // upstream body piped to client
  });

  it('bound-domain guard: forwards the substitute unswapped when the request host is outside the credential bound domain', async () => {
    const SUB = 'sk-SUBSTITUTE-aaaa';
    const REAL = 'sk-REALTOKEN-9999';
    const engine = makeEngine({
      // Credential was sourced at evil.com; request targets api.example.com.
      // boundDomain rides on the resolution result.
      resolveWithRestriction: vi.fn((cand: string) =>
        cand === SUB ? { ...entry(REAL), boundDomain: 'evil.com' } : null,
      ),
    });
    up.response = {
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
      mode: 'pipe',
    };

    const req = makeReq({ authorization: `Bearer ${SUB}` });
    const res = makeRes();
    await run(buildBearerSwapHandler(provider(), rule(), makeCtx(engine)), req, res);

    const h = up.captured!.options.headers as Record<string, string>;
    // Real token NOT injected; the (useless) substitute is forwarded as-is.
    expect(h.authorization).toBe(`Bearer ${SUB}`);
    expect(JSON.stringify(h)).not.toContain(REAL);
  });

  it('bound-domain guard: swaps when the request host shares the credential bound registrable domain', async () => {
    const SUB = 'sk-SUBSTITUTE-aaaa';
    const REAL = 'sk-REALTOKEN-9999';
    const engine = makeEngine({
      // Sourced at auth.example.com; request targets api.example.com — same
      // registrable domain (example.com), so the swap is allowed.
      resolveWithRestriction: vi.fn((cand: string) =>
        cand === SUB ? { ...entry(REAL), boundDomain: 'auth.example.com' } : null,
      ),
    });
    up.response = {
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
      mode: 'pipe',
    };

    const req = makeReq({ authorization: `Bearer ${SUB}` });
    const res = makeRes();
    await run(buildBearerSwapHandler(provider(), rule(), makeCtx(engine)), req, res);

    const h = up.captured!.options.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${REAL}`);
  });

  it('leaves a header whose value is not a known substitute unchanged', async () => {
    const engine = makeEngine({ resolveWithRestriction: vi.fn(() => null) });
    up.response = {
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
      mode: 'pipe',
    };

    const req = makeReq({ authorization: 'Bearer not-a-substitute' });
    const res = makeRes();
    await run(buildBearerSwapHandler(provider(), rule(), makeCtx(engine)), req, res);

    const h = up.captured!.options.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer not-a-substitute');
  });

  it('decodes a Basic-auth base64 substitute, swaps it, and re-encodes the real token', async () => {
    const SUB = 'token-substitute-1234';
    const REAL = 'token-realvalue-5678';
    const basicSub = Buffer.from(SUB, 'utf8').toString('base64');
    const engine = makeEngine({
      resolveWithRestriction: vi.fn((cand: string) => (cand === SUB ? entry(REAL) : null)),
      resolveCredential: vi.fn(() => ({
        value: REAL,
        expires_ts: 0,
        updated_ts: 0,
      })) as unknown,
    });
    up.response = {
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
      mode: 'pipe',
    };

    const prov = provider('redirect', {
      credentialFormat: { oauth: { encode: 'base64' } },
    } as Partial<OAuthProvider>);
    const req = makeReq({ authorization: `Basic ${basicSub}` });
    const res = makeRes();
    await run(buildBearerSwapHandler(prov, rule(), makeCtx(engine)), req, res);

    const h = up.captured!.options.headers as Record<string, string>;
    expect(h.authorization).toBe(`Basic ${Buffer.from(REAL, 'utf8').toString('base64')}`);
    expect(h.authorization).not.toContain(basicSub);
  });

  it('uses a provider transport codec to swap a substitute carried in git-HTTPS Basic auth', async () => {
    // GitHub-shaped codec: the PAT is the password half of base64("<user>:<pat>"),
    // and on encode the provider supplies its own canonical username.
    const gitBasicCodec: CredentialTransportCodec = {
      fromTransport(value, ctx) {
        if (ctx.scheme && /^basic$/i.test(ctx.scheme)) {
          const decoded = Buffer.from(value.slice(ctx.scheme.length + 1).trim(), 'base64').toString('utf8');
          const c = decoded.indexOf(':');
          return c === -1 ? null : decoded.slice(c + 1);
        }
        return ctx.scheme ? value.slice(ctx.scheme.length + 1).trim() : value.trim();
      },
      toTransport(token, ctx) {
        if (ctx.scheme && /^basic$/i.test(ctx.scheme)) {
          return 'Basic ' + Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
        }
        return ctx.scheme ? `${ctx.scheme} ${token}` : token;
      },
    };

    const SUB = 'ghp-SUBSTITUTE-aaaa';
    const REAL = 'ghp-REALTOKEN-9999';
    // What git puts on the wire: base64("<arbitrary-user>:<substitute>").
    const wireSub = Buffer.from(`gituser:${SUB}`, 'utf8').toString('base64');
    const engine = makeEngine({
      resolveWithRestriction: vi.fn((cand: string) => (cand === SUB ? entry(REAL) : null)),
    });
    up.response = { statusCode: 200, headers: {}, body: Buffer.from('ok'), mode: 'pipe' };

    const prov = provider('redirect', { transportCodec: gitBasicCodec } as Partial<OAuthProvider>);
    const req = makeReq({ authorization: `Basic ${wireSub}` });
    const res = makeRes();
    await run(buildBearerSwapHandler(prov, rule(), makeCtx(engine)), req, res);

    const h = up.captured!.options.headers as Record<string, string>;
    // Swapped to the real PAT, re-wrapped with the provider's canonical username.
    expect(h.authorization).toBe('Basic ' + Buffer.from(`x-access-token:${REAL}`, 'utf8').toString('base64'));
    // Neither the bare substitute nor its on-wire form leaks upstream.
    expect(JSON.stringify(h)).not.toContain(SUB);
    expect(JSON.stringify(h)).not.toContain(wireSub);
  });
});

describe('buildBearerSwapHandler — 401 refresh strategies', () => {
  const refreshableEngine = (REAL: string, SUB: string) =>
    makeEngine({
      resolveWithRestriction: vi.fn((cand: string) => (cand === SUB ? entry(REAL) : null)),
      resolveCredential: vi.fn(() => ({
        value: REAL,
        expires_ts: 0, // 0 ⇒ not near-expiry ⇒ no proactive refresh
        updated_ts: 0,
        refresh: { value: 'R', expires_ts: 0, updated_ts: 0 },
      })) as unknown,
    });

  it('redirect strategy: on 401 with a refreshable cred, refreshes then 307s to the same URL', async () => {
    vi.mocked(tryRefresh).mockResolvedValue(true);
    up.response = {
      statusCode: 401,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('unauthorized'),
      mode: 'events',
    };
    const req = makeReq({ authorization: 'Bearer SUB' });
    const res = makeRes();
    await run(
      buildBearerSwapHandler(provider('redirect'), rule(), makeCtx(refreshableEngine('REAL', 'SUB'))),
      req,
      res,
    );

    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(307);
    expect((res.outHeaders as Record<string, string>).location).toBe('https://api.example.com/v1/thing');
  });

  it('passthrough strategy: on 401, refreshes then forwards the 401 (next request gets the new sub)', async () => {
    vi.mocked(tryRefresh).mockResolvedValue(true);
    up.response = {
      statusCode: 401,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('unauthorized'),
      mode: 'events',
    };
    const req = makeReq({ authorization: 'Bearer SUB' });
    const res = makeRes();
    await run(
      buildBearerSwapHandler(provider('passthrough'), rule(), makeCtx(refreshableEngine('REAL', 'SUB'))),
      req,
      res,
    );

    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('unauthorized');
  });

  it('does not attempt a refresh when no swapped credential is refreshable', async () => {
    const engine = makeEngine({
      resolveWithRestriction: vi.fn((cand: string) => (cand === 'SUB' ? entry('REAL') : null)),
      resolveCredential: vi.fn(() => ({
        value: 'REAL',
        expires_ts: 0,
        updated_ts: 0, // no `refresh` ⇒ not refreshable
      })) as unknown,
    });
    up.response = {
      statusCode: 401,
      headers: {},
      body: Buffer.from('nope'),
      mode: 'events',
    };
    const req = makeReq({ authorization: 'Bearer SUB' });
    const res = makeRes();
    await run(buildBearerSwapHandler(provider('redirect'), rule(), makeCtx(engine)), req, res);

    expect(tryRefresh).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401); // forwarded unmodified
    expect(res.body).toBe('nope');
  });
});
