/**
 * OAuth refresh path: exchange the stored refresh token at the token
 * endpoint and persist the new credential through the resolver.
 *
 * Both read and write target the credential's OWNING scope (the grantor's
 * for a borrowed credential; the requester's own scope otherwise), so a
 * refresh heals every borrower and can't diverge from the outbound read
 * path. Reads and writes both go through the resolver directly — the engine
 * has no `store` method in v2 (credentials lifecycle lives in
 * `src/modules/credentials/`), and reading via the engine's scope resolution
 * is not owning-scope-stable once the borrower's own scope holds anything.
 *
 * Concurrent refreshes for the same (owning scope, provider) are deduped via
 * `HandlerContext.inFlightRefresh`, so a burst of in-flight requests — even
 * across several borrowers of one grantor — triggers exactly one upstream
 * exchange.
 */
import { CRED_OAUTH, asCredentialScope, extractToken } from '../../types.js';
import type { Credential, CredentialScope, GroupScope } from '../../types.js';
import { logger } from '../../logger.js';
import type { HandlerContext } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

const REFRESH_TIMEOUT_MS = 15_000;

/** Find the token endpoint URL by reconstructing it from the token-exchange rule. */
function findTokenEndpoint(provider: OAuthProvider): string | null {
  const rule = provider.rules.find((r: InterceptRule) => r.mode === 'token-exchange');
  if (!rule) return null;
  const pathSource = rule.pathPattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  return `https://${rule.anchor}${pathSource}`;
}

/**
 * Exchange the stored refresh token at the token endpoint and persist
 * the new credential. Returns true if the resolver now holds fresh
 * tokens.
 *
 * `owningScope` is the credential's owning (source) scope — the grantor's
 * scope for a borrowed credential, the requester's own scope otherwise.
 * Callers that resolve the credential through a substitute already know it
 * (`SubstituteMapping.credentialScope`) and pass it through; when omitted it
 * defaults to the requester's own scope (self-owned credential).
 *
 * Both the refresh-token read and the fresh-token write target `owningScope`,
 * and the concurrent-refresh dedup is keyed by it — so all borrowers of one
 * grantor share a single exchange and the refreshed token lands where every
 * borrower (and the grantor) reads it. Keying/writing by the *requester* scope
 * instead is the borrowed-credential 401 loop: the write never reaches the
 * scope the outbound path reads from.
 */
export function tryRefresh(
  provider: OAuthProvider,
  scope: GroupScope,
  ctx: HandlerContext,
  owningScope?: CredentialScope,
): Promise<boolean> {
  const owning = owningScope ?? asCredentialScope(scope);
  const key = `${owning}::${provider.id}`;
  const inflight = ctx.inFlightRefresh.get(key);
  if (inflight) return inflight;

  const p: Promise<boolean> = runRefresh(provider, scope, ctx, owning).finally(() => {
    // Only when still ours: the container-originated intercept path chains onto
    // this same key and may already have installed itself as the tail. Dropping
    // that tail would let a third refresh run alongside it.
    if (ctx.inFlightRefresh.get(key) === p) ctx.inFlightRefresh.delete(key);
  });
  ctx.inFlightRefresh.set(key, p);
  return p;
}

async function runRefresh(
  provider: OAuthProvider,
  scope: GroupScope,
  ctx: HandlerContext,
  owning: CredentialScope,
): Promise<boolean> {
  const tokenEndpoint = findTokenEndpoint(provider);
  if (!tokenEndpoint) return false;

  const resolver = ctx.resolverFor(scope);

  // Read the OAuth credential (and its nested refresh token) from the OWNING
  // scope directly. The engine's scope resolution prefers the requester's own
  // scope once anything is stored there, so routing reads through it would —
  // after a prior write polluted the borrower's own scope — silently flip the
  // read from grantor to borrower and never converge. Reading straight from
  // the owning scope is pollution-immune; for a self-owned credential the
  // owning scope IS the requester's own scope, so this is unchanged.
  const oauthCred = resolver.resolve(owning, provider.id, CRED_OAUTH);
  const realRefresh = oauthCred ? extractToken(oauthCred, 'refresh') : null;
  if (!realRefresh) return false;

  const authFields = oauthCred?.authFields ?? {};

  // A borrowed credential is one whose owning scope isn't the requester's own.
  // When its refresh is rejected at the token endpoint, the grantor's stored
  // credential is expired/revoked and no borrower can heal it — surface that to
  // the host so it can alert the grantor's owners.
  const borrowed = owning !== asCredentialScope(scope);
  const alertBorrowedFailure = (): void => {
    if (borrowed)
      ctx.borrowedCredentialEvents?.onBorrowedRefreshFailed({ owningScope: owning, providerId: provider.id });
  };

  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const response = await ctx.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...authFields,
        grant_type: 'refresh_token',
        refresh_token: realRefresh,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { provider: provider.id, scope, status: response.status },
        'oauth.refresh: token endpoint returned error',
      );
      alertBorrowedFailure();
      return false;
    }
    body = (await response.json()) as typeof body;
  } catch (err) {
    // Transient (network) — don't alert the grantor; the next request retries.
    logger.warn({ err, provider: provider.id, scope }, 'oauth.refresh: fetch failed');
    return false;
  }

  if (!body.access_token) {
    alertBorrowedFailure();
    return false;
  }

  const expiresTs = body.expires_in ? Date.now() + body.expires_in * 1000 : 0;

  const accessCred: Credential = {
    value: body.access_token,
    expires_ts: expiresTs,
    updated_ts: Date.now(),
    ...(Object.keys(authFields).length > 0 && { authFields }),
  };
  if (body.refresh_token) {
    accessCred.refresh = {
      value: body.refresh_token,
      expires_ts: 0,
      updated_ts: Date.now(),
    };
  } else {
    // Carry the previous refresh forward — the resolver stores the
    // whole Credential, so we must preserve the existing refresh value
    // when upstream didn't rotate it.
    if (oauthCred?.refresh) accessCred.refresh = oauthCred.refresh;
  }

  // Write through the resolver that OWNS the credential's scope, not the
  // requester's. `CachedCredentialResolver.store` hard-guards
  // `scope === ownFolder` (resolver.ts) — borrowing is read-only — so the
  // requester-scoped resolver (bound to the borrower's own folder) throws on
  // the cross-scope write that heals the grantor. `changeScope(owning)` hands
  // back the grantor-owning resolver, for which this is a self-write; for a
  // self-owned credential `owning` IS the requester scope, so it returns the
  // same resolver and nothing changes. Reads above stay on the requester's
  // resolver so the grant (`canAccess`) is still enforced on the read path.
  const owningResolver = resolver.changeScope(owning);
  try {
    owningResolver.store(owning, provider.id, CRED_OAUTH, accessCred);
  } catch (err) {
    logger.error({ err, provider: provider.id, scope, owning }, 'oauth.refresh: resolver.store failed');
    return false;
  }

  // Drop substitute → real-token caches: the engine reads through the
  // resolver on every lookup so this isn't strictly required for
  // correctness, but pruning stale refs keeps state tidy when an old
  // substitute would no longer resolve.
  ctx.tokenEngine.pruneStaleRefs(scope, provider.id);

  // The owning credential is fresh again — clear any pending expired alert.
  ctx.borrowedCredentialEvents?.onCredentialHealed({ credentialScope: owning, providerId: provider.id });

  logger.info({ provider: provider.id, scope, owning }, 'oauth.refresh: succeeded');
  return true;
}
