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
import { DEFAULT_STACK_CAP, EXCLUDED_BRANCH_GLOBS } from './config.js';
import { checkDeferred, type BlockedParent } from './deferred.js';
import { globMatchAny } from './globs.js';
import { buildEligibleLine, mergePointSweep } from './interval.js';
import { deriveCoverage, enumerateChain, type Chain } from './heights.js';
import { git, newStyleMergeTree, revParse } from './git.js';
import { resolveScope, type ScopeResult } from './scope.js';
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
 *
 * `blocked` (D-057): branches with merge_status != NONE (PR_ID | DEFERRED).
 * The un-skip chain must NEVER merge into or through a blocked branch — a
 * PR_ID branch is waiting on its own owner PR and a DEFERRED branch takes
 * NOTHING while sticky, so a forced merge on such a hop would push content
 * past the block. Blocked branches are excluded from the search entirely
 * (as intermediates AND as the entry terminal — a blocked entry's tip carries
 * no pass progress to pull); when no unblocked chain exists the un-skip is
 * aborted ([] — the leaf simply stays skipped this pass).
 */
export function shortestUnskipChain(
  branch: string,
  edges: Record<string, string[]>,
  entrySet: Set<string>,
  blocked: Set<string> = new Set(),
): string[] {
  if (entrySet.has(branch)) return [branch];
  const queue: string[][] = [[branch]];
  const seen = new Set<string>([branch]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const tail = path[path.length - 1];
    for (const parent of edges[tail] ?? []) {
      if (seen.has(parent) || blocked.has(parent)) continue;
      const next = [...path, parent];
      if (entrySet.has(parent)) return next;
      seen.add(parent);
      queue.push(next);
    }
  }
  return [];
}

/**
 * §6 un-skip chain conflict pre-probe (2026-07-23 live ERR21 halt): before ANY
 * hop of `uchain` is forced, simulate the WHOLE top-down forcing sequence —
 * every `child <- parent` hop probed via merge-tree, INCLUDING the leaf's own
 * forced merge (`uchain[0] <- uchain[1]`). Each clean hop advances the child's
 * SIMULATED tip to a hypothetical ref-less merge commit (commit-tree — no ref
 * moves, same tree/parents the real forced merge will create), so later hops
 * probe the post-force ancestry exactly as the real sequence will see it.
 *
 * The un-skip premise ("every parent no-op'd, so forcing produces empty
 * merges") breaks once a prior forced hop moves a tip and a later hop then
 * genuinely conflicts: commitTreeMerge is CLEAN-ONLY and would throw mid-chain
 * (ERR21_MERGE_FAILED hard-halt) leaving partial forced merges behind. Returns
 * true when every hop merges clean; false means the caller must ABORT the
 * un-skip — force NO hops and mark the leaf's skip rows 'unskip-conflict' (the
 * step verifier's sanctioned all-skip, like 'unskip-blocked'). The conflicting
 * hop branch is NOT handled here: its own normal case derivation owns the
 * conflict (never double-handled).
 */
export async function unskipChainClean(
  repo: string,
  uchain: string[],
  refOf: (b: string) => string = (b) => b,
): Promise<boolean> {
  const tips = new Map<string, string>();
  for (const b of uchain) tips.set(b, await revParse(repo, refOf(b)));
  for (let i = uchain.length - 2; i >= 0; i--) {
    const child = uchain[i];
    const parent = uchain[i + 1];
    const childTip = tips.get(child)!;
    const parentTip = tips.get(parent)!;
    const probe = await newStyleMergeTree(repo, childTip, parentTip);
    if (!probe.clean) return false;
    if (i === 0) break; // the leaf's own hop is last — nothing probes below it
    const hyp = await git(repo, [
      'commit-tree',
      probe.treeOid,
      '-p',
      childTip,
      '-p',
      parentTip,
      '-m',
      `unskip pre-probe: ${parent} -> ${child}`,
    ]);
    tips.set(child, hyp.stdout.trim());
  }
  return true;
}

export interface DerivePlanOptions {
  repo: string;
  upstreamRef: string;
  /** Fork point (exclusive lower bound of the trunk chain). */
  base: string;
  features: FeatureEntry[];
  scope: SweepScope;
  /**
   * PR_ID-blocked branches with their LIVE-derived block heights (this-pass
   * holds + cross-pass PR_ID entries whose height was re-derived from the
   * stored head sha, D-057). Seeds blockHeightOf; also the annotate input.
   */
  held?: HeldRecord[];
  /**
   * Per-branch merge_status view (D-057): PR_ID | DEFERRED; absence = NONE.
   * PR_ID branches arrive with empty intervals (blocked on their own PR).
   * DEFERRED branches are sticky while a DIRECT parent is blocked (no merges,
   * block height re-probed live for their children) and derive NORMALLY when
   * every parent is NONE (the "re-merge fresh" view — `run` commits the clear).
   */
  mergeStatusOf?: Map<string, 'PR_ID' | 'DEFERRED'>;
  /** Global case-stacking cap (routing.yaml `stack_cap`, D-049 §2); per-feature `stack_cap` overrides. */
  stackCap?: number;
}

async function analyzeParent(
  repo: string,
  branch: string,
  branchTip: string,
  branchTree: string,
  parent: string,
  parentRef: string,
  model: 'entry' | 'parents',
  chain: Chain,
  ancestors: string[],
  held: HeldRecord[],
  blockedParents: BlockedParent[],
  stackCap: number,
): Promise<ParentPlan> {
  const line = await buildEligibleLine({ repo, branch, branchTip, parent, parentRef, model, chain });
  // Probe from the pinned branch TIP sha, not the ref name: deterministic
  // (§3 probe determinism) and valid for remote-only branches (§13, D-045).
  const sweep = await mergePointSweep(repo, branchTip, line, stackCap);

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
    // DEFERRED = pure height-MIN over X's blocked DIRECT parents (D-057): defer
    // iff any direct parent is blocked and this conflict is at/above the lowest
    // blocked parent's height. No path/window/ancestor-set test.
    const decision = checkDeferred(fc.head.height, blockedParents);
    if (decision.deferred) {
      pp.deferredTo = decision.blockedBy;
      pp.deferHeight = fc.head.height;
    } else {
      pp.case = {
        head: fc.head,
        run: fc.run,
        conflictedPaths: fc.conflictedPaths,
        automergeTree: fc.automergeTree,
        reproduction: fc.reproduction,
      };
    }
  }

  // Annotate-class (§1, D-002): a CLEAN merge whose merged range passes THROUGH
  // a height at which a transitive ancestor is HELD. Never gates — surfaced in
  // the pass report. Window is (coverage, mergePoint.height].
  if (realMerge && sweep.mergePoint) {
    const ancestorSet = new Set(ancestors);
    const hit = held.find(
      (h) => ancestorSet.has(h.branch) && h.height > line.coverage && h.height <= sweep.mergePoint!.height,
    );
    if (hit) pp.annotate = { heldAncestor: hit.branch, height: hit.height };
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
  /** Block-height of each currently-blocked branch (merge_status != NONE), for the
   * D-057 height-MIN DEFER over this branch's blocked DIRECT parents. */
  blockHeightOf?: Map<string, number>;
  /** Effective case-stacking cap (D-049 §2 lever); DEFAULT_STACK_CAP when omitted. */
  stackCap?: number;
  /**
   * This branch's own merge_status when blocked (D-057; omitted = NONE):
   *  - `{state:'PR_ID'}`: blocked on its own PR — empty interval, skip rows.
   *  - `{state:'DEFERRED', behind}`: sticky-deferred (a DIRECT parent is still
   *    blocked). Parents are PROBED normally so the branch's own conflict
   *    height is re-derived live (its children's height-MIN input), but every
   *    would-be merge is suppressed to a skip and every own conflict is forced
   *    to a defer — set-time BECOME never re-runs while sticky. `behind` names
   *    a blocked direct parent (the defer pointer fallback).
   */
  mergeBlocked?: { state: 'PR_ID' } | { state: 'DEFERRED'; behind: string };
  /**
   * D-045 (§13): the branch is remote-only — read its tip from origin/<branch>
   * and flag the plan row `materialize`. `run --execute` creates the local ref
   * (through the guardRef choke point) before the branch's first mutation.
   */
  materialize?: boolean;
  /**
   * Read-ref resolver for PARENTS (§13): a remote-only parent is read as
   * `origin/<parent>` at plan time. Defaults to the identity (local refs).
   */
  refOf?: (branch: string) => string;
}

/**
 * Derive ONE branch's plan row against LIVE git state (no un-skip — that is a
 * cross-branch decision applied by the caller). `run` calls this per branch
 * during the breadth-wise cascade so a child sees its parents' just-merged tips
 * (like merge.ts probes live source tips); `derivePlan` calls it for the
 * up-front snapshot.
 *
 * NOTE (D-047/B11): all per-parent probes here run against the SAME pinned
 * `branchTip` — the tip at derivation time. Execution merges parents
 * SEQUENTIALLY, so a later parent's verdict goes stale once an earlier parent's
 * merge advances the tip; `run` re-probes each merge against the CURRENT tip
 * immediately before executing it and demotes clean→case/skip as found
 * (§3 execution re-probe).
 */
export async function deriveBranch(args: DeriveBranchArgs): Promise<BranchPlan> {
  const { repo, branch, kind, model, parents, chain, ancestors, tierFloor, isLeaf, alwaysMerge, held } = args;
  const mergeBlocked = args.mergeBlocked ?? null;
  // D-057: X's blocked DIRECT parents (with their block-heights) — the input to
  // the height-MIN DEFER rule. Restricted to DIRECT parents (never transitive):
  // a clean intermediate parent (absent here) stops propagation until it re-merges.
  const blockHeightOf = args.blockHeightOf ?? new Map<string, number>();
  const blockedParents: BlockedParent[] = parents
    .filter((p) => blockHeightOf.has(p))
    .map((p) => ({ branch: p, height: blockHeightOf.get(p)! }));
  const refOf = args.refOf ?? ((b: string) => b);
  const materialize = args.materialize === true;
  const stackCap = args.stackCap ?? DEFAULT_STACK_CAP;
  // merge_status PR_ID (D-057): blocked on its own PR — no merges this pass
  // (barrier satisfied by an empty interval).
  if (mergeBlocked?.state === 'PR_ID') {
    const parentPlans: ParentPlan[] = parents.map((parent) => ({
      parent,
      model,
      mergePoint: null,
      verdict: 'skip',
      case: null,
      deferredTo: null,
      skipReason: 'held',
    }));
    return {
      branch,
      kind,
      tierFloor,
      isLeaf,
      alwaysMerge,
      ancestors,
      stackCap,
      parents: parentPlans,
      ...(materialize ? { materialize: true } : {}),
    };
  }
  // §13: a remote-only branch is read from origin/<branch> (never a ref write).
  const branchTip = await revParse(repo, materialize ? `origin/${branch}` : branch);
  const branchTree = await treeOf(repo, branchTip);
  const parentPlans: ParentPlan[] = [];
  for (const parent of parents) {
    parentPlans.push(
      await analyzeParent(
        repo,
        branch,
        branchTip,
        branchTree,
        parent,
        refOf(parent),
        model,
        chain,
        ancestors,
        held,
        blockedParents,
        stackCap,
      ),
    );
  }
  // merge_status DEFERRED, sticky (D-057): a DIRECT parent is still blocked, so
  // the branch takes NOTHING this pass — it waits until ALL parents are NONE,
  // then re-merges fresh. The probes above still ran so the branch's own
  // conflict height is LIVE (its children's height-MIN input); here every
  // would-be merge is suppressed and every own conflict forced to a defer
  // (STAY is independent of height — BECOME's height-MIN is set-time only).
  if (mergeBlocked?.state === 'DEFERRED') {
    for (const pp of parentPlans) {
      if (pp.case) {
        pp.deferredTo = pp.deferredTo ?? mergeBlocked.behind;
        pp.deferHeight = pp.deferHeight ?? pp.case.head.height;
        pp.case = null;
      }
      if (pp.verdict === 'merge' || pp.verdict === 'case') {
        pp.verdict = pp.deferredTo ? 'defer' : 'skip';
        pp.mergePoint = null; // the suppressed clean prefix does NOT land while sticky
        if (!pp.deferredTo) pp.skipReason = 'deferred';
      }
    }
  }
  return {
    branch,
    kind,
    tierFloor,
    isLeaf,
    alwaysMerge,
    ancestors,
    stackCap,
    parents: parentPlans,
    ...(materialize ? { materialize: true } : {}),
  };
}

/**
 * D-045 code enforcement of "the inventory may only contain branches with
 * proper/valid inheritance" (§13): an in-scope inventory entry whose declared
 * parent is missing from the inventory/structural set is a HARD HALT naming
 * the entry — never a silently rewired root. (Cycles already hard-halt in
 * scope.ts's DAG validation.) Parents dropped by explicit exclusion globs are
 * deliberate config, not invalid inheritance, and stay allowed.
 */
export function validateInventoryInheritance(
  features: FeatureEntry[],
  scopeResult: ScopeResult,
  scope: SweepScope,
): void {
  const exclude = [...EXCLUDED_BRANCH_GLOBS, ...(scope.exclude ?? [])];
  const excluded = (b: string) => globMatchAny(exclude, b);
  const inventorySet = new Set(scopeResult.ordered.filter((e) => e.kind === 'inventory').map((e) => e.branch));
  const structuralSet = new Set(scopeResult.ordered.filter((e) => e.kind === 'structural').map((e) => e.branch));
  for (const e of features) {
    if (!e.branch || !inventorySet.has(e.branch)) continue;
    for (const p of e.parents ?? []) {
      if (excluded(p) || inventorySet.has(p) || structuralSet.has(p)) continue;
      throw new Error(
        `inventory inheritance invalid (D-045): entry '${e.id}' (branch '${e.branch}') declares parent '${p}', ` +
          `which is not in the inventory/structural set — the inventory may only contain branches with ` +
          `proper/valid inheritance; fix the entry (or add/restore the parent) before planning`,
      );
    }
  }
}

/** Derive the whole-pass plan (§2/§6). Pure w.r.t. git state — idempotent. */
export async function derivePlan(opts: DerivePlanOptions): Promise<PropagationPlan> {
  const { repo, upstreamRef, base, features, scope } = opts;
  const held = opts.held ?? [];
  const mergeStatusOf = opts.mergeStatusOf ?? new Map<string, 'PR_ID' | 'DEFERRED'>();

  const chain = await enumerateChain(repo, upstreamRef, base);
  const watermark = chain.watermark;
  const watermark12 = watermark.slice(0, 12);
  const passHasProgress = chain.heads.length > 0;

  // scope.ts validates the DAG (throws on a cycle) and returns topological
  // order; origin/* refs are considered so remote-only inventory branches are
  // in scope, flagged `materialize` (§13, D-045).
  const scopeResult = await resolveScope(repo, features, scope, { includeRemote: true });
  validateInventoryInheritance(features, scopeResult, scope);
  const ordered = scopeResult.ordered;
  const warnings = [...scopeResult.warnings];
  // §13: remote-only branches are READ from origin/<branch> during derivation.
  const materializeSet = new Set(ordered.filter((e) => e.materialize).map((e) => e.branch));
  const refOf = (b: string): string => (materializeSet.has(b) ? `origin/${b}` : b);

  const featureByBranch = new Map<string, FeatureEntry>();
  for (const f of features) if (f.branch) featureByBranch.set(f.branch, f);

  const ancestorsMap = transitiveAncestors(scopeResult.edges);
  const entrySet = new Set(ordered.filter((e) => e.mergeModel === 'upstream-chain').map((e) => e.branch));
  const inventoryBranches = ordered.filter((e) => e.mergeModel === 'parents').map((e) => e.branch);
  const leaves = findLeaves(inventoryBranches, scopeResult.edges);

  const branches: BranchPlan[] = [];
  const byBranch = new Map<string, BranchPlan>();

  // D-057 block-height map: every currently-blocked branch (merge_status != NONE)
  // with the height it is blocked at, for the height-MIN DEFER rule. Seeded from
  // the HELD registry (PR_ID branches, this-pass + cross-pass; height re-derived
  // in `held`) and GROWN in DAG order — a branch DEFERRED this pass (or sticky
  // from a prior pass) becomes a blocked parent for its own children. Heights
  // are live per-pass values, never read from merge_status.
  const blockHeightOf = new Map<string, number>();
  for (const rec of held) blockHeightOf.set(rec.branch, rec.height);
  // The LIVE blocked set (merge_status != NONE) as of this point in DAG order:
  // PR_ID branches (origin rows + held registry) up front; DEFERRED branches join as
  // they are sticky-confirmed; freshly-deferring branches join as derived.
  const blockedNow = new Set<string>([
    ...held.map((r) => r.branch),
    ...[...mergeStatusOf.entries()].filter(([, s]) => s === 'PR_ID').map(([b]) => b),
  ]);

  for (const entry of ordered) {
    const model: 'entry' | 'parents' = entry.mergeModel === 'upstream-chain' ? 'entry' : 'parents';
    const parents = model === 'entry' ? ['main'] : entry.parents;
    const feat = featureByBranch.get(entry.branch) as (FeatureEntry & { always_merge?: boolean }) | undefined;
    // This branch's own merge_status view (D-057): PR_ID → empty interval;
    // DEFERRED → sticky iff a DIRECT parent is still blocked (STAY rule —
    // recomputed from the parents, never trusted as an independent flag);
    // with every parent NONE it derives NORMALLY (the "re-merge fresh" view;
    // `run` commits the actual clear).
    let mergeBlocked: DeriveBranchArgs['mergeBlocked'];
    if (mergeStatusOf.get(entry.branch) === 'PR_ID') {
      mergeBlocked = { state: 'PR_ID' };
    } else if (mergeStatusOf.get(entry.branch) === 'DEFERRED') {
      const blockedParents = parents.filter((p) => blockedNow.has(p));
      if (blockedParents.length > 0) {
        const behind = blockedParents.reduce((lo, p) =>
          (blockHeightOf.get(p) ?? Infinity) < (blockHeightOf.get(lo) ?? Infinity) ? p : lo,
        );
        mergeBlocked = { state: 'DEFERRED', behind };
      }
    }
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
      blockHeightOf,
      // D-049 §2 lever: per-feature `stack_cap` beats the routing.yaml global.
      stackCap: feat?.stack_cap ?? opts.stackCap ?? DEFAULT_STACK_CAP,
      mergeBlocked,
      materialize: entry.materialize === true,
      refOf,
    });
    branches.push(bp);
    byBranch.set(bp.branch, bp);
    if (mergeBlocked) blockedNow.add(bp.branch); // PR_ID or sticky-DEFERRED stays blocked
    // A branch DEFERRED this pass (fresh or sticky) is itself blocked: record its
    // lowest own-conflict height so its children defer behind it (D-057).
    const deferHeights = bp.parents.filter((pp) => pp.verdict === 'defer' && pp.deferHeight !== undefined).map((pp) => pp.deferHeight!);
    if (deferHeights.length) {
      blockedNow.add(bp.branch);
      if (!blockHeightOf.has(bp.branch)) blockHeightOf.set(bp.branch, Math.min(...deferHeights));
    }
  }

  // Leaf / always_merge un-skip (§6): a leaf whose every parent no-op'd, in a
  // pass that carries progress, un-skips its cheapest parent chain — forced
  // (empty) merges along the chain keep "every branch only merges its inventory
  // parents" uniform. NO merge-main-directly exception.
  if (passHasProgress) {
    for (const bp of branches) {
      if (blockedNow.has(bp.branch)) continue; // blocked leaves stay blocked (merge_status != NONE)
      if (!(bp.isLeaf || bp.alwaysMerge)) continue;
      if (!allParentsSkipped(bp)) continue;
      // D-057: the chain must not merge into/through a blocked hop — blocked
      // branches are excluded from the search (no unblocked chain = no un-skip).
      const uchain = shortestUnskipChain(bp.branch, scopeResult.edges, entrySet, blockedNow);
      if (uchain.length < 2) {
        // An entry IS reachable, but only through blocked hops: the un-skip is
        // ABORTED. Mark the rows so the step verifier's leaf rule knows this
        // all-skip is sanctioned (mirrors cmdRun's live derivation).
        if (shortestUnskipChain(bp.branch, scopeResult.edges, entrySet).length >= 2) {
          for (const pp of bp.parents) {
            if (pp.verdict === 'skip' || pp.verdict === 'up-to-date') pp.skipReason = 'unskip-blocked';
          }
        }
        continue; // no (unblocked) entry reachable
      }
      // §6 conflict pre-probe (2026-07-23 live ERR21): never mark a chain
      // forced when any hop — including the leaf's own — does not merge CLEAN
      // (simulated top-down, post-force ancestry). The leaf stays skipped this
      // pass ('unskip-conflict', the sanctioned all-skip); the conflicting hop
      // branch keeps its OWN verdict (its normal case derivation owns the
      // conflict). Mirrors cmdRun's live guard — plan and run stay consistent.
      if (!(await unskipChainClean(repo, uchain, refOf))) {
        for (const pp of bp.parents) {
          if (pp.verdict === 'skip' || pp.verdict === 'up-to-date') pp.skipReason = 'unskip-conflict';
        }
        continue;
      }
      bp.unskipChain = uchain;
      // Force a merge on each (child <- next parent) hop of the chain.
      for (let i = 0; i < uchain.length - 1; i++) {
        const child = byBranch.get(uchain[i]);
        const parent = uchain[i + 1];
        if (!child) continue;
        const parentTip = await revParse(repo, refOf(parent));
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

/** Per-branch signature: parents' verdicts + merge points + defers + forced flags. */
export function branchSignature(bp: BranchPlan): string {
  return JSON.stringify(
    bp.parents.map((pp) => [pp.parent, pp.verdict, pp.mergePoint?.sha ?? null, pp.deferredTo, pp.forced ?? false]),
  );
}

/** Two plans are equivalent when their branch verdicts + merge points match (idempotency, §8). */
export function plansEquivalent(a: PropagationPlan, b: PropagationPlan): boolean {
  if (a.watermark !== b.watermark) return false;
  if (a.order.join(',') !== b.order.join(',')) return false;
  const sig = (p: PropagationPlan) => JSON.stringify(p.branches.map((bp) => [bp.branch, branchSignature(bp)]));
  return sig(a) === sig(b);
}

/**
 * Branches whose signature differs between `prev` and `cur`, EXCLUDING those in
 * `exclude` (arrived / reopened / driver-touched). Used by `run` to detect git
 * moving under us for not-yet-processed branches (§8 plan-equivalence).
 */
export function plansDiffer(prev: PropagationPlan, cur: PropagationPlan, exclude: Set<string>): string[] {
  const prevSig = new Map(prev.branches.map((bp) => [bp.branch, branchSignature(bp)]));
  const drifted: string[] = [];
  for (const bp of cur.branches) {
    if (exclude.has(bp.branch)) continue;
    const before = prevSig.get(bp.branch);
    if (before !== undefined && before !== branchSignature(bp)) drifted.push(bp.branch);
  }
  return drifted;
}
