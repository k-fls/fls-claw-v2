# The sweep driver — developer specification

DEVELOPER documentation for the upstream-sweep driver: what it does, what it
refuses, and why. It is the single spec for the whole pipeline — purpose,
scope and topology rules, propagation mechanics, tier/merge/publication policy,
and the state machine's command surface.

The sweep AGENT does not read this file. Its entire world is
`doctrine/SWEEP-DOCTRINE.md` + `doctrine/RESULT-CODES.md`, which state the same
contract from the outside. Nothing here is addressed to the agent, and nothing
here restates what doctrine owns: the resolve-qualification rules (A1-A6 /
F1-F6 and their tie-breaker), how to choose a tier, the PR writing rules, and
the agent's reporting duties are DOCTRINE. This file states only what the
DRIVER does about them — it is demote-only, it applies floors, it lint-checks
the text mechanically, it embeds standing records into case materials. A change
here that alters what the agent sees must land in the doctrine in the same
commit.

Sections are numbered so code comments can cite them (`DRIVER.md §7.4`).

## 1. Shape and division of labor

The sweep keeps the FLSclaw fork current with upstream `nanocoai/nanoclaw`. It
is half scripted, half agentic:

- **Driver (deterministic, idempotent, resumable)** — fetch, fast-forward
  `main`, per-branch conflict probing, rerere-assisted clean merges propagated
  down the branch DAG, the integration rebuild + checks as the verification
  gate, journaled pass artifacts, and every push and PR creation.
- **Agent (judgment)** — resolve the conflict cases the driver serves inside
  the driver-prepared worktree, fix the red builds the driver blames on a
  branch, write PR prose, claim one `--tier` word.
- **Driver `claude -p` (one-shot, context-free)** — the cold read (§7.5), the
  only LLM call inside the loop.
- **Owner (by report, never inline chat)** — HELD PR review, ambiguous
  candidate inheritance, overlap awareness, genuine infrastructure failures.

The boundary between driver and agent is the command results plus the pass-dir
artifacts (§12): the driver emits them, the agent consumes them.

The command surface is the ONLY interface: `start` / `next-case` /
`report-case --tier` / `report-pr` / `finish` / `abort`
(`sweep-machine.ts`, wrapping `propagate.ts`). The stages named below —
plan, run, verify, publish, push, report — are internal and have no standalone
entry point: `start` runs plan, `next-case` runs run, `finish` runs
verify → publish → push → report, `report-case` is the resolution gate, and
`abort` seals a pass.

The agent has ZERO identifying params. It edits code in the worktree the driver
prepared, writes PR text at a fixed path, and claims one `--tier` word. There is
no `--case`, no `--resolved-ref`, no plan/branch/sha — the driver holds all of
it, which structurally removes the wrong-case / wrong-ref / stale-verdict /
forged-plan bug classes.

## 2. Model and invariants

### 2.1 No durable local state

The sweep is a pure function of (GitHub, committed config). Its only legitimate
local inputs are the config committed in the clone and git-bound caches
(`rr-cache`); anything else on disk is residue with no effect on a pass.

- Upstream coverage is DERIVED per branch by ancestry against the pass's pinned
  trunk chain (§2.2), never stored.
- Blockedness lives on ORIGIN as `fix/sweep/*` refs plus their PRs; `start`
  re-derives it every pass (§5.1). Within a pass the journal is the registry.
- Pass state (`journal.jsonl`, `plan.json`, step/case files, reports) lives in
  the disposable pass dir (§12.2).
- Exclusions are CONFIG (`registry/scope.yaml`), not state.

A local cross-pass state file is not merely redundant: it can go stale and be
read back as the current sweep state while an open pass sits beside it.

### 2.2 Pass, watermark, heights, coverage

A **pass** is one driver run over the whole in-scope DAG.

- **Watermark**: `start` pins `upstream/main`'s tip. The pass targets that SHA
  everywhere; upstream advancing mid-pass is invisible until the next pass.
- **Heights**: the trunk first-parent chain is enumerated once
  (`git rev-list --first-parent --reverse`) from the fork point, and each commit
  gets an index. A *merge head* is the pair `{sha, height}`; every comparison
  (barrier, DEFERRED, coverage, merge point) uses the height, with the sha as an
  integrity check. Never compare by commit date or subject. For `main_patched`
  the chain is enumerated on `main` (which FF-mirrors upstream); parents-model
  branches are measured against the same single chain, because content reaches
  them only through parents.
- **Coverage** (derived): a branch's covered height is the highest chain index
  whose commit is an ancestor of the branch tip. Ancestry along a first-parent
  chain is monotonic, so this is a binary search with
  `git merge-base --is-ancestor` (O(log n) probes) — `heights.ts`.
- **Pass pinning**: only `start` may open a pass. Later commands attach to the
  latest OPEN pass dir (one that has `plan-initial.json` and no `pass-complete`
  journal row) and take the watermark and fork point from `plan-initial.json`,
  never re-resolving refs — so a mid-pass `git fetch` cannot silently start a new
  pass or orphan the in-flight journal.

### 2.3 The `merge_status` block model

Per branch, `merge_status ∈ {PR_ID | DEFERRED | NONE}`, where NONE is the
absent field. No height or path is stored in it — heights are live per-pass
values (§2.2).

- **PR_ID** — the branch is held behind a case with a fix ref and (usually) a
  PR. It persists from the hold until the branch is COMPLETELY resolved (the
  owner resolves the PR AND the merge lands on the branch); it is never cleared
  at an intermediate step. A branch may carry several concurrent PR_ID rows, one
  per held case / origin ref.
- **DEFERRED** — computed, sticky (§5.2).
- Within a pass the view is derived from the journal (`origin-blocked` / `held` /
  `defer` rows, cleared by an `unfrozen` row); across passes it is derived from
  ORIGIN (§5.1). It is never read from a local store.

The predicate the run and verify stages use is PR_ID only: a DEFERRED branch
keeps its clean prefix and stays publishable, while a PR_ID branch is skipped
and arrives at the barrier with an empty interval.

### 2.4 Trust model

The driver re-derives VALUES from git, but its POINTERS — the plan, the journal,
every `--flag`, `case.json` — live in the agent-writable workspace and are
supplied by whoever invokes the CLI. Inside a single trust domain the driver is a
correctness core, not an enforcement boundary. It becomes an enforcement core
only under an owner-controlled invocation layer, which is an adoption condition,
not an afterthought:

- a wrapper (or separate OS/service identity) that pins the CLI flags (`--repo`,
  `--workspace`, `--upstream`, config paths), owns the pass directory
  read-write, and is the only principal allowed to run the mutating commands;
- cold-read PROVENANCE: the driver spawns the reader itself and validates the
  verdict's shape, but the invoker could stub the subprocess, so provenance
  ultimately rests on the invocation layer;
- push/PR execution behind the fork's own enforcement layer: agent identity
  separation, branch protection, required CI.

In-driver, defense in depth only: the protected-ref guard at the single
ref-write choke point (§2.5) and first-principles re-derivation of everything
derivable from git (§4.6, §6.4).

### 2.5 Safety rails

- `main` is a pristine upstream mirror, FF-only. All real merges happen on
  `main_patched` and below, along the DAG, merge-forward, resolving each conflict
  once at the topmost affected branch.
- The DRIVER pushes. Verify-gated, journaled pass pushes at `finish` are the
  ONLY pushes; the agent never hand-pushes. Refs move via `git push` ONLY — the
  GitHub API is used for PR creation and comments (normal use), never to
  fabricate refs or commits as a push workaround.
- The single ref-write choke point (`guardRef`) refuses to move `main`,
  `design/*`, `maint/*`, `everything*`, `test/*`, and anything outside the pass's
  resolved scope, regardless of what a step file, case file or CLI flag says
  (`ERR23_PROTECTED_REF`).
- `everything` is rebuilt only as the verification gate, in a throwaway temp
  worktree — never committed to, never merged anywhere.
- The group never force-pushes a target branch and never rebases published
  branches. The one force is `--force-with-lease` onto an existing `fix/sweep/*`
  ref when a reissue republishes to the same PR (§5.3).
- Checked-out branches are merged in their own worktree only when its status is
  clean; other branches merge via plumbing or a temp worktree, so no human
  checkout is touched.
- Infrastructure failures (pushes, cold-read tooling, the GitHub API) are
  REPORTED and never worked around.
- NOTHING is deployed by this procedure. "Ready to deploy" is a report line.

## 3. Inventory, scope and topology

### 3.1 The inventory (strict config)

The inventory is a directory of `<id>.yaml` entries — owner-authored
declarations of intent, never written by the driver. Removing a feature means
deleting its entry.

Resolution order for the inventory directory: `--inventory` when given;
otherwise `start` uses `<repo>/../inventory` (the group root, sibling of the
clone) when that exists; otherwise the loader falls back to the committed
bootstrap snapshot `scripts/sweep/bootstrap/fork-registry@<hash>/features`
(`config.ts defaultInventoryDir`). `start` pins the resolved absolute path into
machine state, so no later command takes the flag (§6.1).

Required fields: `id`, `name`, `kind` (`module` | `feat` | `edition` | `fix` |
`planned`). `branch` is optional: present means the entry is swept, absent means
planned. Legal optional fields: `parents`, `dependents`, `summary`,
`owned_paths`, `key_symbols`, `design_docs`, `test_anchors`, `scope_guard`
(`same-files` | `conflict-hunks`), `stack_cap` (integer ≥ 1), `tier_floor`
(`judged` only), `always_merge` (boolean) and `routing` (`keywords` /
`always_check_on` string lists). Any other key is an entry error: the inventory
carries no prose addressed to the agent and no record of a decision.

`key_symbols` anchors may pack several symbols per line (`"A / B — path"`); any
hit satisfies validator rule 4.

Loading is fail-closed per entry, not per file set: an entry with a YAML error, a
missing required field, a bad `kind`/`status`, or a missing `branch` on a
non-planned entry is DROPPED with a load warning, and the rest of the inventory
is used. Unknown keys are not rejected.

**Inventory context in case materials.** The driver embeds entries MECHANICALLY
(§6.3): those matching the case branch or parent, and those whose `owned_paths`
prefix-match a conflicted path. Each contributes its summary and `owned_paths`.
The inventory states WHOSE code a case is in; it carries no prose telling the
agent how to resolve anything, and nothing in it records a decision.

Fork-wide conventions the agent must respect are doctrine, not driver config:
`scripts/sweep/doctrine/FORK-CONVENTIONS.md`.

### 3.2 The validator

`validateRegistry(repo, features)`, CLI `sweep.ts validate-registry` (§12.4).
Read-only; exit 1 on ALERTs. ALERTed entries make routing fail closed. Entries
with `status: planned` or `retired` are skipped by the per-entry rules — there is
nothing on git to check them against.

1. The owning branch exists — ALERT (remaining per-entry rules are skipped for
   that entry).
2. Every `owned_paths` glob matches ≥ 1 file on the branch — ALERT.
3. Every `test_anchors` and `design_docs` path exists (a `path@branch` form is
   resolved on that branch) — ALERT.
4. Every `key_symbols` anchor is found by `git grep -F` on the branch — WARN.
5. Reverse check: a branch in a sweepable namespace (`module/**`, `feat/**`,
   `edition/**`, minus the exclusions of §3.3) with no entry — ALERT; a branch in
   the edition composition (§3.4) with no entry — WARN ("add one").
6. Verification freshness: `maintenance.verified_against` differing from the
   branch tip, or a `maintenance.last_verified` older than the staleness window
   (21 days) — WARN.

### 3.3 Scope

Scope = inventory branches whose `status` is `in-progress`, `shipped` or
`experimental` and that have a branch, plus `main_patched` (structural), plus
non-inventory branches in the transitive edition composition (§3.4) — minus
`registry/scope.yaml` exclusions and the namespace exclusions
(`everything*`, `experimental/**`, `wip/**`, `worktree-agent-*`,
`integration/**`, `test/**`, `design/**`, `maint/**`, `sweep/**`,
`fix/sweep/**`). Explicit exclusions apply first and beat the closure.

`fix/*` and docs branches are deliberately NOT excluded — they are swept in this
fork's practice as upstream-PR candidates; only `fix/sweep/*`, the driver's own
namespace, is.

Everything non-inventory that does not qualify through the closure is IGNORED:
no scan, no PRs, at most one digest drift line. A branch in a sweepable namespace
without an entry additionally produces a scope-drift warning and is reported as a
candidate (§3.7).

The pass runs in the maintenance group's OWN clone under its group workspace
(`--workspace` = the group root, the parent of the clone); it never operates in a
human's checkout and never touches a live installation. `start` refuses a
workspace that is the clone or a subdirectory of it
(`ERR37_WORKSPACE_IN_CLONE`): a pass inside the clone splits per-pass state from
the durable group-root `rr-cache` and kills rerere. A group root nested in an
OUTER git work tree (the real server) is fine.

### 3.4 The edition-composition closure

The test is TRANSITIVE and HISTORICAL, because plain tip-ancestry misses the
lagging case: a branch merged into `main_patched`, where `main_patched` was
historically merged into the edition but the edition has not absorbed the newest
tip yet. A non-inventory branch qualifies if it was ever merged into any branch
whose merge history transitively reaches an `edition/*` branch.

- Tip-ancestry into a composition member is the cheap first check.
- General test, fork-era, bounded at the fork point (`FORK_POINT` in
  `config.ts`; unbounded in repos without that commit, e.g. fixtures):
  "B was merged into X" ⇔ some commit on B's FIRST-PARENT line — excluding
  commits reachable from `main` (pure upstream merges never qualify anything) and
  commits on the first-parent line of a DIFFERENT member (a branch cut FROM
  `main_patched` inherits its whole line; those commits are `main_patched`'s own
  work, not evidence about the cut) — is reachable from member X. Reachability of
  the branch's own/second-parent commits is the test; merge-commit subjects are
  never trusted (squash/rename fragile).
- Closure: seeds = `edition/*` branches plus `main_patched` (structural — it
  flows into every edition by construction); grow to fixpoint, then prune members
  whose evidence was claimed by later-joining members, alternating until stable.
- Namespace-excluded branches are neither members nor candidates, so
  `everything*` can never pull branches in. The result excludes the editions
  themselves and `main_patched`.
- All git reads (rev-list, first-parent lines, ancestry) are memoized per run;
  real-repo cost is roughly 4-6 s for 40 branches.

Qualifying branches are in scope, merge `main` ONLY (§3.5), and are flagged "in
edition composition but no inventory entry — add one".

### 3.5 Branch topology and merge sources

- `main` only ever fast-forwards from `upstream/main`; `main_patched` merges
  `main`. These are the only upstream entry points.
- Every other inventory branch merges its DAG **parents'** tips (inventory
  `parents`, which hold branch NAMES; roots default to `[main_patched]`),
  parents before children. Upstream content reaches leaves exclusively through
  the parent chain, so a conflict gates the topmost affected branch and every
  descendant inherits the resolution through its parent merge — no re-conflicts,
  no duplicate PRs. A gated parent's tip does not advance, so children have
  nothing new to merge and can never overshoot.
- Edition-composition branches (§3.4) merge `main` ONLY — they are upstream-PR
  candidates and are never polluted with `main_patched`/fork content.
- A branch with no inventory entry is ignored unless it is in the edition
  composition.
- `dependents` on an entry contribute reverse edges; `scope.yaml extra_edges`
  contributes edges the inventory cannot express. Parent edges that point outside
  the scope are dropped with a scope-drift warning, and a branch left with no
  usable parent falls back to `[main_patched]`.
- Ordering is topological — `main_patched`, then edition-ancestors (independent
  roots), then the inventory DAG. A cycle is a hard halt naming the cycle.

### 3.6 The hierarchy module

`hierarchy.ts` is THE branch hierarchy; every question of "where does this branch
sit" comes through it, because an ad-hoc reimplementation is exactly where depth
goes wrong silently.

- Keyed by BRANCH — inventory `parents` hold branch names, not entry ids. Keying
  by id silently drops every edge.
- `main` = depth 0, `main_patched` = depth 1, and `depth = 1 + MAX(parent
  depths)`: a branch merges only after ALL its parents, so its position is
  governed by its DEEPEST one. MIN would put a child at or above its own parent;
  `assertNoParentInversion` ships with the module to make that class of error
  impossible to release.
- `minPath` is the SHORTEST chain of parents to `main`, excluding `main` — what a
  report or an escalation names.
- Unresolvable → `null`, sorted LAST, NEVER 0. A missing edge must never
  masquerade as "closest to the root".
- `parents` is MERGE topology. A branch CUT from another that its entry does not
  declare as a parent lands at the wrong depth; that surfaces as blame refusing a
  tie (§9.1) rather than as a wrong answer.

### 3.7 Inventory candidates

Candidates are branches — local or `origin/*` — in a sweepable namespace or
qualified by the edition closure, with NO inventory entry. They are never merged
or planned for propagation: discovery and reporting only. The invariant is that
the inventory may only contain branches whose inheritance is established, which
is why placement is an owner decision.

Inheritance derivation (`candidates.ts`) is mechanical and evidence-backed in
both directions, every finding recorded with SHAs:

- *Ownership model*: an established branch (inventory + `main_patched`) owns the
  commits of its first-parent line that are neither reachable from the pinned
  trunk nor on a DECLARED ancestor's line — declared inheritance explains
  sharing, undeclared sharing does not. A candidate owns only commits on no other
  line.
- *Fork point*: the candidate's first-parent-line divergence point from the fork
  ancestry (the first non-own commit walking tip-down) plus its trunk coverage
  height (−1 below the pass chain).
- *Proposed PARENTS*, strongest evidence first: `cut-from` (the fork point is
  owned by exactly ONE branch; owned by several → the specific "cut point
  ambiguous between X@sha and Y@sha" question); `merged-from` (P-own commits
  reachable from the candidate tip off its first-parent line and above the fork
  point; commits reachable from the trunk never qualify); `merge-base` (deepest
  merge-base among inventory branches — thin evidence, ALWAYS an open question,
  never `clear` by itself).
- *Proposed DESCENDANTS*: `merged-into` (candidate-own commits reachable from D's
  tip off D's first-parent line); `cut-of` (D's first-parent line contains the
  candidate, or shares undeclared fork-era history with it — direction is
  topologically undecidable and becomes an open question). A descendant finding
  is flagged `requiresEntryEdit`: it is D's existing entry that needs amending.
- *Confidence*: `clear` ONLY when at least one parent is derived and no open
  question exists — unambiguous parent set, no merge-commit fork point, fork-era
  ancestry present, no both-direction evidence, proposed edges acyclic against
  the declared DAG. Everything else is `unclear` and carries the specific
  question(s).
- *Known limit*: "c cut from D" and "D cut from c" produce identical DAGs; where
  both sides continued, the established-branch prior applies. Safe, because no
  entry exists until the owner approves the placement.

Candidates are derived FRESH from git every pass — no cross-pass store, no
throttle. Each pass journals a `candidate` row per discovery and writes the full
set to the pass dir's `candidates.json` (branch, tip, remoteOnly, forkPoint,
coverage, proposedParents, proposedDescendants, confidence, openQuestions,
changedFiles vs the strongest parent capped at 40 with `changedFilesTotal`). A
candidate is reported every pass until the owner acts in config — an inventory
entry or a scope exclusion; a branch that gains an entry simply stops deriving as
a candidate. Writing `candidates.json` and its journal rows from the plan stage is
derived REPORT state; ref writes stay exclusive to the execute paths through the
guard choke point.

The invariant is code-enforced at plan time: `plan.ts
validateInventoryInheritance` hard-halts, naming the entry, when an in-scope
entry declares a parent missing from the inventory/structural set, and `scope.ts`
hard-halts on any DAG cycle.

## 4. Planning and merge execution

### 4.1 The plan

`plan.json` is the whole-pass plan: DAG order, per-branch per-parent heads
`{sha, height}`, skip/merge/defer verdicts, leaf un-skip chains. It is pure
derivation from git state + inventory, so regenerating it is a no-op. The opening
snapshot is preserved immutably as `plan-initial.json`.

Order is strict breadth-wise over the DAG: a branch is processed only when ALL
its parents have been processed this pass — a parent whose result is "skip" or
"HELD with empty progress" still counts as arrival (possibly with an empty
interval). The DAG is validated before every pass and a cycle halts it.

Only the interval's UPPER bound is strict. `git merge <sha>` merges the sha's
entire ancestry, so the lower end is bookkeeping: a branch that skipped or froze
in earlier passes catches up when it next merges.

Before executing, the live re-derivation must match the pass's last written plan
for all not-yet-arrived branches; a mismatch means git moved underneath the pass
(`ERR24_PLAN_DRIFT`). Branches the driver itself already mutated or demoted this
pass (journaled `merge`/`case`) are excluded from that comparison, as are
origin-synced branches — the execution re-probe's clean→case/skip demotion (§4.3)
is a sanctioned transition, not drift.

### 4.2 The eligible line

For entry-point branches (`main_patched`, edition-composition branches merging
`main`) the eligible line is the trunk first-parent chain up to the watermark;
heads are trunk commits.

For parents-model branches it is the **parent branch's own first-parent
history**: candidate heads are the parent's commits, each carrying a derivable
covered height. "Merging the parent at height ≤ N" means merging the newest
parent commit whose covered height is < N, derived by ancestry probes with no
stored refs. If the parent advanced in one big merge and no such historical tip
exists, the child simply does not merge that parent this pass.

**Fork-only parent content**: when the height-filtered line would be empty but the
parent tip is NOT an ancestor of the child, the parent tip itself (at its derived
height) is the single candidate head. Otherwise a fork fix merged into a parent
would not reach descendants until upstream next advanced.

### 4.3 Merge-point selection — linear sweep, never bisect

"Merging up to height k conflicts" is NOT monotonic in k: a later upstream commit
can rewrite a disputed region so the tip-level three-way merge is clean again. So
merge-point selection is a linear sweep, never a stop-point bisection, which
would embed the monotonicity assumption.

Per branch and per parent, over the parent's eligible line:

1. Probe the full range first — one in-memory `merge-tree` against the parent's
   eligible tip. Clean → done (the common case, one probe total).
2. On conflict, sweep the eligible line linearly (one probe per candidate head,
   oldest → newest), recording clean/conflicted per height.
3. Merge at the LARGEST clean height — which may lie beyond intermediate
   conflicting heights, whose content then lands cleanly at tip level.
4. Report the case starting at the smallest conflicting height above the merge
   point, stacked per §4.4.

Probes are checkout-free and cost milliseconds; upstream deltas are tens of
commits, so linear cost is negligible and correctness beats O(log n).

**Detection invariant.** Conflict detection is per-branch NEW-STYLE
`git merge-tree --write-tree` (full ort, virtual multi-base). NEVER
`--merge-base=<x>` single-base preview (bogus conflicts on branches with two
merge bases), NEVER a cherry-pick fallback. `everything` is rebuilt only as the
verification gate (§10.2), never merged anywhere.

**Probe determinism.** Automerge-tree OIDs depend on the literal merge-tree
invocation: conflict-marker lines embed the command-line labels verbatim (branch
name vs sha → different blob → different tree), and `merge.conflictStyle`
adds or removes the `|||||||` base section. Every driver probe therefore passes
pinned SHAs, never ref names, and forces `-c merge.conflictStyle=merge`, so
recorded automerge trees are reproducible across clones and user configs and the
resolve-time drift halt fires only on genuine movement.

**Execution re-probe.** Plan-time probes are computed against the branch tip at
derivation time, but a branch's parents are merged SEQUENTIALLY: once parent #1's
merge advances the tip, parent #2's clean verdict is stale. Every non-forced merge
is therefore re-probed against the branch's CURRENT tip immediately before
execution, and on staleness that parent row is re-derived live — conflicted → an
ordinary case at that point (conflict set and automerge tree recomputed from the
current tip; the branch's remaining parent merges halt for this run and continue
through the reopen machinery once the case resolves, siblings unaffected);
tree-equal → a journaled no-op skip. Forced (empty) merges are exempt: they exist
only when every parent no-op'd, so the tip cannot have moved. A failure in the
merge plumbing halts THAT BRANCH, journaled (`ERR21_MERGE_FAILED`), never the
process.

### 4.4 The case unit — commit stacking

A case is the MAXIMAL RUN of consecutive conflicting heights whose conflicted
path sets intersect — one logical decision — capped by `stack_cap` (default 5;
global lever in `registry/routing.yaml`, per-entry override on the inventory
entry). The run breaks at a clean height, at a disjoint-path conflict (its own
case later), and at the cap. Never stack disjoint-path conflicts; never stack
across a clean height.

The case's `head` is the run's TOP commit, and `conflictedPaths` / `automergeTree`
are computed at the top, so resolving the case resolves the whole run under ONE
cold read. This applies to all conflict tiers: MECHANICAL/JUDGED resolve the run
as one case; a HELD PR's head is the run's top commit, so its diff is the whole
run. The DEFERRED height check and urge tracking are computed against the run's
top.

### 4.5 No-op skips and the leaf must-merge rule

- A parent merge whose merge-tree result tree equals the branch's current tree is
  a no-op: journaled `skip`, no merge commit. Merge-base consequences are benign
  — the next real merge covers the gap.
- Leaves and entries flagged `always_merge: true` must land at least one real
  merge per pass when the pass carries upstream progress. If every parent chain
  above such a branch no-op'd, the driver un-skips the CHEAPEST parent chain: the
  intermediate merges are no-ops by definition, so they cost one empty merge
  commit each but keep "every branch only ever merges its inventory parents"
  absolutely uniform. There is no merge-main-directly shortcut for leaves;
  hierarchy has zero special cases.

### 4.6 The step contract

`step-<branch>.json` is the per-branch contract the merge executor accepts. The
executor re-verifies from first principles and never trusts the file's author:
the parent is an inventory parent (or `main` for entry-point branches); the head
sha matches the claimed height and lies on the parent's eligible line; the height
is ≤ the watermark; all parents arrived this pass (journal); skip claims are
recomputed via merge-tree; the leaf rule is honored. A verification failure is a
hard halt, journaled.

The same trust rule governs cases (§6.4): `case.json` is a POINTER, never an
authority.

### 4.7 Origin sync and remote-only branches

The driver never operates on `refs/remotes` directly. An inventory branch that
exists only as `origin/<branch>` is fully in scope: plan-time reads (tips,
coverage, eligible lines, probes) use the origin commit, and the plan row is
flagged `materialize`. A branch present in NEITHER place is a loud scope-drift
warning and is dropped from the pass.

At execution, before a branch's first mutation this pass, one journaled sync step
reconciles the local ref with `origin/<branch>` through the guard choke point
(the plan stage and dry runs never write refs):

- no local ref → create it at the origin tip (`branch-materialized`; its rollback
  target is the creation point);
- strictly behind origin → fast-forward (`branch-synced`; a checked-out worktree
  goes through the dirty-guard + reset pattern);
- ahead of origin → unpushed driver work: no action, no noise;
- DIVERGED → a journaled halt for THAT BRANCH only (`ERR20_BRANCH_DIVERGED`). It
  is skipped this pass, arriving at the barrier with an empty interval, and
  reported; siblings keep processing. Divergence is an owner escalation, never
  force-resolved.

Before ANY ref mutation on a branch, its pre-pass tip is journaled (`pre-ref`) —
the rollback target for the verify gate (§10.2) and for `abort` (§6.6).

## 5. Blockedness

### 5.1 Origin-derived state at `start`

`start` fetches origin and upstream first (`ERR39_FETCH_FAILED` — a pass never
opens on a stale view), with the `fix/sweep/*` namespace fetched `--prune` under
its own refspec so a ref another clone deleted cannot linger locally and
re-derive as blocked. It then reconstructs the blocked set from the origin
`fix/sweep/*` refs BEFORE planning (`deriveOriginMergeStatus`). Per ref:

- **merged** — the ref head is an ancestor of `origin/<target>`, or the PR
  reports `merged_at` (squash/rebase-merged) → resolved, and the ref is DELETED.
- **closed unmerged** — the owner withdrew the case: the ref is DELETED, the
  disposition is journaled `origin-ref-withdrawn`, and the branch is left
  UNBLOCKED so the conflict is re-derived fresh.
- **ref present with NO PR** (a crashed publish) → RECOVER: the PR is created from
  the ref head — the ref's resolution is authoritative and is never re-derived —
  and the branch is blocked. The recovery PR is a draft exactly when the ref's own
  diff still carries conflict markers.

Every blocking row carries the KIND of the proposal, read from the head's shape
at this moment (§5.2) — two parents merge, one parent fixes. The ref NAME never
decides it: a name is a string the driver minted, not a fact about the objects,
and by the time the plan reads the journal it would be all that survived.
- **ref ABSENT** → nothing to carry: the conflict is re-derived fresh, and a new
  case yields a new PR at `finish`.
- **slug matching no scope branch** → journaled `origin-ref-unknown` and left
  alone.

Every lookup and write is fail-closed. A missing token while unmerged refs exist
is `ERR11_TOKEN_MISSING`; an unusable origin URL is `ERR12_ORIGIN_UNRESOLVED`; a
non-2xx or transport error is `ERR13_API_FAILED`; 401/403 is
`ERR41_TOKEN_REJECTED`, whose detail names the token's SOURCE (`$GH_TOKEN` /
`$GITHUB_TOKEN` / `--token-file`) and never the token, because a retry with the
same rejected token can never clear it. An API failure never reads as "no PR".
The one delete that happens without a PR lookup is the merged-ancestor arm, where
containment in the target is the proof.

The GitHub token is read from the ENVIRONMENT (`GH_TOKEN`, fallback
`GITHUB_TOKEN`) at each networked write and never persisted; `--token-file` is an
internal/test override that wins when present.

`start` is idempotent on origin: a pass that crashed before `finish` published
nothing, so the re-derived picture is clean.

### 5.2 The open proposal is the cut-off

AN OPEN PULL REQUEST IS A PROPOSAL. Until it merges, nothing in it is part of the
branch, so the branch tip is exactly what exists for anyone below it and the PR
is the upper CUT-OFF of the merge window — for the branch itself and for every
descendant. A cut-off exists iff the PR is open and its head is not reachable
from the branch tip; GitHub squash- and rebase-merges land content without
ancestry, so the PR's own state is the authority and reachability is
corroboration. Heights are a comparable projection used to order candidates
INSIDE an eligible line; they never decide whether a cut-off exists.

**Two kinds of proposal, told apart by the HEAD'S SHAPE, never by the ref name.**
`start` classifies each open sweep PR when it reads it — that is the only moment
the objects are in hand — and journals the kind:

- A head with TWO PARENTS proposes a MERGE. Its cut is the SECOND PARENT'S
  coverage: that is the conflict head the resolution merges, and it is where the
  window closes. The head's OWN coverage is the maximum of the two sides, so
  once the branch tip moves past the conflict (an owner commit, another parent's
  merge) it reads high and would hand descendants content nobody integrated.
- A head with ONE PARENT proposes a FIX to the branch's own content, so the
  branch is RED. It FREEZES the branch and every transitive descendant: they
  take nothing from any parent, through the same empty-interval, all-skip path a
  branch waiting on its own PR gets. That is about VERIFIABILITY, not
  provenance — below a red branch every case is unjudgeable, `report-case`
  checks fail on a defect the open fix already describes, `--not-my-bug` burns
  adjudication rounds proving it, and the agent is handed work that cannot
  complete. The only way to let merges flow past would be to exclude the tests,
  which makes the gate meaningless.

**Cut inheritance.** Each parent edge contributes a cut. A branch's EFFECTIVE
CUT is the MINIMUM over its parents' cuts, and it passes that minimum to its own
descendants — a cut is a statement about content nobody has integrated, and
content does not become integrable by travelling one more edge down. Taking the
minimum is what makes the lattice compose: each branch looks only at its DIRECT
parents, because each of those already carries everything above it.

**The cut is on CONTENT, not on an edge.** It trims EVERY parent's line at that
trunk coordinate, so a sibling parent carrying the same trunk commits is cut
there too; a parent's fork-only work, disjoint from the cut, still flows. A
freeze is not a separate mechanism — it is the BOTTOM of the same lattice
(`WHOLE_RANGE_BLOCK`), which is also what an unmeasurable block contributes: an
unmeasurable block is a total one, not an absent one.

Content at or above the cut has been integrated by nobody and cannot be until
the proposal is resolved; merging it here does not make it integrable, it
advances THIS branch onto a state the trunk has never seen, and the integration
rebuild (§10.2) then meets that state, blames this branch and rolls it back for
a conflict it did not cause.

Cutting gates what a branch TAKES, never what it REPORTS. Below the cut the
ancestors are genuinely clean, so what remains merges normally and a conflict
there is the branch's OWN — its own case, its own PR, in this pass. Withheld
content is journaled as DEFERRED rather than as "up to date": "nothing to take"
and "something to take, blocked upstream" are different facts, and the second is
what the owner is waiting on and what the urge counts (§5.5). A branch cut this
way has a block above it, so the integration recipe leaves it out by the same
rule that cut it (§10.2 step 1) — the exclusion needs no rule of its own. It is
still PUSHED at its cut point: the prefix below the cut is a complete position,
and leaving it unpushed diverges the branch from the PR base its own held case is
opened against. Not built, still landed, and the result says which (§10.7) — but
never unmeasured: the prefix goes through the landing gate (§7.6) like any other
merge, so what ships at a cut point is green even though no integration build
covered it.

DEFERRED is a PURE HEIGHT-MIN over the branch's BLOCKED DIRECT PARENTS
(`deferred.ts`). When branch X hits its own conflict at height `conflictHeight`
(the run TOP, §4.4):

    defer  ⇔  blockedParents ≠ ∅  ∧  conflictHeight ≥ MIN(blockedParents.height)

Below that MIN every parent is clean, so the conflict is X's OWN and takes the
normal ladder (its own case, its own PR). There is no conflicted-path
intersection test and no per-transitive-ancestor window: the rule depends only on
DIRECT parents, because a clean intermediate parent (`merge_status` NONE)
correctly stops propagation until it re-merges the resolved content — parent
resolves → its merge lands → NONE → the child re-merges and may raise its own new
case.

A DEFERRED branch commits its clean prefix and STOPS: no merge above, NO PR. It
is sticky while any direct parent is blocked (the fixpoint also treats a DEFERRED
direct parent as blocking), and it clears when all parents are NONE, at which
point the branch re-merges fresh. Heights are live per-pass values and are never
carried numerically across passes.

A branch below a blocked one derives differently from the plan on disk by
construction, and a block can arrive mid-pass (a verify gate hold is journaled
long after `start` wrote the plan). That is a sanctioned transition, excluded
from the plan-drift halt (§6) exactly as the blocked branch itself is.

### 5.3 The held-PR review loop

A held PR is a two-way review loop, and the trigger is SUBMITTED REVIEWS ONLY.

- **Trigger.** A held PR is re-served this pass (a REISSUE) iff a submitted,
  non-`*[bot]` review exists whose id is above the driver's
  `<!-- sweep-addressed: <review_id> -->` marker (or ≥ 1 such review and no marker
  yet). PENDING (unsubmitted) and DISMISSED reviews are excluded. Loose issue
  comments and standalone inline comments NEVER trigger a reissue — they feed the
  reissue dialog and nothing else.
- **The marker** is a driver comment recognized ONLY as a line by itself,
  id-bounded; the bot/human split is by CONTENT (a shared token authors both);
  the effective addressed id is the MAX over all marker occurrences, bounded by
  the largest real review id, so a re-asserted value never regresses. A dismissal
  above the marker advances the marker with a posted comment and journals
  `review-dismissed` — no reissue.
- **APPROVED + still merges cleanly into the CURRENT target** → the DRIVER lands
  it (`landApproved`): the fix-ref head is merged into the local target, a
  `pre-ref` is recorded first so `abort` can roll it back, the rows
  `origin-approved` + a `resolved` disposition with tier `approved` are journaled,
  and the branch is left UNBLOCKED. `finish` verifies and pushes the target, and
  the push auto-flips the PR to merged. There is no reissue, and the driver never
  hand-merges the PR on GitHub. A target that already CONTAINS the head (a prior
  landing whose push never arrived) journals the same rows without a second merge.
- **APPROVED but STALE** (the target advanced past the point where the head merges
  cleanly) → REISSUE: the agent re-resolves against the new base, keeping the
  approved intent.
- **CHANGES_REQUESTED / COMMENTED / anything else** → REISSUE, and `report-case`
  forces the result to HELD whatever tier is claimed, so a revision never merges
  in place and bypasses the open review.
- **The reissue feed is the FULL time-ordered dialog** — PR description (the
  opening turn) + issue comments + inline review comments + review bodies. The
  agent's own prior turns are served tag-stripped and marked `you (prior)`; every
  other turn is keyed by its GitHub `@login`. Marker-only driver comments are
  dropped.
- **Republication targets the SAME PR**: `--force-with-lease` onto the existing
  fix ref at the head classified at `start`, `PATCH` on the same PR number, and a
  fresh marker at the triggering review id. Before any of that the live PR state
  is re-checked; a merged or closed PR aborts the republish
  (`publish-skipped-live`).
- **Owner-pushed commits on the fix branch** become the revision base: the case
  worktree's pending files are rebuilt from the CURRENT ref head (the conflict
  head itself is re-resolved from the sha encoded in the ref name).
- **A reviewed GATE-FIX PR is never reissued.** A reissue re-probes a live
  conflict and a gate fix never had one, so it is escalated ONCE with an honest
  ask ("it carries a fix, not a conflict resolution — merge or close it") and
  stays blocked.

### 5.4 Active gates

An unmerged `fix/sweep/<slug(branch)>--gate-fix-*` ref on origin is an ACTIVE
GATE on that branch: no second case is minted, the branch is skipped, and
`next-case` REPORTS it (`activeGates`) so "nothing to serve" is never mistaken for
"nothing is wrong". It is keyed on the BRANCH — a gate fix is per-branch — and it
self-clears when the owner merges the PR. A gate on the trunk skips everything
beneath it, since a blocked direct parent already defers its descendants.

### 5.5 Urging and the machine block

No deep PR chains: a branch with an open conflict PR is blocked, and the sweep
only annotates that PR.

Every HELD PR body carries a driver-maintained, clearly delimited machine block
(`<!-- sweep:d004 -->` … `<!-- /sweep:d004 -->`) appended BELOW the agent's
prose: the count of further pending upstream commits beyond the freeze, as of the
pass. The agent never edits the machine block; the driver never touches the prose
above it, and setting the block is idempotent.

When a pass finds NEW pending content for a blocked branch beyond what it was
last urged about, the push stage POSTS an urge comment on the freeze PR (pending
count since the freeze, the newest heads with subjects), refreshes the machine
block, and records the new last-urged head. "Last urged" is read from the PR's OWN
`sweep-urge: <head>` comment markers, never from a local cache. The tracking
advances only after a successful post; a failed post is `ERR17_URGE_FAILED` and
the urge retries on a later pass. One urge per new head, not per pass — quiet
passes stay quiet. The plan and run stages only DETECT a would-be urge; posting
lives exclusively in the networked push stage.

### 5.6 Disposition of an open proposal

A PR that carries NOTHING NEW calls no agent (§5.3) — but the base moves,
conflicts heal and answers go stale, so the ref must not go on exhibiting a
question nobody is asking. What happens to it follows from what it IS now, never
from how it got there.

**Whose head is it.** THE DRIVER-SHAPE TEST is the commits on the ref, not
authorship metadata and not the ref name: walk the FIRST-PARENT line from the
head down to the PR base; every commit on it must carry the driver's pinned
identity (`proposal.ts`). Anything else on that walk is someone else's push. An
empty walk — the head is already contained in the base — is not a driver head
either. This is what the single-commit pristine-conflict head (§10.4) buys:
`parents[0]` is the base tip, so the walk is one commit.

**Exhibit or answer**, decided on CONTENT: a head whose tree still carries
markers poses a question; one that does not offers an answer. The draft flag
says the same thing on a good day, but it is a label somebody can flip.

**Conflict identity** (`conflict-identity.ts`). The exhibit's own head IS the
baseline — its tree is the pristine automerge — so the recorded question is
recoverable from the objects with no need to re-run the old merge. THE
CONFLICTED PATHS COME FROM GIT: the head is a merge commit, so re-probing
`merge-tree` on its own two parents returns the conflicted-file list
authoritatively, and the hunk bodies are read from the tree the PR shows. Never
grep a tree for marker-shaped lines — a file may legitimately carry a line of
seven angle brackets (this repo's own sweep fixtures do), and such a phantom
hunk is invisible while both sides hold it and flips the verdict to `different`
the moment that file is edited for unrelated reasons, force-pushing and
commenting on a PR whose conflict never moved. Compare hunk
by hunk, never tree by tree: the clean part of a merge moves constantly.
Normalize by dropping the marker LABEL lines (all three forms) and by ignoring
the hunk's position in the file; keep the ours/base/theirs bodies verbatim,
because whitespace inside them is content. Identity is the set of
`(path, hunk-hash)`, and the set relation classifies it: empty = healed, equal =
same, strict superset = the body understates it, anything else = a different
question. `git merge-tree` does not consult rerere, so a recorded resolution
cannot make a probe look healed.

**"Mergeable"** is a local `merge-tree` probe against the target as it stands on
origin. **"Checks green"** is the DRIVER'S OWN checks gate — the one
`report-case` runs — on the MERGED tree; never GitHub check-runs, never
`mergeable` polling. No configured checks and no usable environment both mean NO
VERDICT, and no verdict reads as green: every consequence of red here is an
intervention on somebody's pull request, and the driver does not intervene on a
measurement it did not take.

**A RED IS RE-RUN BEFORE IT IS BELIEVED, because DELETE is the one row the next
pass cannot walk back.** Rebase, rebuild, leave and draft-and-report all
re-evaluate next pass and converge; deleting closes the review thread where the
decisions live and discards the resolution, so the case re-derives from zero and
a flaky check deletes and re-creates the same PR on alternating passes with a
new number each time. So before any delete driven by a red check, the failing
commands run AGAIN on the identical tree — the integration gate's determinism
probe (§10.2) — and a disagreement between the two runs is NON-DETERMINISM, not
a red: nothing is deleted, the proposal stands, and the unstable check is
reported (`undecidedProposals`, §10.7). A SPAWN-LEVEL fault — the command never
ran (missing binary, OOM), which `spawnSync` reports as a null status — is an
ENVIRONMENT FAULT (`WARN14_ENVIRONMENT_FAULT`) and never a failing check: the
tree was not measured, so there is no verdict to act on.

| Head | State | Action |
|---|---|---|
| driver | conflict healed | delete the ref (the PR closes) |
| driver | same conflict, base moved | rebase the ref; keep the PR and its body |
| driver | conflict changed or superset | rebuild the ref; the body no longer matches |
| driver | answer, mergeable + checks green | approved → land it (verify-gated); else rebase if the base moved |
| driver | answer, not mergeable or checks red | delete the ref (the PR closes); proceed as a fresh case |
| OWNER | mergeable + checks green | leave it alone entirely |
| OWNER | not mergeable or checks red | convert to draft + comment ONCE; report at finish |

NEVER REBUILD AN OWNER-SHAPED HEAD: force-pushing over commits someone else put
there is the one destructive operation here. Deleting a ref is NOT destructive —
GitHub closes the PR and keeps its commits, restorable — so an unusable head is
deleted and reported, never force-rebuilt. A rebase or rebuild pushes onto the
SAME ref under a lease against the head this pass classified; deriving a fresh
name from a changed conflict would mint a second ref and a second PR for one
case.

The draft flag is the "already told you" marker, so an owner PR is converted and
commented on ONCE and a PR the owner opened as a draft gets neither. The
conversion and the comment are a courtesy on the transition and never stop the
pass; the REPORT is the notification — `finish` lists every owner-shaped PR that
no longer merges or no longer passes, drafted by us or not, every pass, phrased
as "PRs you changed that no longer merge or no longer pass: fix or close".

## 6. The commands and the case loop

### 6.1 `start`

- **Refuses an open pass** (`ERR30_PASS_OPEN`). A blind wipe would strand
  resolved-but-unpushed merges, and continue-vs-abort is the OWNER's call:
  `finish` resumes from the stopped step and keeps the pass's merges and published
  PRs, `abort` rolls every touched branch back to its journaled pre-ref and throws
  the in-flight work away. The refusal returns the counts and both options and
  chooses neither.
- **Config is resolved and PINNED here.** `start` resolves the inventory dir
  (§3.1) and the checks file (`--checks-file`, default
  `scripts/sweep/checks.json`) and persists their absolute paths into machine
  state, so no later command takes either flag. A checks file that does not PARSE
  refuses here (`ERR43_CHECKS_MALFORMED`) BEFORE the clean-slate wipe — that check
  READS the file, it does not run it, and a gate that cannot parse its config
  silently checks nothing. An ABSENT checks file skips the gate silently, which is
  intended. Mid-pass commands re-read the pinned paths and stay fail-open.
- **Workspace guard** runs first (`ERR37_WORKSPACE_IN_CLONE`, §3.3), then the
  fetch and the origin derivation (§5.1), then planning and candidate derivation
  (§3.7).
- **NO BASE GATE.** `start` opens the pass and does not judge the build — it
  typechecks nothing and refuses nothing for redness. A red base is an ordinary
  red for `finish`'s verify to find, blamed to the branch that owns the failing
  files and served as a gate-fix case there (§9). The trunk is eligible for blame
  like any branch: it is a scope entry and the default parent of every root. The
  cross-pass anti-loop is the fix's own PR (§5.4).
- **Clean-slate boundary.** The pass lives at ONE canonical location,
  `<workspace>/propagation/pass-<watermark12>`. After the open-pass refusal,
  `start` removes the WHOLE prior pass tree there — worktrees, case dirs,
  `coldread-*`, `pr/` — so no leftover journal, HELD record or poisoned cold-read
  verdict is ever inherited; a failure to clear it is `ERR38_PASS_CLEAR_FAILED`.
  Worktrees are de-registered before the directory is removed, and teardown runs
  IN-CONTAINER, because a host `rm` fails on container-uid files. `abort` seals a
  pass with `pass-complete` (like `finish`) so it is never re-attached.

### 6.2 `next-case`

Deterministic and internal, with no `claude -p`: it drives the plan/run machinery
(CLEAN merges, no-op skips, DEFERRED holds), handles the barrier and reopens
internally, and serves the topmost undispositioned case in DAG order with its
prepared worktree and materials. The agent never sees the DAG.

It checks the branches TWICE, at the two moments a defect can enter. BEFORE any
merge, a typecheck-only pass over the participating branches catches a branch
that was already red (memoised per branch and tip sha as `branch-check`); a red
one merges nothing and is served its own gate fix. AFTER each prefix lands, the
landing gate (§7.6) runs the full checks on the branch tip, because a merge can
create a red that neither side carried. The two share one memo: a green
`landing-check` at a tip subsumes the pre-merge typecheck of that same tip, so it
is never paid twice. An open gate-fix case suppresses the pre-merge pass and all
merging until it lands.

Returns one of:

- `status: "case-ready"` with `worktree`, `branch`, `caseId`, `conflictedPaths`,
  the case `run`, `materials` + `materialsPath`, `reissue`/`prNumber` for a
  reissue, `activeGates` when any branch is gated, and a loop warning when the
  same case has been served repeatedly (`WARN46_CASE_LOOPING`, then
  `ERR48_CASE_LOOPING` when the next serve is refused);
- `status: "finalize"` — no case is open, run `finish` (carrying `activeGates`
  when branches are gated, and `heldAwaitingPublish` when a branch is still red
  but its fix is held and unpublished, which `finish` must publish);
- `status: "looping"` — the serve bound is exceeded: the case is refused with
  `ERR44_CASE_LOOPING` and no materials are prepared;
- `status: "stopped"` — a red branch with nothing servable and nothing to
  publish.

**The serve bound.** `case-served` is journaled only for serves that HAPPEN — the
row is appended AFTER the limit check, so a refusal never inflates the count it is
computed from. The refusal itself withdraws INVESTIGATION and nothing else: it
writes `phase: case-ready` with the refused case as `currentCase` BEFORE returning,
because the instruction it gives is `report-case --tier held` and `report-case`
hard-requires that phase. Refusing from any other phase would hand the agent an
instruction the driver rejects, leave the case in `openCases`, and halt `finish`
with `ERR34_CASES_REMAIN` — a pass with no legal move.

**Gate-fix cases** use the same `case-ready` shape with a DIFFERENT briefing,
because there is no merge: it states up front that nothing is pending and there
are no markers, names the failing checks, the blamed branch and why it was
blamed, lists the files to fix, states the scope explicitly (those files plus what
fixing them DIRECTLY forces — the only case type that changes code the pass did
not merge), spells out what each tier means, and carries the failing output (tail
inline, full log at `<caseDir>/gate-fix-output.txt`). Several gate-fix cases can
be outstanding at once — one per blamed branch, SHALLOWEST FIRST (§9.1).

**Crash-heal.** An open case whose branch tip already contains the case head is
healed: a synthetic `resolved` entry (reason `crash-heal`) plus `reopened` for the
branch and its descendants, so a crash between a ref update and its journal append
cannot leave the case open forever, and no second merge happens. The rule is
SKIPPED for gate-fix cases: their head IS the branch tip by construction, so the
heuristic is structurally inapplicable.

### 6.3 The case worktree and materials

The case worktree is a PENDING DIFF, not a checkout of the merge. The driver
commits the CLEAN PREFIX — the automerge tree with the conflicted paths reset to
base/ours — as the worktree's HEAD, then writes ONLY the conflicting delta into
the working tree: the automerge (marker) blob per conflicted path, unstaged, or a
deletion when the automerge tree dropped the file (delete/modify conflicts). The
index still holds the prefix version, so `git status` shows exactly the conflicted
paths and nothing else. On-disk bytes and the `add -A; write-tree` snapshot equal
a full checkout, so the empty check, the scope guard and the cold-read diff all see
the same content.

Worktree creation is idempotent: a case re-emitted after a reopen removes and
prunes any stale registration and directory before adding a fresh worktree.

Two more things are installed into every case worktree:

- the workspace `rr-cache` into the shared `.git` (§12.3), so rerere replays are
  visible inside the worktree;
- DEPENDENCIES, installed from the manifests THAT WORKTREE carries — never from
  the pre-merge branch tip, which is what makes a dependency the merge introduced
  look like an unresolvable-module error in the agent's code. `node_modules` and
  `container/agent-runner/node_modules` are the linked paths.

  The install runs BEFORE the conflict is written into the worktree. At that
  point the tree is the clean prefix, so every manifest in it is the base
  commit's own valid blob; installing after the marker blobs land means a
  conflicted `package.json` is not JSON, the install dies on it, the second
  install behind its short-circuit never runs, and the agent works its whole
  session in a tree with no `node_modules` — where every missing-types error
  belongs to the environment and not to the code. The manifests the CHECKS must
  run against are the RESOLVED ones, which do not exist at prep time; the gate
  installs again in the same worktree at `report-case` (§7.1).

  A prep install that FAILS is therefore about the machine, and the case is not
  opened: `run` halts on `ERR47_ENVIRONMENT_UNUSABLE` BEFORE journaling the
  `case` row, `start` skips serving a reissue and leaves its pull request
  untouched, and gate-fix minting skips the branch. Journaling the case first
  and refusing afterwards would leave it in `openCases` with nothing able to
  check it, `finish` refusing on `ERR34_CASES_REMAIN`, and no legal move left.
  The two resets to the PRISTINE conflict (§6.4 branch 4 and the checks-limit
  freeze) install NOTHING: they end the case, run no checks and hand the tree to
  nobody, so a broken machine cannot turn a legal freeze into a stuck case.

  Every install failure carries WHAT failed — the command, the directory it ran
  in relative to the worktree root, and a bounded tail of what it printed — and
  every row that records one carries it too (`environment-unusable`,
  `gate-fix-skipped`, `landing-check`, the `WARN13_DEPS_UNUSABLE` warning).
  Without it a manifest fault and a machine fault are the same row, and they
  have opposite dispositions.

Materials (`<caseDir>/materials.md`, plus `pr/materials.md` and a per-case
`pr/TEMPLATE.md`) are driver-authored facts only: the reading contract, the
conflicted paths, branch/parent/head/run/pending-above, the standing records
matched by path (§3.1), and per-side `git log --oneline` over the conflicted paths
for both sides. The driver NEVER generates PR prose (§10.5).

### 6.4 `report-case --tier mechanical|judged|held`

`--tier` is the ONLY agent param — a CLAIM; the driver is demote-only (§8). The
command is a pure function of (current case, worktree tree), re-callable, with no
accumulating loop state beyond the journaled attempt cap.

It first re-derives the case from git + registry (`case.json` is a pointer,
§4.6): the head sha must lie on the named parent's eligible line for this pass;
the automerge tree and conflicted-path set are RECOMPUTED via merge-tree against
the branch's current tip (recorded values are cross-checked for drift only); the
tier floor, the branch's kind/model/parents/ancestors and the pass scope guarding
the ref writes come from the registry + scope config, never from `plan.json`; the
case must correspond to an open journal entry with no later disposition; and the
branch tip must not already contain the head (the double-resolve guard). Any
mismatch is `ERR02_CASE_STALE`.

Branch order, first match wins:

1. **Held duplicate** → CONSOLIDATE into the topmost held twin. The twin is frozen
   for the owner with no PR yet, so "resolve that case" is impossible; a terminal
   `held-duplicate` disposition drains the open case, opens no PR of its own (this
   case inherits the twin's held PR) and reopens descendants.
2. **Adequacy block** — `ERR06_DUPLICATE_CASE`. Skipped for a reissue: its PR
   already exists, and re-litigating adequacy would re-open a settled question
   inside a live review.
3. **Conflicts present + claim ≠ held** → `ERR32_UNRESOLVED`.
4. **Claim `held` + conflicts present (a still-PRISTINE conflict)** → the worktree
   is reset to the pristine conflict and the case is frozen as a HELD DRAFT,
   SKIPPING the checks gate and the cold read entirely — there is no resolution to
   check or read. The reset that MAKES it pristine must succeed: a failure is
   `ERR44_WORKTREE_RESET_FAILED` and the case stays `case-ready`, because
   announcing a pristine worktree that still holds the agent's edits is a plain
   false statement.
5. **RESOLVED (no markers left)** → the single quality gate, in order: the checks
   gate (§7.1) and its `--not-my-bug` adjudication (§7.2), then the report-attempt
   (§8.2), then the cold read (§7.5). This is the ONLY stage that runs checks or a
   cold read, and it runs for ALL THREE tiers — judged and held included.

Deterministic checks run before the gate: the worktree tree is snapshotted, the
empty/uncommitted check runs, and the scope guard (§7.4) is evaluated — a
violation does NOT demote here; `scopeExceeded` is carried forward to the cold
read.

A REISSUE is always forced to HELD whatever tier is claimed (§5.3). A GATE FIX is
re-derived from the driver's own journal row rather than the conflict path
(§9.5).

### 6.5 `report-pr` (judged and held only; mechanical has no PR)

PR AUTHORING ONLY: no cold read, no checks, no tests, no network. The single
quality gate already ran at `report-case`, and re-reading here would be a second
`claude -p` over content that was already judged. Every check on the text is
MECHANICAL (§10.5).

The text is `pr/body.md` in the case dir, whose FIRST line is the H1 title
(`# <title>`); everything below is the body. A `pr/title.txt` + `pr/body.md` pair
is also accepted, and the resolved values are normalized back to both files so the
finish-time publish reads them unchanged.

On pass, by tier — RECORD PR INTENT, PUBLISH NOTHING (§10.1):

- `judged` — merge the resolution in place on the branch, then record the PR
  intent. The history PR is created at `finish`, before the target push that
  auto-flips it to merged.
- `held` — record the held intent. Active-vs-draft is decided by whether a
  MARKER-CLEAN resolution exists (§8.1). Escalated holds prepend their
  `[AUTO-ESCALATED: …]` prefix and the reviewer feedback to the description.
- **gate fix** — see §9.3.

Then the next case.

### 6.6 `abort`

`abort` rolls every branch with a journaled `pre-ref` back to its pre-pass tip,
newest pre-ref first, through the guard choke point (resetting a checked-out
worktree too), removes the case worktrees, journals `pass-aborted` with the
rolled-back branches, and seals the pass with `pass-complete` plus machine phase
`complete`. Sealing matters: "open" is defined as *has `plan-initial.json` and no
`pass-complete`*, so without the row an aborted pass would stay the latest open
pass and later commands would re-attach to it.

### 6.7 Crash resumption

Every command is idempotent and crash-resumable: a dead session resumes at the
exact phase, and a pass that crashes before `finish` has published nothing, so the
next `start` re-derives a clean origin picture and redoes the pass. A silent death
is impossible, because every report is journal-derived. All mutations go through
journaled subcommands; the journal (`journal.jsonl`) is append-only.

## 7. The quality gates

Four gates live at `report-case` (§6.4). They run in this order: checks →
(optional `--not-my-bug` adjudication) → report-attempt → cold read; the scope
guard is computed before them and consumed by the cold read.

A fifth, the LANDING GATE (§7.6), runs inside `run`, on the branch itself,
whenever a prefix lands on it. It is the SAME checks gate — same config, same
typecheck-then-test ordering — pointed at a branch tip instead of a case
worktree, because a merge propagates content whether or not a case was involved.

### 7.1 The checks gate

`checks.typecheck` THEN `checks.test`, run in the case worktree from the pass's
pinned `checks.json` (host + runner lists; a missing file or an empty list skips
that gate silently, a malformed file is `ERR43_CHECKS_MALFORMED`, §6.1).

A failure writes `<caseDir>/typecheck-output.txt` or `test-output.txt`, journals
`checks-fail`, and returns `ERR36_TYPECHECK_FAILED` / `ERR40_TESTS_FAILED` with
"read the output, fix the pending files, re-run report-case". The phase stays
`case-ready` and NO report-attempt is charged — a failed check is not a failed
attempt. All green journals `checks-pass`, which RESETS the counter.

At `CHECKS_FAIL_LIMIT` (10) consecutive failures the driver stops asking: it
resets the worktree to the PRISTINE conflict and freezes a HELD DRAFT tagged
`[AUTO-ESCALATED: checks failing]`, so a failing resolution is never published. A
failed reset is `ERR44_WORKTREE_RESET_FAILED`, never a "pristine" exhibit built
from a tree nobody reset. For a gate fix the same limit KEEPS the attempted fix
and freezes HELD ACTIVE instead (§9.3).

A re-run after a failure is NARROWED to the files that failed, through each
command's `filter` (`bun test {files}`) — for cost, and for nothing else. A
narrow run that is RED is the whole answer, since the check is failing either
way; a narrow run that is GREEN proves nothing about the files it dropped, so the
FULL list runs in the same `report-case` invocation and only its result can pass
the gate. A command with no `filter` (a project typecheck cannot be narrowed
without dropping its tsconfig) runs whole. `--not-my-bug` turns narrowing off for
that invocation: its adjudication measures this run against whole-suite probes,
and a subset on one side would decide the verdict by population instead of by
tree.

Every failure is FINGERPRINTED (`parseFailureFingerprints` in `attribute.ts`) and
the sorted set journaled on the `checks-fail` row — per failing test, its file +
name + the line IN THE TEST FILE + a class (`assertion`, `timeout`, `throw`,
`suite-error`), with numeric noise stripped so two timeouts of different
durations are one fingerprint while an assertion is never the same as a timeout;
per typecheck diagnostic, file + TS code + normalized message and NO line, since
that line points into the source being edited and moves with every edit. When the
last `DEAD_END_ATTEMPTS` (3) failures came from THREE DIFFERENT trees with an
identical, non-empty fingerprint set, the driver journals `checks-dead-end` and
appends one sentence to the ERR36/ERR40 payload naming what has not moved. It is
EVIDENCE, not a gate: no tier, no disposition, no change to `CHECKS_FAIL_LIMIT` —
the agent still decides what to do about it. An empty fingerprint set never
qualifies; output nobody could parse is proof of nothing.

Two classifiers sit on the failure path even without `--not-my-bug`:

- **Non-determinism** — checks that pass after a previous `checks-fail` on the
  same case and kind are immediately re-run to confirm; a flip is journaled
  `checks-nondeterministic` and surfaced as `WARN21_CHECKS_FLAKY`.
- **Environment faults** — the same classifier as §7.2, so a broken toolchain is
  reported as `WARN14_ENVIRONMENT_FAULT` rather than handed back as a code defect.

### 7.2 `--not-my-bug` adjudication

`--not-my-bug` is the escape hatch for a checks failure the case did not cause.
It is ADDITIONAL to `--tier`, never instead of it: the tier classifies the
agent's EDIT, the flag classifies the DRIVER'S TEST REPORT, and they are
independent axes — a confirmed claim leaves the tier claim standing. It is
honoured only once the same case has at least two `checks-fail` rows since its
last `checks-pass` (before the gate has answered, a claim is premature and is
journaled `not-my-bug-premature`), and gate-fix cases and reissues never
adjudicate at all. The claim decides nothing by itself: the driver adjudicates it
(`not-my-bug.ts`).

- **Baseline = the CLEAN PREFIX commit** — the case worktree's own HEAD, the
  whole merge minus the resolution. It holds the merge constant, removes only the
  agent's edits, and is already on disk with dependencies linked.
- **Failures IN the conflicted paths are dropped first**, never adjudicated. The
  prefix holds each conflicted path at the branch's PRE-MERGE blob (or omits it,
  when the path was added on theirs) against an otherwise merged tree — the very
  incompatibility the conflict is about — so it is red there for reasons unrelated
  to whether the resolution is right: a genuine regression would be "confirmed"
  pre-existing, and a path added on theirs could never fail there, guaranteeing a
  false refuse. Those files are the agent's own edit scope anyway. If nothing
  survives the drop, the claim is refused with zero probes.
- **Subset, not "it reproduces".** Confirmation needs the resolved tree's failures
  COVERED BY the baseline's, counted PER FILE (`countFailingFiles` in
  `attribute.ts`, compared by `uncovered`) — otherwise a file that already fails
  once absorbs a newly introduced second failure and a real regression ships
  inside someone else's red. Repeated observations are combined by a per-file
  MAXIMUM, not a sum, so a second look cannot inflate coverage.
- **The comparison runs the failing commands WHOLE**, with the worktree's own
  installed dependencies. Comparing a full-suite count against a narrowed re-run
  compares two different populations, and the difference alone would decide the
  verdict — a load-dependent failure reproduces only under whole-suite load and
  passes in isolation, so a narrowed baseline would call the very failure this
  exists for `flaky`. Only the FAILING commands are re-run. Narrowing
  (`VerifyCommand.filter`) belongs to the bisect (§7.3).
- **Confirm on one observation, never refuse on one.** A red baseline cannot have
  been broken by edits that tree does not contain, so one red confirms. The
  damaging error is the false REFUSE, so every refusing observation is re-run —
  a second baseline probe over the still-uncovered files, then a re-run of the
  resolved tree itself.

Verdicts: `pre-existing` → the ownership probe below; `caused-by-case` (still
uncovered after both baseline probes and still failing on the worktree re-run) →
`ERR36`/`ERR40` as usual, but naming WHICH failures are the agent's; `flaky` (the
same files fail nowhere on the re-run) → HELD with the resolution KEPT,
`[AUTO-ESCALATED: check unstable]`, the one arm that exits 0; `undecidable` →
say so and stop (no failing files parsed, a tree that will not build on any probe,
or the toolchain backstop below).

**Ownership.** The prefix proves the failure is not the agent's; it cannot say
whose, because it is a synthetic commit no branch points at. So the driver probes
the branch's PRE-MERGE TIP (the prefix's only parent), then the PARENT HEAD.
Branch red → the BRANCH owns those files. Branch green + parent red → the PARENT
owns them, else the same red is fixed once per descendant. BOTH green → an
INTERACTION owned by this merge. A probe that will not build on either side yields
`unknown`; a file absent from a tree counts as green there without a probe.

**A verdict describes a SUBSET, so the failing set is PARTITIONED**
(`partitionOwners`). Each probe round reports which of the files it was asked
about fail at the side it names; the remainder is re-asked until every file sits
in an owner group `{owner, ref, files}` or in a NAMED `interaction`/`unknown`
remainder. Reading one verdict as the whole story has only two outcomes and both
are wrong: the other owners' files are folded into the named owner's case — that
owner is handed a defect it did not introduce and cannot judge — or they are
dropped and the build stays red with nothing minted for them. TERMINATION IS
STRUCTURAL: a branch/parent verdict always carries a non-empty subset so the set
strictly shrinks, and `interaction`/`unknown` consume whatever is left. A SINGLE
owner therefore costs exactly ONE round — its verdict covers the whole set — so
the ordinary failure pays nothing for this. Same-owner re-hits MERGE into one
group; two groups on one ref would become two competing gate fixes on one branch
for one defect.

**One gate fix per proven owner**, each scoped by its own proven subset (`ownedFiles`,
§9.1), rooted by its own bisect, with its own rebase and duplicate notes. Owners are
ordered SHALLOWEST FIRST (parent before branch) in the journal, the mints and the
result, because `next-case` serves in DAG order and the result must name the case the
next command will hand over.

**The remainder is reported, never folded.** With owners present, an
`interaction`/`unknown` remainder cannot be scope-widened — the case it would widen
is being aborted — so it is journaled (`not-my-bug-owner` with that kind, plus
`not-my-bug-partition`), carried in the result as `uncovered`, and named in the
instruction as files NOT COVERED BY ANY GATE FIX. With NO owner found at all, the
whole set is the remainder and the two non-gate-fix answers apply as before:
`unknown` falls through to the ordinary checks failure, and `interaction` WIDENS the
case's edit scope to the failing files (journaled `scope-widened`, read back by the
scope guard, exempted from its `conflict-hunks` marker check since a widened file has
none, and carried into the COLD-READ REQUEST so the reviewer judges the extra edits
as the fix rather than as a scope violation) — the one sanctioned "let the agent edit
non-conflicted files and let the cold read accept it", surfaced as
`WARN12_SCOPE_WIDENED`.

**Toolchain backstop.** Identical failures on both trees are the NORMAL shape of a
confirmed pre-existing defect, so identity alone proves nothing. The backstop
fires when the runner reported literally ZERO passing tests and the comparison
distinguished nothing (the baseline never failed strictly more than the resolved
tree anywhere): that is a broken toolchain, not one defect, and the verdict is
`undecidable`. A run that printed no pass count at all (a clean typecheck) does
not trigger it. It sits behind the shape classifier, for the shapes nobody has
enumerated.

**Environment faults are not code defects.** Both trees share one dependency
setup, so a broken environment reproduces on both and the verdict would be a
correct "not caused by your resolution" about a failure no code change can fix.
The failing output is therefore classified: resolution-shaped diagnostics —
missing native binding, unresolvable module, missing binary, Node ABI mismatch,
bad ELF header, `dlopen` failure, missing shared library — with NO test assertion
anywhere ⇒ `WARN14_ENVIRONMENT_FAULT`, no gate fix, stop and report. The TS
resolution codes TS2307/2688/5012/6053/2318 count as environment evidence; any
other `error TS…` vetoes, since a blanket veto would make the classifier dead
code for the whole typecheck kind. An unresolved specifier that is RELATIVE
(`./x`) also vetoes — that is the agent's own defect, not the environment. The
classification overrides every verdict, including `caused-by-case`.

**Dependencies** are installed INTO each worktree from the manifests that worktree
carries, so the environment is a function of the tree under test — no shared cache
to poison, no key to invalidate, no fallback. A tree whose dependencies will not
install has NO valid environment and yields no verdict at all; on the branch
pre-check that surfaces as `WARN13_DEPS_UNUSABLE`, which matters most for a GREEN
(a branch check pass is memoised for the whole pass and would skip a branch's only
typecheck), and inside the adjudication it degrades to `undecidable`.

Between probes the temp worktree is `reset --hard` + `clean -fdx` (excluding the
dependency links, which are removed and reinstalled), so untracked build output
from one probe cannot decide the next.

Every stage emits `SWEEP-STEP:` progress and journals (`not-my-bug`,
`not-my-bug-owner` — one row per owner group AND one for the remainder —
`not-my-bug-partition` with the round and probe counts, `not-my-bug-bisect` with the
probe log, plus `not-my-bug-environment`, `not-my-bug-premature`,
`not-my-bug-discarded`, `scope-widened`, `gate-fix-root-clamped`). The result carries
a `notMyBug` block (with `owners`), `gateFixes` (every minted case, each with its own
`introducedBy`/`rebaseNote`/`duplicates`) and `uncovered` when there is a remainder;
`gateFix` and the top-level `introducedBy`/`rebaseNote`/`duplicates` describe the
FIRST case, which is the one `next-case` serves first. The proceed arm carries
`WARN09_GATE_FIX_SERVED` — never an `ERR` id.

### 7.3 The bisect

Before minting a branch/parent gate fix the driver searches for the commit that
introduced the failure, so the briefing names a commit instead of a log.

- **Determinism at the tip first**: a coin flip converges on a random commit and
  reads as an answer, so the tip must fail twice; if the NARROWED command stops
  reproducing, the search re-probes with the FULL failing command and uses it for
  the whole search (a load-dependent failure exists only under whole-suite load,
  which is exactly the class this serves), and only then calls it unstable.
- **Exponential walk-back** for a green anchor (there is none recorded: the branch
  check only typechecks, and a previous pass's verify is wiped by `start`), then
  binary search, under a hard probe budget (24).
- A commit that is UNBUILDABLE — or whose checks failed without naming a file — is
  SKIPPED, never read as green (a test command pointed at nothing exits non-zero
  saying "no test files found").
- A commit that PREDATES the failing file is the opposite: absence is proof, so it
  is a green BOUNDARY, which is what lets the search name the commit that ADDED a
  failing test.
- **The bisect never gates the case.** Whether a gate fix is warranted was settled
  by the verdict and the ownership probe; naming the commit only improves the
  briefing. Every outcome mints the case, with the status in the text.
- **The SEARCH is floored at the current trunk head** — bounded rather than having
  its answer clamped, so no probe is spent on a commit whose answer would be
  refused. Below that line history is shared and already integrated: a fix rooted
  there drags every intervening divergence with it, and its worktree is an old tree
  whose WHOLE suite the checks gate would demand green — unwinnable when files
  outside the case are red there. For a gate fix ON the trunk the window is empty,
  so it roots at the tip and names no commit. A root that does not contain the
  trunk head is clamped back to the branch tip and journaled
  `gate-fix-root-clamped`.
- When no introducer can be named, the case roots at the **last failed point** —
  the oldest commit the search OBSERVED red — so the fix lands as deep as the
  evidence supports and branches sharing that ancestor can take one fix instead of
  one each. That root is journaled on the driver's own `gate-fix` row;
  re-verification reads it from there and never from the agent-writable case file,
  or the scope guard would see every commit up to the tip as an agent edit.
- A fix rooted below the tip carries `[ROOTED AT <sha>: n commits behind the
  <branch> tip — REBASE before merging]`, and says plainly when the point is an
  observation rather than a proven cause.

### 7.4 The scope guard

On report-case the driver computes `git diff --name-only <automerge-tree>
<resolved-tree>` and enforces the configured mode (`scope-guard.ts`):

- **`same-files`** (default): the resolution may touch only the RECOMPUTED
  conflicted files; edits anywhere inside those files pass, because hunk-level
  review belongs to the cold reader. Any extra file is a violation.
- **`conflict-hunks`** (strict, opt-in): additionally, within each conflicted file
  the changed line regions must lie inside the automerge blob's conflict-marker
  spans (inclusive of the marker lines — resolving deletes them). A pure insertion
  counts as inside only when both boundary lines are marker lines.

The lever is the global `scope_guard_mode` in `registry/routing.yaml` with a
per-entry `scope_guard` override; like the tier floor, the effective mode is
RE-DERIVED from config at report-case, never read from the case file. Paths the
driver itself widened (§7.2) are allowed at file level and exempt from the hunk
check — a widened file has no markers, so every edit in it would otherwise read as
a hunk violation and the widening would be inert.

The widening is the ONLY path extension the driver computes. A resolution that
unions parameters or fields and must therefore touch call sites outside the
conflicted files trips the guard like any other extra file, and is carried to the
cold read as scope-exceeded (below).

A violation does NOT demote to HELD before the cold read. `scopeExceeded` is
carried forward, the cold read judges the RESOLUTION, and confirm + scope-exceeded
becomes HELD publishing that resolution as an ACTIVE PR tagged
`[AUTO-ESCALATED: scope exceeded]` (the owner merges; never auto-merged). Scope OK
+ confirm → the claimed tier; a reject follows the two-strike path (§7.5).

For a GATE FIX the guard measures BLAST RADIUS rather than legality: the file a
compiler names is often not the file that must change, so a fix confined to the
failing files may land in place (`judged`) and one that reaches further is
legitimate but goes to the owner (`held`). The feedback wording says so, because
that text is fed to the cold read and calling a correct gate fix a "violation"
primes a reject.

### 7.5 The cold read

The driver writes `coldread-request.md` at case emission and REGENERATES it on
every report-case attempt, adding the resolution diff (`git diff <automerge-tree>
<resolved-tree>`) recomputed for THIS resolution: conflict hunks + resolution diff
+ driver-derived context (§6.3) + the questions, and nothing else, so the resolving
agent cannot frame the question. The read runs as a synchronous `claude -p`
subprocess (injectable invoker) spawned by the driver; the reader prints a JSON
verdict on stdout and the driver records `coldread-verdict.json`. The agent never
writes or edits either file. The reader is context-free by construction (§2.4).

The read is FOCUSED: a preamble instructs the reader to judge ONLY from the
materials in the request — never to explore the repo — and to answer
`UNVERIFIABLE-FROM-REQUEST` for a point it cannot judge rather than researching
it. The three questions: (1) within the conflicted hunks, is each side's behavior
preserved or its loss explicitly justified (name anything silently lost); (2) is
every change in the resolution diff explained by the conflict — no content from
outside the two sides/base (name any unexplained hunk); (3) does the resolution
contradict any record included in this request? Typecheck and tests are the checks
and verify gates' job (§7.1, §10.2), never the reader's. Gate-fix cases get their
own question set.

The verdict must VALIDATE: overall `verdict` ∈ {`confirm`, `reject`}, non-empty
`notes`, optional per-question `answers`, and optional 1-2-line `feedback` for the
resolving agent (surfaced on a reject; reused as the PR-description prefix on a
HELD escalation). Fail-closed: an `UNVERIFIABLE-FROM-REQUEST` answer on ANY
question is treated as a reject even under an overall `confirm`. A confirming
verdict's content is journaled on the `resolved` entry for the audit trail.

- **Infra failure is never a content decision.** A read that could not RUN (spawn
  error, non-zero exit, unparseable stdout, or a recognizable auth/login failure)
  is retried on a backoff (auth auto-refreshes into the credentials file) and then
  hard-halts as `ERR35_COLDREAD_UNAVAILABLE`: the case is neither rejected nor
  frozen, and the command is re-runnable once the tooling is restored.
- **Rejections are COUNTED per case.** The 1st reject does NOT freeze — the
  reviewer's short feedback is returned for a revise-and-retry. The 2nd
  (`COLDREAD_REJECT_LIMIT`) stops the retrying and passes the case HELD with
  `[AUTO-ESCALATED: cold read rejected 2x]` plus the feedback prepended to the PR
  description. The cold reader never sees PR prose — there is none yet — so every
  reject is a resolution reject.
- **Outcome routing.** Confirm + in scope, by tier: `mechanical` → merge in place
  → "merged, take next case"; `judged` → "provide PR description" (the merge
  itself lands at `report-pr`); `held` → freeze HELD ACTIVE → "provide PR
  description". Confirm + scope exceeded → HELD ACTIVE (§7.4).

### 7.6 The landing gate

CONTENT THAT PROPAGATES ARRIVES GREEN, OR IT DOES NOT ARRIVE. `run` measures a
branch's tip immediately after its parent loop, before the branch is marked
arrived and before anything below it is derived, because from that moment on the
tip is what every descendant takes and what `finish` pushes to origin.

No other gate can speak for that content. `report-case` measures a CASE's tree,
the `start` probe measures a PROPOSAL, and the integration verify EXCLUDES every
branch with a block above it (§10.2 step 1) — so without this gate a branch that
merges cleanly hands its content to its children with no check anywhere in the
pass, and a CUT branch, pushed at its cut point, ships a prefix to origin that
nothing measured. `pushedUnbuilt` names it; naming is not measuring.

The gate is `checks.typecheck` THEN `checks.test` from the pass's pinned checks
file, run in a temp worktree at the branch tip with dependencies installed from
THAT tree's manifests (§7.2) — one notion of green in this driver, not two. A
missing or empty checks file skips it, exactly as every other gate skips.

**A RED landing is a fix-shaped problem, so it takes the fix-shaped answer.** The
branch and its transitive descendants are REOPENED — which supersedes the
branch's own undispositioned case, since a conflict case on a red tree is
unjudgeable, and the descendants' cases for the same reason — and then a gate-fix
case is minted on the branch (§9), rooted there because that is the branch now
carrying the defect. Reopen strictly BEFORE the mint, or the mint supersedes
itself. `run` then STOPS: the branch does not arrive, so the next run re-derives
it, and no other branch merges while a red is outstanding — the branches below it
would be taking the content this gate just refused, and the pass cannot complete
until the fix lands in any case. The result carries `WARN09_GATE_FIX_SERVED` and
`gated`, and `next-case` serves the fix on the same call.

**What it does not run, and why each is safe.**

- The tree did not MOVE — the forced empty merges of a leaf un-skip (§4.5), or a
  branch that gated with no clean prefix. Nothing arrived, so nothing propagates
  that was not already there, and content inherited from before the pass is
  finish's integration verify to judge (§10.2).
- The TREE was already measured green this pass, on any branch. A checks run is a
  function of the tree it runs on — dependencies included, since they install
  from that tree's own manifests — so a second run answers the same question at
  full price.
- No environment: a tree whose dependencies will not install, or a command that
  never spawned, yields NO verdict (`WARN13_DEPS_UNUSABLE` /
  `WARN14_ENVIRONMENT_FAULT`). An unmeasured tree is never read as green, and it
  is journaled rather than passed over in silence.

**The evidence is the journal.** Every landing writes one `landing-check` row —
`branch`, `sha`, `tree`, and either the verdict (`ok`, plus `phase` and `failed`
on a red) or why no run was owed (`ran: false` with `reason`, or `ok` copied with
`measuredOn` naming the branch the tree was measured on). So "did this branch
arrive green, and on which tree" is a JOURNAL READ: the question of whether a red
is inherited from a parent is answered by comparing rows, with nothing re-probed
and no parent head examined.

## 8. Tiers and enforcement

### 8.1 The ladder

| Tier | Trigger | Action | Review | PR |
|---|---|---|---|---|
| CLEAN | no textual conflict (merge-tree) | bulk direct merge | none | none |
| MECHANICAL | conflict the agent may resolve, resolved | direct merge | cold-read confirm required | none — journal + cold-read artifact only |
| JUDGED | non-obvious conflict, agent-resolved | merge; the same commit pushed to the target auto-marks the PR merged | cold-read confirm required | yes (history) |
| HELD | unresolved / cold-read reject ×2 / scope-guard trip / red verify gate / non-convergence cap / checks limit / reissue / escalation | clean prefix merges first; PR head = the resolved merge commit if marker-clean, else the pristine conflict | **owner** — the only review state | ACTIVE PR (marker-clean resolution, owner merges) or DRAFT PR (pristine conflict), real diff |
| DEFERRED | own conflict at height ≥ MIN(blocked direct parents' heights) (§5.2) | clean prefix committed; STOP — no merge above, NO PR | none | none |

- CLEAN vs conflict is COMPUTED (merge-tree). MECHANICAL vs JUDGED is
  agent-CLAIMED and the driver is DEMOTE-ONLY: it never promotes a claim.
- **Floors** raise the minimum severity: `edition/*` branches and entries flagged
  `tier_floor: judged` never merge below JUDGED, and gate fixes floor at JUDGED
  (§9.3). Edition JUDGED auto-merges by intent; owner-gating happens only by
  escalation to HELD.
- HELD is the ONLY review state: anything review-worthy at any tier is ESCALATED
  to HELD and inherits ALL HELD rules. The driver NEVER auto-merges a HELD PR —
  auto-merge stays JUDGED.
- **HELD publish is UNIFIED on one key**: does a MARKER-CLEAN resolution exist?
  Marker-clean (the agent actually resolved) → an ACTIVE (non-draft) PR at the
  resolved merge commit, which the owner reviews and merges. Markers remain, or
  `--tier held` with no valid resolution → a DRAFT PR built from the PRISTINE
  conflict (clean-prefix commit + the original upstream-vs-ours automerge tree,
  ZERO agent edits), so the owner resolves fresh rather than from an invalid
  attempt.
- A red verify gate demotes any already-executed tier to HELD(gate) with rollback
  to the journaled pre-ref (§10.2). Textual cleanliness ≠ correctness; demotion is
  a first-class transition, not an exception path.
- A CLEAN merge whose merged range passes THROUGH a height at which a transitive
  ancestor is HELD is ANNOTATE-class: flagged in the pass report, never gated.
  Gating — an unresolved conflict, or a red verify on a publishable branch — blocks
  the affected branch only.
- Sensitive surfaces (credentials, egress/firewall, container spawn, host-rpc
  auth) carry security invariants on their inventory entries; a sensitive path
  alone floors the claim at JUDGED rather than forcing HELD. Which conflicts
  qualify at all is doctrine, not driver policy.

### 8.2 Escalations and anti-thrash caps

Escalation prefixes are prepended to the PR description, with the reviewer
feedback when there is one: `[AUTO-ESCALATED: scope exceeded]`,
`[AUTO-ESCALATED: cold read rejected 2x]`,
`[AUTO-ESCALATED: resolution did not converge]`,
`[AUTO-ESCALATED: checks failing]`, `[AUTO-ESCALATED: check unstable]`.

The report-attempt is recorded AFTER the checks gate, so `RESOLVE_COLDREAD_CAP`
counts only trees that actually reached the reviewer. A resolution whose tree keeps
CHANGING beyond that cap is force-HELD ACTIVE with the non-convergence prefix —
the driver never loops.

### 8.3 Noise minimization

- No-op merges are skipped and journaled (§4.5).
- One case at a time per branch (halt at the first conflict run); one branch's case
  never blocks siblings, only descendants.
- The same conflict is resolved once at the topmost affected branch; descendants
  inherit it through the parent merge plus the shared rerere cache
  (`rerere.enabled` is set repo-wide in the agent clone, idempotently, before the
  pass's first mutation).
- A JUDGED PR is closed by pushing the SAME merge commit — no merge-of-merge
  commits.
- A blocked branch is skipped every pass and stays silent apart from one urge per
  NEW pending head (§5.5).
- MECHANICAL produces no PR at all.

### 8.4 Overlap awareness

New upstream content feeds OVERLAP AWARENESS, which is a
report to the owner and never an inline gate in the case loop. The agentic layer
spawns overlap-check subagents from `registry/prompts/overlap-check.md` with the
matched inventory entries' context, falling back to `catch-all-triage.md` when
nothing matches. Findings split three ways: an overlap with an implemented or
planned fork feature is a HIGH-PRIORITY owner report carrying a
dedup/retire/adopt decision; an independent new feature, skill or improvement is a
normal awareness line; anything else is one line in the pass digest.

## 9. Gate-fix cases — a red build is a case, not a merge

A red build whose failing files can be blamed on a branch becomes a GATE-FIX CASE
served on that branch: a worktree AT THE BLAMED BRANCH'S TIP (or at the bisect's
root, §7.3), no merge, nothing pending, no conflict markers, the failing build as
materials. The case's `parent` is the sentinel `(gate-fix)`, its conflicted-path
set is the failing files, and its height is derived like any other.

Four things mint one: finish's integration verify (§10.2), a `--not-my-bug`
adjudication (§7.2), the pre-merge branch check (§6.2), and the landing gate
(§7.6). The last two are rooted on the branch that is RED rather than blamed from
a build log — there is nothing to blame, the branch itself is the answer.

### 9.1 Blame is git history, not the registry

Which branch a fix belongs on is decided by AUTHORSHIP ON THE FIRST-PARENT LINE:

    authored(branch, file) =
      git rev-list --count --first-parent --no-merges <branch> ^main -- <file>

over every branch in the hierarchy, the trunk included, with `^main` — upstream,
never ours to fix — as the one exclusion for all of them.

- Registry path declarations (`owned_paths` / `touch_paths`) say where a feature
  INTENDS to live. Several entries can declare a failing file without any of them
  having modified it, while the branch carrying the defect declares nothing. They
  drive routing and validation; they never decide blame.
- A set difference (`^<parents>`) cannot identify authorship: the moment a commit
  is merged up or down it enters the other set and the answer inverts. A
  propagation merge records the RECEIVING branch as first parent and the donated
  branch as second, so `--first-parent` walks a branch's OWN authoring line and
  steps over everything it absorbed; `--no-merges` drops the integration commits,
  which are not edits to the file but the act of accepting someone else's edit.
- **Shallowest by hierarchy depth wins** (§3.6), so the fix lands closest to the
  root and propagates instead of being applied on N leaves. NO candidate → the
  trunk `main_patched`. A genuine TIE at the shallowest depth REFUSES, naming the
  tied branches, instead of being broken by spelling — the fix for that is the
  missing inventory edge, not a tiebreak here. A branch whose ref (or `main`) does
  not resolve is SKIPPED, never counted with the exclusion silently dropped.
- Failing files are GROUPED PER ATTRIBUTED BRANCH — one case each, shallowest
  first, because a judged trunk fix plus its reopen can moot a descendant's case
  before it is worked.
- **A PROVEN subset overrides the re-parse.** Blame reads the RAW failing log,
  which names every file the run complained about. Where the caller has already
  PROVED which of them fail at a specific owner's ref — the `--not-my-bug`
  ownership probe — it passes that subset (`ownedFiles`) and the case is scoped to
  it. Blame still runs (its candidates and reason are the record), but its file
  list does not decide the scope. Without this the case carries files the probe
  showed the owner does NOT own, plus paths the adjudication already excluded as
  the agent's own work: the agent is handed a case whose scope its owner never
  touched, and the checks gate demands all of it green. Callers with no probe —
  the finish-path blame — have nothing proven and keep the parsed list.

### 9.2 Cut-point exceptions

`scripts/sweep/cut-point-exceptions.yaml` carries owner-approved facts about this
fork's git history that topology cannot express, keyed branch → kind → list:

- **`duplicate`** — a rebase/cherry-pick COPY of another branch's commit
  (`sha`, `patch_id`, `twin`, `authored_on`, `why`). Excluding the authoring branch
  does not remove the copy: it sits on this branch's own first-parent line, so
  every count that reads that line credits the wrong branch. Patch identity is not
  an edge, so no topological rule can see it. Applied entries remove those SHAs
  from the branch's authored count.
- **`absorbed`** — a branch its parent has already merged down, remainder empty
  (`into`, `as_of`, `why`). Parsed, re-verified and reported; it has NO driver
  consumer by design, because nothing in the driver asks the question it would
  answer.

Nothing is trusted forever: every entry is a claim ABOUT GIT, and git moves. Each
is RE-VERIFIED before use — duplicates by recomputing both patch-ids (`patch-id
--stable`) and checking them against each other and against the recorded prefix,
absorbed by re-asking whether `as_of` still contains the branch. A falsified entry
is DROPPED with a `WARN08_CUT_POINT_EXCEPTION_STALE` warning, because a stale
exception silently suppressing a real answer is the whole hazard of hand-written
exception lists. An entry whose refs simply do not resolve in this repo is
not-applicable and stays quiet — it suppresses nothing. An unknown KIND is
reported and skipped, so an older driver does not choke on a file a newer one
wrote. A structurally malformed file is LOUD (`ERR45_CUT_POINTS_MALFORMED`) and
stops the blame it feeds; an ABSENT file skips in silence.

### 9.3 Tiers and commit shapes

The floor is JUDGED — new code is never MECHANICAL — so every gate fix takes a
cold read, and the scope guard is forced to `same-files` regardless of config
(`conflict-hunks` bounds edits by marker spans and a gate-fix tree has no
markers, so every gate fix would be scope-flagged).

- **`judged`** → a SINGLE-PARENT commit on the branch (not a propagation merge; a
  second parent would fabricate a self-merge) whose message is the agent's PR
  title/body, plus a `reopen` of every descendant so the fix is pulled through the
  DAG — which is what lets a trunk-rooted fix salvage the pass instead of forcing
  a restart. NO judged history PR and no pr-intent is recorded (`prIntent: false`):
  that PR exists only to be auto-flipped by the target push landing the SAME merge
  commit, machinery specific to a propagation merge, so claiming one would promise
  a PR that is never created. The commit IS the record and reaches origin with the
  ordinary target push.
- **`held`** → a `fix/sweep/<slug(branch)>--<caseId>` ref plus an ACTIVE PR at a
  likewise SINGLE-PARENT commit, created at `finish` like every other PR, which
  BLOCKS the next sweep until the owner merges it (§5.4). There is no
  pristine-conflict DRAFT fallback — a gate fix has no conflict exhibit to build
  one from. At `CHECKS_FAIL_LIMIT` the attempted fix is KEPT and frozen HELD
  ACTIVE (`[AUTO-ESCALATED: checks failing]`), never reset: a failing fix the owner
  can read beats an empty exhibit.

**Red base.** `start` never judges the build (§6.1). A red base produces one
gate-fix case ROOTED ON THE BASE ANCHOR carrying every failing file — a commit on
a descendant can never turn the base green.

**Mint boundary.** A gate fix is never created on upstream `main`: the sweep
cannot commit there and a fix rooted there reaches nobody. It is enforced at
`materializeGateFixCases`, the ONE place a case is created, per blame group — a
mixed blame set still mints for the non-upstream branches. It is a REFUSAL, not
silence: "upstream is red at ⟨sha⟩ for ⟨files⟩" is journaled `gate-fix-refused`
and reported (`WARN15_UPSTREAM_RED`), because the fork is about to merge a broken
upstream commit.

### 9.4 Anti-loop and duplicates

- One attempt per (branch, file-set) per pass: `gateFixKey` is `branch::files`. A
  second red over the same set is not re-served and falls through to the stop path.
- Across passes the anti-loop is the fix's own PR (§5.4).
- Two more mint refusals: a branch gated by an active gate-fix ref whose digest
  does NOT match the current failing files (`WARN19_GATE_COVERS_OTHER_DEFECT` —
  merging that fix will not turn this branch green and a second fix will be
  needed), and a branch descending from an ancestor that took a gate fix this pass
  and is still red (`WARN20_ANCESTOR_GATED`; the not-my-bug path is exempt when
  the branch is itself the located owner). Both refusals journal
  `gate-fix-skipped` in ONE shape: `owner` (the branch the defect belongs to —
  itself, for the `WARN19` self-gate, where the open fix on that same branch may
  or may not cover these files), `skipped` (the branch no case was minted on) and
  `skippedFiles` (the mint that did not happen). The row carries the
  only filenames in the vicinity, so it must never name the skipped branch in a
  field a reader takes for the owner — `branch` is deliberately absent, and the
  detail leads with the owner.
- **Cross-branch duplicates.** An unstable failure surfaces wherever luck puts it,
  so one defect can earn a gate fix on several branches. The case-id digest covers
  the FAILING FILES ONLY — branch+files would make cross-branch duplicates
  invisible by construction — so the same defect wears the same digest everywhere
  and open fix refs on origin can be matched on sight. Both cases are still minted
  (separate histories each need the fix), with `[POSSIBLE DUPLICATE: …]` injected
  into the gate output, the result and the instruction so the owner merges one and
  rebases or drops the rest. `gateFixKey` stays branch-scoped: two concerns, two
  keys.

### 9.5 The abort/reopen protocol and re-verification

When a `--not-my-bug` adjudication routes to a gate fix, the case being worked is
ABORTED: a `reopened` row over `[branch, ...descendants]` — the SAME scope every
other blocking path uses, widened to the UNION of every proven owner's whole subtree
when ownership routed to the parent. The case's merge was never made (it exists only as the clean
prefix), so the reopen supersedes the undispositioned case, the machine returns to
`open`, and `next-case` serves the gate fix. DESCENDANTS ARE INCLUDED because a
branch just proven RED is blocked and their open cases were derived against it:
the red commit is in the very content they are merging, so they cannot pass. Left
open they would be served one by one, each failing the same checks, each paying a
full adjudication, each hitting the anti-loop and falling back to held — junk HELD
PRs for one defect. Superseding them means the gate fix is the only case left, so
no service-priority rule is needed.

**ALL reopens are journaled BEFORE ALL gate-fix mints.** When an owner is a branch
a fix was already minted on, the reverse order supersedes that fix the instant it is
created and the pass loops through a full re-adjudication every round instead of
serving it. With several owners this is one reopen over the union, then the mints.
The agent's resolution is DISCARDED and the loss journaled (`not-my-bug-discarded`,
plus an observation): the reopen rebuilds the worktree from the automerge tree and
nothing else references the resolved tree (the driver commits by plumbing, so rerere
never recorded it). No local ref is written to hold it — a local ref never leaves
this clone, so it is not a delivery channel, and the only thing that carries work out
of a pass is a PR. The doctrine tells the agent the same thing.

**Re-verification** of a gate fix cannot go through the conflict path — there is
no conflict to re-derive, so every gate fix would die `ERR02_CASE_STALE` and the
agent would loop serve → reject → serve. The case is re-derived from the driver's
OWN `gate-fix` journal row plus the registry: branch, files, failing commands and
root from the row; scope and descendants from the registry; head and height from
git — never from the agent-writable `case.json`. Fixed properties, none of them
defaults: `tierFloor: judged`, scope guard `same-files`, and the branch tip's tree
standing in as "the tree the agent started from" for the empty check, the scope
guard and the cold-read diff. An UNCHANGED tree is `ERR32_UNRESOLVED` on ANY
claim, `held` included ("nothing was fixed") — the pristine-conflict branch would
otherwise describe an exhibit that never existed.

## 10. Publication and finish

### 10.1 The publish-timing rule

EVERY PR — JUDGED history and HELD (active or draft) alike — is created at
`finish`, AFTER the full-integration verify is green. `report-pr` publishes
NOTHING; it records the publish intent (tier, resolved commit, active-vs-draft,
escalation prefix, reviewer feedback) into the journal, and `finish` creates all
PRs from that.

CLEAN / MECHANICAL / JUDGED-closure land code on a target branch, so they need the
verify gate; a HELD PR lands nothing itself, but creating it at `finish` keeps it
on the verified tip and off origin when a pass crashes mid-way. A pass that
crashes before `finish` has published nothing.

### 10.2 `finish`, step by step

`finish` is the only stage that lands code on a target branch and the only stage
that publishes anything, because the full-integration verify is the only gate that
catches semantically-broken-but-clean cross-branch merges, and it cannot run until
all cases are resolved. It refuses while cases are open or the phase is
`awaiting-pr` (`ERR34_CASES_REMAIN`), and after a judged gate fix it says WHY: the
fix advanced its branch, so descendants were reopened to pull it through — expected,
not a driver bug. Run `next-case`, work them, `finish` again; the same pass still
completes.

0. **Base gate check.** If the verify base itself carries an open gate-fix ref,
   verify is SKIPPED, the held cases are published anyway, and `finish` stops with
   `WARN18_BASE_GATED` — nothing can land until the owner merges that PR.
1. **Verify what can be integration-built.** The recipe is DERIVED from the pass
   by ONE rule — **nothing blocked at or above it** — over the plan's DAG order.
   Whether a branch happened to merge something in the last few minutes says
   nothing about whether its content integrates, so an un-advanced branch is
   verified like any other; a branch with something blocked above it is not,
   because its window is cut there and a sibling carrying content ABOVE that cut
   re-creates, inside the rebuild, the very conflict the cut represents — the
   branch is then named the offender and rolled back for a conflict that is
   pending propagation, not integration breakage. Structural, not policy: two
   branches at different cut points do not merge into one tree. Blocked: a
   proposal that PREDATES the pass, a branch UNDER REPAIR and everything beneath
   it, a case still OPEN, and a branch THIS PASS cut. A recipe branch with no
   local ref is dropped loudly rather than aborting the gate.

   **The recipe is not the push set.** "Can this be integration-built" and "did
   the pass produce something legitimate here" are different questions, and
   coupling them is a defect. A branch merged to its cut point holds a complete,
   consistent prefix, and its held PR is opened against origin's copy of that
   prefix — so it is pushed even though it cannot be built. Withholding it
   diverges the branch from its own PR base and repeats the work every pass until
   the owner acts. A PARTIAL build is a valid pass, not a degraded one; what makes
   it valid is that the result says what it covered and what it left out. Content
   pushed at a cut point was in no integration build, and that is reported per
   branch with its reason (§10.7) — never prevented by withholding the push.
   The rebuild base is the fork trunk `main_patched`, not bare `main`:
   merging a fork branch onto `main` recreates the fork-content conflicts it was
   merged past, and `main_patched ⊇ main`, so upstream-chain branches still
   integrate cleanly in this throwaway target. The workspace `rr-cache` is seeded
   into `.git/rr-cache` before the rebuild so resolutions recorded this pass replay
   instead of reappearing as false offenders. The gate runs `checks.typecheck` THEN
   `checks.test` from the pass's pinned checks file — the TYPECHECK runs FIRST
   because typecheck output is what makes blame possible (tests alone surface a
   type error indirectly or not at all, leaving the verify log without compiler
   diagnostics) and it is the cheap check besides. An unparseable checks file halts
   here (`ERR43_CHECKS_MALFORMED`) rather than emptying the list and publishing on
   a verify that ran nothing — this is the last gate before anything reaches
   origin.

   Red outcomes are distinct:
   - **Attributable red** — leave-one-out attribution (§10.6) names a publishable
     branch: it is rolled back to its journaled `pre-ref` and demoted HELD(gate),
     the held cases are published, and `finish` halts with `ERR18_VERIFY_PENDING`,
     machine state staying at `finishing`/`verify` so it is resumable.
   - **Merge conflict in the rebuild** — a recipe branch would not merge, so the
     build stops there and NO command runs. Directly attributable, and handled by
     the same rollback+HELD(gate) path, but its evidence is different in kind:
     the red row carries `failureKind: "merge-conflict"` with `conflictBranch`,
     `unresolved` (the conflicted paths) and `merged` (what got in ahead of it),
     and NONE of the test-shaped fields — a base probe that never ran and an empty
     failing-command list are not evidence, and journaling them writes an
     accusation whose every field is blank. The POST-ROLLBACK row is the
     re-verify's verdict, not the rollback's, so it says `rolledBackFor` instead
     (a `failureKind` there would label a green row `merge-conflict`) and carries
     `reverifyFailedCommands` when the remaining set is still red. `finish`
     reports the conflict in its own words and carries `failureKind`, `unresolved`
     and `reverify` in the result: a rollback that leaves a SECOND, unrelated red
     behind is reported as both, because re-running `finish` clears only the
     conflict.
   - **Unattributable red** — the failing files are blamed by git history (§9.1)
     and served as gate-fix case(s): `status: "gate-fix-required"`,
     `stoppedAt: "verify"`, `WARN09_GATE_FIX_SERVED`, with `gateFix` (the first
     case) and `gateFixes` (all of them), and the pass returns to phase `open` for
     `next-case`.
   - **Red with named failing tests and nothing servable** — no blameable branch,
     no parseable diagnostics, or these exact files were already attempted:
     `status: "stopped"`, `stoppedAt: "finish-tests"`, `ERR40_TESTS_FAILED`. No
     target is pushed. The held cases ARE still published on this path, so the work
     in hand reaches the owner rather than dying in the pass dir.
   - **Every blamed branch already gated** — `status: "stopped"`,
     `stoppedAt: "verify"`, with the gated branches named and no ERR id.
   - **Non-deterministic verify** — `WARN17_VERIFY_FLAKY`: nothing attributed,
     nothing rolled back.
   - A build-conflict or leave-one-out offender with no this-pass `pre-ref` is a
     NON-BLOCKING gate observation: journaled and surfaced, the publishable set
     proceeds, and the gate re-verifies without it. There is nothing to roll it
     back to and no merge of ours to blame it for. The blocking rollback+freeze
     path fires ONLY for a branch that would be pushed this pass.
2. **Create the JUDGED history PRs** (non-draft), before the target push. JUDGED
   GATE FIXES ARE EXCLUDED: selection is by disposition, and a gate fix's
   disposition is `resolved`/`judged` like any other, so without the exclusion
   `finish` would try to build a history PR for a single-parent commit with no
   conflict head and halt.
3. **Push the target branches** (CLEAN / MECHANICAL / prefix merges) + the JUDGED
   closure pushes (the same merge commit, which flips those PRs to merged) +
   closure checks + urge comments on frozen branches with new pending heads
   (§5.5).
4. **Create the HELD PRs** — active (marker-clean resolution, owner merges) or
   draft (pristine conflict, owner resolves) — from the recorded intent, AFTER the
   target pushes so the bases are current, the HELD diff is the case run only, and
   the base-height check holds for every held PR. A held case whose signature
   matches an already-published PR is journaled `held-duplicate` and skipped rather
   than wedging the stage.
5. **The journal-derived owner report** (which PRs need the owner, or the
   done-line).
6. **The upstream check**: has upstream advanced past the pinned watermark →
   "start again" or "done".

### 10.3 Push resilience

THE PUSH SET IS WHAT THE DRIVER MUTATED THIS PASS, in plan order — every branch
it merged or resolved on, whether or not the build covered it (§10.2 step 1).
Blockedness never withholds a push: a branch merged to its cut point holds a
complete prefix, and its held PR is opened against ORIGIN's copy of that prefix,
so withholding it would base the PR on a commit the branch no longer sits on
(ERR14) and repeat the work every pass. What no integration build covered is
REPORTED — `coverage` and `pushedUnbuilt` (§10.7) — never held back, and never
unmeasured either: it passed the landing gate (§7.6) when it landed. The gate on
pushing is a green verify for the pass (§9), not membership of the recipe.
A branch that has no local ref by push time is journaled `push-withheld` and
named in the result rather than dropped in silence.

Step 3 pushes each target branch INDEPENDENTLY — one push per branch, clean prefix
and judged merge commits together. Already-up-to-date or origin-ahead branches are
skipped (higher is fine, someone else committed). A failure is CATEGORIZED
(`rejected` — a hook or branch protection, checked first — / `diverged` /
`auth` / `transient`) and journaled per branch, and the remaining branches
proceed. `ERR15_PUSH_FAILED` at `finish` is a PER-BRANCH LABEL, NOT a hard stop; a
failed held publish is likewise per-case and non-fatal. `diverged` and `rejected`
additionally raise a `push-escalated` row surfaced as `needsOwner`. Only a GLOBAL
failure with no per-branch rows (red verify, missing token, closure check) halts
`finish`.

When every push failed `transient` and nothing landed at all, the held-publish
phase is skipped as a systemic outage rather than opening PRs against an
unreachable origin.

A partial finish is NOT sealed — machine state stays `finishing` — so re-running
`finish` retries exactly the failed pushes and publishes: landed branches skip as
up-to-date, verify re-gates, and pushes and PR-creates never redo.

### 10.4 PR heads and the base-height check

PR heads are REAL commits pushed by the driver, never synthetic constructions and
never API ref fabrication:

- **HELD** — the fix/sweep ref is pushed at the case run's TOP commit verbatim
  (§4.4). Held PRs are created AFTER the pass's target pushes, so the origin base
  already carries the clean prefix and the diff is the run's real changes only, with
  no pending-range bloat. A pristine-conflict draft head is ONE commit — the
  automerge tree parented on the branch tip and the conflict head — because the
  driver-shape walk (§5.6) needs `parents[0]` to BE the base tip to tell whether
  anyone else has pushed to the ref. The PR's diff against its base is that tree
  however many commits carry it. The clean-prefix commit belongs to the case
  WORKTREE, where it is what makes `git status` show exactly the conflict.
- **JUDGED** — the fix/sweep ref is pushed at the REAL merge commit and the
  non-draft PR is created BEFORE the target push; the target push then lands the
  same commit on the base and GitHub auto-marks the PR merged — history preserved,
  zero merge-of-merge noise, no dependence on the merge button.

The **pre-PR base-height check** (`ERR14_BASE_BEHIND`) blocks a publish whose
origin base is missing, behind the expected pass height, or diverged; higher is
fine. For HELD the local tip must be contained in origin; for JUDGED origin must
not have diverged and must NOT already contain the merge commit (that would mean
the target push ran first). Together with the push order this is the guarantee —
there are no per-diff assertions.

One exception is explicit: at a RED finish the held rule's premise is void by
construction (the tests failed, so nothing was pushed, so origin is necessarily
behind). The escalation then satisfies what the rule protects by transplanting the
resolution onto origin's actual tip; when that transplant conflicts it cannot, and
the case ships as a DRAFT with the fat diff plus `WARN16_ESCALATION_BASE_BEHIND`.
Two more publish-time degradations ship the pristine draft instead of the
resolution: a recorded resolution tree missing from the object store
(`WARN06_RESOLUTION_TREE_MISSING`) and a branch tip that moved so the frozen
resolution no longer re-merges cleanly (`WARN07_RESOLUTION_TIP_MOVED`).

Naming: resolution/freeze refs are
`fix/sweep/<slug(branch)>--<slug(parent)>-h<height>-<sha8>`; gate-fix refs are
`fix/sweep/<slug(branch)>--<gate-fix case id>`. Case ids are
`<slug(branch)>--<slug(parent)>-h<height>` — the parent slug is essential, because
two parents of one branch conflicting at the same height are distinct cases, and
with branch+height alone the second would trip the double-resolve guard and
deadlock.

If a publish crashed between creating the PR and journaling it, an open PR found
by head with no journal row is adopted as this case's PR rather than erroring.

### 10.5 PR text — mechanical checks only

The driver NEVER generates PR prose. It writes facts (§6.3) and a per-case
`pr/TEMPLATE.md`; the agent writes the text. The checks on that text are
MECHANICAL only:

- `ERR08_TEXT_MISSING` — title or body absent or empty.
- `WARN01_TEMPLATE_TEXT` (advisory) — the body references none of the conflicted
  files, or contains a stock driver-template phrase, or carries markers of a
  FOREIGN template (upstream's contribution guide for new skills, which describes
  neither a merge resolution nor a gate fix and is the most template-shaped file in
  the clone).
- `WARN02_NO_DECISION_LINE` (advisory) — the first body line states no ask or
  decision.
- `ERR06_DUPLICATE_CASE` — the adequacy gate.

No reader loop enforces the writing rules; they are doctrine. The resolution cold
read (§7.5) is the one and only cold read.

### 10.6 Leave-one-out attribution

The verify stage maps a red matrix to the offending branch by re-building the
recipe with one branch removed at a time, in reverse recipe order — deterministic
and unit-testable, at the cost of extra rebuilds. Reds that survive attribution
become gate-fix cases (§9) or stop the pass.

### 10.7 The `SWEEP-RESULT`

`finish` emits one `SWEEP-RESULT` carrying the pass summary: `ok`, `status`
(`complete` | `partial`), `next`, `upstreamAdvanced`, `branches` (per-branch landed
vs failed), `failedPushes` / `failedPublishes`, and on a partial result
`needsOwner`, `blockingIssues`, and the systemic-outage fields.

`ownerPullRequests` lists every OWNER-shaped PR that no longer merges or no
longer passes (§5.6), drafted by us or not, every pass — the one-time draft
conversion is a courtesy, this list is the notification.

`droppedProposals` lists every proposal the pass DELETED (§5.6) — branch, PR
number, url and what made it inapplicable, plus `deleteFailed` when the ref
survived and the PR is therefore still open. Deleting closes the pull request
and discards the resolution on it, and the next `start` wipes the journal that
recorded it, so this list is the only account of it there will ever be. It is
carried by EVERY exit from `finish`, not only the completing one.

`undecidedProposals` lists every proposal whose merged-tree checks could not be
judged — the probe disagreed with itself on the same tree, or the command never
ran — with the branch, PR number, url, the id (`WARN17_VERIFY_FLAKY` /
`WARN14_ENVIRONMENT_FAULT`) and the detail. Nothing was deleted for these; what
needs the owner is the unstable check.

`coverage` says what the integration build actually covered: `built` (the recipe)
and `excluded`, one entry per branch with the reason it was left out — cut this
pass, blocked before it, under repair, or carrying an open case. A partial build
is a valid pass, so `ok` stays true; what the owner must not have to infer is
WHICH branches shipped without one. `pushedUnbuilt` names the branches whose
merges landed on origin while sitting outside the build — every branch pushed at
a cut point is in it, and an empty list is the ordinary case worth stating.

`withheldPushes` names branches whose merges were NOT pushed, with the reason. A
pass that merges locally and ships nothing must say so in the result; reporting
it in a log line only is how a stalled estate looks like a healthy one.

`pullRequests` lists every PR the pass touched — each with number, url, title, live
status, a landed/failureCategory annotation, and a `kind` of
`review-open-at-start`, `reopened`, `recovered-publish`, `approved-landing`,
`owner-acted-mid-pass`, `judged-history`, `held-review` or
`held-review-reissued`. Rows are deduped by number and refreshed best-effort.

`stats` carries `branchesInScope`, `cleanMerges`, `resolvedMechanical`,
`resolvedJudged`, `approvedLanded`, `held`, `deferredBranches`,
`prsCreatedJudged`, `prsCreatedHeld`, `prsReissued`, `prsReopened`,
`prsRecovered`, `prsOpenAtStart`, `targetsLanded`, `targetsFailed`,
`failedByCategory` (`diverged` / `transient` / `auth` / `rejected`),
`heldPublishFailures`, `upstreamAdvanced` and `watermark12`.

The `instruction` tells the agent to report landed-vs-conflicted branches, the PR
list and the stats to the owner.

## 11. Result ids by emitter

`doctrine/RESULT-CODES.md` owns what the AGENT does about each id; it is not
restated here. This section is the driver-side registry: which stage emits an id
and under what condition. `ERR*` blocks the command, `WARN*` never does.

The six commands are the only entry points; the internal stages named below
(`plan`, `run`, `verify`, `publish`, `push`, `report`) run inside them (§1) and
their output is suppressed for internal calls, so several ids never reach a
`SWEEP-RESULT` line and live in the journal and on stderr instead. Two paths
deliberately re-surface them: the push stage's blocking ids are journaled as
`push-issue` rows and re-emitted by `finish` as `blockingIssues`, and a held
escalation's publish issues are written to `publish-<case>.json` and quoted into a
`publish-failed` journal row.

| id | emitted by | condition |
|---|---|---|
| `ERR01_CASE_NOT_OPEN` | publish, `report-pr` | the case has no open disposition to publish against — never journaled, resolved at another tier, or `report-pr` run outside phase `awaiting-pr` |
| `ERR02_CASE_STALE` | `report-case`, `report-pr`, publish | re-verification failed: branch ref gone, the held head is already an ancestor of the tip, the conflict re-probes clean, the path set drifted, the judged merge left the branch, or the case worktree is missing |
| `ERR06_DUPLICATE_CASE` | `report-case`, publish | another non-superseded case with the same conflict signature (same path set + head sha, identical conflict blobs, or a subset with matching shared blobs) is published, held-and-topmost, or undispositioned-and-topmost |
| `ERR07_PR_EXISTS` | publish | a `pr-published` journal row already exists for this case |
| `ERR08_TEXT_MISSING` | `report-pr`, publish | `pr/body.md` has no resolvable H1 title + body (or the legacy `pr/title.txt`/`pr/body.md` pair is empty) |
| `ERR11_TOKEN_MISSING` | `start`, publish, push | networked work is due and neither `GH_TOKEN` nor `GITHUB_TOKEN` (nor `--token-file`) is present; at `start`, only when unmerged `fix/sweep/*` refs exist |
| `ERR12_ORIGIN_UNRESOLVED` | `start`, publish, push | owner/repo cannot be derived from the origin remote URL |
| `ERR13_API_FAILED` | `start`, publish, push | a GitHub API call failed (non-2xx or transport error) with a status other than 401/403 |
| `ERR41_TOKEN_REJECTED` | `start`, publish, push | the same call answered 401/403; the detail names the token's SOURCE, never the token |
| `ERR14_BASE_BEHIND` | publish | pre-PR height check: no `origin/<branch>`, origin diverged, held mode with origin behind the local tip (outside a red-finish escalation), or judged mode where origin already contains the merge commit |
| `ERR15_PUSH_FAILED` | publish (hard), push (per-branch) | `git push` failed — for the fix/sweep PR head it stops that publish; for a target branch it is a per-branch label and the loop continues (§10.3) |
| `ERR16_CLOSURE_FAILED` | push | a JUDGED PR did not flip to merged after its target push, or the closure lookup threw |
| `ERR17_URGE_FAILED` | push | posting the urge comment / refreshing the machine block threw; the last-urged head is NOT advanced |
| `ERR18_VERIFY_PENDING` | push, `finish` | no green `verify` journal entry after the pass's last mutation; or finish's verify was red and the offender was rolled back to HELD(gate) |
| `ERR20_BRANCH_DIVERGED` | run | a branch (or a push target) has diverged from origin — that branch is skipped, siblings continue |
| `ERR21_MERGE_FAILED` | run | a merge write threw after the execution re-probe; that branch halts, siblings continue |
| `ERR22_DIRTY_WORKTREE` | run, and any command via the halt reporter | the branch is checked out in a worktree with uncommitted changes and the driver refuses to move its ref |
| `ERR23_PROTECTED_REF` | run, and any command via the halt reporter | the ref-write choke point refused a protected or out-of-scope ref |
| `ERR24_PLAN_DRIFT` | run | the live re-derivation differs from the last written plan for a not-yet-processed branch |
| `ERR25_BAD_CASE_ID` | publish | a case identifier does not match the generated shape |
| `ERR30_PASS_OPEN` | `start` | a pass at the canonical dir (or the latest attachable pass) is not `complete` |
| `ERR31_AWAITING_PR` | `next-case` | the current case still needs `report-pr` (stderr label; the result carries `status: "awaiting-pr"`) |
| `ERR32_UNRESOLVED` | `report-case` | conflict markers still present, or nothing changed at all, while the claim is not `held` — and, for a gate fix, an unchanged tree on ANY claim |
| `ERR34_CASES_REMAIN` | `finish` | open cases remain, or the phase is `awaiting-pr` |
| `ERR35_COLDREAD_UNAVAILABLE` | `report-case` | the cold read could not RUN after its retries (spawn error, non-zero exit, unparseable stdout, auth failure) |
| `ERR36_TYPECHECK_FAILED` | `report-case` | the checks gate's typecheck list failed in the case worktree, below the fail limit, not classified as an environment fault |
| `ERR40_TESTS_FAILED` | `report-case`, `finish` | the same for the test list; at `finish`, a red verify with named failing tests and no servable gate fix |
| `ERR37_WORKSPACE_IN_CLONE` | `start` | `--workspace` resolves to `--repo`'s toplevel or a subdirectory of it |
| `ERR38_PASS_CLEAR_FAILED` | `start` | the prior pass directory could not be removed |
| `ERR39_FETCH_FAILED` | `start` | `git fetch` of origin/upstream (or the `fix/sweep/*` prune refspec) failed |
| `ERR43_CHECKS_MALFORMED` | `start`, `report-case`, `finish` | the checks file exists but does not parse (absent is a deliberate, silent skip) |
| `ERR48_CASE_LOOPING` | `next-case` | the case has been served more than `CASE_SERVE_LIMIT` (4) times with no conclusion; the next serve is refused |
| `ERR44_WORKTREE_RESET_FAILED` | `report-case` | the reset to the pristine conflict failed, before a held-pristine freeze or a checks-limit freeze |
| `ERR47_ENVIRONMENT_UNUSABLE` | `run` (halt), `start`, gate-fix minting, `report-case` | dependencies would not install from committed, valid manifests; no case is served or judged in a tree with no environment |
| `ERR45_CUT_POINTS_MALFORMED` | gate-fix minting (`next-case`, `report-case`, `finish`) | the cut-point exceptions file exists but cannot be read or parsed; the detail travels on the `WARN09` result |
| `WARN01_TEMPLATE_TEXT` | `report-pr`, publish | the body names no conflicted file, or carries a stock-template or foreign-template phrase |
| `WARN02_NO_DECISION_LINE` | `report-pr`, publish | the first body line carries no ask or decision |
| `WARN03_MANY_PRS` | publish | at least 8 PRs already published this pass |
| `WARN06_RESOLUTION_TREE_MISSING` | publish | the recorded marker-clean resolution tree is gone from the object store; the pristine draft ships instead |
| `WARN07_RESOLUTION_TIP_MOVED` | publish | the branch tip moved and the frozen resolution no longer re-merges cleanly; the pristine draft ships instead |
| `WARN08_CUT_POINT_EXCEPTION_STALE` | gate-fix minting | an owner-approved exception the repo now contradicts; journaled, never applied |
| `WARN09_GATE_FIX_SERVED` | `report-case`, `run`, `finish` | gate-fix cases were materialized — or none could be served because every candidate was already gated or attempted; from `run` it is a branch that landed a red prefix (§7.6) |
| `WARN11_PRE_MERGE_CHECK_SKIPPED` | `next-case` | a checks file was configured but unreadable, or its typecheck list is empty, so branches merged unverified |
| `WARN12_SCOPE_WIDENED` | `report-case` | the `--not-my-bug` ownership probe returned `interaction`; the edit scope now includes the failing files |
| `WARN13_DEPS_UNUSABLE` | `next-case`, `run` | a branch's dependencies would not install, so it could not be checked or blamed; at `run` a landing is left unmeasured rather than assumed green (§7.6) |
| `WARN14_ENVIRONMENT_FAULT` | `report-case`, `start`, `run` | the failing output classifies as an environment fault, on the adjudication path or the ordinary checks path — or a proposal's checks command never ran, so its ref is left alone; at `run` a landing gate command that never spawned leaves the tree unmeasured, never red (§7.6) |
| `WARN15_UPSTREAM_RED` | gate-fix minting | blame landed on upstream `main`; the mint is refused (journal + stderr) |
| `WARN16_ESCALATION_BASE_BEHIND` | publish | a red-finish held escalation could not be transplanted onto origin's tip, so a wider-diff draft ships |
| `WARN17_VERIFY_FLAKY` | verify, `start` | a command failed and then passed on the same tree: in verify nothing is blamed or rolled back; on a proposal's checks nothing is deleted |
| `WARN18_BASE_GATED` | `finish` | the verify base carries an open gate-fix ref; verify is skipped and nothing can land |
| `WARN19_GATE_COVERS_OTHER_DEFECT` | gate-fix minting | an active gate ref on the branch has a different failing-file digest |
| `WARN20_ANCESTOR_GATED` | gate-fix minting | the branch descends from an ancestor that took a gate fix this pass and is still red |
| `WARN21_CHECKS_FLAKY` | `report-case` | a check passed after a prior failure on the same case and kind, then failed again on the confirming re-run |
| `WARN46_CASE_LOOPING` | `next-case` | the serve count reached the warning threshold (3); emitted as the LOOP WARNING section of the case materials, not as an issue |

**Reserved numbers — never reassign**: ERR03, ERR04, ERR09, ERR10, ERR19, ERR26,
ERR42, WARN04, WARN05. `ERR44` is a live collision: `ERR48_CASE_LOOPING`
(`next-case`) and `ERR44_WORKTREE_RESET_FAILED` (`report-case`) share the number
and are distinguishable only by suffix.

## 12. Files, artifacts and conventions

### 12.1 Module layout

Flat modules in `scripts/sweep/`, with colocated `*.test.ts` siblings picked up by
the vitest scripts glob.

| module | purpose |
|---|---|
| `sweep-machine.ts` | the six-command agent-facing CLI |
| `propagate.ts` | the six commands' implementations + the internal plan/run/publish/push/verify/report stages, journal, worktree and PR-materials preparation, pass pushes, the case gate |
| `heights.ts` | watermark pinning, chain enumeration, height↔sha, coverage derivation (§2.2) |
| `interval.ts` | eligible-line construction (§4.2) + the linear merge-point sweep and case stacking (§4.3, §4.4) |
| `plan.ts` | DAG validation, breadth-wise plan derivation, no-op/skip + leaf un-skip logic (§4.1, §4.5) |
| `tiers.ts` | tier types, floors, the legal demotions (§8.1) |
| `deferred.ts` | the DEFERRED height-MIN rule (§5.2) |
| `scope.ts` | scope partition, DAG ordering, the edition-composition closure (§3.3, §3.4) |
| `hierarchy.ts` | THE branch hierarchy: depth, minPath, inversion assert (§3.6) |
| `proposal.ts` | the driver-shape test + the open-proposal disposition table (§5.6) |
| `scope-guard.ts` | automerge-vs-resolved scope check (§7.4) |
| `conflict-identity.ts` | conflict identity: marker-hunk extraction, label normalization, the set relation (§5.6) |
| `steps.ts` | step/case JSON schemas + first-principles re-verification (§4.6) |
| `not-my-bug.ts` | the `--not-my-bug` adjudication, ownership probe and bisect (§7.2, §7.3) |
| `attribute.ts` | blame: failing-file parsing, per-file counts, branch candidates, attribution (§9.1) |
| `cut-points.ts` | owner-approved cut-point exceptions: parse, re-verify, report (§9.2) |
| `verify.ts` | the everything-rebuild + CI command runner with leave-one-out attribution (§10.2, §10.6) |
| `publish.ts` | PR creation/push mechanics, the base-height check, mechanical text checks, the machine block, review/comment classification, the injectable GitHub transport (REST, plus the GraphQL draft transitions REST cannot express) |
| `candidates.ts` | inventory-candidate discovery + inheritance derivation (§3.7) |
| `registry.ts` | inventory + routing/scope config loading (§3.1) |
| `validate.ts` | the inventory validator (§3.2) |
| `sweep.ts` | the `validate-registry` CLI |
| `merge.ts` | the shared rerere cache |
| `git.ts` | merge-tree, rev-list, ancestry, worktree and push helpers |
| `globs.ts`, `config.ts`, `types.ts`, `fixtures.ts` | glob matching, static defaults, shared types, fixture repos |

### 12.2 The pass directory

`<workspace>/propagation/pass-<watermark12>/`:

- `plan-initial.json` — the immutable opening snapshot (source of the watermark
  and fork point for every attaching command);
- `plan.json` — the working plan; `step-<branch>.json` — per-branch merge
  contracts;
- `<caseId>/` — `case.json` (a POINTER only), `materials.md`,
  `coldread-request.md`, `coldread-verdict.json`, `typecheck-output.txt` /
  `test-output.txt`, `gate-fix-output.txt`, `worktree/`, and `pr/` with
  `TEMPLATE.md`, `materials.md` and the agent's `body.md` (normalized alongside
  `title.txt`);
- `candidates.json` — the pass's derived candidates;
- `journal.jsonl` — append-only, the source of every report;
- machine state — phase, watermark, current case, and the pinned config paths.

The directory is disposable: `start` clean-slates it (§6.1).

### 12.3 Config and durable data

Committed with the code:

- `scripts/sweep/inventory/<id>.yaml` and the bootstrap snapshot under
  `scripts/sweep/bootstrap/` — the inventory (§3.1);
- `scripts/sweep/registry/routing.yaml` — the two global driver levers
  (`scope_guard_mode`, `stack_cap`);
- `scripts/sweep/registry/scope.yaml` — scope policy: `exclude` and
  `extra_edges`;
- `scripts/sweep/registry/schema/feature-entry.schema.json` and
  `registry/prompts/` (`overlap-check.md`, `catch-all-triage.md`);
- `scripts/sweep/checks.json` — the checks gate's typecheck/test command lists,
  each test command carrying a `filter` template (`{files}`) that makes narrowed
  re-probing affordable (§7.3);
- `scripts/sweep/cut-point-exceptions.yaml` — blame's history facts (§9.2). Its
  home is beside `checks.json`, not under `registry/`: it is DRIVER-read config
  that blame consumes, exactly as `checks.json` is driver-read config the checks
  gate consumes, while `registry/` holds the inventory's own judgment.

Group-owned, durable across passes: `<workspace>/rr-cache/`, the shared rerere
cache. The driver installs it into the clone's `.git/rr-cache` before merging and
into each case worktree's shared git dir, and new resolutions are recorded as
driver merges commit. This is why the workspace must sit outside the clone (§3.3).

The authoritative CI verification commands (`config.ts VERIFY_COMMANDS`):
`pnpm install --frozen-lockfile`;
`(cd container/agent-runner && bun install --frozen-lockfile)`;
`pnpm run format:check`; `pnpm exec tsc --noEmit`;
`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`;
`pnpm exec vitest run`; `(cd container/agent-runner && bun test)`.

### 12.4 Tooling conventions

- `tsx`, positional args plus a `Usage:` line, colocated tests. NO new
  dependencies.
- No durable mutable state (§2.1): everything is derived, committed config, or
  pass-dir artifacts.
- Execute is the DEFAULT on the agent surface; `--dry-run` computes without
  writing. A dry run performs NO state changes at all — no merges, no unfreezes,
  no urge artifacts, no journal entries, no ref writes, and the network transport
  is never constructed.
- `sweep.ts` has ONE subcommand, `validate-registry` (§3.2) — read-only, exit 1 on
  ALERTs. It exists for the inventory-regeneration skill, which runs it whenever an
  entry is added or regenerated.

## 13. Tests

- **Unit tests on synthetic fixture repos** (`fixtures.ts`) cover: the
  non-monotonic conflict window (conflict at k, clean at k+m — the sweep must merge
  past k); DEFERRED positive / path-disjoint negative / no-historical-tip;
  multi-parent barrier ordering including a HELD parent arriving with an empty
  interval; no-op skip and the leaf un-skip chain; scope-guard demotions; step
  re-verification rejecting a forged head/parent/height; watermark pinning (the
  chain is never re-read mid-pass); tier floors; idempotent re-run after partial
  execution.
- **The landing gate** (§7.6): a clean merge that lands green journals its
  branch, tree and verdict; a landing whose tree is red reaches no child and is
  journaled with the failing commands; an empty forced merge and a tree already
  measured this pass run nothing; and a cut branch's clean prefix is measured.
- **Remote branches and candidates**: fixtures fake `origin` via
  `refs/remotes/origin/*`, exercising all four sync states end to end
  (materialize / fast-forward / ahead-no-op / diverged-halt with siblings
  proceeding), the `materialize` plan flag, a dry run making zero ref writes, and
  candidate derivation (clear cut-from, merged-into descendant with
  `requiresEntryEdit`, ambiguous cut point with its open question, pre-fork branch
  with no fork-era ancestry), plus candidates being re-derived every pass and never
  appearing in the merge plan.
- **The test-case registry**: pinned-SHA propagation cases under
  `scripts/sweep/test-cases/propagation/cases/*.yaml`, exercised by
  `propagation-cases.test.ts` on a checkout-free replay model and mined from the
  fork + upstream DAG for each taxonomy class where a real instance exists. They
  double as regression anchors and as rerere seeds where a recorded resolution
  exists. Dated recon snapshots live beside them under `test-cases/fixtures/`.
- Every mutating stage is exercised against throwaway repos in the system temp
  directory; tests never mutate real branches, and the cold read and the GitHub
  transport are injected.
