/**
 * Container-tree snapshot.
 *
 * Copy `process.cwd()/container/` → `DATA_DIR/snapshot/container/` once at
 * host boot. Containers mount from the snapshot, not the live tree, so mid-
 * run host edits (e.g. a `git pull` while sessions are open) don't disturb
 * in-flight containers. The snapshot is regenerated on every host start, so
 * the next batch of containers picks up the new tree.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

let initialized = false;

function snapshotRoot(): string {
  return path.join(DATA_DIR, 'snapshot', 'container');
}

function sourceRoot(): string {
  return path.join(process.cwd(), 'container');
}

/**
 * Copy `container/` into the snapshot location. Idempotent across host
 * restarts: any existing snapshot is removed and recreated so `git pull`
 * between restarts always wins. `node_modules` is excluded — agent-runner
 * deps are installed inside the image, not mounted from host.
 */
export function initSnapshot(): void {
  const src = sourceRoot();
  if (!fs.existsSync(src)) {
    log.warn('container-bootstrap: source container/ tree not found, snapshot skipped', { src });
    initialized = false;
    return;
  }

  fs.rmSync(snapshotRoot(), { recursive: true, force: true });
  fs.mkdirSync(snapshotRoot(), { recursive: true });

  fs.cpSync(src, snapshotRoot(), {
    recursive: true,
    preserveTimestamps: true,
    filter: (s) => {
      const base = path.basename(s);
      return base !== 'node_modules';
    },
  });

  // Post-copy invariants. cpSync can leave a partial tree on disk-full / EIO /
  // permission edge cases; an entrypoint or agent-runner that exists in the
  // source but went missing in the snapshot would otherwise surface only as
  // an opaque container-side failure (image's fail-loud stub for entrypoint,
  // or `bun: cannot find /app/src/index.ts` in agent stderr that the host
  // never sees since logs are lost on `--rm`). Catch it at boot.
  const required = ['entrypoint.sh', path.join('agent-runner', 'src', 'index.ts')];
  for (const rel of required) {
    const full = path.join(snapshotRoot(), rel);
    if (!fs.existsSync(full)) {
      throw new Error(
        `container-bootstrap: snapshot is missing required path "${rel}" — ` +
          `host container/ tree may be corrupted or the copy was interrupted`,
      );
    }
  }

  initialized = true;
  log.info('container-bootstrap: snapshot ready', { path: snapshotRoot() });
}

/**
 * Resolve a path inside the snapshot. Throws if `initSnapshot()` wasn't run
 * (or its source dir was missing) — catches misuse early rather than letting
 * Docker fail with a confusing missing-mount error later.
 */
export function snapshotPath(relative = ''): string {
  if (!initialized) {
    throw new Error('container-bootstrap: snapshot not initialized — call initSnapshot() at host boot');
  }
  return relative ? path.join(snapshotRoot(), relative) : snapshotRoot();
}

/** @internal — for tests. */
export function __resetSnapshotForTests(): void {
  initialized = false;
  fs.rmSync(snapshotRoot(), { recursive: true, force: true });
}
