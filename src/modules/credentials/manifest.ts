/**
 * Manifest pipeline (C7s).
 *
 * Every credential scope advertises what it offers via JSONL manifest
 * files — one per providerId — written to
 *   credentials/{scope}/manifests/{providerId}.jsonl
 * by `provider.buildManifest`. The pipeline then copies (fire-and-forget)
 * each manifest into every grantee's
 *   groups/{grantee}/credentials/granted/{grantor}/{providerId}.jsonl
 * so grantees see what their grantor has on offer without ever holding the
 * underlying credentials. The grantor's folder is `scope` in v2 — the two
 * strings are equal at the runtime boundary.
 *
 * Lifecycle hooks (`onManifestWritten`, `onManifestDeleted`) fire after
 * the source manifest file has been written or deleted. Provider-specific
 * side effects (e.g. SSH mirroring the manifest into the group dir for a
 * container mount) live in those hooks, not in this module.
 *
 * Pure I/O — no proxy, no DB. Module import performs no filesystem work.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';

import { credentialsDir, listProviderIds, listScopes, scopeDir } from './store.js';
import { getCredentialProvider } from './providers/registry.js';
import { grantedDir, listGrantees } from './grants.js';
import { asCredentialScope } from './types.js';
import type { CredentialScope } from './types.js';

function manifestDir(scope: CredentialScope): string {
  return path.join(scopeDir(scope), 'manifests');
}

// ── First-use regeneration ──────────────────────────────────────────────────
//
// Per the C7s brief: import-time is filesystem-side-effect-free, but the
// first real consumer call into the pipeline should sweep the on-disk
// keys files and rewrite their manifests. That picks up provider-shape
// changes across restarts without any code touching the host startup.
//
// We trip the flag *before* the call's own work so a single invocation
// doesn't recurse: regenerate sees the just-written file too, but
// rewriting its manifest is identical to what the caller is about to do.

let regenScheduled = false;

function ensureRegenOnce(): void {
  if (regenScheduled) return;
  regenScheduled = true;
  try {
    regenerateAllManifestsImpl();
  } catch (err) {
    log.warn('manifest pipeline: first-use regenerate failed', { err });
  }
}

function manifestPath(scope: CredentialScope, providerId: string): string {
  return path.join(manifestDir(scope), `${providerId}.jsonl`);
}

// ── Source-side writes ──────────────────────────────────────────────────────

function writeManifestFile(scope: CredentialScope, providerId: string, lines: readonly string[]): void {
  fs.mkdirSync(manifestDir(scope), { recursive: true });
  // Empty list still writes an (empty) file so readers can distinguish
  // "advertised but empty" from "never advertised."
  const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
  fs.writeFileSync(manifestPath(scope, providerId), body);
}

function deleteManifestFile(scope: CredentialScope, providerId: string): void {
  try {
    fs.unlinkSync(manifestPath(scope, providerId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ── Grantee-side copy / delete (fire-and-forget) ────────────────────────────

function copyToGrantee(scope: CredentialScope, providerId: string, granteeFolder: string): void {
  const src = manifestPath(scope, providerId);
  if (!fs.existsSync(src)) return;
  const dir = grantedDir(granteeFolder, scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, `${providerId}.jsonl`));
}

function deleteFromGrantee(scope: CredentialScope, providerId: string, granteeFolder: string): void {
  try {
    fs.unlinkSync(path.join(grantedDir(granteeFolder, scope), `${providerId}.jsonl`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function asyncDistribute(scope: CredentialScope, providerId: string, mode: 'copy' | 'delete'): void {
  const grantees = listGrantees(scope);
  if (grantees.length === 0) return;
  Promise.resolve().then(() => {
    for (const grantee of grantees) {
      try {
        if (mode === 'copy') copyToGrantee(scope, providerId, grantee);
        else deleteFromGrantee(scope, providerId, grantee);
      } catch (err) {
        log.warn(`manifest ${mode} to grantee failed`, {
          err,
          scope: scope,
          providerId,
          grantee,
        });
      }
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Called after a keys file (scope, providerId) is written or updated.
 * Rebuilds the manifest via the registered provider, fires
 * `onManifestWritten`, then fans out a fire-and-forget copy to each
 * grantee.
 *
 * If no provider is registered for `providerId`, logs a warn and skips —
 * the keys-file write itself is not undone (writes happen before the
 * manifest pipeline kicks).
 */
export function onKeysFileWritten(scope: CredentialScope, providerId: string): void {
  ensureRegenOnce();
  const provider = getCredentialProvider(providerId);
  if (!provider) {
    log.warn('manifest pipeline: no provider registered — skipping', {
      providerId,
      scope: scope,
    });
    return;
  }

  let lines: string[];
  try {
    lines = provider.buildManifest(scope);
  } catch (err) {
    log.warn('manifest pipeline: buildManifest threw', {
      err,
      providerId,
      scope: scope,
    });
    return;
  }

  try {
    writeManifestFile(scope, providerId, lines);
  } catch (err) {
    log.warn('manifest pipeline: write failed', {
      err,
      providerId,
      scope: scope,
    });
    return;
  }

  try {
    provider.onManifestWritten(scope);
  } catch (err) {
    log.warn('manifest pipeline: onManifestWritten threw', {
      err,
      providerId,
      scope: scope,
    });
  }

  asyncDistribute(scope, providerId, 'copy');
}

/**
 * Called after a keys file is deleted. With `providerId`, removes just
 * that one manifest + grantee copies. Without it, removes the entire
 * manifests/ directory and every grantee's `granted/{grantor}/` dir.
 */
export function onKeysFileDeleted(scope: CredentialScope, providerId?: string): void {
  ensureRegenOnce();
  if (providerId) {
    deleteManifestFile(scope, providerId);
    const provider = getCredentialProvider(providerId);
    if (provider) {
      try {
        provider.onManifestDeleted(scope);
      } catch (err) {
        log.warn('manifest pipeline: onManifestDeleted threw', {
          err,
          providerId,
          scope: scope,
        });
      }
    }
    asyncDistribute(scope, providerId, 'delete');
    return;
  }

  // Whole-scope delete.
  try {
    fs.rmSync(manifestDir(scope), { recursive: true, force: true });
  } catch (err) {
    log.warn('manifest pipeline: scope dir remove failed', {
      err,
      scope: scope,
    });
  }

  const grantees = listGrantees(scope);
  if (grantees.length === 0) return;
  Promise.resolve().then(() => {
    for (const grantee of grantees) {
      try {
        fs.rmSync(grantedDir(grantee, scope), {
          recursive: true,
          force: true,
        });
      } catch (err) {
        log.warn('manifest pipeline: grantee dir remove failed', {
          err,
          scope: scope,
          grantee,
        });
      }
    }
  });
}

/**
 * Copy every existing manifest from `grantorFolder` to `granteeFolder`.
 * Called by `/creds share` immediately after adding the grantee. Best
 * effort — failures are logged at warn.
 */
export function distributeAllManifests(grantorFolder: string, granteeFolder: string): void {
  const scope = asCredentialScope(grantorFolder);
  const dir = manifestDir(scope);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn('manifest pipeline: distributeAllManifests readdir failed', {
      err,
      grantorFolder,
      granteeFolder,
    });
    return;
  }
  for (const file of files) {
    const m = /^(.+)\.jsonl$/.exec(file);
    if (!m) continue;
    try {
      copyToGrantee(scope, m[1], granteeFolder);
    } catch (err) {
      log.warn('manifest pipeline: copyToGrantee failed', {
        err,
        grantorFolder,
        granteeFolder,
        providerId: m[1],
      });
    }
  }
}

/**
 * Remove every manifest copy under `groups/{granteeFolder}/credentials/granted/{grantorFolder}/`.
 * Called by `/creds revoke`.
 */
export function revokeGranteeManifests(grantorFolder: string, granteeFolder: string): void {
  try {
    fs.rmSync(grantedDir(granteeFolder, grantorFolder), { recursive: true, force: true });
  } catch (err) {
    log.warn('manifest pipeline: revokeGranteeManifests failed', {
      err,
      grantorFolder,
      granteeFolder,
    });
  }
}

/**
 * Walk `credentialsDir()` and rewrite every manifest from the current
 * keys-file state. Called from `index.ts` on first consumer call into
 * the pipeline (lazy — module import remains side-effect-free).
 *
 * Skips providerIds with no registered provider — the corresponding
 * manifest is left untouched rather than wiped, so a temporarily
 * unloaded skill doesn't lose its advertised entries.
 */
export function regenerateAllManifests(): void {
  regenerateAllManifestsImpl();
}

/** Test-only: reset the once-flag so the next pipeline call sweeps again. */
export function _resetRegenForTests(): void {
  regenScheduled = false;
}

function regenerateAllManifestsImpl(): void {
  for (const scope of listScopes()) {
    for (const providerId of listProviderIds(scope)) {
      const provider = getCredentialProvider(providerId);
      if (!provider) {
        log.warn('manifest pipeline: regenerate skipping unregistered provider', {
          providerId,
          scope: scope,
        });
        continue;
      }
      try {
        const lines = provider.buildManifest(scope);
        writeManifestFile(scope, providerId, lines);
        provider.onManifestWritten(scope);
      } catch (err) {
        log.warn('manifest pipeline: regenerate failed for entry', {
          err,
          scope: scope,
          providerId,
        });
      }
    }
  }
}
