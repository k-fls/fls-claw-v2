/**
 * Unit tests for the refresh path. We exercise it directly (not via
 * the bearer-swap handler) because the refresh exchange is pure — it
 * just needs an engine that returns canned values and a resolver that
 * captures the write.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CredentialResolver } from '../../../credentials/index.js';
import { CRED_OAUTH, CRED_OAUTH_REFRESH, asGroupScope, type Credential, type GroupScope } from '../../types.js';
import type { TokenSubstituteEngine } from '../../token-substitute.js';
import type { HandlerContext } from '../handler-context.js';
import type { OAuthProvider } from '../types.js';

import { tryRefresh } from './refresh.js';

const SCOPE: GroupScope = asGroupScope('test-group');

function buildProvider(): OAuthProvider {
  return {
    id: 'example',
    rules: [
      {
        anchor: 'api.example.com',
        pathPattern: /^\/oauth\/token$/,
        mode: 'token-exchange',
      },
    ],
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
    refreshStrategy: 'redirect',
  };
}

function buildCtx(opts: { oauthCred?: Credential | null; refreshToken?: string | null; fetchImpl: typeof fetch }): {
  ctx: HandlerContext;
  store: ReturnType<typeof vi.fn>;
} {
  const store = vi.fn();
  const resolver = { store } as unknown as CredentialResolver;
  const engine = {
    resolveRealToken: vi.fn((_g: GroupScope, _p: string, cp: string) =>
      cp === CRED_OAUTH_REFRESH ? (opts.refreshToken ?? null) : null,
    ),
    resolveCredential: vi.fn((_g: GroupScope, _p: string, cid: string) =>
      cid === CRED_OAUTH ? (opts.oauthCred ?? null) : null,
    ),
    pruneStaleRefs: vi.fn(),
  } as unknown as TokenSubstituteEngine;

  const ctx: HandlerContext = {
    tokenEngine: engine,
    resolverFor: () => resolver,
    fetchImpl: opts.fetchImpl,
    inFlightRefresh: new Map(),
  };
  return { ctx, store };
}

describe('tryRefresh', () => {
  it('exchanges the refresh token and stores the new credential', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'NEW_ACCESS',
        refresh_token: 'NEW_REFRESH',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;

    const { ctx, store } = buildCtx({
      refreshToken: 'OLD_REFRESH',
      oauthCred: {
        value: 'OLD_ACCESS',
        expires_ts: 0,
        updated_ts: 0,
        authFields: { client_id: 'X' },
      },
      fetchImpl,
    });

    const ok = await tryRefresh(buildProvider(), SCOPE, ctx);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, , , credential] = store.mock.calls[0];
    expect(credential.value).toBe('NEW_ACCESS');
    expect(credential.refresh?.value).toBe('NEW_REFRESH');
    expect(credential.authFields).toEqual({ client_id: 'X' });
  });

  it('returns false when there is no stored refresh token', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = buildCtx({ refreshToken: null, fetchImpl });
    const ok = await tryRefresh(buildProvider(), SCOPE, ctx);
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false when the token endpoint responds with an error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const { ctx, store } = buildCtx({
      refreshToken: 'OLD_REFRESH',
      oauthCred: { value: 'OLD', expires_ts: 0, updated_ts: 0 },
      fetchImpl,
    });
    const ok = await tryRefresh(buildProvider(), SCOPE, ctx);
    expect(ok).toBe(false);
    expect(store).not.toHaveBeenCalled();
  });

  it('preserves the existing refresh token when upstream does not rotate it', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'NEW_ACCESS' }), // no refresh_token
    })) as unknown as typeof fetch;
    const { ctx, store } = buildCtx({
      refreshToken: 'OLD_REFRESH',
      oauthCred: {
        value: 'OLD',
        expires_ts: 0,
        updated_ts: 0,
        refresh: { value: 'PREVIOUS_REFRESH', expires_ts: 0, updated_ts: 0 },
      },
      fetchImpl,
    });
    await tryRefresh(buildProvider(), SCOPE, ctx);
    const [, , , credential] = store.mock.calls[0];
    expect(credential.refresh?.value).toBe('PREVIOUS_REFRESH');
  });

  it('dedups concurrent refreshes for the same (scope, provider)', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return {
        ok: true,
        json: async () => ({ access_token: 'NEW' }),
      };
    }) as unknown as typeof fetch;
    const { ctx } = buildCtx({
      refreshToken: 'OLD',
      oauthCred: { value: 'OLD', expires_ts: 0, updated_ts: 0 },
      fetchImpl,
    });
    const provider = buildProvider();

    const results = await Promise.all([
      tryRefresh(provider, SCOPE, ctx),
      tryRefresh(provider, SCOPE, ctx),
      tryRefresh(provider, SCOPE, ctx),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(maxInflight).toBe(1);
  });
});
