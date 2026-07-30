/**
 * scripts/sweep/verify.ts — everything-rebuild + test-matrix runner.
 *
 * Rebuilds the throwaway integration target from the recipe (ordered branch
 * list) in a TEMPORARY worktree: seed the recorded rerere cache (D-051), reset
 * --hard to the base ref, then sequential merges with rerere. Then runs the CI
 * command list (injectable — fixture tests use `true`/`false` stubs instead of
 * the real matrix). The recipe + base are the caller's (cmdVerify passes THIS
 * PASS'S publishable set, DAG-ordered, on the fork-trunk base per D-051; the
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

import { VERIFY_COMMANDS } from './config.js';
import { addTempWorktree, git } from './git.js';
import { installRrCache } from './merge.js';

const execFileP = promisify(execFile);

export interface VerifyCommand {
  cmd: string;
  cwd?: string;
}

export interface CommandResult {
  cmd: string;
  code: number;
  outputTail: string;
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
}

export interface VerifyOptions {
  baseRef?: string;
  recipe: string[];
  commands?: VerifyCommand[];
  /** Attribution rebuild attempts cap (default: recipe length). */
  maxAttribution?: number;
  /**
   * Workspace rr-cache directory (D-051): installed into `.git/rr-cache` BEFORE
   * the recipe build so the rebuild replays the sweep's RECORDED resolutions
   * (the same install the driver's own merges do), not merely whatever preimages
   * happen to already live in the shared cache. Null/omitted → no seeding (fixtures).
   */
  rrCacheDir?: string | null;
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
    results.push({ cmd, code, outputTail: output.slice(-4000) });
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
  // D-051 defense in depth: seed the shared rerere cache (common git dir, so the
  // temp worktree's merges see it) with the sweep's recorded resolutions before
  // the rebuild — otherwise a would-be conflict that WAS resolved this pass
  // could reappear in the recipe build and mis-attribute a false offender.
  await installRrCache(repo, opts.rrCacheDir ?? null);
  const wt = await addTempWorktree(repo, baseRef);
  try {
    const first = await buildAndTest(repo, wt.path, baseRef, opts.recipe, commands);
    if (first.green) return { ok: true, build: first.build, commands: first.commands };
    // A merge conflict in the recipe is directly attributable.
    if (!first.build.ok) {
      return { ok: false, build: first.build, commands: first.commands, offender: first.build.conflictBranch };
    }
    const maxTries = Math.min(opts.maxAttribution ?? opts.recipe.length, opts.recipe.length);
    const candidates = [...opts.recipe].reverse().slice(0, maxTries);
    for (const candidate of candidates) {
      const reduced = opts.recipe.filter((b) => b !== candidate);
      const attempt = await buildAndTest(repo, wt.path, baseRef, reduced, commands);
      if (attempt.green) {
        return { ok: false, build: first.build, commands: first.commands, offender: candidate };
      }
    }
    return { ok: false, build: first.build, commands: first.commands, attributionFailed: true };
  } finally {
    await wt.remove();
  }
}
