/**
 * scripts/sweep/deferred.ts — the ancestor-HELD matching rule (PROPAGATION.md
 * §5, D-036).
 *
 * When the sweep finds branch C's first conflicting height N' against parent Q,
 * and the pass registry records a TRANSITIVE inventory ancestor P (not only a
 * direct parent) HELD at height N with conflicted path set S_P:
 *   - N' == N AND C's conflicted paths intersect S_P  -> DEFERRED (freeze, NO
 *     PR, journal pointer at P; auto-unfreeze when P clears).
 *   - N' == N but paths DISJOINT -> NOT deferred: C's own independent conflict
 *     on that commit; normal MECHANICAL/JUDGED/HELD ladder.
 *
 * Height is the comparison key (never date/subject); the sha is an integrity
 * check elsewhere. A conflict at a DIFFERENT height than any HELD ancestor is
 * never deferred.
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
 * @param conflictedPaths      C's conflicted path set at that height.
 * @param transitiveAncestors  every transitive inventory ancestor of C.
 * @param held                 the pass registry of HELD branches.
 */
export function checkDeferred(
  firstConflictHeight: number,
  conflictedPaths: string[],
  transitiveAncestors: string[],
  held: HeldRecord[],
): DeferDecision {
  const ancestorSet = new Set(transitiveAncestors);
  for (const rec of held) {
    if (!ancestorSet.has(rec.branch)) continue;
    if (rec.height !== firstConflictHeight) continue;
    if (intersects(conflictedPaths, rec.conflictedPaths)) {
      return { deferred: true, ancestor: rec };
    }
    // Same height, disjoint paths -> C's own independent conflict (NOT deferred).
  }
  return { deferred: false, ancestor: null };
}
