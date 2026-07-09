/**
 * scripts/sweep/merge.ts — DAG-ordered upstream propagation to per-branch
 * stop points, with a shared rerere cache.
 *
 * Per branch (parents before children): merge its stop point. Clean merges
 * on branches that are NOT checked out use plumbing only (merge-tree +
 * commit-tree + update-ref — the July-sweep technique). Conflicted merges
 * and checked-out branches use a worktree (existing one when the branch is
 * checked out and clean, else a temporary one) with rerere enabled;
 * rerere-auto-resolved conflicts count as clean but are surfaced as
 * annotate-PoIs of type rerere-replay. Unresolved conflicts abort the merge
 * and gate the branch. Pre-merge refs are recorded for rollback.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { RR_CACHE_DIR } from './config.js';
import {
  addTempWorktree,
  commitTreeMerge,
  git,
  gitCommonDir,
  newStyleMergeTree,
  revParse,
  worktreeBranches,
} from './git.js';
import { readRrCacheFiles } from './state.js';
import type { SweepState } from './types.js';

/** Branches the merge stage must never write to, regardless of scope/plan input. */
const PROTECTED_BRANCH_RE = /^(main|everything.*|design\/.*|docs\/.*|maint\/.*)$/;

export interface MergePlanItem {
  branch: string;
  stopPoint: string | null;
  preRef: string;
  action: 'merge' | 'up-to-date' | 'skip-frozen' | 'skip-no-stop-point' | 'skip-protected';
  method?: 'commit-tree' | 'worktree';
  worktree?: string | null;
  expectConflicts: string[];
}

export interface MergeOutcome extends MergePlanItem {
  result: 'merged' | 'noop' | 'gated' | 'skipped' | 'dirty-worktree';
  newRef?: string;
  /** Conflicted paths auto-resolved by rerere (annotate-PoI type rerere-replay). */
  rerereResolved?: string[];
  /** Unresolved conflict paths (gate). */
  unresolved?: string[];
}

export async function planMerges(
  repo: string,
  ordered: { branch: string; stopPoint: string | null; upToDate: boolean }[],
  state: SweepState,
): Promise<MergePlanItem[]> {
  const checkedOut = await worktreeBranches(repo);
  const plan: MergePlanItem[] = [];
  for (const { branch, stopPoint, upToDate } of ordered) {
    const preRef = await revParse(repo, branch);
    const bs = state.branches[branch];
    let action: MergePlanItem['action'];
    if (PROTECTED_BRANCH_RE.test(branch)) action = 'skip-protected';
    else if (bs?.status === 'frozen' || bs?.status === 'excluded') action = 'skip-frozen';
    else if (upToDate) action = 'up-to-date';
    else if (!stopPoint) action = 'skip-no-stop-point';
    else action = 'merge';
    let method: MergePlanItem['method'];
    let expectConflicts: string[] = [];
    if (action === 'merge' && stopPoint) {
      const probe = await newStyleMergeTree(repo, branch, stopPoint);
      expectConflicts = probe.conflictFiles;
      method = probe.clean && !checkedOut.has(branch) ? 'commit-tree' : 'worktree';
    }
    plan.push({
      branch,
      stopPoint,
      preRef,
      action,
      method,
      worktree: checkedOut.get(branch) ?? null,
      expectConflicts,
    });
  }
  return plan;
}

function collectRrCache(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

/** Install the shared rerere cache from the state branch into .git/rr-cache. */
export async function installRrCache(repo: string, stateBranch: string): Promise<number> {
  const files = await readRrCacheFiles(repo, stateBranch);
  const target = join(await gitCommonDir(repo), 'rr-cache');
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return Object.keys(files).length;
}

/** rr-cache entries in .git/rr-cache that are new/changed vs the given baseline. */
export async function exportRrCache(repo: string, baseline: Record<string, Buffer>): Promise<Record<string, Buffer>> {
  const current = collectRrCache(join(await gitCommonDir(repo), 'rr-cache'));
  const changed: Record<string, Buffer> = {};
  for (const [rel, content] of Object.entries(current)) {
    if (!baseline[rel] || !baseline[rel].equals(content)) changed[`${RR_CACHE_DIR}/${rel}`] = content;
  }
  return changed;
}

async function mergeInWorktree(
  repo: string,
  wtPath: string,
  item: MergePlanItem,
  message: string,
): Promise<MergeOutcome> {
  const status = await git(repo, ['status', '--porcelain'], { cwd: wtPath });
  if (status.stdout.trim() !== '') {
    return { ...item, result: 'dirty-worktree' };
  }
  const rerereFlags = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'];
  const res = await git(repo, [...rerereFlags, 'merge', '--no-edit', '-m', message, item.stopPoint!], {
    cwd: wtPath,
    allowCodes: [1],
  });
  if (res.code === 0) {
    return { ...item, result: 'merged', newRef: await revParse(repo, item.branch), rerereResolved: [] };
  }
  const unresolved = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], { cwd: wtPath })).stdout
    .split('\n')
    .filter(Boolean);
  if (unresolved.length === 0) {
    // rerere auto-resolved and auto-staged every conflict; finalize the merge.
    await git(repo, [...rerereFlags, 'commit', '--no-edit', '--no-verify'], { cwd: wtPath });
    return {
      ...item,
      result: 'merged',
      newRef: await revParse(repo, item.branch),
      rerereResolved: item.expectConflicts,
    };
  }
  await git(repo, ['merge', '--abort'], { cwd: wtPath });
  return { ...item, result: 'gated', unresolved };
}

export interface ExecuteMergesResult {
  outcomes: MergeOutcome[];
  /** New/changed rr-cache files (state-branch paths), to be committed by record. */
  rrCacheExport: Record<string, Buffer>;
}

export async function executeMerges(
  repo: string,
  plan: MergePlanItem[],
  stateBranch: string,
): Promise<ExecuteMergesResult> {
  await installRrCache(repo, stateBranch);
  const baseline = collectRrCache(join(await gitCommonDir(repo), 'rr-cache'));
  const outcomes: MergeOutcome[] = [];
  for (const item of plan) {
    if (item.action !== 'merge' || !item.stopPoint) {
      outcomes.push({ ...item, result: item.action === 'up-to-date' ? 'noop' : 'skipped' });
      continue;
    }
    const message = `Merge upstream ${item.stopPoint.slice(0, 12)} into ${item.branch} (sweep)`;
    if (item.method === 'commit-tree') {
      const newRef = await commitTreeMerge(repo, item.branch, item.stopPoint, message);
      outcomes.push({ ...item, result: 'merged', newRef, rerereResolved: [] });
      continue;
    }
    if (item.worktree) {
      outcomes.push(await mergeInWorktree(repo, item.worktree, item, message));
    } else {
      const wt = await addTempWorktree(repo, item.branch, { branch: item.branch });
      try {
        outcomes.push(await mergeInWorktree(repo, wt.path, item, message));
      } finally {
        await wt.remove();
      }
    }
  }
  return { outcomes, rrCacheExport: await exportRrCache(repo, baseline) };
}

/** Roll a branch back to its recorded pre-merge ref. */
export async function rollbackBranch(repo: string, outcome: MergeOutcome): Promise<void> {
  const checkedOut = await worktreeBranches(repo);
  const wtPath = checkedOut.get(outcome.branch);
  if (wtPath) {
    await git(repo, ['reset', '--hard', outcome.preRef], { cwd: wtPath });
  } else {
    await git(repo, ['update-ref', `refs/heads/${outcome.branch}`, outcome.preRef]);
  }
}
