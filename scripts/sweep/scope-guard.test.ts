import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { addTempWorktree, newStyleMergeTree } from './git.js';
import { scopeGuard } from './scope-guard.js';

// Build two trees: an "automerge" tree and a "resolved" tree, and diff them.
const repo = initFixtureRepo();
afterAll(() => repo.destroy());

// automerge state (conflict on src/app.ts).
repo.checkout('automerge', { create: true, at: 'main' });
const automergeTree = repo.git('rev-parse', 'automerge^{tree}');

describe('scopeGuard (§7)', () => {
  it('passes when the resolution only touches conflicted paths', () => {
    repo.checkout('resolved-ok', { create: true, at: 'main' });
    repo.commit('resolve within scope', { 'src/app.ts': 'export const app = () => 2;\n' });
    const resolvedTree = repo.git('rev-parse', 'resolved-ok^{tree}');
    return scopeGuard(repo.dir, automergeTree, resolvedTree, ['src/app.ts']).then((r) => {
      expect(r.ok).toBe(true);
      expect(r.extraPaths).toEqual([]);
      expect(r.changedPaths).toEqual(['src/app.ts']);
    });
  });

  it('fails (demote) when the resolution touches a file outside the conflict set', () => {
    repo.checkout('resolved-bad', { create: true, at: 'main' });
    repo.commit('resolve + sneak an extra file', {
      'src/app.ts': 'export const app = () => 3;\n',
      'src/sneaky.ts': 'export const s = 1;\n',
    });
    const resolvedTree = repo.git('rev-parse', 'resolved-bad^{tree}');
    return scopeGuard(repo.dir, automergeTree, resolvedTree, ['src/app.ts']).then((r) => {
      expect(r.ok).toBe(false);
      expect(r.extraPaths).toEqual(['src/sneaky.ts']);
    });
  });
});

// --- conflict-hunks mode (§7 lever) ---------------------------------------
describe('scopeGuard — conflict-hunks mode', () => {
  // A real conflict on a middle line, leaving context lines outside the markers.
  const r = initFixtureRepo();
  afterAll(() => r.destroy());
  r.commit('base m.ts', { 'src/m.ts': 'a\nb\nMID\nd\ne\n' });
  r.checkout('ours', { create: true, at: 'main' });
  r.commit('ours: MID -> FORK', { 'src/m.ts': 'a\nb\nFORK\nd\ne\n' });
  r.checkout('main');
  r.checkout('theirs', { create: true, at: 'main' });
  r.commit('theirs: MID -> UP1', { 'src/m.ts': 'a\nb\nUP1\nd\ne\n' });
  r.checkout('main');

  /** Build a resolved tree = the automerge tree with src/m.ts overwritten. */
  async function resolvedTreeWith(automergeTree: string, content: string): Promise<string> {
    const amCommit = r.git('commit-tree', automergeTree, '-m', 'am');
    const wt = await addTempWorktree(r.dir, amCommit);
    try {
      writeFileSync(join(wt.path, 'src/m.ts'), content);
      r.git('-C', wt.path, 'add', '-A');
      r.git('-C', wt.path, 'commit', '-m', 'resolve');
      return r.git('-C', wt.path, 'rev-parse', 'HEAD^{tree}');
    } finally {
      await wt.remove();
    }
  }

  it('conflict-hunks HOLDs an in-file edit outside the conflict markers; same-files passes it', async () => {
    const mt = await newStyleMergeTree(r.dir, 'ours', 'theirs');
    expect(mt.clean).toBe(false);
    expect(mt.conflictFiles).toEqual(['src/m.ts']);
    // Out-of-hunk: edits context line 1 ('a' -> 'aX') as well as resolving the block.
    const outOfHunk = await resolvedTreeWith(mt.treeOid, 'aX\nb\nMERGED\nd\ne\n');
    const strict = await scopeGuard(r.dir, mt.treeOid, outOfHunk, ['src/m.ts'], 'conflict-hunks');
    expect(strict.ok).toBe(false);
    expect(strict.hunkViolations).toEqual(['src/m.ts']);
    const lax = await scopeGuard(r.dir, mt.treeOid, outOfHunk, ['src/m.ts'], 'same-files');
    expect(lax.ok).toBe(true); // same-files allows edits anywhere within conflicted files
  });

  it('conflict-hunks passes a strictly-in-hunk resolution', async () => {
    const mt = await newStyleMergeTree(r.dir, 'ours', 'theirs');
    const inHunk = await resolvedTreeWith(mt.treeOid, 'a\nb\nMERGED\nd\ne\n'); // only the marker block changes
    const strict = await scopeGuard(r.dir, mt.treeOid, inHunk, ['src/m.ts'], 'conflict-hunks');
    expect(strict.ok).toBe(true);
    expect(strict.hunkViolations).toEqual([]);
  });
});
