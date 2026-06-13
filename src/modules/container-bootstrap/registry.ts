/**
 * Container lifecycle observer registry.
 *
 * Subsumes P1. Observers register an `id` + a `ContainerLifecycleObserver`;
 * the container-runner invokes `fireSpawnPre` / `fireContainerStarted` /
 * `fireContainerExited` from `fire.ts`.
 *
 * Contract:
 *   - Duplicate id throws at registration.
 *   - Observers run in registration order.
 *   - All callbacks are synchronous. No await.
 *   - A throwing observer is logged with id + phase + err and does not
 *     abort dispatch of remaining observers — except in `onSpawnPre`,
 *     where a throw becomes a FatalSpawnError (wrapped by the caller,
 *     not this registry, to keep this file core-free).
 *   - `cleanup` callbacks returned from `onSpawnPre` results are collected
 *     and run from `onContainerExited`, even if no observer registered an
 *     exit hook and even if the spawn failed before the process was alive.
 */
import type { ContainerLifecycleObserver } from './types.js';

interface Entry {
  id: string;
  obs: ContainerLifecycleObserver;
}

const registry: Entry[] = [];

export function registerContainerLifecycleObserver(id: string, obs: ContainerLifecycleObserver): void {
  if (registry.some((e) => e.id === id)) {
    throw new Error(`Container lifecycle observer already registered: ${id}`);
  }
  registry.push({ id, obs });
}

/** Test-only. */
export function clearContainerLifecycleObservers(): void {
  registry.length = 0;
}

/** @internal — used by fire.ts. */
export function __listObservers(): readonly Entry[] {
  return registry;
}
