/**
 * `onecli` credential provider — the OneCLI **agent identifier** as a
 * grantable credential (C3). See `docs/fls/specs/onecli-broker.md` §5a.
 *
 * The value of this credential is the OneCLI agent identity the broker forwards
 * as for a group. It is the one *grantable* part of the broker story (routing
 * is global-admin config, not a resource): granting `onecli` to another group
 * lets that group forward as — and use the vault of — the grantor's agent.
 *
 * It is a plain credential (no substitution, no host rules); the broker reads
 * it host-side via the resolver. Today's behavior — `agentIdentifier =
 * agentGroup.id`, hardcoded with no override (`container-runner.ts:248`) — is
 * preserved as the **default** when no credential is stored, so nothing needs
 * per-group setup unless a group forwards as someone else.
 *
 * id-vs-folder subtlety: the credential is keyed by **folder** scope (like every
 * credential), but its **value is an OneCLI agent id**. Callers pass the default
 * agent id (computed from the group) so this module stays DB-free.
 */
import {
  asCredentialScope,
  defaultManifestBuilder,
  getBorrowSource,
  getOrCreateResolverForAgentGroup,
  noManifestSideEffect,
  registerCredentialProvider,
} from '../modules/credentials/index.js';

export const ONECLI_PROVIDER_ID = 'onecli';

/** Credential path under the `onecli` provider holding the agent identifier. */
export const ONECLI_IDENTIFIER_PATH = 'identifier';

/** Register the `onecli` agent-identifier credential provider (call at boot). */
export function registerOneCliCredentialProvider(): void {
  registerCredentialProvider({
    id: ONECLI_PROVIDER_ID,
    buildManifest: defaultManifestBuilder(ONECLI_PROVIDER_ID),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
  });
}

/**
 * Resolve the OneCLI agent identifier the broker should forward as for a group.
 *
 * Resolution order (own-scope → granted borrow source → default), so a group
 * forwards as its own agent unless it has been granted another's identifier:
 *   1. the group's own stored `onecli` credential;
 *   2. a stored `onecli` credential under the group's borrow source — the
 *      resolver enforces `canAccess` (bilateral grant), so an ungranted borrow
 *      claim resolves to null;
 *   3. `defaultIdentifier` — pass the group's own `agentGroup.id` to preserve
 *      today's hardcoded behavior.
 */
export function resolveAgentIdentifier(groupFolder: string, defaultIdentifier: string): string {
  const resolver = getOrCreateResolverForAgentGroup(groupFolder);

  const own = resolver.resolve(asCredentialScope(groupFolder), ONECLI_PROVIDER_ID, ONECLI_IDENTIFIER_PATH);
  if (own?.value) return own.value;

  const source = getBorrowSource(groupFolder);
  if (source) {
    const borrowed = resolver.resolve(asCredentialScope(source), ONECLI_PROVIDER_ID, ONECLI_IDENTIFIER_PATH);
    if (borrowed?.value) return borrowed.value;
  }

  return defaultIdentifier;
}
