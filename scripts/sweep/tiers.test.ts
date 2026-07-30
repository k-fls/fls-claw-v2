import { describe, expect, it } from 'vitest';

import { applyFloor, demoteToHeld, severity, tierFloor } from './tiers.js';
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

  it('scope-guard violation / cold-read rejection / red gate all go straight to HELD', () => {
    // Scope violation is HELD-with-no-merge (2026-07-20): a one-tier demotion
    // would still land the out-of-scope content.
    expect(demoteToHeld()).toBe('held');
  });

  it('severity ladder is clean<mechanical<judged<held', () => {
    expect(severity('clean')).toBeLessThan(severity('mechanical'));
    expect(severity('mechanical')).toBeLessThan(severity('judged'));
    expect(severity('judged')).toBeLessThan(severity('held'));
  });
});
