# OVERLAP-HIGH: module/container-queue × tasks-core

## Status: FROZEN — owner decision required

Branch: `fix/sweep/2026-07-13-container-queue-overlap-high`
Created: 2026-07-13
Sweep: 2026-07-13

## Summary

Upstream `tasks-core` (merged via PR #2981, commit range starting `c87f2e55`) 
**intentionally removes** the live-task concurrency cap. The commit message reads:
"isolation replaces throttling". This directly conflicts with `module/container-queue`,
which implements a bounded admission queue gated on `MAX_CONCURRENT_CONTAINERS`.

This is a **design conflict**, not a textual conflict. Upstream's isolation model
(per-series task sessions) is the replacement for admission-queue throttling. Merging
tasks-core into `module/container-queue` without a decision will break the fork.

## Conflict surfaces

### 1. `src/config.ts`
```
<<<<<<< module/container-queue (fork)
  MAX_CONCURRENT_CONTAINERS: z.coerce.number().int().min(1).default(10),
=======
  // (upstream: key entirely absent — deleted in tasks-core)
>>>>>>> upstream/main
```
The queue feature reads `config.MAX_CONCURRENT_CONTAINERS` at module import time.
Post-merge (without this constant) → immediate `TypeError` at startup.

### 2. `src/host-sweep.ts`
Upstream inserts a `shouldCloseTaskSession` / GC block at the same function-body
location where the fork's `reconcileContainerCapacity()` call lives (`sweepSession`).
Both blocks need to be present or one must supersede the other.

### 3. `container/agent-runner/src/poll-loop.ts`
Upstream changes `skipped` from `string[]` to `Array<{id, reason}>` and renames
`markCompleted` → `markScriptSkipped`. The fork's scheduling pre-task seam
(`hasPendingPreTaskScript`, `acquireContainerSlot`) touches the same section.

## Reproduction (one command, dry-run)

```bash
# In the repo clone:
git merge-tree $(git merge-base upstream/main module/container-queue) \
  upstream/main module/container-queue | grep -A5 "MAX_CONCURRENT_CONTAINERS"
```

## Options

**A — Re-add as fork-only constant** (backward compat)
- Add `MAX_CONCURRENT_CONTAINERS` back in `src/config.ts` as a fork-only field.
- Keep `reconcileContainerCapacity()` coexisting with upstream's task-session GC.
- Cost: ongoing maintenance of the override; must re-apply at every future upstream
  config.ts change.

**B — Retire `module/container-queue`** (upstream model adopted)
- Drop the feature; rely on upstream's per-series isolation for back-pressure.
- Clean slate, no ongoing delta.
- Cost: loss of the global container cap; per-series isolation may not be sufficient
  if the fork runs many concurrent series.

## Next steps (for owner Kirill)

1. Choose option A or B.
2. If A: `fls-maintainer` will implement the coexistence patch and open a merge PR.
3. If B: `fls-maintainer` will open a PR that removes `module/container-queue` from
   the inventory and the fork branch list.

Branch is frozen in sweep ledger pending this decision.
