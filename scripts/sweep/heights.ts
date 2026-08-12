/**
 * scripts/sweep/heights.ts — watermark pinning, trunk-chain enumeration,
 * height<->sha, and coverage derivation (PROPAGATION.md §2).
 *
 * A PASS pins `upstream/main`'s tip once (the watermark); the trunk
 * first-parent chain is enumerated ONCE from the fork point and each commit
 * gets a 0-based index (its HEIGHT). A merge head is a `{sha, height}` pair.
 * Coverage is NEVER stored (§2): a branch's covered height is the highest
 * chain index whose commit is an ancestor of the branch tip. Ancestry along a
 * first-parent chain is monotonic, so coverage is binary-searchable with
 * `git merge-base --is-ancestor` (O(log n) probes). Conflict-ness is NOT
 * monotonic and is NEVER bisected (that is interval.ts's linear sweep).
 */
import { firstParentChain, isAncestor, revParse } from './git.js';
import type { Head } from './types.js';

/**
 * The pinned trunk chain for a pass. `heads[i].height === i`; `heads` is
 * oldest-first (height 0 is the oldest pending commit, the last head is the
 * watermark tip). Captured once and reused for the whole pass — never re-read
 * mid-pass, so upstream advancing is invisible until the next pass (§2).
 */
export interface Chain {
  /** Pinned watermark sha (upstream/main tip at pass start). */
  watermark: string;
  /** Exclusive lower bound the chain was enumerated from (fork point / base). */
  base: string;
  heads: Head[];
}

/** Pin the watermark: resolve the upstream ref to a concrete sha, once per pass. */
export async function pinWatermark(repo: string, upstreamRef: string): Promise<string> {
  return revParse(repo, upstreamRef);
}

/**
 * Enumerate the trunk first-parent chain from `base` (exclusive) up to
 * `tipRef` (the pinned watermark), assigning each commit its height index.
 * `tipRef` should already be a pinned sha so the chain is stable for the pass.
 */
export async function enumerateChain(repo: string, tipRef: string, base: string): Promise<Chain> {
  const watermark = await revParse(repo, tipRef);
  const shas = await firstParentChain(repo, watermark, base);
  const heads = shas.map((sha, height) => ({ sha, height }));
  return { watermark, base: await revParse(repo, base), heads };
}

/** The watermark head (largest height), or null for an empty chain. */
export function tipHead(chain: Chain): Head | null {
  return chain.heads.length > 0 ? chain.heads[chain.heads.length - 1] : null;
}

/** sha at a given height, or null if out of range. */
export function shaAtHeight(chain: Chain, height: number): string | null {
  return chain.heads[height]?.sha ?? null;
}

/** Height of a trunk sha, or -1 if it is not on the chain. */
export function heightOfSha(chain: Chain, sha: string): number {
  return chain.heads.findIndex((h) => h.sha === sha);
}

/**
 * DERIVED coverage (§2): the largest chain height whose commit is an
 * ancestor of `branchTip`, or -1 when even the oldest chain commit is not yet
 * reached. Binary search over the monotone ancestry predicate — O(log n)
 * `--is-ancestor` probes. Returns the probe count for cost assertions.
 */
export async function deriveCoverage(
  repo: string,
  chain: Chain,
  branchTip: string,
): Promise<{ height: number; probes: number }> {
  const heads = chain.heads;
  if (heads.length === 0) return { height: -1, probes: 0 };
  let probes = 0;
  const ancestor = async (i: number): Promise<boolean> => {
    probes++;
    return isAncestor(repo, heads[i].sha, branchTip);
  };
  // Monotone: if heads[i] is an ancestor then every heads[j<i] is too.
  if (!(await ancestor(0))) return { height: -1, probes };
  let lo = 0;
  let hi = heads.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await ancestor(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { height: lo, probes };
}
