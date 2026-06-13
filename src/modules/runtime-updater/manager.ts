/**
 * Runtime-CLI auto-update *policy* (inventory F2) — the global, per-provider
 * fetch scheduler. This is explicitly NOT the updater's concern: it owns the
 * auto-update cadence setting (persisted in the central DB, global-admin state)
 * and the periodic timer that keeps the shared version store fresh by fetching
 * the latest published CLI.
 *
 * It does NOT hold per-group selection or a spawn mount: a group selects an
 * already-fetched version via its provider identity string (`claude:2.1.154` /
 * `claude:latest`), and the spawn path resolves that against the updater
 * directly. The `/agent-runtime` command's global-admin verbs (`fetch`, `auto`)
 * go through the per-provider manager registry below.
 */
import { getAllCredentialProviders, RUNTIME_UPDATER } from '../credentials/index.js';
import type { RuntimeUpdaterExt } from '../credentials/index.js';
import { parseProviderSpec } from '../../container-config.js';
import { getAllContainerConfigs } from '../../db/container-configs.js';
import { getRuntimeAutoUpdate, setRuntimeAutoUpdate } from '../../db/runtime-auto-update.js';
import { log } from '../../log.js';
import { maxSemver } from './updater.js';

/** Normalized form of an auto-update setting ('', '24h', '2.1.92', …). */
export interface RuntimeUpdateConfig {
  /** 'off' — no auto-update; 'latest' — periodically fetch newest; 'pinned' — fetch one version. */
  mode: 'off' | 'latest' | 'pinned';
  /** Refresh interval in ms (latest mode only); 0 otherwise. */
  intervalMs: number;
  /** The pinned version (pinned mode only); '' otherwise. */
  version: string;
}

/**
 * Parse a raw auto-update setting (provider-agnostic):
 *   - ''                      → off
 *   - `<n>h | <n>d | <n>m`     → fetch latest, every interval
 *   - `<major.minor[.patch]>`  → fetch this exact version once
 *   - anything else           → off
 */
export function parseRuntimeUpdate(raw: string): RuntimeUpdateConfig {
  if (!raw) return { mode: 'off', intervalMs: 0, version: '' };

  const durationMatch = raw.match(/^(\d+)\s*(h|d|m)$/i);
  if (durationMatch) {
    const n = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const multiplier = unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 60000;
    return { mode: 'latest', intervalMs: n * multiplier, version: '' };
  }

  if (/^\d+\.\d+(\.\d+)?$/.test(raw)) {
    return { mode: 'pinned', intervalMs: 0, version: raw };
  }

  return { mode: 'off', intervalMs: 0, version: '' };
}

export class RuntimeUpdateManager {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly providerId: string,
    readonly updater: RuntimeUpdaterExt,
    /** Auto-update setting, seeded from the central DB at boot. */
    private setting: string,
  ) {}

  getSetting(): string {
    return this.setting;
  }

  config(): RuntimeUpdateConfig {
    return parseRuntimeUpdate(this.setting);
  }

  /** Apply the current setting: fetch the target now + (re)schedule the timer. Boot. */
  async start(): Promise<void> {
    this.stopTimer();
    const config = this.config();
    if (config.mode === 'off') return;
    if (config.mode === 'pinned') {
      await this.fetchVersion(config.version);
      return;
    }
    await this.fetchLatest();
    if (config.intervalMs > 0) this.startTimer(config.intervalMs);
  }

  /** Persist + apply a new auto-update setting (global-admin). */
  async reconfigure(setting: string): Promise<void> {
    this.setting = setting;
    setRuntimeAutoUpdate(this.providerId, setting);
    await this.start();
  }

  /** Fetch (install) an exact version into the shared store. Returns success. */
  async fetchVersion(version: string): Promise<boolean> {
    try {
      await this.updater.fetch(version);
      return true;
    } catch (err) {
      log.error('Runtime CLI fetch failed', { version, providerId: this.providerId, err });
      return false;
    }
  }

  /** Resolve + fetch the latest published version. Returns the version, or null. */
  async fetchLatest(): Promise<string | null> {
    const latest = this.updater.latestVersion();
    if (!latest) {
      log.warn('Could not determine latest runtime CLI version', { providerId: this.providerId });
      return null;
    }
    return (await this.fetchVersion(latest)) ? latest : null;
  }

  stop(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(intervalMs: number): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.fetchLatest().catch((err) =>
        log.error('Periodic runtime CLI fetch failed', { providerId: this.providerId, err }),
      );
    }, intervalMs);
    this.timer.unref();
    log.info('Runtime CLI auto-update scheduled', { intervalMs, providerId: this.providerId });
  }
}

// ── Per-provider manager registry ─────────────────────────────────────────

const managers = new Map<string, RuntimeUpdateManager>();

/**
 * Create a manager for every provider declaring RUNTIME_UPDATER, seed its
 * cadence from the DB, and apply it (initial fetch + timer). Call once at boot,
 * after provider registration.
 */
export async function startRuntimeUpdaters(): Promise<void> {
  for (const provider of getAllCredentialProviders()) {
    const updater = provider.getExtension?.(RUNTIME_UPDATER);
    if (!updater) continue;
    const manager = new RuntimeUpdateManager(provider.id, updater, getRuntimeAutoUpdate(provider.id) ?? '');
    managers.set(provider.id, manager);
    try {
      await manager.start();
    } catch (err) {
      log.error('Runtime updater failed to start', { providerId: provider.id, err });
    }
  }
}

/** Stop every manager's periodic timer. Call on shutdown. */
export function stopRuntimeUpdaters(): void {
  for (const manager of managers.values()) manager.stop();
  managers.clear();
}

/** The manager for a provider, or undefined if it has no runtime updater. */
export function getRuntimeUpdateManager(providerId: string): RuntimeUpdateManager | undefined {
  return managers.get(providerId);
}

/** Test seam: clear the registry between cases. */
export function _resetRuntimeUpdatersForTests(): void {
  for (const manager of managers.values()) manager.stop();
  managers.clear();
  inUse.clear();
}

// ── Selection resolution (spawn-time) ──────────────────────────────────────

/**
 * Resolve a group's selection to the concrete fetched version a spawn mounts:
 *   - undefined (bare provider) → null (use the image-baked CLI)
 *   - 'latest'                  → newest fetched version (null if none fetched)
 *   - exact version             → that version if fetched (null otherwise)
 * Never installs — only reports what a global admin has already fetched.
 */
export function resolveSelectedVersion(updater: RuntimeUpdaterExt, selection: string | undefined): string | null {
  if (!selection) return null;
  if (selection === 'latest') return maxSemver(updater.installedVersions());
  return updater.installedVersions().includes(selection) ? selection : null;
}

// ── In-use tracking (deletion safety) ──────────────────────────────────────
//
// Records the *concrete* CLI version each running container actually mounted —
// load-bearing for `latest`, which freezes onto the then-newest version at
// spawn and can later be superseded, so the running version can't be recomputed
// from config. Keyed by session id; container-runner marks on spawn, releases
// on exit.

const inUse = new Map<string, { providerId: string; version: string }>();

/** Record the concrete CLI version a spawning container mounted. */
export function markCliVersionInUse(sessionId: string, providerId: string, version: string): void {
  inUse.set(sessionId, { providerId, version });
}

/** Drop a session's in-use record (container exited). */
export function releaseCliVersionInUse(sessionId: string): void {
  inUse.delete(sessionId);
}

/** Concrete versions currently mounted by running containers of a provider. */
export function cliVersionsInUse(providerId: string): Set<string> {
  const versions = new Set<string>();
  for (const v of inUse.values()) if (v.providerId === providerId) versions.add(v.version);
  return versions;
}

/**
 * Whether a fetched version is safe to remove. Refuses when it is (a) selected
 * by any group's config (would break that group's next spawn) or (b) mounted in
 * a running container — including a `latest` container frozen onto it, which is
 * why (b) consults the spawn-time in-use record rather than recomputing.
 */
export function canRemoveVersion(providerId: string, version: string): { ok: true } | { ok: false; reason: string } {
  for (const cfg of getAllContainerConfigs()) {
    if (!cfg.provider) continue;
    const spec = parseProviderSpec(cfg.provider);
    if (spec.id === providerId && spec.version === version) {
      return { ok: false, reason: 'it is selected by a group — change that selection first' };
    }
  }
  if (cliVersionsInUse(providerId).has(version)) {
    return { ok: false, reason: 'it is mounted in a running container' };
  }
  return { ok: true };
}
