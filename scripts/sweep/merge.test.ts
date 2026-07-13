import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { revParse } from './git.js';
import { executeMerges, exportRrCache, planMerges, rollbackBranch, writeRrCacheDir } from './merge.js';
import { emptyLedger } from './ledger.js';
import type { Ledger } from './types.js';

// Workspace rr-cache dir (the shared rerere cache is a plain directory now).
const RR_DIR = join(mkdtempSync(join(tmpdir(), 'sweep-rr-')), 'rr-cache');
const repo = initFixtureRepo();
afterAll(() => {
  rmSync(join(RR_DIR, '..'), { recursive: true, force: true });
  repo.destroy();
});

const CONFLICT_EDIT = 'export const app = () => 1;\nexport const shared = "fork-side";\n';
const RESOLUTION = 'export const app = () => 1;\nexport const shared = "merged-both";\n';

// Three fork branches with the IDENTICAL conflicting edit (rerere replay needs
// byte-identical conflict hunks) + one clean branch.
for (const b of ['feat/resolved-once', 'feat/replay-me', 'feat/gated']) {
  repo.checkout(b, { create: true, at: 'main' });
  repo.commit(`${b}: same-line edit`, { 'src/app.ts': CONFLICT_EDIT });
  repo.checkout('main');
}
repo.checkout('feat/clean', { create: true, at: 'main' });
repo.commit('clean addition', { 'src/clean.ts': 'export const c = 1;\n' });
repo.checkout('main');
repo.git('branch', 'everything', 'main'); // protected target for planMerges

repo.checkout('upstream-main', { create: true, at: 'main' });
repo.commit('upstream: same-line edit', {
  'src/app.ts': 'export const app = () => 1;\nexport const shared = "upstream-side";\n',
});
repo.checkout('main');
const upstreamTip = repo.sha('upstream-main');

function ledgerWith(branches: Ledger['branches']): Ledger {
  return { ...emptyLedger(), branches };
}

async function targetsFor(...branches: string[]) {
  return branches.map((branch) => ({
    branch,
    mergeModel: 'upstream-chain' as const,
    stopPoint: upstreamTip,
    parents: [],
    upToDate: false,
  }));
}

function chainTarget(branch: string, opts: { stopPoint?: string | null; upToDate?: boolean } = {}) {
  return {
    branch,
    mergeModel: 'upstream-chain' as const,
    stopPoint: opts.stopPoint === undefined ? upstreamTip : opts.stopPoint,
    parents: [],
    upToDate: opts.upToDate ?? false,
  };
}

function parentTarget(branch: string, parents: string[]) {
  return { branch, mergeModel: 'parents' as const, stopPoint: null, parents, upToDate: false };
}

describe('planMerges', () => {
  it('classifies protected / frozen / up-to-date / clean / conflicting targets', async () => {
    const ledger = ledgerWith({
      'feat/gated': { status: 'frozen', frozenBy: 'PR #7', pendingBehindFreeze: 1, notes: '' },
    });
    const plan = await planMerges(
      repo.dir,
      [
        chainTarget('main'),
        chainTarget('everything'),
        chainTarget('feat/gated'),
        chainTarget('feat/clean', { stopPoint: null, upToDate: true }),
        chainTarget('feat/replay-me', { stopPoint: null }),
        chainTarget('feat/clean'),
      ],
      ledger,
    );
    expect(plan.map((p) => p.action)).toEqual([
      'skip-protected',
      'skip-protected',
      'skip-frozen',
      'up-to-date',
      'skip-no-stop-point',
      'merge',
    ]);
    const cleanItem = plan[5];
    expect(cleanItem.method).toBe('commit-tree'); // clean + not checked out
    expect(cleanItem.expectConflicts).toEqual([]);
  });

  it('routes conflicting merges through a worktree', async () => {
    const plan = await planMerges(repo.dir, await targetsFor('feat/replay-me'), emptyLedger());
    expect(plan[0].method).toBe('worktree');
    expect(plan[0].expectConflicts).toEqual(['src/app.ts']);
  });
});

describe('executeMerges', () => {
  it('clean merge on a non-checked-out branch uses plumbing only', async () => {
    const pre = await revParse(repo.dir, 'feat/clean');
    const plan = await planMerges(repo.dir, await targetsFor('feat/clean'), emptyLedger());
    const { outcomes } = await executeMerges(repo.dir, plan, RR_DIR);
    expect(outcomes[0].result).toBe('merged');
    expect(outcomes[0].preRef).toBe(pre);
    expect(outcomes[0].newRef).toBe(await revParse(repo.dir, 'feat/clean'));
    expect(outcomes[0].newRef).not.toBe(pre);
    expect(repo.git('status', '--porcelain')).toBe(''); // main worktree untouched
  });

  it('gates a conflicting merge with no rerere resolution and leaves the ref alone', async () => {
    const pre = await revParse(repo.dir, 'feat/gated');
    const plan = await planMerges(repo.dir, await targetsFor('feat/gated'), emptyLedger());
    const { outcomes } = await executeMerges(repo.dir, plan, RR_DIR);
    expect(outcomes[0].result).toBe('gated');
    expect(outcomes[0].unresolved).toEqual(['src/app.ts']);
    expect(await revParse(repo.dir, 'feat/gated')).toBe(pre);
  });

  it('replays a recorded rerere resolution and reports it as rerere-replay material', async () => {
    // 1. Resolve the conflict once, by hand, with rerere recording enabled.
    repo.checkout('feat/resolved-once');
    let failed = false;
    try {
      repo.git('-c', 'rerere.enabled=true', 'merge', '--no-edit', 'upstream-main');
    } catch {
      failed = true; // conflict expected
    }
    expect(failed).toBe(true);
    writeFileSync(join(repo.dir, 'src/app.ts'), RESOLUTION);
    repo.git('add', 'src/app.ts');
    repo.git('-c', 'rerere.enabled=true', 'commit', '--no-edit', '--no-verify');
    repo.checkout('main');

    // 2. Export the recorded resolution to the workspace rr-cache directory.
    const rrFiles = await exportRrCache(repo.dir, {});
    expect(Object.keys(rrFiles).length).toBeGreaterThan(0);
    expect(writeRrCacheDir(RR_DIR, rrFiles)).toBe(Object.keys(rrFiles).length);

    // 3. Fresh-clone simulation: drop the local rerere cache.
    rmSync(join(repo.dir, '.git/rr-cache'), { recursive: true, force: true });
    expect(existsSync(join(repo.dir, '.git/rr-cache'))).toBe(false);

    // 4. The sweep now merges the second branch with the same conflict.
    const plan = await planMerges(repo.dir, await targetsFor('feat/replay-me'), emptyLedger());
    const { outcomes } = await executeMerges(repo.dir, plan, RR_DIR);
    expect(outcomes[0].result).toBe('merged');
    expect(outcomes[0].rerereResolved).toEqual(['src/app.ts']);
    expect(repo.git('show', 'feat/replay-me:src/app.ts')).toBe(RESOLUTION.trim());
  });

  it('skips a dirty checked-out worktree instead of merging over WIP', async () => {
    repo.checkout('feat/gated'); // check it out in the main fixture worktree
    writeFileSync(join(repo.dir, 'src/app.ts'), 'dirty WIP\n');
    const plan = await planMerges(repo.dir, await targetsFor('feat/gated'), emptyLedger());
    expect(plan[0].method).toBe('worktree');
    expect(plan[0].worktree).toBe(repo.dir);
    const { outcomes } = await executeMerges(repo.dir, plan, RR_DIR);
    expect(outcomes[0].result).toBe('dirty-worktree');
    repo.git('checkout', '--', 'src/app.ts');
    repo.checkout('main');
  });
});

describe('parent-merge model (2026-07-14 merge-source correction)', () => {
  // Dedicated DAG fixture: main -> main_patched -> module/parent -> feat/child.
  const dag = initFixtureRepo();
  afterAll(() => dag.destroy());

  dag.checkout('main_patched', { create: true, at: 'main' });
  dag.commit('shared fix', { 'src/patch.ts': 'export const patch = 1;\n' });
  dag.checkout('module/parent', { create: true, at: 'main_patched' });
  dag.commit('parent edit on shared line', {
    'src/app.ts': 'export const app = () => 1;\nexport const shared = "parent";\n',
  });
  dag.checkout('feat/child', { create: true, at: 'module/parent' });
  dag.commit('child-only file', { 'src/child.ts': 'export const c = 1;\n' });
  dag.checkout('main');
  dag.checkout('upstream-main', { create: true, at: 'main' });
  const u1 = dag.commit('U1: docs only', { 'docs/u1.md': 'u1\n' });
  dag.checkout('main');

  const targets = (stopPoint: string) => [
    { branch: 'main_patched', mergeModel: 'upstream-chain' as const, stopPoint, parents: [], upToDate: false },
    {
      branch: 'module/parent',
      mergeModel: 'parents' as const,
      stopPoint: null,
      parents: ['main_patched'],
      upToDate: false,
    },
    {
      branch: 'feat/child',
      mergeModel: 'parents' as const,
      stopPoint: null,
      parents: ['module/parent'],
      upToDate: false,
    },
  ];

  it('children merge their PARENT tips, never upstream directly; one pass cascades upstream to the leaves', async () => {
    const { outcomes } = await executeMerges(dag.dir, await planMerges(dag.dir, targets(u1), emptyLedger()), null);
    expect(outcomes.map((o) => o.result)).toEqual(['merged', 'merged', 'merged']);
    // main_patched merged the upstream stop point...
    expect(outcomes[0].mergedSources).toEqual([`${u1}@${u1.slice(0, 12)}`]);
    // ...the parent merged main_patched's NEW tip, the child merged the parent's NEW tip.
    const mainPatchedTip = dag.sha('main_patched');
    const parentTip = dag.sha('module/parent');
    expect(outcomes[1].mergedSources).toEqual([`main_patched@${mainPatchedTip.slice(0, 12)}`]);
    expect(outcomes[2].mergedSources).toEqual([`module/parent@${parentTip.slice(0, 12)}`]);
    // The child's merge commit's second parent IS the parent branch tip — not an upstream commit.
    expect(dag.sha('feat/child^2')).toBe(parentTip);
    // Upstream content reached the leaf through the chain.
    expect(dag.git('merge-base', '--is-ancestor', u1, 'feat/child')).toBe('');
    // And the child never merged upstream-main directly (no upstream sha in its sources).
    expect(outcomes[2].mergedSources!.every((s) => !s.startsWith(u1.slice(0, 12)))).toBe(true);
  });

  it('inherited gating: a gated parent does not advance, so the child has nothing new to merge', async () => {
    // U2 conflicts with module/parent's shared-line edit.
    dag.checkout('upstream-main');
    const u2 = dag.commit('U2: conflicting edit', {
      'src/app.ts': 'export const app = () => 1;\nexport const shared = "upstream";\n',
    });
    dag.checkout('main');
    const childBefore = dag.sha('feat/child');
    const { outcomes } = await executeMerges(dag.dir, await planMerges(dag.dir, targets(u2), emptyLedger()), null);
    // main_patched (no edit on that line) takes U2 clean; the parent gates on it.
    expect(outcomes[0].result).toBe('merged');
    expect(outcomes[1].result).toBe('gated');
    expect(outcomes[1].unresolved).toEqual(['src/app.ts']);
    // The child saw no new parent commits: noop, ref untouched — it can never overshoot its parent.
    expect(outcomes[2].result).toBe('noop');
    expect(dag.sha('feat/child')).toBe(childBefore);
  });

  it('a conflict resolved once at the parent is INHERITED by the child without re-conflicting', async () => {
    // Resolve the U2 conflict at the topmost affected branch (module/parent).
    const RESOLUTION = 'export const app = () => 1;\nexport const shared = "parent+upstream";\n';
    dag.checkout('module/parent');
    try {
      dag.git('merge', '--no-edit', 'main_patched');
    } catch {
      // conflict expected
    }
    dag.write('src/app.ts', RESOLUTION);
    dag.git('add', 'src/app.ts');
    dag.git('commit', '--no-edit', '--no-verify');
    dag.checkout('main');
    const parentTip = dag.sha('module/parent');

    // The child scan/plan now sees a CLEAN parent merge (fan-out would re-conflict on src/app.ts).
    const plan = await planMerges(
      dag.dir,
      [{ branch: 'feat/child', mergeModel: 'parents', stopPoint: null, parents: ['module/parent'], upToDate: false }],
      emptyLedger(),
    );
    expect(plan[0].expectConflicts).toEqual([]);
    const { outcomes } = await executeMerges(dag.dir, plan, null);
    expect(outcomes[0].result).toBe('merged');
    expect(outcomes[0].rerereResolved).toEqual([]);
    expect(outcomes[0].mergedSources).toEqual([`module/parent@${parentTip.slice(0, 12)}`]);
    expect(dag.git('show', 'feat/child:src/app.ts')).toBe(RESOLUTION.trim());
  });

  it('multiple parents are merged in order in one pass', async () => {
    dag.git('branch', 'module/other', 'main_patched');
    dag.checkout('module/other');
    dag.commit('other parent file', { 'src/other.ts': 'export const o = 1;\n' });
    dag.checkout('main');
    const plan = await planMerges(
      dag.dir,
      [
        {
          branch: 'feat/child',
          mergeModel: 'parents',
          stopPoint: null,
          parents: ['module/parent', 'module/other'],
          upToDate: false,
        },
      ],
      emptyLedger(),
    );
    const { outcomes } = await executeMerges(dag.dir, plan, null);
    expect(outcomes[0].result).toBe('merged');
    // module/parent tip was already reached in the previous test -> only module/other is new.
    expect(outcomes[0].mergedSources).toEqual([`module/other@${dag.sha('module/other').slice(0, 12)}`]);
    expect(dag.git('show', 'feat/child:src/other.ts')).toBe('export const o = 1;');
  });
});

describe('rollbackBranch', () => {
  it('resets a merged branch to its recorded pre-merge ref', async () => {
    const outcome = {
      branch: 'feat/clean',
      mergeModel: 'upstream-chain' as const,
      stopPoint: upstreamTip,
      sources: [upstreamTip],
      preRef: repo.git('rev-parse', 'feat/clean^1'), // pre-merge tip (first parent)
      action: 'merge' as const,
      expectConflicts: [],
      result: 'merged' as const,
      newRef: await revParse(repo.dir, 'feat/clean'),
    };
    await rollbackBranch(repo.dir, outcome);
    expect(await revParse(repo.dir, 'feat/clean')).toBe(outcome.preRef);
  });
});
