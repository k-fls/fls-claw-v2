import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';
import {
  commitTreeMerge,
  firstParentChain,
  isAncestor,
  listTreePaths,
  replayCommitOnto,
  newStyleMergeTree,
  revParse,
} from './git.js';
import { initFixtureRepo } from './fixtures.js';

const { repo, chain } = makeSweepFixture();
afterAll(() => repo.destroy());

describe('newStyleMergeTree', () => {
  it('reports a clean merge', async () => {
    const res = await newStyleMergeTree(repo.dir, 'feat/two', 'upstream-main');
    expect(res.clean).toBe(true);
    expect(res.conflictFiles).toEqual([]);
    expect(res.treeOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports conflict files on a same-line edit', async () => {
    const res = await newStyleMergeTree(repo.dir, 'feat/one', 'upstream-main');
    expect(res.clean).toBe(false);
    expect(res.conflictFiles).toEqual(['src/app.ts']);
  });
});

describe('firstParentChain', () => {
  it('returns pending upstream commits oldest first', async () => {
    expect(await firstParentChain(repo.dir, 'upstream-main', 'main')).toEqual(chain);
  });

  it('is empty when up to date', async () => {
    expect(await firstParentChain(repo.dir, 'main', 'upstream-main')).toEqual([]);
  });
});

describe('commitTreeMerge (July-sweep technique)', () => {
  it('merges a clean branch without any checkout', async () => {
    const before = await revParse(repo.dir, 'feat/two');
    const merged = await commitTreeMerge(repo.dir, 'feat/two', 'upstream-main', 'test merge');
    expect(await revParse(repo.dir, 'feat/two')).toBe(merged);
    // Both parents present; content from both sides.
    const files = await listTreePaths(repo.dir, 'feat/two');
    expect(files).toContain('src/two.ts');
    expect(files).toContain('docs/more.md');
    expect(await isAncestor(repo.dir, before, 'feat/two')).toBe(true);
    expect(await isAncestor(repo.dir, 'upstream-main', 'feat/two')).toBe(true);
    // The checked-out branch (main) is untouched.
    expect(repo.git('status', '--porcelain')).toBe('');
  });

  it('refuses a conflicted merge', async () => {
    await expect(commitTreeMerge(repo.dir, 'feat/one', 'upstream-main', 'nope')).rejects.toThrow(/not a clean merge/);
  });
});

describe('replayCommitOnto — transplanting one delta, not a whole branch', () => {
  // The red-finish escalation shape: origin sits at the pre-pass tip, the local
  // branch carries an unpushed pass merge, and the agent's fix sits on top of
  // that. Only the FIX may reach the escalation PR.
  function transplantRepo() {
    const r = initFixtureRepo();
    r.commit('base', { 'src/x.ts': 'orig\n', 'src/keep.ts': 'keep\n' });
    r.checkout('mp', { create: true, at: 'main' });
    r.commit('origin tip', { 'src/x.ts': 'fork\n' });
    const originTip = r.sha('mp');
    r.commit('pass merge — UNPUSHED, unverified (finish was red)', { 'src/unpushed.ts': 'nope\n' });
    const tip = r.sha('mp');
    r.commit('the agent gate fix', { 'src/keep.ts': 'fixed\n' });
    const localHead = r.sha('mp');
    return { r, originTip, tip, localHead };
  }

  it("replays only the commit's own delta — the unpushed merge is left behind", async () => {
    const { r, originTip, tip, localHead } = transplantRepo();
    try {
      const replay = await replayCommitOnto(r.dir, localHead, originTip);
      expect(replay.clean).toBe(true);
      const paths = await listTreePaths(r.dir, replay.treeOid);
      // The fix is present...
      expect(paths).toContain('src/keep.ts');
      // ...and the pass's unpushed merge is NOT.
      expect(paths).not.toContain('src/unpushed.ts');
    } finally {
      r.destroy();
    }
  });

  it("git's own base choice would drag the unpushed merge in — which is why a plain merge-tree is wrong", async () => {
    const { r, originTip, localHead } = transplantRepo();
    try {
      // originTip is an ancestor of localHead, so the inferred base IS originTip
      // and "theirs" wins wholesale: the unpushed merge comes along.
      const naive = await newStyleMergeTree(r.dir, originTip, localHead);
      expect(naive.clean).toBe(true);
      expect(await listTreePaths(r.dir, naive.treeOid)).toContain('src/unpushed.ts');
    } finally {
      r.destroy();
    }
  });
});
