/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';
// Single source of truth for the nanoclaw bridge gateway. This import closes a
// load-safe cycle (network.ts imports CONTAINER_RUNTIME_BIN from here): neither
// module references the other's binding at top level, so initialization order
// is irrelevant. Deriving the gateway here instead would duplicate the subnet
// parsing and let it drift from the network the allocator actually creates.
import { gatewayIP } from './modules/container-bootstrap/network.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // macOS / Docker Desktop: host.docker.internal is built in — nothing to add.
  if (os.platform() !== 'linux') return [];
  // WSL (Docker Desktop's VM) routes host-gateway correctly and the nanoclaw
  // bridge gateway isn't bindable from the Windows host, so keep the built-in
  // host-gateway alias there. Mirrors host-rpc's detectBindHost() branching.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  // Bare-metal Linux: point host.docker.internal at the nanoclaw bridge gateway
  // instead of docker0 (the default host-gateway target). Containers live on
  // the nanoclaw bridge, so reaching the host on its own bridge IP keeps the
  // hop same-subnet — no cross-bridge MASQUERADE, so host-rpc and the MITM
  // proxy (both bound on this address) see the container's real source IP,
  // which host-rpc's caller-IP gate requires. (host-rpc bug #9)
  return [`--add-host=host.docker.internal:${gatewayIP()}`];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

function assertValidContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/**
 * Stop a container by name, synchronously. `docker stop -t <grace>` sends
 * SIGTERM, waits up to `graceSeconds`, then SIGKILL. Default 1s is the fast
 * path for genuinely-stuck containers (they won't honor a graceful abort
 * anyway). Synchronous — blocks the event loop up to `graceSeconds`, so use
 * `stopContainerGraceful` (async) for any grace > 1s.
 */
export function stopContainer(name: string, graceSeconds = 1): void {
  assertValidContainerName(name);
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t ${graceSeconds} ${name}`, { stdio: 'pipe' });
}

/**
 * Async, non-blocking `docker stop -t <grace>` — for graceful eviction /
 * shutdown, where Docker waits up to `graceSeconds` for the container's SIGTERM
 * handler to wind down the current turn (abort the in-flight query, mark rows
 * complete, flush the transcript) before SIGKILL. Resolves when `docker stop`
 * returns; rejects on error so the caller can SIGKILL-fallback.
 */
export function stopContainerGraceful(name: string, graceSeconds: number): Promise<void> {
  assertValidContainerName(name);
  return new Promise((resolve, reject) => {
    exec(`${CONTAINER_RUNTIME_BIN} stop -t ${graceSeconds} ${name}`, { timeout: (graceSeconds + 5) * 1000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
