/**
 * scripts/sweep/deferred.ts — the DEFERRED rule (MERGE-POLICY.md §1):
 * pure height-MIN over the branch's BLOCKED DIRECT PARENTS.
 *
 * When branch X hits its OWN conflict at height `conflictHeight` (the run TOP,
 * MERGE-POLICY.md §2), it is DEFERRED — clean prefix committed, STOP, NO PR — iff any
 * DIRECT parent is currently blocked (merge_status != NONE) AND the conflict is
 * at or above the LOWEST blocked parent's height:
 *
 *     defer  ⇔  blockedParents ≠ ∅  ∧  conflictHeight ≥ MIN(blockedParents.height)
 *
 * Below that MIN the parents are all clean, so the conflict is X's OWN
 * independent one (normal MECHANICAL/JUDGED/HELD ladder → raises its own PR).
 *
 * DEFERRED depends ONLY on DIRECT parents — never on conflicted paths, never
 * on the full ancestor set — because a clean intermediate parent (merge_status
 * NONE) correctly stops propagation until it re-merges the resolved content
 * (the cascade: parent resolves → its merge lands → NONE → the child re-merges
 * and may catch its own new PR). The height is the comparison key (never
 * date/subject). Heights are LIVE per-pass values, never stored in
 * merge_status.
 */

/** A direct parent that is currently blocked (merge_status != NONE), with the
 * height at which it is blocked (its own conflict/held height, live-derived). */
export interface BlockedParent {
  branch: string;
  height: number;
}

export interface DeferDecision {
  deferred: boolean;
  /** The lowest blocked parent this conflict defers behind (when deferred). */
  blockedBy: string | null;
}

/**
 * Decide whether X's own conflict at `conflictHeight` is DEFERRED.
 *
 * @param conflictHeight  the TOP height of X's conflicting run (MERGE-POLICY.md §2).
 * @param blockedParents  X's DIRECT parents that are blocked, with their heights.
 */
export function checkDeferred(conflictHeight: number, blockedParents: BlockedParent[]): DeferDecision {
  let min = Infinity;
  let lowest: string | null = null;
  for (const p of blockedParents) {
    if (p.height < min) {
      min = p.height;
      lowest = p.branch;
    }
  }
  if (lowest !== null && conflictHeight >= min) return { deferred: true, blockedBy: lowest };
  return { deferred: false, blockedBy: null };
}
