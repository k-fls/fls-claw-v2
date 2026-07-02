/**
 * Borrow-aware credential-provider availability.
 *
 * A group "has" a credential provider when either it holds a keys file in its
 * own scope OR it borrows one from a granting source. Both the wake-time
 * acquisition gate (`credential-acquisition.ts`) and the spawn-time validator
 * (`spawn-validation.ts`) must use this, not a raw own-folder `listProviderIds`:
 * once a borrowing group's own keys file is absent, an own-folder-only check
 * concludes "missing" and fires the acquire prompt / fails the spawn *before*
 * the borrow-aware runtime path (`getOrCreateSubstitute` → `resolveCredentialScope`
 * → own→grantor fallback → bearer-swap) ever runs.
 *
 * The borrow predicates here are exactly the ones the runtime resolver uses:
 * `getBorrowSource` (the grantor the group borrows from) gated by `canAccess`
 * (the grantor lists this borrower). So the gate's presence check and the
 * runtime's resolution agree — no per-borrower key copies, no staleness.
 */
import { getBorrowSource, canAccess } from './grants.js';
import { listProviderIds } from './store.js';
import { asCredentialScope } from './types.js';

/**
 * The set of credential-provider ids effectively available to `folder`: its own
 * stored providers, plus — when it borrows from a granting source — the
 * providers that source holds.
 */
export function availableProviderIds(folder: string): Set<string> {
  const ids = new Set(listProviderIds(asCredentialScope(folder)));
  const source = getBorrowSource(folder);
  if (source && canAccess(folder, source)) {
    for (const id of listProviderIds(asCredentialScope(source))) ids.add(id);
  }
  return ids;
}
