/**
 * The GitHub provider entity — programmatic (not a discovery JSON), so it can
 * own its on-wire credential encoding via a `CredentialTransportCodec`.
 *
 * A GitHub PAT rides two ways:
 *   - REST / GraphQL (`api.github.com`): `Authorization: Bearer <token>`.
 *   - git over HTTPS (`github.com`): `Authorization: Basic base64("<user>:<token>")`
 *     — git's credential helper sends the PAT as the *password*; the username is
 *     arbitrary for a PAT, so on encode we use GitHub's documented placeholder
 *     `x-access-token`. The username is never read from, nor stored by, `/auth`.
 *
 * The proxy stores/resolves the bare token (substitute ↔ real); the codec only
 * (un)wraps it into whichever transport form the request used. Registered at
 * host boot alongside the Claude provider; `initOAuthModule` skips it (no
 * `github.json`), so there's no duplicate-id clash.
 */
import {
  registerCredentialProvider,
  defaultManifestBuilder,
  noManifestSideEffect,
} from '../modules/credentials/index.js';
import {
  oauthSubstitutesFor,
  DEFAULT_SUBSTITUTE_CONFIG,
  type OAuthProvider,
  type SubstitutingProvider,
  type CredentialTransportCodec,
} from '../modules/mitm-proxy/index.js';

const PROVIDER_ID = 'github';

function isBasic(scheme: string | null): boolean {
  return scheme != null && /^basic$/i.test(scheme);
}

function afterScheme(value: string, scheme: string | null): string {
  return scheme ? value.slice(scheme.length + 1).trim() : value.trim();
}

export const githubTransportCodec: CredentialTransportCodec = {
  fromTransport(transportToken, ctx) {
    if (isBasic(ctx.scheme)) {
      // base64("<user>:<token>") → the PAT is the password half.
      const decoded = Buffer.from(afterScheme(transportToken, ctx.scheme), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon === -1) return null;
      return decoded.slice(colon + 1);
    }
    // Bearer (or any other scheme): the bare token sits after the scheme.
    return afterScheme(transportToken, ctx.scheme);
  },
  toTransport(storedToken, ctx) {
    if (isBasic(ctx.scheme)) {
      return 'Basic ' + Buffer.from(`x-access-token:${storedToken}`, 'utf8').toString('base64');
    }
    return ctx.scheme ? `${ctx.scheme} ${storedToken}` : storedToken;
  },
};

const GITHUB_OAUTH_PROVIDER: OAuthProvider = {
  id: PROVIDER_ID,
  rules: [
    // REST/GraphQL API — Bearer.
    { anchor: 'api.github.com', pathPattern: /^\//, mode: 'bearer-swap' },
    // git over HTTPS (smart-HTTP) — Basic auth, handled by the codec.
    { anchor: 'github.com', pathPattern: /^\//, mode: 'bearer-swap' },
  ],
  scopeKeys: [],
  substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
  refreshStrategy: 'redirect',
  envBindings: [
    { envName: 'GH_TOKEN', credentialPath: 'oauth' },
    { envName: 'GITHUB_TOKEN', credentialPath: 'oauth' },
  ],
  transportCodec: githubTransportCodec,
};

/**
 * Register the GitHub provider. Call once at boot, AFTER `initTokenEngine`
 * (the substitution facet reads the engine). Duplicate-id registration throws —
 * the registry is the guard.
 */
export function registerGithubCredentialProvider(): void {
  const provider: SubstitutingProvider = {
    id: PROVIDER_ID,
    buildManifest: defaultManifestBuilder(PROVIDER_ID),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
    substitutes: oauthSubstitutesFor(GITHUB_OAUTH_PROVIDER),
  };
  registerCredentialProvider(provider);
}
