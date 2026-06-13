/**
 * SSH pending credential request management.
 *
 * When an agent calls ssh_request_credential(mode:'ask') and the credential
 * doesn't exist, the request is recorded here keyed by alias. Each entry
 * is a list of `{ sessionId, ts }` tuples — the same alias can be requested
 * independently from multiple sessions; each must be notified back when
 * `/ssh add` fulfills the request. The file lives under the per-agent-group
 * scope dir, so the owning agent group is implicit in the file path.
 *
 * File: ~/.config/nanoclaw/credentials/{scope}/ssh.pending.json
 * Format: { [alias]: [{ sessionId, ts }, ...] }
 */
import path from 'path';

import { updateJsonFile } from '../../atomic-json.js';
import { scopeDir } from '../credentials/index.js';
import { log } from '../../log.js';
import type { GroupScope, CredentialScope } from '../credentials/index.js';

// ── Constants ─────────────────────────────────────────────────────

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_CAP = 10;

export interface PendingEntry {
  sessionId: string;
  ts: number;
}

type PendingFile = Record<string, PendingEntry[]>;

// ── Helpers ───────────────────────────────────────────────────────

function pendingPath(scope: GroupScope): string {
  return path.join(scopeDir(scope as unknown as CredentialScope), 'ssh.pending.json');
}

function pruneStale(data: PendingFile): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const alias of Object.keys(data)) {
    const kept = data[alias].filter((e) => e.ts >= cutoff);
    if (kept.length === 0) delete data[alias];
    else data[alias] = kept;
  }
}

function totalCount(data: PendingFile): number {
  let n = 0;
  for (const list of Object.values(data)) n += list.length;
  return n;
}

// ── Public API ────────────────────────────────────────────────────

export interface AddPendingResult {
  /** Whether this request was accepted (vs suppressed). */
  accepted: boolean;
  /** Whether this request just hit the cap (notify user). */
  capReached: boolean;
}

/**
 * Add a pending SSH credential request for an alias from a specific session.
 * Prunes stale entries first.
 *
 * Idempotent for the same `(alias, sessionId)` — re-requests refresh the
 * timestamp but don't duplicate.
 */
export function addPendingRequest(scope: GroupScope, alias: string, sessionId: string): AddPendingResult {
  let accepted = false;
  let capReached = false;

  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);

    const list = data[alias] ?? [];
    const existing = list.find((e) => e.sessionId === sessionId);
    if (existing) {
      existing.ts = Date.now();
      data[alias] = list;
      accepted = true;
      return;
    }

    if (totalCount(data) >= PENDING_CAP) {
      log.info('ssh.pending_suppressed', { alias, scope, sessionId });
      accepted = false;
      return;
    }

    list.push({ sessionId, ts: Date.now() });
    data[alias] = list;
    accepted = true;
    capReached = totalCount(data) >= PENDING_CAP;
  });

  return { accepted, capReached };
}

/**
 * Check if any pending request exists for an alias.
 * Prunes stale entries as a side effect.
 */
export function hasPendingRequest(scope: GroupScope, alias: string): boolean {
  let found = false;
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);
    found = (data[alias]?.length ?? 0) > 0;
  });
  return found;
}

/**
 * Drain and return all pending entries for an alias. The file is updated
 * to remove the alias on the same atomic write.
 */
export function takePendingForAlias(scope: GroupScope, alias: string): PendingEntry[] {
  let drained: PendingEntry[] = [];
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);
    drained = data[alias] ?? [];
    delete data[alias];
  });
  return drained;
}

/**
 * Remove all pending entries belonging to a specific session.
 * Used on container exit — undeliverable entries are dropped.
 */
export function prunePendingForSession(scope: GroupScope, sessionId: string): void {
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);
    for (const alias of Object.keys(data)) {
      data[alias] = data[alias].filter((e) => e.sessionId !== sessionId);
      if (data[alias].length === 0) delete data[alias];
    }
  });
}

/**
 * Clear all pending requests for a scope.
 * Returns the number of `(alias, requester)` tuples cleared.
 */
export function clearAllPending(scope: GroupScope): number {
  let count = 0;
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    count = totalCount(data);
    for (const k of Object.keys(data)) delete data[k];
  });
  return count;
}
