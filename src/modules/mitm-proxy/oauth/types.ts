/**
 * OAuth-module-local types.
 *
 * `OAuthProvider` / `InterceptRule` / `RefreshStrategy` describe the
 * shape of a discovery file once parsed. They are inputs to the
 * provider adapter that builds a `SubstitutingProvider` over them; they
 * do not leak through the proxy's public types.
 *
 * Substitute / credential / scope types are imported from the parent
 * `mitm-proxy/types.ts` so this module stays a leaf in v2.
 */
import type { CredentialFormatSpec, EnvVarBinding, SubstituteConfig } from '../types.js';

/**
 * One MITM intercept rule. `anchor` is the fixed-suffix lookup key;
 * `hostPattern` (optional) is the named-group regex used to peel
 * tenant/region/etc. attrs off a templated host. `pathPattern` is
 * matched per request.
 *
 * The four modes mirror v1. `authorize-stub` and `device-code` are
 * loaded from discovery files but their handlers are deferred to a
 * later PR (`handlers/index.ts` refuses to build them).
 */
export interface InterceptRule {
  anchor: string;
  hostPattern?: RegExp;
  pathPattern: RegExp;
  mode: 'token-exchange' | 'authorize-stub' | 'bearer-swap' | 'device-code';
}

/** How bearer-swap responds to a 401 once it has refreshed credentials. */
export type RefreshStrategy = 'redirect' | 'buffer' | 'passthrough';

/**
 * The request site a credential rides in, handed to a provider's transport
 * codec so it can recognize and rebuild its own on-wire encoding without the
 * swap handler knowing the scheme.
 */
export interface CredentialContext {
  /** Which credential is being encoded (e.g. "oauth", "api_key"). */
  credentialName: string;
  /** Parsed auth scheme, e.g. "Basic" | "Bearer" | "token", or null. */
  scheme: string | null;
  /** Lower-cased header the credential rides in, e.g. "authorization". */
  headerName: string;
  /** Request host — lets a codec scope behavior (e.g. git host vs api host). */
  targetHost: string;
}

/**
 * Converts a provider's credential between its bare stored form (the
 * substitute / real token the engine stores and resolves) and its on-the-wire
 * transport form. Optional on a provider; absent → the bearer-swap handler's
 * default codec (scheme-prefixed token + the `_credential_format` base64 case).
 */
export interface CredentialTransportCodec {
  /** Wire value → bare stored-form token (the candidate to resolve), or null. */
  fromTransport(transportToken: string, ctx: CredentialContext): string | null;
  /** Bare stored-form token (real/refreshed) → wire value. */
  toTransport(storedToken: string, ctx: CredentialContext): string;
}

export interface UpstreamResponseContext {
  clientReq: import('http').IncomingMessage;
  upRes: import('http').IncomingMessage;
  scope: import('../types.js').GroupScope;
}

/** Parsed discovery file → one OAuthProvider per JSON. */
export interface OAuthProvider {
  /** Filename sans .json. */
  id: string;
  rules: InterceptRule[];
  /** Named groups extracted from hostPatterns — scope attrs the proxy stamps onto substitutes. */
  scopeKeys: string[];
  substituteConfig: SubstituteConfig;
  refreshStrategy: RefreshStrategy;
  /** Parsed `_env_vars`. */
  envBindings?: EnvVarBinding[];
  /** Parsed `_credential_format`. */
  credentialFormat?: Record<string, CredentialFormatSpec>;
  /** Parsed `_token_field_capture`. */
  tokenFieldCapture?: {
    fromRequest?: string[];
    fromResponse?: string[];
    scopeExclude?: string[];
    scopeInclude?: string[];
  };
  /**
   * Programmatic providers may own their on-wire credential encoding (e.g.
   * GitHub's git-HTTPS Basic form). Absent → the bearer-swap handler builds a
   * default codec from `credentialFormat`.
   */
  transportCodec?: CredentialTransportCodec;
}

/** Raw discovery file shape — what JSON.parse(*.json) returns. */
export interface DiscoveryFile {
  [key: string]: unknown;
  issuer?: string;
  token_endpoint?: string;
  authorization_endpoint?: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  device_authorization_endpoint?: string;
  api_base_url?: string;
  _api_hosts?: string[];
  _token_format?: {
    prefixLen?: number;
    suffixLen?: number;
    delimiters?: string;
  };
  _refresh_strategy?: RefreshStrategy;
  _env_vars?: Record<string, string>;
  _credential_format?: Record<string, CredentialFormatSpec>;
  _well_known_url?: string | false;
  _host_patterns?: string[];
  _token_field_capture?: {
    from_request?: string[];
    from_response?: string[];
    scope_exclude?: string[];
    scope_include?: string[];
  };
}
