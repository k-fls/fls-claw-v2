import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultInventoryDir } from './config.js';
import { loadFeatures, loadRegistry, loadRoutingConfig, parseFeatureEntry } from './registry.js';

const scratch = mkdtempSync(join(tmpdir(), 'sweep-registry-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('parseFeatureEntry (strict config schema)', () => {
  it('accepts a minimal valid entry', () => {
    const { entry, error } = parseFeatureEntry('id: feat.x\nname: X\nkind: feat\nbranch: feat/x\n', 'f.yaml');
    expect(error).toBeUndefined();
    expect(entry).toMatchObject({ id: 'feat.x', branch: 'feat/x' });
  });

  it('accepts an entry without a branch (planned/observational config)', () => {
    const { entry, error } = parseFeatureEntry('id: planned.x\nname: X\nkind: planned\n', 'f.yaml');
    expect(error).toBeUndefined();
    expect(entry).toMatchObject({ id: 'planned.x' });
    expect(entry!.branch).toBeUndefined();
  });

  it('accepts the declared levers: tier_floor judged and always_merge', () => {
    const { entry, error } = parseFeatureEntry(
      'id: feat.x\nname: X\nkind: feat\nbranch: feat/x\ntier_floor: judged\nalways_merge: true\n',
      'f.yaml',
    );
    expect(error).toBeUndefined();
    expect(entry).toMatchObject({ tier_floor: 'judged', always_merge: true });
  });

  it('rejects missing required fields and malformed documents', () => {
    expect(parseFeatureEntry('name: X\nkind: feat\n', 'f').error).toMatch(/missing required/);
    expect(parseFeatureEntry('- just\n- a list\n', 'f').error).toMatch(/not a mapping/);
    expect(parseFeatureEntry('{{{{', 'f').error).toMatch(/YAML parse error/);
  });

  it('rejects any unknown key: the inventory is strict config only', () => {
    expect(parseFeatureEntry('id: a\nname: X\nkind: feat\nbranch: feat/a\nstatus: shipped\n', 'f').error).toMatch(
      /unknown key 'status'/,
    );
    expect(parseFeatureEntry('id: a\nname: X\nkind: feat\nmaintenance:\n  last_verified: x\n', 'f').error).toMatch(
      /unknown key 'maintenance'/,
    );
  });

  it('rejects bad-shaped values for declared keys', () => {
    expect(parseFeatureEntry('id: a\nname: X\nkind: nope\n', 'f').error).toMatch(/bad value for 'kind'/);
    expect(parseFeatureEntry('id: a\nname: X\nkind: feat\ntier_floor: held\n', 'f').error).toMatch(
      /bad value for 'tier_floor'/,
    );
    expect(parseFeatureEntry('id: a\nname: X\nkind: feat\nbranch: 7\n', 'f').error).toMatch(/bad value for 'branch'/);
  });

  it('rejects prose fields: the inventory carries no guidance addressed to the agent', () => {
    for (const key of ['prompt', 'invariants', 'overlap_hints', 'touch_paths', 'symbol_watch']) {
      const yaml = `id: a\nname: X\nkind: feat\n${key}: whatever\n`;
      expect(parseFeatureEntry(yaml, 'f').error).toMatch(new RegExp(`unknown key '${key}'`));
    }
  });
});

describe('local-tree loaders', () => {
  const inventory = join(scratch, 'inventory');
  mkdirSync(inventory, { recursive: true });
  writeFileSync(
    join(inventory, 'feat.good.yaml'),
    'id: feat.good\nname: Good\nkind: feat\nbranch: feat/good\nowned_paths:\n  - src/good/**\n',
  );
  writeFileSync(join(inventory, 'feat.broken.yaml'), 'id: feat.broken\nname: no kind\n');
  const routingFile = join(scratch, 'routing.yaml');
  writeFileSync(routingFile, 'schemaVersion: 1\nscope_guard_mode: conflict-hunks\nstack_cap: 3\n');
  const scopeFile = join(scratch, 'scope.yaml');
  writeFileSync(scopeFile, 'exclude: ["wip/**"]\n');

  it('loads features/routing/scope from local files; bad entries become warnings', () => {
    const reg = loadRegistry({ inventoryDir: inventory, routingFile, scopeFile });
    expect(reg.features.map((f) => f.id)).toEqual(['feat.good']);
    expect(reg.warnings.some((w) => w.includes('feat.broken'))).toBe(true);
    expect(reg.routing).toEqual({ scopeGuardMode: 'conflict-hunks', stackCap: 3 });
    expect(reg.scope).toEqual({ exclude: ['wip/**'] });
  });

  it('warns on a missing inventory dir and returns defaults for missing config files', () => {
    const { features, warnings } = loadFeatures(join(scratch, 'nope'));
    expect(features).toEqual([]);
    expect(warnings[0]).toContain('does not exist');
    const { routing } = loadRoutingConfig(join(scratch, 'no-routing.yaml'));
    expect(routing).toEqual({}); // both levers unset -> consumers apply their own defaults
  });

  it('the committed scripts/sweep/inventory is the default inventory and loads with zero warnings', () => {
    const dir = defaultInventoryDir();
    expect(dir).toBeTruthy();
    expect(dir).toContain(join('scripts', 'sweep', 'inventory'));
    const { features, warnings } = loadFeatures(dir);
    expect(features.length).toBe(27);
    expect(warnings).toEqual([]);
    expect(features.some((f) => f.id === 'feat.mitm-credential-proxy')).toBe(true);
  });
});
