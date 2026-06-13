/**
 * The built-in credential transport codec — used for any provider that doesn't
 * supply its own. It reproduces the discovery-JSON wire behavior:
 *
 *   - the common case: a bare `<scheme> <token>` header (Bearer, token, …),
 *   - the whole-value base64 case when the provider's `_credential_format`
 *     declares `encode: 'base64'` for a credential (e.g. browserstack's
 *     `Authorization: Basic base64(<composite>)`).
 *
 * Compiled per provider so the base64 decision is data-driven (read off
 * `credentialFormat` once), never resolved at request time.
 */
import type { CredentialFormatSpec } from '../../types.js';
import type { CredentialContext, CredentialTransportCodec } from '../types.js';

/** Parse `<Scheme> <rest>` → the scheme token, or null when there isn't one. */
export function parseAuthScheme(value: string): string | null {
  const sp = value.indexOf(' ');
  if (sp <= 0 || sp >= 20) return null;
  return value.slice(0, sp);
}

function afterScheme(value: string, scheme: string | null): string {
  return scheme ? value.slice(scheme.length + 1).trim() : value.trim();
}

function isBasic(scheme: string | null): boolean {
  return scheme != null && /^basic$/i.test(scheme);
}

export function buildDefaultTransportCodec(
  credentialFormat?: Record<string, CredentialFormatSpec>,
): CredentialTransportCodec {
  const hasBase64 = !!credentialFormat && Object.values(credentialFormat).some((f) => f.encode === 'base64');

  return {
    fromTransport(transportToken: string, ctx: CredentialContext): string | null {
      const body = afterScheme(transportToken, ctx.scheme);
      // A base64-format provider rides its token base64-encoded as the whole
      // Basic payload — decode it. (Invalid base64 just yields a candidate that
      // won't resolve, so attempting the decode is safe.)
      if (hasBase64 && isBasic(ctx.scheme)) {
        return Buffer.from(body, 'base64').toString('utf8');
      }
      return body;
    },
    toTransport(storedToken: string, ctx: CredentialContext): string {
      const base64 = isBasic(ctx.scheme) && credentialFormat?.[ctx.credentialName]?.encode === 'base64';
      const wire = base64 ? Buffer.from(storedToken, 'utf8').toString('base64') : storedToken;
      return ctx.scheme ? `${ctx.scheme} ${wire}` : wire;
    },
  };
}
