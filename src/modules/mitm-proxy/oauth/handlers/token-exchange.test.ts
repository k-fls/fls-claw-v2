/**
 * Token-exchange handler tests. The handler routes both directions
 * through `proxyBuffered` via a request transform and a response
 * transform. We mock `proxyBuffered` to capture those two transforms,
 * then drive them with controlled bodies and assert the security
 * properties:
 *
 *   request:  a substitute refresh_token is swapped for the REAL value
 *             before it reaches the provider's token endpoint.
 *   response: the REAL access/refresh tokens from the provider are
 *             captured + persisted via the resolver, and only
 *             SUBSTITUTES are returned to the container.
 *
 * `parseBody` runs for real (not mocked) so the JSON/form round-trip is
 * genuinely exercised.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialResolver } from '../../../credentials/index.js';
import { CRED_OAUTH, CRED_OAUTH_REFRESH, asGroupScope, type GroupScope } from '../../types.js';
import type { TokenSubstituteEngine } from '../../token-substitute.js';
import type { HandlerContext } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildTokenExchangeHandler } from './token-exchange.js';

// ── proxyBuffered mock: capture the two transforms ─────────────────────
const pb = vi.hoisted(() => ({
  captured: null as null | {
    transformRequest: (body: string) => string;
    transformResponse: (body: string, status: number) => string;
  },
}));

vi.mock('../../credential-proxy.js', () => ({
  proxyBuffered: async (
    _req: unknown,
    _res: unknown,
    _host: string,
    _port: number,
    _injectHeaders: (h: Record<string, unknown>) => void,
    transformRequest: (body: string) => string,
    transformResponse: (body: string, status: number) => string,
  ) => {
    pb.captured = { transformRequest, transformResponse };
  },
}));

const SCOPE: GroupScope = asGroupScope('test-group');

function provider(): OAuthProvider {
  return {
    id: 'example',
    rules: [],
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
    refreshStrategy: 'redirect',
  } as OAuthProvider;
}

function rule(): InterceptRule {
  return {
    anchor: 'api.example.com',
    pathPattern: /^\/oauth\/token$/,
    mode: 'token-exchange',
  };
}

function makeEngine(overrides: Partial<Record<keyof TokenSubstituteEngine, unknown>>): TokenSubstituteEngine {
  return {
    resolveSubstitute: vi.fn(() => null),
    getOrCreateSubstitute: vi.fn(() => null),
    ...overrides,
  } as unknown as TokenSubstituteEngine;
}

function makeCtx(engine: TokenSubstituteEngine, store: ReturnType<typeof vi.fn>): HandlerContext {
  return {
    tokenEngine: engine,
    resolverFor: () => ({ store }) as unknown as CredentialResolver,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    inFlightRefresh: new Map(),
  };
}

/** Build the handler and capture its transforms (proxyBuffered is mocked). */
async function capture(ctx: HandlerContext) {
  const handler = buildTokenExchangeHandler(provider(), rule(), ctx);
  await handler({} as never, {} as never, 'api.example.com', 443, SCOPE);
  return pb.captured!;
}

afterEach(() => {
  pb.captured = null;
  vi.clearAllMocks();
});

describe('buildTokenExchangeHandler — request transform', () => {
  it('swaps a substitute refresh_token for the real value upstream', async () => {
    const engine = makeEngine({
      resolveSubstitute: vi.fn((s: string) =>
        s === 'SUB_REFRESH' ? { realToken: 'REAL_REFRESH', mapping: {} } : null,
      ),
    });
    const { transformRequest } = await capture(makeCtx(engine, vi.fn()));

    const out = transformRequest('grant_type=refresh_token&refresh_token=SUB_REFRESH');
    const params = new URLSearchParams(out);
    expect(params.get('refresh_token')).toBe('REAL_REFRESH'); // real value sent upstream
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(out).not.toContain('SUB_REFRESH'); // substitute never reaches the token endpoint
  });

  it('leaves the body unchanged for a non-refresh grant', async () => {
    const engine = makeEngine({});
    const { transformRequest } = await capture(makeCtx(engine, vi.fn()));

    const input = 'grant_type=authorization_code&code=abc123';
    expect(transformRequest(input)).toBe(input);
    expect(engine.resolveSubstitute).not.toHaveBeenCalled();
  });
});

describe('buildTokenExchangeHandler — response transform', () => {
  it('captures + persists the real tokens and returns only substitutes to the client', async () => {
    const store = vi.fn();
    const engine = makeEngine({
      getOrCreateSubstitute: vi.fn((_pid: string, _attrs: unknown, _scope: GroupScope, path: string) =>
        path === CRED_OAUTH ? 'SUB_ACCESS' : path === CRED_OAUTH_REFRESH ? 'SUB_REFRESH' : null,
      ),
    });
    const { transformResponse } = await capture(makeCtx(engine, store));

    const upstreamBody = JSON.stringify({
      access_token: 'REAL_ACCESS',
      refresh_token: 'REAL_REFRESH',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const out = transformResponse(upstreamBody, 200);

    // Real tokens captured + persisted via the resolver.
    expect(store).toHaveBeenCalledTimes(1);
    const [, providerId, credentialId, credential] = store.mock.calls[0];
    expect(providerId).toBe('example');
    expect(credentialId).toBe(CRED_OAUTH);
    expect(credential.value).toBe('REAL_ACCESS');
    expect(credential.refresh?.value).toBe('REAL_REFRESH');
    expect(credential.expires_ts).toBeGreaterThan(Date.now());

    // Client only ever sees substitutes.
    const outParsed = JSON.parse(out);
    expect(outParsed.access_token).toBe('SUB_ACCESS');
    expect(outParsed.refresh_token).toBe('SUB_REFRESH');
    expect(outParsed.token_type).toBe('Bearer'); // untouched field preserved
    expect(out).not.toContain('REAL_ACCESS');
    expect(out).not.toContain('REAL_REFRESH');
  });

  it('passes the body through untouched when there is no access_token', async () => {
    const store = vi.fn();
    const engine = makeEngine({});
    const { transformResponse } = await capture(makeCtx(engine, store));

    const errBody = JSON.stringify({ error: 'invalid_grant' });
    expect(transformResponse(errBody, 400)).toBe(errBody);
    expect(store).not.toHaveBeenCalled();
    expect(engine.getOrCreateSubstitute).not.toHaveBeenCalled();
  });
});
