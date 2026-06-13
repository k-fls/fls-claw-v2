/**
 * MITM credential proxy module — substitution-only port of the
 * fork's `src/auth/` proxy stack. The OAuth state machine, discovery
 * loader, browser-open relay, and provider-specific handlers do not
 * live here; they land with the group-oauth skill module. Tracking
 * removed surfaces in `docs/fls/mitm-proxy-oauth-readd.md`.
 *
 * Public surface:
 *   - `CredentialProxy` + singleton accessors. The proxy does NOT own a
 *     provider registry — providers live in
 *     `src/modules/credentials/providers/registry.ts`. The proxy holds a
 *     host-rule index over registry entries that satisfy
 *     `isSubstitutingProvider`. Callers manage that index via
 *     `proxy.indexProvider(p)` (incremental, fail-loud) and
 *     `proxy.rebuildIndex()` (atomic full rebuild). `start()` runs an
 *     initial `rebuildIndex()` automatically.
 *   - Token substitute engine: `initTokenEngine(factory)`,
 *     `getTokenEngine`, `TokenSubstituteEngine`.
 *   - MITM CA helpers: `getMitmCaCertPath`, `createMitmContext`.
 *   - Tap observability: `setProxyResponseHook`, `setUpstreamAgent`,
 *     `createTapFilterFromEnv(proxy)`.
 *   - Env-var name validation.
 *
 * Side effects on import:
 *   - Reserves the env-var names the observer injects (`HTTP_PROXY`,
 *     `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
 *     `MITM_CA_PATH`) with `container-bootstrap`.
 *   - Registers a `container-bootstrap` observer that contributes
 *     proxy env vars and the MITM CA bind-mount per spawn (see
 *     `observer.ts`).
 *   - Does NOT start the proxy server — `src/index.ts` constructs a
 *     `CredentialProxy`, calls `initTokenEngine(factory)`,
 *     `setProxyInstance(proxy)`, and `proxy.start({ port })`.
 */

// Proxy class + singleton
export {
  CredentialProxy,
  setProxyInstance,
  clearProxyInstance,
  hasProxyInstance,
  getProxy,
} from './credential-proxy.js';
export type {
  CredentialProxyOptions,
  HostHandler,
  ProxyResponseHook,
  ProxyTapEvent,
  ProxyTapFilter,
  ProxyTapCallback,
  ProxyTapResolver,
  ProxyTapResult,
} from './credential-proxy.js';
export { proxyPipe, proxyBuffered, setProxyResponseHook, setUpstreamAgent } from './credential-proxy.js';

// MITM CA
export { createMitmContext, getMitmCaCertPath, parseSni } from './mitm-ca.js';
export type { MitmContext } from './mitm-ca.js';

// Credential broker registry (the OneCLI-as-broker tier — C3)
export {
  registerCredentialBroker,
  getCredentialBroker,
  getCredentialBrokers,
  hasCredentialBrokers,
} from './broker-registry.js';
export type { CredentialBroker, BrokerForward } from './broker-registry.js';

// Token substitute engine + singleton
export {
  TokenSubstituteEngine,
  initTokenEngine,
  getTokenEngine,
  setTokenEngine,
  _resetTokenEngineForTests,
  _getEngineFactoryForTests,
} from './token-substitute.js';
export type { ResolvedToken, BorrowSourceResolver } from './token-substitute.js';

// SubstitutesSpec default-implementation factory (compose this in a
// provider declaration to get the canonical behavior).
export { defaultSubstitutes } from './defaults.js';
export type { DefaultSubstitutesInput } from './defaults.js';

// Tap observability
export { createTapFilter, createTapFilterFromEnv, LOG_FILE } from './proxy-tap-logger.js';

// Types
export type {
  Credential,
  CredentialFormatSpec,
  CredentialScope,
  EngineCredentialResolver,
  EnvVarBinding,
  GroupScope,
  HostRule,
  ProviderSubstitutes,
  ResolverFactory,
  ScopeAccessCheck,
  SubstituteConfig,
  SubstituteEntry,
  SubstituteMapping,
  SubstitutesSpec,
  SubstitutingProvider,
} from './types.js';
export {
  asCredentialScope,
  asGroupScope,
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
  DEFAULT_SUBSTITUTE_CONFIG,
  DEFAULT_ALNUM_SUBSTITUTE_CONFIG,
  MIN_RANDOM_CHARS,
  extractToken,
  isSubstitutingProvider,
} from './types.js';

// Env-var name validation (format check + reserved-set lookup)
export { ENV_NAME_RE, validateEnvVarFormat, isReservedEnvName } from './env-name-validation.js';

// OAuth detection + handling submodule. Initialized by the host after
// `proxy.start()` resolves; do NOT import this module for any side
// effect — call `initOAuthModule` explicitly.
export { initOAuthModule, oauthSubstitutesFor } from './oauth/index.js';
export type { OAuthModuleHandle, InitOAuthModuleOptions } from './oauth/index.js';
export type {
  OAuthProvider,
  InterceptRule,
  RefreshStrategy,
  CredentialContext,
  CredentialTransportCodec,
} from './oauth/types.js';

// Side-effect: reserve own env-var names and register the lifecycle observer.
import './observer.js';
export { buildMitmProxyContribution, type MitmProxyContribution } from './observer.js';

// Interactive OAuth host surface (device-code notice + authorize-stub code
// relay) + the production code-delivery primitive. The host passes both to
// `initOAuthModule` at boot.
export { oauthInteractive, dockerExecDeliver } from './oauth/oauth-interactive.js';
export type { OAuthEvents, AuthCodeDeliver } from './oauth/handler-context.js';

// Side-effect: register the `get_credential` sync action.
import './get-credential-action.js';

// Side-effect: register the `reload_auth_providers` sync action.
import './reload-providers-action.js';

// Side-effect: register the spawn-time credential→env-var publish (A3
// contribution) — materializes each substituting provider's bound env vars
// (GH_TOKEN, BROWSERSTACK_*, …) for groups that have the credential (I2).
import './credential-env.js';
export { materializeGroupCredentialEnv } from './credential-env.js';

// Side-effect: register the binding-aware `/creds import` planner (reverse
// index + composite joining) into the credentials import seam (I2).
import './import-planning.js';
export { planImport } from './import-planning.js';

// Side-effect: register the `/oauth/browser-open` host-rpc endpoint (the host
// side of the container xdg-open shim — C10).
import './browser-open-action.js';

// Register the `/tap` host command (proxy tap-logger control surface).
import { registerHostCommand } from '../../command-gate.js';
import { handleTapCommand, TAP_HELP } from './commands/tap.js';
registerHostCommand('/tap', handleTapCommand, { scope: 'host', access: 'global-admin', help: TAP_HELP });

// Register the `/auth` host command (credential (re)authentication trigger).
// Channel-scope: the handler enumerates the channel's engaged groups and runs
// the group-admin check itself against the resolved group (C7o).
import { handleAuthCommand, AUTH_HELP } from './commands/auth.js';
registerHostCommand('/auth', handleAuthCommand, { scope: 'channel', access: 'group-admin', help: AUTH_HELP });
