/**
 * Credential broker registry — centralized credential management behind the
 * proxy, the counterpart to the local providers.
 *
 * Two credential-management models meet at the proxy:
 *
 *   - **Providers** (`credentials/providers/registry.ts`) are *local*: creds
 *     set ad-hoc per group, and they **fail open** — a request with no
 *     resolvable key is forwarded unmodified (it still egresses).
 *   - **Brokers** (this registry) are *centralized* (OneCLI): an external
 *     vault, operator-assigned per agent identity, that can **deny** a request
 *     when no authorized key is present. A broker is therefore an enforcement
 *     layer, not just another credential source.
 *
 * A broker only ever handles a request that the per-group **delegation** config
 * routes to it — either an *overtake* of a provider/host (covered space) or a
 * *catch-all* over uncovered space. When routed to, the broker is the
 * **terminal owner** of that request: it pipes the request to its own backend
 * (for OneCLI, the agent's gateway proxy) and pipes the response back. There is
 * no "decline and hand back" — if the backend has no key it returns its own
 * error (e.g. `app_not_connected`), which is the response. Hence the broker is
 * a plain pipe-style handler, same shape as a provider `HostHandler`; it never
 * needs to buffer or signal a decline.
 *
 * Registry semantics differ from the provider registry on purpose: providers
 * **throw** on a duplicate id (always a bug), brokers **warn-and-overwrite**
 * (symmetric with `registerHostCommand`) — re-registering replaces the prior
 * one. `priority` orders brokers; it only matters once a single delegation can
 * fan out to several brokers (a "walk-by-priority"), which is future work — one
 * explicitly-delegated broker today.
 */
import type { IncomingMessage, ServerResponse } from 'http';

import { logger } from './logger.js';
import type { GroupScope } from './types.js';

/**
 * A broker's request handler — same argument shape as a proxy `HostHandler`,
 * and the same contract: it owns the full round-trip and writes the response.
 * It is invoked only when delegation has routed the request to this broker, so
 * it is always the terminal owner; there is no decline.
 */
export type BrokerForward = (
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  scope: GroupScope,
  /** Original container bridge IP (connection-time, not the MITM socket). */
  sourceIP?: string,
) => Promise<void>;

export interface CredentialBroker {
  readonly id: string;
  /** Lower runs first. Default 0. Ties broken by registration order. */
  readonly priority?: number;
  tryForward: BrokerForward;

  /**
   * Per-container setup, fired at IP-allocate **only for containers this broker
   * is routed to** (demand-driven, spec §3b) — the eager-init half of the
   * per-container model. For OneCLI: `ensureAgent` + fetch this agent's gateway
   * config (proxy address + CA), cached by `ip`. May be async; the broker
   * should cache the in-flight promise so `tryForward` can await it and **fail
   * closed** if init rejected (never silently pass through). Errors are the
   * broker's to surface at request time, not the snapshot's.
   */
  onContainerRouted?(ip: string, scope: GroupScope): void | Promise<void>;

  /** Drop per-container state at IP-release. */
  onContainerReleased?(ip: string): void;
}

interface RegisteredBroker {
  broker: CredentialBroker;
  /** Monotonic registration index — stable tiebreak for equal priority. */
  seq: number;
}

const brokers = new Map<string, RegisteredBroker>();
let regSeq = 0;

/**
 * Register a credential broker. Warn-and-overwrite on duplicate id: the
 * replacement keeps a fresh registration index (so a re-register moves it to
 * the back of its priority band, matching last-write-wins intent).
 */
export function registerCredentialBroker(b: CredentialBroker): void {
  if (brokers.has(b.id)) {
    logger.warn({ brokerId: b.id }, 'Credential broker re-registered — overwriting');
  }
  brokers.set(b.id, { broker: b, seq: regSeq++ });
}

/** Look up a broker by id, or undefined. The delegation config names one. */
export function getCredentialBroker(id: string): CredentialBroker | undefined {
  return brokers.get(id)?.broker;
}

/**
 * All registered brokers, sorted by ascending `priority` (default 0) with
 * registration order as a stable tiebreak.
 */
export function getCredentialBrokers(): CredentialBroker[] {
  return Array.from(brokers.values())
    .sort((a, b) => {
      const pa = a.broker.priority ?? 0;
      const pb = b.broker.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.seq - b.seq;
    })
    .map((r) => r.broker);
}

/** Whether any broker is registered. Cheap predicate for gating delegation. */
export function hasCredentialBrokers(): boolean {
  return brokers.size > 0;
}

/** Test-only: clear all registrations. Not exported from the barrel. */
export function _resetBrokerRegistryForTests(): void {
  brokers.clear();
  regSeq = 0;
}
