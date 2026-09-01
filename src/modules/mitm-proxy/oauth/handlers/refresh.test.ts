/**
 * Unit tests for the refresh path. We exercise it directly (not via
 * the bearer-swap handler) because the refresh exchange is pure — it
 * just needs a resolver that returns canned credentials per scope and
 * captures the write.
 *
 * The refresh reads AND writes at the credential's *owning* scope (the
 * grantor's, for a borrowed credential), so the resolver mock is keyed by
 * scope. Borrowed-credential tests seed the grantor scope and pass its scope
 * as `owningScope`.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CredentialResolver } from '../../../credentials/index.js';
import {
  CRED_OAUTH,
  asCredentialScope,
  asGroupScope,
  type Credential,
  type CredentialScope,
  type GroupScope,
} from '../../types.js';
import type { TokenSubstituteEngine } from '../../token-substitute.js';
import type { HandlerContext } from '../handler-context.js';
import type { OAuthProvider } from '../types.js';

import { tryRefresh } from './refresh.js';

const SCOPE: GroupScope = asGroupScope('test-group');
const OWN: CredentialScope = asCredentialScope(SCOPE);
const GRANTOR: CredentialScope = asCredentialScope('grantor-group');

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

/**
 * `resolverFor(s)` returns a **per-scope** resolver owning scope `s`, mirroring
 * the production factory (`getOrCreateResolverForAgentGroup`, which binds one
 * resolver to each agent-group folder). Crucially, each resolver enforces the
 * same guard as the real `CachedCredentialResolver.store` (resolver.ts): a
 * write whose target scope isn't the resolver's own scope **throws** — because
 * borrowing is read-only. Reads are cross-scope permitted (the grant), so
 * `resolve` ignores the guard.
 *
 * This is what makes the borrowed-credential tests meaningful: a fix that
 * writes through the *requester's* resolver (bound to the borrower's folder)
 * would throw here on the cross-scope store, exactly as it does in production —
 * so the tests fail against that bug instead of passing against a guardless
 * mock.
 *
 * `store` is a single shared spy recording every store across all resolvers
 * (so `store.mock.calls[0]` reads the same as before); `storeCalls` additionally
 * records which resolver's own scope performed each write.
 */
function buildCtx(opts: { seed?: Array<{ scope: CredentialScope; cred: Credential }>; fetchImpl: typeof fetch }): {
  ctx: HandlerContext;
  store: ReturnType<typeof vi.fn>;
  storeCalls: Array<{ ownerScope: string; writeScope: string }>;
  read: (scope: CredentialScope) => Credential | null;
  onFailed: ReturnType<typeof vi.fn>;
  onHealed: ReturnType<typeof vi.fn>;
} {
  const byScope = new Map<string, Credential>();
  for (const { scope, cred } of opts.seed ?? []) byScope.set(scope as string, cred);

  const storeCalls: Array<{ ownerScope: string; writeScope: string }> = [];
  const store = vi.fn((scope: CredentialScope, _p: string, credId: string, cred: Credential) => {
    if (credId === CRED_OAUTH) byScope.set(scope as string, cred);
  });

  // One resolver per owning scope, memoized (idempotent, like the real registry).
  const resolvers = new Map<string, CredentialResolver>();
  const resolverFor = (rscope: GroupScope): CredentialResolver => {
    const own = rscope as string;
    let r = resolvers.get(own);
    if (!r) {
      r = {
        resolve: (scope: CredentialScope, _p: string, credId: string) =>
          credId === CRED_OAUTH ? (byScope.get(scope as string) ?? null) : null,
        store: (scope: CredentialScope, p: string, credId: string, cred: Credential) => {
          if ((scope as string) !== own) {
            throw new Error(`resolver.store: cannot write under scope '${scope}' from resolver owning '${own}'`);
          }
          storeCalls.push({ ownerScope: own, writeScope: scope as string });
          store(scope, p, credId, cred);
        },
        // Mirror the real registry: hand back the resolver owning `s`.
        changeScope: (s: CredentialScope) => resolverFor(s as unknown as GroupScope),
      } as unknown as CredentialResolver;
      resolvers.set(own, r);
    }
    return r;
  };

  const engine = { pruneStaleRefs: vi.fn() } as unknown as TokenSubstituteEngine;

  const onFailed = vi.fn();
  const onHealed = vi.fn();
  const ctx: HandlerContext = {
    tokenEngine: engine,
    resolverFor,
    fetchImpl: opts.fetchImpl,
    inFlightRefresh: new Map(),
    borrowedCredentialEvents: { onBorrowedRefreshFailed: onFailed, onCredentialHealed: onHealed },
  };
  return { ctx, store, storeCalls, read: (scope) => byScope.get(scope as string) ?? null, onFailed, onHealed };
}

function cred(value: string, refresh?: string, authFields?: Record<string, string>): Credential {
  const c: Credential = { value, expires_ts: 0, updated_ts: 0 };
  if (refresh) c.refresh = { value: refresh, expires_ts: 0, updated_ts: 0 };
  if (authFields) c.authFields = authFields;
  return c;
}

function okFetch(json: object): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => json })) as unknown as typeof fetch;
}

describe('tryRefresh — self-owned credential', () => {
  it('exchanges the refresh token and stores the new credential to its own scope', async () => {
    const fetchImpl = okFetch({ access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH', expires_in: 3600 });
    const { ctx, store } = buildCtx({
      seed: [{ scope: OWN, cred: cred('OLD_ACCESS', 'OLD_REFRESH', { client_id: 'X' }) }],
      fetchImpl,
    });

    const ok = await tryRefresh(buildProvider(), SCOPE, ctx);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
    const [scope, , , credential] = store.mock.calls[0];
    expect(scope).toBe(OWN);
    expect(credential.value).toBe('NEW_ACCESS');
    expect(credential.refresh?.value).toBe('NEW_REFRESH');
    expect(credential.authFields).toEqual({ client_id: 'X' });
  });

  it('returns false when there is no stored refresh token', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = buildCtx({ seed: [{ scope: OWN, cred: cred('OLD_ACCESS') }], fetchImpl });
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
    const { ctx, store } = buildCtx({ seed: [{ scope: OWN, cred: cred('OLD', 'OLD_REFRESH') }], fetchImpl });
    const ok = await tryRefresh(buildProvider(), SCOPE, ctx);
    expect(ok).toBe(false);
    expect(store).not.toHaveBeenCalled();
  });

  it('preserves the existing refresh token when upstream does not rotate it', async () => {
    const fetchImpl = okFetch({ access_token: 'NEW_ACCESS' }); // no refresh_token
    const { ctx, store } = buildCtx({ seed: [{ scope: OWN, cred: cred('OLD', 'PREVIOUS_REFRESH') }], fetchImpl });
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
      return { ok: true, json: async () => ({ access_token: 'NEW' }) };
    }) as unknown as typeof fetch;
    const { ctx } = buildCtx({ seed: [{ scope: OWN, cred: cred('OLD', 'OLD_REFRESH') }], fetchImpl });
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

describe('tryRefresh — borrowed credential (owningScope)', () => {
  it('reads and writes the grantor (owning) scope, never the borrower', async () => {
    const borrower: GroupScope = asGroupScope('borrower-group');
    const fetchImpl = okFetch({ access_token: 'FRESH_ACCESS', refresh_token: 'FRESH_REFRESH', expires_in: 3600 });
    // Only the grantor holds a credential; the borrower's own scope is empty.
    const { ctx, store, read } = buildCtx({
      seed: [{ scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') }],
      fetchImpl,
    });

    const ok = await tryRefresh(buildProvider(), borrower, ctx, GRANTOR);
    expect(ok).toBe(true);

    // The write landed on the grantor, so every borrower reading via the
    // substitute (→ grantor) immediately sees the fresh token.
    expect(store).toHaveBeenCalledTimes(1);
    const [scope] = store.mock.calls[0];
    expect(scope).toBe(GRANTOR);
    expect(read(GRANTOR)?.value).toBe('FRESH_ACCESS');
    // The borrower's own scope was never written.
    expect(read(asCredentialScope(borrower))).toBeNull();
    // The exchange used the grantor's refresh token.
    const [, body] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(body.body).refresh_token).toBe('GRANTOR_REFRESH');
  });

  it('refreshes the grantor even when the borrower own scope was polluted by a prior buggy write', async () => {
    const borrower: GroupScope = asGroupScope('borrower-group');
    const fetchImpl = okFetch({ access_token: 'FRESH_ACCESS', refresh_token: 'FRESH_REFRESH', expires_in: 3600 });
    const { ctx, store, read } = buildCtx({
      seed: [
        { scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') },
        // Simulate the old bug's leftover: a stale credential in the borrower scope.
        { scope: asCredentialScope(borrower), cred: cred('STALE_BORROWER_ACCESS', 'STALE_BORROWER_REFRESH') },
      ],
      fetchImpl,
    });

    const ok = await tryRefresh(buildProvider(), borrower, ctx, GRANTOR);
    expect(ok).toBe(true);
    // Read used the grantor's refresh token, not the borrower's stale one.
    const [, body] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(body.body).refresh_token).toBe('GRANTOR_REFRESH');
    // Write healed the grantor; the polluted borrower scope is left untouched.
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toBe(GRANTOR);
    expect(read(GRANTOR)?.value).toBe('FRESH_ACCESS');
    expect(read(asCredentialScope(borrower))?.value).toBe('STALE_BORROWER_ACCESS');
  });

  it('writes through the grantor-owning resolver, so the guarded cross-scope store does not throw', async () => {
    // Regression: refresh.ts used to write via `resolverFor(scope)` — the
    // requester's (borrower's) resolver — then call `.store(owning, …)`. The
    // real resolver hard-guards `scope === ownFolder`, so a borrower's refresh
    // threw and never healed the grantor. The write must go through the
    // resolver OWNING the grantor scope.
    const borrower: GroupScope = asGroupScope('borrower-group');
    const fetchImpl = okFetch({ access_token: 'FRESH_ACCESS', refresh_token: 'FRESH_REFRESH', expires_in: 3600 });
    const { ctx, storeCalls } = buildCtx({
      seed: [{ scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') }],
      fetchImpl,
    });

    const ok = await tryRefresh(buildProvider(), borrower, ctx, GRANTOR);

    expect(ok).toBe(true);
    // The store was performed by the resolver whose own scope is the grantor —
    // not the borrower's resolver (which would have thrown the guard).
    expect(storeCalls).toEqual([{ ownerScope: GRANTOR, writeScope: GRANTOR }]);
    expect(storeCalls[0].ownerScope).not.toBe(borrower as string);
  });

  it('dedups two borrowers of one grantor into a single exchange (keyed by owning scope)', async () => {
    const b1: GroupScope = asGroupScope('borrower-1');
    const b2: GroupScope = asGroupScope('borrower-2');
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return { ok: true, json: async () => ({ access_token: 'FRESH' }) };
    }) as unknown as typeof fetch;
    const { ctx } = buildCtx({
      seed: [{ scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') }],
      fetchImpl,
    });
    const provider = buildProvider();

    const results = await Promise.all([tryRefresh(provider, b1, ctx, GRANTOR), tryRefresh(provider, b2, ctx, GRANTOR)]);
    expect(results).toEqual([true, true]);
    // Both borrowers share the grantor-keyed in-flight exchange → one fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(maxInflight).toBe(1);
  });
});

describe('tryRefresh — borrowed-credential expiry events', () => {
  const borrower: GroupScope = asGroupScope('borrower-group');

  it('fires onBorrowedRefreshFailed (not onCredentialHealed) when a borrowed refresh is rejected', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const { ctx, onFailed, onHealed } = buildCtx({
      seed: [{ scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') }],
      fetchImpl,
    });
    const ok = await tryRefresh(buildProvider(), borrower, ctx, GRANTOR);
    expect(ok).toBe(false);
    expect(onFailed).toHaveBeenCalledWith({ owningScope: GRANTOR, providerId: 'example' });
    expect(onHealed).not.toHaveBeenCalled();
  });

  it('fires onBorrowedRefreshFailed when the endpoint returns no access_token', async () => {
    const fetchImpl = okFetch({ refresh_token: 'x' }); // 200 but no access_token
    const { ctx, onFailed } = buildCtx({
      seed: [{ scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') }],
      fetchImpl,
    });
    await tryRefresh(buildProvider(), borrower, ctx, GRANTOR);
    expect(onFailed).toHaveBeenCalledWith({ owningScope: GRANTOR, providerId: 'example' });
  });

  it('fires onCredentialHealed (not onBorrowedRefreshFailed) on a successful borrowed refresh', async () => {
    const fetchImpl = okFetch({ access_token: 'FRESH', refresh_token: 'FRESH_R', expires_in: 3600 });
    const { ctx, onFailed, onHealed } = buildCtx({
      seed: [{ scope: GRANTOR, cred: cred('GRANTOR_ACCESS', 'GRANTOR_REFRESH') }],
      fetchImpl,
    });
    const ok = await tryRefresh(buildProvider(), borrower, ctx, GRANTOR);
    expect(ok).toBe(true);
    expect(onHealed).toHaveBeenCalledWith({ credentialScope: GRANTOR, providerId: 'example' });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('does NOT fire onBorrowedRefreshFailed for a self-owned refresh failure', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const { ctx, onFailed } = buildCtx({
      seed: [{ scope: OWN, cred: cred('OWN_ACCESS', 'OWN_REFRESH') }],
      fetchImpl,
    });
    await tryRefresh(buildProvider(), SCOPE, ctx); // self-owned (owning defaults to own)
    expect(onFailed).not.toHaveBeenCalled();
  });
});
