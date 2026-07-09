import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import type { MergeOutcome } from './merge.js';
import { applyRecord, recordSweep } from './record.js';
import { emptyState, readSweepLog, readSweepState } from './state.js';
import type { SweepReport } from './types.js';
import type { VerifyResult } from './verify.js';

const TIP = 'f'.repeat(40);
const STOP = 'a'.repeat(40);

function report(partial: Partial<SweepReport> = {}): SweepReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-10T12:00:00.000Z',
    repo: '/x',
    upstreamRef: 'upstream/main',
    upstreamTip: TIP,
    rangeBase: 'b'.repeat(40),
    branches: {},
    pois: [],
    warnings: [],
    ...partial,
  };
}

function outcome(partial: Partial<MergeOutcome> & { branch: string; result: MergeOutcome['result'] }): MergeOutcome {
  return { stopPoint: TIP, preRef: 'c'.repeat(40), action: 'merge', expectConflicts: [], ...partial };
}

describe('applyRecord', () => {
  it('records merged stop points, partial notes, gates, and open PoIs', () => {
    const rep = report({
      branches: {
        'feat/one': {
          branch: 'feat/one',
          clean: false,
          conflictFiles: ['src/app.ts'],
          stopPoint: STOP,
          upToDate: false,
        },
        'feat/two': { branch: 'feat/two', clean: true, conflictFiles: [], stopPoint: TIP, upToDate: false },
      },
      pois: [
        {
          id: 'merge-conflict:feat/one',
          class: 'gate',
          type: 'merge-conflict',
          paths: ['src/app.ts'],
          upstreamCommits: [TIP],
          commitSubjects: [],
          branches: ['feat/one'],
        },
      ],
    });
    const outcomes = [
      outcome({ branch: 'feat/two', result: 'merged', newRef: 'd'.repeat(40), rerereResolved: ['src/poll.ts'] }),
      outcome({ branch: 'feat/one', result: 'merged', stopPoint: STOP }),
      outcome({ branch: 'feat/gated', result: 'gated', unresolved: ['x.ts'] }),
    ];
    const next = applyRecord(emptyState(), { report: rep, outcomes });

    expect(next.branches['feat/two'].lastMergedUpstream).toBe(TIP);
    expect(next.branches['feat/two'].notes).toBe('');
    expect(next.branches['feat/one'].lastMergedUpstream).toBe(STOP);
    expect(next.branches['feat/one'].notes).toContain('partial');
    expect(next.branches['feat/gated'].notes).toContain('gated');

    const ids = next.openPois.map((p) => p.id);
    expect(ids).toContain('merge-conflict:feat/one');
    expect(ids).toContain(`rerere-replay:feat/two@${TIP.slice(0, 12)}`);
    const rerere = next.openPois.find((p) => p.type === 'rerere-replay')!;
    expect(rerere.class).toBe('annotate');
    expect(rerere.paths).toEqual(['src/poll.ts']);

    expect(next.lastSweep).toEqual({ id: rep.generatedAt, upstreamTip: TIP, result: 'partial' });
  });

  it('clean sweep -> result clean; verify failure demotes the offender to a test-fail gate', () => {
    const cleanRep = report({
      branches: { 'feat/two': { branch: 'feat/two', clean: true, conflictFiles: [], stopPoint: TIP, upToDate: false } },
    });
    const merged = [outcome({ branch: 'feat/two', result: 'merged' })];
    expect(applyRecord(emptyState(), { report: cleanRep, outcomes: merged }).lastSweep?.result).toBe('clean');

    const verify: VerifyResult = { ok: false, build: { ok: true, merged: [] }, commands: [], offender: 'feat/two' };
    const next = applyRecord(emptyState(), { report: cleanRep, outcomes: merged, verify });
    expect(next.lastSweep?.result).toBe('partial');
    expect(next.branches['feat/two'].lastMergedUpstream).toBeNull(); // rolled back
    const gate = next.openPois.find((p) => p.type === 'test-fail')!;
    expect(gate.class).toBe('gate');
    expect(gate.branches).toEqual(['feat/two']);
  });

  it('is idempotent for already-tracked PoIs', () => {
    const rep = report({
      pois: [
        {
          id: 'dep-change:package.json',
          class: 'annotate',
          type: 'dep-change',
          paths: ['package.json'],
          upstreamCommits: [TIP],
          commitSubjects: [],
          branches: [],
        },
      ],
    });
    const once = applyRecord(emptyState(), { report: rep });
    const twice = applyRecord(once, { report: rep });
    expect(twice.openPois).toHaveLength(1);
  });
});

describe('recordSweep (state-branch integration)', () => {
  const repo = initFixtureRepo();
  afterAll(() => repo.destroy());

  it('commits state + journal + archived report in one commit on the state branch', async () => {
    const rep = report();
    const { state, commit } = await recordSweep(repo.dir, 'maint/fork-registry', {
      report: rep,
      outcomes: [outcome({ branch: 'feat/two', result: 'merged' })],
      extraFiles: { 'sweep-state/rr-cache/aa11/preimage': 'x\n' },
    });
    expect(state.lastSweep?.upstreamTip).toBe(TIP);
    expect(repo.sha('maint/fork-registry')).toBe(commit);

    const reread = await readSweepState(repo.dir, 'maint/fork-registry');
    expect(reread).toEqual(state);
    const log = await readSweepLog(repo.dir, 'maint/fork-registry');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'record', result: 'clean', merged: ['feat/two'] });

    const files = repo.git('ls-tree', '-r', '--name-only', 'maint/fork-registry');
    expect(files).toContain('sweep-state/reports/2026-07-10T120000.000Z.json');
    expect(files).toContain('sweep-state/rr-cache/aa11/preimage');
    expect(repo.git('branch', '--show-current')).toBe('main'); // never checked out
  });
});
