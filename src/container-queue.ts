/**
 * Container admission queue — global concurrency cap + demand-driven eviction.
 *
 * Port of the fork's `group-queue.ts` 4-state lifecycle onto v2's two-DB /
 * poll-on-wake model. v2 differs structurally: a warm container holds its slot
 * by *idle-polling* its session DB (not by a held stdin process), and inbound
 * rows are durable in `inbound.db`, so this queue is an admission gate +
 * fairness/eviction layer rather than a message pipe. Behavior preserved from
 * v1 (see docs/fls/migration-analysis/d-queue-concurrency-risks.md):
 *
 *   P1  occupancy (active + reserved) is mutated synchronously, so concurrent
 *       wakes can't both pass the cap — the reserve is claimed *before* the
 *       caller's first await.
 *   P3  eviction is throttled: never evict more than the unmet demand, because
 *       in-flight stops already free that many slots.
 *   P4  the waiting list dedups and drains FIFO (fairness; fixes v2's R8
 *       starvation — the sweep has no ORDER BY).
 *   P9  on a container exit the freed slot is handed to waiters immediately
 *       (drain), not on the next 60s sweep tick.
 *   P10 a shutdown latch blocks new admissions + drains.
 *
 * All state is mutated only within synchronous event-loop turns (the v1
 * single-threaded safety model); the side-effecting operations (spawn, evict)
 * are injected so the queue is unit-testable without Docker or a DB.
 */
import { log } from './log.js';

export interface EvictionCandidate {
  sessionId: string;
  /** Heartbeat file mtime in ms; 0 when the container never wrote one. */
  heartbeatMtimeMs: number;
  /** True if the container holds an outstanding 'processing' claim (mid-turn). */
  hasOutstandingClaim: boolean;
  /** When the container was spawned (ms epoch) — idle proxy when no heartbeat. */
  spawnedAt: number;
}

/**
 * Idle age of a candidate: time since its last sign of life. Heartbeat mtime
 * when present (the container touches it per SDK event during a turn), else
 * time since spawn (a container that found no work and never ticked).
 */
function idleReference(c: EvictionCandidate): number {
  return c.heartbeatMtimeMs > 0 ? c.heartbeatMtimeMs : c.spawnedAt;
}

export function idleAgeMs(c: EvictionCandidate, now: number): number {
  return now - idleReference(c);
}

/**
 * Pick the oldest-idle eviction victim, or null. A candidate is evictable iff
 * it has been idle longer than `idleBeforeEvictMs` (protection window), holds
 * no outstanding claim (not mid-turn — guards against killing a container
 * blocked in a long, quiet tool call), and is not already being evicted.
 * Oldest idle wins (LRU).
 */
export function pickEvictionVictim(
  candidates: EvictionCandidate[],
  evicting: ReadonlySet<string>,
  idleBeforeEvictMs: number,
  now: number,
): string | null {
  let victim: string | null = null;
  let oldest = Infinity;
  for (const c of candidates) {
    if (evicting.has(c.sessionId)) continue;
    if (c.hasOutstandingClaim) continue;
    if (idleAgeMs(c, now) < idleBeforeEvictMs) continue;
    const ref = idleReference(c);
    if (ref < oldest) {
      oldest = ref;
      victim = c.sessionId;
    }
  }
  return victim;
}

export interface ContainerQueueDeps {
  cap: number;
  idleBeforeEvictMs: number;
  now: () => number;
  /** Count of live containers (activeContainers.size). */
  activeCount: () => number;
  /** Is this session's container currently live? */
  isActive: (sessionId: string) => boolean;
  /** Does this session still exist + want to run? Re-resolved at drain time. */
  canSpawn: (sessionId: string) => boolean;
  /** Begin spawning (reserve already counted). Async kickoff; must not throw. */
  spawn: (sessionId: string) => void;
  /** Kill a container to free its slot (demand eviction). */
  evict: (sessionId: string) => void;
  /** Current eviction candidates, built from live-container liveness. */
  candidates: () => EvictionCandidate[];
}

export class ContainerQueue {
  private reserved = new Set<string>();
  private waiting: string[] = [];
  private evicting = new Set<string>();
  private shuttingDown = false;
  /** Live concurrency cap; starts at deps.cap, adjustable via setCapacity. */
  private cap: number;

  constructor(private deps: ContainerQueueDeps) {
    this.cap = deps.cap;
  }

  /** active + reserved — the true slot occupancy. */
  occupancy(): number {
    return this.deps.activeCount() + this.reserved.size;
  }

  /**
   * Admission decision for a wake. Returns 'reserved' (caller proceeds to
   * spawn) or 'deferred' (the inbound row stays pending; re-tried on drain or
   * the next sweep tick). Synchronous — the reserve is claimed before the
   * caller's first await so two concurrent wakes can't both pass the cap (P1).
   */
  admit(sessionId: string): 'reserved' | 'deferred' {
    // Hard latch: a 0 cap (graceful drain / runtime pause) or teardown defers
    // with no enqueue and no evict-to-serve — a draining host must never spawn
    // or evict a warm container to admit fresh work.
    if (this.cap <= 0 || this.shuttingDown) return 'deferred';
    if (this.occupancy() >= this.cap) {
      this.enqueueWaiting(sessionId);
      this.tryEvict();
      return 'deferred';
    }
    this.reserved.add(sessionId);
    return 'reserved';
  }

  /**
   * Adjust the concurrency cap at runtime. Lowering it below current occupancy
   * immediately pings idle containers to stop (`shedIdleOverCapacity`); raising
   * it drains waiters into the new headroom. `cap = 0` is the graceful-drain
   * latch — "handle no fresh work" — so the whole drain is `setCapacity(0)`.
   */
  setCapacity(cap: number): void {
    this.cap = Math.max(0, Math.floor(cap));
    this.shedIdleOverCapacity();
    this.drain();
  }

  /** Current cap (observability / drain orchestration). */
  capacity(): number {
    return this.cap;
  }

  /**
   * Over-capacity shed: if there are more containers than the cap allows, ping
   * every idle one (no outstanding claim, not already stopping) to stop. Simple
   * by design — no victim ordering, no throttle: too many ⇒ stop all idle. A
   * mid-turn container is skipped and re-pinged once its claim clears (the host
   * sweep re-runs this each tick). With `cap = 0` this stops every container as
   * it goes idle — the engine behind `beginGracefulDrain`.
   */
  shedIdleOverCapacity(): void {
    if (this.occupancy() <= this.cap) return;
    for (const c of this.deps.candidates()) {
      if (c.hasOutstandingClaim) continue; // mid-turn — let it finish; sweep re-pings
      if (this.evicting.has(c.sessionId)) continue; // already stopping
      this.evicting.add(c.sessionId);
      log.info('Shedding idle container over capacity', { sessionId: c.sessionId, cap: this.cap });
      this.deps.evict(c.sessionId);
    }
  }

  /**
   * Reserve→active handoff: the slot is now owned by activeContainers, so just
   * drop the reserve (no slot freed — do NOT drain). Idempotent.
   */
  releaseReserve(sessionId: string): void {
    this.reserved.delete(sessionId);
  }

  /**
   * Failure release: a spawn returned/threw without producing a live container
   * (e.g. the `!agentGroup` early-return, or a throw before the container is
   * registered). This frees a reserved slot, so waiters must be serviced now —
   * otherwise the slot sits idle until the next exit/sweep. Idempotent.
   */
  releaseReserveAndDrain(sessionId: string): void {
    this.reserved.delete(sessionId);
    this.drain();
  }

  /** Container exit: clear stop state + hand the freed slot to waiters (P9). */
  onExit(sessionId: string): void {
    this.evicting.delete(sessionId);
    this.reserved.delete(sessionId);
    this.drain();
  }

  /** P10 — block new admissions + drains during teardown. */
  setShuttingDown(): void {
    this.shuttingDown = true;
  }

  // ── observability / tests ──
  waitingCount(): number {
    return this.waiting.length;
  }
  isEvicting(sessionId: string): boolean {
    return this.evicting.has(sessionId);
  }
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private enqueueWaiting(sessionId: string): void {
    if (!this.waiting.includes(sessionId)) this.waiting.push(sessionId); // P4 dedup
  }

  private tryEvict(): void {
    // P3 throttle: never evict more than the unmet demand. In-flight stops
    // already free that many slots — without this, one burst at capacity would
    // evict every idle container, not just enough.
    if (this.evicting.size >= this.waiting.length) return;
    const victim = pickEvictionVictim(
      this.deps.candidates(),
      this.evicting,
      this.deps.idleBeforeEvictMs,
      this.deps.now(),
    );
    if (!victim) return;
    this.evicting.add(victim);
    log.info('Evicting idle container for queue pressure', { sessionId: victim });
    this.deps.evict(victim);
  }

  private drain(): void {
    if (this.shuttingDown || this.cap <= 0) return;
    // FIFO hand-off. The reserve is claimed synchronously per iteration, so
    // occupancy() reflects it immediately and the loop stays bounded by the cap.
    while (this.waiting.length > 0 && this.occupancy() < this.cap) {
      const sessionId = this.waiting.shift()!;
      if (this.deps.isActive(sessionId)) continue; // already running (a later wake won)
      if (!this.deps.canSpawn(sessionId)) continue; // session gone / no longer active
      this.reserved.add(sessionId);
      this.deps.spawn(sessionId);
    }
  }
}
