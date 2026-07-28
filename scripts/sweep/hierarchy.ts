/**
 * scripts/sweep/hierarchy.ts — THE branch hierarchy. One implementation.
 *
 * Every piece of logic that needs "where does this branch sit in the fork DAG"
 * MUST come through `branchHierarchy`. Depth was previously computed ad hoc
 * inside the attribution code and got it wrong three ways at once (keyed by the
 * wrong field, wrong aggregate, silent zero on failure), so the rule it fed
 * never actually ran. There is no second copy.
 *
 * MODEL
 * -----
 * `main` is the root at depth 0. `main_patched` is the fork trunk at depth 1.
 * Every inventory entry hangs off those through `parents`, which hold BRANCH
 * NAMES (`main_patched`, `module/host-rpc`) — NOT entry ids (`module.command-gate`).
 * Keying the DAG by id silently drops every edge.
 *
 * DEPTH = 1 + MAX(parent depths) — the LONGEST path to the root.
 * A branch can only be merged after ALL of its parents, so its position is
 * governed by its deepest one. Using MIN (the shortest route) puts a child at or
 * above its own parent: on the live inventory it produced 8 such violations,
 * e.g. `feat/mitm-credential-proxy` at 3 alongside its parent `module/host-rpc`
 * at 3, and it ranked `edition/fls-ai-bot` ABOVE three depth-2 modules.
 * `assertNoParentInversion` exists to make that class of error impossible to
 * ship again.
 *
 * MIN PATH = the SHORTEST chain of parents from a branch up to (but excluding)
 * `main`. Depth answers "how late must this merge"; minPath answers "through
 * whom is it connected", which is what a report or an escalation needs to name.
 * The two deliberately use different aggregates and are both recorded, so no
 * caller has to re-derive either.
 */
import type { FeatureEntry } from './types.js';

/** The DAG root. Depth 0; not an inventory entry. */
export const ROOT_BRANCH = 'main';
/** The fork trunk. Depth 1; not an inventory entry either. */
export const TRUNK_BRANCH = 'main_patched';

export interface BranchNode {
  branch: string;
  /** Entry id when the branch comes from the inventory; absent for root/trunk. */
  id?: string;
  /** 1 + MAX(parent depths). Null when no parent resolves to a root. */
  depth: number | null;
  /**
   * Shortest ancestry chain to the root, nearest parent first, EXCLUDING `main`.
   * `main_patched` -> []. `module/command-gate` -> ['main_patched'].
   * Null exactly when `depth` is null.
   */
  minPath: string[] | null;
  /** Parent BRANCH names as declared in the inventory. */
  parents: string[];
}

export interface Hierarchy {
  byBranch: Map<string, BranchNode>;
  /** Branches with no resolvable route to the root — a registry gap, never depth 0. */
  unresolved: string[];
}

/**
 * Build the hierarchy from inventory entries. Pure: no git, no fs.
 *
 * Unresolvable branches get `depth: null`, NOT 0 — a missing edge must never
 * masquerade as "closest to the root", which is precisely how a leaf edition
 * outranked three root-adjacent modules.
 */
export function branchHierarchy(features: FeatureEntry[]): Hierarchy {
  const parentsOf = new Map<string, string[]>();
  const idOf = new Map<string, string>();
  for (const f of features) {
    if (!f.branch) continue;
    parentsOf.set(f.branch, [...(f.parents ?? [])]);
    idOf.set(f.branch, f.id);
  }

  const depth = new Map<string, number | null>([
    [ROOT_BRANCH, 0],
    [TRUNK_BRANCH, 1],
  ]);
  const path = new Map<string, string[] | null>([
    [ROOT_BRANCH, []],
    [TRUNK_BRANCH, []],
  ]);

  const visit = (branch: string, seen: ReadonlySet<string>): void => {
    if (depth.has(branch)) return;
    if (seen.has(branch) || !parentsOf.has(branch)) {
      depth.set(branch, null);
      path.set(branch, null);
      return;
    }
    const next = new Set(seen).add(branch);
    let best: number | null = null; // MAX over parents -> depth
    let shortest: { via: string; path: string[] } | null = null; // MIN over parents -> minPath
    for (const p of parentsOf.get(branch) ?? []) {
      if (next.has(p)) continue; // cycle guard: a malformed registry must not hang the driver
      visit(p, next);
      const pd = depth.get(p) ?? null;
      const pp = path.get(p) ?? null;
      if (pd === null || pp === null) continue;
      if (best === null || pd > best) best = pd;
      const candidate = p === ROOT_BRANCH ? [] : [p, ...pp];
      if (!shortest || candidate.length < shortest.path.length) shortest = { via: p, path: candidate };
    }
    depth.set(branch, best === null ? null : best + 1);
    path.set(branch, shortest ? shortest.path : null);
  };

  for (const b of parentsOf.keys()) visit(b, new Set());

  const byBranch = new Map<string, BranchNode>();
  const add = (branch: string): void => {
    byBranch.set(branch, {
      branch,
      ...(idOf.has(branch) ? { id: idOf.get(branch)! } : {}),
      depth: depth.get(branch) ?? null,
      minPath: path.get(branch) ?? null,
      parents: parentsOf.get(branch) ?? (branch === TRUNK_BRANCH ? [ROOT_BRANCH] : []),
    });
  };
  add(ROOT_BRANCH);
  add(TRUNK_BRANCH);
  for (const b of parentsOf.keys()) add(b);

  return {
    byBranch,
    unresolved: [...parentsOf.keys()].filter((b) => byBranch.get(b)?.depth === null).sort(),
  };
}

/** Depth for one branch, or null when it has no resolvable route to the root. */
export function depthOf(h: Hierarchy, branch: string): number | null {
  return h.byBranch.get(branch)?.depth ?? null;
}

/** Shortest parent chain to the root, excluding `main`; null when unresolvable. */
export function minPathOf(h: Hierarchy, branch: string): string[] | null {
  return h.byBranch.get(branch)?.minPath ?? null;
}

/**
 * Order for the OWNER RULE: earliest by hierarchy first. Shallower wins; an
 * UNRESOLVED branch sorts LAST (never as 0); ties break by name ONLY so the
 * listing is stable — callers must NOT treat a name-order tie as a decision.
 */
export function byHierarchy(h: Hierarchy): (a: string, b: string) => number {
  return (a, b) => {
    const da = depthOf(h, a);
    const db = depthOf(h, b);
    if (da === null && db === null) return a.localeCompare(b);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db || a.localeCompare(b);
  };
}

/**
 * INVARIANT: no branch may sit at or above the depth of any of its parents.
 * The MIN-vs-MAX bug produced exactly this and nothing caught it until the
 * numbers were read by hand. Returns the violations, empty when sound.
 */
export function assertNoParentInversion(h: Hierarchy): Array<{ branch: string; parent: string; depth: number; parentDepth: number }> {
  const bad: Array<{ branch: string; parent: string; depth: number; parentDepth: number }> = [];
  for (const node of h.byBranch.values()) {
    if (node.depth === null) continue;
    for (const p of node.parents) {
      const pd = depthOf(h, p);
      if (pd === null) continue;
      if (node.depth <= pd) bad.push({ branch: node.branch, parent: p, depth: node.depth, parentDepth: pd });
    }
  }
  return bad;
}
