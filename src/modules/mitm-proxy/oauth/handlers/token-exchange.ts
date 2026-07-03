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
 */
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

export function buildTokenExchangeHandler(
  provider: OAuthProvider,
  rule: InterceptRule,
  ctx: HandlerContext,
): HostHandler {
  return async (clientReq, clientRes, targetHost, targetPort, groupScope) => {
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
      (body) => {
        const parsed = parseBody(body);
        if (!parsed) return body;
        capturedReq = parsed.fields;
        if (parsed.fields.grant_type === 'refresh_token' && parsed.fields.refresh_token) {
          const entry = ctx.tokenEngine.resolveSubstitute(parsed.fields.refresh_token, groupScope);
          if (entry) {
            // Store the refreshed token to the scope this substitute is bound
            // to (grantor for a borrowed credential), not the requester's own.
            refreshSourceScope = entry.mapping.credentialScope;
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
          ctx.resolverFor(groupScope).changeScope(targetScope).store(targetScope, provider.id, CRED_OAUTH, credential);
          // A fresh credential for this scope — clear any pending expired alert
          // (a grantor re-auth heals every borrower).
          ctx.borrowedCredentialEvents?.onCredentialHealed({ credentialScope: targetScope, providerId: provider.id });

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

          return parsed.serialize();
        } catch (err) {
          logger.error({ err, provider: provider.id }, 'oauth.token-exchange: response processing failed');
          return body;
        }
      },
    );
  };
}
