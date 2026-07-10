import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { emptyLedger, readLedger, readSweepLog } from './ledger.js';
import type { MergeOutcome } from './merge.js';
import { applyRecord, recordSweep } from './record.js';
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
  it('records partial notes, gates, and open PoIs (no lastMergedUpstream — derived)', () => {
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
    const next = applyRecord(emptyLedger(), { report: rep, outcomes });

    // fully merged branch needs no ledger override at all
    expect(next.branches['feat/two']).toBeUndefined();
    expect(next.branches['feat/one'].notes).toContain('partial');
    expect(next.branches['feat/gated'].notes).toContain('gated');
    // ledger branches never carry lastMergedUpstream (derived via merge-base)
    expect(Object.values(next.branches).every((b) => !('lastMergedUpstream' in b))).toBe(true);

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
    expect(applyRecord(emptyLedger(), { report: cleanRep, outcomes: merged }).lastSweep?.result).toBe('clean');

    const verify: VerifyResult = { ok: false, build: { ok: true, merged: [] }, commands: [], offender: 'feat/two' };
    const next = applyRecord(emptyLedger(), { report: cleanRep, outcomes: merged, verify });
    expect(next.lastSweep?.result).toBe('partial');
    expect(next.branches['feat/two'].notes).toContain('rolled back');
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
    const once = applyRecord(emptyLedger(), { report: rep });
    const twice = applyRecord(once, { report: rep });
    expect(twice.openPois).toHaveLength(1);
  });
});

describe('recordSweep (workspace files, no git)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sweep-record-'));
  const ledgerPath = join(workspace, 'sweep-ledger.json');
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('writes ledger + journal + archived report + rr-cache into the workspace', () => {
    const rep = report();
    const { ledger, reportPath, rrCacheFiles } = recordSweep(workspace, ledgerPath, {
      report: rep,
      outcomes: [outcome({ branch: 'feat/two', result: 'merged' })],
      rrCacheExport: { 'aa11/preimage': Buffer.from('x\n') },
    });
    expect(ledger.lastSweep?.upstreamTip).toBe(TIP);
    expect(readLedger(ledgerPath)).toEqual(ledger);

    expect(reportPath).toBe(join(workspace, 'reports', '2026-07-10T120000.000Z.json'));
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).upstreamTip).toBe(TIP);

    expect(rrCacheFiles).toBe(1);
    expect(existsSync(join(workspace, 'rr-cache', 'aa11', 'preimage'))).toBe(true);

    const log = readSweepLog(workspace);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'record', result: 'clean', merged: ['feat/two'] });
  });
});
