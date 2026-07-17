import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import {
  allParentsSkipped,
  derivePlan,
  findLeaves,
  plansEquivalent,
  shortestUnskipChain,
  transitiveAncestors,
} from './plan.js';
import type { BranchPlan, FeatureEntry, SweepScope } from './types.js';

describe('plan pure helpers', () => {
  const edges = { 'feat/b': ['feat/a'], 'feat/a': ['main_patched'], 'feat/c': ['feat/a'] };

  it('transitiveAncestors closes over the parent graph', () => {
    const a = transitiveAncestors(edges);
    expect(new Set(a['feat/b'])).toEqual(new Set(['feat/a', 'main_patched']));
    expect(new Set(a['feat/a'])).toEqual(new Set(['main_patched']));
  });

  it('findLeaves = branches that are nobody’s parent', () => {
    const leaves = findLeaves(['feat/a', 'feat/b', 'feat/c'], edges);
    expect(leaves).toEqual(new Set(['feat/b', 'feat/c']));
  });

  it('shortestUnskipChain hops to the nearest entry point', () => {
    const entry = new Set(['main_patched']);
    expect(shortestUnskipChain('feat/b', edges, entry)).toEqual(['feat/b', 'feat/a', 'main_patched']);
    expect(shortestUnskipChain('main_patched', edges, entry)).toEqual(['main_patched']);
  });

  it('allParentsSkipped is true only when every parent no-op’d', () => {
    const mk = (verdicts: string[]): BranchPlan => ({
      branch: 'x',
      kind: 'inventory',
      tierFloor: 'clean',
      isLeaf: true,
      alwaysMerge: false,
      ancestors: [],
      parents: verdicts.map((v) => ({
        parent: 'p',
        model: 'parents',
        mergePoint: null,
        verdict: v as never,
        case: null,
        deferredTo: null,
        skipReason: null,
      })),
    });
    expect(allParentsSkipped(mk(['skip', 'up-to-date']))).toBe(true);
    expect(allParentsSkipped(mk(['skip', 'merge']))).toBe(false);
    expect(allParentsSkipped(mk(['case']))).toBe(false);
  });
});

// --- entry-model derivation: non-monotonic window surfaces a case ---------
describe('derivePlan — entry model, non-monotonic case (§3)', () => {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  const base = repo.sha('main');
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
  repo.commit('U2: x = fork', { 'src/x.ts': 'fork\n' });
  repo.commit('U3: x = up3', { 'src/x.ts': 'up3\n' });
  afterAll(() => repo.destroy());

  it('merges past the intermediate conflict and reports the smallest conflict above', async () => {
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features: [], scope: {} });
    expect(plan.order).toEqual(['main_patched']);
    const mp = plan.branches[0];
    expect(mp.parents[0].verdict).toBe('merge');
    expect(mp.parents[0].mergePoint?.height).toBe(2);
    expect(mp.parents[0].case?.head.height).toBe(3);
    expect(mp.parents[0].case?.conflictedPaths).toEqual(['src/x.ts']);
  });

  it('is idempotent: re-derivation on unchanged git state matches', async () => {
    const a = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features: [], scope: {} });
    const b = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features: [], scope: {} });
    expect(plansEquivalent(a, b)).toBe(true);
  });
});

// --- parents-model DAG: barrier ordering + tier floor ---------------------
describe('derivePlan — DAG barrier ordering + tier floor', () => {
  const repo = initFixtureRepo();
  const base = repo.sha('main');
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.checkout('feat/a', { create: true, at: 'main_patched' });
  repo.commit('feat/a: own file', { 'src/a.ts': 'a\n' });
  repo.checkout('feat/b', { create: true, at: 'feat/a' });
  repo.commit('feat/b: own file', { 'src/b.ts': 'b\n' });
  repo.checkout('edition/z', { create: true, at: 'main_patched' });
  repo.commit('edition/z: own', { 'src/z.ts': 'z\n' });
  repo.checkout('main');
  repo.commit('U0: upstream', { 'src/u.ts': 'u\n' });
  afterAll(() => repo.destroy());

  const features: FeatureEntry[] = [
    { id: 'a', name: 'a', kind: 'feat', status: 'shipped', branch: 'feat/a', parents: ['main_patched'] },
    { id: 'b', name: 'b', kind: 'feat', status: 'shipped', branch: 'feat/b', parents: ['feat/a'] },
    { id: 'z', name: 'z', kind: 'edition', status: 'shipped', branch: 'edition/z', parents: ['main_patched'] },
  ];
  const scope: SweepScope = {};

  it('orders parents before children (breadth-wise) and floors edition/* at judged', async () => {
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope });
    const idx = (b: string) => plan.order.indexOf(b);
    expect(idx('main_patched')).toBeLessThan(idx('feat/a'));
    expect(idx('feat/a')).toBeLessThan(idx('feat/b'));
    const edition = plan.branches.find((b) => b.branch === 'edition/z')!;
    expect(edition.tierFloor).toBe('judged');
    const mp = plan.branches.find((b) => b.branch === 'main_patched')!;
    expect(mp.parents[0].verdict).toBe('merge'); // entry merges the new upstream commit
  });
});

// --- DEFERRED wiring in the plan (§5) -------------------------------------
describe('derivePlan — DEFERRED to a HELD ancestor', () => {
  // main_patched already merged U0 (prior pass); feat/p carries a conflicting
  // x-edit, so it conflicts against main_patched at height 0.
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  const base = repo.sha('main');
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.checkout('feat/p', { create: true, at: 'main_patched' });
  repo.commit('feat/p: x = P', { 'src/x.ts': 'P\n' });
  repo.checkout('main');
  repo.commit('U0: x = up0', { 'src/x.ts': 'up0\n' });
  repo.checkout('main_patched');
  repo.git('merge', '--no-edit', '-m', 'main_patched merges U0', 'main');
  repo.checkout('main');
  afterAll(() => repo.destroy());

  const features: FeatureEntry[] = [
    { id: 'p', name: 'p', kind: 'feat', status: 'shipped', branch: 'feat/p', parents: ['main_patched'] },
  ];

  it('DEFERRED when the conflict height + paths match the HELD ancestor', async () => {
    const held = [{ branch: 'main_patched', height: 0, conflictedPaths: ['src/x.ts'], caseId: 'main_patched-h0' }];
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope: {}, held });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    expect(p.parents[0].verdict).toBe('defer');
    expect(p.parents[0].deferredTo).toBe('main_patched');
    expect(p.parents[0].case).toBeNull(); // DEFERRED emits NO case / PR
  });

  it('NOT deferred (own conflict -> case) when the HELD ancestor paths are disjoint', async () => {
    const held = [{ branch: 'main_patched', height: 0, conflictedPaths: ['src/other.ts'], caseId: 'main_patched-h0' }];
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope: {}, held });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    expect(p.parents[0].verdict).toBe('case');
    expect(p.parents[0].deferredTo).toBeNull();
    expect(p.parents[0].case?.conflictedPaths).toEqual(['src/x.ts']);
  });
});
