import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultInventoryDir } from './config.js';
import { loadFeatures, loadRegistry, loadReplayCases, loadRoutingConfig, parseFeatureEntry } from './registry.js';

const scratch = mkdtempSync(join(tmpdir(), 'sweep-registry-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

describe('local-tree loaders', () => {
  const inventory = join(scratch, 'inventory');
  mkdirSync(inventory, { recursive: true });
  writeFileSync(
    join(inventory, 'feat.good.yaml'),
    'id: feat.good\nname: Good\nkind: feat\nstatus: shipped\nbranch: feat/good\nowned_paths:\n  - src/good/**\n',
  );
  writeFileSync(join(inventory, 'feat.broken.yaml'), 'id: feat.broken\nname: no kind or status\n');
  const routingFile = join(scratch, 'routing.yaml');
  writeFileSync(
    routingFile,
    'weights:\n  owned: 20\nthreshold: 8\nlarge_new_file_kb: 32\nsensitive_surfaces:\n  - src/router.ts\ncatch_all:\n  always_include: [new-skill]\n',
  );
  const scopeFile = join(scratch, 'scope.yaml');
  writeFileSync(scopeFile, 'include: [main_patched, "fix/**"]\nrecipe: [module/a, feat/b]\n');

  it('loads features/routing/scope from local files; bad entries become warnings', () => {
    const reg = loadRegistry({ inventoryDir: inventory, routingFile, scopeFile });
    expect(reg.features.map((f) => f.id)).toEqual(['feat.good']);
    expect(reg.warnings.some((w) => w.includes('feat.broken'))).toBe(true);
    expect(reg.routing).toEqual({
      weights: { owned: 20, touch: 6, symbol: 3, keyword: 1 },
      threshold: 8,
      top_k: 4,
      largeNewFileKb: 32,
      sensitiveSurfaces: ['src/router.ts'],
      catchAllAlwaysInclude: ['new-skill'],
    });
    expect(reg.scope).toEqual({ include: ['main_patched', 'fix/**'], recipe: ['module/a', 'feat/b'] });
  });

  it('warns on a missing inventory dir and returns defaults for missing config files', () => {
    const { features, warnings } = loadFeatures(join(scratch, 'nope'));
    expect(features).toEqual([]);
    expect(warnings[0]).toContain('does not exist');
    const { routing } = loadRoutingConfig(join(scratch, 'no-routing.yaml'));
    expect(routing.threshold).toBe(6);
  });

  it('loads replay cases from a local directory', () => {
    const casesDir = join(scratch, 'cases');
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(
      join(casesDir, 'ok.yaml'),
      'id: c1\ntaxonomy: T1\nfork_branch: feat/x\nfork_base_commit: abc\nupstream_range: a..b\nexpected:\n  classification: clean\n',
    );
    writeFileSync(join(casesDir, 'bad.yaml'), 'id: c2\ntaxonomy: T1\n');
    const { cases, warnings } = loadReplayCases(casesDir);
    expect(cases.map((c) => c.id)).toEqual(['c1']);
    expect(warnings.some((w) => w.includes('bad.yaml'))).toBe(true);
  });

  it('the committed bootstrap snapshot is the default inventory and parses clean', () => {
    const dir = defaultInventoryDir();
    expect(dir).toBeTruthy();
    expect(dir).toContain('bootstrap/fork-registry@');
    const { features, warnings } = loadFeatures(dir);
    expect(features.length).toBe(27);
    expect(warnings).toEqual([]);
    expect(features.some((f) => f.id === 'feat.mitm-credential-proxy')).toBe(true);
  });
});
