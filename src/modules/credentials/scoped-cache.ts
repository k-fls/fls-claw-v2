/**
 * Three-level in-memory cache: scope → providerId → credentialId → V.
 *
 * Pure in-memory primitive — no filesystem, no encryption, no
 * lifecycle. The resolver (C7r) instantiates one of these per
 * agent-group resolver and uses it to hold encrypted-value Credential
 * objects between disk reads.
 *
 * Eviction is explicit: callers (or the scope-invalidator hook the
 * resolver registers) drop entries via `evict(scope[, providerId])`.
 * There is no TTL. Entries live until the cache is evicted or the
 * owning resolver is disposed.
 */
import type { CredentialScope } from './types.js';

export class ScopedCache<V> {
  private readonly data = new Map<CredentialScope, Map<string, Map<string, V>>>();

  get(scope: CredentialScope, providerId: string, id: string): V | undefined {
    return this.data.get(scope)?.get(providerId)?.get(id);
  }

  set(scope: CredentialScope, providerId: string, id: string, value: V): void {
    let scopeMap = this.data.get(scope);
    if (!scopeMap) {
      scopeMap = new Map();
      this.data.set(scope, scopeMap);
    }
    let provMap = scopeMap.get(providerId);
    if (!provMap) {
      provMap = new Map();
      scopeMap.set(providerId, provMap);
    }
    provMap.set(id, value);
  }

  /** Drop everything for `scope` — or, if `providerId` given, just that provider. */
  evict(scope: CredentialScope, providerId?: string): void {
    if (providerId === undefined) {
      this.data.delete(scope);
      return;
    }
    this.data.get(scope)?.delete(providerId);
  }

  clear(): void {
    this.data.clear();
  }

  /** Total entry count across all scopes/providers. */
  get size(): number {
    let n = 0;
    for (const scopeMap of this.data.values()) {
      for (const provMap of scopeMap.values()) {
        n += provMap.size;
      }
    }
    return n;
  }
}
