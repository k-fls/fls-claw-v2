/**
 * scripts/sweep/interval.ts — eligible-line construction (§4) and the LINEAR
 * merge-point sweep (§3, D-037).
 *
 * "Merging up to height k conflicts" is NOT monotonic in k: a later upstream
 * commit can rewrite a disputed region so the tip-level three-way merge is
 * clean again. So we NEVER bisect for conflicts (that is stop-points.ts's
 * monotonicity assumption, kept for the scan forecast only). Instead: one
 * full-range merge-tree probe first (the common case — clean, one probe); on
 * conflict, a linear oldest->newest sweep, merging at the LARGEST clean height
 * (which may lie beyond intermediate conflicting heights).
 *
 * Case stacking (D-049 §2): the reported case STARTS at the smallest
 * conflicting height above the merge point and is the MAXIMAL RUN of
 * consecutive conflicting heights whose conflicted path sets intersect (one
 * logical decision), capped (`stack_cap`, default 5). The run breaks at a
 * clean height, at a disjoint-path conflict (its own case later), and at the
 * cap. The case's head is the run's TOP commit — conflict set and automerge
 * tree are taken at the top, so resolving the case resolves the whole run.
 *
 * All probes are new-style `git merge-tree` (git.ts) — never single-base
 * `--merge-base=`, never cherry-pick.
 */
import { DEFAULT_STACK_CAP } from './config.js';
import { deriveCoverage, type Chain } from './heights.js';
import { firstParentChain, isAncestor, newStyleMergeTree, revParse } from './git.js';
import type { Head } from './types.js';

export interface EligibleLine {
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  /** Candidate heads above the branch's current coverage, ascending by height. */
  heads: Head[];
  /** Branch's derived coverage at build time (§2). */
  coverage: number;
}

export interface BuildEligibleLineArgs {
  repo: string;
  branch: string;
  /** Concrete tip sha of the branch (pinned by the caller for the pass). */
  branchTip: string;
  parent: string;
  /**
   * Ref to READ the parent's tip from (D-045, §13): defaults to the parent's
   * branch name; a remote-only (materialize) parent is read as
   * `origin/<parent>` — plan-time probes never require a local ref.
   */
  parentRef?: string;
  model: 'entry' | 'parents';
  chain: Chain;
}

/**
 * Eligible line for one (branch, parent) pair (§4):
 *  - entry model: candidate heads are the trunk chain commits above the
 *    branch's coverage (heads' shas ARE trunk commits).
 *  - parents model: candidate heads are the PARENT branch's own first-parent
 *    commits, each carrying a DERIVED covered height; we keep the newest
 *    parent commit per distinct covered height above the branch's coverage.
 *    If the parent advanced in one big merge, intermediate heights simply do
 *    not exist — the child cannot merge them this pass (relevant to DEFERRED).
 *  - Fork-only parent content (§4, updated 2026-07-18): when the height-filtered
 *    line would be EMPTY but the parent tip is NOT an ancestor of the child, the
 *    parent tip itself (at its derived height, which may equal the child's
 *    coverage) is the single candidate head — otherwise a fork fix merged into a
 *    parent would never reach descendants until upstream next advanced. Safe
 *    because coverage is non-decreasing along the parent's first-parent line, so
 *    when the filtered map is non-empty its top head already IS the parent tip.
 */
export async function buildEligibleLine(args: BuildEligibleLineArgs): Promise<EligibleLine> {
  const { repo, branch, branchTip, parent, model, chain } = args;
  const coverage = (await deriveCoverage(repo, chain, branchTip)).height;

  if (model === 'entry') {
    const heads = chain.heads.filter((h) => h.height > coverage);
    return { branch, parent, model, heads, coverage };
  }

  // parents model: walk the parent's own first-parent line, oldest -> newest,
  // deriving each commit's trunk coverage; newest commit wins its height bucket.
  const parentTip = await revParse(repo, args.parentRef ?? parent);
  const lineShas = await firstParentChain(repo, parentTip, chain.base);
  const byHeight = new Map<number, string>();
  for (const sha of lineShas) {
    const h = (await deriveCoverage(repo, chain, sha)).height;
    if (h > coverage) byHeight.set(h, sha); // oldest->newest: last write = newest
  }
  let heads: Head[] = [...byHeight.entries()]
    .map(([height, sha]) => ({ sha, height }))
    .sort((a, b) => a.height - b.height);

  // Fork-only parent content: no upstream progress above coverage, but the
  // parent carries new fork commits the child has not absorbed -> the parent
  // tip is the single candidate head.
  if (heads.length === 0 && !(await isAncestor(repo, parentTip, branchTip))) {
    const h = (await deriveCoverage(repo, chain, parentTip)).height;
    heads = [{ sha: parentTip, height: h }];
  }
  return { branch, parent, model, heads, coverage };
}

export interface HeadProbe {
  head: Head;
  clean: boolean;
  conflictFiles: string[];
  treeOid: string;
}

export interface MergePointResult {
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  /** No eligible heads above coverage — nothing to merge from this parent. */
  upToDate: boolean;
  /** The full-range probe against the newest head was clean (one probe total). */
  cleanFullRange: boolean;
  /** Largest clean head (§3 step 3); null when even the oldest head conflicts. */
  mergePoint: Head | null;
  /**
   * The stacked conflict run ABOVE the merge point (§3 step 4, D-049 §2):
   * starts at the smallest conflicting height, extends over consecutive
   * path-intersecting conflicting heights, capped. `head` is the run's TOP;
   * paths/tree are the top probe's.
   */
  firstConflict: {
    head: Head;
    run: Head[];
    conflictedPaths: string[];
    automergeTree: string;
    reproduction: { command: string };
  } | null;
  probes: HeadProbe[];
  probeCount: number;
}

function reproCommand(branch: string, headSha: string): { command: string } {
  return { command: `git merge-tree --write-tree --name-only ${branch} ${headSha}` };
}

/**
 * Linear merge-point sweep over an eligible line (§3). One full-range probe;
 * on conflict a linear oldest->newest sweep. Returns the largest clean head as
 * the merge point and the stacked conflict run above it as the case (D-049 §2):
 * the run starts at the smallest conflicting height and extends over
 * consecutive path-intersecting conflicting heights up to `stackCap`.
 */
export async function mergePointSweep(
  repo: string,
  branchRef: string,
  line: EligibleLine,
  stackCap: number = DEFAULT_STACK_CAP,
): Promise<MergePointResult> {
  const { branch, parent, model, heads } = line;
  const base = { branch, parent, model } as const;
  if (heads.length === 0) {
    return {
      ...base,
      upToDate: true,
      cleanFullRange: true,
      mergePoint: null,
      firstConflict: null,
      probes: [],
      probeCount: 0,
    };
  }

  // Step 1: probe the full range (newest head) first.
  const last = heads[heads.length - 1];
  const fullProbe = await newStyleMergeTree(repo, branchRef, last.sha);
  const lastHeadProbe: HeadProbe = {
    head: last,
    clean: fullProbe.clean,
    conflictFiles: fullProbe.conflictFiles,
    treeOid: fullProbe.treeOid,
  };
  if (fullProbe.clean) {
    return {
      ...base,
      upToDate: false,
      cleanFullRange: true,
      mergePoint: last,
      firstConflict: null,
      probes: [lastHeadProbe],
      probeCount: 1,
    };
  }

  // Step 2: linear oldest->newest sweep (reusing the full-range probe for the tip).
  const probes: HeadProbe[] = [];
  for (let i = 0; i < heads.length - 1; i++) {
    const mt = await newStyleMergeTree(repo, branchRef, heads[i].sha);
    probes.push({ head: heads[i], clean: mt.clean, conflictFiles: mt.conflictFiles, treeOid: mt.treeOid });
  }
  probes.push(lastHeadProbe);

  // Step 3: merge at the largest clean height (may be beyond conflicting ones).
  let mergePoint: Head | null = null;
  for (const p of probes)
    if (p.clean && (mergePoint === null || p.head.height > mergePoint.height)) mergePoint = p.head;

  // Step 4 (D-049 §2): the case run. It STARTS at the smallest conflicting
  // height above the merge point (when there is no clean head the floor is
  // below EVERY head — heights can be -1 (fork-only), so -Infinity, not -1, or
  // a fork-only conflict at height -1 would be missed) and STACKS consecutive
  // conflicting heights whose path sets intersect the run's accumulated set,
  // breaking at a clean height (defensive — above the LARGEST clean height all
  // heads conflict by construction), at a disjoint-path conflict (its own case
  // later), and at the cap.
  const floor = mergePoint?.height ?? Number.NEGATIVE_INFINITY;
  const above = probes.filter((p) => p.head.height > floor).sort((a, b) => a.head.height - b.head.height);
  let firstConflict: MergePointResult['firstConflict'] = null;
  const start = above.findIndex((p) => !p.clean);
  if (start >= 0) {
    const runProbes: HeadProbe[] = [above[start]];
    const runPaths = new Set(above[start].conflictFiles);
    for (let i = start + 1; i < above.length && runProbes.length < stackCap; i++) {
      const p = above[i];
      if (p.clean) break; // never stack across a clean height
      if (!p.conflictFiles.some((f) => runPaths.has(f))) break; // disjoint -> own case later
      runProbes.push(p);
      for (const f of p.conflictFiles) runPaths.add(f);
    }
    const top = runProbes[runProbes.length - 1];
    firstConflict = {
      head: top.head,
      run: runProbes.map((p) => p.head),
      conflictedPaths: top.conflictFiles,
      automergeTree: top.treeOid,
      reproduction: reproCommand(branchRef, top.head.sha),
    };
  }

  return {
    ...base,
    upToDate: false,
    cleanFullRange: false,
    mergePoint,
    firstConflict,
    probes,
    probeCount: probes.length,
  };
}
