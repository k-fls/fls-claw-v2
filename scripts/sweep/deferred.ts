/**
 * scripts/sweep/deferred.ts — the ancestor-HELD matching rule (PROPAGATION.md
 * §5, D-036).
 *
 * When the sweep finds branch C's first conflicting height N' against parent Q,
 * and the pass registry records a TRANSITIVE inventory ancestor P (not only a
 * direct parent) HELD at height N with conflicted path set S_P:
 *   - N lies in the CONFLICTING WINDOW `(floor, N']` AND C's conflicted paths
 *     intersect S_P -> DEFERRED (freeze, NO PR, journal pointer at P;
 *     auto-unfreeze when P clears). `floor` is the largest clean height below
 *     the conflict on C's eligible line (the merge-point height when one
 *     exists, else C's coverage at line-build time): the held commit's content
 *     is part of what this merge would newly introduce.
 *   - height inside the window but paths DISJOINT -> NOT deferred: C's own
 *     independent conflict; normal MECHANICAL/JUDGED/HELD ladder.
 *
 * Exact equality N' == N is the special case where the eligible line has a head
 * at N (entry model / fine-grained lines). Parents-model lines are usually
 * coarser — a parent that advanced in one merge has a single head far above N —
 * so the window rule is the faithful generalization (spec §5, updated
 * 2026-07-18). Height is the comparison key (never date/subject).
 */
import type { HeldRecord } from './types.js';

export interface DeferDecision {
  deferred: boolean;
  /** The ancestor HELD record this conflict belongs to (when deferred). */
  ancestor: HeldRecord | null;
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((p) => set.has(p));
}

/**
 * Decide whether C's first conflict is DEFERRED to a HELD ancestor.
 *
 * @param firstConflictHeight  C's first conflicting height N' against Q.
 * @param floor                largest clean height below the conflict on C's
 *                             eligible line (merge-point height, else coverage);
 *                             the window is the half-open `(floor, N']`.
 * @param conflictedPaths      C's conflicted path set at that height.
 * @param transitiveAncestors  every transitive inventory ancestor of C.
 * @param held                 the pass registry of HELD branches.
 */
export function checkDeferred(
  firstConflictHeight: number,
  floor: number,
  conflictedPaths: string[],
  transitiveAncestors: string[],
  held: HeldRecord[],
): DeferDecision {
  const ancestorSet = new Set(transitiveAncestors);
  for (const rec of held) {
    if (!ancestorSet.has(rec.branch)) continue;
    // N must lie in the conflicting window (floor, N'] — the held commit's
    // content is part of what this merge newly introduces.
    if (!(rec.height > floor && rec.height <= firstConflictHeight)) continue;
    if (intersects(conflictedPaths, rec.conflictedPaths)) {
      return { deferred: true, ancestor: rec };
    }
    // In-window but disjoint paths -> C's own independent conflict (NOT deferred).
  }
  return { deferred: false, ancestor: null };
}
