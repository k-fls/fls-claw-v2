/**
 * scripts/sweep/stop-points.ts — per-branch largest clean prefix of the
 * upstream FIRST-PARENT chain (unit of merge = upstream PR merge commit).
 *
 * If the tip merge is clean the stop point is the upstream tip; otherwise we
 * bisect the first-parent chain with new-style merge-tree probes for the last
 * commit whose merge into the branch is conflict-free. Per-branch stop points
 * mean one branch's conflict never holds back the others.
 */
import { firstParentChain, newStyleMergeTree } from './git.js';

export interface StopPointResult {
  branch: string;
  /** Upstream ref already reachable from the branch. */
  upToDate: boolean;
  /** Tip merge is conflict-free. */
  cleanAtTip: boolean;
  /** Conflict files at the upstream tip (empty when cleanAtTip). */
  conflictFiles: string[];
  /** Last clean first-parent commit; null = even the oldest pending commit conflicts. */
  stopPoint: string | null;
  /** Pending first-parent commits total / covered by the stop point. */
  chainLength: number;
  mergedCount: number;
  /** merge-tree probes performed (bisection cost). */
  probes: number;
}

export async function findStopPoint(repo: string, branch: string, upstreamRef: string): Promise<StopPointResult> {
  const chain = await firstParentChain(repo, upstreamRef, branch);
  if (chain.length === 0) {
    return {
      branch,
      upToDate: true,
      cleanAtTip: true,
      conflictFiles: [],
      stopPoint: null,
      chainLength: 0,
      mergedCount: 0,
      probes: 0,
    };
  }
  let probes = 1;
  const tipMerge = await newStyleMergeTree(repo, branch, chain[chain.length - 1]);
  if (tipMerge.clean) {
    return {
      branch,
      upToDate: false,
      cleanAtTip: true,
      conflictFiles: [],
      stopPoint: chain[chain.length - 1],
      chainLength: chain.length,
      mergedCount: chain.length,
      probes,
    };
  }
  // Bisect for the last clean prefix commit. Invariant: clean(lo)=true
  // (lo=-1 is the virtual "merge nothing" no-op), clean(hi)=false.
  let lo = -1;
  let hi = chain.length - 1;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    probes++;
    const probe = await newStyleMergeTree(repo, branch, chain[mid]);
    if (probe.clean) lo = mid;
    else hi = mid;
  }
  return {
    branch,
    upToDate: false,
    cleanAtTip: false,
    conflictFiles: tipMerge.conflictFiles,
    stopPoint: lo >= 0 ? chain[lo] : null,
    chainLength: chain.length,
    mergedCount: lo + 1,
    probes,
  };
}
