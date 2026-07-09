/**
 * scripts/sweep/replay.ts — test-case replay harness ("the pipeline tests
 * the pipeline"). Cases live in fork-registry/test-cases/**.yaml on the
 * state branch; each pins a fork branch at a historical base commit plus
 * either an upstream range (sweep case) or a merge_source ref (fork-internal
 * propagation case), and asserts the pipeline's classification.
 *
 * Replays are ref-only: new-style merge-tree and rev-list operate on the
 * pinned commits directly, so no throwaway worktree/clone is needed (and
 * nothing can be mutated). expected.pois are subset assertions: each listed
 * object {type, paths?} must match at least one actual PoI; plain-string
 * entries are prose notes and are ignored.
 *
 * The registry taxonomy uses richer classification labels than the
 * mechanical layer can determine (agentic judgments like 'feature-overlap');
 * CLASSIFICATION_ALIASES maps them onto the mechanical clean/conflict
 * outcome, and 'excluded' cases are skipped (policy, not mechanics).
 * Unknown labels fail closed.
 */
import { newStyleMergeTree, refExists, revParse } from './git.js';
import { extractPois } from './scan.js';
import { findStopPoint } from './stop-points.js';
import type { Poi, ReplayCase, ReplayResult } from './types.js';

/** Registry-taxonomy classification -> mechanical expectation. */
const CLASSIFICATION_ALIASES: Record<string, 'clean' | 'conflict' | 'up-to-date' | 'skip'> = {
  clean: 'clean',
  conflict: 'conflict',
  'up-to-date': 'up-to-date',
  // agentic labels that still imply a textual conflict
  semantic: 'conflict',
  'semantic-collision': 'conflict',
  mixed: 'conflict',
  'agent-resolvable': 'conflict',
  'feature-overlap': 'conflict',
  'known-recurring': 'conflict',
  // textually clean, the interest lives in PoIs
  'clean-with-semantic-poi': 'clean',
  'clean-with-security-poi': 'clean',
  // policy decisions the mechanical layer cannot replay
  excluded: 'skip',
};

function parseRange(range: NonNullable<ReplayCase['upstream_range']>): { base: string; tip: string } | null {
  if (typeof range === 'object' && range !== null) {
    return range.from && range.to ? { base: range.from, tip: range.to } : null;
  }
  const m = range.match(/^(.+?)\.\.(.+)$/);
  return m ? { base: m[1], tip: m[2] } : null;
}

/** Registry conflict lists may annotate paths ("x.ts (modify/delete)"). */
function stripConflictAnnotation(path: string): string {
  return path.replace(/ \([^)]*\)$/, '');
}

export async function replayCase(repo: string, c: ReplayCase): Promise<ReplayResult> {
  const failures: string[] = [];
  const actual = {
    classification: '',
    conflicts: [] as string[],
    poiTypes: [] as string[],
    stopPoint: null as string | null,
  };

  const expectMechanical = CLASSIFICATION_ALIASES[c.expected.classification];
  if (expectMechanical === undefined) {
    return {
      caseId: c.id,
      pass: false,
      failures: [`expected.classification '${c.expected.classification}' is not a known label (fail closed)`],
      actual,
    };
  }
  if (expectMechanical === 'skip') {
    return { caseId: c.id, pass: true, skipped: true, failures: [], actual };
  }

  const range = c.upstream_range !== undefined ? parseRange(c.upstream_range) : null;
  if (!range && !c.merge_source) {
    return {
      caseId: c.id,
      pass: false,
      failures: [`case needs upstream_range (<base>..<tip> or {from, to}) or merge_source`],
      actual,
    };
  }
  const refs = [
    c.fork_base_commit || c.fork_branch,
    ...(range ? [range.base, range.tip] : []),
    ...(c.merge_source ? [c.merge_source] : []),
  ];
  for (const ref of refs) {
    if (!(await refExists(repo, ref))) {
      return { caseId: c.id, pass: false, failures: [`ref '${ref}' not found in repo`], actual };
    }
  }
  // Pin the fork side: the recorded base commit, not the live branch tip.
  const forkRef = c.fork_base_commit ? await revParse(repo, c.fork_base_commit) : c.fork_branch;

  let pois: Poi[] = [];
  if (range) {
    const sp = await findStopPoint(repo, forkRef, range.tip);
    actual.classification = sp.upToDate ? 'up-to-date' : sp.cleanAtTip ? 'clean' : 'conflict';
    actual.conflicts = sp.conflictFiles;
    actual.stopPoint = sp.stopPoint;
    pois = await extractPois(repo, range.base, range.tip);
    actual.poiTypes = pois.map((p) => p.type);
  } else {
    // Propagation case: single merge of merge_source into the pinned base.
    const mt = await newStyleMergeTree(repo, forkRef, c.merge_source!);
    actual.classification = mt.clean ? 'clean' : 'conflict';
    actual.conflicts = mt.conflictFiles;
  }

  if (actual.classification !== expectMechanical) {
    failures.push(
      `classification: expected ${c.expected.classification} (${expectMechanical}), got ${actual.classification}`,
    );
  }
  if (c.expected.conflicts) {
    const want = [...new Set(c.expected.conflicts.map(stripConflictAnnotation))].sort();
    const got = [...actual.conflicts].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      failures.push(`conflicts: expected [${want.join(', ')}], got [${got.join(', ')}]`);
    }
  }
  if (c.expected.stop_point !== undefined && range) {
    const want = c.expected.stop_point === null ? null : await revParse(repo, c.expected.stop_point);
    if (want !== actual.stopPoint) {
      failures.push(`stop_point: expected ${want ?? 'null'}, got ${actual.stopPoint ?? 'null'}`);
    }
  }
  for (const expectedPoi of c.expected.pois ?? []) {
    if (typeof expectedPoi !== 'object' || expectedPoi === null || !expectedPoi.type) continue; // prose note
    if (!range) continue; // PoI extraction is range-based; propagation cases have none
    const match = pois.find(
      (p) => p.type === expectedPoi.type && (expectedPoi.paths ?? []).every((path) => p.paths.includes(path)),
    );
    if (!match) {
      failures.push(
        `poi: expected ${expectedPoi.type}${expectedPoi.paths ? ` on [${expectedPoi.paths.join(', ')}]` : ''}, not found`,
      );
    }
  }

  return { caseId: c.id, pass: failures.length === 0, failures, actual };
}

export async function replayCases(repo: string, cases: ReplayCase[], onlyId?: string): Promise<ReplayResult[]> {
  const selected = onlyId ? cases.filter((c) => c.id === onlyId) : cases;
  const results: ReplayResult[] = [];
  for (const c of selected) results.push(await replayCase(repo, c));
  return results;
}
