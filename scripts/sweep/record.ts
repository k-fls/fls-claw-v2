/**
 * scripts/sweep/record.ts — stage 7: fold a sweep's artifacts into the
 * group-owned workspace (no git commits, no state branch).
 *
 * Inputs are the stage artifacts (sweep-report.json, merge outcomes, verify
 * result); outputs are plain files in the workspace: the ledger JSON, an
 * appended sweep-log.jsonl row, the archived report under reports/, and any
 * new rerere resolutions under rr-cache/. lastMergedUpstream is NOT written
 * anywhere — it is derived (git merge-base) whenever needed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RR_CACHE_DIRNAME } from './config.js';
import { appendSweepLog, defaultLedgerBranch, readLedger, reportArchivePath, writeLedger } from './ledger.js';
import { writeRrCacheDir, type MergeOutcome } from './merge.js';
import type { Ledger, SweepReport } from './types.js';
import type { VerifyResult } from './verify.js';

export interface RecordInputs {
  report: SweepReport;
  outcomes?: MergeOutcome[];
  verify?: VerifyResult;
  /** New rerere resolutions from the merge stage (relative rr-cache paths). */
  rrCacheExport?: Record<string, Buffer>;
}

export function applyRecord(ledger: Ledger, inputs: RecordInputs): Ledger {
  const { report, outcomes, verify } = inputs;
  const next: Ledger = JSON.parse(JSON.stringify(ledger)) as Ledger;

  for (const o of outcomes ?? []) {
    if (o.result === 'merged' && o.stopPoint) {
      const fullyMerged = o.stopPoint === report.upstreamTip;
      if (!fullyMerged) {
        const bs = (next.branches[o.branch] ??= defaultLedgerBranch());
        bs.notes = `partial: stopped at ${o.stopPoint.slice(0, 12)} (conflict beyond)`;
      } else if (next.branches[o.branch]) {
        next.branches[o.branch].notes = '';
      }
    } else if (o.result === 'gated') {
      const bs = (next.branches[o.branch] ??= defaultLedgerBranch());
      bs.notes = `gated: unresolved conflicts in ${(o.unresolved ?? []).join(', ')}`;
    } else if (o.result === 'dirty-worktree') {
      const bs = (next.branches[o.branch] ??= defaultLedgerBranch());
      bs.notes = 'skipped: checked-out worktree was dirty';
    }
  }

  // Open PoIs: report PoIs (gate + annotate) that aren't already tracked.
  const known = new Set(next.openPois.map((p) => p.id));
  for (const poi of report.pois) {
    if (known.has(poi.id)) continue;
    next.openPois.push({
      id: poi.id,
      class: poi.class,
      type: poi.type,
      paths: poi.paths,
      branches: poi.branches,
      upstreamCommits: poi.upstreamCommits,
      state: 'open',
      pr: null,
    });
  }
  // rerere replays become annotate-PoIs.
  for (const o of outcomes ?? []) {
    if (o.result === 'merged' && (o.rerereResolved?.length ?? 0) > 0) {
      const id = `rerere-replay:${o.branch}@${report.upstreamTip.slice(0, 12)}`;
      if (!known.has(id)) {
        next.openPois.push({
          id,
          class: 'annotate',
          type: 'rerere-replay',
          paths: o.rerereResolved!,
          branches: [o.branch],
          // upstream-chain merges point at the stop point; parent merges at the merged source tips
          upstreamCommits: o.stopPoint ? [o.stopPoint] : (o.mergedSources ?? []),
          state: 'open',
          pr: null,
        });
      }
    }
  }
  // Verify failure: offender was rolled back; demote to gate-PoI (case 4).
  if (verify && !verify.ok && verify.offender) {
    const bs = (next.branches[verify.offender] ??= defaultLedgerBranch());
    bs.notes = 'verify failed: rolled back, demoted to gate (test-fail)';
    const id = `test-fail:${verify.offender}@${report.upstreamTip.slice(0, 12)}`;
    if (!next.openPois.some((p) => p.id === id)) {
      next.openPois.push({
        id,
        class: 'gate',
        type: 'test-fail',
        paths: [],
        branches: [verify.offender],
        upstreamCommits: [report.upstreamTip],
        state: 'open',
        pr: null,
      });
    }
  }

  const gated =
    (outcomes ?? []).some((o) => o.result === 'gated' || o.result === 'dirty-worktree') ||
    Object.values(report.branches).some((b) => !b.clean) ||
    (verify !== undefined && !verify.ok);
  const anyMerged = (outcomes ?? []).some((o) => o.result === 'merged');
  next.lastSweep = {
    id: report.generatedAt,
    upstreamTip: report.upstreamTip,
    result: !gated ? 'clean' : anyMerged ? 'partial' : 'blocked',
  };
  return next;
}

export interface RecordResult {
  ledger: Ledger;
  ledgerPath: string;
  reportPath: string;
  rrCacheFiles: number;
}

/** Write ledger + journal + archived report (+ rr-cache export) into the workspace. */
export function recordSweep(workspace: string, ledgerPath: string, inputs: RecordInputs): RecordResult {
  const prev = readLedger(ledgerPath);
  const ledger = applyRecord(prev, inputs);
  writeLedger(ledgerPath, ledger);

  const reportPath = reportArchivePath(workspace, ledger.lastSweep!.id);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(inputs.report, null, 2) + '\n');

  const rrCacheFiles = inputs.rrCacheExport
    ? writeRrCacheDir(join(workspace, RR_CACHE_DIRNAME), inputs.rrCacheExport)
    : 0;

  appendSweepLog(workspace, {
    action: 'record',
    sweepId: ledger.lastSweep!.id,
    upstreamTip: ledger.lastSweep!.upstreamTip,
    result: ledger.lastSweep!.result,
    merged: (inputs.outcomes ?? []).filter((o) => o.result === 'merged').map((o) => o.branch),
    gated: (inputs.outcomes ?? []).filter((o) => o.result === 'gated').map((o) => o.branch),
    reportPath,
  });
  return { ledger, ledgerPath, reportPath, rrCacheFiles };
}
