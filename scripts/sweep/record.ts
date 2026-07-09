/**
 * scripts/sweep/record.ts — stage 7: fold a sweep's artifacts back into the
 * authoritative state on the state branch.
 *
 * Inputs are the stage artifacts (sweep-report.json, merge outcomes, verify
 * result); output is one commit on the state branch updating
 * sweep-state.json, appending sweep-log.jsonl and archiving the report.
 */
import type { MergeOutcome } from './merge.js';
import { defaultBranchState, readSweepState, reportArchivePath, writeSweepState } from './state.js';
import type { SweepReport, SweepState } from './types.js';
import type { VerifyResult } from './verify.js';

export interface RecordInputs {
  report: SweepReport;
  outcomes?: MergeOutcome[];
  verify?: VerifyResult;
  /** Extra files to commit alongside (e.g. rr-cache export from the merge stage). */
  extraFiles?: Record<string, string | Buffer>;
}

export function applyRecord(state: SweepState, inputs: RecordInputs): SweepState {
  const { report, outcomes, verify } = inputs;
  const next: SweepState = JSON.parse(JSON.stringify(state)) as SweepState;

  for (const o of outcomes ?? []) {
    const bs = (next.branches[o.branch] ??= defaultBranchState());
    if (o.result === 'merged' && o.stopPoint) {
      bs.lastMergedUpstream = o.stopPoint;
      const fullyMerged = o.stopPoint === report.upstreamTip;
      bs.notes = fullyMerged ? '' : `partial: stopped at ${o.stopPoint.slice(0, 12)} (conflict beyond)`;
    } else if (o.result === 'gated') {
      bs.notes = `gated: unresolved conflicts in ${(o.unresolved ?? []).join(', ')}`;
    } else if (o.result === 'dirty-worktree') {
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
          upstreamCommits: [o.stopPoint!],
          state: 'open',
          pr: null,
        });
      }
    }
  }
  // Verify failure: offender was rolled back; demote to gate-PoI (case 4).
  if (verify && !verify.ok && verify.offender) {
    const bs = (next.branches[verify.offender] ??= defaultBranchState());
    bs.notes = 'verify failed: rolled back, demoted to gate (test-fail)';
    if (bs.lastMergedUpstream === report.upstreamTip) bs.lastMergedUpstream = null;
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

export async function recordSweep(
  repo: string,
  stateBranch: string,
  inputs: RecordInputs,
): Promise<{ state: SweepState; commit: string }> {
  const prev = await readSweepState(repo, stateBranch);
  const state = applyRecord(prev, inputs);
  const commit = await writeSweepState(
    repo,
    stateBranch,
    state,
    {
      action: 'record',
      sweepId: state.lastSweep!.id,
      upstreamTip: state.lastSweep!.upstreamTip,
      result: state.lastSweep!.result,
      merged: (inputs.outcomes ?? []).filter((o) => o.result === 'merged').map((o) => o.branch),
      gated: (inputs.outcomes ?? []).filter((o) => o.result === 'gated').map((o) => o.branch),
    },
    {
      [reportArchivePath(state.lastSweep!.id)]: JSON.stringify(inputs.report, null, 2) + '\n',
      ...(inputs.extraFiles ?? {}),
    },
    `sweep: record ${state.lastSweep!.id} (${state.lastSweep!.result})`,
  );
  return { state, commit };
}
