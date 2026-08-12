import { afterAll, describe, expect, it } from 'vitest';

import { makePropagationFixture } from './fixtures.js';
import { deriveCoverage, enumerateChain, heightOfSha, pinWatermark, shaAtHeight, tipHead } from './heights.js';

const { repo, base, chain } = makePropagationFixture();
afterAll(() => repo.destroy());

describe('enumerateChain / height<->sha', () => {
  it('assigns 0-based heights oldest-first up to the watermark', async () => {
    const c = await enumerateChain(repo.dir, 'upstream-main', base);
    expect(c.heads.map((h) => h.sha)).toEqual(chain);
    expect(c.heads.map((h) => h.height)).toEqual([0, 1, 2, 3]);
    expect(shaAtHeight(c, 2)).toBe(chain[2]);
    expect(shaAtHeight(c, 9)).toBeNull();
    expect(heightOfSha(c, chain[3])).toBe(3);
    expect(heightOfSha(c, base)).toBe(-1);
    expect(tipHead(c)).toEqual({ sha: chain[3], height: 3 });
  });
});

describe('pinWatermark + coverage derivation (binary ancestry search)', () => {
  it('pins the watermark to a concrete sha', async () => {
    expect(await pinWatermark(repo.dir, 'upstream-main')).toBe(chain[3]);
  });

  it('derives coverage via monotone ancestry (probes O(log n))', async () => {
    const c = await enumerateChain(repo.dir, 'upstream-main', base);
    // fork has none of the trunk commits -> coverage -1.
    expect((await deriveCoverage(repo.dir, c, 'fork')).height).toBe(-1);
    // A trunk commit's own coverage is its height.
    expect((await deriveCoverage(repo.dir, c, chain[1])).height).toBe(1);
    const top = await deriveCoverage(repo.dir, c, chain[3]);
    expect(top.height).toBe(3);
    // 4 heights: at most ceil(log2(4)) + 1 probes.
    expect(top.probes).toBeLessThanOrEqual(4);
  });

  it('watermark pinning: the chain is captured once and never re-read mid-pass', async () => {
    const c = await enumerateChain(repo.dir, 'upstream-main', base);
    const pinned = c.watermark;
    // Upstream advances AFTER pinning.
    repo.checkout('upstream-main');
    repo.commit('U4: late arrival', { 'src/late.ts': 'late\n' });
    repo.checkout('main');
    // The captured chain object is unchanged (heights stable, watermark pinned).
    expect(c.watermark).toBe(pinned);
    expect(c.heads).toHaveLength(4);
    // A fresh enumeration would see the new commit — proving we must reuse `c`.
    const fresh = await enumerateChain(repo.dir, 'upstream-main', base);
    expect(fresh.heads).toHaveLength(5);
  });
});
