/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { type AgentGroupContribution, invokeAgentGroupContributions } from './agent-group-contributions.js';
import { FatalSpawnError, isSpawnPoisoned, markSpawnPoisoned } from './spawn-failure.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GRACEFUL_STOP_MS,
  GROUPS_DIR,
  IDLE_BEFORE_EVICT,
  MAX_CONCURRENT_CONTAINERS,
  MAX_DRAIN_TIMEOUT_MS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { ContainerQueue, type EvictionCandidate } from './container-queue.js';
import { getSession } from './db/sessions.js';
import { materializeContainerJson, resolveProviderName } from './container-config.js';
// Re-exported for back-compat: `resolveProviderName` lives in container-config.
export { resolveProviderName };
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
  stopContainerGraceful,
} from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import {
  defaultLaunchShape,
  type ExitReason,
  fireContainerExited,
  fireContainerStarted,
  fireSpawnPre,
  resolveLaunchMode,
  type MergedSpawnPre,
} from './modules/container-bootstrap/index.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { hostRpcPort } from './modules/host-rpc/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { getCredentialProvider, AGENT_RUNTIME, asGroupScope } from './modules/credentials/index.js';
import type { ContributionInput, ProviderResult } from './modules/credentials/index.js';
// Import from the leaf module, not the mitm-proxy barrel: the barrel re-exports
// proxy-tap-logger, which reads DATA_DIR at module-eval time, and that eager
// read trips a TDZ in tests that mock config.DATA_DIR via a getter.
import { hasProxyInstance } from './modules/mitm-proxy/credential-proxy.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * Active containers tracked by session ID. `spawnedAt` + the liveness fields
 * (`heartbeatMtimeMs`, `hasOutstandingClaim`, stamped by the host sweep each
 * tick via `recordContainerLiveness`) feed the queue's demand-driven eviction
 * decision without any wake-path DB/FS I/O.
 */
interface ActiveContainer {
  process: ChildProcess;
  containerName: string;
  spawnedAt: number;
  heartbeatMtimeMs: number;
  hasOutstandingClaim: boolean;
}
const activeContainers = new Map<string, ActiveContainer>();

/**
 * Sessions whose container was killed via `killContainer` — checked then
 * cleared by the close handler so it can pass `reason: 'killed'` to
 * `fireContainerExited` instead of `'normal'`.
 */
const killedSessions = new Set<string>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

/**
 * `docker stop -t` takes integer seconds; config carries `GRACEFUL_STOP_MS`
 * (ms, uniform with the other timing knobs). Convert once, here at the runtime
 * boundary. Used for graceful eviction + shutdown stops only — stuck kills use
 * the fast 1s path.
 */
const GRACEFUL_STOP_SECONDS = Math.ceil(GRACEFUL_STOP_MS / 1000);

/**
 * Global admission queue: enforces `MAX_CONCURRENT_CONTAINERS` and evicts the
 * oldest-idle warm container under demand pressure. Side effects (spawn, evict)
 * are the real container-runner ops; the queue owns only the reserve / waiting
 * / evicting bookkeeping. See `container-queue.ts`.
 */
const queue = new ContainerQueue({
  cap: MAX_CONCURRENT_CONTAINERS,
  idleBeforeEvictMs: IDLE_BEFORE_EVICT,
  now: () => Date.now(),
  activeCount: () => activeContainers.size,
  isActive: (id) => activeContainers.has(id),
  canSpawn: (id) => {
    const s = getSession(id);
    return !!s && s.status === 'active';
  },
  spawn: (id) => {
    const s = getSession(id);
    if (s) void beginSpawn(s);
  },
  evict: (id) => killContainer(id, 'evicted', undefined, GRACEFUL_STOP_SECONDS),
  candidates: () => {
    const out: EvictionCandidate[] = [];
    for (const [sessionId, e] of activeContainers) {
      if (killedSessions.has(sessionId)) continue; // already being stopped
      out.push({
        sessionId,
        heartbeatMtimeMs: e.heartbeatMtimeMs,
        hasOutstandingClaim: e.hasOutstandingClaim,
        spawnedAt: e.spawnedAt,
      });
    }
    return out;
  },
});

/**
 * Stamp per-session liveness (heartbeat mtime + outstanding-claim flag) onto
 * the active-container entry. Called by the host sweep each tick — it already
 * reads both — so eviction candidate selection needs no wake-path I/O. The
 * stamp is at most one sweep interval stale, well inside the IDLE_BEFORE_EVICT
 * window.
 */
export function recordContainerLiveness(
  sessionId: string,
  heartbeatMtimeMs: number,
  hasOutstandingClaim: boolean,
): void {
  const e = activeContainers.get(sessionId);
  if (!e) return;
  e.heartbeatMtimeMs = heartbeatMtimeMs;
  e.hasOutstandingClaim = hasOutstandingClaim;
}

/**
 * Graceful container teardown on host shutdown (D-c). Latches the queue shut
 * (no new spawns/drains), then stops every live container *in parallel* with a
 * grace window — each container's SIGTERM handler aborts its turn and flushes
 * before SIGKILL. SIGKILL-fallback per container on stop error. Containers are
 * DB-durable, so even a hard kill just resets the message to pending for the
 * next boot — the grace makes that the exception, not the rule.
 */
export async function shutdownContainers(): Promise<void> {
  queue.setShuttingDown();
  const entries = [...activeContainers.values()];
  if (entries.length === 0) return;
  log.info('Stopping containers on shutdown', { count: entries.length, graceSeconds: GRACEFUL_STOP_SECONDS });
  await Promise.allSettled(
    entries.map((e) =>
      stopContainerGraceful(e.containerName, GRACEFUL_STOP_SECONDS).catch((err) => {
        log.warn('Graceful stop failed on shutdown; SIGKILL fallback', { containerName: e.containerName, err });
        try {
          e.process.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }),
    ),
  );
}

/**
 * Prepare a per-group persistent home directory backing `/home/node`.
 *
 * Subdirectories (app config / caches like `.config/gh/`, `.aws/`, `.npm/`)
 * survive across runs so tool state isn't lost between sessions. Top-level
 * flat files in `~/` are removed on every launch to prevent dotfile injection
 * (`.bashrc`, `.profile`, `.bash_profile`) from carrying between sessions —
 * this wipe is the security boundary, not incidental cleanup. Nested files
 * (e.g. `.config/gh/hosts.yml`) are untouched.
 *
 * Returns the absolute dir so the caller can mount it.
 */
export function prepareGroupHomeDir(homeDir: string): string {
  fs.mkdirSync(homeDir, { recursive: true });
  for (const entry of fs.readdirSync(homeDir)) {
    const full = path.join(homeDir, entry);
    try {
      if (fs.statSync(full).isFile()) fs.unlinkSync(full);
    } catch {
      /* race with container shutdown, ignore */
    }
  }
  return homeDir;
}

/**
 * Re-run the queue's over-capacity shed. Called by the host sweep each tick
 * (after it stamps liveness) so a container that was mid-turn when capacity
 * dropped gets re-pinged the moment its claim clears. No-op unless the queue is
 * over cap (the normal case).
 */
export function reconcileContainerCapacity(): void {
  queue.shedIdleOverCapacity();
}

/** Resolves when the in-flight graceful drain reaches zero live containers. */
let drainComplete: (() => void) | null = null;

/**
 * Graceful drain (D-c). Takes queue capacity to 0 — no fresh work is admitted,
 * and every container is stopped as it goes idle (`shedIdleOverCapacity`,
 * re-pinged each sweep tick for mid-turn ones) — then resolves once all
 * containers have exited.
 *
 * `drainTimeoutMs` is clamped to `[0, MAX_DRAIN_TIMEOUT_MS]` and selects the mode:
 *   - `0`        → immediate: don't wait for idle, hard-drain now (soft stop +
 *                  SIGKILL fallback via `shutdownContainers`).
 *   - finite > 0 → wait for natural completion up to the budget; on timeout,
 *                  hard-drain the remainder.
 *   - max        → effectively "wait for natural completion" (timer never fires
 *                  in practice).
 *
 * In every mode capacity goes to 0 *first*, so a drain never keeps serving while
 * it waits. The host sweep must stay running across the await — it feeds the
 * idle detection that drives the shed.
 */
export async function beginGracefulDrain(drainTimeoutMs: number): Promise<void> {
  const t = Math.max(0, Math.min(Math.floor(drainTimeoutMs) || 0, MAX_DRAIN_TIMEOUT_MS));
  queue.setCapacity(0); // latch admissions + shed every currently-idle container
  if (activeContainers.size === 0) return;
  if (t === 0) {
    log.info('Immediate shutdown — hard-stopping all containers', { count: activeContainers.size });
    await shutdownContainers();
    return;
  }
  log.info('Graceful drain started', { drainTimeoutMs: t, active: activeContainers.size });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn('Graceful drain timed out — hard-stopping remaining containers', {
        remaining: activeContainers.size,
      });
      drainComplete = null;
      void shutdownContainers().finally(resolve);
    }, t);
    drainComplete = () => {
      clearTimeout(timer);
      drainComplete = null;
      log.info('Graceful drain complete — all containers idle and stopped');
      resolve();
    };
  });
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Docker container name for a running session, or null if no container is
 * active for it. Used by the interactive OAuth flow to `docker exec` a
 * captured auth code into the container's localhost callback.
 */
export function getContainerName(sessionId: string): string | null {
  return activeContainers.get(sessionId)?.containerName ?? null;
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract:
 *   - returns `true` on successful spawn;
 *   - returns `false` on **retryable** failure (e.g. OneCLI gateway
 *     unreachable) — the inbound row stays pending and host-sweep wakes
 *     again on its next tick, no user notification;
 *   - returns `false` (without spawning) when the session is currently
 *     marked spawn-poisoned by a prior non-retryable failure;
 *   - **throws `FatalSpawnError`** on a non-retryable failure (e.g. a
 *     registered agent-group contribution rejected the spawn). The
 *     session is also marked poisoned so subsequent wakes are no-ops
 *     until something clears the flag (the router clears it when the
 *     user sends another inbound). Callers that hold channel context
 *     (the router) should catch `FatalSpawnError` and report it to the
 *     user via `deliverDirect`; callers that don't (host-sweep,
 *     notifyAgent's internal wake) should `.catch()` and log only.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  if (isSpawnPoisoned(session.id)) {
    log.debug('Container spawn poisoned — skipping wake', { sessionId: session.id });
    return Promise.resolve(false);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  // Admission control (cap + demand-driven eviction). Synchronous, so two
  // concurrent wakes can't both pass the cap (v1 P1). On 'deferred' the inbound
  // row stays pending; the queue re-wakes this session when a slot frees
  // (drain) and the sweep is the backstop. Treated like a retryable failure
  // (returns false, no throw, no user notification).
  if (queue.admit(session.id) === 'deferred') {
    log.debug('Wake deferred — at concurrency cap', {
      sessionId: session.id,
      occupancy: queue.occupancy(),
      cap: MAX_CONCURRENT_CONTAINERS,
    });
    return Promise.resolve(false);
  }
  return beginSpawn(session);
}

/**
 * Drive a spawn whose slot has already been reserved (via `queue.admit` in
 * `wakeContainer`, or directly by `queue` during drain). Owns the wake-promise
 * dedup + the reserve release: the reserve is freed at the active handoff
 * inside `spawnContainer`, but if the spawn returns/throws *before* a live
 * container is registered (e.g. the `!agentGroup` early-return at the top of
 * `spawnContainer`, which never reaches `fireExitOnce`), this `finally` is the
 * leak-proof release (v2 risk R9).
 */
function beginSpawn(session: Session): Promise<boolean> {
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.error('wakeContainer: spawn failed', { sessionId: session.id, err });
      if (err instanceof FatalSpawnError) {
        markSpawnPoisoned(session.id);
        throw err;
      }
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
      // If the spawn never handed off to a live container, free the reserved
      // slot AND service waiters — the freed slot must not sit idle until the
      // next exit/sweep. (A successful handoff already dropped the reserve at
      // activeContainers.set, so has() is true here and we skip.)
      if (!activeContainers.has(session.id)) queue.releaseReserveAndDrain(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  // Per-agent-group dynamic contributions. Callbacks run sync; any throw
  // is wrapped in FatalSpawnError by the registry and propagates up to
  // wakeContainer's catch, where it marks the session poisoned and
  // re-throws so the caller (router) can notify the user.
  const groupContribution: AgentGroupContribution = invokeAgentGroupContributions({
    agentGroup,
    session,
    hostEnv: process.env,
  });

  // Container-bootstrap lifecycle pipeline. `fireSpawnPre` aggregates
  // observer contributions (IP allocation today, future cred broker / ssh
  // passwd shim) into mounts/env/args/cleanups + a needsRootEntrypoint flag.
  // A throwing observer is wrapped in FatalSpawnError by the registry; the
  // throw propagates without local handling because no cleanups have been
  // collected yet at that point.
  const spawnPre: MergedSpawnPre = fireSpawnPre({ agentGroup, session, providerName: provider, containerConfig });

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution, groupContribution, spawnPre);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;

  const launchMode = resolveLaunchMode(spawnPre.needsRootEntrypoint);

  // Per-spawn exit guard. The spec says `onContainerExited` fires exactly
  // once per session; Node can occasionally emit both `close` and `error`
  // on the same ChildProcess, and the pre-spawn args-build failure path
  // also fires the hook. A single flag shared by every exit site enforces
  // the spec at the call site (paired with the cleanup-level once-shim
  // inside fireSpawnPre, which enforces the cleanup-idempotency contract
  // independently — different invariants, different layers).
  let exited = false;
  const fireExitOnce = (exitCode: number | null, reason: ExitReason): boolean => {
    if (exited) return false;
    exited = true;
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    killedSessions.delete(session.id);
    fireContainerExited({ agentGroup, session, containerName, exitCode, reason }, spawnPre.cleanups);
    // Release the slot + clear any eviction mark, then hand it to waiting
    // sessions (FIFO drain). Runs after activeContainers.delete so occupancy
    // already reflects the freed slot. Also covers the pre-spawn error path
    // (fired at the buildContainerArgs catch), where it releases the reserve
    // for a spawn that never produced a live container.
    queue.onExit(session.id);
    return true;
  };

  let args: string[];
  try {
    args = await buildContainerArgs(
      mounts,
      containerName,
      agentGroup,
      containerConfig,
      provider,
      contribution,
      groupContribution,
      agentIdentifier,
      spawnPre,
      launchMode,
    );
  } catch (err) {
    // Spawn failed before the process is alive: still run cleanups +
    // fire the exited hook with reason='spawn-error' so observers can
    // release any handles they allocated.
    fireExitOnce(null, 'spawn-error');
    throw err;
  }

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, {
    process: container,
    containerName,
    spawnedAt: Date.now(),
    heartbeatMtimeMs: 0,
    hasOutstandingClaim: false,
  });
  // Reserve→active handoff: the slot is now owned by activeContainers (counted
  // in occupancy via activeCount), so drop the reserve to avoid double-counting.
  queue.releaseReserve(session.id);
  markContainerRunning(session.id);
  fireContainerStarted({ agentGroup, session, containerName });

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    // `killedSessions` is consumed by `fireExitOnce` (clears it) so peek before.
    const reason: ExitReason = killedSessions.has(session.id) ? 'killed' : 'normal';
    if (fireExitOnce(code, reason)) {
      log.info('Container exited', { sessionId: session.id, code, containerName, reason });
    }
    if (drainComplete && activeContainers.size === 0) drainComplete();
  });

  container.on('error', (err) => {
    if (fireExitOnce(null, 'spawn-error')) {
      log.error('Container spawn error', { sessionId: session.id, err });
    }
    if (drainComplete && activeContainers.size === 0) drainComplete();
  });
}

/**
 * Kill a container for a session. `graceSeconds > 1` takes the *graceful*
 * non-blocking path (async `docker stop -t N`): the container's SIGTERM handler
 * aborts its turn and flushes before SIGKILL — used for demand eviction. The
 * default 1s path is synchronous and immediate, for stuck-container kills
 * (ceiling / claim-stuck) where graceful wind-down can't work anyway.
 */
export function killContainer(sessionId: string, reason: string, onExit?: () => void, graceSeconds = 1): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  killedSessions.add(sessionId);
  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName, graceSeconds });
  if (graceSeconds > 1) {
    // Graceful: don't block the event loop; SIGTERM handler winds the turn down.
    stopContainerGraceful(entry.containerName, graceSeconds).catch((err) => {
      log.warn('Graceful docker stop failed; SIGKILL fallback', { sessionId, err });
      try {
        entry.process.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    });
    return;
  }
  try {
    stopContainer(entry.containerName, graceSeconds);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): ProviderResult {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const input: ContributionInput = {
    provider,
    agentProvider: session.agent_provider,
    providerVersion: containerConfig.providerVersion,
    agentGroupId: agentGroup.id,
    groupScope: asGroupScope(agentGroup.folder),
    sessionDir: sessionDir(agentGroup.id, session.id),
    hostEnv: process.env,
    runtimeConfig: containerConfig.runtimeConfig ?? {},
    runtime: getCredentialProvider(provider)?.getExtension?.(AGENT_RUNTIME),
  };

  // The container shape comes from the provider's AGENT_RUNTIME extension, whose
  // `containerContribution` merges a set of contributor calls (base env, mitm
  // credential substitutes, runtime-updater's CLI-version mount, …). Capability
  // layers add a call to that merge, so this resolver stays agnostic. Here we
  // split the spawn-facing env/mounts from the host-only `cliVersion` (in-use
  // bookkeeping) — the one place that split lives.
  if (input.runtime) {
    const { env, mounts, cliVersion } = input.runtime.containerContribution({
      agentGroupId: input.agentGroupId,
      groupScope: input.groupScope,
      sessionDir: input.sessionDir,
      hostEnv: input.hostEnv,
      runtimeConfig: input.runtime.parseRuntimeConfig(input.runtimeConfig),
      agentProvider: input.agentProvider,
      providerVersion: input.providerVersion,
    });
    return { provider, contribution: { env, mounts }, cliVersion: cliVersion ?? null };
  }

  // Legacy fallback: out-of-tree providers that register only a single
  // host-config fn in the provider-container registry (no AGENT_RUNTIME ext).
  const fn = getProviderContainerConfig(provider);
  const contribution: ProviderContainerContribution = fn
    ? fn({ sessionDir: input.sessionDir, agentGroupId: input.agentGroupId, hostEnv: input.hostEnv })
    : {};
  return { provider, contribution, cliVersion: null };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
  groupContribution: AgentGroupContribution,
  spawnPre: MergedSpawnPre,
): VolumeMount[] {
  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Snapshot-derived bootstrap mounts: entrypoint.sh, /app/src, /app/skills,
  // /app/CLAUDE.md — all read-only. Owned by container-bootstrap so the
  // launch shape is independent of `process.cwd()` after host boot.
  mounts.push(...defaultLaunchShape().mounts);

  // Per-group persistent home directory at /home/node. The .claude mount below
  // nests on top of this and lives in a separate host dir, so the file-wipe in
  // `prepareGroupHomeDir` never touches it; agent-written ~/.env-vars
  // (regenerated each launch) is correctly cleared as a top-level file.
  const groupHomeDir = prepareGroupHomeDir(path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'home'));
  mounts.push({ hostPath: groupHomeDir, containerPath: '/home/node', readonly: false });

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks). Nested on top of the persistent /home/node mount above.
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  // Agent-group dynamic contributions (e.g. group-oauth proxy CA cert,
  // ssh-auth socket mount). Validation already happened inside the
  // contribution callback's domain; mount-security only governs the
  // static container.json additionalMounts above.
  if (groupContribution.mounts) {
    mounts.push(...groupContribution.mounts);
  }

  // Container-bootstrap onSpawnPre observer mounts (future cred broker, etc.).
  if (spawnPre.mounts.length > 0) {
    mounts.push(...spawnPre.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Opening flags shared by every spawned container. Exported for unit-test
 * coverage of the security baseline (no-new-privileges is required for the
 * root-drop entrypoint's setpriv to be a real boundary; the test asserts it
 * is present unconditionally).
 */
export function baseRunArgs(containerName: string): string[] {
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--label',
    CONTAINER_INSTALL_LABEL,
    // Prevent privilege regain via setuid binaries. Required for the root-
    // drop launch path (where the entrypoint setpriv-drops before exec-ing
    // bun) to be a real security boundary, not a soft suggestion. Cheap
    // defense-in-depth for rootless too.
    '--security-opt=no-new-privileges',
  ];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  groupContribution: AgentGroupContribution,
  agentIdentifier: string | undefined,
  spawnPre: MergedSpawnPre,
  launchMode: import('./modules/container-bootstrap/index.js').LaunchMode,
): Promise<string[]> {
  const args: string[] = baseRunArgs(containerName);

  // Container-bootstrap onSpawnPre args (e.g. --network nanoclaw --ip 10.0.0.5
  // from the IP observer). Must precede the image arg; appended later would
  // be parsed as part of the command.
  if (spawnPre.args.length > 0) {
    args.push(...spawnPre.args);
  }

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Agent-group dynamic env (e.g. group-oauth proxy URLs / cert paths).
  if (groupContribution.env) {
    for (const [key, value] of Object.entries(groupContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Container-bootstrap onSpawnPre env (future cred broker proxy hostname,
  // ssh passwd shim flag, etc.).
  for (const [key, value] of Object.entries(spawnPre.env)) {
    args.push('-e', `${key}=${value}`);
  }

  // Sync-action / host-rpc wiring: the container reaches the host-rpc server at
  // host.docker.internal:$NANOCLAW_HOST_RPC_PORT. The caller's session is
  // resolved host-side from its IP (the IP registry), so no session id is
  // injected. See src/modules/sync-actions/.
  args.push('-e', `NANOCLAW_HOST_RPC_PORT=${hostRpcPort()}`);

  // Egress. When the native MITM credential proxy is live it owns egress (the
  // mitm lifecycle observer already injected HTTP_PROXY + CA into the spawn
  // args), so skip the OneCLI gateway — it would otherwise fight the proxy for
  // HTTPS_PROXY.
  //
  // Without the proxy, OneCLI is the credential path: injects HTTPS_PROXY +
  // certs so container API calls route through the agent vault. Treated as a
  // transient hard failure — if we can't wire the gateway we don't spawn; the
  // caller leaves the inbound pending and the next sweep tick retries.
  if (hasProxyInstance()) {
    log.info('Native credential proxy active — skipping OneCLI gateway', { containerName });
  } else {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // Privilege mode. rootless → --user UID:GID. root-drop → --user 0:0 to
  // override the image's USER node directive (the entrypoint needs root
  // to run iptables / update-ca-certificates / setpriv), then HOST_UID/
  // HOST_GID env tells the entrypoint who to setpriv-drop to before
  // exec-ing bun.
  if (launchMode.kind === 'rootless' && launchMode.userArg) {
    args.push('--user', launchMode.userArg);
    args.push('-e', 'HOME=/home/node');
  } else if (launchMode.kind === 'root-drop') {
    args.push('--user', '0:0');
    args.push('-e', `HOST_UID=${launchMode.envVars.HOST_UID}`);
    args.push('-e', `HOST_GID=${launchMode.envVars.HOST_GID}`);
    args.push('-e', 'HOME=/home/node');
  } else {
    // HOME only needs explicit setting when we remap to a foreign UID
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Use per-agent-group image if one has been built, otherwise base image.
  // The image's baked-in ENTRYPOINT runs — `container/entrypoint.sh` mounted
  // from the snapshot owns the bun exec; no --entrypoint override here.
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
