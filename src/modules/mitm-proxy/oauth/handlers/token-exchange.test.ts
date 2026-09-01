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
import {
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
  asCredentialScope,
  asGroupScope,
  type CredentialScope,
  type GroupScope,
} from '../../types.js';
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

function provider(over: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: 'example',
    rules: [],
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
    refreshStrategy: 'redirect',
    ...over,
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
    getSubstitute: vi.fn(() => null),
    ...overrides,
  } as unknown as TokenSubstituteEngine;
}

/**
 * `resolverFor(s)` returns a per-scope resolver owning scope `s`, and each
 * enforces the production `CachedCredentialResolver.store` guard: a write whose
 * target scope isn't the resolver's own scope THROWS (borrowing is read-only,
 * resolver.ts). This is what makes the borrowed-refresh test meaningful — the
 * handler must write through the resolver owning the *target* (grantor) scope,
 * not the requester's, or the guarded store throws exactly as in production.
 * The shared `store` spy still records every persisted write for assertions.
 */
function makeCtx(engine: TokenSubstituteEngine, store: ReturnType<typeof vi.fn>): HandlerContext {
  const resolvers = new Map<string, CredentialResolver>();
  const resolverFor = (rscope: GroupScope): CredentialResolver => {
    const own = rscope as string;
    let r = resolvers.get(own);
    if (!r) {
      r = {
        store: (scope: CredentialScope, ...rest: unknown[]) => {
          if ((scope as string) !== own) {
            throw new Error(`resolver.store: cannot write under scope '${scope}' from resolver owning '${own}'`);
          }
          (store as (...a: unknown[]) => unknown)(scope, ...rest);
        },
        // Mirror the real registry: hand back the resolver owning `s`.
        changeScope: (s: CredentialScope) => resolverFor(s as unknown as GroupScope),
      } as unknown as CredentialResolver;
      resolvers.set(own, r);
    }
    return r;
  };
  return {
    tokenEngine: engine,
    resolverFor,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    inFlightRefresh: new Map(),
  };
}

/** Build the handler and capture its transforms (proxyBuffered is mocked). */
async function capture(ctx: HandlerContext, over: Partial<OAuthProvider> = {}) {
  const handler = buildTokenExchangeHandler(provider(over), rule(), ctx);
  await handler({} as never, {} as never, 'api.example.com', 443, SCOPE, '172.29.0.9');
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

  it('a refresh of a borrowed credential stores to the owning (grantor) scope, not the borrower', async () => {
    const GRANTOR: CredentialScope = asCredentialScope('grantor-group');
    const store = vi.fn();
    const engine = makeEngine({
      // The swapped refresh substitute is bound to the grantor's scope.
      resolveSubstitute: vi.fn((s: string) =>
        s === 'SUB_REFRESH' ? { realToken: 'REAL_GRANTOR_REFRESH', mapping: { credentialScope: GRANTOR } } : null,
      ),
      getOrCreateSubstitute: vi.fn((_pid: string, _attrs: unknown, _scope: GroupScope, path: string) =>
        path === CRED_OAUTH ? 'SUB_ACCESS' : path === CRED_OAUTH_REFRESH ? 'SUB_REFRESH' : null,
      ),
    });
    const { transformRequest, transformResponse } = await capture(makeCtx(engine, store));

    // Request carries the grantor-bound refresh substitute — captures the source scope.
    transformRequest('grant_type=refresh_token&refresh_token=SUB_REFRESH');
    transformResponse(
      JSON.stringify({ access_token: 'FRESH_ACCESS', refresh_token: 'FRESH_REFRESH', expires_in: 3600 }),
      200,
    );

    // Regression: the write must go through the resolver OWNING the grantor
    // scope. Writing via the requester's resolver (bound to the borrower's own
    // scope) trips the guard in the mock above and throws in transformResponse,
    // exactly as the real resolver would — never silently healing the borrower.
    expect(store).toHaveBeenCalledTimes(1);
    const [scope, , credentialId, credential] = store.mock.calls[0];
    expect(scope).toBe(GRANTOR); // healed at the grantor, where every borrower reads it
    expect(credentialId).toBe(CRED_OAUTH);
    expect(credential.value).toBe('FRESH_ACCESS');
  });

  it('a fresh auth (authorization_code) stores to the requester own scope — a direct write shadows the grantor', async () => {
    const store = vi.fn();
    const engine = makeEngine({
      getOrCreateSubstitute: vi.fn((_pid: string, _attrs: unknown, _scope: GroupScope, path: string) =>
        path === CRED_OAUTH ? 'SUB_ACCESS' : null,
      ),
    });
    const { transformRequest, transformResponse } = await capture(makeCtx(engine, store));

    // No refresh substitute is swapped for an authorization_code grant, so no
    // source scope is captured → the fresh credential lands in the own scope.
    transformRequest('grant_type=authorization_code&code=abc123');
    transformResponse(JSON.stringify({ access_token: 'FRESH_ACCESS', expires_in: 3600 }), 200);

    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toBe(asCredentialScope(SCOPE)); // own scope, not a grantor
  });

  // A provider whose token response carries more than access/refresh — an
  // identity token and an account identifier — used to hand both to the
  // container in the clear, along with every claim inside the identity token.
  it('substitutes every credential-bearing field the provider declares, not just the two', async () => {
    const store = vi.fn();
    const engine = makeEngine({
      getOrCreateSubstitute: vi.fn(
        (_pid: string, _attrs: unknown, _scope: GroupScope, path: string) => `SUB_${path.toUpperCase()}`,
      ),
    });
    const { transformResponse } = await capture(makeCtx(engine, store), {
      credentialResponseFields: [
        { field: 'id_token', credentialPath: 'id_token' },
        { field: 'account_id', credentialPath: 'account_id' },
      ],
    });

    const REAL_ID = 'header.eyJlbWFpbCI6InBlcnNvbkBleGFtcGxlLmNvbSJ9.sig';
    const out = transformResponse(
      JSON.stringify({
        access_token: 'REAL_ACCESS',
        refresh_token: 'REAL_REFRESH',
        id_token: REAL_ID,
        account_id: 'REAL_ACCOUNT',
        expires_in: 3600,
      }),
      200,
    );

    // Nothing real reaches the container.
    expect(out).not.toContain('REAL_ACCESS');
    expect(out).not.toContain('REAL_REFRESH');
    expect(out).not.toContain(REAL_ID);
    expect(out).not.toContain('REAL_ACCOUNT');

    const parsed = JSON.parse(out);
    expect(parsed.id_token).toBe('SUB_ID_TOKEN');
    expect(parsed.account_id).toBe('SUB_ACCOUNT_ID');

    // Each declared field's real value is persisted, so its substitute resolves.
    const stored = Object.fromEntries(store.mock.calls.map((c) => [c[2], c[3].value]));
    expect(stored['id_token']).toBe(REAL_ID);
    expect(stored['account_id']).toBe('REAL_ACCOUNT');
  });

  it('blanks a declared field rather than leaking it when no substitute can be minted', async () => {
    const store = vi.fn();
    const engine = makeEngine({
      getOrCreateSubstitute: vi.fn((_pid: string, _attrs: unknown, _scope: GroupScope, path: string) =>
        path === 'id_token' ? null : `SUB_${path.toUpperCase()}`,
      ),
    });
    const { transformResponse } = await capture(makeCtx(engine, store), {
      credentialResponseFields: [{ field: 'id_token', credentialPath: 'id_token' }],
    });

    const out = transformResponse(
      JSON.stringify({ access_token: 'REAL_ACCESS', id_token: 'REAL_ID', expires_in: 3600 }),
      200,
    );

    expect(out).not.toContain('REAL_ID');
    expect(JSON.parse(out).id_token).toBe('');
  });

  it('leaves a provider that declares no extra fields exactly as before', async () => {
    const store = vi.fn();
    const engine = makeEngine({
      getOrCreateSubstitute: vi.fn(() => 'SUB'),
    });
    const { transformResponse } = await capture(makeCtx(engine, store));

    const out = transformResponse(JSON.stringify({ access_token: 'REAL_ACCESS', id_token: 'PASSTHROUGH' }), 200);

    // Unchanged behaviour: an undeclared field is not touched.
    expect(JSON.parse(out).id_token).toBe('PASSTHROUGH');
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

describe('buildTokenExchangeHandler — derived credentials', () => {
  /** A JWT in shape only, carrying `claims` a provider can derive from. */
  function jwt(claims: Record<string, unknown>): string {
    const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${seg({ alg: 'RS256' })}.${seg(claims)}.sig`;
  }

  // Derivation reads a credential out of ANOTHER field's contents, and that
  // field is itself substituted on the way back. Reading the post-substitution
  // fields decodes the synthetic token instead of upstream's, so nothing is
  // derived — which left the spawn contribution one value short and, finding it
  // missing, silently declined to write the container's auth file at all.
  it('derives from upstream values, not from the substitutes already swapped in', async () => {
    const store = vi.fn();
    const engine = makeEngine({ getOrCreateSubstitute: vi.fn(() => jwt({ exp: 1 })) });

    const { transformResponse } = await capture(makeCtx(engine, store), {
      credentialResponseFields: [{ field: 'id_token', credentialPath: 'id_token' }],
      deriveCredentials: (fields): Record<string, string> => {
        const claims = JSON.parse(Buffer.from(String(fields.id_token).split('.')[1], 'base64url').toString()) as {
          'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
        };
        const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        return account ? { account_id: account } : {};
      },
    });

    transformResponse(
      JSON.stringify({
        access_token: 'REAL_ACCESS',
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } }),
      }),
      200,
    );

    const derived = store.mock.calls.find((c) => c[2] === 'account_id');
    expect(derived?.[3].value).toBe('acct-42');
  });
});
