import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';
import {
  commitFilesOnBranch,
  commitTreeMerge,
  firstParentChain,
  isAncestor,
  listTreePaths,
  newStyleMergeTree,
  readFileFromBranch,
  refExists,
  revParse,
} from './git.js';

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

describe('commitFilesOnBranch', () => {
  it('creates and extends a branch without checkout', async () => {
    expect(await refExists(repo.dir, 'state-branch')).toBe(false);
    await commitFilesOnBranch(repo.dir, 'state-branch', { 'dir/a.txt': 'one\n' }, 'c1');
    const second = await commitFilesOnBranch(repo.dir, 'state-branch', { 'dir/b.txt': 'two\n' }, 'c2');
    expect(await revParse(repo.dir, 'state-branch')).toBe(second);
    expect(await readFileFromBranch(repo.dir, 'state-branch', 'dir/a.txt')).toBe('one\n');
    expect(await readFileFromBranch(repo.dir, 'state-branch', 'dir/b.txt')).toBe('two\n');
    expect(await readFileFromBranch(repo.dir, 'state-branch', 'missing.txt')).toBeNull();
    // Still on main, still clean.
    expect(repo.git('branch', '--show-current')).toBe('main');
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
