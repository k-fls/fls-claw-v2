/**
 * scripts/sweep/scope.ts — scope partition + DAG ordering
 * (2026-07-14 merge-source correction; owner directive).
 *
 * Partition of `git branch --list` (after explicit + namespace exclusions):
 *  - structural:       main_patched — the ONLY upstream entry point besides
 *                      main(ff); mergeModel upstream-chain.
 *  - inventory:        branches owned by a sweepable inventory entry;
 *                      mergeModel 'parents' — they merge their DAG parents'
 *                      tips (entry `parents`, roots default to main_patched),
 *                      NEVER upstream/main directly. Conflicts resolve once
 *                      at the topmost affected branch; descendants inherit.
 *  - edition-ancestor: non-inventory branches whose tip is an ancestor of
 *                      any edition/* branch (they are part of a shipped
 *                      composition — upstream-PR candidates cut from main);
 *                      mergeModel upstream-chain (merge main ONLY — never
 *                      polluted with main_patched/fork content). Flagged:
 *                      "in edition composition but no inventory entry".
 *  - ignored:          every other non-inventory branch (owner rule: "agent
 *                      ignores non-inventory branches, unless they are
 *                      present in any edition branch"). At most a digest
 *                      drift line.
 *
 * Order = parents before children (topological), main_patched first, then
 * edition-ancestors (independent roots), then the inventory DAG.
 */
import { EXCLUDED_BRANCH_GLOBS } from './config.js';
import { globMatchAny } from './globs.js';
import { isAncestor, localBranches } from './git.js';
import type { FeatureEntry, ScopeEntry, SweepScope } from './types.js';

export interface ScopeResult {
  /** In-scope branches in DAG order (parents before children). */
  ordered: ScopeEntry[];
  /** Non-inventory branches ignored by the scope rule (digest drift line). */
  ignored: string[];
  /** child -> parents (only edges among in-scope branches). */
  edges: Record<string, string[]>;
  warnings: string[];
}

const SWEEPABLE_STATUS = new Set(['in-progress', 'shipped', 'experimental']);

/**
 * Non-inventory scope candidates whose tip is an ancestor of any edition/*
 * branch ("present in an edition composition"). Shared by scope + validator.
 */
export async function editionAncestorBranches(repo: string, repoBranches?: string[]): Promise<string[]> {
  const branches = repoBranches ?? (await localBranches(repo));
  const editions = branches.filter((b) => /^edition\//.test(b) && !globMatchAny(EXCLUDED_BRANCH_GLOBS, b));
  if (editions.length === 0) return [];
  const out: string[] = [];
  for (const b of branches) {
    if (b === 'main' || b === 'main_patched' || /^edition\//.test(b)) continue;
    if (globMatchAny(EXCLUDED_BRANCH_GLOBS, b)) continue;
    for (const e of editions) {
      if (await isAncestor(repo, b, e)) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

export function buildScope(
  features: FeatureEntry[],
  scope: SweepScope,
  repoBranches: string[],
  editionAncestors: string[] = [],
): ScopeResult {
  const warnings: string[] = [];
  const exclude = [...EXCLUDED_BRANCH_GLOBS, ...(scope.exclude ?? [])];
  const excluded = (b: string) => globMatchAny(exclude, b);
  const repoSet = new Set(repoBranches);

  // --- inventory branches + DAG edges ---
  const inventory = new Set<string>();
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
    if (!repoSet.has(branch)) {
      warnings.push(`scope drift: branch '${branch}' is in scope but missing from the repo; dropped`);
      continue;
    }
    inventory.add(branch);
    for (const p of e.parents ?? []) if (!excluded(p)) addEdge(branch, p);
    for (const d of e.dependents ?? []) if (!excluded(d)) addEdge(d, branch);
  }
  for (const [child, parents] of Object.entries(scope.extra_edges ?? {})) {
    for (const p of parents) if (!excluded(child) && !excluded(p)) addEdge(child, p);
  }

  const hasMainPatched = repoSet.has('main_patched') && !excluded('main_patched');

  // Per-branch merge sources: DAG parents restricted to in-scope inventory
  // branches (or main_patched); roots default to [main_patched].
  const parentOf: Record<string, string[]> = {};
  for (const b of inventory) {
    const raw = [...(edges[b] ?? [])];
    const usable = raw.filter((p) => inventory.has(p) || (p === 'main_patched' && hasMainPatched)).sort();
    for (const p of raw) {
      if (!usable.includes(p) && repoSet.has(p)) {
        warnings.push(`scope drift: '${b}' parent '${p}' is not in scope; edge dropped`);
      } else if (!usable.includes(p) && !repoSet.has(p)) {
        warnings.push(`scope drift: '${b}' parent '${p}' is missing from the repo; edge dropped`);
      }
    }
    parentOf[b] = usable.length > 0 ? usable : hasMainPatched ? ['main_patched'] : [];
  }

  // --- edition-ancestor + ignored partition of the remaining branches ---
  const ancestorSet = new Set(editionAncestors);
  const editionAncestorsInScope: string[] = [];
  const ignored: string[] = [];
  for (const b of repoBranches) {
    if (excluded(b) || inventory.has(b) || b === 'main' || b === 'main_patched') continue;
    if (ancestorSet.has(b)) {
      editionAncestorsInScope.push(b);
      warnings.push(`scope: '${b}' is in an edition composition but has no inventory entry — add one`);
    } else {
      ignored.push(b);
      if (/^(module|feat|edition)\//.test(b)) {
        warnings.push(`scope drift: repo branch '${b}' matches a sweepable namespace but has no inventory entry`);
      }
    }
  }
  editionAncestorsInScope.sort();
  ignored.sort();

  // --- topological order: main_patched, edition-ancestors, inventory DAG ---
  const ordered: ScopeEntry[] = [];
  if (hasMainPatched) {
    ordered.push({ branch: 'main_patched', kind: 'structural', mergeModel: 'upstream-chain', parents: [] });
  }
  for (const b of editionAncestorsInScope) {
    ordered.push({ branch: b, kind: 'edition-ancestor', mergeModel: 'upstream-chain', parents: [] });
  }
  const state = new Map<string, 'visiting' | 'done'>();
  let cycle: string | null = null;
  const visit = (b: string, stack: string[]) => {
    if (!inventory.has(b)) return; // main_patched handled above
    const s = state.get(b);
    if (s === 'done') return;
    if (s === 'visiting') {
      cycle = [...stack, b].join(' -> ');
      return;
    }
    state.set(b, 'visiting');
    for (const p of parentOf[b]) visit(p, [...stack, b]);
    state.set(b, 'done');
    ordered.push({
      branch: b,
      kind: 'inventory',
      // No parents at all (no main_patched in the repo, e.g. bootstrap
      // fixtures): fall back to the upstream chain.
      mergeModel: parentOf[b].length > 0 ? 'parents' : 'upstream-chain',
      parents: parentOf[b],
    });
  };
  for (const b of [...inventory].sort()) visit(b, []);
  if (cycle) throw new Error(`scope DAG contains a cycle: ${cycle}`);

  return {
    ordered,
    ignored,
    edges: Object.fromEntries(Object.entries(parentOf).filter(([, v]) => v.length > 0)),
    warnings,
  };
}

export async function resolveScope(repo: string, features: FeatureEntry[], scope: SweepScope): Promise<ScopeResult> {
  const repoBranches = await localBranches(repo);
  const ancestors = await editionAncestorBranches(repo, repoBranches);
  return buildScope(features, scope, repoBranches, ancestors);
}
