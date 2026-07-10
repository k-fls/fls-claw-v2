/**
 * scripts/sweep/scope.ts — in-scope branch enumeration + DAG ordering.
 *
 * Scope = UNION of (inventory entries' owning branches) and (repo branches
 * matching registry/scope.yaml `include` GLOBS — main_patched, fix/**,
 * docs/notes: swept in this fork's practice without feature entries, null
 * feature link), minus `exclude` + the built-in namespace exclusions. No
 * state file participates in scope (exclusion policy is config; freeze
 * state is handled by the merge stage via the ledger). DAG edges come from
 * entry parents/dependents plus scope.extra_edges; order = parents before
 * children (topological), with main_patched forced first when present.
 * Cross-checked against `git branch --list` — drift produces warnings,
 * never a crash.
 */
import { EXCLUDED_BRANCH_GLOBS } from './config.js';
import { globMatch, globMatchAny } from './globs.js';
import { localBranches } from './git.js';
import type { FeatureEntry, SweepScope } from './types.js';

export interface ScopeResult {
  /** In-scope branches in DAG order (parents before children). */
  ordered: string[];
  /** child -> parents (only edges among in-scope branches). */
  edges: Record<string, string[]>;
  warnings: string[];
}

const SWEEPABLE_STATUS = new Set(['in-progress', 'shipped', 'experimental']);

export function buildScope(features: FeatureEntry[], scope: SweepScope, repoBranches: string[]): ScopeResult {
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
  // Include GLOBS matched against the actual repo branch list (null feature link).
  for (const pattern of scope.include ?? []) {
    for (const b of repoBranches) {
      if (globMatch(pattern, b) && !excluded(b)) branches.add(b);
    }
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

export async function resolveScope(repo: string, features: FeatureEntry[], scope: SweepScope): Promise<ScopeResult> {
  return buildScope(features, scope, await localBranches(repo));
}
