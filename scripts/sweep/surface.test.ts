import { describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { diffNameStatus, newStyleMergeTree, revParse } from './git.js';
import { computeSurface, inSurface } from './surface.js';

describe('computeSurface — the branch-own path set (§4.3)', () => {
  it('collects added, modified and deleted paths vs the merge base', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/kept.ts': 'kept\n', 'src/mod.ts': 'v0\n', 'src/gone.ts': 'bye\n' });
      const base = r.sha('main');
      r.checkout('src', { create: true, at: base });
      r.commit('source work', { 'src/upstreamish.ts': 'u\n' });
      r.checkout('branch', { create: true, at: base });
      r.commit('branch work', { 'src/mod.ts': 'v1\n', 'src/new.ts': 'n\n' });
      r.git('rm', 'src/gone.ts');
      r.git('commit', '-m', 'drop gone');
      const s = await computeSurface(r.dir, await revParse(r.dir, 'src'), await revParse(r.dir, 'branch'));
      expect(s.paths).not.toBeNull();
      expect([...s.paths!].sort()).toEqual(['src/gone.ts', 'src/mod.ts', 'src/new.ts']);
      expect(inSurface(s, 'src/kept.ts')).toBe(false);
      expect(inSurface(s, 'src/upstreamish.ts')).toBe(false);
    } finally {
      r.destroy();
    }
  });

  it('a branch-side rename puts BOTH names in the surface', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', { 'src/old.ts': 'line1\nline2\nline3\nline4\nline5\n' });
      const base = r.sha('main');
      r.checkout('src', { create: true, at: base });
      r.commit('source', { 'src/other.ts': 'o\n' });
      r.checkout('branch', { create: true, at: base });
      r.git('mv', 'src/old.ts', 'src/renamed.ts');
      r.git('commit', '-m', 'rename');
      const s = await computeSurface(r.dir, await revParse(r.dir, 'src'), await revParse(r.dir, 'branch'));
      expect(inSurface(s, 'src/old.ts')).toBe(true);
      expect(inSurface(s, 'src/renamed.ts')).toBe(true);
    } finally {
      r.destroy();
    }
  });

  /**
   * THE RENAME HOLE. The branch edits `src/x.ts`; the source RENAMES it to
   * `src/y.ts` and edits it. The merge is rename-aware, so the conflict lands
   * at `src/y.ts` — a path a rename-blind surface does not contain. Reading
   * that conflict as out-of-surface auto-resolves it to the incoming side,
   * which silently deletes the fork's edit. The closure under source-side
   * renames is what puts `src/y.ts` in the surface.
   */
  it('closes the surface under source-side renames — the conflicted path is IN', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('base', {
        'src/x.ts': 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n',
      });
      const base = r.sha('main');
      r.checkout('src', { create: true, at: base });
      r.git('mv', 'src/x.ts', 'src/y.ts');
      r.write('src/y.ts', 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\nSOURCE-tail\n');
      r.git('add', '-A');
      r.git('commit', '-m', 'source renames x -> y and edits the tail');
      r.checkout('branch', { create: true, at: base });
      r.commit('branch edits the tail of x', {
        'src/x.ts': 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\nFORK-tail\n',
      });
      const srcTip = await revParse(r.dir, 'src');
      const branchTip = await revParse(r.dir, 'branch');

      // The merge machinery follows the rename: the conflict is at src/y.ts.
      const probe = await newStyleMergeTree(r.dir, branchTip, srcTip);
      expect(probe.clean).toBe(false);
      expect(probe.conflictFiles).toContain('src/y.ts');

      // A rename-blind surface (the branch's own --no-renames diff) misses it —
      // this is the hole the closure exists to plug.
      const blind = new Set((await diffNameStatus(r.dir, base, branchTip)).map((c) => c.path));
      expect(blind.has('src/y.ts')).toBe(false);

      const s = await computeSurface(r.dir, srcTip, branchTip);
      expect(inSurface(s, 'src/y.ts')).toBe(true);
      expect(inSurface(s, 'src/x.ts')).toBe(true);
    } finally {
      r.destroy();
    }
  });

  it('no merge base = every path is in the surface (fail toward asking)', async () => {
    const r = initFixtureRepo();
    try {
      r.commit('root a', { 'a.ts': 'a\n' });
      const a = r.sha('main');
      r.git('checkout', '--orphan', 'other');
      r.git('rm', '-rf', '.');
      r.commit('root b', { 'b.ts': 'b\n' });
      const b = r.sha('other');
      const s = await computeSurface(r.dir, b, a);
      expect(s.paths).toBeNull();
      expect(inSurface(s, 'anything/at/all.ts')).toBe(true);
    } finally {
      r.destroy();
    }
  });
});
