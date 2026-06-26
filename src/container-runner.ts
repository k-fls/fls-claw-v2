/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
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
import { materializeContainerJson } from './container-config.js';
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
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
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
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
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
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
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

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

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

  // Log stderr. A container that dies at boot (unknown provider, missing
  // binary, bad config) explains itself only here — and debug is below the
  // default log level — so keep a tail to surface on a non-zero exit.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    // Release the slot + clear any eviction mark, then hand it to waiting
    // sessions (FIFO drain). Runs after activeContainers.delete so occupancy
    // already reflects the freed slot.
    queue.onExit(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
    if (drainComplete && activeContainers.size === 0) drainComplete();
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    queue.onExit(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
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
export function killContainer(
  sessionId: string,
  reason: string,
  onExit?: () => void,
  graceSeconds = 1,
): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

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
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

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
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
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

  const desired = selectedSkillNames(containerConfig);
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
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Per-container resource caps (opt-in; empty = unbounded, today's behavior).
  // Only --memory is set. Whether that's a hard cap depends on the host having no
  // swap (a deployment concern) — on a swapless host --memory is hard and a runaway
  // is OOM-killed; we don't manage swap from here.
  if (CONTAINER_CPU_LIMIT) args.push('--cpus', CONTAINER_CPU_LIMIT);
  if (CONTAINER_MEMORY_LIMIT) args.push('--memory', CONTAINER_MEMORY_LIMIT);

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Egress lockdown when enabled — throws if it can't be established, aborting
  // the spawn rather than running with open egress. Otherwise the host gateway.
  if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

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
