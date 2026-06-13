/**
 * Per-container broker-routing snapshot (C3, the "(b) per-container init").
 *
 * At IP-allocate we know a container's IP and scope (folder), so we snapshot
 * its **effective routing** — for each enabled broker, the overtake set +
 * catch-all flag merged from the global default and the group's override
 * (`db/broker-config.effectiveRouting`). The snapshot is keyed by IP and read
 * by the proxy at dispatch, so a request never hits the DB on the hot path.
 *
 * **Demand-driven (spec §3b):** a container is recorded **only if** it routes
 * to at least one enabled broker (some overtake target or catch-all). For each
 * routed broker, the snapshot also fires that broker's `onContainerRouted` hook
 * — its per-container setup (OneCLI: `ensureAgent` + fetch the agent's gateway
 * config, cached by IP). A container that delegates to no broker gets no entry
 * and no broker work runs at all.
 *
 * Lifecycle mirrors the per-group OAuth tier (`observer.ts`): snapshot on
 * `onAllocate`, drop on `onRelease`.
 */
import { effectiveRouting, listEnabledBrokerIds } from '../../db/broker-config.js';

import { getCredentialBroker } from './broker-registry.js';
import { logger } from './logger.js';
import { asGroupScope } from './types.js';

/** One broker's routing as it applies to a single container. */
export interface RoutedBroker {
  brokerId: string;
  /** Provider ids and/or host patterns this broker overtakes. */
  overtake: string[];
  /** Whether this broker handles the uncovered space. */
  catchAll: boolean;
}

const byIp = new Map<string, RoutedBroker[]>();

/**
 * Snapshot the effective broker routing for a container at allocate time.
 * Records the IP only when the scope routes to ≥1 enabled broker (demand).
 */
export function snapshotBrokerRouting(ip: string, folder: string): void {
  const routed: RoutedBroker[] = [];
  for (const brokerId of listEnabledBrokerIds()) {
    const r = effectiveRouting(brokerId, folder);
    if (r.overtake.length > 0 || r.catchAll) {
      routed.push({ brokerId, overtake: r.overtake, catchAll: r.catchAll });
    }
  }
  if (routed.length === 0) {
    byIp.delete(ip);
    return;
  }
  byIp.set(ip, routed);

  // Eager per-container broker setup (demand-driven): only the routed brokers
  // get their per-container hook. Async errors are the broker's to surface at
  // request time (fail-closed); we just log a sync throw / rejection.
  for (const r of routed) {
    const broker = getCredentialBroker(r.brokerId);
    if (!broker?.onContainerRouted) continue;
    try {
      void Promise.resolve(broker.onContainerRouted(ip, asGroupScope(folder))).catch((err: unknown) => {
        logger.error({ err, brokerId: r.brokerId, ip }, 'broker onContainerRouted rejected');
      });
    } catch (err) {
      logger.error({ err, brokerId: r.brokerId, ip }, 'broker onContainerRouted threw');
    }
  }
}

/** Drop a container's routing snapshot + per-container broker state at release. */
export function dropBrokerRouting(ip: string): void {
  const routed = byIp.get(ip);
  byIp.delete(ip);
  for (const r of routed ?? []) {
    try {
      getCredentialBroker(r.brokerId)?.onContainerReleased?.(ip);
    } catch (err) {
      logger.error({ err, brokerId: r.brokerId, ip }, 'broker onContainerReleased threw');
    }
  }
}

/** The routing snapshot for a container IP, or `[]` if none. */
export function getBrokerRouting(ip: string): readonly RoutedBroker[] {
  return byIp.get(ip) ?? [];
}

/** Any container routed to a broker? Cheap gate for the dispatch hot path. */
export function hasAnyBrokerRouting(): boolean {
  return byIp.size > 0;
}

/** Test-only: clear all snapshots. */
export function _resetBrokerRoutingForTests(): void {
  byIp.clear();
}
