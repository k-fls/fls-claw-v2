# FLSclaw self-maintenance: upstream-sweep pipeline specification

This file is the top-level design of the upstream sweep: purpose, fixed
principles, scope/topology rules, and the division of labor between the
deterministic driver and the agent. Authority split: `MERGE-POLICY.md` owns
tiers, batching, noise, review, and publication; `PROPAGATION.md` owns the
propagation driver's mechanics; `SWEEP-STATE-MACHINE.md` owns the agent-facing
command surface. On conflict, those files win for their domains.

**Relationship to the estate design:** this spec is the detailed mechanics of
`docs/design/02-self-maintaining-flsclaw.md` §5 (flows a+b). Everything here is
runnable standalone (operator invokes the scripts directly) — the estate is the
wrapper, not a dependency.

**Placement:**
- Tooling: `scripts/sweep/*.ts` (tsx, positional args + `Usage:` line, `*.test.ts`
  siblings picked up by the vitest scripts glob). No new deps.
- Config, tracked in the fork repo with the code: the feature inventory
  `scripts/sweep/inventory/*.yaml` (§10 item 1); driver levers
  `scripts/sweep/registry/routing.yaml`; scope policy
  `scripts/sweep/registry/scope.yaml`; the checks gate's command list
  `scripts/sweep/checks.json`; blame's history facts
  `scripts/sweep/cut-point-exceptions.yaml`; prompt templates
  `scripts/sweep/registry/prompts/`.
- Mutable state: none durable — see §4.
- Branch naming: conflict-case refs are
  `fix/sweep/<slug(branch)>--<slug(parent)>-h<height>-<sha8>`; gate-fix refs are
  `fix/sweep/<slug(branch)>--gate-fix-…` (the case id).
- Verification commands (from CI, authoritative): `pnpm install --frozen-lockfile`;
  `(cd container/agent-runner && bun install --frozen-lockfile)`; `pnpm run format:check`;
  `pnpm exec tsc --noEmit`; `pnpm exec tsc -p container/agent-runner/tsconfig.json
  --noEmit`; `pnpm exec vitest run`; `(cd container/agent-runner && bun test)`; plus
  `pnpm run build` and `./container/build.sh` when `container/` changed.

## 1. Purpose and shape

A half-scripted / half-agentic procedure, operated by a dedicated agent group
("maintenance group"), that keeps the FLSclaw fork current with upstream
`nanocoai/nanoclaw`:

- **Scripted core** — the propagation driver (deterministic, idempotent,
  resumable): fetch, fast-forward `main`, per-branch conflict probing,
  rerere-assisted clean merges propagated down the branch DAG, the `everything`
  rebuild + checks as the verification gate, journaled pass artifacts, and
  every push and PR creation.
- **Agentic layer** (judgment): resolve the conflict cases the driver serves,
  write PR prose, analyze overlap between upstream changes and fork features,
  relay candidates and reports to the owner.

The scripted core's one LLM call is the cold read — a context-free `claude -p`
subprocess the driver runs itself; the agentic layer never does raw git surgery
the driver can do. The boundary is the state machine's command results plus the
pass-dir artifacts (journal, `plan.json`, case files, the `SWEEP-RESULT`): the
driver emits them, the agent consumes them.

## 2. Fixed principles (owner-approved)

- `main` = pristine upstream mirror, FF-only. All real merges happen on `main_patched`
  and below, along the DAG, merge-forward, resolving each conflict once at the
  topmost affected branch. `git rerere` replays known resolutions.
- Detection = per-branch new-style `git merge-tree` (full ort, virtual multi-base).
  NEVER `--merge-base=<x>` single-base preview, NEVER cherry-pick fallback (known
  two-merge-base pitfall). `everything` is rebuilt only as the verification gate,
  never merged anywhere.
- Awareness vs gating: a CLEAN merge whose merged range passes through a height
  at which a transitive ancestor is HELD is annotate-class — flagged in the pass
  report, never gated (PROPAGATION.md §1). Gating — an unresolved conflict, or a
  red verify on a publishable branch — blocks the affected branch only, per the
  tier ladder (MERGE-POLICY.md §1).
- Sensitive surfaces (credentials, egress/firewall, container spawn, host-rpc
  auth) carry security invariants on their inventory entries; a conflicted hunk
  that alters enforcement behavior on one with no covering record is HELD, and a
  sensitive path alone floors the tier claim at JUDGED (MERGE-POLICY.md §7 F2).
- Textually clean ≠ done: a pass pushes and publishes only after the
  full-integration rebuild + checks are green at `finish`. A red verify on a
  publishable branch rolls it back to its journaled pre-pass ref and demotes it
  to HELD(gate).
- No deep PR chains: a branch with an open conflict PR is **blocked**; the sweep
  only annotates the PR (a driver-maintained machine block plus posted urge
  comments carrying the count of newer pending upstream commits).
- Blocked state is origin-authoritative: derived at `sweep start` from the
  `fix/sweep/*` refs and their PRs (MERGE-POLICY.md §1), never read from a local
  store.

## 3. Repos, branches, isolation

- The maintenance group operates in its OWN clone under its group workspace
  (`--workspace` = the group root, parent of the clone); it never operates in a
  human's checkout and never touches the running deployment.
- There is no maintenance/state branch: durable tooling config is committed with
  the code under `scripts/sweep/` (see Placement), and everything else is
  derived per pass (§4). Cross-pass holds live on origin as `fix/sweep/*` refs.
- **Scope** = inventory branches + `main_patched` (structural) + non-inventory
  branches in the transitive edition composition (§10 items 3-4), minus
  `registry/scope.yaml` exclusions and the namespace exclusions (`everything*`,
  `experimental/*`, `wip/*`, `design/*`, `maint/*`, `worktree-agent-*`,
  `integration/*`, `test/*`, `sweep/*`, `fix/sweep/*`). The validator
  cross-checks the inventory against the repo's branches every run (§10 item 2,
  rule 5).

## 4. State model (derived; no durable local store)

The driver keeps NO durable local state — the sweep is a pure function of
(GitHub, committed config):

- Upstream coverage is DERIVED per branch (`git merge-base` ancestry against the
  pass's pinned trunk chain, PROPAGATION.md §2) — never stored.
- Blocked state lives on ORIGIN as `fix/sweep/*` refs plus their PRs;
  `sweep start` re-derives the blocked set from them every pass
  (MERGE-POLICY.md §1).
- Pass state (`journal.jsonl`, `plan.json`, step/case files, reports) lives in
  the disposable pass dir `<workspace>/propagation/pass-<watermark12>/`; every
  mutation goes through journaled driver commands (PROPAGATION.md §7-8).
- Exclusions are CONFIG (`registry/scope.yaml`), not state.

## 5. Scripted core — stages

Propagation, verification, and publication are the propagation driver
(`PROPAGATION.md`): internal stages `plan → run → verify → publish → push →
report`, reachable ONLY through the state machine's commands
(`SWEEP-STATE-MACHINE.md`) — `start` runs plan, `next-case` runs run, `finish`
runs verify → publish → push → report; `report-case` is the resolution gate,
and `abort` seals a pass. Each command is idempotent and crash-resumable: a
dead session resumes at the exact phase, and a pass that crashes before
`finish` has published nothing.

`sweep.ts` has ONE subcommand — `validate-registry`, the inventory validator
(§10 item 2; stage 0 of the runbook, step 3 of the `fork-registry-generate`
skill). Read-only; exit 1 on ALERTs.

## 6. Agentic layer — case handling and awareness

Merge and review handling is the CLEAN/MECHANICAL/JUDGED/HELD/DEFERRED tier
ladder — MERGE-POLICY.md §1 (authoritative) + PROPAGATION.md §1. HELD is the
only review state; anything review-worthy escalates to it. The agent's judgment
work:

- **Conflict cases:** resolve the case the driver serves inside its
  driver-managed worktree, claim `--tier`, and write the PR description
  (`pr/body.md`). What the agent may resolve is regulated by
  MERGE-POLICY.md §7.
- **Gate-fix cases:** fix a red build on the branch the driver blamed
  (MERGE-POLICY.md §8).
- **Overlap awareness:** for annotate-class flags and new upstream content,
  spawn overlap-check subagents (`registry/prompts/overlap-check.md` with the
  matched inventory entries' context; `catch-all-triage.md` when nothing
  matches). Findings: (a) overlap with an implemented/planned fork feature →
  HIGH-PRIORITY owner report (dedup/retire/adopt decision for the owner);
  (b) independent new feature/skill/improvement → NORMAL awareness line;
  (c) nothing interesting → one line in the sweep digest.
- **Candidates:** relay the CANDIDATES section to the owner verbatim; propose
  `clear` placements for approval; ask the `unclear` open questions
  (PROPAGATION.md §13, §10 item 6 here).
- **Reports:** one sweep digest per pass, built from the `finish`
  `SWEEP-RESULT`: landed vs conflicted branches, the PR list, stats,
  escalations. HIGH-PRIORITY overlaps are called out on top.

The agent never opens PRs, never pushes, and never mutates refs itself —
publication is driver-only (§8).

## 7. Registries the group maintains

- **Feature inventory** — `scripts/sweep/inventory/*.yaml` (§10 item 1).
  Entries are created/amended only with owner approval, via the
  `fork-registry-generate` skill (judgment fields seeded from its
  `seeds.yaml`), then validated with `sweep.ts validate-registry`.
- **Test cases** — pinned-SHA propagation cases under
  `scripts/sweep/test-cases/propagation/`, exercised by
  `propagation-cases.test.ts` (checkout-free replay model; regression anchors).
- **rerere cache** — `<workspace>/rr-cache/` (durable per group root); the
  driver installs it into the clone's `.git/rr-cache` before merging, and new
  resolutions are recorded as driver merges commit.

## 8. Safety rails / policy

- The DRIVER pushes: verify-gated, journaled pass pushes at `finish` are the
  ONLY pushes; the agent never hand-pushes anything. `edition/*` merges floor
  at JUDGED and AUTO-MERGE; owner-gating happens only by escalation to HELD.
  NOTHING is deployed by this procedure; "ready to deploy" is a report line.
- The group never force-pushes, never rebases published branches, never touches
  `everything` except scripted rebuilds in temp worktrees, never writes to
  `main` except FF.
- All destructive-ish git (update-ref, worktree add/remove) happens inside the
  driver with journaling; the agent calls the state-machine commands, not raw
  git, for state mutations. A protected-ref guard at the single ref-write choke
  point refuses to move `main`, `design/*`, `maint/*`, `everything*`, `test/*`,
  and anything outside the pass's resolved scope (PROPAGATION.md §8).
- Resilience: every stage is journaled and re-runnable. Infrastructure failures
  (pushes, cold-read tooling, GitHub API) hard-halt and are reported to the
  owner — never worked around; such issues are not sweep-agent duty.

## 9. Agent group installation

The estate topology, credentials (GitHub App per-child scopes), trust chain,
updater, and bootstrap sequence are designed in
`docs/design/02-self-maintaining-flsclaw.md` (§3, §6-8, §11) — this spec does
not redesign them. The live shape is ONE maintenance group running the state
machine in its own clone. Estate scaffolds live under `estate/` per doc 02 §11;
authoring them is out of scope for this toolkit beyond the directory layout.

## 10. Implementation notes (scripts/sweep)

1. **Inventory contract (strict config).** The inventory is
   `scripts/sweep/inventory/*.yaml`, one entry per file, loaded by default from
   the repo tree; `--inventory` overrides it for tests/fixtures ONLY. It is
   CONFIGURATION ONLY — owner-authored declarations of intent, never written by
   the driver; removing a feature = deleting its entry. Required fields: `id`,
   `name`, `kind` (`module`|`feat`|`edition`|`fix`|`planned`). `branch` is
   optional: an entry WITH a branch is swept; one without is
   planned/observational (validator rules 1-4 skip it). Legal fields:
   `parents`, `dependents`, `summary`, `owned_paths`, `touch_paths`,
   `key_symbols`, `symbol_watch`, `invariants`, `design_docs`, `test_anchors`,
   `overlap_hints`, `scope_guard` (`same-files` | `conflict-hunks`),
   `stack_cap` (integer ≥ 1), `tier_floor` (`judged` only), `always_merge`
   (boolean), `routing` (`keywords` / `always_check_on` string lists), and
   `prompt.extra_context` — owner-authored STANDING guidance, embedded
   path-matched into case materials and cold-read context; never a decision
   store (one-time adjudications live on their PRs and die with their refs).
   Unknown keys and bad values are entry ERRORS, and `sweep start` fails hard
   on them (ERR46_INVENTORY_INVALID), as it does on a missing or empty
   inventory. `key_symbols` anchors may pack several symbols per line
   (`"A / B — path"`; any hit passes validator rule 4).
2. **Registry validator** — `validateRegistry(repo, features)`, CLI
   `sweep.ts validate-registry`. Rules 1-5: (1) owning branch exists — ALERT;
   (2) every `owned_paths` glob matches ≥ 1 file on the branch — ALERT;
   (3) `test_anchors` + `design_docs` exist — ALERT; (4) `key_symbols` found
   via `git grep -F` — WARN; (5) sweepable branch (`module/**`, `feat/**`,
   `edition/**`, minus exclusions) without an entry — ALERT, and an
   edition-composition branch without an entry — WARN ("add one"). Entries
   without `branch` skip rules 1-4 (nothing on git to check them against).
   ALERTed entries make routing fail closed.
3. **Branch topology.** `main` only ever fast-forwards from `upstream/main`;
   `main_patched` merges `main` — these are the ONLY upstream entry points.
   Every other inventory branch merges its DAG **parents'** tips (inventory
   `parents`; roots default to `[main_patched]`), parents-before-children:
   upstream content reaches leaves exclusively through the parent chain, so a
   conflict gates the topmost affected branch and every descendant inherits the
   resolution via its parent merge — no re-conflicts, no duplicate PRs. A gated
   parent's tip does not advance, so children have nothing new to merge and can
   never overshoot. A branch with no inventory entry is IGNORED (no scan, no
   PRs, at most one digest drift line) UNLESS it is in the edition composition
   (item 4): such branches are swept with merge source `main` ONLY (upstream-PR
   candidates — never polluted with main_patched/fork content) and are flagged
   by the validator/digest until they get an inventory entry. Explicit
   exclusions (`scope.yaml`) apply first.
4. **The edition-composition test is TRANSITIVE and HISTORICAL.** Plain
   tip-ancestry alone would miss the lagging case: a branch merged into
   `main_patched`, where main_patched was historically merged into the edition
   but the edition has not absorbed the newest tip yet. A non-inventory branch
   qualifies if it was ever merged into any branch whose merge history
   (transitively) reaches an `edition/*` branch:
   - Tip-ancestry into a composition member is the cheap first check.
   - General test (fork-era, bounded at the fork point `d85efea2` —
     `FORK_POINT` in `config.ts`; unbounded in repos without that commit, e.g.
     fixtures): "B was merged into X" ⇔ some commit on B's FIRST-PARENT line —
     excluding commits reachable from `main` (pure upstream merges never
     qualify anything) and commits on the first-parent line of a DIFFERENT
     composition member (a branch cut FROM main_patched inherits its whole
     line; those commits are main_patched's own work, not evidence about the
     cut) — is reachable from member X. Reachability of second-parent/own-line
     commits is the test; merge-commit subjects are never trusted
     (squash/rename fragile).
   - Closure: seeds = `edition/*` branches plus `main_patched` (structural — it
     flows into every edition by construction); grow to fixpoint, prune members
     whose evidence got claimed by later-joining members, alternate until
     stable. All git reads (rev-list, first-parent lines, ancestry) are
     memoized per run; real-repo cost ≈ 4-6 s for 40 branches.
   - Qualifying branches are in scope, merge `main` ONLY, and are flagged "in
     edition composition but no inventory entry — add one". Everything else
     non-inventory stays ignored; explicit exclusions beat the closure;
     `everything*` and other namespace-excluded branches can never pull
     branches in.
5. **Leave-one-out verify attribution.** The verify stage maps a red test
   matrix to the offending branch by re-building the recipe with one branch
   removed at a time (reverse recipe order) — deterministic and unit-testable,
   at the cost of extra rebuilds. Reds that survive attribution become gate-fix
   cases or stop the pass (MERGE-POLICY.md §5, §8).
6. **Inventory candidates.** Candidates — sweepable-namespace or
   edition-composition branches with no inventory entry — are derived FRESH
   from git every pass: no cross-pass store, no report throttle. Each pass
   journals them and writes the pass dir's `candidates.json`; a candidate is
   reported every pass until the owner acts in config (an inventory entry or a
   scope exclusion). Candidates are never merged or planned for propagation
   (PROPAGATION.md §13).
