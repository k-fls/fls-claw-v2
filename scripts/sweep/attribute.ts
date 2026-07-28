/**
 * scripts/sweep/attribute.ts — D-061 (B): blame a failing build on a BRANCH.
 *
 * `finish`'s verify can go red with no clean attribution: the offender is not a
 * branch the pass mutated, so the driver halts and asks a human to go fix
 * something (live 2026-07-28 — verify accused `feat/mitm-credential-proxy`
 * while the defect was in `src/command-gate.ts`, owned by `module/command-gate`
 * and inherited from the trunk). To turn that halt into a fixable case, the
 * driver first has to know WHICH BRANCH the fix belongs on.
 *
 * Two signals, in order:
 *  1. the failing FILE PATHS, parsed out of the checks output;
 *  2. the REGISTRY: which feature owns/touches those paths.
 *
 * OWNER RULE (2026-07-28): when a file implicates SEVERAL branches, pick the
 * EARLIEST ONE BY HIERARCHY — the shallowest entry in the parents DAG. The fix
 * lands closest to the root and propagates down to every descendant, instead of
 * being applied N times on N leaves (or on a leaf that never reaches its
 * siblings).
 */
import type { FeatureEntry } from './types.js';

/** A `tsc` diagnostic in either the bracket or the colon form. */
const TSC_BRACKET = /^(?:\s*)([\w./@-]+\.[cm]?tsx?)\((\d+),(\d+)\):\s*error\s+TS\d+/;
const TSC_COLON = /^(?:\s*)([\w./@-]+\.[cm]?tsx?):(\d+):(\d+)\s*-\s*error\s+TS\d+/;
/** A vitest file-level failure: ` FAIL  src/x.test.ts [ src/x.test.ts ]`. */
const VITEST_FAIL = /^\s*FAIL\s+([\w./@-]+\.[cm]?tsx?)/;

/**
 * The distinct source files named by a failing checks run, first-seen order.
 * Typecheck output is parsed reliably; test output is best-effort (a runner is
 * free to print whatever it likes), which is why an empty result must fall back
 * rather than guess.
 */
export function parseFailingFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split('\n')) {
    const m = TSC_BRACKET.exec(line) ?? TSC_COLON.exec(line) ?? VITEST_FAIL.exec(line);
    if (!m) continue;
    const f = m[1].replace(/^\.\//, '');
    if (!files.includes(f)) files.push(f);
  }
  return files;
}

/**
 * Depth of an entry in the `parents` DAG — 0 for a root (no parents), otherwise
 * 1 + the MINIMUM parent depth (the shortest route to a root, so a branch that
 * also has a deep parent is not pushed down by it). Cycle-safe and memoized: a
 * malformed registry must not hang the driver, so a node already on the current
 * path contributes no depth.
 */
export function hierarchyDepth(features: FeatureEntry[], id: string): number {
  const byId = new Map(features.map((f) => [f.id, f]));
  const memo = new Map<string, number>();
  const walk = (cur: string, seen: Set<string>): number => {
    const cached = memo.get(cur);
    if (cached !== undefined) return cached;
    const entry = byId.get(cur);
    const parents = (entry?.parents ?? []).filter((p) => byId.has(p) && !seen.has(p));
    if (parents.length === 0) {
      memo.set(cur, 0);
      return 0;
    }
    const next = new Set(seen).add(cur);
    const d = 1 + Math.min(...parents.map((p) => walk(p, next)));
    memo.set(cur, d);
    return d;
  };
  return walk(id, new Set([id]));
}

/** A branch implicated in a failure, with why and how deep it sits. */
export interface BranchCandidate {
  branch: string;
  id: string;
  depth: number;
  /** `owned` beats `touched` — an owner is the intended home of the path. */
  match: 'owned' | 'touched';
}

function pathMatches(patterns: string[] | undefined, file: string): boolean {
  return (patterns ?? []).some((p) => {
    const clean = p.replace(/\/+$/, '');
    return file === clean || file.startsWith(clean + '/');
  });
}

/**
 * Every registry branch implicated by the failing files, sorted by the OWNER
 * RULE: shallowest hierarchy depth first, `owned` before `touched` at equal
 * depth, then branch name so the choice is deterministic across runs.
 */
export function branchCandidates(files: string[], features: FeatureEntry[]): BranchCandidate[] {
  const out = new Map<string, BranchCandidate>();
  for (const f of features) {
    if (!f.branch) continue;
    const owned = files.some((file) => pathMatches(f.owned_paths, file));
    const touched = files.some((file) => pathMatches(f.touch_paths, file));
    if (!owned && !touched) continue;
    const cand: BranchCandidate = {
      branch: f.branch,
      id: f.id,
      depth: hierarchyDepth(features, f.id),
      match: owned ? 'owned' : 'touched',
    };
    const prior = out.get(f.branch);
    if (!prior || cand.depth < prior.depth) out.set(f.branch, cand);
  }
  return [...out.values()].sort(
    (a, b) =>
      a.depth - b.depth ||
      (a.match === b.match ? 0 : a.match === 'owned' ? -1 : 1) ||
      a.branch.localeCompare(b.branch),
  );
}

/** Where a gate-fix should be rooted, and how that was decided. */
export interface Attribution {
  branch: string | null;
  files: string[];
  candidates: BranchCandidate[];
  reason: string;
}

/**
 * Attribute a failing checks run to the branch a fix belongs on.
 *
 * Falls back to `accused` (the branch verify rolled back) ONLY when the registry
 * yields nothing — an explicit "could not attribute" is far better than a
 * confident wrong branch, because a gate-fix case rooted on the wrong branch
 * gives the agent files it has no business editing.
 */
export function attributeFailure(
  output: string,
  features: FeatureEntry[],
  accused?: string | null,
): Attribution {
  const files = parseFailingFiles(output);
  if (files.length === 0) {
    return { branch: accused ?? null, files, candidates: [], reason: 'no file paths in the output — fell back to the branch verify accused' };
  }
  const candidates = branchCandidates(files, features);
  if (candidates.length === 0) {
    return { branch: accused ?? null, files, candidates, reason: 'no registry entry owns or touches the failing files — fell back to the branch verify accused' };
  }
  const pick = candidates[0];
  const tied = candidates.filter((c) => c.depth === pick.depth).length;
  return {
    branch: pick.branch,
    files,
    candidates,
    reason:
      candidates.length === 1
        ? `${pick.branch} ${pick.match} the failing path(s)`
        : `${candidates.length} branches implicated; picked ${pick.branch} — earliest by hierarchy (depth ${pick.depth}${tied > 1 ? `, ${pick.match} wins the tie` : ''})`,
  };
}
