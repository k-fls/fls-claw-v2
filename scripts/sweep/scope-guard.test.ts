import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { scopeGuard } from './scope-guard.js';

// Build two trees: an "automerge" tree and a "resolved" tree, and diff them.
const repo = initFixtureRepo();
afterAll(() => repo.destroy());

// automerge state (conflict on src/app.ts).
repo.checkout('automerge', { create: true, at: 'main' });
const automergeTree = repo.git('rev-parse', 'automerge^{tree}');

describe('scopeGuard (§7, D-038)', () => {
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
