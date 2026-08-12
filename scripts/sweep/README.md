# Upstream-sweep toolkit (`scripts/sweep/`)

Scripted core of the FLSclaw self-maintenance pipeline. Deterministic,
idempotent, resumable; the agentic layer runs the commands and resolves the
conflicts they hand it, and never does raw git surgery the scripts can do.

The ONLY command surface is the sweep state machine:

```
pnpm exec tsx scripts/sweep/sweep-machine.ts <start|next-case|report-case|report-pr|finish|abort> [flags]
```

`start` / `next-case` / `report-case --tier` / `report-pr` / `finish` / `abort`
— spec: `SWEEP-STATE-MACHINE.md` (AUTHORITY on the interface), mechanics:
`PROPAGATION.md`, tier/merge/publication semantics: `MERGE-POLICY.md`. The
deterministic stages (plan, run, verify, publish, push, report) are the driver's
INTERNALS with no standalone entry point.

One inventory tool sits beside the machine, because the
`fork-registry-generate` skill's step 3 invokes it:

```
pnpm exec tsx scripts/sweep/sweep.ts validate-registry --repo <repo> --inventory <dir>
```

5-rule inventory validator (`validate.ts`); read-only, exit 1 on ALERTs, and
ALERTed entries fail closed in routing. Entries without a `branch`
(planned/observational config) skip rules 1-4.

## Layout & data model

Everything durable lives here with the code; live state is derived or
group-owned. There is no state branch.

```
scripts/sweep/
  *.ts                       toolkit + colocated *.test.ts
  README.md  DESIGN.md       this file; the pipeline design spec
  SWEEP-STATE-MACHINE.md     the agent-facing command surface
  PROPAGATION.md             the propagation driver's specification
  MERGE-POLICY.md            tier ladder + merge/publication policy
  sweep.ts                   the inventory validator CLI (validate-registry)
  checks.json                host+runner typecheck/test command lists (the checks gate)
  cut-point-exceptions.yaml  owner-approved cut-point exceptions (blame input)
  inventory/
    <id>.yaml                THE inventory: one strict-config entry per fork feature
  registry/
    schema/feature-entry.schema.json
    routing.yaml             global driver levers (scope_guard_mode, stack_cap)
    scope.yaml               scope POLICY: exclusions + extra_edges + everything recipe
    prompts/                 overlap-check.md, catch-all-triage.md
  test-cases/
    propagation/cases/*.yaml propagation cases (propagation-cases.test.ts)
    fixtures/                dated recon snapshots
.claude/skills/fork-registry-generate/
  SKILL.md  seeds.yaml       inventory (re)generation; judgment seeds live HERE
```

- **Inventory** (`scripts/sweep/inventory/*.yaml`): strict config tracked in
  the fork repo, one YAML entry per fork feature, loaded by default from the
  clone; `--inventory` exists for tests/fixtures. Required fields
  `id`/`name`/`kind`; `branch` is optional — an entry with a `branch` is
  swept, one without is planned/observational. Legal fields include
  `tier_floor` (`judged`), `always_merge`, `scope_guard`, `stack_cap`, and
  `prompt.extra_context` (owner-authored STANDING guidance, embedded
  path-matched into case materials — never a decision store). Unknown keys are
  entry errors, and `sweep start` refuses on any entry error
  (ERR46_INVENTORY_INVALID). Regeneration is the `fork-registry-generate`
  skill: mechanical fields derive fresh from git, judgment fields merge from
  `seeds.yaml`.
- **Derived state:** `lastMergedUpstream` is never stored — it is
  `git merge-base <branch> upstream/main`. Blockedness (`merge_status`) is
  derived from the origin `fix/sweep/*` refs at `start` plus the pass journal.
  There is NO durable local state file: everything a pass produces lives in
  the pass dir, and anything about origin is re-read from origin. `start`
  refuses on sweep residue it would otherwise be tempted to read
  (ERR47_SWEEP_RESIDUE: `refs/sweep/*` refs, workspace `inventory/` or
  `inventory-candidates/` dirs, stray `sweep-*.json(l)` files).
- **Group-owned state** (`--workspace <dir>`, default = the parent of
  `--repo`): `propagation/pass-<wm12>/` (plan + step + case files,
  `journal.jsonl`, machine state) and `rr-cache/` (shared rerere resolutions,
  local/ephemeral). The workspace MUST NOT be the `--repo` clone or a
  subdirectory of it (ERR37_WORKSPACE_IN_CLONE); a group root inside an outer
  git work tree is fine.

## Bootstrapping a group workspace

From a clone where `origin` = k-fls/fls-claw-v2 and `upstream` =
nanocoai/nanoclaw (never a human's checkout with WIP). The group root — the
PARENT of the clone — is the workspace: `propagation/` and `rr-cache/` live
there, never inside the clone. The inventory ships in the clone at
`scripts/sweep/inventory/`. Then run the loop in `SWEEP-STATE-MACHINE.md`;
the clone persists across sessions.

Registry-schema notes (verified against the live authored content):

- `routing.yaml` carries the two live driver levers `scope_guard_mode` (§7)
  and `stack_cap` (the case-stacking cap). `key_symbols` may list several
  symbols per anchor (`"SymA / SymB — path"`).

**Execute is the DEFAULT** on the agent surface; `--dry-run` opts into
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
  green `verify`, and any push failure is journaled and reported to the owner,
  never worked around.
- **Conflict detection is new-style `git merge-tree --write-tree`** (full
  ort, virtual multi-base). Never `--merge-base=<x>` single-base previews —
  they produce bogus conflicts on branches with two merge bases — and never
  cherry-pick fallbacks.
- **Checked-out branches** are merged in their own worktree only when its
  status is clean; non-checked-out branches merge via plumbing or a temp
  worktree, so no human checkout is ever touched.
- **Tests never mutate real branches** — all mutating stages are exercised
  against throwaway fixture repos in `os.tmpdir()` (`fixtures.ts`).

Scope: the swept set is main_patched (structural) + inventory entries'
branches + non-inventory branches in the TRANSITIVE edition composition —
tip-ancestor of an `edition/*` branch OR ever merged (fork-era merge-edge
closure, transitively) into any branch whose merge history reaches an edition
(merge source `main` ONLY — upstream-PR candidates never absorb
main_patched/fork content; flagged "add an inventory entry"). Every other
non-inventory branch is IGNORED — one digest drift line at most. Explicit +
namespace exclusions apply first. Merge sources: `main` ff-only,
`main_patched` merges main; every inventory branch merges its DAG parents —
conflicts resolve once at the topmost affected branch, descendants inherit
via parent merges. "Registry entry (seed + regenerate) is step 3 of every new
feature branch" — see the `fork-registry-generate` skill.

## References

- `scripts/sweep/SWEEP-STATE-MACHINE.md` — the agent-facing command surface.
- `scripts/sweep/PROPAGATION.md` — the propagation driver's specification.
- `scripts/sweep/MERGE-POLICY.md` — the authoritative tier ladder.
- `scripts/sweep/DESIGN.md` — the pipeline design spec.
- `docs/design/02-self-maintaining-flsclaw.md` §5 — component mapping.
- `.claude/skills/fork-registry-generate/` — inventory regeneration + the
  canonical judgment seeds.
