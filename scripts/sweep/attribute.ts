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
 * branch that carries the defect is NOT one of them. Declarations are
 * aspirational — they say where a feature INTENDS to live. Git history says who
 * actually wrote the line that broke. Blame uses history.
 *
 * AUTHORSHIP IS THE FIRST-PARENT LINE — NOT A SET DIFFERENCE (2026-07-28, round
 * two). The first history rule counted a branch's own work as
 *
 *     git rev-list --count <branch> ^<inventory parents> -- <file>
 *
 * A set difference CANNOT identify authorship once work has propagated: the
 * moment a commit is merged up or down, it enters the other set and the answer
 * inverts. Measured on the live fork for `src/command-gate.ts`:
 *
 *     rule                          main_patched   module/command-gate
 *     ^parents (what shipped)            6                 0
 *     ^main ^all-other-branches          2                 0
 *     --first-parent                     3                 3
 *     --first-parent --no-merges         0                 3   <- correct
 *
 * The trunk's six "own" commits were two merges — one of them a propagation
 * merge the sweep itself had just made — plus three edits AUTHORED on
 * `module/command-gate` and absorbed by the trunk. Meanwhile the branch that
 * actually wrote the file scored 0, because `^main_patched` subtracted its own
 * work back out of it the instant the trunk absorbed it. Blame therefore reads
 * authorship off the first-parent chain:
 *
 *     authored(branch, file) =
 *       git rev-list --count --first-parent --no-merges <branch> ^main -- <file>
 *
 * A propagation merge records the RECEIVING branch as first parent and the
 * donated branch as second, so `--first-parent` walks a branch's OWN authoring
 * line and steps straight over everything it absorbed; `--no-merges` then drops
 * the integration commits themselves, which are not edits to the file — they are
 * the act of accepting someone else's edit. `3d5dde16` ("parse slash commands
 * from the bot-mention boundary", authored on `module/command-gate`, absorbed by
 * the trunk) is reachable from `main_patched` but is NOT on its first-parent
 * line: exactly the distinction the set difference could not draw.
 *
 * The exclusion is `^main` for EVERY branch, the trunk included. `main` is
 * upstream — never ours to fix — and it is the only floor that does not move as
 * work propagates. Inventory `parents` take no part in blame any more; they stay
 * what they always were, the input to hierarchy DEPTH (hierarchy.ts), which is
 * what decides WHICH candidate wins.
 *
 * A branch CUT from another (rather than merged from it) carries that branch's
 * commits on its own first-parent line, so it can appear as a candidate for work
 * it inherited. Normally harmless — the true author is then an ANCESTOR, hence
 * shallower, and the OWNER RULE below picks it. It stops being harmless when the
 * inventory's `parents` DISAGREE with git: censused over the 710 real `.ts` paths
 * of the live fork, 59 refuse as a depth tie, every one of them a branch cut off
 * another that its entry does not declare as a parent — `module/runtime-updater`
 * was cut from `module/credentials`, `module/host-rpc` and
 * `module/interactions-helpers` from `module/container-bootstrap`, yet all of
 * them are declared as SIBLINGS off a common parent and therefore land at the
 * same depth. That refusal is the correct outcome and a useful signal: the fix
 * is to add the missing edge to the inventory, not to break the tie by spelling
 * here.
 *
 * OWNER RULE: when several branches carry authored commits over a file, pick the
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

/** A branch that AUTHORED commits over a failing file, with why and how deep it sits. */
export interface BranchCandidate {
  branch: string;
  /** Entry id when the branch comes from the inventory; '' for the trunk. */
  id: string;
  /** From the ONE hierarchy (hierarchy.ts). Null = no route to the root. */
  depth: number | null;
  /** Shortest parent chain to the root, excluding `main`. */
  minPath: string[] | null;
  /** `rev-list --count --first-parent --no-merges <branch> ^main` — always > 0 here. */
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
 * Commits `ref` AUTHORED over `file`: its own first-parent line since `rootRef`,
 * merges dropped. A propagation merge puts the RECEIVING branch first and the
 * donated branch second, so `--first-parent` never walks into absorbed work, and
 * `--no-merges` removes the integration commits — accepting an edit is not
 * making one. Live check: `main_patched` scores 6 with a plain `^main` set
 * difference over `src/command-gate.ts` and 0 here, while the branch that wrote
 * the file, `module/command-gate`, scores 0 with the set difference and 3 here.
 *
 * `exclude` — OWNER-APPROVED DUPLICATE CUT-POINT EXCEPTIONS (cut-points.ts).
 * A rebase COPY of another branch's commit sits on the copying branch's own
 * first-parent line, so this count credits it as that branch's work and no
 * exclusion of the ORIGINAL's branch can remove it: `3b8c5896` (patch-id
 * 25c7b6481c3a) is a copy of `dc3cb7f6` on `module/host-rpc`, and it is on
 * `module/credentials`' first-parent line, so `^module/host-rpc` does nothing.
 * The exception is re-verified against the repo before it reaches here (both
 * patch-ids recomputed), so a listed sha is a MEASURED copy, not a claim. With
 * an exclusion the count must be listed and filtered rather than counted by
 * git — `--count` returns a number with nothing left to subtract from.
 */
async function authoredCommits(
  repo: string,
  ref: string,
  rootRef: string,
  file: string,
  exclude?: Set<string>,
): Promise<number> {
  const range = ['--first-parent', '--no-merges', ref, `^${rootRef}`, '--', file];
  if (!exclude || exclude.size === 0) {
    const res = await git(repo, ['rev-list', '--count', ...range], { allowCodes: [1, 128] });
    if (res.code !== 0) return 0;
    const n = parseInt(res.stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }
  const res = await git(repo, ['rev-list', ...range], { allowCodes: [1, 128] });
  if (res.code !== 0) return 0;
  return res.stdout.split('\n').filter((sha) => sha && !exclude.has(sha)).length;
}

/**
 * Per failing file, every branch that AUTHORED commits over it — ordered by the
 * OWNER RULE (shallowest hierarchy depth first; UNRESOLVED last, never as 0).
 * Name order is applied ONLY to make the listing stable; it is never a decision,
 * see `attributeFailure`.
 *
 * EVERY branch in the hierarchy is examined, INCLUDING the trunk `main_patched`:
 * the trunk does author defects, and no inventory entry carries `branch:
 * main_patched`, so an inventory-only scan guarantees a wrong answer in exactly
 * the case that matters most. `main` is not examined — it is upstream, not ours
 * to fix — it is the EXCLUSION, the same one for every branch.
 *
 * A branch whose ref cannot be resolved is SKIPPED, never counted with the
 * exclusion silently dropped: without `^main` the count would swallow the whole
 * of upstream's history over the file. `main` itself failing to resolve is the
 * same case for everyone at once — nothing can be blamed, so nothing is, and
 * every file falls to the trunk rather than to a fabricated candidate.
 *
 * `duplicates` — branch -> shas that are REBASE COPIES carried by that branch,
 * from the owner-approved, re-verified cut-point exceptions (cut-points.ts).
 * Absent by default: with no exceptions file the counts are exactly what they
 * were. See `authoredCommits`.
 */
export async function blameCandidates(
  repo: string,
  files: string[],
  features: FeatureEntry[],
  h?: Hierarchy,
  duplicates?: Map<string, Set<string>>,
): Promise<Map<string, BranchCandidate[]>> {
  const hier = h ?? branchHierarchy(features);
  const order = byHierarchy(hier);
  const refs = new Map<string, string | null>();
  const byFile = new Map<string, BranchCandidate[]>(files.map((f) => [f, []]));
  // ONE exclusion for every branch, resolved once: upstream. It replaces the
  // per-branch `^parents` set, which inverted the answer the moment work
  // propagated (see the header — the trunk scored 6 for a file it never wrote).
  const rootRef = await resolveRef(repo, ROOT_BRANCH, refs);
  if (!rootRef) return byFile;
  for (const node of hier.byBranch.values()) {
    if (node.branch === ROOT_BRANCH) continue;
    const ref = await resolveRef(repo, node.branch, refs);
    if (!ref) continue;
    const exclude = duplicates?.get(node.branch);
    for (const file of files) {
      const commits = await authoredCommits(repo, ref, rootRef, file, exclude);
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
    // Nobody authored it on their own line: inherited from upstream, or broken by
    // the trunk's own merge of upstream. Either way the trunk is where a fix
    // reaches every branch, and it is the ONE place that is never someone
    // else's work.
    return {
      file,
      branch: TRUNK_BRANCH,
      candidates,
      reason: `no branch authored commits over ${file} — attributed to the trunk ${TRUNK_BRANCH}`,
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
        ? `${first.branch} is the only branch that authored commits over ${file} (${first.commits})`
        : `${candidates.length} branches authored commits over ${file}; picked ${first.branch} — shallowest by hierarchy (depth ${first.depth ?? 'UNRESOLVED'} via ${(first.minPath ?? []).join(' <- ') || 'main'}, ${first.commits} commit(s))`,
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
 *
 * `duplicates` — re-verified duplicate cut-point exceptions, threaded to
 * `blameCandidates`. The caller loads and verifies them (cut-points.ts) because
 * the LOUD/quiet split for a malformed or stale file is a command-level
 * decision, not one blame can make from inside a count.
 */
export async function attributeFailure(
  repo: string,
  output: string,
  features: FeatureEntry[],
  accused?: string | null,
  duplicates?: Map<string, Set<string>>,
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
  const byFile = await blameCandidates(repo, files, features, hier, duplicates);
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
