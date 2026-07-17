/**
 * scripts/sweep/scope-guard.ts — the automerge-vs-resolved subset check
 * (PROPAGATION.md §7, D-038).
 *
 * On `resolve`, the driver computes `git diff --name-only <automerge-tree>
 * <resolved-tree>`; that set MUST be a subset of the case's conflicted paths.
 * Any extra path means the agent touched files outside the conflict and the
 * tier auto-demotes (MECHANICAL->JUDGED, JUDGED->HELD) — no discussion,
 * journaled. File-level is the enforced check; hunk-level review belongs to the
 * cold reader.
 */
import { git } from './git.js';

export interface ScopeGuardResult {
  ok: boolean;
  /** Paths the resolution changed that are NOT in the case's conflicted set. */
  extraPaths: string[];
  /** All paths that differ between the automerge tree and the resolved tree. */
  changedPaths: string[];
}

/** `git diff --name-only` between two trees (or commits). */
async function diffNameOnly(repo: string, a: string, b: string): Promise<string[]> {
  const res = await git(repo, ['diff', '--name-only', a, b]);
  return res.stdout.split('\n').filter(Boolean);
}

/**
 * Enforce the scope guard. `conflictedPaths` is the case's conflicted-path set;
 * the resolution may only touch files within it.
 */
export async function scopeGuard(
  repo: string,
  automergeTree: string,
  resolvedTree: string,
  conflictedPaths: string[],
): Promise<ScopeGuardResult> {
  const allowed = new Set(conflictedPaths);
  const changedPaths = await diffNameOnly(repo, automergeTree, resolvedTree);
  const extraPaths = changedPaths.filter((p) => !allowed.has(p));
  return { ok: extraPaths.length === 0, extraPaths, changedPaths };
}
