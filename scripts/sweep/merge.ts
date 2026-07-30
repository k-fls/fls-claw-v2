/**
 * scripts/sweep/merge.ts — the shared rerere cache.
 *
 * The batch merge engine that used to live here (planMerges / executeMerges /
 * rollbackBranch, driven by the retired `sweep.ts merge|verify --rollback`
 * pipeline) is gone: the propagation driver does its own DAG-ordered merging
 * (`propagate.ts`, PROPAGATION.md §8) and its own §9 rollback. What survives is
 * the shared rerere cache — a plain directory in the group workspace, installed
 * into `.git/rr-cache` before merging and exported back after, so a conflict
 * resolved once at the topmost affected branch replays on every descendant
 * (D-006).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { gitCommonDir } from './git.js';

function collectRrCache(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Install the shared rerere cache from the workspace rr-cache directory
 * (local/ephemeral) into .git/rr-cache.
 */
export async function installRrCache(repo: string, rrSourceDir: string | null): Promise<number> {
  if (!rrSourceDir) return 0;
  const files = collectRrCache(rrSourceDir);
  const target = join(await gitCommonDir(repo), 'rr-cache');
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return Object.keys(files).length;
}

/** Write rr-cache entries (relative path -> content) into a workspace rr-cache dir. */
export function writeRrCacheDir(rrDir: string, files: Record<string, Buffer>): number {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(rrDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return Object.keys(files).length;
}

/** rr-cache entries in .git/rr-cache that are new/changed vs the given baseline (relative paths). */
export async function exportRrCache(repo: string, baseline: Record<string, Buffer>): Promise<Record<string, Buffer>> {
  const current = collectRrCache(join(await gitCommonDir(repo), 'rr-cache'));
  const changed: Record<string, Buffer> = {};
  for (const [rel, content] of Object.entries(current)) {
    if (!baseline[rel] || !baseline[rel].equals(content)) changed[rel] = content;
  }
  return changed;
}
