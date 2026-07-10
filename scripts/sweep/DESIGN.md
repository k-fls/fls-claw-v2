# FLSclaw self-maintenance: upstream-sweep pipeline specification

Status: DRAFT v2 (2026-07-10). Decision references D-001..D-021 point to the decision log
(`self-maintenance-decisions.md`).

**Relationship to existing design:** this spec is the detailed mechanics of
`docs/design/02-self-maintaining-flsclaw.md` §5 (flows a+b). Component mapping: stage
scan = `fls-upstream-watcher`, PoI classification/plan = `fls-maintainer`, merge/PR
execution = `fls-change-author`, approval = owner on GitHub. Everything here is
M0-runnable standalone (operator invokes the scripts directly) — the estate is the
wrapper, not a dependency (D-020).

**Placement (D-017/D-018/D-021):**
- Tooling: `scripts/sweep/*.ts` (tsx, positional args + `Usage:` line, `*.test.ts`
  siblings picked up by the vitest scripts glob). No new deps; JSON not YAML.
- Data: `estate/sweep/` — `sweep-scope.json` (branch list + DAG edges + exclusions),
  `feature-inventory/` (JSON index + per-feature markdown prompt templates),
  `test-cases.json`, `prompts/` (PoI-analysis prompt templates).
- Mutable state: `estate/sweep/state/` (sweep-state.json, sweep-log.jsonl, rr-cache/,
  reports/) committed ONLY on the never-merged ops branch `maint/state`; job lifecycle
  stays in the doc-02 maintainer ledger (SQLite), referencing state commits by SHA.
- Design-doc refinements: append to doc 02 + `scratchpads/topic-2-self-maintenance.md`
  (no new doc number, D-016).
- Branch naming: batch merges pushed as `sweep/<date>`; conflict resolutions as
  `fix/sweep/<date>-<topic>` (D-019).
- Verification commands (from CI, authoritative): `pnpm install --frozen-lockfile`;
  `(cd container/agent-runner && bun install --frozen-lockfile)`; `pnpm run format:check`;
  `pnpm exec tsc --noEmit`; `pnpm exec tsc -p container/agent-runner/tsconfig.json
  --noEmit`; `pnpm exec vitest run`; `(cd container/agent-runner && bun test)`; plus
  `pnpm run build` and `./container/build.sh` when `container/` changed.

## 1. Purpose and shape

A half-scripted / half-agentic procedure, operated by a dedicated agent group
("maintenance group"), that keeps the FLSclaw fork current with upstream
`nanocoai/nanoclaw`:

- **Scripted core** (deterministic, idempotent, resumable): fetch, fast-forward `main`,
  per-branch conflict scan, rerere-assisted clean merges propagated down the branch DAG,
  `everything` rebuild, full test matrix, machine-readable sweep report, state journal.
- **Agentic layer** (judgment): classify points of interest, correlate conflicts with
  fork features via the feature inventory, author conflict resolutions as `fix/*` PRs,
  post human-facing reports, maintain the registries.

The scripted core never needs an LLM; the agentic layer never does raw git surgery that
the scripts can do. The boundary artifact is the **sweep report** (JSON): scripts emit
it, agents consume it.

## 2. Fixed principles (owner-approved)

- `main` = pristine upstream mirror, FF-only. All real merges happen on `main_patched`
  and below, along the DAG, merge-forward, resolving each conflict once at the topmost
  affected branch (D-003). `git rerere` replays known resolutions (D-006).
- Detection = per-branch new-style `git merge-tree` (full ort, virtual multi-base).
  NEVER `--merge-base=<x>` single-base preview, NEVER cherry-pick fallback (known
  two-merge-base pitfall). `everything` is rebuilt only as the verification gate,
  never merged anywhere (D-001).
- PoI classes (D-002):
  - **annotate** — merge proceeds, analysis is async: new directory, new skill, new file
    over threshold (default 15 KB source / 40 KB any), touches to sensitive surfaces
    (credentials, egress/firewall, container spawn, host-rpc auth), dependency/SDK bumps.
  - **gate** — stops propagation for the affected branch only: textual merge conflict
    not resolved by rerere; test/build failure after a textually clean merge.
- Textually clean ≠ done: a sweep batch is only recorded/pushed after the everything
  rebuild + full test matrix passes. Clean-merge-but-red-tests demotes to gate (case 4).
- No deep PR chains (D-004): a branch with an open conflict PR is **frozen**; the
  sweeper only annotates the PR with the count of newer pending upstream commits.
  Exception: case-3 provisional resolutions may be advanced on top of.
- Freeze/status is registry-authoritative (D-005): `sweep-state.json` on the
  maintenance branch; cosmetic `sweep-frozen/<branch>` lightweight tags mirror it.

## 3. Repos, branches, isolation

- Canonical clone: TBD(deploy) — the maintenance group gets its OWN clone/worktree;
  it never operates in a human's checkout and never touches the running deployment.
- **Maintenance branch** `maint/self-update` (final name TBD(recon)): holds
  `sweep/` tooling, `sweep-state.json`, feature inventory, test-case registry,
  shared rerere cache, sweep reports archive. Not part of the product DAG; never
  merged into module/feat/edition branches.
- **Scope config** (`sweep-scope.yaml`): explicit branch list with DAG edges
  (parent→child propagation order), plus exclusions: `experimental/*`, `wip/*`,
  `everything*`, blocked branches (e.g. `fix/channels/telegram-markdown-nesting`,
  status: excluded/needs-rebase). The DAG here is the executable copy of the
  confirmed topology; the agent group updates it when branches are added/retired,
  and the script cross-checks it against `git branch -r` every run (drift alert).

## 4. State schema (sweep-state.json, authoritative)

```json
{
  "schemaVersion": 1,
  "lastSweep": {"id": "2026-07-10T12:00Z", "upstreamTip": "<sha>", "result": "clean|partial|blocked"},
  "branches": {
    "<branch>": {
      "status": "active | frozen | excluded",
      "lastMergedUpstream": "<sha>",   // last upstream first-parent commit merged in
      "frozenBy": "PR #NN | null",
      "pendingBehindFreeze": 0,
      "notes": "free text"
    }
  },
  "openPois": [ {"id": "...", "class": "annotate|gate", "type": "new-skill|new-dir|large-file|sensitive|conflict|test-fail",
                 "upstreamCommits": ["<sha>"], "paths": [], "branches": [], "state": "open|reported|resolved", "pr": null} ]
}
```

Written only by the scripted core (agents request changes via script subcommands, so
every mutation is validated + journaled). Every sweep appends a row to
`sweep-log.jsonl` (audit trail).

## 5. Scripted core — stages

`sweep.ts` subcommands (each idempotent; a crashed sweep re-runs from the top and
converges — no partial-state corruption):

1. **fetch** — `git fetch upstream origin --prune`. Exit early if `upstream/main` tip
   == `lastSweep.upstreamTip` and no open work.
2. **ff-main** — `git merge --ff-only` upstream/main into main. Any non-FF = loud
   failure (mirror invariant violated; agent alert, stop).
3. **scan** — for every active branch: new-style `git merge-tree upstream/main <branch>`
   → conflict file list. For upstream range `lastMergedUpstream..upstream/main`
   (first-parent): detect annotate-PoIs via `git diff-tree`/`log --stat` (new dirs, new
   skills = new dir under the skills root, large files, sensitive-path touches,
   lockfile/SDK bumps). Route changed paths through the feature inventory to shortlist
   overlap checks. Emit `sweep-report.json`.
4. **stop-points** — per branch: if tip merge is clean → stop point = upstream tip.
   Else bisect the upstream **first-parent chain** (unit of merge = upstream PR merge
   commit) for the largest clean prefix; stop point = last clean first-parent commit.
   Per-branch stop points — one branch's conflict never holds back the others.
5. **merge** — with shared rerere cache installed: propagate in DAG order
   (main_patched first, then parents before children). For each branch, merge its stop
   point. rerere-resolved conflicts count as clean but are listed in the report
   (annotate-PoI, type `rerere-replay`). Checked-out branches via temp worktrees;
   others via merge-tree + commit-tree + update-ref (July-sweep technique). Nothing
   pushed yet.
6. **verify** — rebuild `everything` from the recipe in scope config (temp worktree,
   reset --hard main, scripted merge sequence + rerere), then: pnpm install
   --frozen-lockfile, build, host tests, container typecheck + bun tests (exact CI
   command list in the placement section above). Failures map back to the last-merged range → the offending
   branch is rolled back to its pre-sweep ref (recorded in stage 5) and demoted to
   gate-PoI (case 4). Re-verify without it.
7. **record** — update sweep-state.json + sweep-log.jsonl, archive sweep-report.json,
   create/delete `sweep-frozen/*` tags, push per push-policy (§8).
8. **status** — human-readable dump for the agent group / owner.

## 6. Agentic layer — PoI handling

The maintenance group wakes on schedule (e.g. daily; upstream does ~2-15 PRs/month),
runs `sweep.ts` through stage 7, then processes the report:

**Case 1 — annotate-PoIs (merged already, analysis async):**
For each, spawn an overlap-check subagent using the ready-made prompt from the feature
inventory (only the shortlisted features; catch-all prompt when nothing matches):
- (a) OVERLAP with implemented/planned fork feature → report HIGH PRIORITY (upstream
  built something we have/planned — dedup/retire/adopt decision for the owner).
- (b) independent new feature/skill/improvement → report NORMAL (awareness).
- (c) nothing interesting → PoI dissolves; one line in the sweep digest.

**Case 2 — resolvable conflict:** correlate with owning fork branch (inventory +
topmost-affected-branch rule). Branch `fix/sweep/<date>-<topic>` off the target branch
(which already has prior upstream merged, i.e. its stop point). Resolve, run the
branch-relevant tests, open PR (traceability), auto-merge it, record the resolution in
rerere cache, unfreeze, resume the merge loop for that branch (script stage 4-7 rerun).

**Case 3 — resolvable but confirmation wanted:** same as 2, but PR stays open with the
provisional resolution + rationale; branch may continue advancing on top of the
provisional resolution (the one sanctioned continue-on-top case). Owner merge = final.

**Case 4 — unresolvable (needs decision / tests non-trivially broken):** push the
conflicting state to `fix/sweep/...` WITHOUT resolution (merge with conflict markers
committed is ugly — instead: branch at stop point + a NOTES.md describing the conflict,
hunks, and analysis; the actual conflicted merge is reproducible with one command
recorded in the notes). Open PR, don't resolve, freeze branch, alert owner.

**Multiple gates on one branch:** they queue in the state file; the branch stays at its
earliest stop point until the first PR lands (no stacking, D-004).

**Reports:** one sweep digest per run to the owner's channel: merged range per branch,
PoIs by class/priority, frozen branches with PR links, test-matrix result, inventory/
registry updates made. HIGH-PRIORITY overlaps are called out on top.

## 7. Registries the group maintains

- **Feature inventory** — spec from design subagent (separate doc).
- **Test-case registry** — mined cases (separate doc); `sweep.ts test <case-id>`
  creates a throwaway worktree at the case's base commit, replays the upstream range,
  asserts the pipeline's classification matches `expected`. Run before changing sweep
  tooling itself (the pipeline tests the pipeline).
- **rerere cache** — `sweep/rr-cache/` committed on the maintenance branch; installed
  into the clone's .git/rr-cache (or via rerere.rrCachePath equivalent symlink) before
  stage 5; new resolutions from case-2 PRs are exported back.

## 8. Safety rails / policy

- Push policy: `main`, swept branches, `fix/sweep/*`, maintenance branch → push to
  origin (k-fls) is REQUIRED for the PR flow; owner has approved the PR-based flow.
  `edition/*` merges are always case-3 minimum (PR + owner ack) — that's what runs in
  prod. NOTHING is deployed by this procedure; "ready to deploy" is a report line.
- The group never force-pushes, never rebases published branches, never touches
  `everything` except scripted rebuilds in temp worktrees, never writes to `main`
  except FF.
- All destructive-ish git (update-ref, worktree add/remove) happens inside sweep.ts
  with journaling; agents call subcommands, not raw git, for state mutations.
- API-error resilience (D-008): the group's orchestration retries dead subagents (≤2),
  checkpoints between stages (state file), and every stage is resumable.

## 9. Agent group installation — per design doc 02

The estate topology, credentials (GitHub App per-child scopes), trust chain, updater,
and bootstrap sequence are already designed in `docs/design/02-self-maintaining-flsclaw.md`
(§3, §6-8, §11) — this spec does not redesign them. The sweep scripts slot in as:
watcher runs `sweep.ts fetch|scan` in its no-push clone; maintainer consumes the report
and runs PoI classification subagents (feature-inventory prompts); change-author runs
`sweep.ts merge|verify|record` in its RW working clone and opens the PRs. At M0, the
operator runs all stages by hand. Estate scaffolds live under `estate/` per doc 02 §11
(to be authored when the estate is bootstrapped; blocked on feat/dependent-groups
recovery — out of scope for this implementation round beyond the directory layout).

## 10. Implementation deviations (scripts/sweep, 2026-07-10)

The toolkit in this directory implements §5 with the following deliberate
deviations from the letter of this spec and the feature-registry design:

1. **Ref-only replay.** The test-case replay harness (`replay.ts`) does not
   create a throwaway worktree/clone at the case's base commit: new-style
   `git merge-tree` and `rev-list` operate on the pinned commits directly, so
   the replay is checkout-free and structurally unable to mutate anything.

2. **Adaptation to the live registry schema** (`maint/fork-registry`, which
   evolved past the written designs while being authored): `upstream_range`
   may be `{from, to}` as well as `a..b`; propagation cases use
   `merge_source` (fork-internal merge into `fork_base_commit`) instead of
   an upstream range; rich taxonomy classifications are normalized to the
   mechanical outcome (`semantic`/`semantic-collision`/`mixed`/
   `agent-resolvable`/`feature-overlap`/`known-recurring` -> conflict;
   `clean-with-semantic-poi`/`clean-with-security-poi` -> clean; `excluded`
   -> skipped) and **unknown classification labels fail closed** (case
   fails, never silently passes); expected conflict paths may carry
   `(modify/delete)`-style annotations; `expected.pois` prose strings are
   notes, not assertions; `key_symbols` may pack several symbols per anchor
   (`"A / B — path"`, any hit passes rule 4); `routing.yaml` extras are
   honored (`catch_all.always_include`, `large_new_file_kb`,
   `sensitive_surfaces` as scan tuning).

3. **Leave-one-out verify attribution.** Stage 6 maps a red test matrix to
   the offending branch by re-building the recipe with one branch removed at
   a time (reverse recipe order) rather than reasoning over the last-merged
   range; deterministic and unit-testable, at the cost of extra rebuilds.

4. **Scope rule.** The sweep scope is the UNION of (feature-registry
   entries' owning branches) and (`sweep-state.json` branches with status
   `active`); branches present only in the state file (fix/* upstream-PR
   candidates, docs/notes) have a null feature link and no DAG edges but are
   scanned/merged like any other. Namespace exclusions (`everything*`,
   `experimental/*`, `wip/*`, `design/*`, `maint/*`, `worktree-agent-*`,
   `integration/*`, `test/*`, `sweep/*`, `fix/sweep/*`) and status
   `excluded`/`frozen` rules apply on top of both sources.

5. **2026-07-10 restructure — registry branch dissolved (owner decision).**
   The spec's "maintenance branch" / state-branch model (§3 `maint/self-update`,
   §4 sweep-state.json on a branch, D-017/D-018 `estate/sweep` data placement,
   D-023 `maint/fork-registry`) is superseded by a snapshot+seeds model:
   - Durable tooling config is committed WITH the code:
     `scripts/sweep/registry/` (schema, routing.yaml, scope.yaml, prompts) and
     `scripts/sweep/test-cases/` (replay cases, read from the local tree).
   - The feature inventory is a GENERATED artifact: mechanical fields derived
     fresh from git, judgment fields (invariants, overlap hints, routing
     keywords) merged from `.claude/skills/fork-registry-generate/seeds.yaml`
     — their canonical home. A stamped verbatim snapshot
     (`scripts/sweep/bootstrap/fork-registry@<tree-hash>/` + MANIFEST.md,
     moment of capture explicit) provides cheap re-bootstrap and is the
     default `--inventory`.
   - Live state is DERIVED or GROUP-OWNED: `lastMergedUpstream` is never
     stored (computed as `git merge-base <branch> upstream/main`);
     freeze/exclude overrides, open PoIs and the last-sweep record live in a
     plain JSON ledger in the group workspace (`--ledger`, default
     `<workspace>/sweep-ledger.json`) with an append-only sweep-log.jsonl
     journal; `record` writes workspace files only — no git commits.
   - Exclusion policy is CONFIG, not state: `scripts/sweep/registry/scope.yaml`
     (include globs main_patched/fix/**/docs/notes; explicit exclusion of the
     telegram branch). Scope = inventory branches UNION include-glob matches,
     minus exclusions — no state file participates.
   - The rerere cache is local/ephemeral under the workspace
     (`<workspace>/rr-cache/`); `seed-rerere` rebuilds it from pinned T2
     resolution cases (`resolution_ref` = the recorded merge commit carrying
     the canonical resolution), replayed in detached temp worktrees.
   - `--state-branch` no longer exists anywhere in the CLI.
