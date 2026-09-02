import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo, makePropagationFixture } from './fixtures.js';
import {
  coverageDerivations,
  deriveCoverage,
  enumerateChain,
  heightOfSha,
  mintHead,
  resetCoverageDerivations,
  type Chain,
} from './heights.js';
import {
  buildEligibleLine,
  pendingWalk,
  reconcileToAnchor,
  replayPrefix,
  walkStep,
  withheldByCut,
  type EligibleLine,
} from './interval.js';
import {
  ancestryPath,
  blobOidAt,
  firstParentChain,
  git,
  isAncestor,
  newStyleMergeTree,
  revParse,
} from './git.js';
import { computeSurface, inSurface } from './surface.js';
import type { FixtureRepo } from './fixtures.js';

/**
 * An AUTHORED merge built with plumbing: merge `otherSha` into `branch` with a
 * tree the author decided — the branch's tree overlaid with `files` — so a
 * conflicting fixture merge needs no worktree mergetool dance.
 */
async function authoredMerge(
  r: FixtureRepo,
  branch: string,
  otherSha: string,
  files: Record<string, string>,
  message = 'authored merge',
): Promise<string> {
  let tree = (await git(r.dir, ['rev-parse', `${branch}^{tree}`])).stdout.trim();
  for (const [path, content] of Object.entries(files)) {
    const blob = (await git(r.dir, ['hash-object', '-w', '--stdin'], { input: content })).stdout.trim();
    const idx = r.dir + '/.overlay-index';
    const env = { GIT_INDEX_FILE: idx };
    await git(r.dir, ['read-tree', tree], { env });
    await git(r.dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    tree = (await git(r.dir, ['write-tree'], { env })).stdout.trim();
  }
  const tip = (await git(r.dir, ['rev-parse', branch])).stdout.trim();
  const m = (await git(r.dir, ['commit-tree', tree, '-p', tip, '-p', otherSha, '-m', message])).stdout.trim();
  await git(r.dir, ['update-ref', `refs/heads/${branch}`, m]);
  return m;
}

/** Walk a line under the surface its anchor defines (the test-side shorthand). */
async function walkLine(dir: string, branchTip: string, line: EligibleLine, anchor: string) {
  const surface = await computeSurface(dir, anchor, branchTip);
  return pendingWalk(dir, branchTip, line, surface, anchor);
}

/** A fixture tree: `commit`'s tree with `path` replaced by literal `content`. */
async function overlayTreePathsForTest(r: FixtureRepo, commit: string, path: string, content: string): Promise<string> {
  const blob = (await git(r.dir, ['hash-object', '-w', '--stdin'], { input: content })).stdout.trim();
  const idx = r.dir + '/.overlay-index';
  const env = { GIT_INDEX_FILE: idx };
  await git(r.dir, ['read-tree', `${commit}^{tree}`], { env });
  await git(r.dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
  return (await git(r.dir, ['write-tree'], { env })).stdout.trim();
}
import { WHOLE_RANGE_BLOCK } from './types.js';

const { repo, base, chain } = makePropagationFixture();
let c: Chain;
afterAll(() => repo.destroy());

/**
 * Heights for an eligible line, minted for the assertion. The line carries
 * shas; projecting them onto the trunk is how a test says WHICH commits the
 * line holds, and it is the test's cost, never the walk's.
 */
async function heightsOf(dir: string, chn: Chain, shas: string[]): Promise<number[]> {
  return Promise.all(shas.map(async (sha) => (await mintHead(dir, chn, sha)).height));
}

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
    expect((await deriveCoverage(repo.dir, c, tip)).height).toBe(-1);
    expect(await heightsOf(repo.dir, c, line.heads)).toEqual([0, 1, 2, 3]);
  });
});

describe('pendingWalk — the entry-model walk (§3)', () => {
  it('stops at the first conflicting trunk height; the clean prefix below it lands', async () => {
    const tip = await revParse(repo.dir, 'fork');
    const line = await buildEligibleLine({
      repo: repo.dir,
      branch: 'fork',
      branchTip: tip,
      parent: 'main',
      model: 'entry',
      chain: c,
    });
    const res = await walkLine(repo.dir, tip, line, c.watermark);
    // Height 0 lands clean; height 1 rewrites the fork's own file — the stop.
    expect(res.steps.map((st) => st.sha)).toEqual([chain[0]]);
    expect(res.conflict?.head).toBe(chain[1]);
    expect(res.conflict?.conflictedPaths).toEqual(['src/x.ts']);
    expect(res.conflict?.automergeTree).toMatch(/^[0-9a-f]{40}$/);
    // Nothing above the stop is probed: the case is one commit, and heights
    // 2..3 wait for the next derivation after it resolves.
    expect(res.probeCount).toBe(2);
  });

  it('a clean line lands whole', async () => {
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
    const res = await walkLine(repo.dir, tip, line, c.watermark);
    expect(res.conflict).toBeNull();
    expect(res.steps.map((st) => st.sha)).toEqual(chain);
    expect(res.probeCount).toBe(4);
    expect(await blobOidAt(repo.dir, res.landTree!, 'src/x.ts')).toBe(await blobOidAt(repo.dir, chain[3], 'src/x.ts'));
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
    const res = await walkLine(repo.dir, tip, line, c.watermark);
    expect(res.upToDate).toBe(true);
    expect(res.probeCount).toBe(0);
    expect(res.steps).toEqual([]);
  });
});

describe('pendingWalk — the case is the stop commit alone (§4.4)', () => {
  /**
   * Trunk with a clean height 0 then consecutive conflicting heights 1..3 on
   * src/x.ts, plus a height 4 on src/y.ts. The fork edits both files.
   */
  async function conflictRunFixture(): Promise<{ r: ReturnType<typeof initFixtureRepo>; chn: Chain }> {
    const r = initFixtureRepo();
    r.commit('base xy', { 'src/x.ts': 'orig\n', 'src/y.ts': 'orig\n' });
    const b = r.sha('main');
    r.checkout('fork2', { create: true, at: 'main' });
    r.commit('fork2: edit x and y', { 'src/x.ts': 'fork\n', 'src/y.ts': 'fork\n' });
    r.checkout('main');
    r.commit('U0: clean util', { 'src/u.ts': 'u\n' }); // height 0 — clean
    r.commit('U1: x = a', { 'src/x.ts': 'a\n' }); // height 1 — x conflict
    r.commit('U2: x = b', { 'src/x.ts': 'b\n' }); // height 2 — x conflict
    r.commit('U3: x = c', { 'src/x.ts': 'c\n' }); // height 3 — x conflict
    r.commit('U4: y = d', { 'src/y.ts': 'd\n' }); // height 4 — y conflict
    const chn = await enumerateChain(r.dir, 'main', b);
    return { r, chn };
  }

  it('a run of conflicting heights yields ONE case: the first of them, nothing stacked above', async () => {
    const { r, chn } = await conflictRunFixture();
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
      const res = await walkLine(r.dir, tip, line, chn.watermark);
      expect(res.steps.map((st) => st.sha)).toEqual([chn.heads[0].sha]); // the clean prefix
      // Heights 1..4 all conflict eventually, but the case is exactly the
      // FIRST: nothing above it was probed in combination with what the branch
      // takes, so nothing above it is in the case, the branch or the fix ref.
      expect(res.conflict?.head).toBe(chn.heads[1].sha);
      expect(res.conflict?.conflictedPaths).toEqual(['src/x.ts']);
      expect(res.probeCount).toBe(2);
    } finally {
      r.destroy();
    }
  });

  it('a later disjoint conflict is not this case: it waits above the stop', async () => {
    const r = initFixtureRepo();
    r.commit('base xy', { 'src/x.ts': 'orig\n', 'src/y.ts': 'orig\n' });
    const b = r.sha('main');
    r.checkout('forkd', { create: true, at: 'main' });
    r.commit('forkd: edit x and y', { 'src/x.ts': 'fork\n', 'src/y.ts': 'fork\n' });
    r.checkout('main');
    r.commit('U0: x = a', { 'src/x.ts': 'a\n' }); // height 0 — x conflict
    r.commit('U1: y = d', { 'src/y.ts': 'd\n' }); // height 1 — y conflict, disjoint
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
      const res = await walkLine(r.dir, tip, line, chn.watermark);
      expect(res.steps).toEqual([]); // no clean height at all
      expect(res.conflict?.head).toBe(chn.heads[0].sha);
      expect(res.conflict?.conflictedPaths).toEqual(['src/x.ts']);
      // The y question at height 1 is a case of its own, after this one resolves.
      expect(res.probeCount).toBe(1);
    } finally {
      r.destroy();
    }
  });
});

describe('buildEligibleLine (parents model, §4) — the pending DAG of a one-merge jump', () => {
  it('a parent that jumped in one merge still offers every commit the merge dragged in', async () => {
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
      // The parent jumped in one merge, but the pending DAG still holds every
      // commit that merge dragged in: the trunk commits individually, the
      // parent's own fork-side commit, and the merge itself — so the walk can
      // land the finest prefix that exists instead of the merge or nothing.
      const u = [await revParse(r.dir, 'main~2'), await revParse(r.dir, 'main~1'), await revParse(r.dir, 'main')];
      const pOwn = await revParse(r.dir, 'P^');
      const pTip = await revParse(r.dir, 'P');
      expect(new Set(line.heads)).toEqual(new Set([pOwn, ...u, pTip]));
      // Topological order holds: ancestors before descendants, the merge last.
      expect(line.heads[line.heads.length - 1]).toBe(pTip);
      expect(line.heads.indexOf(u[0])).toBeLessThan(line.heads.indexOf(u[1]));
      expect(line.heads.indexOf(u[1])).toBeLessThan(line.heads.indexOf(u[2]));
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
      expect(line.heads[0]).toBe(await revParse(r.dir, 'P'));
      // The walk lands it (a real merge — the fork commit adds src/g.ts).
      const pTip = await revParse(r.dir, 'P');
      const res = await walkLine(r.dir, cTip, line, pTip);
      expect(res.upToDate).toBe(false);
      expect(res.conflict).toBeNull();
      expect(res.steps.map((st) => st.sha)).toEqual([pTip]);
      expect(await blobOidAt(r.dir, res.landTree!, 'src/g.ts')).toBe(await blobOidAt(r.dir, pTip, 'src/g.ts'));

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

describe('pendingWalk — position in the line, never height', () => {
  /**
   * TWO HEADS AT ONE HEIGHT, the older clean and the newer conflicting. Nothing
   * about a parents-model line forbids this: a parent's fork-side commits
   * advance no upstream coverage, so a whole run of them derives one height.
   * The walk orders by position, so the clean one lands and the conflicting one
   * is the stop — a height ordering has no way to say which is which.
   */
  it('a clean and a conflicting head at the SAME height: land the clean one, report the conflicting one', async () => {
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
      // The line is stated OUTRIGHT, so this pins the walk and nothing else:
      // two heads, one bucket, the older clean and the newer conflicting.
      const line: EligibleLine = {
        branch: 'C',
        parent: 'P',
        model: 'parents',
        heads: [pClean, pConflict],
      };
      const res = await walkLine(r.dir, cTip, line, await revParse(r.dir, 'P'));
      expect(res.steps.map((st) => st.sha)).toEqual([pClean]);
      expect(res.conflict?.head).toBe(pConflict);
      expect(res.conflict?.conflictedPaths).toEqual(['src/x.ts']);
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
      expect(await heightsOf(r.dir, chn, line.heads)).toEqual([-1, -1, -1]);
      const pTip = await revParse(r.dir, 'P');
      const res = await walkLine(r.dir, cTip, line, pTip);
      expect(res.conflict).toBeNull();
      expect(res.steps.map((st) => st.sha)).toEqual(line.heads);
      expect(res.steps[2].sha).toBe(pTip);
    } finally {
      r.destroy();
    }
  });

  it('conflict from the first fork commit: the case head is that commit, not the parent tip', async () => {
    const { r, b } = forkAdvance();
    r.checkout('P', { create: true, at: b });
    const p1 = r.commit('p1: x = p1', { 'src/x.ts': 'p1\n' });
    r.commit('p2: x = p2', { 'src/x.ts': 'p2\n' });
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
      const res = await walkLine(r.dir, cTip, line, await revParse(r.dir, 'P'));
      expect(res.steps).toEqual([]); // the first commit already conflicts
      expect(res.conflict?.head).toBe(p1);
      expect(res.conflict?.head).not.toBe(await revParse(r.dir, 'P'));
      // p2 and p3 — never probed in combination with anything the branch will
      // take — stay out of the case entirely.
      expect(res.probeCount).toBe(1);
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
    expect(await heightsOf(repo.dir, c2, trimmed.heads)).toEqual([0, 1]);
    expect(trimmed.trimmedAt).toBe(2);

    // The boundary is EXCLUSIVE at the trim: the blocked height itself is the
    // content nobody integrated, so it is the first thing withheld, not the
    // last thing allowed.
    const atBoundary = await buildEligibleLine({ ...args, blockedAtHeight: 3 });
    expect(await heightsOf(repo.dir, c2, atBoundary.heads)).toEqual([0, 1, 2]);
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
    expect(await heightsOf(repo.dir, c2, line.heads)).toEqual([0, 1, 2, 3]);
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
      // The pending DAG: P's own fork commit (-1), the trunk commits the
      // merges dragged in (0, 1, 2) and the merges themselves (0, 1, 2).
      const openHeights = await heightsOf(r.dir, chn, (await buildEligibleLine(args)).heads);
      expect([...openHeights].sort((x, y) => x - y)).toEqual([-1, 0, 0, 1, 1, 2, 2]);

      // Trimmed at 1: everything CONTAINING the trunk commit at 1 is withheld —
      // T1 and T2 themselves, and the merges that brought them.
      const trimmed = await buildEligibleLine({ ...args, blockedAtHeight: 1 });
      const trimmedHeights = await heightsOf(r.dir, chn, trimmed.heads);
      expect([...trimmedHeights].sort((x, y) => x - y)).toEqual([-1, 0, 0]);
      expect(trimmed.trimmedAt).toBe(1);

      const untouched = await buildEligibleLine({ ...args, blockedAtHeight: 3 });
      expect((await buildEligibleLine(args)).heads.length).toBe(untouched.heads.length);
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
      expect(open.heads).toEqual([pMerge, pTip]);
      expect(await heightsOf(r.dir, chn, open.heads)).toEqual([0, 0]);
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
      expect(above.heads).toEqual([pMerge, pTip]);
      expect(above.trimmedAt).toBeUndefined();
    } finally {
      r.destroy();
    }
  });
});

describe('withheldByCut — the cut as a containment test (§5.2)', () => {
  /**
   * A parent that merges two lineages: L2 brings the trunk commit at the cut
   * (and a fork commit on top of it), L1 is fork-only work that touches the cut
   * not at all. The parent's own first-parent line reaches both.
   */
  async function twoLineageFixture(): Promise<{
    r: ReturnType<typeof initFixtureRepo>;
    chn: Chain;
    pending: Set<string>;
    pTip: string;
    f1: string;
    f2: string;
    m1: string;
    m2: string;
    f3: string;
  }> {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const b = r.sha('main');
    r.commit('T0', { 'src/t0.ts': '0\n' }); // trunk height 0
    r.commit('T1', { 'src/t1.ts': '1\n' }); // trunk height 1 — the cut
    // L2: a side branch that merges the trunk up to T1, then adds fork work.
    r.checkout('L2', { create: true, at: b });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'L2 merges T1', r.sha('main'));
    const f3 = r.commit('f3: L2 fork work', { 'src/f3.ts': '3\n' });
    // L1: fork-only work, disjoint from the trunk entirely.
    r.checkout('L1', { create: true, at: b });
    const f1 = r.commit('f1: L1 fork work', { 'src/f1.ts': '1\n' });
    const f2 = r.commit('f2: L1 fork work', { 'src/f2.ts': '2\n' });
    // P takes L2 first, then L1 — so L1's commits are topologically AFTER the
    // withheld ones on P's own line.
    r.checkout('P', { create: true, at: b });
    r.git('merge', '--no-ff', '--no-edit', '-m', 'P merges L2', 'L2');
    const m2 = r.sha('P');
    r.git('merge', '--no-ff', '--no-edit', '-m', 'P merges L1', 'L1');
    const m1 = r.sha('P');
    r.checkout('main');
    const chn = await enumerateChain(r.dir, 'main', b);
    return { r, chn, pending: new Set([m2, f3, m1, f1, f2]), pTip: m1, f1, f2, m1, m2, f3 };
  }

  it('a withheld commit does not withhold a parallel lineage: skipping is not stopping', async () => {
    const { r, chn, pending, pTip, f1, f2, m1, m2, f3 } = await twoLineageFixture();
    try {
      const cut = chn.heads[1].sha; // T1
      const withheld = await withheldByCut(r.dir, chn, 1, pTip, pending);
      // Everything that contains T1 — the merge that brought it, the fork commit
      // above it, and P's later merge which sits on top of both.
      expect(withheld).toEqual(new Set([m2, f3, m1]));
      // L1's fork-only work is untouched and lands even though it is ordered
      // after the withheld commits.
      const eligible = [...pending].filter((s) => !withheld.has(s));
      expect(new Set(eligible)).toEqual(new Set([f1, f2]));
      for (const sha of eligible) expect(await isAncestor(r.dir, cut, sha)).toBe(false);

      // The enumeration itself agrees: a child cut from base sees the parallel
      // lineage — and the trunk commit BELOW the cut — as its eligible line,
      // and the removal is announced.
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'Cbase',
        branchTip: chn.base,
        parent: 'P',
        parentRef: pTip,
        model: 'parents',
        chain: chn,
        blockedAtHeight: 1,
      });
      expect(new Set(line.heads)).toEqual(new Set([chn.heads[0].sha, f1, f2]));
      expect(line.trimmedAt).toBe(1);

      // The landed tip: merge every eligible commit into a child cut from base.
      r.checkout('C', { create: true, at: chn.base });
      for (const sha of eligible) r.git('merge', '--no-ff', '--no-edit', '-m', `C takes ${sha}`, sha);
      const cTip = r.sha('C');
      r.checkout('main');
      expect(await isAncestor(r.dir, f1, cTip)).toBe(true);
      expect(await isAncestor(r.dir, f2, cTip)).toBe(true);
      expect(await isAncestor(r.dir, cut, cTip)).toBe(false);
    } finally {
      r.destroy();
    }
  });

  /**
   * A parent whose own first-parent line IS the trunk plus one fork commit, so
   * the commit at the cut is itself a candidate — the arm that lands a branch
   * exactly at the blocked coordinate when `A..B`'s exclusion of A is not
   * repaired.
   */
  async function trunkLineFixture(): Promise<{ r: ReturnType<typeof initFixtureRepo>; chn: Chain; pending: string[] }> {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const b = r.sha('main');
    r.commit('T0', { 'src/t0.ts': '0\n' });
    r.commit('T1', { 'src/t1.ts': '1\n' });
    r.commit('T2', { 'src/t2.ts': '2\n' });
    r.checkout('P', { create: true, at: 'main' }); // P's first-parent line IS the trunk
    r.commit('P: own file', { 'src/p.ts': 'p\n' });
    r.checkout('C', { create: true, at: b });
    r.checkout('main');
    const chn = await enumerateChain(r.dir, 'main', b);
    const pending = await firstParentChain(r.dir, await revParse(r.dir, 'P'), await revParse(r.dir, 'C'));
    return { r, chn, pending };
  }

  it('membership is exactly “derived coverage at or above the trim”, cut commit included', async () => {
    const { r, chn, pending } = await trunkLineFixture();
    try {
      const pTip = await revParse(r.dir, 'P');
      const set = new Set(pending);
      // The chain commits themselves are pending here, so the trim at a chain
      // commit names a candidate.
      expect(pending).toContain(chn.heads[1].sha);
      // Below the chain, inside it, and past the watermark.
      for (const trim of [WHOLE_RANGE_BLOCK, -1, 0, 1, chn.heads.length - 1, chn.heads.length]) {
        const withheld = await withheldByCut(r.dir, chn, trim, pTip, set);
        for (const sha of pending) {
          const height = (await deriveCoverage(r.dir, chn, sha)).height;
          expect([trim, sha, withheld.has(sha)]).toEqual([trim, sha, height >= trim]);
        }
      }
    } finally {
      r.destroy();
    }
  });

  it('a cut commit that is not an ancestor of the source withholds nothing', async () => {
    const r = initFixtureRepo();
    r.commit('base f', { 'src/f.ts': 'base\n' });
    const b = r.sha('main');
    r.commit('T0', { 'src/t0.ts': '0\n' });
    r.commit('T1', { 'src/t1.ts': '1\n' });
    // P never takes the trunk, so no chain commit is reachable from it.
    r.checkout('P', { create: true, at: b });
    r.commit('P: own file', { 'src/p.ts': 'p\n' });
    r.checkout('C', { create: true, at: b });
    r.checkout('main');
    try {
      const chn = await enumerateChain(r.dir, 'main', b);
      const pTip = await revParse(r.dir, 'P');
      const cTip = await revParse(r.dir, 'C');
      // Empty range, exit 0 — the answer is "nothing pending contains the cut",
      // not an error.
      expect(await ancestryPath(r.dir, chn.heads[1].sha, pTip)).toEqual([]);
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'C',
        branchTip: cTip,
        parent: 'P',
        model: 'parents',
        chain: chn,
        blockedAtHeight: 1,
      });
      expect(line.heads).toEqual([pTip]);
      expect(line.trimmedAt).toBeUndefined();
    } finally {
      r.destroy();
    }
  });

  it('a whole-range block withholds every pending commit', async () => {
    const { r, chn, pending } = await trunkLineFixture();
    try {
      const pTip = await revParse(r.dir, 'P');
      const withheld = await withheldByCut(r.dir, chn, WHOLE_RANGE_BLOCK, pTip, new Set(pending));
      expect(withheld).toEqual(new Set(pending));
    } finally {
      r.destroy();
    }
  });

  it('the walk spends NO coverage derivation on a candidate; a height is minted only where it is load-bearing', async () => {
    const { r, chn } = await trunkLineFixture();
    try {
      const cTip = await revParse(r.dir, 'C');
      resetCoverageDerivations();
      const line = await buildEligibleLine({
        repo: r.dir,
        branch: 'C',
        branchTip: cTip,
        parent: 'P',
        model: 'parents',
        chain: chn,
        blockedAtHeight: 2,
      });
      expect(line.heads.length).toBeGreaterThan(0);
      expect(line.trimmedAt).toBe(2);
      expect(coverageDerivations()).toBe(0);

      const pTipCost = await revParse(r.dir, 'P');
      const res = await walkLine(r.dir, cTip, line, pTipCost);
      expect(res.conflict).toBeNull();
      expect(coverageDerivations()).toBe(0);

      // The landed prefix's top is the ONE load-bearing commit on a clean
      // walk, and it is a chain commit here, so even minting it costs nothing.
      const mp = await mintHead(r.dir, chn, res.steps[res.steps.length - 1].sha);
      expect(mp.height).toBe(1);
      expect(coverageDerivations()).toBe(0);
      // An off-chain commit costs exactly one derivation.
      expect((await mintHead(r.dir, chn, await revParse(r.dir, 'P'))).height).toBe(2);
      expect(coverageDerivations()).toBe(1);
    } finally {
      r.destroy();
    }
  });
});

describe('pendingWalk — the advancing walk (§4.3)', () => {
  /**
   * FALSE CONFLICTS WITHOUT THE ADVANCE, even on a linear chain. P1 makes the
   * same edit the branch made (their lines converge); P2 then edits that region
   * again. Probed against the UNMOVED branch tip, P2 conflicts (both sides
   * changed the region vs the old base); probed against a tip that absorbed P1,
   * the merge base is P1 and P2's delta applies cleanly — which is exactly what
   * the executed sequence meets.
   */
  it('advances the hypothetical tip on clean steps — a linear chain lands whole where static probes conflict', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f.ts': 'one\ntwo\nthree\nfour\nfive\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('branch converges', { 'src/f.ts': 'ONE\ntwo\nthree\nfour\nfive\n' });
      r.checkout('P', { create: true, at: base });
      const p1 = r.commit('p1: same edit', { 'src/f.ts': 'ONE\ntwo\nthree\nfour\nfive\n' });
      const p2 = r.commit('p2: edits the region again', { 'src/f.ts': 'ONE-AGAIN\ntwo\nthree\nfour\nfive\n' });
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const pTip = await revParse(r.dir, 'P');

      // The static probe of p2 against the unmoved tip conflicts.
      const staticProbe = await newStyleMergeTree(r.dir, bTip, p2);
      expect(staticProbe.clean).toBe(false);

      const surface = await computeSurface(r.dir, pTip, bTip);
      const line: EligibleLine = { branch: 'B', parent: 'P', model: 'parents', heads: [p1, p2] };
      const res = await pendingWalk(r.dir, bTip, line, surface, pTip);
      expect(res.conflict).toBeNull();
      expect(res.steps.map((s) => s.sha)).toEqual([p1, p2]);
      expect(res.steps.every((s) => s.autoResolved.length === 0)).toBe(true);
      expect(await blobOidAt(r.dir, res.landTree!, 'src/f.ts')).toBe(await blobOidAt(r.dir, p2, 'src/f.ts'));
    } finally {
      r.destroy();
    }
  });

  /**
   * THE STOP IS THE FIRST UNRESOLVABLE CONFLICT AND THE CASE IS ONE COMMIT.
   * Nothing above the stop is probed, and nothing above it enters the case.
   */
  it('stops at the first in-surface conflict; the case is that single commit and nothing above it', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f.ts': 'v0\n', 'src/g.ts': 'g0\n', 'src/h.ts': 'h0\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('fork edit', { 'src/f.ts': 'fork\n' });
      r.checkout('P', { create: true, at: base });
      const c1 = r.commit('c1 clean', { 'src/g.ts': 'g1\n' });
      const c2 = r.commit('c2 conflicts', { 'src/f.ts': 'p2\n' });
      const c3 = r.commit('c3 conflicts too', { 'src/f.ts': 'p3\n' });
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const pTip = await revParse(r.dir, 'P');
      const surface = await computeSurface(r.dir, pTip, bTip);
      const line: EligibleLine = { branch: 'B', parent: 'P', model: 'parents', heads: [c1, c2, c3] };
      const res = await pendingWalk(r.dir, bTip, line, surface, pTip);
      expect(res.steps.map((s) => s.sha)).toEqual([c1]);
      expect(res.conflict?.head).toBe(c2);
      expect(res.conflict?.conflictedPaths).toEqual(['src/f.ts']);
      // c3 was never probed: the stop ends the walk.
      expect(res.probeCount).toBe(2);
      // The landed prefix carries c1's content and none of the conflict.
      expect(await blobOidAt(r.dir, res.landTree!, 'src/g.ts')).toBe(await blobOidAt(r.dir, c1, 'src/g.ts'));
      expect(await blobOidAt(r.dir, res.landTree!, 'src/f.ts')).toBe(await blobOidAt(r.dir, bTip, 'src/f.ts'));
    } finally {
      r.destroy();
    }
  });

  /**
   * OUT-OF-SURFACE CONFLICTS ARE NOBODY'S QUESTION. Two source lineages edit a
   * file the branch never touched; their collision — and the author's own
   * resolution of it in the merge commit — auto-resolve step by step, and the
   * walk lands the author's endpoint with no case.
   */
  it('auto-resolves out-of-surface conflicts to the incoming side and lands the author endpoint', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f_out.ts': 'o0\n', 'src/f_in.ts': 'i0\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('fork edit', { 'src/f_in.ts': 'iB\n' });
      r.checkout('P', { create: true, at: base });
      const x = r.commit('x: upstream state 1', { 'src/f_out.ts': 'oX\n' });
      r.checkout('Y', { create: true, at: base });
      const y = r.commit('y: upstream state 2', { 'src/f_out.ts': 'oY\n' });
      // The author integrates y and resolves the collision himself.
      const m = await authoredMerge(r, 'P', y, { 'src/f_out.ts': 'oM\n' }, 'author integrates');
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const surface = await computeSurface(r.dir, m, bTip);
      const line: EligibleLine = { branch: 'B', parent: 'P', model: 'parents', heads: [x, y, m] };
      const res = await pendingWalk(r.dir, bTip, line, surface, m);
      expect(res.conflict).toBeNull();
      expect(res.steps.map((s) => s.sha)).toEqual([x, y, m]);
      // The collision between the two upstream states auto-resolved mid-walk...
      expect(res.steps.some((s) => s.autoResolved.includes('src/f_out.ts'))).toBe(true);
      // ...and the endpoint carries the AUTHOR's resolution, not either input.
      expect(await blobOidAt(r.dir, res.landTree!, 'src/f_out.ts')).toBe(await blobOidAt(r.dir, m, 'src/f_out.ts'));
      expect(await blobOidAt(r.dir, res.landTree!, 'src/f_in.ts')).toBe(await blobOidAt(r.dir, bTip, 'src/f_in.ts'));
    } finally {
      r.destroy();
    }
  });

  /**
   * A MIXED conflict pre-resolves its out-of-surface members INTO the exhibit:
   * the case carries only the in-surface question, and the exhibit tree has
   * markers only there.
   */
  it('a mixed conflict ships an exhibit with out-of-surface members already resolved', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f_in.ts': 'i0\n', 'src/f_out.ts': 'o0\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('fork edit', { 'src/f_in.ts': 'iB\n' });
      r.checkout('P', { create: true, at: base });
      const x = r.commit('x', { 'src/f_out.ts': 'oX\n' });
      r.checkout('Z', { create: true, at: base });
      const z = r.commit('z: touches both', { 'src/f_in.ts': 'iZ\n', 'src/f_out.ts': 'oZ\n' });
      const m = await authoredMerge(
        r,
        'P',
        z,
        { 'src/f_out.ts': 'oM\n', 'src/f_in.ts': 'iZ\n' },
        'author integrates z',
      );
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const surface = await computeSurface(r.dir, m, bTip);
      const line: EligibleLine = { branch: 'B', parent: 'P', model: 'parents', heads: [x, z, m] };
      const res = await pendingWalk(r.dir, bTip, line, surface, m);
      expect(res.conflict?.head).toBe(z);
      // The case is the in-surface question only...
      expect(res.conflict?.conflictedPaths).toEqual(['src/f_in.ts']);
      // ...and the exhibit resolved the out-of-surface member to the incoming side.
      expect(await blobOidAt(r.dir, res.conflict!.automergeTree, 'src/f_out.ts')).toBe(
        await blobOidAt(r.dir, z, 'src/f_out.ts'),
      );
      const exhibited = (
        await git(r.dir, ['cat-file', 'blob', `${res.conflict!.automergeTree}:src/f_in.ts`])
      ).stdout;
      expect(exhibited).toContain('<<<<<<<');
    } finally {
      r.destroy();
    }
  });

  it('a line whose content the branch already carries lands a tree equal to the branch tree (no-op)', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f.ts': 'v0\n' });
      const base = r.sha('main');
      r.checkout('P', { create: true, at: base });
      const c1 = r.commit('p change', { 'src/f.ts': 'v1\n' });
      // The branch SQUASHED the same content (no ancestry).
      r.checkout('B', { create: true, at: base });
      r.commit('squash of p change', { 'src/f.ts': 'v1\n' });
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const surface = await computeSurface(r.dir, c1, bTip);
      const line: EligibleLine = { branch: 'B', parent: 'P', model: 'parents', heads: [c1] };
      const res = await pendingWalk(r.dir, bTip, line, surface, c1);
      expect(res.conflict).toBeNull();
      expect(res.landTree).toBe((await git(r.dir, ['rev-parse', `${bTip}^{tree}`])).stdout.trim());
    } finally {
      r.destroy();
    }
  });
});

describe('walkStep — the shared step engine', () => {
  /**
   * SKIP-BY-EQUIVALENCE at a merge step: the author DECIDED a path (the
   * recorded tree differs from the automerge of the merge's own parents), and
   * the branch already carries exactly that decision. The step resolves to the
   * agreed blob instead of stopping. The hypothetical tip is built explicitly
   * here because the shape only arises mid-walk (an earlier clean step moved
   * the path off the branch's own blob).
   */
  it('resolves an in-surface conflict where the branch already agrees with the merge author', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/p.ts': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n' });
      const base = r.sha('main');
      // The branch's own blob == the author's decision.
      r.checkout('B', { create: true, at: base });
      r.commit('branch carries the decision', { 'src/p.ts': 'l1\nl2\nDECIDED\nl4\nl5\nl6\nl7\n' });
      // The merge commit whose author decided the path.
      r.checkout('S1', { create: true, at: base });
      const s1 = r.commit('side 1', { 'src/p.ts': 'l1\nl2\nS1\nl4\nl5\nl6\nl7\n' });
      r.checkout('S2', { create: true, at: base });
      r.commit('side 2', { 'src/p.ts': 'l1\nl2\nS2\nl4\nl5\nl6\nl7\n' });
      const m = await authoredMerge(r, 'S2', s1, { 'src/p.ts': 'l1\nl2\nDECIDED\nl4\nl5\nl6\nl7\n' }, 'decide');
      r.git('checkout', '-f', 'main');
      const bTip = await revParse(r.dir, 'B');
      // A hypothetical tip whose blob agrees with NEITHER side (an earlier walk
      // step moved the disputed region), so the probe genuinely conflicts.
      const hypTree = await overlayTreePathsForTest(r, bTip, 'src/p.ts', 'l1\nl2\nHYP\nl4\nl5\nl6\nl7\n');
      const hyp = (await git(r.dir, ['commit-tree', hypTree, '-p', bTip, '-m', 'hyp'])).stdout.trim();
      const surface = await computeSurface(r.dir, m, bTip);
      expect(inSurface(surface, 'src/p.ts')).toBe(true);
      const probe = await newStyleMergeTree(r.dir, hyp, m);
      expect(probe.clean).toBe(false);
      const step = await walkStep(r.dir, hyp, m, surface, bTip, m);
      expect(step.kind).toBe('advance');
      if (step.kind === 'advance') {
        expect(step.autoResolved).toEqual(['src/p.ts']);
        expect(await blobOidAt(r.dir, step.tree, 'src/p.ts')).toBe(await blobOidAt(r.dir, m, 'src/p.ts'));
      }
    } finally {
      r.destroy();
    }
  });

  it('does NOT resolve where the branch disagrees with the merge author — that is the owner question', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/p.ts': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('branch disagrees', { 'src/p.ts': 'l1\nl2\nFORK\nl4\nl5\nl6\nl7\n' });
      r.checkout('S1', { create: true, at: base });
      const s1 = r.commit('side 1', { 'src/p.ts': 'l1\nl2\nS1\nl4\nl5\nl6\nl7\n' });
      r.checkout('S2', { create: true, at: base });
      r.commit('side 2', { 'src/p.ts': 'l1\nl2\nS2\nl4\nl5\nl6\nl7\n' });
      const m = await authoredMerge(r, 'S2', s1, { 'src/p.ts': 'l1\nl2\nDECIDED\nl4\nl5\nl6\nl7\n' }, 'decide');
      r.git('checkout', '-f', 'main');
      const bTip = await revParse(r.dir, 'B');
      const surface = await computeSurface(r.dir, m, bTip);
      const step = await walkStep(r.dir, bTip, m, surface, bTip, m);
      expect(step.kind).toBe('stop');
      if (step.kind === 'stop') expect(step.conflict.conflictedPaths).toEqual(['src/p.ts']);
    } finally {
      r.destroy();
    }
  });
});

describe('reconcileToAnchor — the endpoint agrees with the source out of surface', () => {
  it('takes the anchor blob at differing out-of-surface paths and leaves in-surface paths alone', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f_in.ts': 'i0\n', 'src/f_out.ts': 'o0\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('fork', { 'src/f_in.ts': 'iB\n' });
      r.checkout('P', { create: true, at: base });
      const p = r.commit('source', { 'src/f_in.ts': 'iP\n', 'src/f_out.ts': 'oP\n' });
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const surface = await computeSurface(r.dir, p, bTip);
      // A landed tree that drifted from the anchor at both paths.
      const drifted = await overlayTreePathsForTest(r, bTip, 'src/f_out.ts', 'oDRIFT\n');
      const rec = await reconcileToAnchor(r.dir, drifted, p, surface);
      expect(rec.reconciled).toEqual(['src/f_out.ts']);
      expect(await blobOidAt(r.dir, rec.tree, 'src/f_out.ts')).toBe(await blobOidAt(r.dir, p, 'src/f_out.ts'));
      // In-surface divergence (the fork's own content) is NOT overwritten.
      expect(await blobOidAt(r.dir, rec.tree, 'src/f_in.ts')).toBe(await blobOidAt(r.dir, bTip, 'src/f_in.ts'));
    } finally {
      r.destroy();
    }
  });
});

describe('replayPrefix — first-principles re-verification of a landed prefix', () => {
  it('reproduces the walk exactly and rejects a forged auto-resolution list', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/f_out.ts': 'o0\n', 'src/f_in.ts': 'i0\n' });
      const base = r.sha('main');
      r.checkout('B', { create: true, at: base });
      r.commit('fork', { 'src/f_in.ts': 'iB\n' });
      r.checkout('P', { create: true, at: base });
      const x = r.commit('x', { 'src/f_out.ts': 'oX\n' });
      r.checkout('Y', { create: true, at: base });
      const y = r.commit('y', { 'src/f_out.ts': 'oY\n' });
      const m = await authoredMerge(r, 'P', y, { 'src/f_out.ts': 'oM\n' }, 'integrate');
      r.checkout('main');
      const bTip = await revParse(r.dir, 'B');
      const surface = await computeSurface(r.dir, m, bTip);
      const line: EligibleLine = { branch: 'B', parent: 'P', model: 'parents', heads: [x, y, m] };
      const walk = await pendingWalk(r.dir, bTip, line, surface, m);
      expect(walk.conflict).toBeNull();

      const prefix = walk.steps.map((s) => ({ sha: s.sha, autoResolved: s.autoResolved }));
      const replay = await replayPrefix(r.dir, bTip, prefix, surface, m);
      expect(replay.ok).toBe(true);
      expect(replay.tree).toBe(walk.landTree);

      // A forged auto-resolution list does not verify.
      const forged = prefix.map((p, i) => (i === prefix.length - 1 ? { ...p, autoResolved: [] } : p));
      const bad = await replayPrefix(r.dir, bTip, forged, surface, m);
      expect(bad.ok).toBe(false);
      expect(bad.errors.join('\n')).toMatch(/auto-resolution mismatch|does not fully resolve/);

      // A prefix that includes a genuinely conflicting candidate does not verify.
      r.checkout('Q', { create: true, at: base });
      const q = r.commit('q: in-surface conflict', { 'src/f_in.ts': 'iQ\n' });
      r.checkout('main');
      const stopped = await replayPrefix(r.dir, bTip, [{ sha: q, autoResolved: [] }], surface, m);
      expect(stopped.ok).toBe(false);
      expect(stopped.errors.join('\n')).toContain('does not fully resolve');
    } finally {
      r.destroy();
    }
  });
});
