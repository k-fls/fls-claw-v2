import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { buildScope, editionAncestorBranches } from './scope.js';
import type { FeatureEntry, ScopeEntry } from './types.js';

function entry(partial: Partial<FeatureEntry> & { id: string }): FeatureEntry {
  return { name: partial.id, kind: 'feat', status: 'shipped', ...partial } as FeatureEntry;
}

const FEATURES: FeatureEntry[] = [
  entry({ id: 'module.agc', kind: 'module', branch: 'module/agc', dependents: ['module/host-rpc', 'feat/mitm'] }),
  entry({ id: 'module.host-rpc', kind: 'module', branch: 'module/host-rpc', parents: ['module/agc'] }),
  entry({ id: 'feat.mitm', branch: 'feat/mitm', parents: ['module/host-rpc', 'module/agc'] }),
  entry({ id: 'edition.bot', kind: 'edition', branch: 'edition/bot', parents: ['feat/mitm'] }),
  entry({ id: 'planned.x', kind: 'planned', status: 'planned' }),
  entry({ id: 'feat.retired', status: 'retired', branch: 'feat/retired' }),
  entry({ id: 'feat.exp', status: 'experimental', branch: 'experimental/feat/policies' }),
];

const REPO_BRANCHES = [
  'main',
  'main_patched',
  'module/agc',
  'module/host-rpc',
  'feat/mitm',
  'edition/bot',
  'feat/unregistered',
  'everything',
  'experimental/feat/policies',
  'wip/x',
];

const names = (ordered: ScopeEntry[]) => ordered.map((e) => e.branch);
const byBranch = (ordered: ScopeEntry[]) => new Map(ordered.map((e) => [e.branch, e]));

describe('buildScope (2026-07-14 partition)', () => {
  it('orders parents before children (DAG), main_patched first', () => {
    const order = names(buildScope(FEATURES, {}, REPO_BRANCHES).ordered);
    expect(order[0]).toBe('main_patched');
    expect(order.indexOf('module/agc')).toBeLessThan(order.indexOf('module/host-rpc'));
    expect(order.indexOf('module/host-rpc')).toBeLessThan(order.indexOf('feat/mitm'));
    expect(order.indexOf('feat/mitm')).toBeLessThan(order.indexOf('edition/bot'));
  });

  it('merge sources: main_patched is upstream-chain; inventory branches merge their DAG parents; roots default to main_patched', () => {
    const scope = byBranch(buildScope(FEATURES, {}, REPO_BRANCHES).ordered);
    expect(scope.get('main_patched')).toMatchObject({ kind: 'structural', mergeModel: 'upstream-chain', parents: [] });
    // root inventory branch: parents default to [main_patched] — NEVER upstream directly
    expect(scope.get('module/agc')).toMatchObject({
      kind: 'inventory',
      mergeModel: 'parents',
      parents: ['main_patched'],
    });
    expect(scope.get('module/host-rpc')).toMatchObject({ mergeModel: 'parents', parents: ['module/agc'] });
    expect(scope.get('feat/mitm')).toMatchObject({ mergeModel: 'parents', parents: ['module/agc', 'module/host-rpc'] });
    expect(scope.get('edition/bot')).toMatchObject({ mergeModel: 'parents', parents: ['feat/mitm'] });
  });

  it('without main_patched in the repo, root inventory branches fall back to the upstream chain', () => {
    const repoBranches = REPO_BRANCHES.filter((b) => b !== 'main_patched');
    const scope = byBranch(buildScope(FEATURES, {}, repoBranches).ordered);
    expect(scope.get('module/agc')).toMatchObject({ mergeModel: 'upstream-chain', parents: [] });
    expect(scope.get('module/host-rpc')).toMatchObject({ mergeModel: 'parents', parents: ['module/agc'] });
  });

  it('excludes retired/planned entries and excluded namespaces', () => {
    const order = names(buildScope(FEATURES, {}, REPO_BRANCHES).ordered);
    expect(order).not.toContain('feat/retired');
    expect(order).not.toContain('experimental/feat/policies');
    expect(order).not.toContain('everything');
  });

  it('partitions non-inventory branches: edition-ancestors in scope (main-only source, flagged), the rest ignored', () => {
    const repoBranches = [...REPO_BRANCHES, 'fix/upstreamable', 'docs/notes', 'design/flsclaw'];
    const scope = buildScope(FEATURES, {}, repoBranches, ['fix/upstreamable']);
    const entries = byBranch(scope.ordered);
    // in an edition composition: swept, but only ever merges the upstream chain (= main)
    expect(entries.get('fix/upstreamable')).toMatchObject({
      kind: 'edition-ancestor',
      mergeModel: 'upstream-chain',
      parents: [],
    });
    expect(scope.warnings.some((w) => w.includes("'fix/upstreamable'") && w.includes('add one'))).toBe(true);
    // not in any edition composition: ignored, one drift line at most
    expect(names(scope.ordered)).not.toContain('docs/notes');
    expect(scope.ignored).toContain('docs/notes');
    // namespace-excluded branches are neither scanned nor listed as ignored
    expect(names(scope.ordered)).not.toContain('design/flsclaw');
    expect(scope.ignored).not.toContain('design/flsclaw');
    // sweepable-namespace branch without an entry: ignored + drift warning
    expect(scope.ignored).toContain('feat/unregistered');
    expect(scope.warnings.some((w) => w.includes("'feat/unregistered'") && w.includes('no inventory entry'))).toBe(
      true,
    );
  });

  it('explicit exclusions beat the edition-ancestry pass', () => {
    const repoBranches = [...REPO_BRANCHES, 'fix/channels/telegram-markdown-nesting'];
    const scope = buildScope(FEATURES, { exclude: ['fix/channels/telegram-markdown-nesting'] }, repoBranches, [
      'fix/channels/telegram-markdown-nesting',
    ]);
    expect(names(scope.ordered)).not.toContain('fix/channels/telegram-markdown-nesting');
    expect(scope.ignored).not.toContain('fix/channels/telegram-markdown-nesting');
  });

  it('drops inventory branches missing from the repo and dead parent edges with warnings', () => {
    const scope = buildScope(
      FEATURES,
      {},
      REPO_BRANCHES.filter((b) => b !== 'edition/bot'),
    );
    expect(names(scope.ordered)).not.toContain('edition/bot');
    expect(scope.warnings.some((w) => w.includes("'edition/bot'") && w.includes('missing from the repo'))).toBe(true);
  });

  it('throws on a DAG cycle', () => {
    const cyclic = [
      entry({ id: 'a', branch: 'feat/a', parents: ['feat/b'] }),
      entry({ id: 'b', branch: 'feat/b', parents: ['feat/a'] }),
    ];
    expect(() => buildScope(cyclic, {}, ['feat/a', 'feat/b'])).toThrow(/cycle/);
  });
});

describe('editionAncestorBranches', () => {
  const repo = initFixtureRepo();
  afterAll(() => repo.destroy());

  it('detects branches whose tip is contained in an edition branch', async () => {
    repo.checkout('fix/inside', { create: true, at: 'main' });
    repo.commit('upstreamable fix', { 'src/fix.ts': 'export const f = 1;\n' });
    repo.checkout('main');
    repo.checkout('docs/outside', { create: true, at: 'main' });
    repo.commit('unrelated docs', { 'docs/x.md': 'x\n' });
    repo.checkout('main');
    repo.checkout('edition/ed', { create: true, at: 'main' });
    repo.git('merge', '--no-edit', 'fix/inside');
    repo.checkout('main');

    const ancestors = await editionAncestorBranches(repo.dir);
    expect(ancestors).toContain('fix/inside');
    expect(ancestors).not.toContain('docs/outside');
    expect(ancestors).not.toContain('edition/ed'); // editions are not their own candidates
    expect(ancestors).not.toContain('main');
  });

  it('returns nothing when the repo has no edition branches', async () => {
    const bare = initFixtureRepo();
    try {
      expect(await editionAncestorBranches(bare.dir)).toEqual([]);
    } finally {
      bare.destroy();
    }
  });
});
