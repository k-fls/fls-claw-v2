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

describe('checkDeferred (§5, D-036)', () => {
  it('DEFERRED: same height + intersecting paths + ancestor HELD', () => {
    const d = checkDeferred(5, ['src/b.ts', 'src/c.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(true);
    expect(d.ancestor?.branch).toBe('feat/parent');
  });

  it('NOT deferred: same height but DISJOINT paths (own independent conflict)', () => {
    const d = checkDeferred(5, ['src/z.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(false);
    expect(d.ancestor).toBeNull();
  });

  it('NOT deferred: intersecting paths but a DIFFERENT height', () => {
    const d = checkDeferred(4, ['src/a.ts'], ancestors, [heldP]);
    expect(d.deferred).toBe(false);
  });

  it('NOT deferred: HELD branch is not a transitive ancestor', () => {
    const d = checkDeferred(5, ['src/a.ts'], ['main_patched'], [heldP]);
    expect(d.deferred).toBe(false);
  });

  it('NOT deferred: empty HELD registry', () => {
    expect(checkDeferred(5, ['src/a.ts'], ancestors, []).deferred).toBe(false);
  });
});
