/**
 * Token-exchange handler. Sits in front of the provider's
 * `token_endpoint`:
 *
 *   request:  swap a substitute refresh_token (if present) → real value
 *   response: capture access/refresh from upstream, persist via the
 *             resolver, and return format-preserving substitutes to the
 *             container.
 *
 * Both directions go through `proxyBuffered` (the proxy's
 * buffer-both-ways primitive). Bodies may be JSON or form-encoded —
 * `parseBody` handles both transparently.
 *
 * A refresh grant is serialized per (owning scope, provider) through the same
 * `HandlerContext.inFlightRefresh` map the host-initiated helper uses. The
 * credential store is per group while containers are per session, so a group's
 * concurrent sessions share one refresh substitute; two simultaneous refreshes
 * would both send the same real token and the loser trips the provider's
 * reuse detection, invalidating the credential for the whole group.
 */
import { isAuthEpisodeContainer } from '../../../credentials/auth-bridge.js';
import { proxyBuffered } from '../../credential-proxy.js';
import type { HostHandler } from '../../credential-proxy.js';
import { logger } from '../../logger.js';
import { CRED_OAUTH, CRED_OAUTH_REFRESH, asCredentialScope } from '../../types.js';
import type { Credential, CredentialScope } from '../../types.js';
import type { HandlerContext } from '../handler-context.js';
import { parseBody } from '../oauth-interceptor.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

/** Fields excluded from auto-capture (transient or contain secrets). */
const TRANSIENT_FIELDS = new Set([
  'grant_type',
  'code',
  'code_verifier',
  'state',
  'redirect_uri',
  'refresh_token',
  'access_token',
  'token_type',
  'expires_in',
]);

function captureAuthFields(
  reqBody: Record<string, string> | null,
  respBody: Record<string, string>,
  provider: OAuthProvider,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  const cap = provider.tokenFieldCapture;

  if (reqBody) {
    if (cap?.fromRequest) {
      for (const f of cap.fromRequest) {
        const v = reqBody[f];
        if (typeof v === 'string') fields[f] = v;
      }
    } else {
      for (const [k, v] of Object.entries(reqBody)) {
        if (!TRANSIENT_FIELDS.has(k) && typeof v === 'string') fields[k] = v;
      }
    }
  }

  if (cap?.fromResponse) {
    for (const f of cap.fromResponse) {
      const v = respBody[f];
      if (typeof v === 'string') fields[f] = v;
    }
  } else if (typeof respBody.scope === 'string') {
    fields['scope'] = respBody.scope;
  }

  if (fields['scope']) {
    let parts = fields['scope'].split(/\s+/);
    if (cap?.scopeExclude) {
      const ex = new Set(cap.scopeExclude);
      parts = parts.filter((s) => !ex.has(s));
    }
    if (cap?.scopeInclude) {
      const inc = new Set(cap.scopeInclude);
      for (const s of inc) if (!parts.includes(s)) parts.push(s);
    }
    fields['scope'] = parts.join(' ');
    if (!fields['scope']) delete fields['scope'];
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

function extractScopeAttrs(targetHost: string, rule: InterceptRule): Record<string, string> {
  if (!rule.hostPattern) return {};
  const match = rule.hostPattern.exec(targetHost);
  if (!match?.groups) return {};
  return { ...match.groups };
}

/**
 * Take the next slot in the (owning scope, provider) refresh queue and return a
 * release callback. Installing the gate as the new tail and reading the old one
 * happen before the first `await`, so two callers can never observe the same
 * predecessor. The tail is dropped on release only when it is still ours — a
 * later caller that already chained behind us owns it by then.
 */
async function enterRefreshQueue(ctx: HandlerContext, key: string): Promise<(captured: boolean) => void> {
  const prior = ctx.inFlightRefresh.get(key);
  let release!: (captured: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  ctx.inFlightRefresh.set(key, gate);
  // An upstream failure must not block the queue — the next caller retries.
  if (prior) await prior.catch(() => false);
  return (captured: boolean) => {
    if (ctx.inFlightRefresh.get(key) === gate) ctx.inFlightRefresh.delete(key);
    release(captured);
  };
}

export function buildTokenExchangeHandler(
  provider: OAuthProvider,
  rule: InterceptRule,
  ctx: HandlerContext,
): HostHandler {
  return async (clientReq, clientRes, targetHost, targetPort, groupScope, sourceIP) => {
    const scopeAttrs = extractScopeAttrs(targetHost, rule);
    let capturedReq: Record<string, string> | null = null;
    // When this exchange is a refresh (grant_type=refresh_token), the request
    // carries a substitute refresh_token bound to a specific credential. Its
    // source scope — the grantor's, for a borrowed credential — is where the
    // refreshed token must be stored, so the outbound path (which reads that
    // same substitute) sees it. Captured here, consumed in the response
    // transform. Left undefined for a fresh auth (authorization_code), which
    // establishes the requester's OWN credential and stores to its own scope.
    let refreshSourceScope: CredentialScope | undefined;
    // True once a substitute refresh token has been swapped for its real value:
    // proof the caller already held a credential for this scope, so the exchange
    // rotates one rather than binding a new one.
    let rotatesExisting = false;
    // Replaced while this request holds the refresh-queue slot for its
    // credential; a no-op for an exchange that took no slot.
    let releaseRefreshQueue: (captured: boolean) => void = () => {};
    let captured = false;

    try {
      await proxyBuffered(
        clientReq,
        clientRes,
        targetHost,
        targetPort,
        (headers) => {
          // proxyBuffered does toString() — strip gzip request expectations.
          delete headers['accept-encoding'];
        },
        // Request transform: swap substitute refresh_token → real value,
        // capture fields for the response transform.
        async (body) => {
          const parsed = parseBody(body);
          if (!parsed) return body;
          capturedReq = parsed.fields;
          if (parsed.fields.grant_type === 'refresh_token' && parsed.fields.refresh_token) {
            const substitute = parsed.fields.refresh_token;
            const first = ctx.tokenEngine.resolveSubstitute(substitute, groupScope);
            if (first) {
              releaseRefreshQueue = await enterRefreshQueue(ctx, `${first.mapping.credentialScope}::${provider.id}`);
              // Re-resolve after the wait: a predecessor may have rotated the
              // credential, and sending the token it just spent is what trips
              // reuse detection. The substitute is stable across rotations, so
              // this second lookup yields the fresh real value.
              const entry = ctx.tokenEngine.resolveSubstitute(substitute, groupScope) ?? first;
              // Store the refreshed token to the scope this substitute is bound
              // to (grantor for a borrowed credential), not the requester's own.
              refreshSourceScope = entry.mapping.credentialScope;
              rotatesExisting = true;
              parsed.set('refresh_token', entry.realToken);
              return parsed.serialize();
            }
          }
          return body;
        },
        // Response transform: capture real tokens, persist, return substitutes.
        (body, _statusCode) => {
          const parsed = parseBody(body);
          if (!parsed?.fields.access_token) return body;

          // Binding a NEW credential is gated on a host-driven sign-in episode:
          // the caller must be that episode's own auth container, for this scope.
          // Rotation is not gated — it comes from ordinary session containers that
          // have no episode, and its write is pinned to the scope the swapped
          // substitute already resolves to, so it cannot bind a foreign account.
          //
          // Refusing means blanking the credential fields, not passing the body
          // through: an un-episoded container that kept the upstream response
          // would hold a REAL token where the ungated path would have given it a
          // substitute, which is the opposite of the intended outcome.
          if (!rotatesExisting && !isAuthEpisodeContainer(sourceIP, String(groupScope))) {
            logger.warn(
              { provider: provider.id, scope: groupScope, sourceIP },
              'oauth.token-exchange: credential binding outside a sign-in episode — refused',
            );
            parsed.set('access_token', '');
            if (parsed.fields.refresh_token) parsed.set('refresh_token', '');
            for (const extra of provider.credentialResponseFields ?? []) {
              if (typeof parsed.fields[extra.field] === 'string') parsed.set(extra.field, '');
            }
            return parsed.serialize();
          }

          try {
            const authFields = captureAuthFields(capturedReq, parsed.fields, provider);
            // Stamp the sourcing host on NON-global credentials so the
            // bearer-swap guard confines them to this registrable domain.
            // Global providers (legitimately multi-domain) are left unstamped.
            const isGlobal = ctx.isGlobalProvider?.(provider.id) ?? true;
            const credential: Credential = {
              value: parsed.fields.access_token,
              expires_ts: parsed.fields.expires_in ? Date.now() + Number(parsed.fields.expires_in) * 1000 : 0,
              updated_ts: Date.now(),
              ...(authFields && { authFields }),
              ...(!isGlobal && { boundDomain: targetHost }),
            };
            if (parsed.fields.refresh_token) {
              credential.refresh = {
                value: parsed.fields.refresh_token,
                expires_ts: 0,
                updated_ts: Date.now(),
              };
            }

            // A refresh writes back to the scope the swapped refresh substitute
            // is bound to (grantor for a borrowed credential), so the outbound
            // path reading that substitute sees the fresh token and every
            // borrower is healed. A fresh auth (no substitute swapped) stores to
            // the requester's OWN scope, where its newly minted substitute will
            // resolve — a borrower that directly authenticates thereby shadows
            // the grantor with its own credential.
            const targetScope = refreshSourceScope ?? asCredentialScope(groupScope);
            if (refreshSourceScope && refreshSourceScope !== asCredentialScope(groupScope)) {
              logger.info(
                { provider: provider.id, scope: groupScope, owning: refreshSourceScope },
                'oauth.token-exchange: refresh of borrowed credential — storing to owning (grantor) scope',
              );
            }
            // Write through the resolver that OWNS `targetScope`, not the
            // requester's. `CachedCredentialResolver.store` hard-guards
            // `scope === ownFolder` (resolver.ts) — borrowing is read-only — so
            // for a borrowed refresh (targetScope = grantor) the requester-scoped
            // resolver throws on the cross-scope write that heals the grantor.
            // `changeScope(targetScope)` hands back the owning resolver, for which
            // this is a self-write; for a fresh self-auth targetScope ===
            // groupScope and it returns the same resolver.
            ctx
              .resolverFor(groupScope)
              .changeScope(targetScope)
              .store(targetScope, provider.id, CRED_OAUTH, credential);
            // Resolves this request's refresh-queue slot as a success, so a
            // host-initiated `tryRefresh` waiting on the same key reads the same
            // "the store now holds fresh tokens" answer it gets from its own path.
            captured = true;
            // A fresh credential for this scope — clear any pending expired alert
            // (a grantor re-auth heals every borrower).
            ctx.borrowedCredentialEvents?.onCredentialHealed({ credentialScope: targetScope, providerId: provider.id });
            // The pivotal event of the whole flow, and the only evidence a
            // rotation happened at all.
            logger.info(
              { provider: provider.id, scope: targetScope, credentialPath: CRED_OAUTH, rotation: rotatesExisting },
              'oauth.token-exchange: credential captured',
            );

            const subAccess = ctx.tokenEngine.getOrCreateSubstitute(provider.id, scopeAttrs, groupScope, CRED_OAUTH);
            if (!subAccess) {
              logger.warn(
                { provider: provider.id, scope: groupScope },
                'oauth.token-exchange: could not mint substitute for access_token',
              );
              return body;
            }
            parsed.set('access_token', subAccess);

            if (parsed.fields.refresh_token) {
              const subRefresh = ctx.tokenEngine.getOrCreateSubstitute(
                provider.id,
                scopeAttrs,
                groupScope,
                CRED_OAUTH_REFRESH,
              );
              if (subRefresh) parsed.set('refresh_token', subRefresh);
            }

            // Every other credential-bearing field the provider declares. These
            // are stored first so the minted substitute has a real value to
            // resolve back to, then swapped in the response. Anything not
            // declared and not handled above leaves this handler unchanged — for
            // a provider whose response carries an identity token, that would be
            // real credential material, and the claims inside it, handed to the
            // container.
            for (const extra of provider.credentialResponseFields ?? []) {
              const real = parsed.fields[extra.field];
              if (typeof real !== 'string' || !real) continue;
              ctx
                .resolverFor(groupScope)
                .changeScope(targetScope)
                .store(targetScope, provider.id, extra.credentialPath, { value: real, updated_ts: Date.now() });
              const sub = ctx.tokenEngine.getOrCreateSubstitute(
                provider.id,
                scopeAttrs,
                groupScope,
                extra.credentialPath,
              );
              if (sub) {
                parsed.set(extra.field, sub);
              } else {
                logger.warn(
                  { provider: provider.id, scope: groupScope, field: extra.field },
                  'oauth.token-exchange: could not mint substitute for a declared credential field — dropping it',
                );
                parsed.set(extra.field, '');
              }
            }

            return parsed.serialize();
          } catch (err) {
            logger.error({ err, provider: provider.id }, 'oauth.token-exchange: response processing failed');
            return body;
          }
        },
      );
    } finally {
      // Release the queue slot whether or not the exchange produced a
      // credential; a failed refresh must not block the next attempt.
      releaseRefreshQueue(captured);
    }
  };
}
