/**
 * scripts/sweep/plan.ts — DAG validation + breadth-wise whole-pass plan
 * derivation, including no-op/skip detection and the leaf/always_merge un-skip
 * logic (PROPAGATION.md §2/§6, D-036/D-039).
 *
 * The plan is a PURE derivation from git state + inventory: regenerating it must
 * be a no-op (idempotent, resumable — §7). Branches are processed strictly
 * breadth-wise over the inventory DAG (a branch only after ALL its inventory
 * parents), which scope.ts already produces as a topological order (and throws
 * on a cycle). Per (branch, parent) we build the eligible line (interval.ts) and
 * run the linear merge-point sweep (interval.ts), then classify the verdict and,
 * for own conflicts, run the DEFERRED check (deferred.ts).
 */
import { checkDeferred } from './deferred.js';
import { buildEligibleLine, mergePointSweep } from './interval.js';
import { deriveCoverage, enumerateChain, type Chain } from './heights.js';
import { git, revParse } from './git.js';
import { resolveScope } from './scope.js';
import { tierFloor } from './tiers.js';
import type { BranchPlan, FeatureEntry, HeldRecord, ParentPlan, PropagationPlan, SweepScope } from './types.js';

async function treeOf(repo: string, commit: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
}

/** child -> full set of transitive inventory ancestors (DEFERRED matching input, §5). */
export function transitiveAncestors(edges: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const resolve = (b: string, seen: Set<string>): Set<string> => {
    for (const p of edges[b] ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      resolve(p, seen);
    }
    return seen;
  };
  for (const b of Object.keys(edges)) out[b] = [...resolve(b, new Set())];
  return out;
}

/** Inventory branches that are nobody's parent (leaves for the §6 rule). */
export function findLeaves(branches: string[], edges: Record<string, string[]>): Set<string> {
  const isParent = new Set<string>();
  for (const parents of Object.values(edges)) for (const p of parents) isParent.add(p);
  return new Set(branches.filter((b) => !isParent.has(b)));
}

/** A branch's parents all no-op'd this pass (no real merge, no case, no defer). */
export function allParentsSkipped(plan: BranchPlan): boolean {
  return plan.parents.length > 0 && plan.parents.every((p) => p.verdict === 'skip' || p.verdict === 'up-to-date');
}

/**
 * Cheapest parent chain from `branch` up to an entry-point branch (§6): BFS over
 * child->parents, shortest hop count. Returns [branch, ..., entry] or [] when no
 * entry is reachable.
 */
export function shortestUnskipChain(branch: string, edges: Record<string, string[]>, entrySet: Set<string>): string[] {
  if (entrySet.has(branch)) return [branch];
  const queue: string[][] = [[branch]];
  const seen = new Set<string>([branch]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const tail = path[path.length - 1];
    for (const parent of edges[tail] ?? []) {
      if (seen.has(parent)) continue;
      const next = [...path, parent];
      if (entrySet.has(parent)) return next;
      seen.add(parent);
      queue.push(next);
    }
  }
  return [];
}

export interface DerivePlanOptions {
  repo: string;
  upstreamRef: string;
  /** Fork point (exclusive lower bound of the trunk chain). */
  base: string;
  features: FeatureEntry[];
  scope: SweepScope;
  /** HELD registry from the pass journal (empty on the first plan). */
  held?: HeldRecord[];
}

async function analyzeParent(
  repo: string,
  branch: string,
  branchTip: string,
  branchTree: string,
  parent: string,
  model: 'entry' | 'parents',
  chain: Chain,
  ancestors: string[],
  held: HeldRecord[],
): Promise<ParentPlan> {
  const line = await buildEligibleLine({ repo, branch, branchTip, parent, model, chain });
  const sweep = await mergePointSweep(repo, branch, line);

  const pp: ParentPlan = {
    parent,
    model,
    mergePoint: sweep.mergePoint,
    verdict: 'up-to-date',
    case: null,
    deferredTo: null,
    skipReason: null,
  };

  if (sweep.upToDate) return pp;

  let realMerge = false;
  if (sweep.mergePoint) {
    const probe = sweep.probes.find((p) => p.head.height === sweep.mergePoint!.height);
    if (probe && probe.clean && probe.treeOid === branchTree) {
      pp.skipReason = 'no-op';
    } else {
      realMerge = true;
    }
  }

  if (sweep.firstConflict) {
    const fc = sweep.firstConflict;
    const decision = checkDeferred(fc.head.height, fc.conflictedPaths, ancestors, held);
    if (decision.deferred) {
      pp.deferredTo = decision.ancestor!.branch;
    } else {
      pp.case = {
        head: fc.head,
        conflictedPaths: fc.conflictedPaths,
        automergeTree: fc.automergeTree,
        reproduction: fc.reproduction,
      };
    }
  }

  if (realMerge) pp.verdict = 'merge';
  else if (pp.deferredTo) pp.verdict = 'defer';
  else if (pp.case) pp.verdict = 'case';
  else pp.verdict = 'skip';
  return pp;
}

export interface DeriveBranchArgs {
  repo: string;
  branch: string;
  kind: BranchPlan['kind'];
  model: 'entry' | 'parents';
  parents: string[];
  chain: Chain;
  ancestors: string[];
  tierFloor: BranchPlan['tierFloor'];
  isLeaf: boolean;
  alwaysMerge: boolean;
  held: HeldRecord[];
}

/**
 * Derive ONE branch's plan row against LIVE git state (no un-skip — that is a
 * cross-branch decision applied by the caller). `run` calls this per branch
 * during the breadth-wise cascade so a child sees its parents' just-merged tips
 * (like merge.ts probes live source tips); `derivePlan` calls it for the
 * up-front snapshot.
 */
export async function deriveBranch(args: DeriveBranchArgs): Promise<BranchPlan> {
  const { repo, branch, kind, model, parents, chain, ancestors, tierFloor, isLeaf, alwaysMerge, held } = args;
  const branchTip = await revParse(repo, branch);
  const branchTree = await treeOf(repo, branchTip);
  const parentPlans: ParentPlan[] = [];
  for (const parent of parents) {
    parentPlans.push(await analyzeParent(repo, branch, branchTip, branchTree, parent, model, chain, ancestors, held));
  }
  return { branch, kind, tierFloor, isLeaf, alwaysMerge, ancestors, parents: parentPlans };
}

/** Derive the whole-pass plan (§2/§6). Pure w.r.t. git state — idempotent. */
export async function derivePlan(opts: DerivePlanOptions): Promise<PropagationPlan> {
  const { repo, upstreamRef, base, features, scope } = opts;
  const held = opts.held ?? [];

  const chain = await enumerateChain(repo, upstreamRef, base);
  const watermark = chain.watermark;
  const watermark12 = watermark.slice(0, 12);
  const passHasProgress = chain.heads.length > 0;

  // scope.ts validates the DAG (throws on a cycle) and returns topological order.
  const scopeResult = await resolveScope(repo, features, scope);
  const ordered = scopeResult.ordered;
  const warnings = [...scopeResult.warnings];

  const featureByBranch = new Map<string, FeatureEntry>();
  for (const f of features) if (f.branch) featureByBranch.set(f.branch, f);

  const ancestorsMap = transitiveAncestors(scopeResult.edges);
  const entrySet = new Set(ordered.filter((e) => e.mergeModel === 'upstream-chain').map((e) => e.branch));
  const inventoryBranches = ordered.filter((e) => e.mergeModel === 'parents').map((e) => e.branch);
  const leaves = findLeaves(inventoryBranches, scopeResult.edges);

  const branches: BranchPlan[] = [];
  const byBranch = new Map<string, BranchPlan>();

  for (const entry of ordered) {
    const model: 'entry' | 'parents' = entry.mergeModel === 'upstream-chain' ? 'entry' : 'parents';
    const parents = model === 'entry' ? ['main'] : entry.parents;
    const feat = featureByBranch.get(entry.branch) as (FeatureEntry & { always_merge?: boolean }) | undefined;
    const bp = await deriveBranch({
      repo,
      branch: entry.branch,
      kind: entry.kind,
      model,
      parents,
      chain,
      ancestors: ancestorsMap[entry.branch] ?? [],
      tierFloor: tierFloor(entry.branch, feat),
      isLeaf: model === 'parents' && leaves.has(entry.branch),
      alwaysMerge: feat?.always_merge === true,
      held,
    });
    branches.push(bp);
    byBranch.set(bp.branch, bp);
  }

  // Leaf / always_merge un-skip (§6): a leaf whose every parent no-op'd, in a
  // pass that carries progress, un-skips its cheapest parent chain — forced
  // (empty) merges along the chain keep "every branch only merges its inventory
  // parents" uniform. NO merge-main-directly exception.
  if (passHasProgress) {
    for (const bp of branches) {
      if (!(bp.isLeaf || bp.alwaysMerge)) continue;
      if (!allParentsSkipped(bp)) continue;
      const uchain = shortestUnskipChain(bp.branch, scopeResult.edges, entrySet);
      if (uchain.length < 2) continue; // no entry reachable
      bp.unskipChain = uchain;
      // Force a merge on each (child <- next parent) hop of the chain.
      for (let i = 0; i < uchain.length - 1; i++) {
        const child = byBranch.get(uchain[i]);
        const parent = uchain[i + 1];
        if (!child) continue;
        const parentTip = await revParse(repo, parent);
        const height = (await deriveCoverage(repo, chain, parentTip)).height;
        const pp = child.parents.find((p) => p.parent === parent);
        const forcedHead = { sha: parentTip, height };
        if (pp) {
          pp.verdict = 'merge';
          pp.forced = true;
          pp.mergePoint = forcedHead;
          pp.skipReason = null;
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    watermark,
    watermark12,
    forkPoint: chain.base,
    chainLength: chain.heads.length,
    order: ordered.map((e) => e.branch),
    branches,
    warnings,
  };
}

/** Two plans are equivalent when their branch verdicts + merge points match (idempotency, §8). */
export function plansEquivalent(a: PropagationPlan, b: PropagationPlan): boolean {
  if (a.watermark !== b.watermark) return false;
  if (a.order.join(',') !== b.order.join(',')) return false;
  const sig = (p: PropagationPlan) =>
    JSON.stringify(
      p.branches.map((bp) => [
        bp.branch,
        bp.parents.map((pp) => [pp.parent, pp.verdict, pp.mergePoint?.sha ?? null, pp.deferredTo, pp.forced ?? false]),
      ]),
    );
  return sig(a) === sig(b);
}
