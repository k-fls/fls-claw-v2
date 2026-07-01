/**
 * Per-OAuth-module context threaded into every handler closure.
 *
 * v1 wired refresh-callbacks, fetch overrides, etc. via module-level
 * singletons (`setTokenFetch`, `setAuthErrorResolver`). v2 closes over
 * a single `HandlerContext` instead — clearer ownership, no global
 * state, and a clean test seam (override `fetchImpl` and you're done).
 */
import type { CredentialResolver } from '../../credentials/index.js';
import type { TokenSubstituteEngine } from '../token-substitute.js';
import type { GroupScope } from '../types.js';

/**
 * Deliver a captured OAuth code into a running container's own localhost
 * callback listener — the leaf "get this code to that container" step,
 * injected so the chat-UX layer doesn't hardwire the container runtime.
 * In production this is a `docker exec … curl localhost:<port>/cb?code=…`
 * (see `oauth-interactive.ts`); tests pass a fake.
 */
export type AuthCodeDeliver = (containerName: string, callbackUrl: string) => Promise<void>;

/**
 * Host-side surface the interactive OAuth handlers (`device-code`,
 * `authorize-stub`) call to reach a human and, for the redirect flow,
 * deliver the captured code back into the container. Pure interface —
 * the implementation (`./oauth-interactive.ts`) closes over sessions and
 * host-interactions; the OAuth submodule stays dependency-light and just
 * invokes these.
 *
 * Both methods resolve the calling container from `sourceIP` (container↔IP↔
 * session is 1:1 — so the scope is derivable and isn't passed redundantly).
 * When no session/user can be resolved they no-op (device-code) or return
 * null (authorize-stub → the handler forwards the request unchanged).
 */
export interface OAuthEvents {
  /**
   * Device-code flow: surface the `user_code` + verification URI to the
   * user as a one-shot chat message. No reply is captured — the container
   * polls the token endpoint itself once the user authorizes.
   */
  notifyDeviceCode(args: { sourceIP?: string; providerId: string; userCode: string; verificationUri: string }): void;
  /**
   * Authorize-stub flow: surface the authorization URL to the user, capture
   * the returned code (or full localhost callback URL), and hand it to
   * `deliverCallback` (which `docker exec`s it into the container). Returns
   * an interaction id for the stub response synchronously (the capture +
   * delivery run in the background), or null when no user could be resolved.
   */
  beginAuthorizeStub(args: {
    sourceIP?: string;
    providerId: string;
    authUrl: string;
    deliverCallback: AuthCodeDeliver;
  }): string | null;
}

export interface HandlerContext {
  /** Substitute engine (read-only path: substitute ↔ real token). */
  tokenEngine: TokenSubstituteEngine;
  /**
   * Per-group credential resolver factory. The refresh path writes
   * credentials through the resolver for the calling group's own scope.
   */
  resolverFor: (scope: GroupScope) => CredentialResolver;
  /** Replaceable fetch — only used for token-endpoint exchanges. */
  fetchImpl: typeof fetch;
  /**
   * Dedup concurrent refreshes per (scope, providerId, credentialPath).
   * Lives on the context so all handlers built off one
   * `initOAuthModule` call share the same gate.
   */
  inFlightRefresh: Map<string, Promise<boolean>>;
  /**
   * Circuit breaker for the `redirect` refresh strategy. Keyed
   * `${scope}::${providerId}::${credentialId}`, value = the ms timestamp of the
   * refresh+redirect last emitted for that credential.
   *
   * A `redirect` retry is a brand-new proxy request with no per-request memory,
   * so a credential that is refreshable but structurally invalid (the refresh
   * mints a new access token, yet upstream still 401s it) otherwise loops
   * 401→refresh→307 until the client's redirect cap. This map lets the handler
   * detect "I already refreshed+redirected this credential and it's back with a
   * 401" and forward the 401 instead of redirecting again. Cleared on any
   * non-401 success (resetting the one-retry budget) and self-heals via a TTL.
   * Lives on the context so all handlers built off one `initOAuthModule` call
   * share it. Absent → breaker disabled (falls back to always-redirect); every
   * production context wires it, only lightweight test contexts may omit it.
   */
  redirectRefreshBreaker?: Map<string, number>;
  /**
   * Is this provider id globally registered? Token-exchange capture uses it
   * to skip stamping `boundDomain` on global credentials (which legitimately
   * span multiple registrable domains). Evaluated at request time. Absent →
   * treated as global (no stamp) — the conservative default for callers that
   * don't wire it (tests); all production contexts set it.
   */
  isGlobalProvider?: (providerId: string) => boolean;
  /**
   * Host surface for the interactive OAuth modes (`device-code`,
   * `authorize-stub`). Absent on contexts built for programmatic providers
   * (e.g. the Claude entity, which only uses bearer-swap/token-exchange) and
   * in tests — the interactive handlers degrade gracefully when it's unset.
   */
  oauthEvents?: OAuthEvents;
  /**
   * Code-delivery primitive the authorize-stub handler forwards into
   * `oauthEvents.beginAuthorizeStub`. Wired alongside `oauthEvents` at boot.
   * Absent → authorize-stub can't return a code to the container, so it
   * forwards the request unchanged.
   */
  deliverCallback?: AuthCodeDeliver;
}
