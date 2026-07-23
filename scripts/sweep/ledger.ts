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
import type { Ledger, LedgerBranch, MergeStatus } from './types.js';

export function emptyLedger(): Ledger {
  return { schemaVersion: 1, lastSweep: null, branches: {}, openPois: [] };
}

export function defaultLedgerBranch(): LedgerBranch {
  return {
    status: 'active',
    merge_status: null,
    notes: '',
    lastUrgedHead: null,
  };
}

/**
 * Legacy blocked predicate over the ledger CACHE — used by the old sweep merge
 * stage only. The propagation driver derives blockedness from origin + the
 * pass journal instead (D-058) and never consults this.
 */
export function isBlocked(b: LedgerBranch | undefined): boolean {
  return (b?.merge_status ?? null) !== null;
}

/**
 * Pre-D-057 ledger branch shape (independent freeze flags), up-converted on
 * read so an existing on-disk ledger keeps its blocked branches blocked:
 * status:'frozen' → merge_status PR_ID carrying the old caseId/head/PR fields.
 */
interface LegacyLedgerBranch {
  status?: string;
  frozenBy?: string | null;
  heldHead?: string | null;
  heldPaths?: string[] | null;
  fixBranch?: string | null;
  prNumber?: number | null;
  pendingBehindFreeze?: number;
}

function upconvertLegacyBranch(raw: Omit<LedgerBranch, 'status'> & LegacyLedgerBranch): LedgerBranch {
  const { frozenBy, heldHead, heldPaths, fixBranch, prNumber, pendingBehindFreeze, ...rest } = raw;
  void heldPaths; // retired: DEFER is pure height-MIN (D-057) — paths are never matched
  void pendingBehindFreeze; // retired: pending counts are derived live per pass
  let merge_status: MergeStatus | null = rest.merge_status ?? null;
  if (!merge_status && raw.status === 'frozen') {
    merge_status = {
      state: 'PR_ID',
      caseId: frozenBy ?? 'legacy-freeze',
      headSha: heldHead ?? null,
      fixBranch: fixBranch ?? null,
      prNumber: prNumber ?? null,
    };
  }
  const status: LedgerBranch['status'] = raw.status === 'excluded' ? 'excluded' : 'active';
  return { ...rest, status, merge_status };
}

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return emptyLedger();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (parsed.schemaVersion !== 1) throw new Error(`ledger schemaVersion ${parsed.schemaVersion} unsupported`);
  for (const [name, b] of Object.entries(parsed.branches ?? {})) {
    parsed.branches[name] = upconvertLegacyBranch(b as Omit<LedgerBranch, 'status'> & LegacyLedgerBranch);
  }
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
