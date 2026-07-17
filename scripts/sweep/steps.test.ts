import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makePropagationFixture } from './fixtures.js';
import { enumerateChain, type Chain } from './heights.js';
import { verifyStepFile } from './steps.js';
import type { StepFile, StepVerifyContext } from './steps.js';

const { repo, base, chain } = makePropagationFixture();
let c: Chain;
let ctx: StepVerifyContext;
afterAll(() => repo.destroy());

beforeAll(async () => {
  c = await enumerateChain(repo.dir, 'upstream-main', base);
  ctx = { chain: c, branchTip: repo.sha('fork'), arrivedParents: new Set(), passHasProgress: true };
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
    merges: [{ parent: 'main', model: 'entry', action: 'merge', head: { sha: chain[0], height: 0 }, skipReason: null }],
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
    const r = await verifyStepFile(repo.dir, step, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/!= trunk commit at height 0/);
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
