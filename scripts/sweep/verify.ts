/**
 * scripts/sweep/verify.ts — everything-rebuild + test-matrix runner.
 *
 * Rebuilds the throwaway integration target from the recipe (ordered branch
 * list) in a TEMPORARY worktree: seed the recorded rerere cache (DRIVER.md
 * §10.2), reset
 * --hard to the base ref, then sequential merges with rerere. Then runs the CI
 * command list (injectable — fixture tests use `true`/`false` stubs instead of
 * the real matrix). The recipe + base are the caller's (cmdVerify passes THIS
 * PASS'S publishable set, DAG-ordered, on the fork-trunk base; the
 * static sweep-scope.yaml `recipe` is only a planless fallback). On failure,
 * attributes the breakage by re-building with one
 * recipe branch removed at a time (reverse recipe order); the offender is
 * reported so the caller can roll it back to its journaled pre-ref and demote
 * it to a gate-PoI (the propagation driver's §9 gate does exactly that). The `everything` branch itself is NEVER committed to,
 * reset, or pushed — the rebuild happens only in the temp worktree.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parseFailingFiles } from './attribute.js';
import { VERIFY_COMMANDS } from './config.js';
import { addTempWorktree, git } from './git.js';
import { installRrCache } from './merge.js';

const execFileP = promisify(execFile);

export interface VerifyCommand {
  cmd: string;
  cwd?: string;
  /**
   * How to run this command over a SUBSET of files — a template whose `{files}`
   * placeholder is replaced by the cwd-relative paths to re-run (e.g.
   * `bun test {files}`). Optional: a command without one is simply re-run whole.
   *
   * This is what makes re-probing affordable. The not-my-bug comparison and the
   * bisect below it run the failing checks a dozen or more times across
   * different trees; at full-suite cost that is minutes per probe and the whole
   * mechanism is unaffordable, while one test file is seconds. Nothing else
   * about the command list changes — verify and the case gate still run the
   * full `cmd`.
   */
  filter?: string;
  /**
   * The regular expression that tells a MISSING DECLARATION apart from every
   * other way this command can fail — `error TS(2305|2307|2724):` for a
   * TypeScript project, whatever names the same class for another toolchain.
   *
   * The mechanism (deps-missing.ts) is language-agnostic; WHICH diagnostics
   * mean "the declaration is not here" is the repo's business, so the repo
   * states it beside the command that emits them. A command with no pattern
   * never takes the advance path: the driver cannot recognise the class and
   * does not guess at one.
   *
   * NAME ONLY CODES THAT CANNOT MEAN ANYTHING ELSE. A matching diagnostic sends
   * its whole red down a bounded walk and, when the walk comes up empty, parks
   * the branch on an owner's draft with no agent served — so a code that ALSO
   * fires on ordinary defects buys that outcome for a typo. `TS2339` ("Property
   * X does not exist on type Y") is the example that does not belong: a
   * misspelled property and a semantic merge skew both report it.
   */
  missingDeclRe?: string;
}

export interface CommandResult {
  cmd: string;
  code: number;
  /**
   * The command's FULL stdout+stderr — deliberately uncapped.
   *
   * This was `outputTail: output.slice(-4000)`, and that truncation was the ONLY
   * copy kept. Blame (`attributeFailure` → `parseFailingFiles`) is a pure text
   * scrape, so its whole view of "what failed" is this string: files whose
   * diagnostics fell outside the window could not be attributed at all, and a
   * gate-fix case ended up scoped to whichever files happened to land in the
   * last 4000 characters. `.slice()` also cut mid-line, so the first surviving
   * line was a severed fragment.
   *
   * Capping belongs at the DISPLAY boundary (what the agent is handed), not at
   * CAPTURE — see `boundedChecksOutput` / `failureSummary` in propagate.ts,
   * which bound the view and leave the full log on disk.
   */
  output: string;
}

export interface RecipeBuildResult {
  ok: boolean;
  merged: string[];
  /** Branch whose merge left unresolved conflicts (build stops there). */
  conflictBranch?: string;
  unresolved?: string[];
}

export interface VerifyResult {
  ok: boolean;
  build: RecipeBuildResult;
  commands: CommandResult[];
  /** Branch whose removal turns the matrix green (rollback + gate candidate). */
  offender?: string;
  /** No single-branch removal fixed it. */
  attributionFailed?: boolean;
  /**
   * The SAME tree gave a different verdict on a second run — the failure is
   * non-deterministic and belongs to no branch.
   *
   * Attribution assumes determinism: it removes one branch at a time and calls
   * the one whose removal turns the matrix green the offender. Under a flaky
   * test that logic blames whichever branch happened to be out when the test
   * passed — an innocent branch rolled back and a gate fix minted against a
   * defect that is not there, with a DIFFERENT branch blamed on every rerun.
   */
  nonDeterministic?: boolean;
  /** Which commands disagreed between the two identical runs. */
  flakyCommands?: string[];
  /**
   * The failure reproduces on the BASE ALONE, with no recipe branch merged.
   *
   * Then no branch caused it and none may be rolled back. Leave-one-out cannot
   * see this: removing a branch never fixes a defect that is already in the
   * base, so attribution either blames whoever happens to flip the matrix or
   * reports "no clean attribution" — and the pass peels one innocent branch
   * per run before it ever reaches the real cause.
   */
  baseRed?: boolean;
  /** The base-alone failure output, for blame + the gate-fix case materials. */
  baseCommands?: CommandResult[];
  /**
   * What the base probe SAW, recorded on every red whether or not it fired.
   *
   * Without this, "the probe ran and the base was clean" and "the probe never
   * ran" look identical from the journal, and the only way to tell an honest
   * attribution from a missed base defect is to re-run the whole thing by hand.
   * The verdict is a judgement about two file sets; both belong in the record.
   */
  baseFailingFiles?: string[];
  mergedFailingFiles?: string[];
  /**
   * Did the BASE ALONE pass? The single fact that makes an attribution
   * auditable: "this branch broke it" is only credible if the base was green.
   *
   * The file lists above are not enough on their own — both come back empty
   * when the runner's output names no file the parser recognises, and an empty
   * pair reads identically whether the base was clean or red-but-unparseable.
   */
  baseGreen?: boolean;
  /** Commands that failed on the base alone (empty when the base was green). */
  baseFailedCommands?: string[];
}

export interface VerifyOptions {
  baseRef?: string;
  recipe: string[];
  commands?: VerifyCommand[];
  /** Attribution rebuild attempts cap (default: recipe length). */
  maxAttribution?: number;
  /**
   * Workspace rr-cache directory (DRIVER.md §10.2): installed into `.git/rr-cache` BEFORE
   * the recipe build so the rebuild replays the sweep's RECORDED resolutions
   * (the same install the driver's own merges do), not merely whatever preimages
   * happen to already live in the shared cache. Null/omitted → no seeding (fixtures).
   */
  rrCacheDir?: string | null;
  /**
   * Prepare the freshly-created temp worktree before anything is built in it.
   *
   * A `git worktree add` checkout holds TRACKED FILES ONLY — `node_modules` is
   * gitignored, so it is absent. Run `tsc` there without preparation and it has
   * no `@types/node` and no `vitest` and cannot compile on ANY pass: the
   * output is a wall of "Cannot find name 'process'" / "Cannot find module
   * 'vitest'" — which blame then attributes to whichever source files those
   * lines name, minting gate-fix cases for a defect that was never in the code.
   *
   * This worktree is base + every publishable branch MERGED, so its manifests
   * are the merged ones and only they can describe what it needs — the driver
   * installs from them (`installDeps`).
   *
   * Injected rather than imported: the installer lives in propagate.ts, which
   * imports THIS module. Omitted → no preparation (fixtures, whose stub commands
   * need no dependencies).
   */
  prepareWorktree?: (wtPath: string) => Promise<unknown>;
}

async function runRecipe(repo: string, wtPath: string, baseRef: string, recipe: string[]): Promise<RecipeBuildResult> {
  await git(repo, ['reset', '--hard', baseRef], { cwd: wtPath });
  await git(repo, ['clean', '-fdx', '--exclude=node_modules'], { cwd: wtPath });
  const merged: string[] = [];
  const rerereFlags = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'];
  for (const branch of recipe) {
    const res = await git(repo, [...rerereFlags, 'merge', '--no-edit', '-m', `verify: merge ${branch}`, branch], {
      cwd: wtPath,
      allowCodes: [1],
    });
    if (res.code !== 0) {
      const unresolved = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], { cwd: wtPath })).stdout
        .split('\n')
        .filter(Boolean);
      if (unresolved.length === 0) {
        await git(repo, [...rerereFlags, 'commit', '--no-edit', '--no-verify'], { cwd: wtPath });
      } else {
        await git(repo, ['merge', '--abort'], { cwd: wtPath });
        return { ok: false, merged, conflictBranch: branch, unresolved };
      }
    }
    merged.push(branch);
  }
  return { ok: true, merged };
}

async function runCommands(wtPath: string, commands: VerifyCommand[]): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const { cmd, cwd } of commands) {
    let code = 0;
    let output = '';
    try {
      const res = await execFileP('bash', ['-c', cmd], {
        cwd: cwd ? join(wtPath, cwd) : wtPath,
        maxBuffer: 64 * 1024 * 1024,
      });
      output = res.stdout + res.stderr;
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      code = typeof e.code === 'number' ? e.code : 1;
      output = (e.stdout ?? '') + (e.stderr ?? '');
    }
    results.push({ cmd, code, output });
    if (code !== 0) break;
  }
  return results;
}

async function buildAndTest(
  repo: string,
  wtPath: string,
  baseRef: string,
  recipe: string[],
  commands: VerifyCommand[],
): Promise<{ build: RecipeBuildResult; commands: CommandResult[]; green: boolean }> {
  const build = await runRecipe(repo, wtPath, baseRef, recipe);
  if (!build.ok) return { build, commands: [], green: false };
  const cmdResults = await runCommands(wtPath, commands);
  const green = cmdResults.every((r) => r.code === 0);
  return { build, commands: cmdResults, green };
}

/**
 * Full verification gate. Returns ok=true only when the recipe merges clean
 * AND every command exits 0. On red, tries to attribute the failure to one
 * recipe branch (reverse order) by rebuilding without it.
 */
export async function verifyEverything(repo: string, opts: VerifyOptions): Promise<VerifyResult> {
  const baseRef = opts.baseRef ?? 'main';
  const commands = opts.commands ?? VERIFY_COMMANDS;
  // Defense in depth (DRIVER.md §10.2): seed the shared rerere cache (common git dir, so the
  // temp worktree's merges see it) with the sweep's recorded resolutions before
  // the rebuild — otherwise a would-be conflict that WAS resolved this pass
  // could reappear in the recipe build and mis-attribute a false offender.
  await installRrCache(repo, opts.rrCacheDir ?? null);
  const wt = await addTempWorktree(repo, baseRef);
  try {
    // Dependencies FIRST: every command below runs in this worktree, and
    // without them the very first typecheck fails for want of `@types/node`
    // rather than for anything in the tree being verified.
    if (opts.prepareWorktree) await opts.prepareWorktree(wt.path);
    const first = await buildAndTest(repo, wt.path, baseRef, opts.recipe, commands);
    if (first.green) return { ok: true, build: first.build, commands: first.commands };
    // A merge conflict in the recipe is directly attributable.
    if (!first.build.ok) {
      return { ok: false, build: first.build, commands: first.commands, offender: first.build.conflictBranch };
    }
    // DETERMINISM PROBE, before attribution. Re-run the failing commands on the
    // very same tree: identical input, so a different verdict can only mean the
    // failure is non-deterministic. Attribution below is meaningless in that
    // case and actively harmful — it would blame whichever branch was removed
    // when the test happened to pass. Cheaper than attribution too (one rerun
    // versus one per recipe branch), so probing first also saves the wasted
    // sweep when the answer is "no branch did this".
    const failedFirst = first.commands.filter((c) => c.code !== 0).map((c) => c.cmd);
    const rerun = await runCommands(wt.path, commands);
    const failedAgain = new Set(rerun.filter((c) => c.code !== 0).map((c) => c.cmd));
    const flaky = failedFirst.filter((c) => !failedAgain.has(c));
    if (flaky.length > 0) {
      return {
        ok: false,
        build: first.build,
        commands: first.commands,
        nonDeterministic: true,
        flakyCommands: flaky,
      };
    }
    let baseSeen: string[] = [];
    let mergedSeen: string[] = [];
    let baseGreen = true;
    let baseFailedCommands: string[] = [];
    // BASE PROBE, before attribution. Rebuild the base ALONE (no recipe) and
    // re-run: a failure that reproduces there belongs to the base, and blaming
    // any branch for it is wrong by construction. Costs one build; attribution
    // costs one per recipe branch and would have been meaningless.
    //
    // It runs AFTER the determinism probe on purpose — that probe re-runs the
    // tree standing in the worktree, and this rebuild replaces it with the base.
    const baseOnly = await buildAndTest(repo, wt.path, baseRef, [], commands);
    baseGreen = baseOnly.green;
    baseFailedCommands = baseOnly.commands.filter((c) => c.code !== 0).map((c) => c.cmd);
    if (!baseOnly.green) {
      // SUBSET RULE, by FILE — the same test `--not-my-bug` adjudication uses.
      // Command granularity is useless here: `pnpm test` fails on both sides
      // whenever anything at all is red, so matching on the command name calls
      // every red base-caused, including one a branch really introduced. What
      // makes a red base-caused is that it brings NO failing file the base does
      // not already have.
      const filesOf = (rs: CommandResult[]): Set<string> =>
        new Set(rs.filter((c) => c.code !== 0).flatMap((c) => parseFailingFiles(c.output)));
      const baseFiles = filesOf(baseOnly.commands);
      const mergedFiles = filesOf(first.commands);
      // No parseable file on either side (an opaque command): fall back to the
      // command names, which is all the information there is.
      const baseCmds = new Set(baseOnly.commands.filter((c) => c.code !== 0).map((c) => c.cmd));
      const subsumed =
        mergedFiles.size === 0 && baseFiles.size === 0
          ? first.commands.some((c) => c.code !== 0 && baseCmds.has(c.cmd))
          : mergedFiles.size > 0 && [...mergedFiles].every((f) => baseFiles.has(f));
      baseSeen = [...baseFiles];
      mergedSeen = [...mergedFiles];
      if (subsumed) {
        return {
          ok: false,
          build: first.build,
          commands: first.commands,
          baseRed: true,
          baseCommands: baseOnly.commands,
          baseFailingFiles: baseSeen,
          mergedFailingFiles: mergedSeen,
          baseGreen,
          baseFailedCommands,
        };
      }
    } else {
      baseSeen = [];
      mergedSeen = [...new Set(first.commands.filter((c) => c.code !== 0).flatMap((c) => parseFailingFiles(c.output)))];
    }

    const maxTries = Math.min(opts.maxAttribution ?? opts.recipe.length, opts.recipe.length);
    const candidates = [...opts.recipe].reverse().slice(0, maxTries);
    for (const candidate of candidates) {
      const reduced = opts.recipe.filter((b) => b !== candidate);
      const attempt = await buildAndTest(repo, wt.path, baseRef, reduced, commands);
      if (attempt.green) {
        return {
          ok: false,
          build: first.build,
          commands: first.commands,
          offender: candidate,
          baseFailingFiles: baseSeen,
          mergedFailingFiles: mergedSeen,
          baseGreen,
          baseFailedCommands,
        };
      }
    }
    return {
      ok: false,
      build: first.build,
      commands: first.commands,
      attributionFailed: true,
      baseFailingFiles: baseSeen,
      mergedFailingFiles: mergedSeen,
      baseGreen,
      baseFailedCommands,
    };
  } finally {
    await wt.remove();
  }
}
