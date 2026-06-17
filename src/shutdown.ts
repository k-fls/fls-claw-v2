/**
 * Host shutdown orchestration.
 *
 * Shared by the signal handlers (`src/index.ts`) and the `ncl shutdown` command
 * so both drive the same graceful drain. The mode is the drain budget:
 *   - `0`        → immediate: stop accepting work and hard-stop now.
 *   - finite     → graceful: let in-flight turns finish up to the budget, then
 *                  force-stop the remainder.
 *   - MAX        → wait for natural completion (timer never fires in practice).
 *
 * A second request while a drain is in flight escalates to immediate.
 *
 * The host sweep + delivery polls stay running across the drain: the sweep feeds
 * the idle detection that drives the shed, and delivery lets a finishing agent's
 * last answer reach the user. They're stopped only after the drain returns.
 */
import { resetCircuitBreaker } from './circuit-breaker.js';
import { beginGracefulDrain, shutdownContainers } from './container-runner.js';
import { stopDeliveryPolls } from './delivery.js';
import { stopHostSweep } from './host-sweep.js';
import { stopCliServer } from './cli/socket-server.js';
import { teardownChannelAdapters } from './channels/channel-registry.js';
import { getShutdownCallbacks } from './response-registry.js';
import { log } from './log.js';

type ShutdownPhase = 'none' | 'draining' | 'final';
let phase: ShutdownPhase = 'none';

/** True once a shutdown is under way — lets callers (e.g. the CLI) ack right. */
export function isShuttingDown(): boolean {
  return phase !== 'none';
}

/**
 * Drive host shutdown. `drainTimeoutMs` selects the mode (clamped downstream in
 * `beginGracefulDrain`). `source` is for logs. Resolves only on the immediate
 * path; the graceful path ends by `process.exit(0)` after teardown.
 */
export async function initiateShutdown(drainTimeoutMs: number, source: string): Promise<void> {
  if (phase === 'draining') {
    log.info('Second shutdown request — escalating to immediate stop', { source });
    await shutdownContainers(); // hard-stop remaining; the in-flight drain resolves at 0
    return;
  }
  if (phase === 'final') return; // already tearing down
  phase = 'draining';
  log.info('Shutdown initiated', { source, drainTimeoutMs });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }

  // Drain: capacity → 0 (no fresh work), wait for in-flight turns to finish up
  // to the budget, then force-stop the rest.
  await beginGracefulDrain(drainTimeoutMs);

  phase = 'final';
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — we got here via an intentional
    // signal/command, not a crash, so the next start shouldn't be counted as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}
