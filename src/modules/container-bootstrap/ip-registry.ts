/**
 * Container-IP registry — process-local map from container IP to its allocation
 * record (scope + session). Container↔IP↔session is 1:1.
 *
 * Ephemeral: lives in memory for the host's lifetime. Containers spawn fresh
 * after a host restart, so the map starting empty is correct.
 *
 * Sole consumer today: container-runner allocates on spawn and releases on
 * exit. Lookup callers (C12 host-rpc; future C2 cred proxy) consult
 * `lookupContainerIP` to resolve `incoming connection IP → scope`, and the
 * sync-action wakeup consults `lookupContainerSession` to resolve the caller's
 * session from its IP — authoritative and unspoofable, unlike a
 * container-supplied id.
 *
 * Scope and session share one record (one lifecycle: set together at allocate,
 * deleted together at release) so the two can never drift.
 *
 * Event hooks (`onAllocate`, `onRelease`) exist so future consumers that
 * want to react to lifecycle (rather than poll-on-request) can subscribe
 * without modifying this module.
 */
import { allocateIPFromPool, releaseIPToPool } from './network.js';
import type { ContainerScope, AllocatedIP, AllocateListener, ReleaseListener } from './types.js';
import { log } from '../../log.js';

interface AllocationRecord {
  scope: ContainerScope;
  /** undefined only if allocated without a session (e.g. some tests). */
  sessionId?: string;
}

const byIp = new Map<string, AllocationRecord>();
const allocateListeners = new Set<AllocateListener>();
const releaseListeners = new Set<ReleaseListener>();

export function allocateContainerIP(scope: ContainerScope, sessionId?: string): AllocatedIP {
  const ip = allocateIPFromPool((candidate) => !byIp.has(candidate));
  byIp.set(ip, { scope, sessionId });

  for (const fn of allocateListeners) {
    try {
      fn(ip, scope);
    } catch (err) {
      log.error('container-ip onAllocate listener threw', { ip, err });
    }
  }

  let released = false;
  return {
    ip,
    release(): void {
      if (released) return;
      released = true;
      const owner = byIp.get(ip)?.scope;
      byIp.delete(ip);
      releaseIPToPool(ip);
      if (owner !== undefined) {
        for (const fn of releaseListeners) {
          try {
            fn(ip, owner);
          } catch (err) {
            log.error('container-ip onRelease listener threw', { ip, err });
          }
        }
      }
    },
  };
}

export function lookupContainerIP(ip: string): ContainerScope | null {
  return byIp.get(ip)?.scope ?? null;
}

/** Resolve the session id bound to a container IP (1:1 with the container).
 * Returns null if the IP isn't allocated or was allocated without a session. */
export function lookupContainerSession(ip: string): string | null {
  return byIp.get(ip)?.sessionId ?? null;
}

/** Resolve the container IP bound to a session id — the reverse of
 * `lookupContainerSession` (container↔IP↔session is 1:1). Used by sync-action
 * handlers that act on the caller's per-container state (e.g. reloading its
 * OAuth provider tier) but only receive the session, not the IP. Returns null
 * if no allocated IP carries that session. */
export function lookupIPForSession(sessionId: string): string | null {
  for (const [ip, rec] of byIp) {
    if (rec.sessionId === sessionId) return ip;
  }
  return null;
}

export function lookupIPsForScope(scope: ContainerScope): readonly string[] {
  const out: string[] = [];
  for (const [ip, rec] of byIp) {
    if (rec.scope === scope) out.push(ip);
  }
  return out;
}

export function onAllocate(fn: AllocateListener): () => void {
  allocateListeners.add(fn);
  return () => allocateListeners.delete(fn);
}

export function onRelease(fn: ReleaseListener): () => void {
  releaseListeners.add(fn);
  return () => releaseListeners.delete(fn);
}

/** @internal — for tests. */
export function __resetRegistryForTests(): void {
  byIp.clear();
  allocateListeners.clear();
  releaseListeners.clear();
}
