/**
 * `ncl shutdown` — initiate host shutdown with a graceful drain.
 *
 *   ncl shutdown               graceful: drain up to SHUTDOWN_DRAIN_TIMEOUT_MS,
 *                              then force-stop the remainder
 *   ncl shutdown --now         immediate: stop accepting work, hard-stop now
 *   ncl shutdown --drain <ms>  graceful with an explicit budget
 *   ncl shutdown --wait        wait for natural completion (no practical timeout)
 *
 * Host-only — an agent container cannot shut down its host. The ack is returned
 * before teardown runs (deferred to the next tick) so the caller sees it before
 * the CLI socket is torn down inside `initiateShutdown`.
 */
import { MAX_DRAIN_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS } from '../../config.js';
import { initiateShutdown } from '../../shutdown.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

interface ShutdownArgs {
  drainTimeoutMs: number;
  mode: string;
}

function flagSet(v: unknown): boolean {
  return v != null && v !== false && v !== 'false';
}

export function parseShutdownArgs(raw: Record<string, unknown>): ShutdownArgs {
  if (flagSet(raw.now)) return { drainTimeoutMs: 0, mode: 'immediate' };
  if (flagSet(raw.wait)) return { drainTimeoutMs: MAX_DRAIN_TIMEOUT_MS, mode: 'wait-for-completion' };
  if (raw.drain != null) {
    const ms = parseInt(String(raw.drain), 10);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('--drain expects a non-negative integer (milliseconds)');
    return { drainTimeoutMs: ms, mode: `drain ${ms}ms` };
  }
  return { drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS, mode: `drain ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms (default)` };
}

register<ShutdownArgs, { ok: true; mode: string }>({
  name: 'shutdown',
  description: 'Shut down the host: drain containers (wait for idle), then stop. Flags: --now | --drain <ms> | --wait.',
  access: 'open',
  parseArgs: parseShutdownArgs,
  handler: async (args, ctx: CallerContext) => {
    if (ctx.caller !== 'host') {
      throw new Error('shutdown is host-only; an agent cannot shut down its host.');
    }
    // Ack first; run teardown on the next tick so this response flushes before
    // the CLI socket is closed inside initiateShutdown.
    setImmediate(() => void initiateShutdown(args.drainTimeoutMs, 'ncl shutdown'));
    return { ok: true, mode: args.mode };
  },
});
