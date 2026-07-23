/**
 * scripts/sweep/merge.ts — DAG-ordered propagation with a shared rerere
 * cache (2026-07-14 merge-source correction).
 *
 * Merge sources per branch: main_patched and edition-ancestor branches merge
 * their upstream STOP POINT (the only upstream entry points besides main's
 * ff); every inventory branch merges its DAG PARENTS' tips, in order,
 * parents-before-children — upstream content reaches leaves only through the
 * parent chain, so a conflict is resolved once at the topmost affected
 * branch and descendants inherit the resolution. A gated parent's tip does
 * not advance, so its children naturally have nothing new to merge
 * (inherited gating). Clean merges
 * on branches that are NOT checked out use plumbing only (merge-tree +
 * commit-tree + update-ref — the July-sweep technique). Conflicted merges
 * and checked-out branches use a worktree (existing one when the branch is
 * checked out and clean, else a temporary one) with rerere enabled;
 * rerere-auto-resolved conflicts count as clean but are surfaced as
 * annotate-PoIs of type rerere-replay. Unresolved conflicts abort the merge
 * and gate the branch. Pre-merge refs are recorded for rollback. The shared
 * rerere cache is a plain directory in the group workspace (seeded via
 * `seed-rerere`), installed into .git/rr-cache before merging and exported
 * back after.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  addTempWorktree,
  commitTreeMerge,
  git,
  gitCommonDir,
  isAncestor,
  newStyleMergeTree,
  revParse,
  worktreeBranches,
} from './git.js';
import { isBlocked } from './ledger.js';
import type { Ledger } from './types.js';

/**
 * Branches the merge stage must never write to, regardless of scope/plan
 * input. fix/* and docs/notes are legitimate sweep targets (kept current
 * for upstream PRs) and are deliberately NOT protected.
 */
const PROTECTED_BRANCH_RE = /^(main|everything.*|design\/.*|maint\/.*)$/;

export interface MergeTarget {
  branch: string;
  mergeModel: 'upstream-chain' | 'parents';
  /** upstream-chain: the bisected stop point (null = fully gated). */
  stopPoint: string | null;
  /** parents model: DAG parent branches to merge, in order. */
  parents: string[];
  upToDate: boolean;
}

export interface MergePlanItem {
  branch: string;
  mergeModel: 'upstream-chain' | 'parents';
  stopPoint: string | null;
  preRef: string;
  action: 'merge' | 'up-to-date' | 'skip-frozen' | 'skip-no-stop-point' | 'skip-protected';
  /** Merge sources in order: the stop-point sha (upstream-chain) or parent branch names. */
  sources: string[];
  method?: 'commit-tree' | 'worktree' | 'mixed';
  worktree?: string | null;
  /** Preview union vs sources' CURRENT tips (post-cascade tips may differ). */
  expectConflicts: string[];
}

export interface MergeOutcome extends MergePlanItem {
  result: 'merged' | 'noop' | 'gated' | 'skipped' | 'dirty-worktree';
  newRef?: string;
  /** Sources actually merged, as "<name>@<sha12>". */
  mergedSources?: string[];
  /** Conflicted paths auto-resolved by rerere (annotate-PoI type rerere-replay). */
  rerereResolved?: string[];
  /** Unresolved conflict paths (gate). */
  unresolved?: string[];
}

export async function planMerges(repo: string, targets: MergeTarget[], ledger: Ledger): Promise<MergePlanItem[]> {
  const checkedOut = await worktreeBranches(repo);
  const plan: MergePlanItem[] = [];
  for (const t of targets) {
    const preRef = await revParse(repo, t.branch);
    const bs = ledger.branches[t.branch];
    let action: MergePlanItem['action'];
    if (PROTECTED_BRANCH_RE.test(t.branch)) action = 'skip-protected';
    else if (isBlocked(bs) || bs?.status === 'excluded') action = 'skip-frozen'; // blocked ⇔ merge_status != NONE (D-057)
    else if (t.upToDate) action = 'up-to-date';
    else if (t.mergeModel === 'upstream-chain' && !t.stopPoint) action = 'skip-no-stop-point';
    else action = 'merge';
    const sources = t.mergeModel === 'upstream-chain' ? (t.stopPoint ? [t.stopPoint] : []) : t.parents;
    let method: MergePlanItem['method'];
    const expectConflicts = new Set<string>();
    if (action === 'merge') {
      // Preview vs CURRENT source tips (execution re-probes after parents move).
      const methods = new Set<string>();
      for (const src of sources) {
        const tip = await revParse(repo, src);
        if (await isAncestor(repo, tip, t.branch)) continue;
        const probe = await newStyleMergeTree(repo, t.branch, tip);
        for (const f of probe.conflictFiles) expectConflicts.add(f);
        methods.add(probe.clean && !checkedOut.has(t.branch) ? 'commit-tree' : 'worktree');
      }
      method =
        methods.size > 1 ? 'mixed' : ((methods.values().next().value as MergePlanItem['method']) ?? 'commit-tree');
    }
    plan.push({
      branch: t.branch,
      mergeModel: t.mergeModel,
      stopPoint: t.stopPoint,
      preRef,
      action,
      sources,
      method,
      worktree: checkedOut.get(t.branch) ?? null,
      expectConflicts: [...expectConflicts].sort(),
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

/**
 * Install the shared rerere cache from the workspace rr-cache directory
 * (local/ephemeral; seeded by `seed-rerere`) into .git/rr-cache.
 */
export async function installRrCache(repo: string, rrSourceDir: string | null): Promise<number> {
  if (!rrSourceDir) return 0;
  const files = collectRrCache(rrSourceDir);
  const target = join(await gitCommonDir(repo), 'rr-cache');
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return Object.keys(files).length;
}

/** Write rr-cache entries (relative path -> content) into a workspace rr-cache dir. */
export function writeRrCacheDir(rrDir: string, files: Record<string, Buffer>): number {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(rrDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return Object.keys(files).length;
}

/** rr-cache entries in .git/rr-cache that are new/changed vs the given baseline (relative paths). */
export async function exportRrCache(repo: string, baseline: Record<string, Buffer>): Promise<Record<string, Buffer>> {
  const current = collectRrCache(join(await gitCommonDir(repo), 'rr-cache'));
  const changed: Record<string, Buffer> = {};
  for (const [rel, content] of Object.entries(current)) {
    if (!baseline[rel] || !baseline[rel].equals(content)) changed[rel] = content;
  }
  return changed;
}

interface SourceMergeResult {
  status: 'merged' | 'gated' | 'dirty-worktree';
  rerereResolved: string[];
  unresolved?: string[];
}

async function mergeSourceInWorktree(
  repo: string,
  wtPath: string,
  branch: string,
  source: string,
  message: string,
  expectConflicts: string[],
): Promise<SourceMergeResult> {
  const status = await git(repo, ['status', '--porcelain'], { cwd: wtPath });
  if (status.stdout.trim() !== '') {
    return { status: 'dirty-worktree', rerereResolved: [] };
  }
  const rerereFlags = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'];
  const res = await git(repo, [...rerereFlags, 'merge', '--no-edit', '-m', message, source], {
    cwd: wtPath,
    allowCodes: [1],
  });
  if (res.code === 0) return { status: 'merged', rerereResolved: [] };
  const unresolved = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], { cwd: wtPath })).stdout
    .split('\n')
    .filter(Boolean);
  if (unresolved.length === 0) {
    // rerere auto-resolved and auto-staged every conflict; finalize the merge.
    await git(repo, [...rerereFlags, 'commit', '--no-edit', '--no-verify'], { cwd: wtPath });
    return { status: 'merged', rerereResolved: expectConflicts };
  }
  await git(repo, ['merge', '--abort'], { cwd: wtPath });
  return { status: 'gated', rerereResolved: [], unresolved };
}

export interface ExecuteMergesResult {
  outcomes: MergeOutcome[];
  /** New/changed rr-cache files (relative paths) — persisted back into the workspace rr-cache dir. */
  rrCacheExport: Record<string, Buffer>;
}

export async function executeMerges(
  repo: string,
  plan: MergePlanItem[],
  rrSourceDir: string | null,
): Promise<ExecuteMergesResult> {
  await installRrCache(repo, rrSourceDir);
  const baseline = collectRrCache(join(await gitCommonDir(repo), 'rr-cache'));
  const checkedOut = await worktreeBranches(repo);
  const outcomes: MergeOutcome[] = [];
  for (const item of plan) {
    if (item.action !== 'merge' || item.sources.length === 0) {
      outcomes.push({ ...item, result: item.action === 'up-to-date' ? 'noop' : 'skipped' });
      continue;
    }
    // Sources are merged in order, at their tips AS OF NOW — parents processed
    // earlier in this run have already advanced, so children inherit their
    // resolved upstream content (and a gated parent's unmoved tip means the
    // child simply has nothing new to merge: inherited gating).
    let outcome: MergeOutcome = { ...item, result: 'noop' };
    const mergedSources: string[] = [];
    const rerereResolved: string[] = [];
    for (const source of item.sources) {
      const sourceTip = await revParse(repo, source);
      if (await isAncestor(repo, sourceTip, item.branch)) continue; // nothing new from this source
      const label = item.mergeModel === 'parents' ? source : `upstream ${sourceTip.slice(0, 12)}`;
      const message = `Merge ${label} into ${item.branch} (sweep)`;
      const probe = await newStyleMergeTree(repo, item.branch, sourceTip);
      if (probe.clean && !checkedOut.has(item.branch)) {
        const newRef = await commitTreeMerge(repo, item.branch, sourceTip, message);
        mergedSources.push(`${source}@${sourceTip.slice(0, 12)}`);
        outcome = { ...item, result: 'merged', newRef, mergedSources, rerereResolved };
        continue;
      }
      const wtPath = checkedOut.get(item.branch) ?? null;
      const wt = wtPath ? null : await addTempWorktree(repo, item.branch, { branch: item.branch });
      let res: SourceMergeResult;
      try {
        res = await mergeSourceInWorktree(
          repo,
          wtPath ?? wt!.path,
          item.branch,
          sourceTip,
          message,
          probe.conflictFiles,
        );
      } finally {
        if (wt) await wt.remove();
      }
      if (res.status === 'merged') {
        mergedSources.push(`${source}@${sourceTip.slice(0, 12)}`);
        rerereResolved.push(...res.rerereResolved);
        outcome = {
          ...item,
          result: 'merged',
          newRef: await revParse(repo, item.branch),
          mergedSources,
          rerereResolved,
        };
        continue;
      }
      // gated / dirty-worktree: stop processing further sources for this branch.
      outcome = { ...item, result: res.status, mergedSources, rerereResolved, unresolved: res.unresolved };
      break;
    }
    outcomes.push(outcome);
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
