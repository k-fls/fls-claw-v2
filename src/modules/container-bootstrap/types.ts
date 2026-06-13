/**
 * Container-bootstrap module — public types.
 *
 * `ContainerScope` is a branded string that identifies the owning agent
 * group of an allocated container IP. Today its value is always an
 * `agent_groups.id`, but the branding keeps the registry signature
 * distinct from other string IDs in the codebase. Callers cast at the
 * boundary via `asContainerScope`.
 *
 * Module-local — kept here rather than in `src/types.ts` so the bootstrap
 * module stands on its own without a wider type dependency.
 */
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../../types.js';

declare const __containerScope: unique symbol;

export type ContainerScope = string & { readonly [__containerScope]: true };

/** Cast a string into a ContainerScope. Use at the runtime boundary. */
export function asContainerScope(s: string): ContainerScope {
  return s as ContainerScope;
}

export interface AllocatedIP {
  readonly ip: string;
  /** Idempotent. Release the IP back to the pool and remove the registry entry. */
  release(): void;
}

export type AllocateListener = (ip: string, scope: ContainerScope) => void;
export type ReleaseListener = (ip: string, scope: ContainerScope) => void;

/* ---------- Observer registry (subsumes P1) ---------- */

export interface SpawnPreContext {
  agentGroup: AgentGroup;
  session: Session;
}

export interface SpawnPreResult {
  mounts?: VolumeMount[];
  env?: Record<string, string>;
  /** Raw docker args (e.g. `--network nanoclaw --ip 10.0.0.5`). Inserted after the
   *  default run flags and before the image arg. */
  args?: string[];
  /** If any observer sets this true, container starts as root and entrypoint
   *  drops privileges via setpriv. */
  needsRootEntrypoint?: boolean;
  /** Fires from onContainerExited (incl. spawn-error). Idempotent — observers
   *  should guard against double invocation. */
  cleanup?: () => void;
}

export interface LifecycleContext {
  agentGroup: AgentGroup;
  session: Session;
  containerName: string;
}

export type ExitReason = 'normal' | 'killed' | 'spawn-error';

export interface ExitContext extends LifecycleContext {
  exitCode: number | null;
  reason: ExitReason;
}

export interface ContainerLifecycleObserver {
  onSpawnPre?(ctx: SpawnPreContext): SpawnPreResult | void;
  onContainerStarted?(ctx: LifecycleContext): void;
  onContainerExited?(ctx: ExitContext): void;
}

/** Aggregate of all onSpawnPre results, merged by `fireSpawnPre`. */
export interface MergedSpawnPre {
  mounts: VolumeMount[];
  env: Record<string, string>;
  args: string[];
  needsRootEntrypoint: boolean;
  cleanups: Array<() => void>;
}
