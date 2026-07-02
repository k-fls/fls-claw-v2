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
import { effectiveRouting, listEnabledBrokerIds } from '../../db/broker-config.js';
import { FatalSpawnError } from '../../spawn-failure.js';
import { registerContainerLifecycleObserver, type SpawnPreContext } from '../container-bootstrap/index.js';

import { availableProviderIds } from './provider-availability.js';
import { getCredentialProvider } from './providers/registry.js';
import { AGENT_RUNTIME, type AgentRuntimeExt } from './providers/types.js';

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
  /**
   * Whether a credential broker supplies this provider for the group (C3). A
   * required provider missing from the native has-set must NOT hard-fail when
   * a broker overtakes it — the broker supplies the credential at request time,
   * a real miss then surfaces as a 401. Defaults to never (no broker), so the
   * dormant/native case is unchanged.
   */
  brokerSupplies?: (credentialProviderId: string) => boolean;
}): void {
  const runtime = opts.getRuntime(opts.providerName);
  if (!runtime) return;

  const brokerSupplies = opts.brokerSupplies ?? (() => false);
  const runtimeConfig = runtime.parseRuntimeConfig(opts.runtimeConfigRaw);
  const missing = runtime
    .requiredCredentialProviders(runtimeConfig)
    .filter((r) => r.required && !opts.hasProvider(r.id) && !brokerSupplies(r.id))
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
 * Does any enabled broker overtake `providerId` for this group (folder)?
 * Pre-spawn there is no container IP yet, so this resolves by folder via
 * `effectiveRouting` (the per-group merged routing). Catch-all is irrelevant
 * here — a required *provider* is covered space, only an explicit overtake of
 * its id means the broker supplies it.
 */
function brokerSuppliesProvider(folder: string, providerId: string): boolean {
  for (const brokerId of listEnabledBrokerIds()) {
    if (effectiveRouting(brokerId, folder).overtake.includes(providerId)) return true;
  }
  return false;
}

registerContainerLifecycleObserver('provider-runtime-validation', {
  onSpawnPre(ctx: SpawnPreContext) {
    // Compute the has-set lazily and once — skipped entirely in the common
    // no-op case where the provider declares no agent-runtime extension.
    // Borrow-aware (`availableProviderIds`): a group borrowing a required
    // provider from a granting source passes, matching the runtime resolver —
    // otherwise a borrowing group with no own keys would be false-rejected.
    let cached: Set<string> | undefined;
    validateRuntimeCredentials({
      providerName: ctx.providerName,
      runtimeConfigRaw: ctx.containerConfig.runtimeConfig ?? {},
      getRuntime: runtimeFor,
      hasProvider: (id) => (cached ??= availableProviderIds(ctx.agentGroup.folder)).has(id),
      brokerSupplies: (id) => brokerSuppliesProvider(ctx.agentGroup.folder, id),
    });
  },
});
