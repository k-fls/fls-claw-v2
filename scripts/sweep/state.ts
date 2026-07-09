/**
 * scripts/sweep/state.ts — sweep-state.json + sweep-log.jsonl on the state branch.
 *
 * The state branch (default maint/fork-registry) is never checked out for
 * mutation: reads go through `git show`, writes build a new commit via a
 * temporary index (git.commitFilesOnBranch). Every state mutation appends a
 * journal row to sweep-log.jsonl in the SAME commit (audit trail).
 */
import { LOG_FILE, REPORTS_DIR, RR_CACHE_DIR, STATE_FILE } from './config.js';
import { commitFilesOnBranch, listTreePaths, readFileFromBranch, git } from './git.js';
import type { BranchState, SweepState } from './types.js';

export function emptyState(): SweepState {
  return { schemaVersion: 1, lastSweep: null, branches: {}, openPois: [] };
}

export function defaultBranchState(): BranchState {
  return { status: 'active', lastMergedUpstream: null, frozenBy: null, pendingBehindFreeze: 0, notes: '' };
}

export async function readSweepState(repo: string, stateBranch: string): Promise<SweepState> {
  const raw = await readFileFromBranch(repo, stateBranch, STATE_FILE);
  if (raw === null) return emptyState();
  const parsed = JSON.parse(raw) as SweepState;
  if (parsed.schemaVersion !== 1) throw new Error(`sweep-state.json schemaVersion ${parsed.schemaVersion} unsupported`);
  return parsed;
}

export interface LogEntry {
  ts: string;
  action: string;
  [key: string]: unknown;
}

export async function readSweepLog(repo: string, stateBranch: string): Promise<LogEntry[]> {
  const raw = await readFileFromBranch(repo, stateBranch, LOG_FILE);
  if (raw === null) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

/**
 * Commit a state mutation + journal row (+ optional extra files, e.g. an
 * archived report) to the state branch in one commit. Returns the commit sha.
 */
export async function writeSweepState(
  repo: string,
  stateBranch: string,
  state: SweepState,
  logEntry: Omit<LogEntry, 'ts'>,
  extraFiles: Record<string, string | Buffer> = {},
  message = `sweep: ${logEntry.action}`,
): Promise<string> {
  const existingLog = (await readFileFromBranch(repo, stateBranch, LOG_FILE)) ?? '';
  const row = JSON.stringify({ ts: new Date().toISOString(), ...logEntry });
  const files: Record<string, string | Buffer> = {
    [STATE_FILE]: JSON.stringify(state, null, 2) + '\n',
    [LOG_FILE]: existingLog + row + '\n',
    ...extraFiles,
  };
  return commitFilesOnBranch(repo, stateBranch, files, message);
}

/** Archive path for a sweep report on the state branch. */
export function reportArchivePath(sweepId: string): string {
  return `${REPORTS_DIR}/${sweepId.replace(/[:]/g, '')}.json`;
}

/** rr-cache entries stored on the state branch: path -> blob content. */
export async function readRrCacheFiles(repo: string, stateBranch: string): Promise<Record<string, Buffer>> {
  const paths = await listTreePaths(repo, stateBranch, RR_CACHE_DIR);
  const out: Record<string, Buffer> = {};
  for (const path of paths) {
    // Binary-safe read via cat-file (readFileFromBranch is string-typed).
    const res = await git(repo, ['cat-file', 'blob', `${stateBranch}:${path}`]);
    out[path.slice(RR_CACHE_DIR.length + 1)] = Buffer.from(res.stdout, 'utf8');
  }
  return out;
}
