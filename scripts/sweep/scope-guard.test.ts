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

// --- allowedGlobs: paths admitted by predicate (the repo's own testPaths) ----

describe('scopeGuard — allowedGlobs', () => {
  const g = initFixtureRepo();
  afterAll(() => g.destroy());
  g.commit('base', { 'src/app.ts': 'a\nb\nMID\nd\ne\n', 'src/app.test.ts': 'assert(1)\n' });
  g.checkout('ours', { create: true, at: 'main' });
  g.commit('ours: MID -> FORK', { 'src/app.ts': 'a\nb\nFORK\nd\ne\n' });
  g.checkout('main');
  g.checkout('theirs', { create: true, at: 'main' });
  g.commit('theirs: MID -> UP1', { 'src/app.ts': 'a\nb\nUP1\nd\ne\n' });
  g.checkout('main');

  /** The automerge tree with the conflict resolved AND the test updated with it. */
  async function resolvedWithTestEdit(automergeTree: string): Promise<string> {
    const amCommit = g.git('commit-tree', automergeTree, '-m', 'am');
    const wt = await addTempWorktree(g.dir, amCommit);
    try {
      writeFileSync(join(wt.path, 'src/app.ts'), 'a\nb\nMERGED\nd\ne\n');
      writeFileSync(join(wt.path, 'src/app.test.ts'), 'assert(MERGED)\n');
      g.git('-C', wt.path, 'add', '-A');
      g.git('-C', wt.path, 'commit', '-m', 'resolve + move the test with it');
      return g.git('-C', wt.path, 'rev-parse', 'HEAD^{tree}');
    } finally {
      await wt.remove();
    }
  }

  it('admits a changed path matching a glob, and holds it when no glob is configured', async () => {
    const mt = await newStyleMergeTree(g.dir, 'ours', 'theirs');
    expect(mt.conflictFiles).toEqual(['src/app.ts']);
    const resolved = await resolvedWithTestEdit(mt.treeOid);
    // No globs: the test file is an extra file like any other — today's rule,
    // and what an absent `testPaths` key still buys.
    const closed = await scopeGuard(g.dir, mt.treeOid, resolved, ['src/app.ts']);
    expect(closed.ok).toBe(false);
    expect(closed.extraPaths).toEqual(['src/app.test.ts']);
    // With the repo's own test globs, the same edit is in scope.
    const open = await scopeGuard(g.dir, mt.treeOid, resolved, ['src/app.ts'], 'same-files', {
      allowedGlobs: ['**/*.test.ts'],
    });
    expect(open.ok).toBe(true);
    expect(open.extraPaths).toEqual([]);
    expect(open.changedPaths).toContain('src/app.test.ts');
  });

  it('a glob-admitted path is HUNK-EXEMPT: it carries no markers to bound edits by', async () => {
    const mt = await newStyleMergeTree(g.dir, 'ours', 'theirs');
    const resolved = await resolvedWithTestEdit(mt.treeOid);
    // The conflicted file is still hunk-checked (this resolution stays inside
    // its markers), while the admitted test file — every line of which is
    // outside any marker span, there being none — is not checked at all.
    const strict = await scopeGuard(g.dir, mt.treeOid, resolved, ['src/app.ts'], 'conflict-hunks', {
      allowedGlobs: ['**/*.test.ts'],
    });
    expect(strict.ok).toBe(true);
    expect(strict.hunkViolations).toEqual([]);
  });
});
