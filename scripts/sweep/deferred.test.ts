import { describe, expect, it } from 'vitest';

import { checkDeferred, type BlockedParent } from './deferred.js';

// checkDeferred(conflictHeight, blockedParents): X's own conflict DEFERS iff a
// blocked DIRECT parent exists AND conflictHeight >= MIN(blockedParents.height).
// Pure height-MIN — no path/window/ancestor-set test (D-057).
describe('checkDeferred — pure height-MIN over blocked direct parents (D-057)', () => {
  const A: BlockedParent = { branch: 'feat/a', height: 5 };
  const B: BlockedParent = { branch: 'feat/b', height: 10 };

  it('DEFERRED: conflict exactly at the blocked parent height', () => {
    const d = checkDeferred(5, [A]);
    expect(d.deferred).toBe(true);
    expect(d.blockedBy).toBe('feat/a');
  });

  it('DEFERRED: conflict above the blocked parent height', () => {
    expect(checkDeferred(9, [A]).deferred).toBe(true);
  });

  it('DEFERRED: multiple blocked parents -> compares against the LOWEST; blockedBy = lowest', () => {
    const d = checkDeferred(7, [B, A]); // MIN(10, 5) = 5; 7 >= 5
    expect(d.deferred).toBe(true);
    expect(d.blockedBy).toBe('feat/a');
  });

  it('NOT deferred: conflict below the lowest blocked parent (X\'s own independent conflict)', () => {
    const d = checkDeferred(4, [A, B]); // MIN = 5; 4 < 5
    expect(d.deferred).toBe(false);
    expect(d.blockedBy).toBeNull();
  });

  it('NOT deferred: no blocked parents (a clean parent stops propagation)', () => {
    const d = checkDeferred(6, []);
    expect(d.deferred).toBe(false);
    expect(d.blockedBy).toBeNull();
  });

  it('paths no longer matter: any conflict at/above MIN defers regardless of what changed', () => {
    // The retired rule required conflicted-path intersection; D-057 dropped it.
    expect(checkDeferred(10, [B]).deferred).toBe(true);
  });
});
