import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo, makePropagationFixture } from './fixtures.js';
import { enumerateChain, type Chain } from './heights.js';
import { buildEligibleLine, mergePointSweep, type EligibleLine } from './interval.js';
import { revParse } from './git.js';
import { WHOLE_RANGE_BLOCK } from './types.js';

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
      // Heights 0 and 1 are genuinely absent — the parent has no commit whose
      // coverage is either, so the child cannot merge them this pass. Its own
      // fork-side commit is still a candidate, at the coverage it derives (-1).
      expect(line.heads.map((h) => h.height)).toEqual([-1, 2]);
      expect(line.heads.map((h) => h.sha)).toEqual([await revParse(r.dir, 'P^'), await revParse(r.dir, 'P')]);
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

describe('mergePointSweep — order is the line position, not the height', () => {
  /**
   * TWO HEADS AT ONE HEIGHT, the older clean and the newer conflicting. Nothing
   * about a parents-model line forbids this: a parent's fork-side commits
   * advance no upstream coverage, so a whole run of them derives one height.
   * A sweep ordered by height picks an arbitrary member of the tied group as the
   * merge point and then filters the case run with `height > floor`, which
   * excludes the tied conflicting head — the branch stops with no merge point to
   * report and no case to serve.
   */
  it('a clean and a conflicting head at the SAME height: merge at the clean one, report the conflicting one', async () => {
    const r = initFixtureRepo();
    r.commit('base x', { 'src/x.ts': 'orig\n' });
    const b = r.sha('main');
    r.commit('U0: util', { 'src/u.ts': 'u\n' }); // trunk, height 0
    r.checkout('P', { create: true, at: b });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'P merges U0', r.sha('main'));
    const pClean = r.commit('P: adds g', { 'src/g.ts': 'g\n' }); // height 0, clean
    const pConflict = r.commit('P: x = pfork', { 'src/x.ts': 'pfork\n' }); // height 0, conflicts
    r.checkout('C', { create: true, at: b });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'C merges U0', r.sha('main'));
    r.commit('C: x = cfork', { 'src/x.ts': 'cfork\n' });
    r.checkout('main');
    try {
      const cTip = await revParse(r.dir, 'C');
      // The line is stated OUTRIGHT, so this pins the sweep and nothing else:
      // two heads, one bucket, the older clean and the newer conflicting.
      const line: EligibleLine = {
        branch: 'C',
        parent: 'P',
        model: 'parents',
        coverage: 0,
        heads: [
          { sha: pClean, height: 0 },
          { sha: pConflict, height: 0 },
        ],
      };
      const res = await mergePointSweep(r.dir, cTip, line);
      expect(res.mergePoint?.sha).toBe(pClean);
      expect(res.firstConflict?.head.sha).toBe(pConflict);
      expect(res.firstConflict?.run.map((h) => h.sha)).toEqual([pConflict]);
      expect(res.firstConflict?.conflictedPaths).toEqual(['src/x.ts']);
    } finally {
      r.destroy();
    }
  });
});

describe('parents model — a purely fork-side parent advance', () => {
  /**
   * A parent whose only new work is fork-side: three commits, no upstream
   * progress at all, so all three derive the same height. Every one of them is a
   * candidate — a line that keeps only the newest has no clean prefix to merge
   * and no older head to sweep, so the branch takes nothing and the case names
   * the parent's tip.
   */
  function forkAdvance(): { r: ReturnType<typeof initFixtureRepo>; b: string } {
    const r = initFixtureRepo();
    r.commit('base x', { 'src/x.ts': 'orig\n' });
    const b = r.sha('main');
    r.commit('U0: util', { 'src/u.ts': 'u\n' }); // trunk, height 0 — neither side takes it
    return { r, b };
  }

  it('no conflict: every fork commit is a candidate and the whole run merges', async () => {
    const { r, b } = forkAdvance();
    r.checkout('P', { create: true, at: b });
    r.commit('p1: g', { 'src/g.ts': 'g\n' });
    r.commit('p2: h', { 'src/h.ts': 'h\n' });
    r.commit('p3: i', { 'src/i.ts': 'i\n' });
    r.checkout('C', { create: true, at: b });
    r.commit('c: own', { 'src/c.ts': 'c\n' });
    r.checkout('main');
    try {
      const chn = await enumerateChain(r.dir, 'main', b);
      const cTip = await revParse(r.dir, 'C');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'C',
        branchTip: cTip,
        parent: 'P',
        model: 'parents',
        chain: chn,
      });
      // Three commits, one bucket: no upstream progress lifts any of them.
      expect(line.heads.map((h) => h.height)).toEqual([-1, -1, -1]);
      const res = await mergePointSweep(r.dir, cTip, line);
      expect(res.cleanFullRange).toBe(true);
      expect(res.mergePoint?.sha).toBe(await revParse(r.dir, 'P'));
      expect(res.firstConflict).toBeNull();
    } finally {
      r.destroy();
    }
  });

  it('conflict from the first fork commit: the case head is the run TOP, not the parent tip', async () => {
    const { r, b } = forkAdvance();
    r.checkout('P', { create: true, at: b });
    const p1 = r.commit('p1: x = p1', { 'src/x.ts': 'p1\n' });
    const p2 = r.commit('p2: x = p2', { 'src/x.ts': 'p2\n' });
    r.commit('p3: x = p3', { 'src/x.ts': 'p3\n' });
    r.checkout('C', { create: true, at: b });
    r.commit('c: x = cfork', { 'src/x.ts': 'cfork\n' });
    r.checkout('main');
    try {
      const chn = await enumerateChain(r.dir, 'main', b);
      const cTip = await revParse(r.dir, 'C');
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'C',
        branchTip: cTip,
        parent: 'P',
        model: 'parents',
        chain: chn,
      });
      // Cap the run at two: the top of the run is p2, and p3 — never probed in
      // combination with anything the branch will take — stays out of the case.
      const res = await mergePointSweep(r.dir, cTip, line, 2);
      expect(res.mergePoint).toBeNull(); // the first commit already conflicts
      expect(res.firstConflict?.run.map((h) => h.sha)).toEqual([p1, p2]);
      expect(res.firstConflict?.head.sha).toBe(p2);
      expect(res.firstConflict?.head.sha).not.toBe(await revParse(r.dir, 'P'));
    } finally {
      r.destroy();
    }
  });
});

describe('buildEligibleLine — the trim at an unresolved conflict (§5.2)', () => {
  /**
   * The trim is what stops a branch advancing onto content nobody has
   * integrated. Every arm of it is pinned here: without coverage, a rewrite of
   * the eligible line can silently drop the trim on one arm only, and the
   * damage does not show until the integration rebuild blames a branch that
   * merely took what it was handed.
   */

  it('entry model: candidates at or above the trim are dropped and the removal is announced', async () => {
    const c2 = await enumerateChain(repo.dir, 'upstream-main', base);
    const tip = await revParse(repo.dir, 'fork');
    const args = { repo: repo.dir, branch: 'fork', branchTip: tip, parent: 'main', model: 'entry' as const, chain: c2 };

    const trimmed = await buildEligibleLine({ ...args, blockedAtHeight: 2 });
    expect(trimmed.heads.map((h) => h.height)).toEqual([0, 1]);
    expect(trimmed.trimmedAt).toBe(2);

    // The boundary is EXCLUSIVE at the trim: the blocked height itself is the
    // content nobody integrated, so it is the first thing withheld, not the
    // last thing allowed.
    const atBoundary = await buildEligibleLine({ ...args, blockedAtHeight: 3 });
    expect(atBoundary.heads.map((h) => h.height)).toEqual([0, 1, 2]);
    expect(atBoundary.trimmedAt).toBe(3);
  });

  it('entry model: a trim above every candidate removes nothing and stays silent', async () => {
    // "Nothing to take" and "something to take, blocked upstream" are different
    // facts; announcing a trim that withheld nothing makes a quiet pass look
    // like a stalled one in the report and in the urge counts.
    const c2 = await enumerateChain(repo.dir, 'upstream-main', base);
    const tip = await revParse(repo.dir, 'fork');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'fork',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c2,
      blockedAtHeight: 99,
    });
    expect(line.heads.map((h) => h.height)).toEqual([0, 1, 2, 3]);
    expect(line.trimmedAt).toBeUndefined();
  });

  it('entry model: a whole-range block leaves nothing eligible', async () => {
    const c2 = await enumerateChain(repo.dir, 'upstream-main', base);
    const tip = await revParse(repo.dir, 'fork');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'fork',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c2,
      blockedAtHeight: WHOLE_RANGE_BLOCK,
    });
    expect(line.heads).toEqual([]);
    expect(line.trimmedAt).toBe(WHOLE_RANGE_BLOCK);
  });

  /**
   * A parent whose own first-parent line exposes heights 0, 1 and 2, and a
   * child cut from the base — so the trim can be placed inside the line.
   */
  async function parentsFixture(): Promise<{ r: ReturnType<typeof initFixtureRepo>; chn: Chain }> {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const b = r.sha('main');
    r.commit('U0', { 'src/u0.ts': '0\n' });
    r.commit('U1', { 'src/u1.ts': '1\n' });
    r.commit('U2', { 'src/u2.ts': '2\n' });
    r.checkout('P', { create: true, at: b });
    r.commit('P: own file', { 'src/p.ts': 'p\n' });
    // One merge per height, so every intermediate height is reachable on P's
    // own first-parent line.
    for (let h = 0; h <= 2; h++) r.git('merge', '--no-ff', '--no-edit', '-m', `P merges U${h}`, r.sha(`main~${2 - h}`));
    r.checkout('C', { create: true, at: b });
    r.checkout('main');
    return { r, chn: await enumerateChain(r.dir, 'main', b) };
  }

  it('parents model: the parent line is cut at the trim, exclusive of the blocked height', async () => {
    const { r, chn } = await parentsFixture();
    try {
      const cTip = await revParse(r.dir, 'C');
      const args = { repo: r.dir, branch: 'C', branchTip: cTip, parent: 'P', model: 'parents' as const, chain: chn };
      // P's own fork commit derives -1 and is a candidate in its own right;
      // then one head per upstream merge.
      expect((await buildEligibleLine(args)).heads.map((h) => h.height)).toEqual([-1, 0, 1, 2]);

      const trimmed = await buildEligibleLine({ ...args, blockedAtHeight: 1 });
      expect(trimmed.heads.map((h) => h.height)).toEqual([-1, 0]);
      expect(trimmed.trimmedAt).toBe(1);

      const untouched = await buildEligibleLine({ ...args, blockedAtHeight: 3 });
      expect(untouched.heads.map((h) => h.height)).toEqual([-1, 0, 1, 2]);
      expect(untouched.trimmedAt).toBeUndefined();
    } finally {
      r.destroy();
    }
  });

  /**
   * A parent and child at the SAME coverage, the parent carrying one fork-only
   * commit on top: the height filter yields nothing, so the parent tip itself
   * is the candidate. This is the arm a blocked parent escapes through if the
   * trim is not applied to it — its tip IS the state that cannot integrate, and
   * every descendant would merge it cleanly, advance on it, and meet the trunk
   * for the first time in the integration rebuild, which blames THEM.
   */
  async function forkOnlyFixture(): Promise<{ r: ReturnType<typeof initFixtureRepo>; chn: Chain }> {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const b = r.sha('main');
    r.commit('U0', { 'src/u0.ts': '0\n' });
    r.checkout('P', { create: true, at: b });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'P merges U0', r.sha('main'));
    r.commit('P: fork-only fix', { 'src/g.ts': 'g\n' });
    r.checkout('C', { create: true, at: b });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'C merges U0', r.sha('main'));
    r.checkout('main');
    return { r, chn: await enumerateChain(r.dir, 'main', b) };
  }

  it('fork-only parent content is withheld by a trim at the parent tip height', async () => {
    const { r, chn } = await forkOnlyFixture();
    try {
      const cTip = await revParse(r.dir, 'C');
      const pTip = await revParse(r.dir, 'P');
      const pMerge = await revParse(r.dir, 'P^');
      const args = { repo: r.dir, branch: 'C', branchTip: cTip, parent: 'P', model: 'parents' as const, chain: chn };

      // Untrimmed, BOTH of P's unabsorbed commits are candidates and both derive
      // height 0 — coverage is equal on the two sides, so height says nothing
      // here and ancestry says everything.
      const open = await buildEligibleLine(args);
      expect(open.heads).toEqual([
        { sha: pMerge, height: 0 },
        { sha: pTip, height: 0 },
      ]);
      expect(open.trimmedAt).toBeUndefined();

      // The parent tip sits AT the trim: withheld, and the withholding is
      // announced even though the height filter had already emptied the line.
      const cut = await buildEligibleLine({ ...args, blockedAtHeight: 0 });
      expect(cut.heads).toEqual([]);
      expect(cut.trimmedAt).toBe(0);

      // A whole-range block takes it too — the fork-only height is below every
      // real height, so only the bottom of the lattice can reach it.
      const frozen = await buildEligibleLine({ ...args, blockedAtHeight: WHOLE_RANGE_BLOCK });
      expect(frozen.heads).toEqual([]);
      expect(frozen.trimmedAt).toBe(WHOLE_RANGE_BLOCK);

      // A trim ABOVE the parent tip's height lets the fork content through and
      // reports no removal.
      const above = await buildEligibleLine({ ...args, blockedAtHeight: 1 });
      expect(above.heads).toEqual([
        { sha: pMerge, height: 0 },
        { sha: pTip, height: 0 },
      ]);
      expect(above.trimmedAt).toBeUndefined();
    } finally {
      r.destroy();
    }
  });
});
