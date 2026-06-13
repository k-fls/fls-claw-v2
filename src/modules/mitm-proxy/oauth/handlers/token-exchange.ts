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
import type { Credential } from '../../types.js';
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

          const ownScope = asCredentialScope(groupScope);
          ctx.resolverFor(groupScope).store(ownScope, provider.id, CRED_OAUTH, credential);

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
