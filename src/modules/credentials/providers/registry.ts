/**
 * Credential provider registry — storage-namespace participants.
 *
 * Every providerId stored under {scope}/{providerId}.json has a
 * registered CredentialProvider. The provider fully controls how its
 * JSONL manifest is built and what fires after the manifest file is
 * written or deleted on disk.
 *
 * The credential provider is the **provider entity**: capabilities beyond
 * the credential namespace (agent runtime, OAuth producer, reauth driver,
 * MITM-response feedback, per-container state) attach as typed
 * **extensions** retrieved via `getExtension(...)` — see `./types.ts`. The
 * MITM substitution capability is the separate `SubstitutingProvider`
 * subtype (its `substitutes` property), not an extension.
 *
 * Duplicate-id registrations throw — a duplicate is always a bug (two
 * import paths installing the same provider), not a configuration.
 */
import type { CredentialScope } from '../types.js';

import type { ExtensionType } from './types.js';

export interface CredentialProvider {
  readonly id: string;

  /** Build the JSONL manifest content for this provider in this scope. */
  buildManifest(scope: CredentialScope): string[];

  /** Fires after the manifest file is written to disk. */
  onManifestWritten(scope: CredentialScope): void;

  /** Fires after the manifest file is deleted. */
  onManifestDeleted(scope: CredentialScope): void;

  /**
   * Retrieve a typed capability extension this provider declares (agent
   * runtime, producer, reauth, feedback, per-container state, …). Optional:
   * providers with no extra capabilities omit it. Build one with
   * `new ExtensionBag()` and pass `bag.get` (see `./types.ts`).
   */
  getExtension?<T>(type: ExtensionType<T>): T | undefined;
}

const providers = new Map<string, CredentialProvider>();

/**
 * Per-scope provider tier — the providers a single agent group declares in
 * its `.auth-discovery/` directory. Unlike the global tier above (Claude,
 * GitHub, the discovery defaults — shared by every scope), these are
 * group-local: a provider only group A declares must be invisible to, and
 * un-mintable from, group B. Keyed by the group's credential scope.
 *
 * Lookups consult this tier first (it shadows the global tier for the same
 * id), then fall back to global. This is the home that lets every
 * registry-driven surface — `getOrCreateSubstitute` minting, the
 * `/substitute` endpoint — see per-group providers, instead of the proxy's
 * IP-keyed routing tier being their only home (where the SubstitutesSpec was
 * discarded and minting silently failed, leaking the real token).
 */
const scopedProviders = new Map<CredentialScope, Map<string, CredentialProvider>>();

export function registerCredentialProvider(p: CredentialProvider): void {
  if (providers.has(p.id)) {
    throw new Error(`Credential provider '${p.id}' already registered`);
  }
  providers.set(p.id, p);
}

export function getCredentialProvider(id: string, scope?: CredentialScope): CredentialProvider | undefined {
  if (scope !== undefined) {
    const hit = scopedProviders.get(scope)?.get(id);
    if (hit) return hit;
  }
  return providers.get(id);
}

export function getAllCredentialProviders(scope?: CredentialScope): CredentialProvider[] {
  if (scope === undefined) return Array.from(providers.values());
  const tier = scopedProviders.get(scope);
  if (!tier) return Array.from(providers.values());
  // Scope tier shadows global for a shared id (the group's own view wins).
  const merged = new Map(providers);
  for (const [id, p] of tier) merged.set(id, p);
  return Array.from(merged.values());
}

/**
 * Replace the per-scope provider tier for `scope` — called on every per-group
 * discovery load. Idempotent: re-loading a group's providers replaces the set
 * rather than throwing on duplicate ids (the global tier's throw guards against
 * double-registration bugs; a per-group reload is expected to repeat). An empty
 * list clears the tier.
 */
export function setScopedCredentialProviders(scope: CredentialScope, list: readonly CredentialProvider[]): void {
  if (list.length === 0) {
    scopedProviders.delete(scope);
    return;
  }
  const m = new Map<string, CredentialProvider>();
  for (const p of list) m.set(p.id, p);
  scopedProviders.set(scope, m);
}

/** Drop a scope's entire per-group provider tier (e.g. group teardown). */
export function clearScopedCredentialProviders(scope: CredentialScope): void {
  scopedProviders.delete(scope);
}

/** Test-only: clear all registrations. Not exported from the barrel. */
export function _resetProviderRegistryForTests(): void {
  providers.clear();
  scopedProviders.clear();
}
