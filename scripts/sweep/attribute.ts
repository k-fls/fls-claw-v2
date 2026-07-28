/**
 * scripts/sweep/attribute.ts — D-061 (B): blame a failing build on a BRANCH.
 *
 * `finish`'s verify can go red with no clean attribution: the offender is not a
 * branch the pass mutated, so the driver halts and asks a human to go fix
 * something (live 2026-07-28 — verify accused `feat/mitm-credential-proxy`
 * while the defect was in `src/command-gate.ts`). To turn that halt into a
 * fixable case, the driver first has to know WHICH BRANCH the fix belongs on.
 *
 * GIT HISTORY IS THE EVIDENCE — NOT THE REGISTRY (owner-approved 2026-07-28).
 * -------------------------------------------------------------------------
 * Blame used to match the failing paths against the registry's `owned_paths` /
 * `touch_paths`. On the LIVE registry that answer is simply wrong. For the real
 * failure (`src/command-gate.ts`) FOUR entries declare the file in their paths —
 * `module/command-gate`, `feat/ops-registry`, `module/agent-group-contributions`,
 * `edition/fls-ai-bot` — and NOT ONE of them has ever modified it; meanwhile the
 * branch that actually carries the defect is the fork trunk `main_patched`
 * (6 own commits over that file, hierarchy depth 1), which is not a candidate at
 * all under declarations because no inventory entry claims the trunk.
 * Declarations are aspirational — they say where a feature INTENDS to live. Git
 * history says who actually wrote the line that broke. Blame uses history:
 *
 *     own_touches(branch, file) = git rev-list --count <branch> ^<parents> -- <file>
 *
 * A branch is a candidate for a file iff it has own commits touching it, i.e.
 * commits reachable from the branch but from NONE of its inventory parents (for
 * the trunk, the exclusion is `main`) — everything else it merely inherited.
 *
 * OWNER RULE: when several branches carry own commits over a file, pick the
 * SHALLOWEST by hierarchy depth (hierarchy.ts is the one source of depth). The
 * fix lands closest to the root and propagates down to every descendant instead
 * of being applied N times on N leaves. No candidate at all -> the TRUNK: an
 * untouched file that fails is either inherited from upstream or broken by the
 * trunk itself, and the trunk is the only place a fix reaches everyone. A TIE at
 * the shallowest depth is REFUSED, never broken by spelling.
 *
 * `owned_paths`/`touch_paths` are untouched elsewhere (routing.ts, validate.ts
 * still score and validate with them) — they simply no longer decide blame.
 */
import { git } from './git.js';
import {
  branchHierarchy,
  byHierarchy,
  depthOf,
  minPathOf,
  ROOT_BRANCH,
  TRUNK_BRANCH,
  type Hierarchy,
} from './hierarchy.js';
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
 * rather than guess. PURE — no git, no fs: the paths arrive already re-rooted
 * per command cwd (`rootChecksOutput`).
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

/** A branch whose OWN history touches a failing file, with why and how deep it sits. */
export interface BranchCandidate {
  branch: string;
  /** Entry id when the branch comes from the inventory; '' for the trunk. */
  id: string;
  /** From the ONE hierarchy (hierarchy.ts). Null = no route to the root. */
  depth: number | null;
  /** Shortest parent chain to the root, excluding `main`. */
  minPath: string[] | null;
  /** `git rev-list --count <branch> ^<parents> -- <file>` — always > 0 here. */
  commits: number;
}

/**
 * Resolve a branch NAME to something git can read: the local ref, else the
 * remote-tracking one (D-045 §13 — an inventory branch may legitimately exist
 * only as `origin/<branch>`). Null when neither exists, which is not an error:
 * a planned entry simply has no history to blame. Cached — the same 27 branches
 * are resolved once per failing file otherwise.
 */
async function resolveRef(repo: string, branch: string, cache: Map<string, string | null>): Promise<string | null> {
  const hit = cache.get(branch);
  if (hit !== undefined) return hit;
  let ref: string | null = null;
  for (const candidate of [branch, `origin/${branch}`]) {
    const res = await git(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      allowCodes: [1, 128],
    });
    if (res.code === 0) {
      ref = candidate;
      break;
    }
  }
  cache.set(branch, ref);
  return ref;
}

/**
 * Commits reachable from `ref` but from NONE of `parentRefs`, limited to `file`.
 * That is the branch's OWN work on that file: what it merged in from a parent is
 * the parent's to answer for, which is exactly what makes the shallowest
 * candidate the right place to fix.
 */
async function ownTouches(repo: string, ref: string, parentRefs: string[], file: string): Promise<number> {
  const res = await git(repo, ['rev-list', '--count', ref, ...parentRefs.map((p) => `^${p}`), '--', file], {
    allowCodes: [1, 128],
  });
  if (res.code !== 0) return 0;
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per failing file, every branch whose own history touches it — ordered by the
 * OWNER RULE (shallowest hierarchy depth first; UNRESOLVED last, never as 0).
 * Name order is applied ONLY to make the listing stable; it is never a decision,
 * see `attributeFailure`.
 *
 * EVERY branch in the hierarchy is examined, INCLUDING the trunk `main_patched`:
 * the defect is frequently on the trunk itself (live 2026-07-28 — 6 own commits
 * over `src/command-gate.ts`), and no inventory entry carries `branch:
 * main_patched`, so an inventory-only scan guarantees a wrong answer in exactly
 * the case that matters most. `main` is excluded: it is upstream, not ours to fix.
 *
 * A branch whose own ref, or ANY of whose parent refs, cannot be resolved is
 * SKIPPED rather than counted with the missing exclusion dropped — subtracting
 * fewer parents inflates the count with inherited commits, which would blame a
 * leaf for its ancestor's work.
 */
export async function blameCandidates(
  repo: string,
  files: string[],
  features: FeatureEntry[],
  h?: Hierarchy,
): Promise<Map<string, BranchCandidate[]>> {
  const hier = h ?? branchHierarchy(features);
  const order = byHierarchy(hier);
  const refs = new Map<string, string | null>();
  const byFile = new Map<string, BranchCandidate[]>(files.map((f) => [f, []]));
  for (const node of hier.byBranch.values()) {
    if (node.branch === ROOT_BRANCH) continue;
    const ref = await resolveRef(repo, node.branch, refs);
    if (!ref) continue;
    // The exclusion set. A branch with no declared parents is a registry gap
    // (hierarchy reports it UNRESOLVED); excluding the TRUNK is the honest
    // reading — every fork branch descends from it — where excluding nothing
    // would credit the branch with the whole of main's history.
    const declared =
      node.parents.length > 0 ? node.parents : [node.branch === TRUNK_BRANCH ? ROOT_BRANCH : TRUNK_BRANCH];
    const parentRefs: string[] = [];
    let resolvable = true;
    for (const p of declared) {
      const pref = await resolveRef(repo, p, refs);
      if (!pref) {
        resolvable = false;
        break;
      }
      parentRefs.push(pref);
    }
    if (!resolvable) continue;
    for (const file of files) {
      const commits = await ownTouches(repo, ref, parentRefs, file);
      if (commits === 0) continue;
      byFile.get(file)!.push({
        branch: node.branch,
        id: node.id ?? '',
        depth: depthOf(hier, node.branch),
        minPath: minPathOf(hier, node.branch),
        commits,
      });
    }
  }
  for (const list of byFile.values()) list.sort((a, b) => order(a.branch, b.branch));
  return byFile;
}

/** Where ONE failing file's fix belongs, and how that was decided. */
export interface FileBlame {
  file: string;
  /** Null ONLY on a refused tie — never a guess. */
  branch: string | null;
  candidates: BranchCandidate[];
  reason: string;
}

/** One gate-fix's worth of blame: a branch and the failing files that are its. */
export interface BlameGroup {
  branch: string;
  depth: number | null;
  files: string[];
  candidates: BranchCandidate[];
  reason: string;
}

/** Where gate-fixes should be rooted, and how that was decided. */
export interface Attribution {
  files: string[];
  /** Per-file blame, input order. */
  perFile: FileBlame[];
  /** BATCHED: one group per attributed branch, SHALLOWEST BRANCH FIRST. */
  groups: BlameGroup[];
  /** Files refused (a tie at the shallowest depth) — no group carries them. */
  unattributable: FileBlame[];
  /** The shallowest attributed branch, or null when nothing could be blamed. */
  branch: string | null;
  /** Union of every candidate seen, ordered by hierarchy — for the journal. */
  candidates: BranchCandidate[];
  reason: string;
}

/** Blame one file: shallowest candidate wins, no candidate -> trunk, tie -> refuse. */
function blameFile(file: string, candidates: BranchCandidate[]): FileBlame {
  if (candidates.length === 0) {
    // Nobody's own commits touch it: inherited from upstream, or broken by the
    // trunk's own merge of upstream. Either way the trunk is where a fix reaches
    // every branch, and it is the ONE place that is never someone else's work.
    return {
      file,
      branch: TRUNK_BRANCH,
      candidates,
      reason: `no branch has own commits touching ${file} — attributed to the trunk ${TRUNK_BRANCH}`,
    };
  }
  const first = candidates[0];
  const tied = candidates.filter((c) => c.depth === first.depth);
  if (tied.length > 1) {
    // Indistinguishable on the ONE real signal. The previous version fell
    // through to `localeCompare` and then reported "earliest by hierarchy" — a
    // decision made by spelling, described as a rule. Determinism orders the
    // listing; it never decides.
    return {
      file,
      branch: null,
      candidates,
      reason: `${tied.length} branches tie on hierarchy depth ${first.depth ?? 'UNRESOLVED'} for ${file} — cannot attribute (${tied.map((c) => c.branch).join(', ')})`,
    };
  }
  return {
    file,
    branch: first.branch,
    candidates,
    reason:
      candidates.length === 1
        ? `${first.branch} is the only branch with own commits touching ${file} (${first.commits})`
        : `${candidates.length} branches carry own commits touching ${file}; picked ${first.branch} — shallowest by hierarchy (depth ${first.depth ?? 'UNRESOLVED'} via ${(first.minPath ?? []).join(' <- ') || 'main'}, ${first.commits} commit(s))`,
  };
}

/**
 * Attribute a failing checks run to the branch(es) a fix belongs on, BATCHED:
 * one group per branch carrying that branch's failing files, shallowest branch
 * first. A judged trunk fix plus the reopen it triggers can moot a descendant's
 * case entirely, so the trunk has to be workable before its descendants.
 *
 * Git-dependent (see the header) and therefore async: `repo` is the clone whose
 * history is the evidence. `accused` — the branch verify pointed at — is used
 * ONLY when the output named no files at all; it is a report of what was being
 * built, not evidence about who broke it.
 */
export async function attributeFailure(
  repo: string,
  output: string,
  features: FeatureEntry[],
  accused?: string | null,
): Promise<Attribution> {
  const files = parseFailingFiles(output);
  if (files.length === 0) {
    return {
      files,
      perFile: [],
      groups: [],
      unattributable: [],
      branch: accused ?? null,
      candidates: [],
      reason: 'no file paths in the output — fell back to the branch verify accused',
    };
  }
  const hier = branchHierarchy(features);
  const order = byHierarchy(hier);
  const byFile = await blameCandidates(repo, files, features, hier);
  const perFile = files.map((f) => blameFile(f, byFile.get(f) ?? []));

  const grouped = new Map<string, FileBlame[]>();
  for (const b of perFile) {
    if (!b.branch) continue;
    const list = grouped.get(b.branch) ?? [];
    list.push(b);
    grouped.set(b.branch, list);
  }
  const groups: BlameGroup[] = [...grouped.entries()]
    .map(([branch, blames]) => ({
      branch,
      depth: depthOf(hier, branch),
      files: blames.map((b) => b.file),
      candidates: blames.flatMap((b) => b.candidates).filter((c) => c.branch === branch),
      reason: blames.map((b) => b.reason).join('; '),
    }))
    .sort((a, b) => order(a.branch, b.branch));
  const unattributable = perFile.filter((b) => !b.branch);

  const seen = new Map<string, BranchCandidate>();
  for (const b of perFile) for (const c of b.candidates) if (!seen.has(c.branch)) seen.set(c.branch, c);
  const candidates = [...seen.values()].sort((a, b) => order(a.branch, b.branch));

  const summary = groups
    .map((g) => `${g.branch} (${g.files.length} file(s), depth ${g.depth ?? 'UNRESOLVED'})`)
    .join('; ');
  const refused = unattributable.length > 0 ? `; ${unattributable.map((b) => b.reason).join('; ')}` : '';
  return {
    files,
    perFile,
    groups,
    unattributable,
    branch: groups[0]?.branch ?? null,
    candidates,
    reason:
      groups.length === 0
        ? `no branch could be blamed for the failing files${refused}`
        : `${files.length} failing file(s) blamed by git history to ${groups.length} branch(es): ${summary}${refused}`,
  };
}
