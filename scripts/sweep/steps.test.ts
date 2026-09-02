import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initFixtureRepo, makePropagationFixture } from './fixtures.js';
import { newStyleMergeTree } from './git.js';
import { enumerateChain, type Chain } from './heights.js';
import { allParentsSkipped, deriveBranch, type DeriveBranchArgs } from './plan.js';
import { buildStepFile, verifyStepFile } from './steps.js';
import type { StepFile, StepVerifyContext } from './steps.js';
import { WHOLE_RANGE_BLOCK, type BranchPlan } from './types.js';

const { repo, base, chain } = makePropagationFixture();
let c: Chain;
let ctx: StepVerifyContext;
let goodTree: string;
afterAll(() => repo.destroy());

beforeAll(async () => {
  c = await enumerateChain(repo.dir, 'upstream-main', base);
  ctx = { chain: c, branchTip: repo.sha('fork'), arrivedParents: new Set(), passHasProgress: true };
  goodTree = (await newStyleMergeTree(repo.dir, repo.sha('fork'), chain[0])).treeOid;
});

function goodStep(): StepFile {
  return {
    schemaVersion: 1,
    branch: 'fork',
    watermark: c.watermark,
    legalParents: ['main'],
    requiredParents: [],
    isLeaf: false,
    alwaysMerge: false,
    // Height 0 (U0 adds util.ts) is a clean, real merge into fork.
    merges: [
      {
        parent: 'main',
        model: 'entry',
        action: 'merge',
        head: { sha: chain[0], height: 0 },
        prefix: [{ sha: chain[0], autoResolved: [] }],
        tree: goodTree,
        skipReason: null,
      },
    ],
  };
}

describe('verifyStepFile — accepts a well-formed step', () => {
  it('passes first-principles verification', async () => {
    const r = await verifyStepFile(repo.dir, goodStep(), ctx);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('verifyStepFile — rejects forged / hand-edited inputs (§7)', () => {
  it('rejects a forged head sha that does not match the claimed height', async () => {
    const step = goodStep();
    step.merges[0].head = { sha: chain[1], height: 0 }; // sha at height 1, claimed 0
    step.merges[0].prefix = [{ sha: chain[1], autoResolved: [] }];
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/chain index != claimed height 0/);
  });

  it('rejects a merge row with no landed prefix', async () => {
    const step = goodStep();
    delete step.merges[0].prefix;
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/names no landed prefix/);
  });

  it('rejects a forged landed tree — the replay recomputes it from first principles', async () => {
    const step = goodStep();
    step.merges[0].tree = '0'.repeat(40);
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/claimed tree 000000000000 != replayed tree/);
  });

  it('rejects a prefix commit that is not a trunk chain commit (entry model)', async () => {
    const step = goodStep();
    step.merges[0].prefix = [{ sha: ctx.branchTip, autoResolved: [] }, { sha: chain[0], autoResolved: [] }];
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/is not a trunk chain commit/);
  });

  it('rejects a forged parent not in the legal parent set', async () => {
    const step = goodStep();
    step.merges[0].parent = 'evil/branch';
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/illegal parent 'evil\/branch'/);
  });

  it('rejects a forged height beyond the watermark chain', async () => {
    const step = goodStep();
    step.merges[0].head = { sha: chain[0], height: 99 };
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/height 99 out of range/);
  });

  it('rejects a bogus skip claim (merge-tree would change the branch tree)', async () => {
    const step = goodStep();
    step.merges[0] = {
      parent: 'main',
      model: 'entry',
      action: 'skip',
      head: { sha: chain[0], height: 0 },
      skipReason: 'no-op',
    };
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/claims no-op but merge-tree changes/);
  });

  it('rejects when a required parent has not arrived (barrier)', async () => {
    const step = goodStep();
    step.requiredParents = ['feat/not-yet'];
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/required parent 'feat\/not-yet' has not arrived/);
  });

  it('rejects a step whose watermark is not this pass', async () => {
    const step = goodStep();
    step.watermark = '0'.repeat(40);
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/!= pass watermark/);
  });
});

// --- the step's reason slot carries the PARENT-LEVEL answer ---------------
//
// Per-commit window enumeration makes "merge point below, conflict above" the
// normal shape of a parent, so a parent whose merge point is a tree-identical
// no-op can still end as a `case` or a `defer`. The step file must say which:
// the leaf / always_merge rule reads the reason alone, and 'no-op' tells it a
// blocked branch merely had nothing to take.
describe('buildStepFile — the skip reason is the parent-level answer', () => {
  // THE DIAMOND. feat/leaf has two parents and already carries `src/a.ts =
  // shared` because it grew out of feat/p2; feat/p1 arrives at the same content
  // by its own commit (a tree-identical, clean merge point) and then diverges
  // on `src/x.ts` (a genuine conflict above it). feat/p2 has nothing left to
  // give, so no real merge can land and the leaf rule is live.
  const repo = initFixtureRepo();
  repo.commit('base: x + a', { 'src/x.ts': 'orig\n', 'src/a.ts': 'orig\n' });
  const base = repo.sha('main');
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.checkout('feat/p2', { create: true, at: 'main_patched' });
  repo.commit('feat/p2: a = shared', { 'src/a.ts': 'shared\n' });
  repo.checkout('feat/leaf', { create: true, at: 'feat/p2' });
  repo.commit('feat/leaf: x = leaf', { 'src/x.ts': 'leaf\n' });
  repo.checkout('feat/p1', { create: true, at: 'main_patched' });
  repo.commit('feat/p1: a = shared', { 'src/a.ts': 'shared\n' }); // tree-identical arrival
  repo.commit('feat/p1: x = p1', { 'src/x.ts': 'p1\n' }); // conflicts with the leaf
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // the pass carries progress
  afterAll(() => repo.destroy());

  const leafArgs = (chain: Chain): DeriveBranchArgs => ({
    repo: repo.dir,
    branch: 'feat/leaf',
    kind: 'inventory',
    model: 'parents',
    parents: ['feat/p1', 'feat/p2'],
    chain,
    ancestors: ['feat/p1', 'feat/p2', 'main_patched'],
    tierFloor: 'clean',
    isLeaf: true,
    alwaysMerge: false,
  });

  async function leafCtx(chain: Chain): Promise<StepVerifyContext> {
    return {
      chain,
      branchTip: repo.sha('feat/leaf'),
      arrivedParents: new Set(['feat/p1', 'feat/p2']),
      passHasProgress: true,
    };
  }

  it('a conflict above a no-op merge point is reported as conflict-pending', async () => {
    const chain = await enumerateChain(repo.dir, 'main', base);
    const bp = await deriveBranch(leafArgs(chain));
    const p1 = bp.parents.find((p) => p.parent === 'feat/p1')!;
    // The tree-identical prefix is a no-op: nothing lands, and the parent's
    // answer is the conflict above it.
    expect(p1.mergePoint).toBeNull();
    expect(p1.case?.conflictedPaths).toEqual(['src/x.ts']);
    expect(p1.verdict).toBe('case');

    const step = buildStepFile(bp, chain.watermark);
    const m1 = step.merges.find((m) => m.parent === 'feat/p1')!;
    expect(m1.action).toBe('skip');
    expect(m1.skipReason).toBe('conflict-pending');
    expect(p1.skipReason).toBeNull(); // the parent's answer is `case`, not the merge point's shape
  });

  it('the leaf/always_merge rule exempts a branch blocked on that conflict instead of halting it', async () => {
    const chain = await enumerateChain(repo.dir, 'main', base);
    const step = buildStepFile(await deriveBranch(leafArgs(chain)), chain.watermark);
    const r = await verifyStepFile(repo.dir, step, await leafCtx(chain));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('the same conflict deferred behind a blocked parent is reported as deferred', async () => {
    const chain = await enumerateChain(repo.dir, 'main', base);
    const bp = await deriveBranch({
      ...leafArgs(chain),
      blockHeightOf: new Map([['feat/p2', WHOLE_RANGE_BLOCK]]),
    });
    const p1 = bp.parents.find((p) => p.parent === 'feat/p1')!;
    expect(p1.verdict).toBe('defer');
    expect(p1.deferredTo).toBe('feat/p2');
    expect(p1.skipReason).toBeNull(); // 'no-op' must not leak into a defer

    const step = buildStepFile(bp, chain.watermark);
    expect(reasonFor(step, 'feat/p1')).toBe('deferred');

    const r = await verifyStepFile(repo.dir, step, await leafCtx(chain));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('an up-to-date parent names itself in the reason, matching how the journal reads it', async () => {
    const chain = await enumerateChain(repo.dir, 'main', base);
    const bp = await deriveBranch(leafArgs(chain));
    const p2 = bp.parents.find((p) => p.parent === 'feat/p2')!;
    expect(p2.verdict).toBe('up-to-date');
    expect(reasonFor(buildStepFile(bp, chain.watermark), 'feat/p2')).toBe('up-to-date');
  });

  // PASSES BEFORE THE FIX TOO — the guard is that the plain no-op path is
  // untouched: a merge point that no-ops with nothing above it still reports
  // 'no-op', still counts as "every parent no-op'd", and the build-time
  // vocabulary assertion does not fire on it.
  it('a plain no-op merge point still reports no-op and still feeds the un-skip pass', async () => {
    const chain = await enumerateChain(repo.dir, 'main', base);
    // feat/p1 minus its conflicting top: a tree-identical arrival and nothing more.
    repo.git('update-ref', 'refs/heads/feat/p1-noop', repo.sha('feat/p1^'));
    const bp = await deriveBranch({
      ...leafArgs(chain),
      parents: ['feat/p1-noop'],
      ancestors: ['feat/p1-noop', 'main_patched'],
    });
    const pp = bp.parents[0];
    expect(pp.verdict).toBe('skip');
    expect(pp.skipReason).toBe('no-op');
    expect(allParentsSkipped(bp)).toBe(true);

    const step = buildStepFile(bp, chain.watermark); // must NOT throw
    expect(step.merges[0].skipReason).toBe('no-op');
  });

  /** An all-skip leaf plan whose parents carry exactly these reasons. */
  const allSkipLeaf = (reasons: Array<string | null>): BranchPlan => ({
    branch: 'feat/leaf',
    kind: 'inventory',
    tierFloor: 'clean',
    isLeaf: true,
    alwaysMerge: false,
    ancestors: [],
    parents: reasons.map((skipReason, i) => ({
      parent: `feat/p${i}`,
      model: 'parents',
      mergePoint: null,
      verdict: 'skip',
      case: null,
      deferredTo: null,
      skipReason,
    })),
  });

  it('an all-skip leaf step whose reasons are in neither vocabulary is refused at build time', () => {
    expect(() => buildStepFile(allSkipLeaf(['invented']), c.watermark)).toThrow(
      /unclassified skip reason\(s\).*invented/s,
    );
  });

  it('one stray reason among no-ops is refused too — the leaf rule would read the row as a plain no-op', () => {
    // A single classified reason cannot vouch for the rest: these rows reach the
    // leaf rule as "every parent no-op'd" and halt the branch with the generic
    // string, which is the very shape the assertion exists to catch. Only a
    // BLOCKED reason sanctions a step outright; short of that, EVERY reason must
    // be un-skip input.
    // The offending list ends at the em dash, so matching it proves the message
    // names 'bogus' ALONE — 'no-op' is classified and is not an offender.
    expect(() => buildStepFile(allSkipLeaf(['no-op', 'bogus']), c.watermark)).toThrow(
      /unclassified skip reason\(s\) on an all-skip leaf\/always_merge step: bogus —/,
    );
    // A blocked reason still sanctions the step, unknowns beside it included.
    expect(() => buildStepFile(allSkipLeaf(['conflict-pending', 'bogus']), c.watermark)).not.toThrow();
  });
});

function reasonFor(step: StepFile, parent: string): string | null {
  return step.merges.find((m) => m.parent === parent)!.skipReason;
}
