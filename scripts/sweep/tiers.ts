/**
 * scripts/sweep/tiers.ts — tier types, floors, and the ONLY legal tier
 * transitions (PROPAGATION.md §1, D-035/D-015/D-012).
 *
 * Tier decisions are demote-only in the driver:
 *  - CLEAN vs conflict is computed mechanically (new-style merge-tree).
 *  - MECHANICAL vs JUDGED is CLAIMED by the resolving agent but only ever
 *    DEMOTED, never promoted: a scope-guard violation (§7) demotes
 *    MECHANICAL->JUDGED and JUDGED->HELD; a cold-read rejection demotes to HELD;
 *    a red verification gate (§9) demotes any executed tier to HELD.
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

/** The only tiers a resolving agent may claim (§7). */
export function isClaimableTier(tier: string): tier is 'mechanical' | 'judged' {
  return tier === 'mechanical' || tier === 'judged';
}

/**
 * Tier floor for a branch (§1, D-015). `edition/*` and any inventory entry
 * flagged `tier_floor: judged` never merge below JUDGED; everyone else floors
 * at CLEAN.
 */
export function tierFloor(branch: string, entry?: FeatureEntry & { tier_floor?: string }): Tier {
  if (/^edition\//.test(branch)) return 'judged';
  if (entry && (entry as { tier_floor?: string }).tier_floor === 'judged') return 'judged';
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
 * Demotion on a scope-guard violation (§7, D-038): MECHANICAL->JUDGED,
 * JUDGED->HELD, HELD->HELD. CLEAN is not agent-resolved so it has no scope
 * guard and is returned unchanged.
 */
export function demoteForScopeViolation(tier: Exclude<Tier, 'deferred'>): Exclude<Tier, 'deferred'> {
  if (tier === 'mechanical') return 'judged';
  if (tier === 'judged') return 'held';
  return tier;
}

/** Cold-read rejection or red verification gate: demote straight to HELD (§1/§9). */
export function demoteToHeld(): 'held' {
  return 'held';
}
