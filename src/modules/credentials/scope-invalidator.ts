/**
 * Scope invalidator registry (C7s/C7r).
 *
 * Three triggers fire `invalidateScope(scope)`:
 *
 *   1. `/creds borrow`, `/creds revoke`, `/creds stop-borrowing` — grant
 *      state mutations. Issued by the command body in commands/creds.ts.
 *   2. `store.writeKeysFile(scope, ...)` and `store.deleteKeysFile(scope, ...)`
 *      — credential content mutations. Issued by the store so the
 *      resolver layer cannot serve stale cached entries when another
 *      writer updates the same on-disk file.
 *   3. Future C2 proxy invalidations as substitute mappings change.
 *
 * Consumers register `(CredentialScope) => void` callbacks. The resolver
 * (C7r) registers a callback that evicts the scope from its in-memory
 * cache; the proxy will later register one that revokes substitutes.
 *
 * Default state: empty. Failures inside a callback are caught and
 * logged at warn so one misbehaving consumer cannot block the rest.
 *
 * Note on axis: invalidation is keyed by **CredentialScope** (the
 * on-disk storage location), not GroupScope. A write to scope A must
 * invalidate every cached entry under A regardless of which GroupScope
 * cached it.
 */
import { log } from '../../log.js';

import type { CredentialScope } from './types.js';

export type ScopeInvalidator = (scope: CredentialScope) => void;

const invalidators: ScopeInvalidator[] = [];

export function registerScopeInvalidator(cb: ScopeInvalidator): () => void {
  invalidators.push(cb);
  return () => {
    const i = invalidators.indexOf(cb);
    if (i >= 0) invalidators.splice(i, 1);
  };
}

export function invalidateScope(scope: CredentialScope): void {
  for (const cb of invalidators) {
    try {
      cb(scope);
    } catch (err) {
      log.warn('scope invalidator threw', { err, scope: scope });
    }
  }
}

/** Test-only: clear all registered invalidators. */
export function _resetScopeInvalidatorsForTests(): void {
  invalidators.length = 0;
}
