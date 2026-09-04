/**
 * scripts/sweep/deps-missing.ts — the MISSING-DECLARATION advance (DRIVER.md §7.7).
 *
 * A propagation walk enumerates the whole DAG, both parents, so a branch can
 * come to rest on a commit INSIDE an unmerged upstream feature branch — a
 * work-in-progress state upstream never intended to be consumable. When that
 * state carries a file whose imports name declarations the branch has not
 * reached yet, the checker says the symbol does not exist and there is no
 * correct-and-green resolution at that height: the declaration is real, it is
 * simply further along the same line the branch is walking.
 *
 * A MISSING-SYMBOL ERROR IS NEVER A LICENCE TO AUTHOR THE SYMBOL. Handed to an
 * agent as a gate fix, that red produces a reinvention of a function that
 * already exists elsewhere in the chain, wired to nothing, which the real one
 * collides with the moment the walk reaches it. So the driver ADVANCES THE WALK
 * TOWARD THE DECLARATION instead of asking anyone to write it.
 *
 * The mechanism is language-agnostic: what counts as a missing-declaration
 * diagnostic is the REPO'S business, declared per command as `missingDeclRe` in
 * checks.json. A command with no pattern never takes this path.
 */
import { parseFailureFingerprints } from './attribute.js';
import type { VerifyCommand } from './verify.js';

/**
 * How far the advance may walk before it stops and reports.
 *
 * An UNBOUNDED advance lets a single compile error consume a whole pass: each
 * step is a merge plus a fresh worktree plus an install plus a check run, and a
 * line whose declaration never arrives would spend all of them. Ten steps is
 * enough to cross the reconciliation window this exists for (upstream split a
 * function and reconciled it a handful of commits later) and small enough that
 * the worst case is bounded work with a report at the end of it.
 */
export const DEPS_MISSING_ADVANCE_LIMIT = 10;

/** The classification of one red landing against the repo's own patterns. */
export interface DepsMissingVerdict {
  /** Every failing command matched, and the matched lines name a comparable error set. */
  depsMissing: boolean;
  /**
   * THE ORIGINAL ERROR SET — the termination condition of the advance, as
   * `fingerprintKeys` spells it. A tsc key is `ts <file> <TSCODE> <message>`:
   * no line and no column, so an unrelated edit above the import does not look
   * like a different error.
   */
  errorKeys: string[];
  /** The paths the matched diagnostics name — the advance's pathspec. */
  files: string[];
  /** The matched lines themselves, for the journal and the draft PR body. */
  lines: string[];
  /** Why this is (or is not) a deps-missing red, in one sentence. */
  reason: string;
}

/**
 * Split a checks run's output into per-command blocks on the `$ <cmd>` headers
 * `defaultChecksRunner` writes. A block with no header belongs to no command
 * and is dropped: the classification below is PER COMMAND, and attributing
 * unheaded text to an arbitrary one of them would let a single command's
 * pattern speak for a command that declared none.
 */
export function splitChecksOutput(output: string, commands: readonly VerifyCommand[]): Map<string, string> {
  const known = new Set(commands.map((c) => c.cmd));
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('$ ') && known.has(line.slice(2))) {
      current = line.slice(2);
      if (!blocks.has(current)) blocks.set(current, []);
      continue;
    }
    if (current !== null) blocks.get(current)!.push(line);
  }
  // ONE FAILING COMMAND AND NO HEADERS is unambiguous — the whole output is
  // its own. More than one, and it is not, so nothing is attributed.
  if (blocks.size === 0 && commands.length === 1) return new Map([[commands[0].cmd, output]]);
  return new Map([...blocks].map(([cmd, lines]) => [cmd, lines.join('\n')]));
}

/** The command's pattern, compiled; null when it declares none or declares a broken one. */
export function missingDeclPattern(cmd: VerifyCommand): RegExp | null {
  if (typeof cmd.missingDeclRe !== 'string' || cmd.missingDeclRe === '') return null;
  try {
    return new RegExp(cmd.missingDeclRe);
  } catch {
    // AN UNCOMPILABLE PATTERN CLASSIFIES NOTHING. Treating it as "matches
    // everything" would route every red down the advance; treating it as
    // "matches nothing" is the same answer a command with no pattern gives,
    // which is the behaviour of a repo that never named its diagnostics.
    return null;
  }
}

/**
 * IS THIS RED A MISSING DECLARATION? Yes only when EVERY failing command that
 * ran has at least one output line matching its own `missingDeclRe`, and no
 * failing command lacks such a match — one ordinary failure alongside them
 * means the tree is broken in a way the advance cannot speak to.
 *
 * FAIL-CLOSED at every step where the answer would have to be guessed: a
 * command with no pattern, a command whose block cannot be found, matched lines
 * that yield no fingerprints, fingerprints that name no file. Each of those
 * leaves the red on the ordinary gate-fix path, which is where a red the driver
 * cannot characterise belongs.
 *
 * `output` must be the RE-ROOTED output (`rootChecksOutput`), for the same
 * reason blame reads it: a runner printing paths from its own cwd and the
 * pathspec below are otherwise talking about different files.
 */
export function classifyDepsMissing(failed: readonly VerifyCommand[], output: string): DepsMissingVerdict {
  const empty = { depsMissing: false as const, errorKeys: [], files: [], lines: [] };
  if (failed.length === 0) return { ...empty, reason: 'no failing command to classify' };
  const blocks = splitChecksOutput(output, failed);
  const matched: string[] = [];
  for (const cmd of failed) {
    const re = missingDeclPattern(cmd);
    if (!re) return { ...empty, reason: `\`${cmd.cmd}\` declares no missingDeclRe` };
    const block = blocks.get(cmd.cmd);
    if (block === undefined) return { ...empty, reason: `no output block for \`${cmd.cmd}\`` };
    const hits = block.split('\n').filter((l) => re.test(l));
    if (hits.length === 0) return { ...empty, reason: `\`${cmd.cmd}\` reports failures that are not missing declarations` };
    matched.push(...hits);
  }
  const fps = parseFailureFingerprints(matched.join('\n'));
  if (fps.length === 0) {
    return { ...empty, lines: matched, reason: 'the missing-declaration lines yield no comparable error signature' };
  }
  const files = [...new Set(fps.map((f) => f.file).filter(Boolean))].sort();
  if (files.length === 0) {
    return { ...empty, lines: matched, reason: 'the missing-declaration lines name no file to walk toward' };
  }
  return {
    depsMissing: true,
    errorKeys: [...new Set(fps.map((f) => f.key))].sort(),
    files,
    lines: matched,
    reason: `every failing command reports a missing declaration in ${files.join(', ')}`,
  };
}

/**
 * Which of `originalKeys` a later run still reports. Read against the WHOLE
 * output of the re-run, not against its missing-declaration lines alone: the
 * question is whether the original errors are still there, and an error that
 * stopped matching the pattern has still not gone away.
 */
export function survivingKeys(originalKeys: readonly string[], output: string): string[] {
  const now = new Set(parseFailureFingerprints(output).map((f) => f.key));
  return originalKeys.filter((k) => now.has(k));
}

/** What one advance step did, and what the tree said afterwards. */
export interface AdvanceStep {
  sha: string;
  verdict: 'original-persists' | 'original-cleared' | 'already-contained' | 'conflict' | 'unmeasured';
  /** The branch tip after the step (absent when nothing landed). */
  tip?: string;
  /** Original keys still reported after this step. */
  surviving?: string[];
  /** The re-run was green (no failing command at all). */
  green?: boolean;
  conflictedPaths?: string[];
  detail?: string;
}

/**
 * Why the walk stopped without clearing the original set. Each is a fact about
 * the walk, and each ends it: a bound that was reached, a source with nothing
 * left in it, a step that cannot be landed, a step that cannot be measured.
 */
export type AdvanceStop = 'bound-reached' | 'source-exhausted' | 'conflict' | 'unmeasured';

export type AdvanceOutcome =
  /** The original set emptied and the tree is green — the propagation repaired it. */
  | { kind: 'repaired'; steps: AdvanceStep[]; candidates: string[]; bounded: boolean; tip: string }
  /** The original set emptied and something else is red — an ordinary red now. */
  | { kind: 'changed'; steps: AdvanceStep[]; candidates: string[]; bounded: boolean; tip: string }
  /** The walk ended with the original errors still present. */
  | {
      kind: 'exhausted';
      steps: AdvanceStep[];
      candidates: string[];
      bounded: boolean;
      stop: AdvanceStop;
      /** The first tip in the walk that carried the original errors. */
      firstErrored: string;
    };

/** The git + checks work one advance needs, injected so the algorithm is testable. */
export interface AdvanceOps {
  /** Pending commits over the sources that touch `files`, oldest-first. */
  candidates(files: readonly string[]): Promise<string[]>;
  /** Is `sha` already an ancestor of the branch tip? */
  alreadyContained(sha: string): Promise<boolean>;
  /** Merge ONE commit into the branch; the new tip, or why it would not land. */
  step(sha: string): Promise<{ tip: string } | { conflictedPaths: string[]; detail?: string }>;
  /**
   * Re-run ONLY the failing commands at the current tip. Null when the tree
   * could not be measured at all (no environment) — never read as green.
   */
  recheck(tip: string): Promise<{ ok: boolean; output: string } | null>;
}

/**
 * WALK TOWARD THE DECLARATION, ONE COMMIT AT A TIME, AND STOP THE MOMENT THE
 * QUESTION CHANGES.
 *
 * Candidates are the pending commits that touch the FAILING PATHS, bounded by
 * `limit`. Each step lands one commit and re-runs the failing commands alone —
 * the whole battery would pay for a question nobody asked.
 *
 * A CONFLICT ENDS THE ADVANCE. A resolution cannot be validated while the tree
 * is red: the checks that would judge it are the ones already failing, so any
 * resolution is unfalsifiable at that height.
 *
 * THE ORIGINAL ERROR SET IS THE TERMINATION CONDITION. While it survives, the
 * walk is still answering the question it started on. The moment it is empty
 * the question has changed — a red that has changed identity is a different
 * question, and this walk has no standing to keep answering it.
 */
export async function advanceThroughDepsMissing(opts: {
  startTip: string;
  originalKeys: readonly string[];
  files: readonly string[];
  ops: AdvanceOps;
  limit?: number;
  onStep?: (step: AdvanceStep) => void;
}): Promise<AdvanceOutcome> {
  const limit = opts.limit ?? DEPS_MISSING_ADVANCE_LIMIT;
  const all = await opts.ops.candidates(opts.files);
  const candidates = all.slice(0, limit);
  const bounded = all.length > candidates.length;
  const steps: AdvanceStep[] = [];
  /**
   * The first tip in this walk that carried the original errors. The walk
   * starts on a CONFIRMED red and continues only while those errors survive,
   * so every tip it visits carries them and the earliest is the one it started
   * on — read straight off the walk, with nothing bisected.
   */
  const firstErrored = opts.startTip;
  let tip = opts.startTip;
  const record = (step: AdvanceStep): void => {
    steps.push(step);
    opts.onStep?.(step);
  };
  const end = (stop: AdvanceStop): AdvanceOutcome => ({
    kind: 'exhausted',
    steps,
    candidates,
    bounded,
    stop,
    firstErrored,
  });
  for (const sha of candidates) {
    // A candidate the earlier steps' merges already dragged in changes nothing
    // and is not worth a check run — the pathspec listed it, the DAG delivered
    // it.
    if (await opts.ops.alreadyContained(sha)) {
      record({ sha, verdict: 'already-contained', tip });
      continue;
    }
    const landed = await opts.ops.step(sha);
    if ('conflictedPaths' in landed) {
      record({
        sha,
        verdict: 'conflict',
        tip,
        conflictedPaths: landed.conflictedPaths,
        ...(landed.detail ? { detail: landed.detail } : {}),
      });
      return end('conflict');
    }
    tip = landed.tip;
    const run = await opts.ops.recheck(tip);
    if (run === null) {
      record({ sha, verdict: 'unmeasured', tip, detail: 'the advanced tip could not be measured' });
      return end('unmeasured');
    }
    const surviving = survivingKeys(opts.originalKeys, run.output);
    if (surviving.length > 0) {
      record({ sha, verdict: 'original-persists', tip, surviving, green: false });
      continue;
    }
    record({ sha, verdict: 'original-cleared', tip, surviving: [], green: run.ok });
    return { kind: run.ok ? 'repaired' : 'changed', steps, candidates, bounded, tip };
  }
  // Every candidate is spent, and the original errors are still there.
  return end(bounded ? 'bound-reached' : 'source-exhausted');
}

/**
 * The identifiers a diagnostic names, best-effort: single-quoted words that
 * look like identifiers. Module specifiers (`'./request.js'`, `'"./x.js"'`) do
 * not match, which is the point — the question below is about a SYMBOL.
 *
 * Best-effort is enough because every caller omits its claim when this yields
 * nothing. A guess in a PR body an owner reads is worse than a shorter body.
 */
export function namedSymbols(lines: readonly string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g)) out.add(m[1]);
  }
  return [...out].sort();
}
