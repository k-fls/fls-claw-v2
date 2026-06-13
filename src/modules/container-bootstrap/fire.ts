/**
 * Lifecycle dispatchers.
 *
 * Called by `src/container-runner.ts` at the three phases:
 *   - fireSpawnPre   — before docker spawn; aggregates onSpawnPre results.
 *                      Any observer throw is wrapped in FatalSpawnError so
 *                      the caller's existing FatalSpawnError catch path
 *                      classifies it as non-retryable.
 *   - fireContainerStarted — after spawn process is alive, before first poll.
 *   - fireContainerExited  — exactly once per session that saw onContainerStarted,
 *                      and once with reason='spawn-error' for failed spawns.
 *                      Runs collected `cleanup` callbacks from onSpawnPre
 *                      results in registration order; observer-thrown
 *                      errors are logged but never propagate.
 */
import { log } from '../../log.js';
import { FatalSpawnError } from '../../spawn-failure.js';
import { __listObservers } from './registry.js';
import type { ExitContext, LifecycleContext, MergedSpawnPre, SpawnPreContext } from './types.js';

export function fireSpawnPre(ctx: SpawnPreContext): MergedSpawnPre {
  const merged: MergedSpawnPre = {
    mounts: [],
    env: {},
    args: [],
    needsRootEntrypoint: false,
    cleanups: [],
  };
  const envOrigin = new Map<string, string>();

  for (const entry of __listObservers()) {
    if (!entry.obs.onSpawnPre) continue;
    let result;
    try {
      result = entry.obs.onSpawnPre(ctx);
    } catch (err) {
      throw new FatalSpawnError(
        `Container lifecycle observer "${entry.id}" onSpawnPre failed: ${(err as Error).message ?? String(err)}`,
        { cause: err },
      );
    }
    if (!result) continue;
    if (result.mounts && result.mounts.length > 0) merged.mounts.push(...result.mounts);
    if (result.args && result.args.length > 0) merged.args.push(...result.args);
    if (result.needsRootEntrypoint) merged.needsRootEntrypoint = true;
    if (result.cleanup) {
      // Wrap in a once-shim at the collection boundary. Cleanup idempotency
      // is a contract claim in `SpawnPreResult` — enforce it here so it
      // holds regardless of how many times (or from where) `fireContainerExited`
      // is invoked.
      const fn = result.cleanup;
      let ran = false;
      merged.cleanups.push(() => {
        if (ran) return;
        ran = true;
        fn();
      });
    }
    if (result.env) {
      for (const [key, value] of Object.entries(result.env)) {
        const prior = envOrigin.get(key);
        if (prior !== undefined && merged.env[key] !== value) {
          log.warn('Container lifecycle observer env key collision (last-write-wins)', {
            key,
            priorId: prior,
            priorValue: merged.env[key],
            newId: entry.id,
            newValue: value,
          });
        }
        merged.env[key] = value;
        envOrigin.set(key, entry.id);
      }
    }
  }

  return merged;
}

export function fireContainerStarted(ctx: LifecycleContext): void {
  for (const entry of __listObservers()) {
    if (!entry.obs.onContainerStarted) continue;
    try {
      entry.obs.onContainerStarted(ctx);
    } catch (err) {
      log.error('Container lifecycle observer onContainerStarted threw', {
        id: entry.id,
        sessionId: ctx.session.id,
        err,
      });
    }
  }
}

export function fireContainerExited(ctx: ExitContext, cleanups: ReadonlyArray<() => void> = []): void {
  for (const fn of cleanups) {
    try {
      fn();
    } catch (err) {
      log.error('Container lifecycle cleanup threw', { sessionId: ctx.session.id, err });
    }
  }
  for (const entry of __listObservers()) {
    if (!entry.obs.onContainerExited) continue;
    try {
      entry.obs.onContainerExited(ctx);
    } catch (err) {
      log.error('Container lifecycle observer onContainerExited threw', {
        id: entry.id,
        sessionId: ctx.session.id,
        err,
      });
    }
  }
}
