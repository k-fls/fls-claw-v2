/**
 * Copy non-`.ts` runtime assets from `src/` into `dist/`, mirroring the tree.
 *
 * `tsc` only emits `.js` for `.ts` inputs — it leaves sibling data files behind.
 * Several modules read such files at runtime relative to their compiled location
 * (e.g. `oauth/discovery-paths.ts` resolves `path.join(HERE, 'discovery')`, and
 * the per-module instruction docs `agent.md` / `project.md`). Under tsx (dev)
 * `HERE` points back into `src/`, so dev works without this; only the compiled
 * `dist/` build needs the copy. Zero-dep on purpose (supply-chain policy).
 *
 * Wired into `build` after `tsc`. Idempotent — overwrites, never deletes.
 */
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

let copied = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (entry.name.endsWith('.ts')) continue; // compiled by tsc
    const dest = join(DIST, relative(SRC, p));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p, dest);
    copied++;
  }
}

walk(SRC);
console.log(`copy-assets: ${copied} non-.ts asset(s) copied src/ -> dist/`);
