/**
 * scripts/sweep/tiers.ts — tier types, floors, and the ONLY legal tier
 * transitions (DRIVER.md §8.1).
 *
 * Tier decisions are demote-only in the driver:
 *  - CLEAN vs conflict is computed mechanically (new-style merge-tree).
 *  - MECHANICAL vs JUDGED is CLAIMED by the resolving agent but only ever
 *    DEMOTED, never promoted: a scope-guard violation goes straight to HELD
 *    with NO merge (§7 — a one-tier demotion would still
 *    land the out-of-scope content); a cold-read rejection demotes to HELD; a
 *    red verification gate (§9) demotes any executed tier to HELD.
 *  - `edition/*` and entries flagged `tier_floor: judged` never merge below
 *    JUDGED — the floor RAISES the minimum severity (policy, not a promotion of
 *    the agent's claim).
 */
import type { FeatureEntry, Tier } from './types.js';

/** Ladder severity (deferred is off-ladder and has no severity). */
const SEVERITY: Record<Exclude<Tier, 'deferred'>, number> = {
  clean: 0,
  mechanical: 1,
  judged: 2,
  held: 3,
};

export function severity(tier: Exclude<Tier, 'deferred'>): number {
  return SEVERITY[tier];
}

/**
 * Tier floor for a branch (§1). `edition/*` and any inventory entry
 * flagged `tier_floor: judged` never merge below JUDGED; everyone else floors
 * at CLEAN.
 */
export function tierFloor(branch: string, entry?: FeatureEntry): Tier {
  if (/^edition\//.test(branch)) return 'judged';
  if (entry?.tier_floor === 'judged') return 'judged';
  return 'clean';
}

/** Raise `tier` to at least `floor` (severity max). Never lowers. */
export function applyFloor(
  tier: Exclude<Tier, 'deferred'>,
  floor: Exclude<Tier, 'deferred'>,
): Exclude<Tier, 'deferred'> {
  return SEVERITY[tier] >= SEVERITY[floor] ? tier : floor;
}

/**
 * Cold-read rejection, scope-guard violation, or red verification gate all
 * demote straight to HELD (§1/§7/§9). A scope violation is HELD-with-no-merge:
 * demoting one tier (to JUDGED) would still land the out-of-scope content, so
 * the guard would not actually guard.
 */
export function demoteToHeld(): 'held' {
  return 'held';
}
