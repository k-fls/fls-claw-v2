# Container Queue

The container queue is a host-side admission layer that bounds how many agent
containers run at once and decides, under pressure, which warm container to
reclaim. It enforces a global concurrency cap (`MAX_CONCURRENT_CONTAINERS`),
queues waking sessions FIFO when the cap is reached, and evicts the
oldest-idle container — but only when a new spawn actually needs the slot.

Containers are durable: every inbound message lives in the session's
`inbound.db` and a warm container holds its slot by idle-polling that DB, not by
keeping an open pipe. So the queue is purely an admission gate and fairness /
eviction layer over that durable substrate. Deferring or evicting never loses a
message — at worst a message stays pending until a slot frees, and a killed
container's in-flight claim resets to pending for the next spawn.

## Components

- `src/container-queue.ts` — the `ContainerQueue` class and the pure
  eviction-victim selector. Owns all reserve / waiting / evicting bookkeeping;
  the side effects (spawning a container, killing one) are injected so the queue
  is testable without Docker or a database.
- `src/container-runner.ts` — wires the queue to real container operations:
  admission in `wakeContainer`, the reserve→active handoff and exit drain inside
  the spawn path, `recordContainerLiveness`, graceful `killContainer`, and
  `shutdownContainers`.
- `src/container-runtime.ts` — `stopContainerGraceful`, the async `docker stop
  -t <grace>` used for graceful eviction and shutdown.
- `src/host-sweep.ts` — feeds per-session liveness into the queue each tick and
  applies the no-demand idle backstop.
- `src/config.ts` — the tuning knobs: `MAX_CONCURRENT_CONTAINERS`,
  `IDLE_BEFORE_EVICT`, `EVICTION_TIMEOUT`, `GRACEFUL_STOP_MS`.
- `container/agent-runner/src/poll-loop.ts` + `index.ts` — the container's
  graceful-stop handler, so an evicted or shutting-down container winds its
  current turn down cleanly before it dies.

## Configuration

| Knob | Default | Meaning |
|------|---------|---------|
| `MAX_CONCURRENT_CONTAINERS` | 5 | Hard cap on concurrent containers (active + reserved). Floored at 1. |
| `IDLE_BEFORE_EVICT` | 600000 (10 min) | Protection window. A container idle for less than this is never chosen as an eviction victim, so a freshly-idle container survives a brief lull. |
| `EVICTION_TIMEOUT` | 14400000 (4 h) | No-demand idle backstop. A container with a stale heartbeat and no outstanding claim is reaped after this long even with zero queue pressure. |
| `GRACEFUL_STOP_MS` | 10000 (10 s) | Grace window for a graceful stop (eviction + shutdown). Floored at 2 s. |

## Occupancy and the cap

Occupancy is `active + reserved`:

- **active** — containers tracked in the runner's live-container map, counted via
  `activeCount()`.
- **reserved** — slots claimed by a wake that has passed admission but whose
  container hasn't registered as live yet.

A reservation is claimed *synchronously*, before the caller's first `await`. This
is what makes the cap safe: two concurrent wakes both run through `admit` on the
same event-loop turn, the first claims the slot and pushes occupancy up, and the
second sees the cap is reached. Without the synchronous reserve, both could pass
the check before either had spawned, breaching the cap.

## Admission

`admit(sessionId)` returns one of two outcomes:

- **`reserved`** — there is room. A reserve is recorded and the caller proceeds to
  spawn.
- **`deferred`** — the cap is reached (or the queue is shutting down). The session
  is added to the FIFO waiting list, an eviction attempt is made, and the caller
  backs off. The inbound row stays pending, so the session is retried when a slot
  frees (drain) or, as a backstop, on the next host-sweep tick.

In the runner, a deferred wake is treated like a retryable spawn failure: it
returns without throwing and without notifying the user. The waiting list dedups
on insert — a session already queued is not added twice — which both prevents
over-spawning and gives fairness.

## Demand-driven eviction

When a wake is deferred, the queue tries to free a slot by evicting an
oldest-idle container. Two rules govern this:

**Victim selection** (`pickEvictionVictim`). A container is evictable only if
all of:

- it has been idle longer than `IDLE_BEFORE_EVICT` (the protection window);
- it holds no outstanding `processing` claim — i.e. it is not mid-turn, which
  guards against killing a container blocked in a long, quiet tool call;
- it is not already being evicted.

Among the eligible candidates, the one idle the longest wins (least-recently
used). A container's idle reference is its heartbeat file's mtime when it has one
(the agent touches the heartbeat as it works through a turn), or its spawn time
when it never wrote one — covering a container that found no work and never
ticked.

**Eviction throttle.** The queue never has more evictions in flight than there
are waiters. Each in-flight stop will free a slot shortly, so launching more
evictions than the unmet demand would needlessly tear down idle containers. This
keeps a single burst at capacity from cascading into evicting every idle
container at once.

Eviction is a *graceful* kill: the runner calls `killContainer` with the grace
window, which issues an async `docker stop -t <grace>`. The container's SIGTERM
handler aborts its in-flight turn and lets the loop wind down cleanly before
Docker's SIGKILL deadline.

## Spawn lifecycle and slot accounting

A reserved slot must end up exactly one of three ways, with no leak:

1. **Reserve → active handoff.** Once the container is registered as live, the
   runner calls `releaseReserve`. The slot is now counted as active, so dropping
   the reserve avoids double-counting. No slot is freed, so this does *not*
   trigger a drain.

2. **Spawn produced no live container.** If a spawn returns or throws before a
   container registers — for example an early return when the agent group is
   missing, or a failure building the launch arguments — the runner calls
   `releaseReserveAndDrain`. This frees the reserved slot *and* immediately
   services waiters, so a slot freed by a failed spawn doesn't sit idle until the
   next exit or sweep.

3. **Container exit.** On exit the runner calls `onExit`, which clears any
   eviction mark and the reserve for that session and then drains. This fires
   after the container is removed from the live map, so occupancy already
   reflects the freed slot. The freed slot is handed to waiters immediately
   rather than waiting for the next sweep tick.

## Draining

A drain hands freed slots to the waiting list FIFO. It loops while there are
waiters and occupancy is below the cap, claiming a reserve synchronously per
iteration so occupancy reflects each hand-off immediately and the loop stays
bounded by the cap. For each candidate it skips:

- sessions whose container is already active (a later wake already won the slot);
- sessions that no longer exist or are no longer active (re-resolved at drain
  time).

Otherwise it reserves the slot and kicks off a spawn. Draining is a no-op while
the queue is shutting down.

## Liveness feeding

The eviction selector needs each live container's idle age and mid-turn status,
but the wake path must not do filesystem or database I/O to get them. Instead the
host sweep — which already reads the heartbeat mtime and the `processing` claims
each tick — stamps them onto the live-container entry via
`recordContainerLiveness`. Victim selection then reads these cached fields with
no I/O. The stamp is at most one sweep interval stale, comfortably inside the
`IDLE_BEFORE_EVICT` window.

The sweep also applies the no-demand backstop: a container whose heartbeat has
been stale beyond `EVICTION_TIMEOUT` (and that holds no claim) is reaped even
with zero queue pressure. The common idle case is handled earlier and faster by
demand-driven eviction; this backstop is deliberately long so warm containers
stay warm for fast follow-ups.

## Graceful stop

Both eviction and host shutdown stop containers gracefully so a turn ends cleanly
rather than being torn mid-write.

On the host, `GRACEFUL_STOP_MS` is converted once to integer seconds at the
runtime boundary and passed to `docker stop -t`. Docker sends SIGTERM, waits up
to that many seconds for the container to wind down, then SIGKILL. The graceful
path is async and non-blocking; on a stop error it falls back to an immediate
SIGKILL. Stuck-container kills (heartbeat ceiling, claim-stuck) bypass the grace
window and take the fast synchronous 1-second path, since a stuck container can't
honor a graceful abort anyway.

Inside the container, a SIGTERM (or SIGINT) handler requests a graceful stop:
it aborts any in-flight query — provider-agnostic, riding the query's `abort()`
— and trips the poll loop to exit at its next safe point. A turn in progress is
ended cleanly (its message batch marked complete, the transcript flushed by the
SDK's own abort) before the loop unwinds and the process exits. An idle container
with no active query simply exits the loop. A second stop signal forces an
immediate exit. The container needs no stop timer of its own — Docker's `-t`
deadline is the single source of truth for how long the wind-down may take.

## Shutdown

`shutdownContainers` latches the queue shut via `setShuttingDown`, which blocks
all new admissions and drains, then stops every live container in parallel with
the grace window, SIGKILL-falling-back per container on error. Because containers
are durable, even a hard kill just resets the in-flight message to pending for
the next boot; the grace window makes a clean wind-down the rule rather than the
exception.
