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

  it('DEFERS even when the HELD parent paths are DISJOINT (D-057 dropped path-intersection)', async () => {
    const held = [{ branch: 'main_patched', height: 0, conflictedPaths: ['src/other.ts'], caseId: 'main_patched-h0' }];
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope: {}, held });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    // main_patched is a blocked DIRECT parent at height 0; feat/p conflicts at
    // height 0 -> MIN(0) <= 0 -> DEFERRED regardless of conflicted paths.
    expect(p.parents[0].verdict).toBe('defer');
    expect(p.parents[0].deferredTo).toBe('main_patched');
    expect(p.parents[0].case).toBeNull();
  });

  it('NOT deferred (own conflict -> case) when NO direct parent is blocked', async () => {
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope: {}, held: [] });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    expect(p.parents[0].verdict).toBe('case');
    expect(p.parents[0].deferredTo).toBeNull();
    expect(p.parents[0].case?.conflictedPaths).toEqual(['src/x.ts']);
  });
});

// --- merge_status views in derivation (D-057) ------------------------------
describe('derivePlan — mergeStatusOf (D-057: PR_ID empty interval, DEFERRED sticky)', () => {
  // Same fixture as the DEFERRED wiring above: feat/p conflicts vs main_patched at h0.
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

  it('a PR_ID branch arrives with an EMPTY interval (skip rows, no probes act)', async () => {
    const plan = await derivePlan({
      repo: repo.dir,
      upstreamRef: 'main',
      base,
      features,
      scope: {},
      mergeStatusOf: new Map([['feat/p', 'PR_ID']]),
    });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    expect(p.parents.every((pp) => pp.verdict === 'skip' && pp.skipReason === 'held')).toBe(true);
  });

  it('STICKY: a DEFERRED branch behind a blocked parent forces defer EVEN when the height-MIN would not (STAY ≠ BECOME)', async () => {
    // main_patched is PR_ID-blocked but contributes NO height (no held record),
    // so the BECOME height-MIN alone would emit a case; the sticky STAY rule is
    // independent of height and keeps the branch deferred.
    const plan = await derivePlan({
      repo: repo.dir,
      upstreamRef: 'main',
      base,
      features,
      scope: {},
      held: [],
      mergeStatusOf: new Map([
        ['main_patched', 'PR_ID'],
        ['feat/p', 'DEFERRED'],
      ]),
    });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    expect(p.parents[0].verdict).toBe('defer');
    expect(p.parents[0].deferredTo).toBe('main_patched');
    expect(p.parents[0].case).toBeNull();
    expect(p.parents[0].deferHeight).toBe(0); // live-probed: its children's height-MIN input
    expect(p.parents[0].mergePoint).toBeNull(); // takes NOTHING while sticky
  });

  it('CLEARED view: a DEFERRED branch whose parents are all NONE derives normally (re-merge fresh → own case)', async () => {
    const plan = await derivePlan({
      repo: repo.dir,
      upstreamRef: 'main',
      base,
      features,
      scope: {},
      mergeStatusOf: new Map([['feat/p', 'DEFERRED']]), // parent main_patched is NONE
    });
    const p = plan.branches.find((b) => b.branch === 'feat/p')!;
    expect(p.parents[0].verdict).toBe('case'); // fresh re-merge hits its own conflict → own PR
    expect(p.parents[0].deferredTo).toBeNull();
  });
});

// --- §6 un-skip vs blocked branches (D-057) --------------------------------
describe('derivePlan — un-skip never merges into/through a blocked branch (D-057)', () => {
  // leaf feat/l -> feat/d -> entry main_patched. main_patched is PR_ID-blocked
  // (which keeps feat/d sticky-DEFERRED); U0 gives the pass progress so the
  // leaf un-skip rule fires — but its only chain runs through blocked hops.
  const repo = initFixtureRepo();
  const base = repo.sha('main');
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.checkout('feat/d', { create: true, at: 'main_patched' });
  repo.checkout('feat/l', { create: true, at: 'feat/d' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  afterAll(() => repo.destroy());

  const features: FeatureEntry[] = [
    { id: 'd', name: 'd', kind: 'feat', status: 'shipped', branch: 'feat/d', parents: ['main_patched'] },
    { id: 'l', name: 'l', kind: 'feat', status: 'shipped', branch: 'feat/l', parents: ['feat/d'] },
  ];

  it('aborts the un-skip instead of force-merging a DEFERRED intermediate hop', async () => {
    const plan = await derivePlan({
      repo: repo.dir,
      upstreamRef: 'main',
      base,
      features,
      scope: {},
      mergeStatusOf: new Map([
        ['main_patched', 'PR_ID'],
        ['feat/d', 'DEFERRED'],
      ]),
    });
    const d = plan.branches.find((b) => b.branch === 'feat/d')!;
    const l = plan.branches.find((b) => b.branch === 'feat/l')!;
    expect(l.isLeaf).toBe(true);
    // The blocked intermediate must NOT be force-merged (it takes NOTHING
    // while merge_status != NONE)...
    expect(d.parents[0].verdict).not.toBe('merge');
    expect(d.parents[0].forced ?? false).toBe(false);
    // ...and the leaf's un-skip is aborted outright (no chain avoids the block).
    expect(l.unskipChain ?? null).toBeNull();
    expect(l.parents[0].forced ?? false).toBe(false);
    expect(l.parents[0].verdict).toBe('up-to-date');
  });

  it('shortestUnskipChain skips blocked hops explicitly', () => {
    const edges = { 'feat/l': ['feat/d'], 'feat/d': ['main_patched'] };
    const entry = new Set(['main_patched']);
    expect(shortestUnskipChain('feat/l', edges, entry)).toEqual(['feat/l', 'feat/d', 'main_patched']);
    expect(shortestUnskipChain('feat/l', edges, entry, new Set(['feat/d']))).toEqual([]);
  });
});

// --- annotate-class detection (§1 D-002, SPEC 2) --------------------------
describe('derivePlan — annotate-class (clean merge THROUGH a HELD-ancestor height)', () => {
  // feat/c (coverage -1) merges main_patched cleanly to height 0; main_patched
  // is a transitive ancestor recorded HELD at height 0 (within the merge window).
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  const base = repo.sha('main');
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.checkout('feat/c', { create: true, at: 'main_patched' }); // cut BEFORE the merge -> coverage -1
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  repo.checkout('main_patched');
  repo.git('merge', '--no-edit', '-m', 'main_patched merges U0', 'main'); // main_patched covers h0
  repo.checkout('main');
  afterAll(() => repo.destroy());

  const features: FeatureEntry[] = [
    { id: 'c', name: 'c', kind: 'feat', status: 'shipped', branch: 'feat/c', parents: ['main_patched'] },
  ];

  it('flags annotate when a HELD ancestor height lies in the merge window', async () => {
    const held = [{ branch: 'main_patched', height: 0, conflictedPaths: ['src/x.ts'], caseId: 'mp' }];
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope: {}, held });
    const c = plan.branches.find((b) => b.branch === 'feat/c')!;
    expect(c.parents[0].verdict).toBe('merge');
    expect(c.parents[0].annotate).toEqual({ heldAncestor: 'main_patched', height: 0 });
  });

  it('no annotate when the HELD ancestor height is outside the merge window', async () => {
    const held = [{ branch: 'main_patched', height: 5, conflictedPaths: ['src/x.ts'], caseId: 'mp' }];
    const plan = await derivePlan({ repo: repo.dir, upstreamRef: 'main', base, features, scope: {}, held });
    const c = plan.branches.find((b) => b.branch === 'feat/c')!;
    expect(c.parents[0].verdict).toBe('merge');
    expect(c.parents[0].annotate ?? null).toBeNull();
  });
});
