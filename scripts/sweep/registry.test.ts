import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { commitFilesOnBranch } from './git.js';
import { loadRegistry, parseFeatureEntry } from './registry.js';

const STATE_BRANCH = 'maint/fork-registry';
const repo = initFixtureRepo();
afterAll(() => repo.destroy());

describe('parseFeatureEntry (fail closed)', () => {
  it('accepts a minimal valid entry', () => {
    const { entry, error } = parseFeatureEntry(
      'id: feat.x\nname: X\nkind: feat\nstatus: shipped\nbranch: feat/x\n',
      'f.yaml',
    );
    expect(error).toBeUndefined();
    expect(entry).toMatchObject({ id: 'feat.x', branch: 'feat/x' });
  });

  it('rejects missing fields, bad enums, and branchless non-planned entries', () => {
    expect(parseFeatureEntry('name: X\nkind: feat\nstatus: shipped\n', 'f').error).toMatch(/missing required/);
    expect(parseFeatureEntry('id: a\nname: X\nkind: nope\nstatus: shipped\n', 'f').error).toMatch(/bad kind/);
    expect(parseFeatureEntry('id: a\nname: X\nkind: feat\nstatus: later\n', 'f').error).toMatch(/bad status/);
    expect(parseFeatureEntry('id: a\nname: X\nkind: feat\nstatus: shipped\n', 'f').error).toMatch(/branch required/);
    expect(parseFeatureEntry('id: a\nname: X\nkind: planned\nstatus: planned\n', 'f').error).toBeUndefined();
    expect(parseFeatureEntry('- just\n- a list\n', 'f').error).toMatch(/not a mapping/);
    expect(parseFeatureEntry('{{{{', 'f').error).toMatch(/YAML parse error/);
  });
});

describe('loadRegistry', () => {
  it('loads features/routing/scope from the state branch; bad entries become warnings', async () => {
    await commitFilesOnBranch(
      repo.dir,
      STATE_BRANCH,
      {
        'fork-registry/features/feat.good.yaml':
          'id: feat.good\nname: Good\nkind: feat\nstatus: shipped\nbranch: feat/good\nowned_paths:\n  - src/good/**\n',
        'fork-registry/features/feat.broken.yaml': 'id: feat.broken\nname: no kind or status\n',
        'fork-registry/routing.yaml':
          'weights:\n  owned: 20\nthreshold: 8\nlarge_new_file_kb: 32\nsensitive_surfaces:\n  - src/router.ts\ncatch_all:\n  always_include: [new-skill]\n',
        'fork-registry/sweep-scope.yaml': 'include: [main_patched]\nrecipe: [module/a, feat/b]\n',
      },
      'seed registry',
    );
    const reg = await loadRegistry(repo.dir, STATE_BRANCH);
    expect(reg.features.map((f) => f.id)).toEqual(['feat.good']);
    expect(reg.warnings.some((w) => w.includes('feat.broken'))).toBe(true);
    // routing: overrides merge over defaults; live-schema extras are surfaced
    expect(reg.routing).toEqual({
      weights: { owned: 20, touch: 6, symbol: 3, keyword: 1 },
      threshold: 8,
      top_k: 4,
      largeNewFileKb: 32,
      sensitiveSurfaces: ['src/router.ts'],
      catchAllAlwaysInclude: ['new-skill'],
    });
    expect(reg.scope).toEqual({ include: ['main_patched'], recipe: ['module/a', 'feat/b'] });
  });

  it('returns defaults when the state branch has no registry at all', async () => {
    const reg = await loadRegistry(repo.dir, 'no-such-branch');
    expect(reg.features).toEqual([]);
    expect(reg.routing.threshold).toBe(6);
    expect(reg.scope).toEqual({});
    expect(reg.warnings).toEqual([]);
  });
});
