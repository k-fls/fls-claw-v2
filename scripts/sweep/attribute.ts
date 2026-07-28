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
import { globMatchAny } from './globs.js';
import { branchHierarchy, byHierarchy, depthOf, minPathOf, TRUNK_BRANCH, type Hierarchy } from './hierarchy.js';
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

/** A branch implicated in a failure, with why and how deep it sits. */
export interface BranchCandidate {
  branch: string;
  id: string;
  /** From the ONE hierarchy (hierarchy.ts). Null = no route to the root. */
  depth: number | null;
  /** Shortest parent chain to the root, excluding `main`. */
  minPath: string[] | null;
  /** `owned` beats `touched` — an owner is the intended home of the path. */
  match: 'owned' | 'touched';
}

function pathMatches(patterns: string[] | undefined, file: string): boolean {
  // GLOB semantics, via the driver's existing helper (routing.ts and
  // validate.ts already use it). These fields are gitignore-style globs and the
  // live inventory is full of `scripts/sweep/**`-shaped patterns; the literal
  // prefix test this replaced could never match one, so blame silently found no
  // owner and fell back to the accused branch (defect 5).
  return globMatchAny(patterns ?? [], file);
}

/**
 * Every branch implicated by the failing files, ordered by the OWNER RULE:
 * shallowest hierarchy depth first (UNRESOLVED last, never as 0), `owned` before
 * `touched` at equal depth. Name order is applied ONLY to make the listing
 * stable — it is never a decision, see `attributeFailure`.
 *
 * The TRUNK is always a candidate when it matches: the defect is frequently on
 * `main_patched` itself (live 2026-07-28 — fcee39ea), and excluding it
 * guarantees a wrong answer in exactly the case the base gate exists to catch.
 */
export function branchCandidates(files: string[], features: FeatureEntry[], h?: Hierarchy): BranchCandidate[] {
  const hier = h ?? branchHierarchy(features);
  const out = new Map<string, BranchCandidate>();
  const consider = (branch: string, id: string, owned: boolean, touched: boolean): void => {
    if (!owned && !touched) return;
    const cand: BranchCandidate = {
      branch,
      id,
      depth: depthOf(hier, branch),
      minPath: minPathOf(hier, branch),
      match: owned ? 'owned' : 'touched',
    };
    const prior = out.get(branch);
    if (!prior || (cand.depth !== null && (prior.depth === null || cand.depth < prior.depth))) out.set(branch, cand);
  };
  for (const f of features) {
    if (!f.branch) continue;
    consider(
      f.branch,
      f.id,
      files.some((file) => pathMatches(f.owned_paths, file)),
      files.some((file) => pathMatches(f.touch_paths, file)),
    );
  }
  const trunk = features.find((f) => f.branch === TRUNK_BRANCH);
  if (!out.has(TRUNK_BRANCH) && trunk) {
    consider(
      TRUNK_BRANCH,
      trunk.id,
      files.some((file) => pathMatches(trunk.owned_paths, file)),
      files.some((file) => pathMatches(trunk.touch_paths, file)),
    );
  }
  const order = byHierarchy(hier);
  return [...out.values()].sort(
    (a, b) => order(a.branch, b.branch) || (a.match === b.match ? 0 : a.match === 'owned' ? -1 : 1),
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
 * REFUSES rather than guesses. There is no arbitrary tie-break: when the top two
 * candidates are indistinguishable on BOTH real signals (hierarchy depth and
 * owned-vs-touched), this returns `branch: null` and names the tied candidates.
 * The previous version fell through to `localeCompare` and then reported
 * "earliest by hierarchy" — a decision made by spelling, described as a rule.
 * Determinism is only ever used for ORDERING the reported list.
 */
export function attributeFailure(
  output: string,
  features: FeatureEntry[],
  accused?: string | null,
): Attribution {
  const files = parseFailingFiles(output);
  if (files.length === 0) {
    return {
      branch: accused ?? null,
      files,
      candidates: [],
      reason: 'no file paths in the output — fell back to the branch verify accused',
    };
  }
  const candidates = branchCandidates(files, features);
  if (candidates.length === 0) {
    return {
      branch: accused ?? null,
      files,
      candidates,
      reason: 'no registry entry owns or touches the failing files — fell back to the branch verify accused',
    };
  }
  const [first, second] = candidates;
  const indistinguishable = second && second.depth === first.depth && second.match === first.match;
  if (indistinguishable) {
    const tied = candidates.filter((c) => c.depth === first.depth && c.match === first.match).map((c) => c.branch);
    return {
      branch: null,
      files,
      candidates,
      reason: `${tied.length} branches tie on hierarchy depth ${first.depth ?? 'UNRESOLVED'} and on ${first.match} — cannot attribute (${tied.join(', ')})`,
    };
  }
  return {
    branch: first.branch,
    files,
    candidates,
    reason:
      candidates.length === 1
        ? `${first.branch} ${first.match} the failing path(s)`
        : `${candidates.length} branches implicated; picked ${first.branch} — earliest by hierarchy (depth ${first.depth ?? 'UNRESOLVED'} via ${(first.minPath ?? []).join(' <- ') || 'main'})`,
  };
}
