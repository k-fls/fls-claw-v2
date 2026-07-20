/**
 * scripts/sweep/ledger.ts — group-owned sweep state (no state branch).
 *
 * Durable-but-live data splits three ways since the 2026-07-10 restructure:
 *  - DERIVED: lastMergedUpstream = `git merge-base <branch> <upstream>` —
 *    never stored, always computed.
 *  - GROUP-OWNED: freeze/exclude overrides, open PoIs, last-sweep record →
 *    the ledger JSON file in the group workspace (--ledger), plus an
 *    append-only sweep-log.jsonl journal next to it.
 *  - CONFIG: exclusion policy lives in scripts/sweep/registry/scope.yaml
 *    (committed), not here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { LOG_FILENAME, REPORTS_DIRNAME } from './config.js';
import { git } from './git.js';
import type { Ledger, LedgerBranch } from './types.js';

export function emptyLedger(): Ledger {
  return { schemaVersion: 1, lastSweep: null, branches: {}, openPois: [] };
}

export function defaultLedgerBranch(): LedgerBranch {
  return {
    status: 'active',
    frozenBy: null,
    pendingBehindFreeze: 0,
    notes: '',
    heldHead: null,
    fixBranch: null,
    lastUrgedHead: null,
  };
}

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return emptyLedger();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (parsed.schemaVersion !== 1) throw new Error(`ledger schemaVersion ${parsed.schemaVersion} unsupported`);
  return parsed;
}

export function writeLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n');
}

export interface LogEntry {
  ts: string;
  action: string;
  [key: string]: unknown;
}

/** Append a journal row to <workspace>/sweep-log.jsonl. */
export function appendSweepLog(workspace: string, entry: Omit<LogEntry, 'ts'>): void {
  mkdirSync(workspace, { recursive: true });
  appendFileSync(join(workspace, LOG_FILENAME), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function readSweepLog(workspace: string): LogEntry[] {
  const path = join(workspace, LOG_FILENAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

/** Archive path for a sweep report inside the workspace. */
export function reportArchivePath(workspace: string, sweepId: string): string {
  return join(workspace, REPORTS_DIRNAME, `${sweepId.replace(/[:]/g, '')}.json`);
}

/**
 * DERIVED state: the last upstream first-parent commit already merged into
 * the branch = merge-base(branch, upstreamRef). Replaces the previously
 * stored lastMergedUpstream field.
 */
export async function derivedLastMerged(repo: string, branch: string, upstreamRef: string): Promise<string | null> {
  const res = await git(repo, ['merge-base', branch, upstreamRef], { allowCodes: [1, 128] });
  return res.code === 0 ? res.stdout.trim() : null;
}
