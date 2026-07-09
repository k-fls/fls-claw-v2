# Upstream-sweep toolkit (`scripts/sweep/`)

Scripted core of the FLSclaw self-maintenance pipeline — the detailed
mechanics of `docs/design/02-self-maintaining-flsclaw.md` §5 (flows a+b).
Deterministic, idempotent, resumable; the agentic layer consumes the JSON
artifacts these commands emit and never does raw git surgery the scripts can
do. The boundary artifact is **sweep-report.json**.

```
pnpm exec tsx scripts/sweep/sweep.ts <subcommand> [flags]
```

## Data model

- **State branch** (default `maint/fork-registry`, `--state-branch` to
  override) — never merged anywhere, never checked out by the tooling:
  - `fork-registry/features/*.yaml` — feature registry entries (see the
    feature-inventory design; one file per feature).
  - `fork-registry/routing.yaml` — router weights/threshold/top_k.
  - `fork-registry/sweep-scope.yaml` — `include`, `exclude`, `extra_edges`
    (child → parents), `recipe` (ordered branch list for the everything
    rebuild).
  - `fork-registry/test-cases/*.yaml` — replay cases.
  - `sweep-state/sweep-state.json` — authoritative branch/PoI state.
  - `sweep-state/sweep-log.jsonl` — append-only journal (every mutation).
  - `sweep-state/rr-cache/**` — shared rerere resolutions.
  - `sweep-state/reports/*.json` — archived sweep reports.

  Reads use `git show <branch>:<path>`; writes build a commit via a temporary
  index (`read-tree` → `update-index --cacheinfo` → `write-tree` →
  `commit-tree` → `update-ref`), so the state branch is mutated without ever
  being checked out.

- **PoI classes** (D-002): `annotate` (merge proceeds, analysis async) —
  new-top-level-dir, new-skill, large-new-file (>15 KB source / >40 KB any),
  sensitive-surface-touch, dep-change, rerere-replay; `gate` (stops that
  branch only) — merge-conflict, test-fail.

## Subcommands

| Command             | Mutates                  | Purpose |
| ------------------- | ------------------------ | ------- |
| `fetch`             | remote-tracking refs     | `git fetch upstream origin --prune`; reports early-exit when upstream tip == last sweep and no open PoIs |
| `ff-main`           | `main` (FF only)         | fast-forward `main` to `upstream/main`; any non-FF is a loud failure (mirror invariant) |
| `scan`              | no                       | per-branch merge-tree conflict scan + stop points + PoI extraction → sweep-report.json |
| `stop-points`       | no                       | per-branch largest clean prefix of the upstream first-parent chain (bisected with merge-tree) |
| `merge`             | swept branches, state journal | DAG-ordered propagation to per-branch stop points with the shared rerere cache; exports new resolutions |
| `verify`            | temp worktree only       | everything rebuild from the recipe + CI matrix; attributes failures to the offending branch; `--rollback --outcomes <f>` resets it |
| `record`            | state branch             | fold report/outcomes/verify into sweep-state.json + journal + archived report |
| `status`            | no                       | human-readable state dump |
| `validate-registry` | no                       | 6-rule registry validator (exit 1 on ALERTs; ALERTed entries fail closed in routing) |
| `route`             | no                       | score report PoIs against feature entries (owned 10 / touch 6 / symbol 3 / keyword 1, threshold 6, top_k 4, from routing.yaml) |
| `replay`            | no                       | replay registry test-cases; run before changing the sweep tooling itself |

Registry-schema notes (verified against the live `maint/fork-registry` content):

- `routing.yaml` extras are honored: `catch_all.always_include` (classes that
  ALSO go to catch-all even when routed), `large_new_file_kb` and
  `sensitive_surfaces` (scan tuning — the registry, not code, is the tuning
  surface). `key_symbols` may list several symbols per anchor
  (`"SymA / SymB — path"`); rule 4 passes when any one is found.
- Replay cases come in two modes: upstream-range cases (`upstream_range` as
  `a..b` or `{from, to}` — full scan semantics: stop point, conflicts, PoIs)
  and fork-internal propagation cases (`merge_source` merged into
  `fork_base_commit` — conflict check only). Rich taxonomy labels are
  normalized to the mechanical outcome (`semantic`/`mixed`/`known-recurring`/
  `agent-resolvable`/`feature-overlap` → conflict; `clean-with-*-poi` →
  clean; `excluded` → skipped; unknown labels fail closed), and conflict
  paths may carry `(modify/delete)`-style annotations. Replays are ref-only
  (merge-tree needs no worktree), so nothing can be mutated.

Flags: see the `Usage:` header in `sweep.ts`. Everything takes `--repo <path>`
(so tests can point at fixtures) and `--state-branch <name>`.

**Dry-run by default:** `fetch`, `ff-main`, `merge`, `verify`, `record` print
their plan and touch nothing unless `--execute` is passed. This is deliberate
cheap insurance for an agent-operated tool — a missing flag can only ever
under-do.

## M0 operator runbook (manual sweep)

From a clone where `origin` = k-fls/fls-claw-v2 and `upstream` =
nanocoai/nanoclaw (never a human's checkout with WIP):

```sh
S=scripts/sweep/sweep.ts
pnpm exec tsx $S replay                       # 0. pipeline self-test (registry cases)
pnpm exec tsx $S fetch --execute              # 1. fetch both remotes
pnpm exec tsx $S validate-registry            # 2. registry sanity (ALERTs => fix registry or accept catch-all)
pnpm exec tsx $S ff-main --execute            # 3. FF the pristine mirror
pnpm exec tsx $S scan --out /tmp/sweep-report.json          # 4. conflicts + stop points + PoIs
pnpm exec tsx $S merge --report /tmp/sweep-report.json      # 5a. inspect the merge plan
pnpm exec tsx $S merge --report /tmp/sweep-report.json --execute --out /tmp/outcomes.json   # 5b. do it
pnpm exec tsx $S verify --execute --out /tmp/verify.json \
  --outcomes /tmp/outcomes.json --rollback    # 6. everything rebuild + full matrix (~20 min)
pnpm exec tsx $S record --report /tmp/sweep-report.json \
  --outcomes /tmp/outcomes.json --verify-result /tmp/verify.json --execute   # 7. journal it
pnpm exec tsx $S route --report /tmp/sweep-report.json --out /tmp/routes.json # 8. PoI -> feature routing
pnpm exec tsx $S status                       # 9. digest input
```

Then the agentic layer takes over: overlap-check subagents per routed
(feature, sweep) pair, catch-all triage for unrouted PoIs, `fix/sweep/*`
branches + PRs for gates (cases 2-4 in the pipeline spec), pushes per the
push policy. Nothing here deploys anything.

## Safety model

- **Dry-run default** — every mutating subcommand requires `--execute`.
- **`main` is a pristine upstream mirror** — `ff-main` refuses (exit 1) any
  non-fast-forward; nothing else ever writes to `main`.
- **Protected branches** — `main`, `everything*`, `design/*`, `docs/*`,
  `maint/*` are hard-excluded merge targets in `merge.ts`
  (`skip-protected`), on top of the scope exclusions (`experimental/*`,
  `wip/*`, `worktree-agent-*`, `integration/*`, `test/*`). `everything` is
  rebuilt ONLY as a throwaway temp worktree in `verify` — never committed to,
  never merged anywhere.
- **Conflict detection is new-style `git merge-tree --write-tree`** (full
  ort, virtual multi-base). Never `--merge-base=<x>` single-base previews —
  they produce bogus conflicts on branches with two merge bases (verified
  2026-07-01, mitm <-> onecli-broker), and never cherry-pick fallbacks.
- **Checked-out branches** are merged in their own worktree only when its
  status is clean (`dirty-worktree` skip otherwise); non-checked-out branches
  merge via plumbing (clean) or a temp worktree (rerere), so no human
  checkout is ever touched.
- **State mutations are journaled commits** on the state branch, written
  without checkout; every mutation appends a `sweep-log.jsonl` row.
- **Tests never mutate real branches** — all mutating stages are exercised
  against throwaway fixture repos in `os.tmpdir()` (`fixtures.ts`);
  read-only stages may be smoke-tested against the real repo.
- Rollback: `merge` records pre-merge refs in its outcomes; `verify
  --rollback` and `merge.rollbackBranch()` reset via `update-ref` (or
  `reset --hard` in the owning worktree).

## References

- `docs/design/02-self-maintaining-flsclaw.md` §5 — the pipeline this
  implements (watcher = fetch/scan, maintainer = route/classify,
  change-author = merge/verify/record + PRs).
- Sweep pipeline spec + feature-inventory registry design (scratchpad docs,
  2026-07-10) — stage semantics, PoI taxonomy, routing algorithm, validator
  rules.
