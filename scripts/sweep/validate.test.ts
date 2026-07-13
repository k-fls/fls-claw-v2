import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { validateRegistry } from './validate.js';
import type { FeatureEntry } from './types.js';

const repo = initFixtureRepo();
afterAll(() => repo.destroy());

repo.checkout('feat/real', { create: true, at: 'main' });
repo.commit('real feature', {
  'src/modules/example/index.ts': 'export function registerExample() {}\n',
  'src/modules/example/e2e.test.ts': 'test\n',
  'docs/design/example.md': '# design\n',
});
repo.checkout('main');
repo.git('branch', 'module/unregistered', 'main'); // rule-5 trigger
repo.git('branch', 'everything', 'main'); // excluded namespace, must NOT trigger rule 5
// Non-inventory branch inside an edition composition (rule-5 WARN, scope pass):
repo.checkout('fix/candidate', { create: true, at: 'main' });
repo.commit('upstreamable fix', { 'src/candidate.ts': 'export const x = 1;\n' });
repo.checkout('edition/ed', { create: true, at: 'main' });
repo.git('merge', '--no-edit', 'fix/candidate');
repo.checkout('main');
const realTip = repo.sha('feat/real');

function entry(partial: Partial<FeatureEntry> & { id: string }): FeatureEntry {
  return { name: partial.id, kind: 'feat', status: 'shipped', branch: 'feat/real', ...partial } as FeatureEntry;
}

const GOOD = entry({
  id: 'feat.good',
  owned_paths: ['src/modules/example/**'],
  test_anchors: ['src/modules/example/e2e.test.ts'],
  design_docs: ['docs/design/example.md@feat/real'],
  key_symbols: ['registerExample — src/modules/example/index.ts'],
  maintenance: { last_verified: '2026-07-09', verified_against: realTip },
});

describe('validateRegistry', () => {
  it('a fully consistent entry produces no issues for itself', async () => {
    const res = await validateRegistry(repo.dir, [GOOD], { now: new Date('2026-07-10') });
    expect(res.issues.filter((i) => i.featureId === 'feat.good')).toEqual([]);
    expect(res.alertedFeatureIds).toEqual([]);
  });

  it('rule 1: missing branch is an ALERT and short-circuits the entry', async () => {
    const res = await validateRegistry(repo.dir, [entry({ id: 'feat.ghost', branch: 'feat/does-not-exist' })]);
    const issues = res.issues.filter((i) => i.featureId === 'feat.ghost');
    expect(issues).toEqual([expect.objectContaining({ level: 'ALERT', rule: 1 })]);
    expect(res.alertedFeatureIds).toContain('feat.ghost');
  });

  it('rule 2: owned_paths glob matching nothing is an ALERT', async () => {
    const res = await validateRegistry(repo.dir, [entry({ id: 'feat.stale', owned_paths: ['src/gone/**'] })]);
    expect(res.issues).toContainEqual(expect.objectContaining({ featureId: 'feat.stale', level: 'ALERT', rule: 2 }));
  });

  it('rule 3: missing test_anchors / design_docs are ALERTs', async () => {
    const res = await validateRegistry(repo.dir, [
      entry({ id: 'feat.anchors', test_anchors: ['src/nope.test.ts'], design_docs: ['docs/none.md@feat/real'] }),
    ]);
    const rules = res.issues.filter((i) => i.featureId === 'feat.anchors').map((i) => i.rule);
    expect(rules).toEqual([3, 3]);
  });

  it('rule 4: missing key_symbols are WARNs only', async () => {
    const res = await validateRegistry(repo.dir, [
      entry({ id: 'feat.sym', key_symbols: ['noSuchSymbolAnywhere — x.ts'] }),
    ]);
    const issue = res.issues.find((i) => i.featureId === 'feat.sym');
    expect(issue).toMatchObject({ level: 'WARN', rule: 4 });
    expect(res.alertedFeatureIds).toEqual([]); // WARNs don't fail-close
  });

  it('rule 4: multi-symbol "A / B — path" convention passes when ANY symbol is found', async () => {
    const res = await validateRegistry(repo.dir, [
      entry({ id: 'feat.multi', key_symbols: ['noSuchSymbol / registerExample — src/modules/example/index.ts'] }),
    ]);
    expect(res.issues.filter((i) => i.featureId === 'feat.multi')).toEqual([]);
  });

  it('rule 5: sweepable branch without an entry is an ALERT; excluded namespaces are not', async () => {
    const res = await validateRegistry(repo.dir, [GOOD]);
    const alerts5 = res.issues.filter((i) => i.rule === 5 && i.level === 'ALERT').map((i) => i.message);
    expect(alerts5.some((m) => m.includes('module/unregistered'))).toBe(true);
    expect(alerts5.some((m) => m.includes('edition/ed'))).toBe(true); // edition without an entry alerts too
    expect(alerts5.some((m) => m.includes('everything'))).toBe(false);
    expect(res.ok).toBe(false);
  });

  it('rule 5 extension: non-inventory branch in an edition composition is WARN-flagged ("add one")', async () => {
    const res = await validateRegistry(repo.dir, [GOOD]);
    const flag = res.issues.find((i) => i.rule === 5 && i.level === 'WARN' && i.message.includes('fix/candidate'));
    expect(flag).toBeDefined();
    expect(flag!.message).toContain('edition composition');
    expect(flag!.message).toContain('add one');
    // it is a WARN, not an ALERT: the branch is swept (merge source: main only)
    expect(res.alertedFeatureIds).toEqual([]);
  });

  it('rule 6: stale verified_against and old last_verified are WARNs', async () => {
    const res = await validateRegistry(
      repo.dir,
      [entry({ id: 'feat.stale6', maintenance: { verified_against: '0'.repeat(40), last_verified: '2026-01-01' } })],
      { now: new Date('2026-07-10'), staleDays: 21 },
    );
    const issues = res.issues.filter((i) => i.featureId === 'feat.stale6');
    expect(issues.map((i) => i.rule)).toEqual([6, 6]);
    expect(issues.every((i) => i.level === 'WARN')).toBe(true);
  });

  it('planned and retired entries are skipped entirely', async () => {
    const res = await validateRegistry(repo.dir, [
      { id: 'planned.x', name: 'x', kind: 'planned', status: 'planned' },
      entry({ id: 'feat.retired', status: 'retired', branch: 'feat/does-not-exist' }),
    ]);
    expect(res.issues.filter((i) => i.featureId !== null)).toEqual([]);
  });
});
