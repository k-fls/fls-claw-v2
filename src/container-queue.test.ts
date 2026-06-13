import { describe, expect, it } from 'vitest';

import { ContainerQueue, pickEvictionVictim, idleAgeMs, type EvictionCandidate } from './container-queue.js';

const IDLE = 600_000; // 10min protection window

function cand(sessionId: string, over: Partial<EvictionCandidate> = {}): EvictionCandidate {
  return {
    sessionId,
    heartbeatMtimeMs: 0,
    hasOutstandingClaim: false,
    spawnedAt: 0,
    ...over,
  };
}

/**
 * Test harness simulating the container-runner side of the injected deps:
 * `active` is the live-container set (activeContainers), `spawned`/`evicted`
 * record the side effects, and helpers model the real lifecycle transitions
 * (spawn kickoff → handoff → exit). A wake mirrors `wakeContainer`: admit, and
 * on 'reserved' kick off a spawn (beginSpawn).
 */
function harness(cap: number, idleBeforeEvictMs = IDLE) {
  const active = new Set<string>();
  const candidates: EvictionCandidate[] = [];
  const spawned: string[] = [];
  const evicted: string[] = [];
  let canSpawnFn: (id: string) => boolean = () => true;
  let now = 1_000_000_000;

  const q = new ContainerQueue({
    cap,
    idleBeforeEvictMs,
    now: () => now,
    activeCount: () => active.size,
    isActive: (id) => active.has(id),
    canSpawn: (id) => canSpawnFn(id),
    spawn: (id) => {
      spawned.push(id);
    },
    evict: (id) => {
      evicted.push(id);
    },
    candidates: () => candidates.filter((c) => active.has(c.sessionId)),
  });

  return {
    q,
    active,
    candidates,
    spawned,
    evicted,
    setNow: (t: number) => {
      now = t;
    },
    setCanSpawn: (fn: (id: string) => boolean) => {
      canSpawnFn = fn;
    },
    /** External wake (router/sweep): admit + beginSpawn on reserve. */
    wake(id: string): 'running' | 'reserved' | 'deferred' {
      if (active.has(id)) return 'running';
      const d = q.admit(id);
      if (d === 'reserved') spawned.push(id);
      return d;
    },
    /** Spawn handed off to a live container (activeContainers.set). */
    complete(id: string, over: Partial<EvictionCandidate> = {}) {
      active.add(id);
      q.releaseReserve(id);
      candidates.push(cand(id, over));
    },
    /** Spawn returned/threw without producing a live container. */
    fail(id: string) {
      q.releaseReserveAndDrain(id);
    },
    /** Container exited. */
    exit(id: string) {
      active.delete(id);
      const i = candidates.findIndex((c) => c.sessionId === id);
      if (i >= 0) candidates.splice(i, 1);
      q.onExit(id);
    },
  };
}

describe('pickEvictionVictim', () => {
  const now = 10_000_000;

  it('picks the oldest-idle (lowest heartbeat) candidate', () => {
    const v = pickEvictionVictim(
      [
        cand('a', { heartbeatMtimeMs: now - 2 * IDLE }),
        cand('b', { heartbeatMtimeMs: now - 3 * IDLE }), // oldest
        cand('c', { heartbeatMtimeMs: now - 2.5 * IDLE }),
      ],
      new Set(),
      IDLE,
      now,
    );
    expect(v).toBe('b');
  });

  it('excludes a freshly-idle container (within the protection window)', () => {
    const v = pickEvictionVictim([cand('a', { heartbeatMtimeMs: now - IDLE / 2 })], new Set(), IDLE, now);
    expect(v).toBeNull();
  });

  it('excludes a container holding an outstanding claim (mid-turn, possibly long tool call)', () => {
    const v = pickEvictionVictim(
      [cand('a', { heartbeatMtimeMs: now - 5 * IDLE, hasOutstandingClaim: true })],
      new Set(),
      IDLE,
      now,
    );
    expect(v).toBeNull();
  });

  it('excludes a session already being evicted', () => {
    const v = pickEvictionVictim([cand('a', { heartbeatMtimeMs: now - 5 * IDLE })], new Set(['a']), IDLE, now);
    expect(v).toBeNull();
  });

  it('uses spawnedAt as the idle proxy when no heartbeat was ever written', () => {
    // No heartbeat, but alive (spawned) long ago with no claim → evictable.
    const v = pickEvictionVictim([cand('a', { heartbeatMtimeMs: 0, spawnedAt: now - 5 * IDLE })], new Set(), IDLE, now);
    expect(v).toBe('a');
    // …but a just-spawned no-heartbeat container is protected.
    const v2 = pickEvictionVictim(
      [cand('b', { heartbeatMtimeMs: 0, spawnedAt: now - IDLE / 2 })],
      new Set(),
      IDLE,
      now,
    );
    expect(v2).toBeNull();
  });

  it('idleAgeMs prefers heartbeat, falls back to spawnedAt', () => {
    expect(idleAgeMs(cand('a', { heartbeatMtimeMs: now - 1000, spawnedAt: now - 99999 }), now)).toBe(1000);
    expect(idleAgeMs(cand('a', { heartbeatMtimeMs: 0, spawnedAt: now - 1000 }), now)).toBe(1000);
  });
});

describe('ContainerQueue — admission & cap', () => {
  it('admits under the cap and tracks occupancy (active + reserved)', () => {
    const h = harness(2);
    expect(h.wake('s1')).toBe('reserved');
    expect(h.q.occupancy()).toBe(1); // reserved, not yet live
    h.complete('s1');
    expect(h.q.occupancy()).toBe(1); // handed off to active — no double count
  });

  it('defers a wake at the cap and queues the session', () => {
    const h = harness(1);
    h.wake('s1');
    h.complete('s1');
    expect(h.wake('s2')).toBe('deferred');
    expect(h.q.waitingCount()).toBe(1);
    expect(h.q.occupancy()).toBe(1);
  });

  it('two concurrent reserves cannot both pass the cap (P1 — reserve before handoff)', () => {
    const h = harness(1);
    // Both wakes happen before either spawn hands off → second must defer.
    expect(h.wake('s1')).toBe('reserved');
    expect(h.wake('s2')).toBe('deferred');
    expect(h.q.occupancy()).toBe(1);
  });

  it('releases the reserve on spawn failure so the slot is reusable (R9 — no leak)', () => {
    const h = harness(1);
    h.wake('s1');
    expect(h.q.occupancy()).toBe(1);
    h.fail('s1'); // spawn threw / !agentGroup early return
    expect(h.q.occupancy()).toBe(0);
    expect(h.wake('s2')).toBe('reserved'); // slot freed
  });

  it('a spawn failure frees the slot AND drains a waiter (no idle slot until next exit)', () => {
    const h = harness(1);
    h.wake('s1'); // reserved, spawning
    h.wake('s2'); // deferred, queued (at cap by the reserve)
    expect(h.q.waitingCount()).toBe(1);
    h.fail('s1'); // s1 spawn threw → slot freed → drain s2
    expect(h.spawned).toContain('s2');
    expect(h.q.waitingCount()).toBe(0);
  });

  it('dedups a session that is deferred twice (P4)', () => {
    const h = harness(1);
    h.wake('s1');
    h.complete('s1');
    h.wake('s2');
    h.wake('s2'); // e.g. router + sweep both wake it
    expect(h.q.waitingCount()).toBe(1);
  });
});

describe('ContainerQueue — drain (FIFO fairness, P9/P4 → fixes R8)', () => {
  it('hands a freed slot to the longest-waiting session first', () => {
    const h = harness(1);
    h.wake('s1');
    h.complete('s1');
    h.wake('s2'); // queued first
    h.wake('s3'); // queued second
    h.exit('s1'); // slot frees → drain
    expect(h.spawned).toEqual(['s1', 's2']); // s2 (FIFO) wins, not s3
    expect(h.q.waitingCount()).toBe(1); // s3 still waiting
  });

  it('drain respects the cap — fills only available slots', () => {
    const h = harness(2);
    h.wake('a');
    h.complete('a');
    h.wake('b');
    h.complete('b');
    h.wake('c'); // deferred
    h.wake('d'); // deferred
    h.exit('a'); // one slot frees
    // Only one of the two waiters spawns; cap respected.
    expect(h.spawned.filter((x) => x === 'c' || x === 'd')).toHaveLength(1);
    expect(h.q.occupancy()).toBe(2);
  });

  it('drain skips a session that is already running', () => {
    const h = harness(2);
    h.wake('a');
    h.complete('a');
    h.wake('b');
    h.complete('b');
    h.wake('c'); // deferred, queued
    // c somehow became active via another path before drain:
    h.active.add('c');
    h.exit('a');
    expect(h.spawned).not.toContain('c'); // skipped — already running
  });

  it('drain skips a session that no longer wants to spawn', () => {
    const h = harness(1);
    h.wake('a');
    h.complete('a');
    h.wake('b'); // deferred
    h.setCanSpawn((id) => id !== 'b'); // session b gone / inactive
    h.exit('a');
    expect(h.spawned).not.toContain('b');
    expect(h.q.waitingCount()).toBe(0); // shifted off, not requeued
  });
});

describe('ContainerQueue — demand-driven eviction (P3)', () => {
  it('evicts the oldest idle container when a new session needs the slot', () => {
    const h = harness(1);
    const now = 10_000_000;
    h.setNow(now);
    h.wake('old');
    h.complete('old', { heartbeatMtimeMs: now - 5 * IDLE });
    h.wake('new'); // at cap → defer + evict
    expect(h.evicted).toEqual(['old']);
    expect(h.q.isEvicting('old')).toBe(true);
  });

  it('does NOT evict a freshly-idle (protected) container under pressure', () => {
    const h = harness(1);
    const now = 10_000_000;
    h.setNow(now);
    h.wake('warm');
    h.complete('warm', { heartbeatMtimeMs: now - IDLE / 2 }); // protected
    h.wake('new');
    expect(h.evicted).toEqual([]); // nothing evictable → just deferred
    expect(h.q.waitingCount()).toBe(1);
  });

  it('throttles eviction: no second eviction while one is already in flight (stoppingCount ≥ waiting)', () => {
    const h = harness(2);
    const now = 10_000_000;
    h.setNow(now);
    h.wake('a');
    h.complete('a', { heartbeatMtimeMs: now - 5 * IDLE });
    h.wake('b');
    h.complete('b', { heartbeatMtimeMs: now - 4 * IDLE });
    // First waiter → evict one (oldest = a).
    h.wake('c');
    expect(h.evicted).toEqual(['a']);
    // Second waiter while a is still evicting: evicting(1) ≥ waiting(... )?
    // waiting now has [c, d] = 2, evicting = 1 → 1 ≥ 2 false → evict b too.
    h.wake('d');
    expect(h.evicted).toEqual(['a', 'b']);
    // A third waiter with evicting(2) ≥ waiting(3)? 2 ≥ 3 false but no more
    // candidates → no extra evict.
    h.wake('e');
    expect(h.evicted).toEqual(['a', 'b']);
  });

  it('never double-evicts a session already being evicted (R6 hygiene)', () => {
    const h = harness(1);
    const now = 10_000_000;
    h.setNow(now);
    h.wake('a');
    h.complete('a', { heartbeatMtimeMs: now - 5 * IDLE });
    h.wake('b'); // evict a
    h.wake('b'); // still deferred; a already evicting → no second evict
    expect(h.evicted).toEqual(['a']);
  });

  it('evicted container exit drains the waiter into the freed slot', () => {
    const h = harness(1);
    const now = 10_000_000;
    h.setNow(now);
    h.wake('old');
    h.complete('old', { heartbeatMtimeMs: now - 5 * IDLE });
    h.wake('new'); // deferred, evict old
    h.exit('old'); // eviction completes → slot frees → drain
    expect(h.spawned).toContain('new');
    expect(h.q.isEvicting('old')).toBe(false);
  });

  it('no eviction when every container is mid-turn (claimed) — stays deferred', () => {
    const h = harness(1);
    const now = 10_000_000;
    h.setNow(now);
    h.wake('busy');
    h.complete('busy', { heartbeatMtimeMs: now - 5 * IDLE, hasOutstandingClaim: true });
    h.wake('new');
    expect(h.evicted).toEqual([]);
    expect(h.q.waitingCount()).toBe(1);
  });
});

describe('ContainerQueue — shutdown latch (P10)', () => {
  it('defers admissions and skips drain once shutting down', () => {
    const h = harness(2);
    h.wake('a');
    h.complete('a');
    h.wake('b'); // queued? no — under cap, reserved
    h.complete('b');
    h.wake('c'); // deferred, queued
    h.q.setShuttingDown();
    expect(h.q.isShuttingDown()).toBe(true);
    // New wake is refused.
    expect(h.wake('d')).toBe('deferred');
    // A slot freeing does NOT drain during shutdown.
    h.exit('a');
    expect(h.spawned).not.toContain('c');
  });
});
