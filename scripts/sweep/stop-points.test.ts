import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';
import { findStopPoint } from './stop-points.js';

const { repo, chain } = makeSweepFixture();
afterAll(() => repo.destroy());

describe('findStopPoint (first-parent bisection)', () => {
  it('clean tip merge -> stop point is the upstream tip', async () => {
    const sp = await findStopPoint(repo.dir, 'feat/two', 'upstream-main');
    expect(sp.upToDate).toBe(false);
    expect(sp.cleanAtTip).toBe(true);
    expect(sp.stopPoint).toBe(chain[3]);
    expect(sp.mergedCount).toBe(4);
  });

  it('conflict at U3 -> largest clean prefix ends at U2', async () => {
    const sp = await findStopPoint(repo.dir, 'feat/one', 'upstream-main');
    expect(sp.cleanAtTip).toBe(false);
    expect(sp.conflictFiles).toEqual(['src/app.ts']);
    // U1, U2 merge clean; U3 introduces the same-line edit; U4 doesn't help.
    expect(sp.stopPoint).toBe(chain[1]);
    expect(sp.mergedCount).toBe(2);
    expect(sp.chainLength).toBe(4);
  });

  it('up-to-date branch -> no pending commits', async () => {
    const sp = await findStopPoint(repo.dir, 'upstream-main', 'upstream-main');
    expect(sp.upToDate).toBe(true);
    expect(sp.stopPoint).toBeNull();
    expect(sp.chainLength).toBe(0);
  });

  it('conflict in the very first pending commit -> stop point null', async () => {
    // A fork conflicting with U1 itself.
    repo.checkout('feat/early-conflict', { create: true, at: 'main' });
    repo.commit('early conflict', { 'docs/notes.md': 'fork version\n' });
    repo.checkout('main');
    const sp = await findStopPoint(repo.dir, 'feat/early-conflict', 'upstream-main');
    expect(sp.cleanAtTip).toBe(false);
    expect(sp.stopPoint).toBeNull();
    expect(sp.mergedCount).toBe(0);
  });

  it('bisection only probes O(log n) commits beyond the tip probe', async () => {
    const sp = await findStopPoint(repo.dir, 'feat/one', 'upstream-main');
    // chain of 4: tip probe + at most 2 bisect probes
    expect(sp.probes).toBeLessThanOrEqual(3);
  });
});
