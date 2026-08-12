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

describe('mergePointSweep — linear, non-monotonic window (§3)', () => {
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
    // The case run starts at the smallest conflicting height ABOVE the merge
    // point = 3 (a single-height run here — nothing above it, DRIVER.md §4.4).
    expect(res.firstConflict?.head.height).toBe(3);
    expect(res.firstConflict?.run.map((h) => h.height)).toEqual([3]);
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

describe('mergePointSweep — case stacking (MERGE-POLICY.md §2)', () => {
  /**
   * Trunk with a clean height 0 then consecutive conflicting heights 1..3 on
   * src/x.ts, plus a DISJOINT conflicting height 4 on src/y.ts. The fork edits
   * both files, so all of 1..4 conflict against it.
   */
  async function stackFixture(): Promise<{ r: ReturnType<typeof initFixtureRepo>; chn: Chain }> {
    const r = initFixtureRepo();
    r.commit('base xy', { 'src/x.ts': 'orig\n', 'src/y.ts': 'orig\n' });
    const b = r.sha('main');
    r.checkout('fork2', { create: true, at: 'main' });
    r.commit('fork2: edit x and y', { 'src/x.ts': 'fork\n', 'src/y.ts': 'fork\n' });
    r.checkout('main');
    r.commit('U0: clean util', { 'src/u.ts': 'u\n' }); // height 0 — clean
    r.commit('U1: x = a', { 'src/x.ts': 'a\n' }); // height 1 — x conflict
    r.commit('U2: x = b', { 'src/x.ts': 'b\n' }); // height 2 — x conflict (intersects)
    r.commit('U3: x = c', { 'src/x.ts': 'c\n' }); // height 3 — x conflict (intersects)
    r.commit('U4: y = d', { 'src/y.ts': 'd\n' }); // height 4 — y ALSO x? cumulative: x staying conflicted
    const chn = await enumerateChain(r.dir, 'main', b);
    return { r, chn };
  }

  it('stacks consecutive path-intersecting conflicting heights; head = the run TOP', async () => {
    const { r, chn } = await stackFixture();
    try {
      const tip = await revParse(r.dir, 'fork2');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'fork2',
        branchTip: tip,
        parent: 'main',
        model: 'entry',
        chain: chn,
      });
      const res = await mergePointSweep(r.dir, 'fork2', line);
      expect(res.mergePoint?.height).toBe(0); // the clean prefix
      // Heights 1..4 all conflict; cumulative conflict sets intersect on
      // src/x.ts throughout, so the run stacks to the cap-free top (4 heights
      // < cap 5) and the head is the TOP.
      expect(res.firstConflict?.run.map((h) => h.height)).toEqual([1, 2, 3, 4]);
      expect(res.firstConflict?.head.height).toBe(4);
      // The top's conflict set is the cumulative one (both files by height 4).
      expect(res.firstConflict?.conflictedPaths).toContain('src/x.ts');
    } finally {
      r.destroy();
    }
  });

  it('the cap breaks the run (stack_cap lever, default 5)', async () => {
    const { r, chn } = await stackFixture();
    try {
      const tip = await revParse(r.dir, 'fork2');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'fork2',
        branchTip: tip,
        parent: 'main',
        model: 'entry',
        chain: chn,
      });
      const res = await mergePointSweep(r.dir, 'fork2', line, 2);
      expect(res.firstConflict?.run.map((h) => h.height)).toEqual([1, 2]);
      expect(res.firstConflict?.head.height).toBe(2);
    } finally {
      r.destroy();
    }
  });

  it('a disjoint-path conflict breaks the run (its own case later)', async () => {
    // Fork edits x only; upstream conflicts on x at height 0, then REPLACES y
    // wholesale at height 1 in a way that conflicts on y only after the fork
    // also diverges y — build it directly: height 0 x-conflict, height 1
    // y-conflict with a DISJOINT set at that head.
    const r = initFixtureRepo();
    r.commit('base xy', { 'src/x.ts': 'orig\n', 'src/y.ts': 'orig\n' });
    const b = r.sha('main');
    r.checkout('forkd', { create: true, at: 'main' });
    r.commit('forkd: edit x and y', { 'src/x.ts': 'fork\n', 'src/y.ts': 'fork\n' });
    r.checkout('main');
    r.commit('U0: x = a', { 'src/x.ts': 'a\n' }); // height 0 — x conflict
    // Height 1 resolves x to the FORK content (x heals) but rewrites y: the
    // cumulative conflict set at height 1 is {src/y.ts} — disjoint from {src/x.ts}.
    r.commit('U1: x = fork, y = d', { 'src/x.ts': 'fork\n', 'src/y.ts': 'd\n' });
    try {
      const chn = await enumerateChain(r.dir, 'main', b);
      const tip = await revParse(r.dir, 'forkd');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'forkd',
        branchTip: tip,
        parent: 'main',
        model: 'entry',
        chain: chn,
      });
      const res = await mergePointSweep(r.dir, 'forkd', line);
      expect(res.mergePoint).toBeNull(); // no clean height at all
      expect(res.probes.map((p) => [p.head.height, p.clean, p.conflictFiles])).toEqual([
        [0, false, ['src/x.ts']],
        [1, false, ['src/y.ts']],
      ]);
      // Disjoint sets: the run stays at height 0; height 1 is its own case later.
      expect(res.firstConflict?.run.map((h) => h.height)).toEqual([0]);
      expect(res.firstConflict?.head.height).toBe(0);
      expect(res.firstConflict?.conflictedPaths).toEqual(['src/x.ts']);
    } finally {
      r.destroy();
    }
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

describe('buildEligibleLine (parents model, §4) — fork-only parent content', () => {
  it('a parent with a fork-only commit (no upstream progress) still yields a head', async () => {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const base = r.sha('main');
    r.commit('U0: upstream', { 'src/u0.ts': '0\n' }); // trunk, height 0
    // Parent carries a NEW fork commit but no upstream progress above coverage.
    r.checkout('P', { create: true, at: base });
    r.commit('P: fork-only fix', { 'src/g.ts': 'g\n' });
    // Child cut from base; does NOT contain P's fork commit.
    r.checkout('C', { create: true, at: base });
    r.checkout('main');
    try {
      const chn = await enumerateChain(r.dir, 'main', base);
      const cTip = await revParse(r.dir, 'C');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'C',
        branchTip: cTip,
        parent: 'P',
        model: 'parents',
        chain: chn,
      });
      // Height-filtered line is empty (P has no upstream progress), but the parent
      // tip is not an ancestor of C -> the parent tip is the single head.
      expect(line.heads).toHaveLength(1);
      expect(line.heads[0].sha).toBe(await revParse(r.dir, 'P'));
      // The sweep merges it (a real merge — the fork commit adds src/g.ts).
      const res = await mergePointSweep(r.dir, 'C', line);
      expect(res.upToDate).toBe(false);
      expect(res.cleanFullRange).toBe(true);
      expect(res.mergePoint?.sha).toBe(await revParse(r.dir, 'P'));

      // Contrast: when the parent tip IS an ancestor of the child, nothing to do.
      r.checkout('C2', { create: true, at: 'P' });
      r.checkout('main');
      const c2Tip = await revParse(r.dir, 'C2');
      const line2 = await buildEligibleLine({
        repo: r.dir,
        branch: 'C2',
        branchTip: c2Tip,
        parent: 'P',
        model: 'parents',
        chain: chn,
      });
      expect(line2.heads).toHaveLength(0);
    } finally {
      r.destroy();
    }
  });
});
