/**
 * Container-bootstrap module.
 *
 * Owns the full container-launch contract:
 *   1. Snapshot management (`snapshot.ts`) — copy `container/` once at host
 *      boot so mid-run host edits don't break in-flight containers.
 *   2. Default launch shape (`launch-shape.ts`) — the snapshot-derived mounts
 *      every container gets (entrypoint, agent-runner src, skills, CLAUDE.md).
 *   3. Lifecycle observers (`registry.ts` + `fire.ts`) — `onSpawnPre`,
 *      `onContainerStarted`, `onContainerExited`. Subsumes P1.
 *   4. Privilege-mode resolution (`privilege.ts`) — rootless vs root-drop.
 *   5. Bridge-network IP allocation (`ip-registry.ts` + `network.ts`) — process-
 *      local map IP → ContainerScope, plus the docker network plumbing. The
 *      allocation itself is wired through the lifecycle pipeline by
 *      `ip-observer.ts`, which self-registers on import.
 *
 * No DB, no migrations. `initSnapshot()` and `ensureContainerNetwork()` are
 * the only entry points that touch host state; both are called explicitly
 * from `src/index.ts` at boot.
 */

// IP registry + bridge network
export type { AllocatedIP, AllocateListener, ReleaseListener, ContainerScope } from './types.js';
export { asContainerScope } from './types.js';
export {
  allocateContainerIP,
  lookupContainerIP,
  lookupContainerSession,
  lookupIPForSession,
  lookupIPsForScope,
  onAllocate,
  onRelease,
} from './ip-registry.js';
export { ensureContainerNetwork, networkArgs } from './network.js';

// Snapshot
export { initSnapshot, snapshotPath } from './snapshot.js';

// Default launch shape
export { defaultLaunchShape } from './launch-shape.js';
export type { LaunchShape } from './launch-shape.js';

// Observer registry
export type {
  ContainerLifecycleObserver,
  SpawnPreContext,
  SpawnPreResult,
  LifecycleContext,
  ExitContext,
  ExitReason,
  MergedSpawnPre,
} from './types.js';
export { registerContainerLifecycleObserver, clearContainerLifecycleObservers } from './registry.js';
export { fireSpawnPre, fireContainerStarted, fireContainerExited } from './fire.js';

// Privilege mode
export { resolveLaunchMode } from './privilege.js';
export type { LaunchMode, HostIds } from './privilege.js';

// Reserved env-name registry (the protected-name map + the static container
// reservations: TZ / HOME / HOST_UID / HOST_GID / ENSURE_PASSWD_ENTRY).
// Consumed by per-group custom-env validation (container-env).
export { reserveEnvName, isEnvNameReserved, reservedEnvNames, _resetReservedEnvForTests } from './reserved-env.js';

// Side-effects: built-in IP allocation observer + reserved-env statics.
import './ip-observer.js';
import './reserved-env.js';
// Side-effect: register the egress-lockdown observer (no-op unless opted in).
import './egress-observer.js';
