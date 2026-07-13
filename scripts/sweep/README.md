# Upstream-sweep toolkit (`scripts/sweep/`)

Scripted core of the FLSclaw self-maintenance pipeline — the detailed
mechanics of `docs/design/02-self-maintaining-flsclaw.md` §5 (flows a+b).
Deterministic, idempotent, resumable; the agentic layer consumes the JSON
artifacts these commands emit and never does raw git surgery the scripts can
do. The boundary artifact is **sweep-report.json**.

```
pnpm exec tsx scripts/sweep/sweep.ts <subcommand> [flags]
```

## Layout & data model (post-2026-07-10 restructure)

The registry branch is DISSOLVED (owner decision): everything durable lives
here with the code; live state is derived or group-owned.

```
scripts/sweep/
  *.ts                       toolkit + colocated *.test.ts
  README.md  DESIGN.md       this file; pipeline spec + deviations (§10)
  registry/
    schema/feature-entry.schema.json
    routing.yaml             router weights/threshold/top_k + scan tuning
    scope.yaml               scope POLICY: include globs + exclusions (config, not state)
    prompts/                 overlap-check.md, catch-all-triage.md
  test-cases/
    README.md  cases/*.yaml  replay cases (read from the LOCAL TREE)
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
  `git merge-base <branch> upstream/main` (see `status`'s `mergeBase=`).
- **Group-owned state** (`--workspace <dir>`, default cwd): the ledger
  (`--ledger`, default `<workspace>/sweep-ledger.json` — freeze/exclude
  overrides, open PoIs, last-sweep record), `sweep-log.jsonl` (append-only
  journal), `reports/` (archived sweep reports), `rr-cache/` (shared rerere
  resolutions, local/ephemeral — rebuild any time with `seed-rerere`).
- **PoI classes** (D-002): `annotate` (merge proceeds, analysis async) —
  new-top-level-dir, new-skill, large-new-file (>15 KB source / >40 KB any),
  sensitive-surface-touch, dep-change, rerere-replay; `gate` (stops that
  branch only) — merge-conflict, test-fail.

## Subcommands

| Command             | Mutates                    | Purpose |
| ------------------- | -------------------------- | ------- |
| `fetch`             | remote-tracking refs       | `git fetch upstream origin --prune`; reports early-exit when upstream tip == last sweep and no open PoIs |
| `ff-main`           | `main` (FF only)           | fast-forward `main` to `upstream/main`; any non-FF is a loud failure (mirror invariant) |
| `scan`              | no                         | per-branch merge-tree conflict scan vs each branch's ACTUAL merge source (parents' tips for inventory branches, the upstream chain for main_patched/edition-ancestors) + stop points + PoI extraction → sweep-report.json |
| `stop-points`       | no                         | largest clean prefix of the upstream first-parent chain — upstream-chain branches only (main_patched + edition-ancestors); inventory branches inherit gating from their parents |
| `merge`             | swept branches, workspace  | DAG-ordered propagation: main_patched merges its upstream stop point; every inventory branch merges its DAG PARENTS' tips (never upstream directly), parents-before-children, with the workspace rerere cache; journals + exports new resolutions |
| `verify`            | temp worktree only         | everything rebuild from the recipe (scope.yaml) + CI matrix; attributes failures; `--rollback --outcomes <f>` resets the offender |
| `record`            | workspace files            | fold report/outcomes/verify into the ledger + journal + archived report — plain files, no git |
| `status`            | no                         | derived merge-base + ledger overrides per branch; `--report` adds scan verdicts (up-to-date / clean-ready / gated at stop point / fully gated) |
| `validate-registry` | no                         | 6-rule inventory validator vs `--inventory` (exit 1 on ALERTs; ALERTed entries fail closed in routing) |
| `route`             | no                         | score report PoIs against inventory entries (owned 10 / touch 6 / symbol 3 / keyword 1; routing.yaml) |
| `replay`            | no                         | replay test-cases from the local tree; run before changing the sweep tooling itself |
| `seed-rerere`       | `.git/rr-cache`, workspace | rebuild `<workspace>/rr-cache` from pinned resolution cases (`resolution_ref`), via detached temp worktrees |

Flags: see the `Usage:` header in `sweep.ts`. Everything takes `--repo <path>`
(so tests can point at fixtures); config paths (`--inventory`,
`--scope-config`, `--routing-config`, `--cases`) default to the committed
files next to the code.

Registry-schema notes (verified against the live authored content):

- `routing.yaml` extras are honored: `catch_all.always_include` (classes that
  ALSO go to catch-all even when routed), `large_new_file_kb` and
  `sensitive_surfaces` (scan tuning — the registry config, not code, is the
  tuning surface). `key_symbols` may list several symbols per anchor
  (`"SymA / SymB — path"`); rule 4 passes when any one is found.
- Replay cases come in two modes: upstream-range cases (`upstream_range` as
  `a..b` or `{from, to}` — full scan semantics: stop point, conflicts, PoIs)
  and fork-internal propagation cases (`merge_source` merged into
  `fork_base_commit` — conflict check only; with `resolution_ref` they double
  as rerere seeds). Rich taxonomy labels are normalized to the mechanical
  outcome (`semantic`/`mixed`/`known-recurring`/`agent-resolvable`/
  `feature-overlap` → conflict; `clean-with-*-poi` → clean; `excluded` →
  skipped; unknown labels fail closed), and conflict paths may carry
  `(modify/delete)`-style annotations. Replays are ref-only (merge-tree needs
  no worktree), so nothing can be mutated.

**Dry-run by default:** `fetch`, `ff-main`, `merge`, `verify`, `record`,
`seed-rerere` print their plan and touch nothing unless `--execute` is
passed. This is deliberate cheap insurance for an agent-operated tool — a
missing flag can only ever under-do.

## M0 operator runbook (manual sweep)

From a clone where `origin` = k-fls/fls-claw-v2 and `upstream` =
nanocoai/nanoclaw (never a human's checkout with WIP). First set up a
workspace: `WS=~/sweep-ws; mkdir -p $WS` — the ledger, journal, reports and
rr-cache live there. Inventory: either point `--inventory` at the bootstrap
snapshot (default; fine while fresh) or regenerate a live inventory into the
workspace first with the `fork-registry-generate` skill and pass
`--inventory $WS/features`.

```sh
S=scripts/sweep/sweep.ts
pnpm exec tsx $S replay --repo .                           # 0a. pipeline self-test (registry cases)
pnpm exec tsx $S seed-rerere --repo . --workspace $WS --execute   # 0b. rebuild the rerere cache from pinned cases
pnpm exec tsx $S fetch --repo . --execute                  # 1. fetch both remotes
pnpm exec tsx $S validate-registry --repo .                # 2. inventory sanity (ALERTs => regenerate or accept catch-all)
pnpm exec tsx $S ff-main --repo . --execute                # 3. FF the pristine mirror
pnpm exec tsx $S scan --repo . --workspace $WS --out $WS/sweep-report.json   # 4. conflicts vs ACTUAL merge sources + stop points + PoIs
pnpm exec tsx $S merge --repo . --workspace $WS --report $WS/sweep-report.json          # 5a. inspect the plan (sources = DAG parents; only main_patched/edition-ancestors touch upstream)
pnpm exec tsx $S merge --repo . --workspace $WS --report $WS/sweep-report.json --execute --out $WS/outcomes.json  # 5b. do it (one pass cascades upstream down the parent chain)
pnpm exec tsx $S verify --repo . --execute --out $WS/verify.json \
  --outcomes $WS/outcomes.json --rollback                  # 6. everything rebuild + full matrix (~20 min)
pnpm exec tsx $S record --repo . --workspace $WS --report $WS/sweep-report.json \
  --outcomes $WS/outcomes.json --verify-result $WS/verify.json --execute     # 7. write the ledger + archives
pnpm exec tsx $S route --repo . --report $WS/sweep-report.json --out $WS/routes.json    # 8. PoI -> feature routing
pnpm exec tsx $S status --repo . --workspace $WS --report $WS/sweep-report.json         # 9. digest input
```

Then the agentic layer takes over: overlap-check subagents per routed
(feature, sweep) pair, catch-all triage for unrouted PoIs, `fix/sweep/*`
branches + PRs for gates (cases 2-4 in DESIGN.md §6), pushes per the push
policy. Nothing here deploys anything.

## Safety model

- **Dry-run default** — every mutating subcommand requires `--execute`.
- **`main` is a pristine upstream mirror** — `ff-main` refuses (exit 1) any
  non-fast-forward; nothing else ever writes to `main`.
- **Protected branches** — `main`, `everything*`, `design/*`, `maint/*` are
  hard-excluded merge targets in `merge.ts` (`skip-protected`), on top of
  the scope exclusions (`experimental/*`, `wip/*`, `worktree-agent-*`,
  `integration/*`, `test/*`). `fix/*` and `docs/notes` are NOT protected —
  they are swept in this fork's practice (upstream-PR candidates kept
  current). `everything` is rebuilt ONLY as a throwaway temp worktree in
  `verify` — never committed to, never merged anywhere.
- **No state branch** — all state writes are plain files in the group
  workspace (ledger, journal, reports, rr-cache); the toolkit never commits
  to any branch. `seed-rerere` and conflicted merges write only the
  local/ephemeral `.git/rr-cache` plus detached temp worktrees (no ref moves).
- **Conflict detection is new-style `git merge-tree --write-tree`** (full
  ort, virtual multi-base). Never `--merge-base=<x>` single-base previews —
  they produce bogus conflicts on branches with two merge bases (verified
  2026-07-01, mitm <-> onecli-broker), and never cherry-pick fallbacks.
- **Checked-out branches** are merged in their own worktree only when its
  status is clean (`dirty-worktree` skip otherwise); non-checked-out branches
  merge via plumbing (clean) or a temp worktree (rerere), so no human
  checkout is ever touched.
- **Tests never mutate real branches** — all mutating stages are exercised
  against throwaway fixture repos in `os.tmpdir()` (`fixtures.ts`);
  read-only stages may be smoke-tested against the real repo.
- Rollback: `merge` records pre-merge refs in its outcomes; `verify
  --rollback` and `merge.rollbackBranch()` reset via `update-ref` (or
  `reset --hard` in the owning worktree).

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

- `scripts/sweep/DESIGN.md` — the pipeline spec this implements, committed
  verbatim, plus documented implementation deviations (§10, incl. the
  2026-07-10 registry-branch dissolution).
- `docs/design/02-self-maintaining-flsclaw.md` §5 — component mapping
  (watcher = fetch/scan, maintainer = route/classify, change-author =
  merge/verify/record + PRs).
- `.claude/skills/fork-registry-generate/` — inventory regeneration + the
  canonical judgment seeds.
