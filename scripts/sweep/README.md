# Upstream-sweep toolkit (`scripts/sweep/`)

Scripted core of the FLSclaw self-maintenance pipeline. Deterministic,
idempotent, resumable; the agentic layer runs the commands and resolves the
conflicts they hand it, and never does raw git surgery the scripts can do.

The ONLY command surface is the six-command D-053 state machine:

```
pnpm exec tsx scripts/sweep/sweep-machine.ts <start|next-case|report-case|report-pr|finish|abort> [flags]
```

`start` / `next-case` / `report-case --tier` / `report-pr` / `finish` / `abort`
— spec: `SWEEP-STATE-MACHINE.md` (AUTHORITY on the interface), mechanics:
`PROPAGATION.md`, tier/merge/publication semantics: `MERGE-POLICY.md`. The
deterministic stages (plan, run, verify, publish, push, report) are the driver's
INTERNALS with no standalone entry point; the old `sweep.ts` pipeline
(`fetch|ff-main|scan|stop-points|merge|verify|record|status|route|replay|seed-rerere`)
and the flag-based `propagate resolve|unfreeze|status` are retired
(2026-07-30) — nothing on the agent's doctrined surface reached them.

One inventory tool survives beside the machine, because the
`fork-registry-generate` skill's step 3 invokes it:

```
pnpm exec tsx scripts/sweep/sweep.ts validate-registry --repo <repo> --inventory <dir>
```

6-rule inventory validator (`validate.ts`); read-only, exit 1 on ALERTs, and
ALERTed entries fail closed in routing.

## Layout & data model (post-2026-07-10 restructure)

The registry branch is DISSOLVED (owner decision): everything durable lives
here with the code; live state is derived or group-owned.

```
scripts/sweep/
  *.ts                       toolkit + colocated *.test.ts
  README.md  DESIGN.md       this file; pipeline spec + deviations (§10)
  SWEEP-STATE-MACHINE.md     the agent-facing command surface (D-053)
  PROPAGATION.md             the propagation driver's specification
  MERGE-POLICY.md            tier ladder + merge/publication policy
  sweep.ts                   the surviving inventory validator CLI (validate-registry)
  checks.json                host+runner typecheck/test command lists (the checks gate)
  cut-point-exceptions.yaml  owner-approved cut-point exceptions (blame input)
  registry/
    schema/feature-entry.schema.json
    routing.yaml             global driver levers (scope_guard_mode, stack_cap)
    scope.yaml               scope POLICY: exclusions + extra_edges + everything recipe
    prompts/                 overlap-check.md, catch-all-triage.md
  test-cases/
    propagation/cases/*.yaml propagation cases (propagation-cases.test.ts)
    fixtures/                dated recon snapshots
  bootstrap/
    fork-registry@<hash12>/  stamped verbatim inventory snapshot + MANIFEST.md
      features/*.yaml        default --inventory (27 entries @ ca693b0e)
.claude/skills/fork-registry-generate/
  SKILL.md  seeds.yaml       inventory (re)generation; judgment seeds live HERE
```

- **Inventory** (`--inventory <dir>`, default = latest bootstrap snapshot):
  one YAML entry per fork feature. Regenerate into a group workspace with the
  `fork-registry-generate` skill; mechanical fields derive fresh from git,
  judgment fields merge from `seeds.yaml`.
- **Derived state:** `lastMergedUpstream` is never stored — it is
  `git merge-base <branch> upstream/main`. Blockedness (`merge_status`) is
  derived from the origin `fix/sweep/*` refs at `start` plus the pass journal
  (D-058). There is NO durable local state file: a `sweep-ledger.json` existed
  until 2026-08-04 and was deleted after a 12-day-old copy was read back by a
  fresh session and reported as the current sweep state while an open pass sat
  beside it. Anything about origin is re-read from origin.
- **Group-owned state** (`--workspace <dir>`, default = the parent of
  `--repo`): `propagation/pass-<wm12>/` (plan + step + case files,
  `journal.jsonl`, machine state) and `rr-cache/` (shared rerere resolutions,
  local/ephemeral). The workspace MUST be outside any git work tree (D-055).

## Bootstrapping a group workspace

From a clone where `origin` = k-fls/fls-claw-v2 and `upstream` =
nanocoai/nanoclaw (never a human's checkout with WIP). The group root — the
PARENT of the clone — is the workspace: `propagation/` and `rr-cache/` live
there, never inside the clone. Inventory: either take the
default bootstrap snapshot or regenerate a live inventory into the group root
with the `fork-registry-generate` skill and pass `--inventory <dir>`. Then run
the loop in `SWEEP-STATE-MACHINE.md`; the clone and the inventory persist
across sessions.

Registry-schema notes (verified against the live authored content):

- `routing.yaml` carries the two live driver levers `scope_guard_mode` (§7) and
  `stack_cap` (D-049 §2); the retired matcher's tuning (`weights`, `threshold`,
  `top_k`, `large_new_file_kb`, `sensitive_surfaces`, `catch_all`) is gone.
  `key_symbols` may list several symbols per anchor (`"SymA / SymB — path"`).

**Execute is the DEFAULT** on the agent surface (D-060); `--dry-run` opts into
computing without writing.

## Safety model

- **`main` is a pristine upstream mirror** — nothing here ever writes to it.
- **Protected branches** — `main`, `everything*`, `design/*`, `maint/*` are
  never merge targets, on top of the scope exclusions (`experimental/*`,
  `wip/*`, `worktree-agent-*`, `integration/*`, `test/*`). `fix/*` and
  `docs/notes` are NOT protected — they are swept in this fork's practice
  (upstream-PR candidates kept current). `everything` is rebuilt ONLY as a
  throwaway temp worktree in `verify` — never committed to, never merged
  anywhere.
- **No state branch** — all state writes are plain files in the group
  workspace (pass dir, rr-cache); the toolkit never commits to any branch
  except the merges a pass performs.
- **The driver pushes, verify-gated** — refs move via `git push` only, after a
  green `verify`, and any push failure is journaled and reported to the owner
  (D-046 case 2), never worked around.
- **Conflict detection is new-style `git merge-tree --write-tree`** (full
  ort, virtual multi-base). Never `--merge-base=<x>` single-base previews —
  they produce bogus conflicts on branches with two merge bases (verified
  2026-07-01, mitm <-> onecli-broker), and never cherry-pick fallbacks.
- **Checked-out branches** are merged in their own worktree only when its
  status is clean; non-checked-out branches merge via plumbing or a temp
  worktree, so no human checkout is ever touched.
- **Tests never mutate real branches** — all mutating stages are exercised
  against throwaway fixture repos in `os.tmpdir()` (`fixtures.ts`).

Scope (owner rule 2026-07-14, D-033): the swept set is main_patched
(structural) + inventory entries' branches + non-inventory branches in the
TRANSITIVE edition composition — tip-ancestor of an `edition/*` branch OR
ever merged (fork-era merge-edge closure, transitively) into any branch
whose merge history reaches an edition (merge source `main` ONLY —
upstream-PR candidates never absorb main_patched/fork content; flagged "add
an inventory entry"). Every other non-inventory branch is IGNORED — one
digest drift line at most. Explicit + namespace exclusions apply first. Merge sources: `main` ff-only, `main_patched` merges main;
every inventory branch merges its DAG parents — conflicts resolve once at
the topmost affected branch, descendants inherit via parent merges.
"Registry entry (seed + regenerate) is step 3 of every new feature branch" —
see the `fork-registry-generate` skill.

## References

- `scripts/sweep/SWEEP-STATE-MACHINE.md` — the agent-facing command surface.
- `scripts/sweep/PROPAGATION.md` — the propagation driver's specification.
- `scripts/sweep/MERGE-POLICY.md` — the authoritative tier ladder.
- `scripts/sweep/DESIGN.md` — the original pipeline spec, committed verbatim,
  plus documented implementation deviations (§10, incl. the 2026-07-10
  registry-branch dissolution). §5-6 and §8 are historical record.
- `docs/design/02-self-maintaining-flsclaw.md` §5 — component mapping.
- `.claude/skills/fork-registry-generate/` — inventory regeneration + the
  canonical judgment seeds.
