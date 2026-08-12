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
 *  - edition-ancestor: non-inventory branches in the TRANSITIVE edition
 *                      composition (D-033): tip-ancestor of an edition/*
 *                      branch OR ever merged into any branch whose merge
 *                      history reaches an edition (fork-era merge-edge
 *                      closure — upstream-PR candidates cut from main);
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
import { EXCLUDED_BRANCH_GLOBS, FORK_POINT } from './config.js';
import { globMatchAny } from './globs.js';
import { git, isAncestor, localBranches, refExists, remoteBranches } from './git.js';
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
 * D-033: the edition-composition test is TRANSITIVE and HISTORICAL. A branch
 * qualifies if it was ever merged into any branch whose merge history
 * (transitively) reaches an edition/* branch. Tip-ancestry into a member is
 * the cheap first check; the general test is fork-era reachability of the
 * branch's OWN work:
 *
 *   B was merged into X  ⇔  some commit on B's first-parent line — excluding
 *   commits reachable from main (upstream merges never qualify anything) and
 *   commits on the first-parent line of ANOTHER member (a branch cut FROM
 *   main_patched inherits its whole line; those commits are main_patched's
 *   own, not evidence about the cut) — is reachable from X.
 *
 * Second-parent reachability, never merge-commit subjects (squash/rename
 * fragile). The walk is bounded at the fork point (unbounded in repos
 * without it, e.g. fixtures). Closure: seeds = edition/* branches plus
 * main_patched (structural — it flows into every edition by construction);
 * grow to fixpoint, then prune members whose evidence was claimed by
 * later-joining members (ordering artifacts), alternating until stable.
 * Namespace-excluded branches are neither members nor candidates (so
 * `everything*` can never pull branches in). Returns the composition minus
 * the editions themselves and main_patched. All git reads memoized per run.
 */
export async function editionCompositionBranches(
  repo: string,
  repoBranches?: string[],
  opts: { forkPoint?: string } = {},
): Promise<string[]> {
  const branches = repoBranches ?? (await localBranches(repo));
  const usable = branches.filter((b) => b !== 'main' && !globMatchAny(EXCLUDED_BRANCH_GLOBS, b));
  const editions = usable.filter((b) => /^edition\//.test(b));
  if (editions.length === 0) return [];

  const forkPoint = opts.forkPoint ?? FORK_POINT;
  const bound = (await refExists(repo, forkPoint)) ? forkPoint : null;
  const boundArgs = bound ? [`^${bound}`] : [];

  // --- memoized git reads ---
  const revList = async (args: string[]): Promise<Set<string>> =>
    new Set((await git(repo, ['rev-list', ...args, ...boundArgs])).stdout.split('\n').filter(Boolean));
  const revSetMemo = new Map<string, Set<string>>();
  const revSet = async (b: string): Promise<Set<string>> => {
    let s = revSetMemo.get(b);
    if (!s) {
      s = await revList([b]);
      revSetMemo.set(b, s);
    }
    return s;
  };
  const fpMemo = new Map<string, Set<string>>();
  const firstParentLine = async (b: string): Promise<Set<string>> => {
    let s = fpMemo.get(b);
    if (!s) {
      s = await revList(['--first-parent', b]);
      fpMemo.set(b, s);
    }
    return s;
  };
  const mainSet = await revList(['main']);
  const tipAncestorMemo = new Map<string, boolean>();
  const tipAncestor = async (b: string, x: string): Promise<boolean> => {
    const key = `${b}..${x}`;
    let v = tipAncestorMemo.get(key);
    if (v === undefined) {
      v = await isAncestor(repo, b, x);
      tipAncestorMemo.set(key, v);
    }
    return v;
  };

  const qualifies = async (b: string, members: Set<string>): Promise<boolean> => {
    for (const x of members) {
      if (x === b) continue;
      if (await tipAncestor(b, x)) return true;
    }
    // B's own fork-era work: first-parent line minus main minus other members' lines.
    const own: string[] = [];
    outer: for (const c of await firstParentLine(b)) {
      if (mainSet.has(c)) continue;
      for (const m of members) {
        if (m === b) continue;
        if ((await firstParentLine(m)).has(c)) continue outer;
      }
      own.push(c);
    }
    if (own.length === 0) return false;
    for (const x of members) {
      if (x === b) continue;
      const xSet = await revSet(x);
      if (own.some((c) => xSet.has(c))) return true;
    }
    return false;
  };

  // --- closure: grow / prune alternation until stable ---
  const seeds = new Set<string>(editions);
  if (usable.includes('main_patched')) seeds.add('main_patched'); // structural upstream entry point
  const members = new Set<string>(seeds);
  for (let round = 0; round < 10; round++) {
    let mutated = false;
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of usable) {
        if (members.has(b)) continue;
        if (await qualifies(b, members)) {
          if (process.env.SWEEP_DEBUG_CLOSURE) console.error(`JOIN ${b}`);
          members.add(b);
          changed = mutated = true;
        }
      }
    }
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const b of [...members]) {
        if (seeds.has(b)) continue;
        if (!(await qualifies(b, members))) {
          if (process.env.SWEEP_DEBUG_CLOSURE) console.error(`PRUNE ${b}`);
          members.delete(b);
          pruned = mutated = true;
        }
      }
    }
    if (!mutated) break;
  }
  return [...members].filter((b) => !/^edition\//.test(b) && b !== 'main_patched').sort();
}

export function buildScope(
  features: FeatureEntry[],
  scope: SweepScope,
  repoBranches: string[],
  editionAncestors: string[] = [],
  originBranches: string[] = [],
): ScopeResult {
  const warnings: string[] = [];
  const exclude = [...EXCLUDED_BRANCH_GLOBS, ...(scope.exclude ?? [])];
  const excluded = (b: string) => globMatchAny(exclude, b);
  const repoSet = new Set(repoBranches);
  // D-045 (DRIVER.md §4.7): branches present ONLY as origin/* remote-tracking
  // refs. An inventory branch found here (and not locally) is IN scope, flagged
  // `materialize` — planned from the origin commit, local ref created by
  // `run --execute` before its first mutation. A branch in NEITHER place stays
  // a loud drift warning.
  const originSet = new Set(originBranches);
  const materialize = new Set<string>();

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
      if (originSet.has(branch)) {
        materialize.add(branch);
      } else {
        warnings.push(
          `scope drift: branch '${branch}' is in scope but missing from the repo (no local branch, no origin/${branch}); dropped`,
        );
        continue;
      }
    }
    inventory.add(branch);
    for (const p of e.parents ?? []) if (!excluded(p)) addEdge(branch, p);
    for (const d of e.dependents ?? []) if (!excluded(d)) addEdge(d, branch);
  }
  for (const [child, parents] of Object.entries(scope.extra_edges ?? {})) {
    for (const p of parents) if (!excluded(child) && !excluded(p)) addEdge(child, p);
  }

  const hasMainPatched = (repoSet.has('main_patched') || originSet.has('main_patched')) && !excluded('main_patched');
  if (hasMainPatched && !repoSet.has('main_patched')) materialize.add('main_patched');

  // Per-branch merge sources: DAG parents restricted to in-scope inventory
  // branches (or main_patched); roots default to [main_patched].
  const parentOf: Record<string, string[]> = {};
  for (const b of inventory) {
    const raw = [...(edges[b] ?? [])];
    const usable = raw.filter((p) => inventory.has(p) || (p === 'main_patched' && hasMainPatched)).sort();
    for (const p of raw) {
      if (!usable.includes(p) && (repoSet.has(p) || originSet.has(p))) {
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
    ordered.push({
      branch: 'main_patched',
      kind: 'structural',
      mergeModel: 'upstream-chain',
      parents: [],
      ...(materialize.has('main_patched') ? { materialize: true } : {}),
    });
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
      ...(materialize.has(b) ? { materialize: true } : {}),
    });
  };
  for (const b of [...inventory].sort()) visit(b, []);
  if (cycle)
    throw new Error(
      `scope DAG contains a cycle: ${cycle} — the inventory may only contain branches with proper/valid inheritance (D-045); fix the entries' parents before planning`,
    );

  return {
    ordered,
    ignored,
    edges: Object.fromEntries(Object.entries(parentOf).filter(([, v]) => v.length > 0)),
    warnings,
  };
}

export async function resolveScope(
  repo: string,
  features: FeatureEntry[],
  scope: SweepScope,
  opts: {
    /**
     * D-045 (§13): also consider origin/* remote-tracking refs so remote-only
     * inventory branches enter scope (flagged `materialize`). The propagation
     * driver passes true; the scan flow stays local-only (it probes by branch
     * name and never materializes refs).
     */
    includeRemote?: boolean;
  } = {},
): Promise<ScopeResult> {
  const repoBranches = await localBranches(repo);
  const origin = opts.includeRemote ? await remoteBranches(repo) : [];
  const composition = await editionCompositionBranches(repo, repoBranches);
  return buildScope(features, scope, repoBranches, composition, origin);
}
