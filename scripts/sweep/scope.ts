/**
 * scripts/sweep/scope.ts — in-scope branch enumeration + DAG ordering.
 *
 * Scope = UNION of (registry feature entries' branches), (sweep-scope.yaml
 * include list) and (sweep-state.json branches with status active) —
 * fix/* upstream-PR candidates and docs/notes are swept in this fork's
 * practice but have no feature entry, so they enter via the state file
 * (with a null feature link). Exclusions from config + sweep-scope.yaml
 * apply to all sources. DAG edges come from entry parents/dependents plus
 * scope.extra_edges; order = parents before children (topological), with
 * main_patched forced first when present. Cross-checked against
 * `git branch --list` — drift produces warnings, never a crash.
 */
import { EXCLUDED_BRANCH_GLOBS } from './config.js';
import { globMatchAny } from './globs.js';
import { localBranches } from './git.js';
import type { FeatureEntry, SweepScope, SweepState } from './types.js';

export interface ScopeResult {
  /** In-scope branches in DAG order (parents before children). */
  ordered: string[];
  /** child -> parents (only edges among in-scope branches). */
  edges: Record<string, string[]>;
  warnings: string[];
}

const SWEEPABLE_STATUS = new Set(['in-progress', 'shipped', 'experimental']);

/** Branches the state file marks active (the practice-derived sweep set). */
export function stateActiveBranches(state: SweepState): string[] {
  return Object.entries(state.branches)
    .filter(([, bs]) => bs.status === 'active')
    .map(([name]) => name);
}

export function buildScope(
  features: FeatureEntry[],
  scope: SweepScope,
  repoBranches: string[],
  stateActive: string[] = [],
): ScopeResult {
  const warnings: string[] = [];
  const exclude = [...EXCLUDED_BRANCH_GLOBS, ...(scope.exclude ?? [])];
  const excluded = (b: string) => globMatchAny(exclude, b);

  const branches = new Set<string>();
  const edges: Record<string, Set<string>> = {};
  const addEdge = (child: string, parent: string) => {
    (edges[child] ??= new Set()).add(parent);
  };

  const byBranch = new Map<string, FeatureEntry>();
  for (const e of features) {
    if (!e.branch || !SWEEPABLE_STATUS.has(e.status)) continue;
    byBranch.set(e.branch, e);
  }
  for (const [branch, e] of byBranch) {
    if (excluded(branch)) continue;
    branches.add(branch);
    for (const p of e.parents ?? []) if (!excluded(p)) addEdge(branch, p);
    for (const d of e.dependents ?? []) if (!excluded(d)) addEdge(d, branch);
  }
  for (const b of scope.include ?? []) {
    if (excluded(b)) warnings.push(`scope include '${b}' matches an exclusion glob; skipped`);
    else branches.add(b);
  }
  // Union with sweep-state active branches (no feature link, no DAG edges).
  for (const b of stateActive) {
    if (!excluded(b)) branches.add(b);
  }
  for (const [child, parents] of Object.entries(scope.extra_edges ?? {})) {
    for (const p of parents) if (!excluded(child) && !excluded(p)) addEdge(child, p);
  }
  // Edges may reference branches not yet in the set (e.g. parents from dependents lists).
  for (const [child, parents] of Object.entries(edges)) {
    if (branches.has(child)) for (const p of parents) branches.add(p);
  }

  // Drift check vs the actual repo.
  const repoSet = new Set(repoBranches);
  for (const b of branches) {
    if (!repoSet.has(b)) {
      warnings.push(`scope drift: branch '${b}' is in scope but missing from the repo; dropped`);
      branches.delete(b);
    }
  }
  for (const b of repoBranches) {
    if (!branches.has(b) && !excluded(b) && /^(module|feat|edition)\//.test(b)) {
      warnings.push(`scope drift: repo branch '${b}' matches a sweepable namespace but is not in scope`);
    }
  }

  // Topological sort: parents before children; stable alphabetical tiebreak;
  // main_patched (when present) always first.
  const inScope = [...branches].sort();
  const parentOf: Record<string, string[]> = {};
  for (const b of inScope) {
    parentOf[b] = [...(edges[b] ?? [])].filter((p) => branches.has(p)).sort();
  }
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  let cycle: string | null = null;
  const visit = (b: string, stack: string[]) => {
    const s = state.get(b);
    if (s === 'done') return;
    if (s === 'visiting') {
      cycle = [...stack, b].join(' -> ');
      return;
    }
    state.set(b, 'visiting');
    for (const p of parentOf[b]) visit(p, [...stack, b]);
    state.set(b, 'done');
    ordered.push(b);
  };
  if (branches.has('main_patched')) visit('main_patched', []);
  for (const b of inScope) visit(b, []);
  if (cycle) throw new Error(`scope DAG contains a cycle: ${cycle}`);

  return { ordered, edges: Object.fromEntries(Object.entries(parentOf).filter(([, v]) => v.length > 0)), warnings };
}

export async function resolveScope(
  repo: string,
  features: FeatureEntry[],
  scope: SweepScope,
  stateActive: string[] = [],
): Promise<ScopeResult> {
  return buildScope(features, scope, await localBranches(repo), stateActive);
}
