/**
 * Spawn-time credential-provider validation.
 *
 * An agent runtime declares — via its provider's `AGENT_RUNTIME` extension —
 * which credential providers it requires (`requiredCredentialProviders`). This
 * `onSpawnPre` lifecycle observer fails the spawn fast with a `FatalSpawnError`
 * when a `required` credential provider is not bound to the group, so a missing
 * credential surfaces as a clear, non-retryable error *before* the container is
 * created — rather than as an opaque 401 on the first API call.
 *
 * Dormant until a provider declares an `AGENT_RUNTIME` extension: providers
 * without one make this a no-op, so it never regresses spawns.
 */
import { FatalSpawnError } from '../../spawn-failure.js';
import { registerContainerLifecycleObserver, type SpawnPreContext } from '../container-bootstrap/index.js';

import { getCredentialProvider } from './providers/registry.js';
import { AGENT_RUNTIME, type AgentRuntimeExt } from './providers/types.js';
import { listProviderIds } from './store.js';
import { asCredentialScope } from './types.js';

/**
 * Validate that every `required` credential provider the runtime declares is
 * present in the group's bound set. Pure — all I/O is injected — so the policy
 * is unit-testable without the registry, the credential store, or the
 * lifecycle pipeline. Throws `FatalSpawnError` naming the missing ids.
 *
 * No-op when the provider declares no agent-runtime extension (`getRuntime`
 * returns undefined); `hasProvider` is then never consulted.
 */
export function validateRuntimeCredentials(opts: {
  providerName: string;
  runtimeConfigRaw: unknown;
  getRuntime: (providerName: string) => AgentRuntimeExt | undefined;
  hasProvider: (credentialProviderId: string) => boolean;
}): void {
  const runtime = opts.getRuntime(opts.providerName);
  if (!runtime) return;

  const runtimeConfig = runtime.parseRuntimeConfig(opts.runtimeConfigRaw);
  const missing = runtime
    .requiredCredentialProviders(runtimeConfig)
    .filter((r) => r.required && !opts.hasProvider(r.id))
    .map((r) => r.id);

  if (missing.length > 0) {
    throw new FatalSpawnError(
      `Agent runtime '${opts.providerName}' requires credential provider(s) not bound to this group: ${missing.join(', ')}`,
    );
  }
}

/** Resolve a provider's `AGENT_RUNTIME` extension from the credential registry. */
export function runtimeFor(providerName: string): AgentRuntimeExt | undefined {
  return getCredentialProvider(providerName)?.getExtension?.(AGENT_RUNTIME);
}

/**
 * The group's bound credential providers ("has" set) — today the providers
 * with a keys file under the group's own folder scope.
 *
 * NOTE (refine before enforcement is relied on): if a group can *borrow*
 * a required provider's credential (grant/borrow), this set must also
 * consult borrow state / the resolver, or a borrowing group would be
 * false-rejected. Safe to defer while the validator is dormant.
 */
function boundProviderIds(folder: string): Set<string> {
  return new Set(listProviderIds(asCredentialScope(folder)));
}

registerContainerLifecycleObserver('provider-runtime-validation', {
  onSpawnPre(ctx: SpawnPreContext) {
    // Compute the (FS-backed) has-set lazily and once — skipped entirely in the
    // common no-op case where the provider declares no agent-runtime extension.
    let cached: Set<string> | undefined;
    validateRuntimeCredentials({
      providerName: ctx.providerName,
      runtimeConfigRaw: ctx.containerConfig.runtimeConfig ?? {},
      getRuntime: runtimeFor,
      hasProvider: (id) => (cached ??= boundProviderIds(ctx.agentGroup.folder)).has(id),
    });
  },
});
