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
 * (which may lie beyond intermediate conflicting heights), reporting the
 * SMALLEST conflicting height above the merge point as the agent's case.
 *
 * All probes are new-style `git merge-tree` (git.ts) — never single-base
 * `--merge-base=`, never cherry-pick.
 */
import { deriveCoverage, type Chain } from './heights.js';
import { firstParentChain, newStyleMergeTree, revParse } from './git.js';
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
  const parentTip = await revParse(repo, parent);
  const lineShas = await firstParentChain(repo, parentTip, chain.base);
  const byHeight = new Map<number, string>();
  for (const sha of lineShas) {
    const h = (await deriveCoverage(repo, chain, sha)).height;
    if (h > coverage) byHeight.set(h, sha); // oldest->newest: last write = newest
  }
  const heads: Head[] = [...byHeight.entries()]
    .map(([height, sha]) => ({ sha, height }))
    .sort((a, b) => a.height - b.height);
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
  /** Smallest conflicting height ABOVE the merge point (§3 step 4). */
  firstConflict: {
    head: Head;
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
 * the merge point and the smallest conflicting head above it as the case.
 */
export async function mergePointSweep(repo: string, branchRef: string, line: EligibleLine): Promise<MergePointResult> {
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

  // Step 4: smallest conflicting height ABOVE the merge point.
  const floor = mergePoint?.height ?? -1;
  let firstConflict: MergePointResult['firstConflict'] = null;
  for (const p of probes) {
    if (!p.clean && p.head.height > floor && (firstConflict === null || p.head.height < firstConflict.head.height)) {
      firstConflict = {
        head: p.head,
        conflictedPaths: p.conflictFiles,
        automergeTree: p.treeOid,
        reproduction: reproCommand(branchRef, p.head.sha),
      };
    }
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
