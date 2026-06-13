/**
 * Discovery cache refresh — fetches OIDC well-known documents and
 * writes them into the override directory. The override directory is
 * read once at init *before* refresh fires, so refreshed files take
 * effect on the next process start (no loader/refresh race).
 *
 * Well-known URL resolution order:
 *   1. `_well_known_url` string  → use it directly.
 *   2. `_well_known_url === false` → skip (previously failed).
 *   3. absent → derive from `issuer`: `{issuer}/.well-known/openid-configuration`.
 *
 * The fetched body is filtered to standard fields (any `_*` key the
 * upstream may have included is dropped) and written atomically via
 * `*.tmp` + `rename`. This module never mutates the in-tree baseline.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { DiscoveryFile } from './types.js';

const PLACEHOLDER_RE = /\{(\w+)\}/;
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5_000;

function resolveWellKnownUrl(data: DiscoveryFile): string | null {
  if (data._well_known_url === false) return null;
  if (typeof data._well_known_url === 'string') {
    const url = data._well_known_url;
    if (PLACEHOLDER_RE.test(url)) return null;
    return url;
  }
  const issuer = data.issuer;
  if (!issuer || typeof issuer !== 'string') return null;
  if (PLACEHOLDER_RE.test(issuer)) return null;
  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

function isFresh(filePath: string, staleMs: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < staleMs;
  } catch {
    return false;
  }
}

function filterStandardFields(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('_')) result[key] = value;
  }
  return result;
}

/** Atomic write: tmp + rename, so the loader never sees a half-written file. */
function writeJsonAtomic(filePath: string, body: Record<string, unknown>): void {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

export interface RefreshOptions {
  /** Baseline discovery files indexed by provider id. */
  baseline: Map<string, DiscoveryFile>;
  /** Where refreshed standard-field JSON lands. */
  overrideDir: string;
  /** Skip threshold (ms). Default 24h. */
  staleMs?: number;
  /** Replaceable fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface RefreshResult {
  refreshed: string[];
  failed: string[];
  skipped: string[];
}

/**
 * Refresh each baseline provider that has a resolvable well-known URL
 * and whose override file is stale or missing.
 *
 * The loader has already read the override dir for this process. The
 * files written here take effect on the next start.
 */
export async function refreshDiscoveryCache(opts: RefreshOptions): Promise<RefreshResult> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const result: RefreshResult = { refreshed: [], failed: [], skipped: [] };

  fs.mkdirSync(opts.overrideDir, { recursive: true });

  for (const [id, data] of opts.baseline) {
    const url = resolveWellKnownUrl(data);
    if (!url) {
      result.skipped.push(id);
      continue;
    }

    const overrideFile = path.join(opts.overrideDir, `${id}.json`);
    if (isFresh(overrideFile, staleMs)) {
      result.skipped.push(id);
      continue;
    }

    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = (await response.json()) as Record<string, unknown>;
      writeJsonAtomic(overrideFile, filterStandardFields(body));
      result.refreshed.push(id);
      logger.debug({ id, url }, 'oauth.discovery.refresh: fetched');
    } catch (err) {
      result.failed.push(id);
      logger.debug({ id, url, err: err instanceof Error ? err.message : err }, 'oauth.discovery.refresh: failed');
    }
  }

  logger.info(
    {
      refreshed: result.refreshed.length,
      failed: result.failed.length,
      skipped: result.skipped.length,
    },
    'oauth.discovery.refresh: done',
  );
  return result;
}

export interface RefreshScheduleOptions extends RefreshOptions {
  /**
   * How often to re-run the refresh sweep. Each sweep only re-fetches files
   * older than `staleMs` (or missing), so a cadence shorter than `staleMs`
   * mostly just retries previously-failed providers sooner. Defaults to
   * `staleMs` (24h) — i.e. one sweep per staleness window.
   */
  intervalMs?: number;
}

export interface RefreshScheduleHandle {
  /** The initial sweep, kicked off immediately (same as the prior one-shot). */
  initial: Promise<RefreshResult>;
  /** Stop the recurring sweep. Idempotent. */
  stop(): void;
}

/**
 * Schedule recurring discovery refresh (C14). Runs one sweep immediately, then
 * repeats every `intervalMs`. Each sweep writes refreshed standard-field JSON
 * into the override dir; as before, refreshed files take effect on the **next**
 * process start (the loader reads the override dir once at init) — the schedule
 * just keeps the cache warm without a restart needed to *fetch*. Per-run errors
 * are swallowed (logged) so a transient network failure never tears down the
 * timer. The interval is `unref`'d so it never keeps the process alive.
 */
export function startDiscoveryRefreshSchedule(opts: RefreshScheduleOptions): RefreshScheduleHandle {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const intervalMs = opts.intervalMs ?? staleMs;

  const sweep = (): Promise<RefreshResult> =>
    refreshDiscoveryCache(opts).catch((err) => {
      logger.warn({ err }, 'oauth.discovery.refresh: scheduled sweep aborted');
      return { refreshed: [], failed: [], skipped: [] } satisfies RefreshResult;
    });

  const initial = sweep();
  const timer = setInterval(() => {
    void sweep();
  }, intervalMs);
  // Don't pin the event loop open (host shutdown, tests) — the sweep is
  // best-effort cache maintenance, never a reason to stay alive.
  timer.unref?.();

  let stopped = false;
  return {
    initial,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
