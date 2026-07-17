import { describe, expect, it } from 'vitest';

import { applyFloor, demoteForScopeViolation, demoteToHeld, isClaimableTier, severity, tierFloor } from './tiers.js';
import type { FeatureEntry } from './types.js';

describe('tier floors (D-015)', () => {
  it('floors edition/* at judged', () => {
    expect(tierFloor('edition/fls-ai-bot')).toBe('judged');
  });

  it('floors a tier_floor:judged flagged entry at judged', () => {
    const entry = { id: 'x', name: 'x', kind: 'feat', status: 'shipped', tier_floor: 'judged' } as FeatureEntry & {
      tier_floor: string;
    };
    expect(tierFloor('feat/thing', entry)).toBe('judged');
  });

  it('floors everyone else at clean', () => {
    expect(tierFloor('feat/thing')).toBe('clean');
    expect(tierFloor('module/core')).toBe('clean');
  });
});

describe('legal transitions are demote-only (D-035)', () => {
  it('applyFloor never lowers, only raises', () => {
    expect(applyFloor('clean', 'judged')).toBe('judged'); // edition raises a clean merge
    expect(applyFloor('held', 'judged')).toBe('held'); // never lowered back to judged
    expect(applyFloor('mechanical', 'clean')).toBe('mechanical');
  });

  it('scope-guard violation demotes MECHANICAL->JUDGED, JUDGED->HELD', () => {
    expect(demoteForScopeViolation('mechanical')).toBe('judged');
    expect(demoteForScopeViolation('judged')).toBe('held');
    expect(demoteForScopeViolation('held')).toBe('held');
    // clean is not agent-resolved -> unchanged.
    expect(demoteForScopeViolation('clean')).toBe('clean');
  });

  it('cold-read rejection / red gate demote straight to HELD', () => {
    expect(demoteToHeld()).toBe('held');
  });

  it('only mechanical/judged are claimable by the agent', () => {
    expect(isClaimableTier('mechanical')).toBe(true);
    expect(isClaimableTier('judged')).toBe(true);
    expect(isClaimableTier('clean')).toBe(false);
    expect(isClaimableTier('held')).toBe(false);
    expect(isClaimableTier('deferred')).toBe(false);
  });

  it('severity ladder is clean<mechanical<judged<held', () => {
    expect(severity('clean')).toBeLessThan(severity('mechanical'));
    expect(severity('mechanical')).toBeLessThan(severity('judged'));
    expect(severity('judged')).toBeLessThan(severity('held'));
  });
});
