/**
 * Local types for the mitm-proxy module.
 *
 * Scope branding (`GroupScope`, `CredentialScope`) is re-exported from
 * the credentials module — both modules need the same brand so types
 * line up across the resolver boundary.
 *
 * The OAuth-specific types from v1 (`InterceptRule`, `OAuthProvider`,
 * `RefreshStrategy`, etc.) are intentionally **not** here — they land
 * with the OAuth module. What we keep is the minimal surface the
 * substitution engine and substitute endpoint need to register and
 * route against provider entries.
 */
import type { Credential, CredentialScope, GroupScope } from '../credentials/index.js';
import type { CredentialProvider } from '../credentials/providers/registry.js';
export { asCredentialScope, asGroupScope } from '../credentials/index.js';
export type { Credential, CredentialScope, GroupScope } from '../credentials/index.js';

// ── Substitute configuration ────────────────────────────────────────────────

export interface SubstituteConfig {
  /** Characters to preserve from the start of the real token. */
  prefixLen: number;
  /** Characters to preserve from the end of the real token. */
  suffixLen: number;
  /** Delimiter chars to preserve in-place (e.g. "-._"). */
  delimiters: string;
  /** Minimum randomized chars required in the middle. Defaults to MIN_RANDOM_CHARS. */
  minRandomChars?: number;
}

export const DEFAULT_SUBSTITUTE_CONFIG: SubstituteConfig = {
  prefixLen: 10,
  suffixLen: 4,
  delimiters: '-._~',
};

export const DEFAULT_ALNUM_SUBSTITUTE_CONFIG: SubstituteConfig = {
  prefixLen: 4,
  suffixLen: 4,
  delimiters: '',
  minRandomChars: 8,
};

export const MIN_RANDOM_CHARS = 16;

// ── Well-known credential paths ─────────────────────────────────────────────

/** Credential path for OAuth access tokens. Re-used as a generic top-level key. */
export const CRED_OAUTH = 'oauth';

/** Credential path for OAuth refresh tokens (nested under 'oauth'). */
export const CRED_OAUTH_REFRESH = 'oauth/refresh';

// ── Provider registry entries ───────────────────────────────────────────────

/**
 * One env var binding declared by a provider's `_env_vars` map.
 * Plain (`"GH_TOKEN": "oauth"`) or slice (`"USER": "auth[0]"`) form.
 */
export interface EnvVarBinding {
  envName: string;
  credentialPath: string;
  /** Set when the raw value was `"credId[n]"`. Index into split-by-sep of the substitute. */
  slice?: number;
}

/** Per-credential format hint. */
export interface CredentialFormatSpec {
  /** Wire encoding of the credential value. Only `base64` is supported today. */
  encode?: 'base64';
  /** Separator joining the credential's sub-fields. Used for slicing into env vars. */
  sep?: string;
}

// ── Substituting provider (CredentialProvider subtype) ─────────────────────

/**
 * One MITM host rule. The proxy derives the anchor index *and* evaluates
 * per-request matches from the same array returned by `hostRules()` —
 * single source of truth, no drift between index and matcher.
 */
export interface HostRule {
  hostPattern: RegExp;
  pathPattern: RegExp;
  handler: import('./credential-proxy.js').HostHandler;
  /**
   * Explicit anchor (domain suffix) for the proxy's anchor index.
   * Set this when the hostPattern is templated (contains regex
   * metacharacters that would not pass the anchor-shape check), so the
   * lookup can still find the rule by the fixed suffix of the host.
   *
   * Example: a rule for `(?<tenant>[^.]+)\.auth0\.com` sets
   * `anchor: 'auth0.com'`. Omit for fixed-host rules — the anchor is
   * derived from `hostPattern.source` by stripping `^/$` and unescaping
   * `\.`.
   */
  anchor?: string;
}

/**
 * Behavioral contract a provider implements to participate in the MITM
 * proxy / substitute endpoint surface. Methods only — no declarative
 * fields. Providers that want the canonical implementation compose
 * `defaultSubstitutes(...)` from `./defaults.js`; providers that need
 * custom behavior write their own.
 *
 * Integrity invariants the contract preserves by construction:
 *   - `hostRules()` is the sole source of routing data. Anchors are
 *     derived from the returned regexes; the matcher walks the same
 *     array. No separate hint structure that could drift.
 *   - `envNamesFor(path)` and `envValueFor(name, ...)` are methods on
 *     the same provider object, sharing state. The set of names the
 *     value method accepts equals what the enum method advertises.
 *   - `generateSubstitute` is the only path to a substitute. The
 *     engine never generates one itself, so substitute-shape is
 *     entirely a provider decision.
 */
export interface SubstitutesSpec {
  /**
   * Produce a substitute for a real credential value at this path.
   * Called by the token engine on cache miss. Returning a value that
   * collides with an existing substitute prompts the engine to retry;
   * after a handful of attempts the engine gives up. Return `null`
   * when the input can't be substituted at all (e.g. token too short
   * for a format-preserving scheme).
   */
  generateSubstitute(realValue: string, credentialPath: string): string | null;

  /**
   * Enumerate env var names this provider produces for one
   * credentialPath. Pure enumeration — no credential resolution. The
   * substitute endpoint uses this to populate its JSON response and to
   * decide which env vars will appear in the container manifest.
   */
  envNamesFor(credentialPath: string): readonly string[];

  /**
   * Compute the value for one envName given a resolved substitute and
   * the underlying credential. Returns `null` when the value can't be
   * materialized (e.g. a sliced binding whose substitute has too few
   * parts to slice). The set of names this accepts MUST equal what
   * `envNamesFor` advertises for the same credentialPath.
   */
  envValueFor(envName: string, substitute: string, credential: Credential): string | null;

  /**
   * All env-var bindings this provider declares, in declaration order.
   * Pure enumeration — the inverse of `envNamesFor` over every path at
   * once. Mirrors v1's `provider.envBindings`. Consumed by the
   * spawn-time credential-env publish and the `/creds import` reverse
   * index. Optional: a provider with a hand-rolled spec may omit it
   * (enumeration consumers then treat it as declaring no bindings).
   * Providers composed from `defaultSubstitutes` expose it.
   */
  envBindings?(): readonly EnvVarBinding[];

  /**
   * Per-credential format hint (separator / encoding) for one
   * credentialPath, or an empty object when none is declared. Composite
   * (sliced) consumers need the `sep` to join env-var fields back into
   * one credential value on import. Optional — paired with `envBindings`.
   */
  credentialFormatFor?(credentialPath: string): CredentialFormatSpec;

  /**
   * All host rules in one call. The proxy derives the anchor index
   * AND evaluates per-request matches from the same array — single
   * source, no drift possible. Throws at index time if any
   * hostPattern doesn't yield a derivable anchor.
   */
  hostRules(): readonly HostRule[];
}

/**
 * A CredentialProvider that participates in the MITM proxy / substitute
 * endpoint surface. Extends the base provider — does not modify it. The
 * credentials module knows nothing about this subtype.
 */
export interface SubstitutingProvider extends CredentialProvider {
  substitutes: SubstitutesSpec;
}

export function isSubstitutingProvider(p: CredentialProvider): p is SubstitutingProvider {
  return (p as SubstitutingProvider).substitutes !== undefined;
}

// ── Substitute mapping (engine state) ───────────────────────────────────────

export interface SubstituteEntry {
  /** Path to the token within the keys file, e.g. 'oauth', 'api_key', 'oauth/refresh'. */
  credentialPath: string;
  scopeAttrs: Record<string, string>;
  /** Per-entry source scope for borrowed credentials. Absent = owned by this group. */
  sourceScope?: CredentialScope;
  /** Env var names this substitute should be published as. Unique. */
  envNames?: string[];
}

export interface ProviderSubstitutes {
  substitutes: Map<string, SubstituteEntry>;
}

export type ScopeAccessCheck = (groupScope: GroupScope, sourceScope: CredentialScope) => boolean;

export interface SubstituteMapping {
  providerId: string;
  credentialPath: string;
  scopeAttrs: Record<string, string>;
  credentialScope: CredentialScope;
}

// ── Resolver contract (engine ↔ v2 credentials module) ──────────────────────

/**
 * Read-only credential lookup the engine needs. Narrower than
 * `src/modules/credentials/CredentialResolver` — the engine only reads,
 * never stores/deletes (credentials lifecycle lives in its own module).
 *
 * In production this is satisfied by a per-group resolver returned from
 * `getOrCreateResolverForAgentGroup(groupScope)`; the engine multiplexes
 * via an injected `ResolverFactory`.
 */
export interface EngineCredentialResolver {
  resolve(credentialScope: CredentialScope, providerId: string, credentialId: string): Credential | null;
}

/**
 * Factory returning the appropriate resolver for the *calling* group.
 * The credentials module's per-group resolvers enforce their own
 * access checks (`grants.canAccess(ownFolder, scope)`); the engine
 * stays scope-agnostic by routing every read through the right
 * resolver for the request's GroupScope.
 */
export type ResolverFactory = (groupScope: GroupScope) => EngineCredentialResolver;

/** Pull a token value out of a resolved (plaintext) credential. */
export function extractToken(credential: Credential, subPath?: string): string | null {
  if (!subPath) return credential.value || null;
  const sub = (credential as unknown as Record<string, unknown>)[subPath];
  if (!sub || typeof sub !== 'object' || !('value' in sub)) return null;
  const { value } = sub as { value: string };
  return value || null;
}
