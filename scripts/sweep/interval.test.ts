import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo, makePropagationFixture } from './fixtures.js';
import { enumerateChain, type Chain } from './heights.js';
import { buildEligibleLine, mergePointSweep } from './interval.js';
import { revParse } from './git.js';

const { repo, base, chain } = makePropagationFixture();
let c: Chain;
afterAll(() => repo.destroy());

describe('buildEligibleLine (entry model, §4)', () => {
  it('lists trunk heads above the branch coverage', async () => {
    c = await enumerateChain(repo.dir, 'upstream-main', base);
    const tip = await revParse(repo.dir, 'fork');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'fork',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c,
    });
    expect(line.coverage).toBe(-1);
    expect(line.heads.map((h) => h.height)).toEqual([0, 1, 2, 3]);
  });
});

describe('mergePointSweep — linear, non-monotonic window (§3, D-037)', () => {
  it('merges past an intermediate conflict at the largest clean height', async () => {
    const tip = await revParse(repo.dir, 'fork');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'fork',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c,
    });
    const res = await mergePointSweep(repo.dir, 'fork', line);
    // heights 0,2 clean; 1,3 conflict. Largest clean = 2 (past the height-1 conflict).
    expect(res.cleanFullRange).toBe(false);
    expect(res.mergePoint).toEqual({ sha: chain[2], height: 2 });
    // Smallest conflicting height ABOVE the merge point = 3.
    expect(res.firstConflict?.head.height).toBe(3);
    expect(res.firstConflict?.conflictedPaths).toEqual(['src/x.ts']);
    expect(res.firstConflict?.automergeTree).toMatch(/^[0-9a-f]{40}$/);
    // Records clean/conflict per height.
    expect(res.probes.map((p) => [p.head.height, p.clean])).toEqual([
      [0, true],
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('clean full range -> single probe, merge at the tip', async () => {
    // feat/clean-ish: a branch that never touches x merges the whole chain clean.
    repo.checkout('clean', { create: true, at: 'main' });
    repo.commit('clean: unrelated', { 'src/clean.ts': 'c\n' });
    repo.checkout('main');
    const tip = await revParse(repo.dir, 'clean');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'clean',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c,
    });
    const res = await mergePointSweep(repo.dir, 'clean', line);
    expect(res.cleanFullRange).toBe(true);
    expect(res.probeCount).toBe(1);
    expect(res.mergePoint?.height).toBe(3);
    expect(res.firstConflict).toBeNull();
  });

  it('up-to-date branch -> no eligible heads, no probes', async () => {
    const tip = await revParse(repo.dir, chain[3]); // a branch already at the watermark
    repo.checkout('atwm', { create: true, at: 'upstream-main' });
    repo.checkout('main');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'atwm',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c,
    });
    const res = await mergePointSweep(repo.dir, 'atwm', line);
    expect(res.upToDate).toBe(true);
    expect(res.probeCount).toBe(0);
    expect(res.mergePoint).toBeNull();
  });
});

describe('buildEligibleLine (parents model, §4) — no-historical-tip variant', () => {
  it('a parent that jumped in one merge exposes only the reachable height', async () => {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const base = r.sha('main');
    // trunk on `main`: three independent commits (heights 0,1,2).
    r.commit('U0', { 'src/u0.ts': '0\n' });
    r.commit('U1', { 'src/u1.ts': '1\n' });
    r.commit('U2', { 'src/u2.ts': '2\n' });
    // parent P jumps to height 2 in ONE (non-ff) merge — no historical tip at 0/1.
    r.checkout('P', { create: true, at: base });
    r.commit('P: own file', { 'src/p.ts': 'p\n' });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'P merges U2', r.sha('main'));
    // child C cut from base (coverage -1).
    r.checkout('C', { create: true, at: base });
    r.checkout('main');
    try {
      const chn = await enumerateChain(r.dir, 'main', base);
      expect(chn.heads).toHaveLength(3);
      const tip = await revParse(r.dir, 'C');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'C',
        branchTip: tip,
        parent: 'P',
        model: 'parents',
        chain: chn,
      });
      // Only height 2 is reachable — no intermediate parent tip at 0 or 1.
      expect(line.heads.map((h) => h.height)).toEqual([2]);
    } finally {
      r.destroy();
    }
  });
});
