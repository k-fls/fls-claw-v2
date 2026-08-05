/**
 * scripts/sweep/not-my-bug.ts — adjudicating `report-case --not-my-bug`.
 *
 * THE DEADLOCK THIS EXISTS FOR (live 2026-08-01, pass 87175bdb89ad). A case
 * resolved `src/cli/resources/groups.ts` cleanly; the checks gate then failed on
 * `container/agent-runner/src/poll-loop.test.ts`, a test the case never touched
 * and the agent was not allowed to edit. The gate's answer to a test failure is
 * "fix the pending files" — impossible when the failure is not in them — and the
 * only other exit was ten more deliberate failures. The agent claimed `--tier
 * held` twice, was refused twice, filed a stop-case and idled for four hours.
 *
 * THE SHAPE OF THE FIX (owner, 2026-08-03). The agent gets a flag it can raise
 * ALONGSIDE its tier — the tier classifies the agent's EDIT, the flag classifies
 * the driver's TEST REPORT, and they are independent axes. The claim is then
 * ADJUDICATED MECHANICALLY here; the agent's belief decides nothing. It cannot:
 * the agent is forbidden to run tests (`CHECKS_HANDOFF_LINE`), so on its first
 * `report-case` it does not even know a test failed. That is why the flag can
 * only ever be raised on the SECOND iteration — not a policy knob, a consequence
 * of who can see what.
 *
 * WHAT IS COMPARED, AND WHY THAT TREE. The baseline is the case's own CLEAN
 * PREFIX commit — the worktree's HEAD, everything of the merge that landed
 * cleanly, with the conflicted paths still pending. It holds the entire merge
 * constant and removes only the agent's resolution, so it isolates exactly the
 * variable the claim is about. It is also already on disk with its dependencies
 * linked, which makes it the cheapest tree in the pass to re-probe.
 *
 * THREE RULES THAT KEEP IT HONEST:
 *
 *  1. SUBSET, NOT "IT REPRODUCES". Confirmation requires the resolved tree's
 *     failures to be covered by the baseline's, counted PER FILE. A file that
 *     already fails once must not be allowed to absorb a newly-introduced second
 *     failure — "the bug reproduces" would be literally true and the regression
 *     would ship inside someone else's red.
 *  2. CONFIRM ON ONE OBSERVATION, NEVER REFUSE ON ONE. A red on the baseline
 *     cannot have been caused by edits that tree does not contain, so one red
 *     run settles it. The damaging error is the false REFUSE — the baseline
 *     coming back green by luck and shoving the agent back into the deadlock —
 *     so every refusing observation is re-run before it is believed. The 08-01
 *     test has an internal 5000 ms deadline under a 5000 ms runner timeout: it
 *     is a coin flip under load, and a single run decides nothing.
 *  3. UNBUILDABLE IS NOT GREEN. A tree whose dependencies cannot be prepared, or
 *     whose checks failed without naming a single file, is SKIPPED. Reading it as
 *     a pass is how a bisect converges on the commit that touched `package.json`,
 *     and how `vitest run <path matching nothing>` — which exits 1 saying "No test
 *     files found" — becomes a green anchor. A commit that PREDATES the failing
 *     file is the opposite case and is genuinely green: absence is proof the
 *     failure is not there, stronger than any run.
 *
 * The module is pure logic over injected probes: `propagate.ts` supplies the
 * worktrees, dependency pools and git reads, so every rule above is testable
 * without a runner.
 */

/**
 * ENVIRONMENT-FAULT SIGNATURES. A failure whose diagnostics look like these did
 * not come from the code under test — it came from the tree it was run in.
 *
 * This is the failure MODE the whole mechanism is most dangerous in, and it bit
 * live on 2026-08-03. The adjudication compares two trees that share ONE
 * dependency pool, so a broken pool reproduces identically on both: the verdict
 * is a correct "not caused by your resolution", and the driver then confidently
 * blames a branch, mints a gate-fix case and asks an agent to fix source code
 * for a missing compiled addon. One case named 44 files; the log held 76
 * "Could not locate the bindings file" and NOT ONE assertion failure.
 *
 * The discriminator is what a diagnostic is ABOUT. Code defects assert and
 * type-error; environments fail to RESOLVE — a binding, a module, a binary. The
 * second tell is location: frames inside `node_modules/` or the driver's
 * `deps-pool/` rather than repo sources.
 */
const ENV_FAULT_PATTERNS: RegExp[] = [
  /Could not locate the bindings file/i,
  // TS2307 (cannot find module/declarations), TS2688 (missing @types), TS5012
  // (cannot read file), TS6053 (file not found), TS2318 (missing global type) —
  // the compiler failing to RESOLVE its inputs, not to check them.
  /error TS(?:2307|2688|5012|6053|2318)\b/,
  /was compiled against a different Node\.js version/i,
  /invalid ELF header|wrong ELF class/i,
  /Cannot find module '[^']*'\s*$/im,
  /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
  /ERR_DLOPEN_FAILED|dlopen\(/,
  /\bcommand not found\b|\bENOENT\b.*\bspawn\b/i,
  /error while loading shared libraries/i,
];

/** A frame pointing INTO the dependency trees rather than at repo sources. */
const ENV_FAULT_FRAME = /(?:^|[\s(])(?:[\w./@-]*\/)?(?:node_modules|deps-pool)\//m;

export interface EnvFaultVerdict {
  isEnvironment: boolean;
  /** The matched signature, for the journal and the agent's report. */
  signature: string | null;
  detail: string;
}

/**
 * Does this failing output describe a broken ENVIRONMENT rather than broken code?
 *
 * Conservative by construction: it demands a named signature, it demands that
 * NOTHING in the output looks like a genuine test assertion, and it demands that
 * an unresolved module is not one of the repo's OWN files.
 *
 * That third demand replaces a claim this comment used to make and that the
 * pipeline made false: "a real defect that merely happens to mention a missing
 * module (a resolution that deleted an import, say) still asserts somewhere."
 * It does not. Typecheck short-circuits before the tests, so an assertion is
 * impossible in the only output this ever sees, and the named counterexample was
 * classified ENVIRONMENT — halting the sweep to tell the agent not to fix a
 * broken import it had just written.
 *
 * The asymmetry is still deliberate — mis-classifying an environment fault as
 * code produces confident branch-targeted nonsense, while mis-classifying code
 * as environment produces a stop case a human reads.
 */
export function classifyEnvironmentFault(output: string): EnvFaultVerdict {
  const hit = ENV_FAULT_PATTERNS.find((re) => re.test(output));
  if (!hit) return { isEnvironment: false, signature: null, detail: '' };
  // A genuine assertion anywhere means code is being exercised and failing on
  // its own terms; the resolution error is then incidental, not the story.
  //
  // `error TS…` USED TO VETO WHOLESALE, and that made this function dead code for
  // the entire typecheck kind — `checks.typecheck` runs before `checks.test` and
  // short-circuits, so a typecheck failure was the only thing it could ever be
  // asked about, and every one of them carries `error TS`. Worse, TS2307 "Cannot
  // find module" IS a resolution diagnostic: exactly this class. Live 2026-08-04,
  // a missing `yaml` was read as the agent's code defect. So TS codes are split —
  // resolution codes are environment evidence, everything else is a real
  // compile error and vetoes as before.
  const otherTsError = /error TS(?!2307\b|2688\b|5012\b|6053\b|2318\b)\d+/.test(output);
  const asserts =
    /AssertionError|expected .* (?:to|but)\b|toBe\(|toEqual\(|Expected:.*Received:/is.test(output) || otherTsError;
  if (asserts) return { isEnvironment: false, signature: null, detail: '' };
  // A RELATIVE specifier is the repo's own tree, so failing to resolve one is
  // the agent's defect — not the environment's.
  //
  // The veto above cannot catch it. `checks.typecheck` runs before `checks.test`
  // and short-circuits, so a typecheck failure is the ONLY thing this is ever
  // asked about (the comment above says so) — its output can therefore never
  // contain a test assertion, and a lone TS2307 carries no other TS error to
  // veto with. So the doc's own counterexample, "a resolution that deleted an
  // import", was classified ENVIRONMENT and the sweep halted telling the agent
  // not to fix its own one-line mistake. Verified by calling this directly:
  //
  //   Cannot find module './command-gate'  -> ENVIRONMENT   (wrong)
  //   Cannot find module 'yaml'            -> ENVIRONMENT   (right)
  //
  // What a diagnostic is ABOUT is the right discriminator; the specifier says
  // which tree it is about. `'./x'` and `'../x'` are repo sources the agent
  // edits; a bare `'yaml'` is the dependency tree it cannot.
  const unresolvedSpecifiers = [...output.matchAll(/Cannot find module '([^']+)'/g)].map((m) => m[1]);
  if (unresolvedSpecifiers.length > 0 && unresolvedSpecifiers.every((m) => m.startsWith('.'))) {
    return { isEnvironment: false, signature: null, detail: '' };
  }
  const framed = ENV_FAULT_FRAME.test(output);
  const signature = String(hit).replace(/^\/|\/[a-z]*$/g, '');
  return {
    isEnvironment: true,
    signature,
    detail:
      `the failing output is an ENVIRONMENT fault, not a code defect — it matches /${signature}/ ` +
      `${framed ? 'with frames inside node_modules/deps-pool ' : ''}and contains no test assertion. ` +
      `No code change can fix this; the dependency tree the checks ran against is broken.`,
  };
}


/** Which tree a probe runs against. */
export type ProbeTarget =
  /** The case worktree AS IT STANDS — with the agent's edits. */
  | { kind: 'worktree' }
  /** A committed tree: the clean prefix, a branch tip, a bisect candidate. */
  | { kind: 'commit'; sha: string };

/** What one subset run reports back. */
export interface ProbeResult {
  /**
   * FALSE when the tree could not be prepared or run at all (dependencies would
   * not install, the checkout failed, none of the files exist yet). Distinct
   * from "ran and passed" — see rule 3. A caller must SKIP an unusable probe,
   * never count it as green.
   */
  usable: boolean;
  /** Failures per file, as `countFailingFiles` reports them. */
  counts: Map<string, number>;
  /** Raw output, for the journal and the agent-facing summary. */
  output: string;
}

export type SubsetProbe = (target: ProbeTarget, files: string[]) => Promise<ProbeResult>;

/** Git reads the search needs. Injected so the search is testable without a repo. */
export interface History {
  /** `<ref>~<back>`, or null when the history is shorter than that. */
  ancestor(ref: string, back: number): Promise<string | null>;
  /** First-parent commits in `(from, to]`, OLDEST first. */
  listFirstParent(from: string, to: string): Promise<string[]>;
  /** Does at least one of these paths exist at this commit? (rule 3.) */
  hasAnyFile(sha: string, files: string[]): Promise<boolean>;
  /** Does `sha` contain `ancestor`? Used to enforce the search FLOOR. */
  contains?(sha: string, ancestor: string): Promise<boolean>;
}

export type NotMyBugVerdict =
  /** Proven: the failures are there without the agent's resolution. */
  | 'pre-existing'
  /** Disproven: at least one failure appears only WITH the resolution. */
  | 'caused-by-case'
  /** Neither — the failures did not reproduce anywhere consistently. */
  | 'flaky'
  /** The comparison could not be made (no parseable files, unbuildable tree). */
  | 'undecidable';

export interface NotMyBugClassification {
  verdict: NotMyBugVerdict;
  /**
   * `pre-existing`: the files proven to fail without the resolution.
   * `caused-by-case`: the files that fail ONLY with it — the agent's own work.
   * `flaky`: the files that stopped failing when asked again.
   */
  files: string[];
  /** How many subset runs it took, for the agent's report and the journal. */
  probes: number;
  /** One line, agent-facing. */
  detail: string;
}

/** Fold a probe's counts into a running maximum (rule 2's merge of two runs). */
function mergeCounts(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map(a);
  for (const [f, n] of b) out.set(f, Math.max(out.get(f) ?? 0, n));
  return out;
}

/**
 * Did the runner report that ANYTHING passed?
 *
 * This replaces a file-count threshold (`IMPLAUSIBLE_BREADTH = 10`) that could
 * not do the job asked of it. The guard below wants to know "is this a broken
 * toolchain rather than a defect", and breadth is a proxy for that: the 08-03
 * environment fault happened to touch 44 files. But a genuine pre-existing
 * defect fails IDENTICALLY on both trees — the guard's own comment calls that
 * "the NORMAL shape of a confirmed pre-existing defect" — so `hasControl` is
 * false for every one of them, and any real defect touching >= 10 files became
 * `undecidable` by construction, unconfirmable no matter how many probes ran.
 * The observed real defects were 1 and 3 files; the threshold sat at 10 while
 * its comment said "dozens".
 *
 * What was actually anomalous on 08-03 is what the guard's own message says:
 * "nothing passed on either". A broken toolchain runs nothing; a code defect
 * leaves the rest of the suite green. That is reported by the runner and can be
 * read instead of guessed at.
 *
 * Returns null when NO count was reported at all (a clean `tsc` prints nothing).
 * Absence of a pass count is not evidence that nothing passed, so the caller
 * must not treat it as such.
 */
function reportedPasses(output: string): number | null {
  let total: number | null = null;
  // vitest: `Tests  1 failed | 1175 passed | 21 skipped`
  // bun:    `120 pass  5 fail`
  for (const m of output.matchAll(/\b(\d+)\s+pass(?:ed)?\b/gi)) {
    total = (total ?? 0) + Number(m[1]);
  }
  return total;
}

/**
 * Did anything DISTINGUISH the two runs? True when the baseline failed strictly
 * more than the resolved tree somewhere — the control that proves the checks can
 * still report a difference at all. Without it, "identical failures" carries no
 * information: it is equally consistent with a real pre-existing defect and with
 * an environment in which nothing can pass.
 */
function hasControl(baseline: Map<string, number>, resolved: Map<string, number>): boolean {
  for (const [f, n] of baseline) if (n > (resolved.get(f) ?? 0)) return true;
  return false;
}

/** Files whose resolved-tree failure count the baseline does NOT account for. */
function uncovered(resolved: Map<string, number>, baseline: Map<string, number>): string[] {
  return [...resolved.entries()].filter(([f, n]) => (baseline.get(f) ?? 0) < n).map(([f]) => f);
}

/**
 * Adjudicate the claim. At most three subset runs, and the common confirming
 * case costs exactly one.
 */
export async function classifyFailure(
  resolved: Map<string, number>,
  prefixSha: string,
  probe: SubsetProbe,
): Promise<NotMyBugClassification> {
  const files = [...resolved.keys()];
  if (files.length === 0) {
    return {
      verdict: 'undecidable',
      files: [],
      probes: 0,
      detail:
        'the failing output named no source file, so there is nothing to compare — ' +
        'the claim cannot be adjudicated (read the output and fix the pending files, or claim --tier held)',
    };
  }
  const prefix = { kind: 'commit', sha: prefixSha } as const;

  const b1 = await probe(prefix, files);
  if (!b1.usable) {
    return {
      verdict: 'undecidable',
      files,
      probes: 1,
      detail: `the pre-conflict tree (${prefixSha.slice(0, 12)}) could not be built, so the comparison could not be made`,
    };
  }
  // Rule 2, confirming half: one red on a tree that does not contain the agent's
  // edits is proof enough. No repetition — repeating it cannot change the answer.
  if (uncovered(resolved, b1.counts).length === 0) {
    // TOOLCHAIN BACKSTOP (owner, 2026-08-04). "Both sides fail identically" is the
    // NORMAL shape of a confirmed pre-existing defect — the 08-01 poll-loop case
    // is exactly one file failing the same way on both trees — so identity alone
    // proves nothing either way and must not be treated as suspicious.
    //
    // What was anomalous on 2026-08-03 was that NOTHING PASSED: 44 files at
    // once and not one green test anywhere. A broken toolchain or dependency
    // tree runs nothing; a code defect, however broad, leaves the rest of the
    // suite green. So the guard fires on a runner-reported zero WITH no
    // discriminating observation — never on a defect that merely touches many
    // files, and never when the runner reported no counts at all (a clean `tsc`
    // prints nothing, and silence is not evidence).
    //
    // This sits BEHIND `classifyEnvironmentFault`, which catches the same class
    // by diagnostic shape and is the primary defence. It exists for the shapes
    // nobody has enumerated yet — which is precisely what a heuristic is for.
    const passes = reportedPasses(b1.output);
    if (passes === 0 && !hasControl(b1.counts, resolved)) {
      return {
        verdict: 'undecidable',
        files,
        probes: 1,
        detail:
          `${files.length} files fail on BOTH trees, the runner reported ZERO passing tests, and the comparison ` +
          `distinguished nothing. This is what a broken toolchain or dependency tree looks like; the environment ` +
          `must be checked before any code is blamed`,
      };
    }
    return {
      verdict: 'pre-existing',
      files,
      probes: 1,
      detail: `every failure also fails at the pre-conflict tree ${prefixSha.slice(0, 12)} — not caused by this resolution`,
    };
  }

  // Rule 2, refusing half: re-run ONLY what looked green before believing it.
  const u1 = uncovered(resolved, b1.counts);
  const b2 = await probe(prefix, u1);
  if (!b2.usable) {
    return {
      verdict: 'undecidable',
      files,
      probes: 2,
      detail: `the pre-conflict tree (${prefixSha.slice(0, 12)}) became unbuildable on the second probe`,
    };
  }
  const merged = mergeCounts(b1.counts, b2.counts);
  if (uncovered(resolved, merged).length === 0) {
    return {
      verdict: 'pre-existing',
      files,
      probes: 2,
      detail:
        `every failure also fails at the pre-conflict tree ${prefixSha.slice(0, 12)} — ` +
        `not caused by this resolution (${u1.join(', ')} needed a second run: unstable there too)`,
    };
  }

  // Still unaccounted for. Before calling them the agent's, make sure they are
  // not a flake on the RESOLVED side either — that misfire refuses a true claim.
  const u2 = uncovered(resolved, merged);
  const r2 = await probe({ kind: 'worktree' }, u2);
  if (!r2.usable) {
    return {
      verdict: 'undecidable',
      files: u2,
      probes: 3,
      detail: 'the case worktree could not be re-run, so the remaining failures could not be attributed',
    };
  }
  const still = u2.filter((f) => (r2.counts.get(f) ?? 0) > 0);
  if (still.length === 0) {
    return {
      verdict: 'flaky',
      files: u2,
      probes: 3,
      detail: `${u2.join(', ')} did not fail again when re-run — a flake, not a defect in either tree`,
    };
  }
  return {
    verdict: 'caused-by-case',
    files: still,
    probes: 3,
    detail: `${still.join(', ')} fail with your resolution and pass without it — these are yours to fix`,
  };
}

/** Who owns a proven pre-existing failure — i.e. where its fix has to land. */
export type OwnerKind =
  /** Red at the branch's own tip: the branch owns it. */
  | 'branch'
  /** Green on the branch, red at the parent's head: the incoming side owns it. */
  | 'parent'
  /** Green on both sides in isolation — the MERGE produced it. Nobody upstream owns it. */
  | 'interaction'
  /** A probe was unusable; ownership undetermined. */
  | 'unknown';

export interface OwnershipResult {
  owner: OwnerKind;
  /** The commit the fix must be rooted on (null for an interaction). */
  ref: string | null;
  /** The subset of files failing there. */
  files: string[];
  probes: number;
  detail: string;
}

/**
 * Locate the owner of a pre-existing failure.
 *
 * The clean prefix proves the failure is not the AGENT's, but it cannot say
 * WHOSE it is: it is a synthetic commit, not a branch tip, and it already
 * contains the merge that is about to be abandoned — rooting a fix there would
 * commit the very merge being aborted, on a commit no branch points at, where
 * the fix reaches nobody. Two probes settle it, and the third outcome is not a
 * gate fix at all.
 */
export async function locateOwner(
  files: string[],
  branchTip: string,
  parentHead: string,
  probe: SubsetProbe,
  opts: {
    /**
     * Does this commit contain any of the files? A tip that does not have the
     * file cannot be failing in it, and asking a runner about a path it cannot
     * find produces a non-zero exit with nothing parseable rather than a verdict.
     * This is the COMMON case for the parent side: the failing test usually
     * arrived with the merge, so the branch tip predates it.
     */
    hasAnyFile?: (sha: string, files: string[]) => Promise<boolean>;
  } = {},
): Promise<OwnershipResult> {
  let probes = 0;
  /**
   * One side's answer. Rule 2 applies here too: a RED is conclusive on sight (a
   * tip that has no part of this merge cannot have been reddened by it), but a
   * GREEN must be seen twice before it is allowed to push ownership onward —
   * otherwise a single flaky pass at the branch tip promotes the claim to the
   * parent, or worse, to `interaction`, which widens the agent's edit scope and
   * tells it to fix a file nobody has a defect in.
   */
  const sideFailures = async (sha: string): Promise<{ failing: string[] | null; absent: boolean }> => {
    if (opts.hasAnyFile && !(await opts.hasAnyFile(sha, files))) return { failing: [], absent: true };
    const first = await probe({ kind: 'commit', sha }, files);
    probes++;
    if (!first.usable) return { failing: null, absent: false };
    const failing = files.filter((f) => (first.counts.get(f) ?? 0) > 0);
    if (failing.length > 0) return { failing, absent: false };
    const second = await probe({ kind: 'commit', sha }, files);
    probes++;
    if (!second.usable) return { failing: null, absent: false };
    return { failing: files.filter((f) => (second.counts.get(f) ?? 0) > 0), absent: false };
  };

  const bt = await sideFailures(branchTip);
  if (bt.failing === null) {
    return {
      owner: 'unknown',
      ref: null,
      files,
      probes,
      detail: `the branch tip ${branchTip.slice(0, 12)} could not be built — ownership undetermined`,
    };
  }
  if (bt.failing.length > 0) {
    return {
      owner: 'branch',
      ref: branchTip,
      files: bt.failing,
      probes,
      detail: `already red at the branch tip ${branchTip.slice(0, 12)} — the branch owns this`,
    };
  }
  const ph = await sideFailures(parentHead);
  if (ph.failing === null) {
    return {
      owner: 'unknown',
      ref: null,
      files,
      probes,
      detail: `the parent head ${parentHead.slice(0, 12)} could not be built — ownership undetermined`,
    };
  }
  if (ph.failing.length > 0) {
    return {
      owner: 'parent',
      ref: parentHead,
      files: ph.failing,
      probes,
      // Rooting here is what stops the same red being fixed once per descendant:
      // the parent propagates to all of them, a fix on this branch to none.
      detail: `green at the branch tip but red at the parent head ${parentHead.slice(0, 12)} — the incoming side owns this`,
    };
  }
  const absent = [bt.absent ? 'the branch tip' : '', ph.absent ? 'the parent head' : ''].filter(Boolean).join(' and ');
  return {
    owner: 'interaction',
    ref: null,
    files,
    probes,
    detail:
      'green on BOTH sides in isolation and red once merged — nobody upstream owns this; ' +
      `it is this merge’s own defect and belongs in this case${absent ? ` (the files do not exist at ${absent})` : ''}`,
  };
}

/**
 * How far back to look for a green anchor, in first-parent steps. Exponential
 * because there is no anchor to start from: `branch-check` only ever typechecks,
 * `finish`'s verify is the sole test run and its journal is wiped by `start`, so
 * the last commit known to pass the failing test is unknown and may be hundreds
 * back. Doubling finds a window in a handful of probes and bounds the worst case.
 */
const WALK_BACK_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** Hard ceiling on subset runs for one search. Bounds a pathological history. */
const BISECT_PROBE_BUDGET = 24;

export interface BisectOutcome {
  status:
    /** Converged: `sha` is the first commit where the failure appears. */
    | 'found'
    /** The failure does not reproduce consistently — nothing to bisect. */
    | 'flaky'
    /** No green commit within the walk-back: the failure predates the window. */
    | 'no-anchor'
    /** Ran out of probe budget, or every candidate was unbuildable. */
    | 'inconclusive';
  sha?: string;
  /** The green commit the search worked forward from. */
  anchor?: string;
  probes: number;
  /** Commits in the searched window. */
  scanned?: number;
  /**
   * The OLDEST commit actually OBSERVED failing. Always set once anything was
   * seen red, whatever the status.
   *
   * This is what an inconclusive search still knows, and it is enough to root a
   * gate fix (owner, 2026-08-04): rooting at the oldest confirmed-red point puts
   * the fix as far down the history as the evidence supports, so branches that
   * share that ancestor can take one fix instead of one each. It is NOT a claim
   * about where the defect was introduced — for an unstable failure it is
   * merely the oldest place the search happened to CATCH it, and the PR text
   * must say so rather than dress a lower bound up as a bisect result.
   */
  lastFailed?: string;
  /** Whether the probes ran the failing command whole (see `findIntroducingCommit`). */
  usedFullCommand?: boolean;
  /** One line, agent- and PR-facing. */
  detail: string;
}

/**
 * Find the commit that introduced a failure, so the gate-fix case can name it.
 *
 * The point is not blame for its own sake: the agent is handed a case whose
 * briefing otherwise says only "this branch is red, here is a log". A commit
 * gives it a diff to read and the owner a reviewable claim, and it names the
 * branch that actually introduced the defect rather than the one where it
 * surfaced — the difference between fixing it once and fixing it in every
 * descendant.
 */
export async function findIntroducingCommit(
  tip: string,
  files: string[],
  probe: SubsetProbe,
  history: History,
  /**
   * The same probe with NO file narrowing. A load-dependent failure exists only
   * under whole-suite load, so the narrowed form cannot see it and the
   * determinism gate below rejects it as unstable — which is precisely the class
   * this search exists for. Live 2026-08-03: `poll-loop.test.ts` (5000 ms
   * internal deadline under a 5000 ms runner timeout) passed twice narrowed at
   * the tip, and a real, reproducible failure was written off as a coin flip.
   * Only the FAILED command re-runs, so the fallback costs seconds per probe.
   */
  fullProbe?: SubsetProbe,
  /**
   * The OLDEST commit the search may consider — the current trunk head (owner,
   * 2026-08-04). Below this line history is shared and already integrated, so a
   * fix rooted there drags every intervening divergence with it: live, a bisect
   * named a commit 299 behind the branch tip, and the case worktree became a
   * three-week-old tree whose suite was red in a second, unrelated file nobody
   * had fixed yet. The agent could not win — one test in scope, a whole
   * pre-history demanded green.
   *
   * Bounding the SEARCH rather than clamping its answer afterwards is the honest
   * version: it never spends probes on commits whose answer we would refuse, and
   * for a gate fix ON the trunk the window is empty, so it returns immediately
   * instead of paying eight probes to be overruled.
   */
  floor?: string,
): Promise<BisectOutcome> {
  let probes = 0;
  const red = (r: ProbeResult): boolean => files.some((f) => (r.counts.get(f) ?? 0) > 0);
  // The OLDEST commit observed red — the fallback root when the search cannot
  // name an introducer. No ordering bookkeeping is needed: the walk-back probes
  // strictly older commits each step, and the binary search only ever moves its
  // known-red bound `hi` DOWN (older), so a plain overwrite at each red
  // observation always holds the oldest one.
  let lastFailed: string | undefined;

  // Determinism first. Bisecting a coin flip converges on a random commit and
  // presents it as the cause — worse than no answer, because it reads as one.
  let active = probe;
  let usedFullCommand = false;
  let t1 = await probe({ kind: 'commit', sha: tip }, files);
  probes++;
  if (!t1.usable) {
    return { status: 'inconclusive', probes, detail: `the tip ${tip.slice(0, 12)} could not be built` };
  }
  let t2 = await probe({ kind: 'commit', sha: tip }, files);
  probes++;
  if ((!red(t1) || !red(t2)) && fullProbe) {
    // Not reproducible NARROWED — try the whole command before calling it
    // unstable. If it reproduces twice this way, the search is valid; it just
    // has to run every probe the same way, or the halves are not comparable.
    const f1 = await fullProbe({ kind: 'commit', sha: tip }, files);
    probes++;
    const f2 = f1.usable ? await fullProbe({ kind: 'commit', sha: tip }, files) : f1;
    if (f1.usable) probes++;
    if (f1.usable && f2.usable && red(f1) && red(f2)) {
      active = fullProbe;
      usedFullCommand = true;
      t1 = f1;
      t2 = f2;
    }
  }
  if (!red(t1) || !red(t2)) {
    return {
      status: 'flaky',
      probes,
      usedFullCommand,
      // The tip IS a confirmed failure — the checks gate just reported it — so it
      // is a valid root even though the search cannot narrow further.
      lastFailed: tip,
      detail:
        `${files.join(', ')} does not fail consistently at ${tip.slice(0, 12)}` +
        `${fullProbe ? ' (narrowed or whole)' : ''} — no commit can be named as its cause; the check is unstable`,
    };
  }
  lastFailed = tip;

  // Walk back for a green anchor.
  //
  // ABSENCE OF THE FILE IS A GREEN BOUNDARY, not a skip. A commit that predates
  // the failing file cannot be failing in it — that is a stronger statement than
  // any test run, and it is the COMMON history ("someone added a failing test").
  // Skipping those instead, as the first cut did, left every ancestor of such an
  // addition unprobed and reported `no-anchor` for a commit the search can name
  // exactly. What must never be read as green is a tree that HAS the file and
  // could not be built — that one is skipped below.
  let anchor: string | null = null;
  let hitFloor = false;
  const aboveFloor = async (sha: string): Promise<boolean> => {
    if (!floor || !history.contains) return true;
    if (sha === floor) return true;
    return history.contains(sha, floor);
  };
  for (const step of WALK_BACK_STEPS) {
    if (probes >= BISECT_PROBE_BUDGET) break;
    const sha = await history.ancestor(tip, step);
    if (!sha) break;
    // At or below the floor: stop. Everything older is shared history the fix
    // must not be rooted in, so probing it could only produce a refused answer.
    if (!(await aboveFloor(sha))) {
      hitFloor = true;
      break;
    }
    if (!(await history.hasAnyFile(sha, files))) {
      anchor = sha;
      break;
    }
    const r = await active({ kind: 'commit', sha }, files);
    probes++;
    if (!r.usable) continue;
    if (red(r)) lastFailed = sha; // walking back: each red is older than the last
    if (!red(r)) {
      // Rule 2 at the anchor: a single flaky pass here poisons the entire search
      // — everything after it is bisected inside a window whose lower bound is
      // wrong, and the result is a confidently named innocent commit.
      const again = await active({ kind: 'commit', sha }, files);
      probes++;
      if (again.usable && red(again)) lastFailed = sha;
      if (again.usable && !red(again)) {
        anchor = sha;
        break;
      }
    }
  }
  if (!anchor) {
    return {
      status: 'no-anchor',
      probes,
      lastFailed,
      usedFullCommand,
      detail: hitFloor
        ? `${files.join(', ')} already fails at the trunk head — the failure predates this branch's own history, ` +
          `so there is no commit HERE that introduced it and the fix belongs at the tip`
        : `no commit in the last ${WALK_BACK_STEPS[WALK_BACK_STEPS.length - 1]} first-parent commits passes ` +
          `${files.join(', ')} — the failure predates the search window`,
    };
  }

  // Binary search the window. `anchor` is green, `tip` is red, so the first red
  // commit exists inside it.
  const commits = await history.listFirstParent(anchor, tip);
  if (commits.length === 0) {
    return { status: 'inconclusive', anchor, probes, lastFailed, usedFullCommand, detail: 'the search window came back empty' };
  }
  let lo = 0;
  let hi = commits.length - 1;
  while (lo < hi) {
    if (probes >= BISECT_PROBE_BUDGET) {
      return {
        status: 'inconclusive',
        anchor,
        probes,
        scanned: commits.length,
        lastFailed,
        usedFullCommand,
        detail: `probe budget (${BISECT_PROBE_BUDGET}) spent with the window narrowed to ${hi - lo + 1} commits`,
      };
    }
    // An unbuildable candidate is skipped, not counted — try later commits
    // first (keeps the window shrinking), then earlier ones.
    //
    // Candidates stop at `hi - 1`: `commits[hi]` is ALREADY KNOWN RED (the tip,
    // or whatever the last red probe set it to), so probing it again learns
    // nothing and re-assigns `hi = hi`. With `hi` in the candidate list, a run of
    // unbuildable commits below it made every iteration pick `hi`, leave the
    // window unchanged, and spin until the probe budget ran out — reported as
    // `inconclusive` for a history the search could actually resolve.
    let mid = (lo + hi) >> 1;
    let r: ProbeResult | null = null;
    let exhausted = false;
    let missing: number | null = null;
    for (const cand of [...range(mid, hi - 1), ...range(mid - 1, lo, -1)]) {
      if (probes >= BISECT_PROBE_BUDGET) {
        exhausted = true;
        break;
      }
      // The file does not exist here, so it cannot fail here: a green boundary,
      // exactly as in the walk-back. Treated as a skip it would stall the search
      // over any range that adds the file.
      if (!(await history.hasAnyFile(commits[cand], files))) {
        missing = cand;
        break;
      }
      const attempt = await active({ kind: 'commit', sha: commits[cand] }, files);
      probes++;
      if (attempt.usable) {
        mid = cand;
        r = attempt;
        break;
      }
    }
    if (missing !== null) {
      lo = missing + 1;
      continue;
    }
    if (!r) {
      return {
        status: 'inconclusive',
        anchor,
        probes,
        scanned: commits.length,
        lastFailed,
        usedFullCommand,
        // These are different failures and an operator acts on them differently:
        // a spent budget means "the history is long", an unbuildable window means
        // "these commits cannot be checked out and tested at all".
        detail: exhausted
          ? `probe budget (${BISECT_PROBE_BUDGET}) spent with the window narrowed to ${hi - lo + 1} commits`
          : `no buildable commit in the remaining window of ${hi - lo + 1}`,
      };
    }
    if (red(r)) {
      hi = mid;
      lastFailed = commits[mid]; // `hi` only ever moves DOWN, so this is the oldest red
    } else lo = mid + 1;
  }
  return {
    status: 'found',
    sha: commits[lo],
    anchor,
    probes,
    scanned: commits.length,
    lastFailed: lastFailed ?? commits[lo],
    usedFullCommand,
    // `red` is ANY of the files, so with several the answer is the first commit
    // where the first of them appears — say that rather than implying all.
    detail:
      `${commits[lo].slice(0, 12)} is the first commit where ` +
      (files.length === 1 ? `${files[0]} fails` : `any of ${files.join(', ')} fails`),
  };
}

/** Inclusive integer range, ascending or descending. */
function range(from: number, to: number, step = 1): number[] {
  const out: number[] = [];
  if (step > 0) for (let i = from; i <= to; i += step) out.push(i);
  else for (let i = from; i >= to; i += step) out.push(i);
  return out;
}
