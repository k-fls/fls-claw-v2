/**
 * Credentials module barrel.
 *
 * Public surface:
 *   - Scope types and converters (CredentialScope, GroupScope,
 *     asCredentialScope, asGroupScope).
 *   - Provider registry (manifest customization for a storage
 *     namespace + post-write/delete lifecycle hooks).
 *   - Default helpers (defaultManifestBuilder, noManifestSideEffect)
 *     for providers with no provider-specific manifest behavior.
 *   - Per-scope GPG keyring surface (C6).
 *   - Scoped plaintext store (C7s; secrets-at-rest is the resolver's
 *     job, not the store's) — readKeysFile / writeKeysFile /
 *     deleteKeysFile / listEntries / listProviderIds / listScopes /
 *     path helpers.
 *   - Manifest pipeline (C7s) — onKeysFileWritten / onKeysFileDeleted /
 *     distributeAllManifests / revokeGranteeManifests /
 *     regenerateAllManifests.
 *   - Grant/borrow state (C7s) — listGrantees / isGrantee / addGrantee /
 *     removeGrantee / getBorrowSource / setBorrowSource /
 *     clearBorrowSource / grantedDir.
 *   - Scope invalidator registry (C7s) — registerScopeInvalidator /
 *     invalidateScope.
 *   - `/creds` host command, registered at module load (C7s).
 *
 * Not in this module:
 *   - Proxy host routing (`hostRules`, brokers). Lives in the proxy
 *     module under the group-oauth skill (C2/C3).
 *   - /auth catalog metadata. Lives with the /auth command surface (C7o).
 *   - Container env / mount injection. Skills register their own A3
 *     callbacks; nothing routes through credentials.
 *   - OAuth state machine. Lives under the group-oauth skill (C4).
 */

import { registerHostCommand } from '../../command-gate.js';

import { CREDS_HELP, handleCredsCommand } from './commands/creds.js';

export type { Credential, CredentialScope, GroupScope } from './types.js';
export { asCredentialScope, asGroupScope } from './types.js';

export type { CredentialProvider } from './providers/registry.js';
export {
  registerCredentialProvider,
  getCredentialProvider,
  getAllCredentialProviders,
  setScopedCredentialProviders,
  clearScopedCredentialProviders,
} from './providers/registry.js';

// Provider extensions (provider-model). The credential provider is the
// entity; capabilities beyond the credential (agent runtime, feedback,
// reauth, producer, per-container state) attach as typed extensions
// retrieved via CredentialProvider.getExtension(type).
export {
  defineExtension,
  ExtensionBag,
  AGENT_RUNTIME,
  CONTAINER_STATE,
  CONTAINER_FEEDBACK,
  MITM_FEEDBACK,
  PRODUCER,
  UX,
  RUNTIME_UPDATER,
} from './providers/types.js';
export type {
  ExtensionType,
  AgentRuntimeExt,
  ContainerStateDecl,
  ContainerContext,
  ContainerExitContext,
  ContainerFeedbackExt,
  ContainerErrorEvent,
  FeedbackAction,
  MitmFeedbackExt,
  ProducerExt,
  UxExt,
  RuntimeUpdaterExt,
  ContributionInput,
  ProviderResult,
} from './providers/types.js';

// Container contribution: a provider's spawn env + mounts, assembled by merging
// a set of contributor calls (see ./providers/contributions.ts). Each capability
// layer adds one call rather than rewriting a shared body; object in, object out.
export { mergeContributions } from './providers/contributions.js';
export type {
  ContainerContributor,
  ContainerContributionCtx,
  ContainerContributionResult,
} from './providers/contributions.js';

// ── Reauth (mid-session) ────────────────────────────────────────────────────
export { REAUTH } from './reauth.js';
export type { ReauthExt, ReauthContext } from './reauth.js';

export { defaultManifestBuilder, noManifestSideEffect } from './providers/defaults.js';

export {
  gpgHomeForScope,
  ensureGpgKey,
  exportPublicKey,
  exportPublicKeyBinary,
  buildPgpEncryptUrl,
  PGP_ENCRYPT_BASE_URL,
  getKeyMeta,
  isKeyExpired,
  isGpgAvailable,
  isPgpMessage,
  normalizeArmoredBlock,
  gpgDecrypt,
  type GpgKeyMeta,
} from './gpg.js';

// ── Store (C7s) ─────────────────────────────────────────────────────────────
export {
  ENTRY_VERSION_KEY,
  credentialsDir,
  scopeDir,
  keysFilePath,
  readKeysFile,
  writeKeysFile,
  updateKeysFile,
  deleteKeysFile,
  deleteScope,
  listEntries,
  listProviderIds,
  listScopes,
} from './store.js';

// ── Grants (C7s) ────────────────────────────────────────────────────────────
export {
  listGrantees,
  isGrantee,
  addGrantee,
  removeGrantee,
  getBorrowSource,
  setBorrowSource,
  clearBorrowSource,
  grantedDir,
  canAccess,
} from './grants.js';

// ── Manifest pipeline (C7s) ─────────────────────────────────────────────────
export {
  onKeysFileWritten,
  onKeysFileDeleted,
  distributeAllManifests,
  revokeGranteeManifests,
  regenerateAllManifests,
  _resetRegenForTests,
} from './manifest.js';

// ── Resolver (C7r) ──────────────────────────────────────────────────────────
export type { CredentialResolver } from './resolver.js';
export {
  getOrCreateResolverForAgentGroup,
  disposeResolverForAgentGroup,
  getResolverForAgentGroup,
} from './resolver.js';

// ── Scope invalidator (C7s) ─────────────────────────────────────────────────
export {
  registerScopeInvalidator,
  invalidateScope,
  _resetScopeInvalidatorsForTests,
  type ScopeInvalidator,
} from './scope-invalidator.js';

// ── Import planner seam (C7o / I2) ───────────────────────────────────────────
// mitm-proxy registers the binding-aware planner (reverse index + composite
// joining); `/creds import` consults it. Dormant (literal storage) until a
// planner is registered.
export { registerImportPlanner, planCredentialImport, _resetImportPlannerForTests } from './import-resolver.js';
export type { ImportToken, ImportStore, ImportPlan, ImportPlanner } from './import-resolver.js';

// ── Host command registration (C7s) ─────────────────────────────────────────
// Grant/borrow state moves real credentials between groups, so the command
// requires admin privilege over the target agent group (gate-enforced).
registerHostCommand('/creds', handleCredsCommand, {
  scope: 'agent',
  access: 'group-admin',
  help: CREDS_HELP,
});

// Side-effect: registers the spawn-time credential-provider validation
// observer. Dormant until a provider declares an AGENT_RUNTIME extension.
import './spawn-validation.js';

// Side-effect: registers the `feedback.container` delivery action (the
// mid-session reauth dispatcher). Dormant until a provider declares a
// CONTAINER_FEEDBACK extension.
import './reauth-dispatcher.js';
export { requestReauth, sanitizeReason, _resetReauthDispatcherForTests } from './reauth-dispatcher.js';

// Side-effect: registers the `/auth/*` host-rpc handler (the browser-auth
// container↔user bridge). Dormant until a provider opens an auth episode.
import './auth-bridge.js';
export { startAuthEpisode, _resetAuthBridgeForTests } from './auth-bridge.js';
export type { AuthEpisodeHandle, AuthCodeResult } from './auth-bridge.js';
