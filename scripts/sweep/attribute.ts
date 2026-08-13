/**
 * scripts/sweep/attribute.ts — blame a failing build on a BRANCH.
 *
 * `finish`'s verify can go red with no clean attribution: the offender is not a
 * branch the pass mutated, so the driver halts and asks a human to go fix
 * something. To turn that halt into a
 * fixable case, the driver first has to know WHICH BRANCH the fix belongs on.
 *
 * GIT HISTORY IS THE EVIDENCE — NOT THE REGISTRY.
 * ----------------------------------------------
 * Matching the failing paths against the registry's `owned_paths` /
 * `touch_paths` gives wrong answers: several entries can declare a failing file
 * in their paths without one of them ever having modified it, while the branch
 * that actually carries the defect declares nothing. Declarations are
 * aspirational — they say where a feature INTENDS to live. Git history says who
 * actually wrote the line that broke. Blame uses history.
 *
 * AUTHORSHIP IS THE FIRST-PARENT LINE — NOT A SET DIFFERENCE. A set-difference
 * count of a branch's own work, such as
 *
 *     git rev-list --count <branch> ^<inventory parents> -- <file>
 *
 * CANNOT identify authorship once work has propagated: the
 * moment a commit is merged up or down, it enters the other set and the answer
 * inverts. The receiving trunk scores for merges and for edits it merely
 * absorbed, while the branch that actually wrote the file scores 0, because the
 * exclusion subtracts its own work back out the instant the trunk absorbs it.
 * Blame therefore reads authorship off the first-parent chain:
 *
 *     authored(branch, file) =
 *       git rev-list --count --first-parent --no-merges <branch> ^main -- <file>
 *
 * A propagation merge records the RECEIVING branch as first parent and the
 * donated branch as second, so `--first-parent` walks a branch's OWN authoring
 * line and steps straight over everything it absorbed; `--no-merges` then drops
 * the integration commits themselves, which are not edits to the file — they are
 * the act of accepting someone else's edit. A commit authored on a module
 * branch and absorbed by the trunk is reachable from the trunk but is NOT on
 * its first-parent line: exactly the distinction the set difference cannot
 * draw.
 *
 * The exclusion is `^main` for EVERY branch, the trunk included. `main` is
 * upstream — never ours to fix — and it is the only floor that does not move as
 * work propagates. Inventory `parents` take no part in blame; they are the
 * input to hierarchy DEPTH (hierarchy.ts), which is
 * what decides WHICH candidate wins.
 *
 * A branch CUT from another (rather than merged from it) carries that branch's
 * commits on its own first-parent line, so it can appear as a candidate for work
 * it inherited. Normally harmless — the true author is then an ANCESTOR, hence
 * shallower, and the OWNER RULE below picks it. It stops being harmless when the
 * inventory's `parents` DISAGREE with git: a branch cut off another that its
 * entry does not declare as a parent can be declared a SIBLING of its true
 * author off a common parent, land at the same depth, and refuse as a depth
 * tie. That refusal is the correct outcome and a useful signal: the fix
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
 * `owned_paths`/`touch_paths` keep their other roles (routing.ts, validate.ts
 * score and validate with them) — they simply do not decide blame.
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
 * `bun test` names the file ONCE as a section header and then prints one
 * `(fail) <test name>` line per failing test underneath it — the file itself is
 * never repeated on the failure line. Parsing it needs the two together, which
 * is why this runner is stateful where the others are line-local.
 *
 * Without it a bun failure names NO file at all: `parseFailingFiles` returns
 * empty, blame falls through to the trunk, `rootChecksOutput` re-roots
 * nothing, and the not-my-bug comparison has no identity to compare —
 * `container/agent-runner`'s suite is bun, so its failing tests would be
 * invisible to every reader in this file.
 */
const BUN_FILE_HEADER = /^([\w./@-]+\.[cm]?tsx?):\s*$/;
const BUN_FAIL = /^\((?:fail|error)\)\s/;

/**
 * The distinct source files named by a failing checks run, first-seen order.
 * Typecheck output is parsed reliably; test output is best-effort (a runner is
 * free to print whatever it likes), which is why an empty result must fall back
 * rather than guess. PURE — no git, no fs: the paths arrive already re-rooted
 * per command cwd (`rootChecksOutput`).
 */
export function parseFailingFiles(output: string): string[] {
  return [...countFailingFiles(output).keys()];
}

/**
 * The same files, with HOW MANY failures each one accounts for (insertion-
 * ordered, so `keys()` is `parseFailingFiles`).
 *
 * The count is what makes a subset comparison safe. Comparing file SETS alone,
 * a file that already fails once absorbs a newly-introduced second failure
 * silently — the set is unchanged, the claim "this is not my bug" is confirmed,
 * and a real regression rides out inside a pre-existing red. Counting is the
 * cheapest thing that closes that hole without a per-runner test-name parser.
 */
export function countFailingFiles(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (raw: string): void => {
    const f = raw.replace(/^\.\//, '');
    counts.set(f, (counts.get(f) ?? 0) + 1);
  };
  let bunFile: string | null = null;
  for (const line of output.split('\n')) {
    // `$ <cmd>` separates one command's output from the next (`defaultChecksRunner`).
    // Without disarming here, a bun file header from one command stayed armed into
    // the NEXT command's block and collected its failures under the wrong file.
    if (line.startsWith('$ ')) {
      bunFile = null;
      continue;
    }
    const header = BUN_FILE_HEADER.exec(line);
    if (header) {
      // A header is not itself a failure — every file bun runs gets one. It only
      // arms the `(fail)` lines that follow, until the next header.
      bunFile = header[1].replace(/^\.\//, '');
      continue;
    }
    if (BUN_FAIL.test(line)) {
      if (bunFile) bump(bunFile);
      continue;
    }
    const m = TSC_BRACKET.exec(line) ?? TSC_COLON.exec(line) ?? VITEST_FAIL.exec(line);
    if (m) bump(m[1]);
  }
  return counts;
}

/**
 * WHAT failed, at a grain that survives an edit to the SOURCE.
 *
 * `countFailingFiles` answers "which files"; two attempts that fail in the same
 * file tell you nothing about whether they failed for the same reason. A
 * fingerprint is the identity of a single failing ITEM, chosen so that repeating
 * it across attempts is evidence and not coincidence:
 *
 *   test        file + test name + the line IN THE TEST FILE + a class
 *   typecheck   file + TS code + the normalized message, and NO line
 *
 * The line is in the TEST because the test is what the agent is NOT editing: it
 * edits source, so a stable test line means the failure landed in the same place
 * twice. When the agent edits the TEST FILE itself the line moves, the
 * fingerprint changes, and any comparison against earlier attempts correctly
 * resets — that is a different failure now. A tsc diagnostic points INTO the
 * source being edited, so its line moves under it with every edit and carrying
 * one would make every attempt look different; the normalized message carries
 * the identity instead.
 *
 * NUMERIC NOISE IS STRIPPED. `[10001.43ms]` versus `[8004.12ms]`, byte offsets,
 * "Received length: 1" — all of it varies run to run on an unchanged defect, and
 * a fingerprint that moves with the clock proves nothing. What may NOT collapse
 * is the CLASS: a test that times out and a test that fails an assertion are two
 * different failures of the same test, and telling the agent "nothing you did
 * moved it" when the failure mode changed would be false.
 */
export type FailureClass = 'assertion' | 'timeout' | 'throw' | 'suite-error';

export interface FailureFingerprint {
  kind: 'test' | 'typecheck';
  /** Repo-relative, as `parseFailingFiles` reports it. */
  file: string;
  /** Test name; '' for a whole-file/suite failure. Empty for a diagnostic. */
  test: string;
  /** Line in the TEST file. Null when the runner named none, and for a diagnostic. */
  line: number | null;
  cls: FailureClass | null;
  /** `TS2345` — diagnostics only. */
  code: string;
  /** Normalized diagnostic text — diagnostics only. */
  message: string;
  /** The stable serialization; the only form that is stored or compared. */
  key: string;
}

/** Names get long (a bun suite path is a sentence); the journal is not a log. */
const FP_NAME_CAP = 120;
const FP_MESSAGE_CAP = 160;

/** `src/x.ts(12,3): error TS2345: msg` and `src/x.ts:12:3 - error TS2345: msg`. */
const TSC_MESSAGE = /^\s*([\w./@-]+\.[cm]?tsx?)(?:\(\d+,\d+\)|:\d+:\d+\s*-)\s*:?\s*error\s+(TS\d+):\s*(.*)$/;
/** ` FAIL  src/x.test.ts > suite > case` — vitest names the test on the FAIL line. */
const VITEST_FAIL_NAMED = /^\s*FAIL\s+([\w./@-]+\.[cm]?tsx?)\s+>\s+(.+?)\s*$/;
/** `(fail) suite > case [155.42ms]`, `(error) suite`. */
const BUN_VERDICT = /^\((fail|error)\)\s*(.*)$/;
/** `(pass)`/`(skip)`/`(todo)` close the block above them without failing. */
const BUN_QUIET = /^\((?:pass|skip|todo)\)/;
/**
 * A timeout says so in words in every runner: bun `Test "x" timed out after
 * 5007ms`, vitest `Error: Test timed out in 5000ms.` It is tested FIRST because
 * both spell it as an `Error:`, which would otherwise class as a throw.
 */
const CLS_TIMEOUT = /\btimed\s*out\b|\btimeout\b/i;
/** bun `error: expect(received)…`, vitest `AssertionError: expected true to be false`. */
const CLS_ASSERTION = /AssertionError|\bexpect\(|\bexpected\b.*\b(?:to|but)\b/;
/**
 * ANCHORED, and that is the whole defense. Test output is full of application
 * logging (`[poll-loop] Query error: …` runs through the real capture below by
 * the dozen) and an unanchored `error:` would class a log line as the failure.
 */
const CLS_THROW = /^\s*(?:[A-Za-z_$][\w$]*Error|error|Error|Uncaught|Unhandled)\b\s*:/;

function classOf(line: string): FailureClass | null {
  if (CLS_TIMEOUT.test(line)) return 'timeout';
  if (CLS_ASSERTION.test(line)) return 'assertion';
  if (CLS_THROW.test(line)) return 'throw';
  return null;
}

/** Drop the numbers, keep the names: `Expected 2 arguments` -> `Expected # arguments`. */
function normalizeMessage(msg: string): string {
  return msg.replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim().slice(0, FP_MESSAGE_CAP);
}

function testKey(file: string, line: number | null, cls: FailureClass, test: string): string {
  return `test ${file}:${line ?? '?'} ${cls} ${test.slice(0, FP_NAME_CAP)}`;
}

/**
 * The failure fingerprints a checks run named — same input as
 * `parseFailingFiles`, and the same rule: OUTPUT THAT NAMES NOTHING YIELDS
 * NOTHING. An empty result means "cannot compare", never "identical"; every
 * caller must treat it as the absence of evidence, because a runner is free to
 * print whatever it likes and a parser that guesses would manufacture proof.
 *
 * Feed it the RE-ROOTED output (`rootChecksOutput`) for the same reason blame
 * does: bun prints `src/x.test.ts` from its own cwd while the stack frame under
 * it prints an absolute path, and only re-rooting makes the two the same file.
 * Suffix matching below covers what re-rooting cannot.
 *
 * Runner shapes, all three of which must be parsed:
 *
 *   tsc     `src/x.ts(12,3): error TS2345: …`   line-local, one diagnostic per line
 *   vitest  ` FAIL  src/x.test.ts > s > case`   name FIRST, then message, then frame
 *   bun     `src/x.test.ts:` … `(fail) <name>`  file is a HEADER, the message and
 *                                               frame come BEFORE the verdict line
 *
 * bun and vitest print the pieces in OPPOSITE ORDER, which is why this carries a
 * pending block rather than reading line by line: bun's message/frame are
 * accumulated and claimed by the `(fail)` that follows, vitest's FAIL opens a
 * block that the following lines fill in.
 *
 * Duplicates are collapsed by key and nothing else. A runner that prints the
 * same failure twice (vitest lists it in the run and again under "Failed Tests",
 * a retry prints it once per try) does so on EVERY attempt, so the set stays
 * identical across attempts — which is the only property the comparison needs.
 */
export function parseFailureFingerprints(output: string): FailureFingerprint[] {
  const out: FailureFingerprint[] = [];
  const seen = new Set<string>();
  const emit = (fp: FailureFingerprint): void => {
    if (seen.has(fp.key)) return;
    seen.add(fp.key);
    out.push(fp);
  };
  /** The failure being assembled: bun's armed file, or vitest's open FAIL. */
  let file: string | null = null;
  let test: string | null = null;
  let cls: FailureClass | null = null;
  let line: number | null = null;
  const sameFile = (frame: string, f: string): boolean =>
    frame === f || frame.endsWith(`/${f}`) || f.endsWith(`/${frame}`);
  const clear = (): void => {
    cls = null;
    line = null;
  };
  /** vitest's block is only complete when something else starts. */
  const flushVitest = (): void => {
    if (test === null || file === null) return;
    emit({
      kind: 'test',
      file,
      test,
      line,
      cls: cls ?? 'throw',
      code: '',
      message: '',
      key: testKey(file, line, cls ?? 'throw', test),
    });
    test = null;
    file = null;
    clear();
  };
  for (const raw of output.split('\n')) {
    // `$ <cmd>` separates one command's output from the next (`defaultChecksRunner`);
    // nothing may stay armed across it (same hazard as `countFailingFiles`).
    if (raw.startsWith('$ ')) {
      flushVitest();
      file = null;
      test = null;
      clear();
      continue;
    }
    const diag = TSC_MESSAGE.exec(raw);
    if (diag) {
      const f = diag[1].replace(/^\.\//, '');
      const message = normalizeMessage(diag[3]);
      emit({
        kind: 'typecheck',
        file: f,
        test: '',
        line: null,
        cls: null,
        code: diag[2],
        message,
        key: `ts ${f} ${diag[2]} ${message}`,
      });
      continue;
    }
    const named = VITEST_FAIL_NAMED.exec(raw);
    if (named) {
      flushVitest();
      file = named[1].replace(/^\.\//, '');
      test = named[2];
      clear();
      continue;
    }
    // ` FAIL  src/x.test.ts [ src/x.test.ts ]` with no `>` is the FILE failing to
    // load — no test ran, so there is no test name and no line in it to have
    // failed at.
    const bare = VITEST_FAIL.exec(raw);
    if (bare) {
      flushVitest();
      file = bare[1].replace(/^\.\//, '');
      test = '';
      clear();
      cls = 'suite-error';
      continue;
    }
    const header = BUN_FILE_HEADER.exec(raw);
    if (header) {
      flushVitest();
      file = header[1].replace(/^\.\//, '');
      test = null;
      clear();
      continue;
    }
    const verdict = BUN_VERDICT.exec(raw);
    if (verdict) {
      // A verdict with no armed header names no file — nothing to fingerprint.
      if (file === null) continue;
      const name = verdict[2].replace(/\s*\[[\d.]+\s*m?s\]\s*$/, '').trim();
      // `(error)` is bun reporting a failure that is not a test's own assertion —
      // a hook or module-scope throw. Classing it with the test's own failures
      // would let a suite that stops loading look like the same defect as a test
      // that runs and fails.
      const c: FailureClass = verdict[1] === 'error' ? 'suite-error' : (cls ?? 'throw');
      emit({
        kind: 'test',
        file,
        test: name,
        line,
        cls: c,
        code: '',
        message: '',
        key: testKey(file, line, c, name),
      });
      clear();
      continue;
    }
    if (BUN_QUIET.test(raw)) {
      clear();
      continue;
    }
    if (file === null) continue;
    cls ??= classOf(raw);
    if (line === null) {
      for (const f of raw.matchAll(STACK_FRAME)) {
        const frame = repoRootedFrame(f[1]);
        // ONLY the test file's own frames. The first frame of a bun trace is
        // usually the assertion inside the test; the deeper ones are in the
        // SOURCE the agent is editing, and taking one of those would make the
        // fingerprint move on every edit — the exact instability this avoids.
        if (!frame || !sameFile(frame, file)) continue;
        line = Number(f[2]);
        break;
      }
    }
  }
  flushVitest();
  return out;
}

/** The journaled form: de-duplicated and SORTED, so two runs compare as strings. */
export function fingerprintKeys(fps: FailureFingerprint[]): string[] {
  return [...new Set(fps.map((f) => f.key))].sort();
}

/**
 * One fingerprint key as a clause an agent can act on. Reads the KEY rather than
 * the record because the comparison that needs this reads keys out of the
 * journal — the records themselves belong to a run that is over. An unparseable
 * key is returned verbatim: a slightly ugly sentence beats a thrown parse.
 */
export function describeFingerprint(key: string): string {
  const t = /^test (\S+?):(\d+|\?) (\S+) ?(.*)$/.exec(key);
  if (t) {
    const [, file, line, cls, name] = t;
    if (!name) return `${file} still fails to load in the same way (${cls})`;
    if (line === '?') return `"${name}" still fails in the same way (${file}, ${cls})`;
    return `"${name}" still fails at the same line in the same way (${file}:${line})`;
  }
  const d = /^ts (\S+) (TS\d+) ?(.*)$/.exec(key);
  if (d) return `${d[1]} still reports the same ${d[2]}${d[3] ? `: ${d[3]}` : ''}`;
  return key;
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
 * remote-tracking one (DRIVER.md §4.7 — an inventory branch may legitimately
 * exist only as `origin/<branch>`). Null when neither exists, which is not an
 * error: a planned entry simply has no history to blame. Cached — the same
 * branches would otherwise be re-resolved once per failing file.
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
 * making one.
 *
 * `exclude` — OWNER-APPROVED DUPLICATE CUT-POINT EXCEPTIONS (cut-points.ts).
 * A rebase COPY of another branch's commit sits on the copying branch's own
 * first-parent line, so this count credits it as that branch's work and no
 * exclusion of the ORIGINAL's branch can remove it — the copy is a different
 * sha, so `^<original-branch>` does nothing.
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
  // ONE exclusion for every branch, resolved once: upstream. A per-branch
  // `^parents` set would invert the answer the moment work propagated (see the
  // header — the trunk would score for edits it merely absorbed).
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
    // Indistinguishable on the ONE real signal. Falling through to name order
    // and reporting "earliest by hierarchy" would be a
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

/**
 * WHERE the failure is, per failing test — the gate-fix analogue of a conflict
 * case's hunk ranges.
 *
 * A conflict case says where the markers are, so the agent reads two windows
 * instead of paging the file. Without this equivalent, a gate fix hands over a
 * file list plus a bounded output tail and the agent locates the code itself —
 * dozens of reads at different offsets, re-paging the same path over and over.
 *
 * THE RUNNERS DISAGREE ABOUT WHAT A LOCATION IS, and all three shapes must be
 * parsed — miss one and this emits NOTHING for that runner, so the section is
 * silently omitted:
 *
 *   tsc      `src/x.ts(12,3): error TS2345`     file + line on the failing line
 *   vitest   ` ❯ src/x.test.ts:85:21`            file + line on the failing line
 *   bun      `src/x.test.ts:` … `(fail) <name>`  file is a HEADER; the failure
 *                                                line carries NO file and NO
 *                                                line number, only a test name
 *
 * Bun is the runner this driver's `checks.test` actually uses. Its file must be
 * carried down from the header — the same statefulness `countFailingFiles`
 * needs, and for the same reason — and since there is no line number, the
 * TEST NAME is the coordinate: it is what the agent greps for.
 *
 * Deduped, first occurrence wins, capped — a stack trace repeats one frame
 * dozens of times and the point is a short list of places to look.
 */
export function failingLocations(output: string, limit = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (loc: string): void => {
    if (seen.has(loc) || out.length >= limit) return;
    seen.add(loc);
    out.push(loc);
  };
  let bunFile: string | null = null;
  for (const line of output.split('\n')) {
    if (out.length >= limit) break;
    // `$ <cmd>` separates one command's output from the next; a header must not
    // stay armed across that boundary (same hazard as countFailingFiles).
    if (line.startsWith('$ ')) {
      bunFile = null;
      continue;
    }
    const header = BUN_FILE_HEADER.exec(line);
    if (header) {
      bunFile = header[1].replace(/^\.\//, '');
      continue;
    }
    if (BUN_FAIL.test(line) && bunFile) {
      // `(fail) suite > case [1234.56ms]` — the timing is noise for a search.
      const name = line.replace(/^\((?:fail|error)\)\s*/, '').replace(/\s*\[[\d.]+m?s\]\s*$/, '').trim();
      add(name ? `${bunFile} — "${name}"` : bunFile);
      continue;
    }
    const m = TSC_BRACKET.exec(line) ?? TSC_COLON.exec(line);
    if (m) {
      add(`${m[1].replace(/^\.\//, '')}:${m[2]}`);
      continue;
    }
    for (const f of line.matchAll(STACK_FRAME)) {
      const file = repoRootedFrame(f[1]);
      if (!file) continue;
      add(`${file}:${f[2]}`);
    }
  }
  return out;
}

/** vitest frames + node stack frames: `at fn (file:line:col)`, ` ❯ file:line:col`. */
const STACK_FRAME = /(?:^|\s|\()(\/?[\w./@-]+\.[cm]?tsx?):(\d+)(?::\d+)?/g;

/**
 * A stack frame's path as the agent can open it — repo-relative — or null when
 * it names nothing the agent works in.
 *
 * Stack traces print the worktree's FULL path, e.g.
 *   …/propagation/pass-<id>/<case>/worktree/src/x.ts:153
 * — unopenable twice over: it names a DIFFERENT pass (checks output is captured
 * before the case is minted and carries the tree it ran in), and that directory
 * does not survive a clean-slate. Everything after the worktree root is the
 * repo-relative path, which is what the conflict-case hunk ranges give and what
 * `parseFailingFiles` produces.
 *
 * With no worktree segment — a clone root, a temp verify worktree, wherever the
 * runner happened to be — the repo-relative part still starts at the first
 * source directory, and naming a `src/…`/`container/…` path the agent can
 * actually open beats dropping a real location for want of a prefix. A frame in
 * `node_modules` is the runner's own stack, not the defect.
 */
function repoRootedFrame(raw: string): string | null {
  const file = raw.replace(/^\.\//, '');
  if (file.includes('node_modules/')) return null;
  const cut = file.lastIndexOf('/worktree/');
  if (cut >= 0) return file.slice(cut + '/worktree/'.length);
  if (file.startsWith('/')) {
    const m = /\/((?:src|container|scripts|test|tests)\/.*)$/.exec(file);
    return m ? m[1] : null;
  }
  return file;
}
