/**
 * OAuth refresh path: exchange the stored refresh token at the token
 * endpoint and persist the new credential through the resolver.
 *
 * Reads through the engine (substitute-aware, scope-aware), writes
 * through the resolver directly. The engine has no `store` method in
 * v2 — credentials lifecycle lives in `src/modules/credentials/`.
 *
 * Concurrent refreshes for the same (scope, provider) are deduped via
 * `HandlerContext.inFlightRefresh`, so a burst of in-flight requests
 * triggers exactly one upstream exchange.
 */
import { CRED_OAUTH, CRED_OAUTH_REFRESH, asCredentialScope } from '../../types.js';
import type { Credential, GroupScope } from '../../types.js';
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
 * Multiple concurrent callers for the same (scope, provider) share a
 * single in-flight exchange via the context's dedup map.
 */
export function tryRefresh(provider: OAuthProvider, scope: GroupScope, ctx: HandlerContext): Promise<boolean> {
  const key = `${scope}::${provider.id}`;
  const inflight = ctx.inFlightRefresh.get(key);
  if (inflight) return inflight;

  const p = runRefresh(provider, scope, ctx).finally(() => {
    ctx.inFlightRefresh.delete(key);
  });
  ctx.inFlightRefresh.set(key, p);
  return p;
}

async function runRefresh(provider: OAuthProvider, scope: GroupScope, ctx: HandlerContext): Promise<boolean> {
  const tokenEndpoint = findTokenEndpoint(provider);
  if (!tokenEndpoint) return false;

  const realRefresh = ctx.tokenEngine.resolveRealToken(scope, provider.id, CRED_OAUTH_REFRESH);
  if (!realRefresh) return false;

  const oauthCred = ctx.tokenEngine.resolveCredential(scope, provider.id, CRED_OAUTH);
  const authFields = oauthCred?.authFields ?? {};

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
      return false;
    }
    body = (await response.json()) as typeof body;
  } catch (err) {
    logger.warn({ err, provider: provider.id, scope }, 'oauth.refresh: fetch failed');
    return false;
  }

  if (!body.access_token) return false;

  const expiresTs = body.expires_in ? Date.now() + body.expires_in * 1000 : 0;
  const ownScope = asCredentialScope(scope);
  const resolver = ctx.resolverFor(scope);

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

  try {
    resolver.store(ownScope, provider.id, CRED_OAUTH, accessCred);
  } catch (err) {
    logger.error({ err, provider: provider.id, scope }, 'oauth.refresh: resolver.store failed');
    return false;
  }

  // Drop substitute → real-token caches: the engine reads through the
  // resolver on every lookup so this isn't strictly required for
  // correctness, but pruning stale refs keeps state tidy when an old
  // substitute would no longer resolve.
  ctx.tokenEngine.pruneStaleRefs(scope, provider.id);

  logger.info({ provider: provider.id, scope }, 'oauth.refresh: succeeded');
  return true;
}
