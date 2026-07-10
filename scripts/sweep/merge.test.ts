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
  return branches.map((branch) => ({ branch, stopPoint: upstreamTip, upToDate: false }));
}

describe('planMerges', () => {
  it('classifies protected / frozen / up-to-date / clean / conflicting targets', async () => {
    const ledger = ledgerWith({
      'feat/gated': { status: 'frozen', frozenBy: 'PR #7', pendingBehindFreeze: 1, notes: '' },
    });
    const plan = await planMerges(
      repo.dir,
      [
        { branch: 'main', stopPoint: upstreamTip, upToDate: false },
        { branch: 'everything', stopPoint: upstreamTip, upToDate: false },
        { branch: 'feat/gated', stopPoint: upstreamTip, upToDate: false },
        { branch: 'feat/clean', stopPoint: null, upToDate: true },
        { branch: 'feat/replay-me', stopPoint: null, upToDate: false },
        { branch: 'feat/clean', stopPoint: upstreamTip, upToDate: false },
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

describe('rollbackBranch', () => {
  it('resets a merged branch to its recorded pre-merge ref', async () => {
    const outcome = {
      branch: 'feat/clean',
      stopPoint: upstreamTip,
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
