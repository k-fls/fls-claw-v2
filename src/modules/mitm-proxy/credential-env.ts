/**
 * Spawn-time bulk publish of credential→env-var bindings (inventory I2).
 *
 * v1 parity: at container spawn, every substituting provider the group has a
 * stored credential for gets its declared env vars (e.g. `GH_TOKEN`,
 * `TODOIST_API_TOKEN`, the composite `BROWSERSTACK_USERNAME` /
 * `BROWSERSTACK_ACCESS_KEY`) materialized into the container env up front —
 * so tools that read env vars work without the agent having to call
 * `get_credential` first. Ported from v1 `provisionEnvVars` /
 * `injectSubstituteCredentials` (`src/auth/{provision,container-args}.ts`).
 *
 * The published values are non-sensitive **substitutes** — the proxy swaps
 * each for the real token on the wire — so they are safe to place in the
 * container env. Composite credentials are sliced per binding via the
 * provider's `envValueFor` (using the credential's declared `sep`), exactly
 * as v1's `materializeEnv` did.
 *
 * Delivered through the A3 agent-group contribution registry (`{ env }` →
 * Docker `-e`), the same mechanism the custom-env substrate (I1) uses.
 *
 * Providers that own their spawn-time env injection via an `AGENT_RUNTIME`
 * extension (the agent runtime itself — e.g. Claude's `ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN`) are skipped here: they self-inject through the
 * provider-container contribution, and double-emitting the same name would
 * collide. This mirrors v1's builtin (Docker `-e`) vs discovery (`~/.env-vars`)
 * split, which kept the two sets disjoint.
 */
import { registerAgentGroupContribution } from '../../agent-group-contributions.js';
import { AGENT_RUNTIME } from '../credentials/index.js';
import { getAllCredentialProviders } from '../credentials/providers/registry.js';

import { isReservedEnvName, validateEnvVarFormat } from './env-name-validation.js';
import { logger } from './logger.js';
import { getTokenEngine } from './token-substitute.js';
import { asCredentialScope, asGroupScope, isSubstitutingProvider, type GroupScope } from './types.js';

/**
 * Build the credential-bound env vars for a group: `{ ENV_NAME → substitute }`.
 * Only providers with a stored credential for the bound credentialPath
 * contribute (the mint returns null otherwise). First provider to claim an
 * env name wins; later collisions are skipped with a warning (v1's `claimed`
 * map). Reserved / malformed names are dropped before they reach the env.
 */
export function materializeGroupCredentialEnv(groupScope: GroupScope): Record<string, string> {
  const engine = getTokenEngine();
  const env: Record<string, string> = {};
  const claimedBy = new Map<string, string>(); // envName → providerId

  // Scope-aware: includes the group's per-group `.auth-discovery/` providers
  // when present in the scope tier. (At spawn the container has no IP yet, so
  // per-group providers aren't loaded — the tier is empty and this yields the
  // global set; per-group env then arrives at runtime via get_credential.)
  for (const provider of getAllCredentialProviders(asCredentialScope(groupScope))) {
    if (!isSubstitutingProvider(provider)) continue;
    // The agent runtime injects its own credential env at spawn (Claude:
    // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN). Skip so we never
    // double-publish the same name; v1 kept builtin vs discovery disjoint.
    if (provider.getExtension?.(AGENT_RUNTIME)) continue;

    const bindings = provider.substitutes.envBindings?.() ?? [];
    if (bindings.length === 0) continue;

    // Mint one substitute per credentialPath, shared across that path's
    // bindings (composite credentials declare several). `null` ⇒ no stored
    // credential for the group → skip every binding on that path.
    const subByPath = new Map<string, string | null>();
    for (const b of bindings) {
      let sub = subByPath.get(b.credentialPath);
      if (sub === undefined) {
        const names = provider.substitutes.envNamesFor(b.credentialPath);
        sub = engine.getOrCreateSubstitute(
          provider.id,
          {},
          groupScope,
          b.credentialPath,
          names.length > 0 ? [...names] : undefined,
        );
        subByPath.set(b.credentialPath, sub);
      }
      if (!sub) continue;

      if (validateEnvVarFormat(b.envName) || isReservedEnvName(b.envName)) {
        logger.warn(
          { envName: b.envName, providerId: provider.id },
          'credential-env: skipping reserved or malformed env name',
        );
        continue;
      }
      const owner = claimedBy.get(b.envName);
      if (owner && owner !== provider.id) {
        logger.warn(
          { envName: b.envName, providerId: provider.id, owner },
          'credential-env: env name already claimed by another provider, skipping',
        );
        continue;
      }

      // `envValueFor` materializes the (possibly sliced) value from the
      // substitute. The default impl ignores the credential; we resolve it
      // anyway so a provider with a credential-derived value still works.
      const credential = engine.resolveCredential(groupScope, provider.id, b.credentialPath);
      if (!credential) continue; // substitute existed but credential vanished
      const value = provider.substitutes.envValueFor?.(b.envName, sub, credential);
      if (value == null) continue; // sliced binding with too few parts, or no value
      env[b.envName] = value;
      claimedBy.set(b.envName, provider.id);
    }
  }

  return env;
}

registerAgentGroupContribution('credential-env', (ctx) => {
  const env = materializeGroupCredentialEnv(asGroupScope(ctx.agentGroup.folder));
  return Object.keys(env).length > 0 ? { env } : {};
});
