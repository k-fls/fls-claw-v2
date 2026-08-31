/**
 * scripts/sweep/interval.ts — eligible-line construction (§4) and the LINEAR
 * merge-point sweep (§3).
 *
 * "Merging up to height k conflicts" is NOT monotonic in k: a later upstream
 * commit can rewrite a disputed region so the tip-level three-way merge is
 * clean again. So we NEVER bisect for conflicts. Instead: one
 * full-range merge-tree probe first (the common case — clean, one probe); on
 * conflict, a linear oldest->newest sweep, merging at the LARGEST clean height
 * (which may lie beyond intermediate conflicting heads).
 *
 * Case stacking (DRIVER.md §4.4): the reported case STARTS at the first
 * conflicting head above the merge point and is the MAXIMAL RUN of consecutive
 * conflicting heads whose conflicted path sets intersect (one logical
 * decision), capped (`stack_cap`, default 5). The run breaks at a clean head,
 * at a disjoint-path conflict (its own case later), and at the cap. The case's
 * head is the run's TOP commit — conflict set and automerge tree are taken at
 * the top, so resolving the case resolves the whole run, and content above the
 * top is left out of the branch, the case and the fix ref alike.
 *
 * The line is walked by POSITION, not by height: parents-model heads are the
 * parent's own commits, and a run of fork-side commits shares one derived
 * height. Heights remain projections onto the trunk — what the trim, the
 * DEFERRED check and the machine block read — and are never the sweep's order.
 *
 * All probes are new-style `git merge-tree` (git.ts) — never single-base
 * `--merge-base=`, never cherry-pick.
 */
import { DEFAULT_STACK_CAP } from './config.js';
import { deriveCoverage, type Chain } from './heights.js';
import { firstParentChain, newStyleMergeTree, revParse } from './git.js';
import type { Head } from './types.js';

export interface EligibleLine {
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  /**
   * Candidate heads the branch has not absorbed, oldest -> newest. Coverage is
   * non-decreasing along that order, so heights are non-decreasing too — but
   * they REPEAT wherever a parent's commits are fork-side, so order is the
   * position in this array and never the height.
   */
  heads: Head[];
  /** Branch's derived coverage at build time (§2). */
  coverage: number;
  /**
   * Set when the trim actually removed candidates: there IS content waiting for
   * this branch and it is held back by an unresolved conflict above.
   *
   * "Nothing to take" and "something to take, blocked upstream" are different
   * facts and the pass must not report them the same way — the second is what
   * the owner is waiting on, and what the urge comments count.
   */
  trimmedAt?: number;
}

export interface BuildEligibleLineArgs {
  repo: string;
  branch: string;
  /** Concrete tip sha of the branch (pinned by the caller for the pass). */
  branchTip: string;
  parent: string;
  /**
   * Ref to READ the parent's tip from (§13): defaults to the parent's
   * branch name; a remote-only (materialize) parent is read as
   * `origin/<parent>` — plan-time probes never require a local ref.
   */
  parentRef?: string;
  model: 'entry' | 'parents';
  chain: Chain;
  /**
   * THE CUT (DRIVER.md §5.2): the trunk coordinate this branch's window closes
   * at — the minimum over its parents' cuts. Nothing at or above it is
   * eligible: that content cannot integrate until the proposal above is
   * resolved, and merging it anyway advances the branch onto a state the trunk
   * has never seen, which the integration rebuild then reports as the branch's
   * own conflict.
   *
   * `-Infinity` closes the whole range — a branch under repair is red, not
   * red-above-height-k, so no prefix of it is proven clean.
   *
   * Omitted = nothing above this branch is blocked = the full line is eligible.
   */
  blockedAtHeight?: number;
}

/**
 * Eligible line for one (branch, parent) pair (§4):
 *  - entry model: candidate heads are the trunk chain commits above the
 *    branch's coverage (heads' shas ARE trunk commits).
 *  - parents model: candidate heads are the PARENT branch's own first-parent
 *    commits that the branch has NOT yet absorbed — EVERY such commit, each
 *    carrying its DERIVED covered height. If the parent advanced in one big
 *    merge, intermediate heights simply do not exist; the commits that DO exist
 *    are all offered (relevant to DEFERRED).
 *
 * ENUMERATION IS AT COMMIT GRAIN. Fork-side commits advance no upstream
 * coverage, so a whole run of them derives ONE height; keeping only the newest
 * commit per height collapses that run to the parent's tip, and a one-head line
 * has no clean prefix to merge and no older head to sweep. The branch then takes
 * nothing, the case head is the tip, and the held fix ref carries the parent's
 * whole tip instead of the commits the pass actually verified.
 *
 * ABSORPTION IS ANCESTRY, NOT HEIGHT. The walk excludes what the branch already
 * contains (`^branchTip`), which is also the exact bound of the unabsorbed
 * window — a shorter walk than one to the chain base. A height filter cannot
 * say this: heights repeat along a fork-side run, so `h <= coverage` would drop
 * commits the branch does not have, and it can express no intra-run progress at
 * all. This is also what carries fork-only parent content down: a parent whose
 * only new work is fork-side has that work enumerated as ordinary heads, so a
 * fork fix merged into a parent reaches descendants without waiting for upstream
 * to advance.
 */
export async function buildEligibleLine(args: BuildEligibleLineArgs): Promise<EligibleLine> {
  const { repo, branch, branchTip, parent, model, chain } = args;
  const coverage = (await deriveCoverage(repo, chain, branchTip)).height;
  const trim = args.blockedAtHeight ?? Infinity;

  if (model === 'entry') {
    const above = chain.heads.filter((h) => h.height > coverage);
    const heads = above.filter((h) => h.height < trim);
    return { branch, parent, model, heads, coverage, ...(heads.length < above.length ? { trimmedAt: trim } : {}) };
  }

  // parents model: walk the parent's own first-parent line, oldest -> newest,
  // over exactly what the branch has not absorbed, deriving each commit's trunk
  // coverage.
  const parentTip = await revParse(repo, args.parentRef ?? parent);
  const lineShas = await firstParentChain(repo, parentTip, branchTip);
  const heads: Head[] = [];
  let trimmed = false;
  for (const sha of lineShas) {
    const h = (await deriveCoverage(repo, chain, sha)).height;
    // THE TRIM STAYS HEIGHT-GRAIN: it is a statement about trunk content nobody
    // has integrated, so it withholds every head at or above the block —
    // including a blocked parent's TIP, which is precisely the state that cannot
    // integrate. Without it descendants merge that tip cleanly, advance on it,
    // and meet the trunk for the first time in the integration rebuild, which
    // blames THEM. Coverage is non-decreasing along a first-parent line, so the
    // withheld heads are a suffix.
    if (h >= trim) {
      trimmed = true;
      continue;
    }
    heads.push({ sha, height: h });
  }
  return { branch, parent, model, heads, coverage, ...(trimmed ? { trimmedAt: trim } : {}) };
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
   * The stacked conflict run ABOVE the merge point (§3 step 4; DRIVER.md §4.4):
   * starts at the first conflicting head above it, extends over consecutive
   * path-intersecting conflicting heads, capped. `head` is the run's TOP;
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
 * the merge point and the stacked conflict run above it as the case (DRIVER.md §4.4):
 * the run starts at the first conflicting head above the merge point and
 * extends over consecutive path-intersecting conflicting heads up to `stackCap`.
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

  // Step 3: merge at the largest clean head — the LAST clean probe in line
  // order.
  //
  // ORDER IS THE POSITION IN THE LINE, NEVER THE HEIGHT. `probes` is in
  // eligible-line order (oldest -> newest) and coverage is non-decreasing along
  // that order, so position subsumes height and is exact where consecutive
  // heads share one height. Under the entry model heights strictly increase, so
  // this picks exactly what a height comparison picks. Under the parents model
  // a fork-side run shares one height, and a height comparison there fails
  // twice: it names an arbitrary member of the tied group as the merge point,
  // and it then hides every conflicting head at that same height from step 4 —
  // which comes back with no case while the branch stops dead below the cut.
  let mergeIndex = -1;
  for (let i = 0; i < probes.length; i++) if (probes[i].clean) mergeIndex = i;
  const mergePoint: Head | null = mergeIndex >= 0 ? probes[mergeIndex].head : null;

  // Step 4 (DRIVER.md §4.4): the case run. It STARTS at the first conflicting
  // head ABOVE the merge point — the cut — and STACKS consecutive conflicting
  // heads whose path sets intersect the run's accumulated set, breaking at a
  // clean head (defensive — above the LAST clean probe every head conflicts by
  // construction), at a disjoint-path conflict (its own case later), and at the
  // cap. Nothing above the run's top is in the case, so nothing above it enters
  // the held fix ref either.
  const above = probes.slice(mergeIndex + 1);
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
