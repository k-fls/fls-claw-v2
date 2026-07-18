import { describe, expect, it } from 'vitest';

import { checkDeferred } from './deferred.js';
import type { HeldRecord } from './types.js';

const heldP: HeldRecord = {
  branch: 'feat/parent',
  height: 5,
  conflictedPaths: ['src/a.ts', 'src/b.ts'],
  caseId: 'feat__parent-h5',
};
const ancestors = ['feat/parent', 'main_patched'];

// Signature: checkDeferred(firstConflictHeight N', floor, conflictedPaths, ancestors, held).
// DEFERRED when an intersecting ancestor HELD height lies in the window (floor, N'].
describe('checkDeferred — conflicting-window rule (§5, D-036, updated 2026-07-18)', () => {
  it("DEFERRED: held height inside the window (floor, N'] + intersecting paths", () => {
    // window (2, 6] contains held height 5; coarse parents-model line (N' != N).
    const d = checkDeferred(6, 2, ['src/b.ts', 'src/c.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(true);
    expect(d.ancestor?.branch).toBe('feat/parent');
  });

  it("DEFERRED: exact equality N' == N is the fine-grained special case", () => {
    // window (4, 5] — held height 5 == N'.
    const d = checkDeferred(5, 4, ['src/a.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(true);
  });

  it('NOT deferred: held height at or below the floor (already-clean prefix)', () => {
    // window (5, 6] excludes held height 5.
    const d = checkDeferred(6, 5, ['src/a.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(false);
  });

  it("NOT deferred: held height above N' (not yet in this merge's window)", () => {
    // window (2, 4] excludes held height 5.
    const d = checkDeferred(4, 2, ['src/a.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(false);
  });

  it('NOT deferred: in-window but DISJOINT paths (own independent conflict)', () => {
    const d = checkDeferred(6, 2, ['src/z.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(false);
    expect(d.ancestor).toBeNull();
  });

  it('NOT deferred: HELD branch is not a transitive ancestor', () => {
    const d = checkDeferred(6, 2, ['src/a.ts'], ['main_patched'], [heldP]);
    expect(d.deferred).toBe(false);
  });

  it('NOT deferred: empty HELD registry', () => {
    expect(checkDeferred(6, 2, ['src/a.ts'], ancestors, []).deferred).toBe(false);
  });
});
