/**
 * Default helpers a CredentialProvider composes when it has no
 * provider-specific manifest behavior.
 *
 *   defaultManifestBuilder(id) — closes over the providerId and returns
 *     a builder that reads `{scope}/{id}.json` via the store and emits
 *     one JSONL line per top-level entry (skipping the `v` version
 *     marker).
 *
 *   noManifestSideEffect — no-op lifecycle hook. Providers that don't
 *     need post-write/delete side effects pass this for
 *     onManifestWritten / onManifestDeleted.
 *
 * Both are explicit imports — there is no fallback path inside the
 * registry. A registered provider always supplies all three methods.
 */
import { readKeysFile, ENTRY_VERSION_KEY } from '../store.js';
import type { CredentialScope } from '../types.js';

export function defaultManifestBuilder(providerId: string): (scope: CredentialScope) => string[] {
  return (scope) => {
    const keys = readKeysFile(scope, providerId);
    const out: string[] = [];
    for (const [name, entry] of Object.entries(keys)) {
      if (name === ENTRY_VERSION_KEY) continue;
      // Match the fork's defensive filter (auth/manifest.ts:81): only
      // advertise entries that are real objects. Skips half-written
      // primitives and lets providers with non-object shapes opt out by
      // not using the default builder.
      if (!entry || typeof entry !== 'object') continue;
      out.push(JSON.stringify({ provider: providerId, name }));
    }
    return out;
  };
}

export function noManifestSideEffect(_scope: CredentialScope): void {
  // Intentionally empty.
}
