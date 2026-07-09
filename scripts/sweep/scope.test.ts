import { describe, expect, it } from 'vitest';

import { buildScope } from './scope.js';
import type { FeatureEntry } from './types.js';

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

describe('buildScope', () => {
  it('orders parents before children (DAG), main_patched first', () => {
    const scope = buildScope(
      FEATURES,
      { include: ['main_patched'], extra_edges: { 'module/agc': ['main_patched'] } },
      REPO_BRANCHES,
    );
    const order = scope.ordered;
    expect(order[0]).toBe('main_patched');
    expect(order.indexOf('module/agc')).toBeLessThan(order.indexOf('module/host-rpc'));
    expect(order.indexOf('module/host-rpc')).toBeLessThan(order.indexOf('feat/mitm'));
    expect(order.indexOf('feat/mitm')).toBeLessThan(order.indexOf('edition/bot'));
  });

  it('excludes retired/planned entries and excluded namespaces', () => {
    const scope = buildScope(FEATURES, {}, REPO_BRANCHES);
    expect(scope.ordered).not.toContain('feat/retired');
    expect(scope.ordered).not.toContain('experimental/feat/policies');
    expect(scope.ordered).not.toContain('everything');
  });

  it('warns on drift both ways and drops branches missing from the repo', () => {
    const scope = buildScope(
      FEATURES,
      {},
      REPO_BRANCHES.filter((b) => b !== 'edition/bot'),
    );
    expect(scope.ordered).not.toContain('edition/bot');
    expect(scope.warnings.some((w) => w.includes("'edition/bot'") && w.includes('missing from the repo'))).toBe(true);
    // feat/unregistered exists in the repo but nothing in the registry claims it.
    expect(scope.warnings.some((w) => w.includes("'feat/unregistered'") && w.includes('not in scope'))).toBe(true);
  });

  it('honors scope excludes', () => {
    const scope = buildScope(FEATURES, { exclude: ['edition/**'] }, REPO_BRANCHES);
    expect(scope.ordered).not.toContain('edition/bot');
  });

  it('throws on a DAG cycle', () => {
    const cyclic = [
      entry({ id: 'a', branch: 'feat/a', parents: ['feat/b'] }),
      entry({ id: 'b', branch: 'feat/b', parents: ['feat/a'] }),
    ];
    expect(() => buildScope(cyclic, {}, ['feat/a', 'feat/b'])).toThrow(/cycle/);
  });

  it('registry-derived edges survive into the result', () => {
    const scope = buildScope(FEATURES, {}, REPO_BRANCHES);
    expect(scope.edges['feat/mitm']).toEqual(['module/agc', 'module/host-rpc']);
    expect(scope.edges['module/host-rpc']).toEqual(['module/agc']);
  });
});
