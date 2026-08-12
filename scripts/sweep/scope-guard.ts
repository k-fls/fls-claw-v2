/**
 * scripts/sweep/scope-guard.ts — the automerge-vs-resolved scope check
 * (DRIVER.md §7.4).
 *
 * On `resolve`, the driver computes `git diff --name-only <automerge-tree>
 * <resolved-tree>` and enforces the configured mode:
 *  - `same-files` (DEFAULT): the changed set must be a subset of the recomputed
 *    conflicted FILES; edits anywhere inside those files pass (hunk-level review
 *    belongs to the cold reader). Any extra file → HELD, no merge.
 *  - `conflict-hunks` (strict, opt-in): additionally, within each conflicted
 *    file the CHANGED line regions (automerge side) must lie inside the
 *    conflict-marker spans of the automerge blob (inclusive of the marker lines
 *    themselves — resolving deletes them). Edits elsewhere in the file → HELD.
 *
 * The effective mode is re-derived from config at resolve, never read from the
 * agent-writable case file.
 */
import { git } from './git.js';
import type { ScopeGuardMode } from './types.js';

export interface ScopeGuardResult {
  ok: boolean;
  mode: ScopeGuardMode;
  /** Paths the resolution changed that are NOT in the conflicted set. */
  extraPaths: string[];
  /** All paths that differ between the automerge tree and the resolved tree. */
  changedPaths: string[];
  /** conflict-hunks only: conflicted files edited outside their marker regions. */
  hunkViolations: string[];
}

/** `git diff --name-only` between two trees (or commits). */
async function diffNameOnly(repo: string, a: string, b: string): Promise<string[]> {
  const res = await git(repo, ['diff', '--name-only', a, b]);
  return res.stdout.split('\n').filter(Boolean);
}

/** Line numbers (1-based) inside conflict-marker spans of the automerge blob. */
function markerLines(blob: string): Set<number> {
  const lines = blob.split('\n');
  const marked = new Set<number>();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('<<<<<<<'))
      start = i + 1; // 1-based
    else if (l.startsWith('>>>>>>>') && start >= 0) {
      for (let n = start; n <= i + 1; n++) marked.add(n);
      start = -1;
    }
  }
  return marked;
}

/**
 * Automerge-side changed ranges from the diff hunks. Each `@@ -a,b +c,d @@`
 * yields the old-side range: [a, a+b-1] for b>0 (deletions/replacements), or the
 * insertion anchor `a` for b==0 (pure insertion between old lines a and a+1).
 */
function changedOldRanges(diffText: string): Array<{ start: number; count: number }> {
  const ranges: Array<{ start: number; count: number }> = [];
  for (const line of diffText.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m) ranges.push({ start: parseInt(m[1], 10), count: m[2] === undefined ? 1 : parseInt(m[2], 10) });
  }
  return ranges;
}

async function hunkWithinMarkers(
  repo: string,
  automergeTree: string,
  resolvedTree: string,
  path: string,
): Promise<boolean> {
  const blobRes = await git(repo, ['cat-file', '-p', `${automergeTree}:${path}`], { allowCodes: [128] });
  if (blobRes.code !== 0) return false; // path missing on the automerge side is out-of-scope
  const marked = markerLines(blobRes.stdout);
  // -U0: zero context so hunk ranges contain ONLY changed lines (context lines
  // would otherwise widen the range past the conflict markers).
  const diff = await git(repo, ['diff', '--no-color', '-U0', automergeTree, resolvedTree, '--', path]);
  for (const r of changedOldRanges(diff.stdout)) {
    if (r.count > 0) {
      for (let n = r.start; n <= r.start + r.count - 1; n++) if (!marked.has(n)) return false;
    } else {
      // Pure insertion at anchor `a`: it is inside a conflict block only when
      // both boundary lines (a and a+1) are marker lines.
      if (!marked.has(r.start) || !marked.has(r.start + 1)) return false;
    }
  }
  return true;
}

/**
 * Enforce the scope guard. `conflictedPaths` is the RECOMPUTED conflicted-file
 * set; `mode` is re-derived from config (never the case file).
 */
export async function scopeGuard(
  repo: string,
  automergeTree: string,
  resolvedTree: string,
  conflictedPaths: string[],
  mode: ScopeGuardMode = 'same-files',
  opts: {
    /**
     * Allowed paths that must NOT be hunk-checked in `conflict-hunks` mode —
     * files the driver itself added to the scope (`--not-my-bug` widening, where
     * both sides of the merge are green and only the merged tree is red). They
     * carry no conflict markers, so `markerLines` is empty for them and EVERY
     * edit reads as a hunk violation: the widening would be inert, turning an
     * extra-file violation into a hunk violation with the same HELD outcome.
     * File-level allowed is the entire point for these.
     */
    hunkExempt?: string[];
  } = {},
): Promise<ScopeGuardResult> {
  const allowed = new Set(conflictedPaths);
  const exempt = new Set(opts.hunkExempt ?? []);
  const changedPaths = await diffNameOnly(repo, automergeTree, resolvedTree);
  const extraPaths = changedPaths.filter((p) => !allowed.has(p));
  const hunkViolations: string[] = [];
  if (mode === 'conflict-hunks') {
    for (const p of changedPaths) {
      if (!allowed.has(p) || exempt.has(p)) continue; // extra-file violation already, or driver-widened
      if (!(await hunkWithinMarkers(repo, automergeTree, resolvedTree, p))) hunkViolations.push(p);
    }
  }
  return { ok: extraPaths.length === 0 && hunkViolations.length === 0, mode, extraPaths, changedPaths, hunkViolations };
}
