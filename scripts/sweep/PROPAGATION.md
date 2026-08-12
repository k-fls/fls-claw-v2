# Mechanical propagation driver — specification

> **Agent surface:** the ONLY interface is the six-command SWEEP STATE
> MACHINE — `start` / `next-case` / `report-case --tier` / `report-pr` /
> `finish` / `abort` (`scripts/sweep/sweep-machine.ts`; spec
> `SWEEP-STATE-MACHINE.md`). The `plan`/`run`/`publish`/`push`/`verify`/`report`
> stages described below have NO standalone entry point: they are the driver's
> deterministic INTERNALS, run by the six commands (`start` → plan;
> `next-case` → run; `finish` → verify, publish, push, report). Where this spec
> says `resolve`, it names the driver's internal resolution gate, run by
> `report-case`. The cold read is a synchronous `claude -p` subprocess
> (injectable), run by the driver itself (§7). On any conflict of
> who-does-what, `SWEEP-STATE-MACHINE.md` wins for the command surface.

For case stacking, driver pushes and PR head shapes, MERGE-POLICY.md is
authoritative — on conflict, MERGE-POLICY.md wins. For propagation ordering,
merge execution, and case handling this spec governs (not DESIGN.md §5-6); the
inventory + verify machinery is shared (§10).

**Principle:** everything ordering-, scope-, and framing-critical is mechanical.
The agent's role is exactly one thing: resolving a conflict the driver hands it,
inside a driver-managed worktree, followed by re-running the driver. The driver
decides what merges where, in what order, from which commit, and whether the
agent's output is acceptable.

## 1. Tier ladder

Every parent→branch merge attempt lands in exactly one tier:

| Tier | Meaning | Handling |
|------|---------|----------|
| **CLEAN** | No textual conflict | Bulk-merged directly, no review |
| **MECHANICAL** | Conflict the agent is allowed to resolve (qualification: MERGE-POLICY.md §7); agent-resolved | Cold-read confirmed, merged directly, no PR |
| **JUDGED** | Non-obvious resolution, agent-resolved | NON-draft PR for the audit trail (head = the REAL merge commit), cold-read confirmed, auto-merged: the same merge commit pushed to the target flips the PR to merged |
| **HELD** | Unresolved / cold-read rejected / sophisticated | PR via `publish` at the case run's TOP commit (real diff = the run; active when the case carries a marker-clean resolution, draft for a pristine-conflict exhibit — §14.1), branch frozen for the owner |
| **DEFERRED** | Conflict *belongs to an ancestor* currently HELD | Branch frozen, **no PR**; auto-unfreezes when the ancestor's HELD clears |

Tier decisions and constraints:
- CLEAN vs conflict is computed by the driver (new-style `git merge-tree`).
- MECHANICAL vs JUDGED is claimed by the resolving agent but only ever **demoted** by
  the driver, never promoted: a scope-guard violation (§7) goes **HELD, no merge**;
  a cold-read rejection demotes to HELD.
- `edition/*` (and any inventory entry flagged `tier_floor: judged`) never merges below
  JUDGED.
- A red verification gate (§9) demotes any already-executed tier to HELD(gate) with
  rollback to the journaled pre-pass ref. Textual cleanliness ≠ correctness;
  demotion is a first-class transition, not an exception path.
- A CLEAN merge that passes *through* a commit some ancestor is HELD on is
  annotate-class: flagged in the pass report, never gated.

## 2. Pass model — watermark, heights, breadth-wise barrier

A **pass** is one driver run over the whole inventory DAG.

- **Inventory**: `scripts/sweep/inventory/*.yaml` — strict, owner-authored
  config tracked in the fork repo, loaded by default (`--inventory` exists for
  tests/fixtures). Required fields `id`/`name`/`kind`; `branch` is optional —
  present = the entry is swept, absent = planned/observational config. Legal
  driver levers include `tier_floor: 'judged'` (§1), `always_merge` (§6),
  `scope_guard` (§7), `stack_cap` (§3) and `prompt.extra_context` —
  owner-authored STANDING guidance, embedded path-matched into case materials
  and cold-read context; never a decision store (one-time adjudications belong
  on PRs and die with their refs). Unknown keys are entry errors, and `start`
  refuses an invalid inventory (`ERR46_INVENTORY_INVALID`, §8 start guards,
  §14.3).
- **Watermark**: at pass start the driver pins `upstream/main`'s tip. The pass targets
  this SHA everywhere; upstream advancing mid-pass is invisible until the next pass.
- **Heights**: the driver enumerates the trunk first-parent chain once
  (`git rev-list --first-parent --reverse`) from the fork point and
  assigns each commit an index. A *merge head* is the pair `{sha, height}`; all
  comparisons (barrier, DEFERRED matching, coverage) use height with the sha as an
  integrity check. Never compare by commit date or subject.
  For `main_patched` the chain is enumerated on `main` (which FF-mirrors upstream);
  for parents-model branches "upstream coverage" is still measured against the same
  single trunk chain — content reaches them only through parents.
- **Coverage** (derived, never stored): a branch's covered height =
  the highest chain index whose commit is an ancestor of the branch tip. Ancestry along
  a first-parent chain IS monotonic, so this is binary-searchable with
  `git merge-base --is-ancestor` (O(log n) probes).
- **Order**: strict breadth-wise over the inventory DAG. A branch is processed only when
  ALL its inventory parents have been processed this pass — even a parent whose result
  is "skip" or "HELD with empty progress" counts as processed (arrival, possibly with an
  empty interval). `main` (FF) and `main_patched` are the only upstream entry points;
  every other branch merges only its inventory parents' tips; the driver
  validates the inventory is a DAG before every pass and halts on a cycle.
- **Earliest boundary is soft**: only a head's height is strict. `git merge <sha>`
  merges the sha's entire ancestry, so the interval's lower end is bookkeeping — a
  branch that skipped or froze in earlier passes simply catches up when it next merges.

## 3. Merge-point selection — linear sweep, not bisect

"Merging up to height k conflicts" is **not monotonic in k**: a later upstream commit
can rewrite a disputed region so the tip-level three-way merge is clean again — so
merge-point selection is a linear sweep, never a stop-point bisection (which would
embed the monotonicity assumption).

Per branch and per parent, over the parent's *eligible line* (§4):

1. Probe the full range first — one in-memory `merge-tree` against the parent's
   eligible tip. Clean → done (the common case; one probe total).
2. On conflict, sweep the eligible line **linearly** (one merge-tree probe per
   candidate head, oldest→newest), recording clean/conflicted per height.
3. Merge at the **largest clean height** — this may lie beyond intermediate conflicting
   heights (their content lands cleanly at tip level; desirable, fewer conflicts).
4. Report the case for the agent: it STARTS at the smallest conflicting height above
   the merge point and is STACKED into the **maximal run of consecutive
   conflicting heights whose conflicted path sets intersect** — one logical decision.
   The run breaks at a clean height, at a disjoint-path conflict (its own case later),
   and at the cap (`stack_cap`, default 5 — routing.yaml key; per-entry `stack_cap`
   override on the inventory entry, mirroring the scope-guard lever). The case's
   `head` is the run's TOP commit; `conflictedPaths`/`automergeTree` are computed at
   the top, so resolving the case resolves the whole run under ONE cold read:
   `{branch, parent, head: {sha, height}, run: [{sha, height}…], conflictedPaths,
   automergeTree, reproduction}`. DEFERRED windows and urge tracking are computed
   against the run's top. Never stack disjoint-path conflicts; never stack across a
   clean height.

Probes are milliseconds (checkout-free); upstream deltas are tens of commits — linear
cost is negligible and correctness beats O(log n).

**Probe determinism:** automerge-tree OIDs depend on the literal
merge-tree invocation — conflict-marker LINES embed the command-line labels verbatim
(branch name vs sha → different blob → different tree) and `merge.conflictStyle`
adds/removes the `|||||||` base section. Every driver probe therefore (a) passes
pinned SHAs, never ref names,
and (b) forces `-c merge.conflictStyle=merge`, making recorded automerge trees
reproducible across clones and user configs; the resolve-time drift halt then fires
only on genuine movement.

**Execution re-probe:** the per-parent probes above are all
computed against the branch tip AT DERIVATION TIME, but `run` merges a branch's
parents SEQUENTIALLY — once parent #1's merge advances the tip, parent #2's clean
verdict is stale, and its merge against the ADVANCED tip can conflict even though it
probed clean. `run` therefore re-probes every non-forced merge against the
branch's CURRENT tip (pinned SHAs, as above) immediately before executing it; on
staleness it re-derives that parent row live and demotes clean→case/skip as found:
conflicted → an ordinary case at that point (conflict set + automerge tree recomputed
from the current tip; the branch's remaining parent merges halt for this run and
continue via the §8 reopen machinery once the case resolves — siblings are
unaffected); tree-equal → a journaled no-op skip (§6). Forced (empty) merges are
exempt — they exist only when every parent no-op'd, so the tip cannot have moved.
`commitTreeMerge` stays as a backstop, but a failure there now halts THAT BRANCH
journaled (`halt`, reason `merge-failed`), never the process.

## 4. What is mergeable of a parent — eligible line

For entry-point branches (`main_patched`, edition-composition branches merging
`main`) the eligible line is the trunk first-parent chain up to the watermark — heads
are trunk commits.

For parents-model branches the eligible line is the **parent branch's own first-parent
history**: candidate heads are the parent's commits (its per-pass merge commits),
each carrying a derivable covered height. Merging "parent at height ≤ N" means merging
the newest parent commit whose covered height is < N (derived by ancestry probes, no
stored refs). If the parent advanced in one big merge and no such historical tip exists,
the child simply doesn't merge that parent this pass (relevant to DEFERRED, §5).

**Fork-only parent content:** a parent tip that carries new fork commits but no
upstream progress above the child's coverage still belongs on the eligible line — when
the height-filtered line would be empty but the parent tip is NOT an ancestor of the
child, the parent tip itself (at its derived height) is the single candidate head.
Otherwise a fork fix merged into a parent would not reach descendants until upstream
next advances (violating the parent-tip inheritance model, §2). The normal ladder,
no-op check, and DEFERRED rule apply to that head like any other.

**Source refs (§13):** a branch (or parent) that exists only as
`origin/<name>` is still in scope; every plan-time read — tips, coverage, eligible
lines, merge-tree probes — uses the origin commit (probes pass pinned SHAs anyway,
§3), and the plan row is flagged `materialize`. `plan` and dry-run `run` never write
refs; the local branch is created by `run --execute` before the branch's first
mutation (§8). A branch present in NEITHER place remains a loud scope-drift warning.

## 5. DEFERRED — conflicts that belong to an ancestor

When the sweep finds branch C's first conflicting run against parent Q, with run TOP
height N′ (the window is computed against the run's top), and the
pass registry records an ancestor P (any transitive inventory ancestor, not only a
direct parent) HELD at height N with conflicted path set S_P:

- **N lies in the conflicting window and C's conflicted paths intersect S_P →
  DEFERRED.** The conflicting window is `(floor, N′]` where `floor` is the largest
  clean height below the conflict on C's eligible line (or C's coverage when none) —
  i.e. the held commit's content is part of what this merge would newly introduce.
  Exact equality N′ == N is the special case where the eligible line has a head at N;
  parents-model lines are usually coarser (a parent that advanced in one merge has one
  head far above N), and the window rule is the faithful generalization: if the merge
  up to `floor` was clean, the disputed content arrived above `floor`, and an
  intersecting held height inside the window identifies the ancestor's conflict. C freezes; NO PR; the
  journal entry points at P's HELD record; C auto-unfreezes (re-enters the plan) when
  P's HELD clears. C still merges Q's clean prefix below N when a historical tip of Q
  with coverage < N exists (§4); otherwise it merges nothing from Q this pass.
- **N′ == N but paths disjoint → NOT deferred**: it is C's own independent conflict on
  that commit; normal MECHANICAL/JUDGED/HELD ladder.
- Rationale: the child carries the parent's delta, so a
  collision that gated P textually re-manifests at C — nothing is silent. If it does
  not re-manifest, the merge is genuinely clean for C, and P's eventual resolution
  flows down later as an ordinary delta. Convergence mechanism: next pass the barrier
  has C merge P (fresh resolution + shared rerere) *before* re-probing Q, so the
  deferred conflict typically auto-resolves.

**Cross-pass DEFERRED (origin-derived):** HELD outlives
the pass through ORIGIN — the open `fix/sweep/*` ref and its PR — not through any
local file. `start` re-derives the blocked set from those refs and journals
`origin-blocked` rows carrying the conflicting head sha; at plan/run/resolve the HELD
registry is the pass journal. The height is re-derived from that head against the
current pass's pinned chain — heights are pass-relative (the fork point moves as
branches absorb upstream) and are never carried numerically across passes.
Degradation is still possible and is deliberately in the safe direction: gate holds
(§9) carry no head/paths and cannot be matched, so a next-pass descendant of such a
hold gets an ORDINARY case instead of DEFERRED — extra review, never less.

## 6. No-op skips and the leaf must-merge rule

- A parent merge whose merge-tree result tree equals the branch's current tree is a
  **no-op**: the driver records `skip` in the journal and does not create a merge
  commit. Merge-base consequences are benign; the next real merge covers the gap.
- **Leaves and inventory entries flagged `always_merge: true` must land at least one
  real merge per pass** when the pass carries any upstream progress. If every parent
  chain above such a branch skipped as no-op, the driver **un-skips the cheapest parent
  chain**: the intermediate merges are no-ops by definition, so they cost one empty
  merge commit each but keep the invariant "every branch only ever merges its inventory
  parents" absolutely uniform. There is NO merge-main-directly exception for leaves;
  hierarchy has zero special cases.

## 7. Step contract and scope guard

The driver is the only author of merge parameters. Artifacts live under
`<workspace>/propagation/pass-<watermark12>/`:

- `plan.json` — the whole-pass plan: DAG order, per-branch per-parent heads
  `{sha, height}`, skip/merge/defer verdicts, leaf un-skip chains. Pure derivation from
  git state + inventory; regenerating it must be a no-op (idempotent, resumable).
- `step-<branch>.json` — the per-branch contract the merge executor accepts. The
  executor **re-verifies from first principles** (never trusts the file author):
  parent ∈ inventory parents (or `main` for edition-composition entry-point
  branches); head sha matches the
  claimed height and is on the parent's eligible line; height ≤ watermark; all parents
  arrived this pass (journal); skip claims re-computed via merge-tree; leaf rule
  honored. Verification failure = hard halt, journaled.
- `case-<branch>-<height>.json` + `case-.../automerge/` — a reported conflict: tier
  floor, conflicted paths, automerge tree (conflict markers), one-command reproduction,
  DEFERRED-check inputs. The agent resolves ONLY inside the driver-created worktree for
  that case, commits, and runs `report-case --tier mechanical|judged`.
- **Case re-verification at resolve (trust boundary):** everything under the workspace
  is agent-writable, so `case-*.json` is a POINTER, never an authority. At resolve the
  driver re-derives from git + registry everything it is about to act on: the head sha
  must lie on the named parent's eligible line for this pass; the automerge tree and
  conflicted-path set are RECOMPUTED via merge-tree against the branch's current tip
  (the recorded values are only cross-checked for drift reporting); the tier floor,
  the branch's kind/model/parents/ancestors AND the pass scope guarding the ref
  writes are all re-derived from the registry + scope config — never from
  `plan.json`, which is agent-writable and serves only as a drift cross-check (N2: a
  forged parent edge or a branch smuggled into the snapshot must not extend what
  resolve may merge or move); the case must correspond to an open `case` journal
  entry with no later `resolved`/`held` for the same id, and the branch tip must not
  already contain the head (double-resolve guard — a crash between ref-update and
  journal append must not allow a second merge). Any mismatch = hard halt, journaled.
- **Scope guard:** on
  resolve, the driver computes `git diff --name-only <automerge-tree> <resolved-tree>`
  and enforces the configured mode:
  - `same-files` (DEFAULT): the resolution may touch only the
    recomputed conflicted FILES; edits anywhere inside those files pass (hunk-level
    review belongs to the cold reader). Any extra file → **HELD, no merge** — a
    demotion to JUDGED would still land the out-of-scope content, defeating the
    guard.
  - `conflict-hunks` (strict, opt-in): additionally, within conflicted files the
    changed line regions must lie within the conflict-marker regions of the automerge
    tree; edits elsewhere in the file → HELD.
  The lever: global default `scope_guard_mode` in `registry/routing.yaml`; per-feature
  override `scope_guard:` on the inventory entry. Like the tier floor, the effective
  mode is RE-DERIVED from config at resolve — never read from the case file.
- **Cold read (focused, driver-run):** the driver writes `coldread-request.md`
  at case emission (conflict hunks from the automerge tree + the three bounded
  cold-reader questions) and REGENERATES it on every `report-case` attempt,
  adding the resolution diff (`git diff <automerge-tree> <resolved-tree>`)
  recomputed for THIS resolution — conflict hunks + resolution diff +
  driver-derived context + questions, nothing else, so the resolving agent
  cannot frame the question. The read runs as a synchronous `claude -p`
  subprocess (injectable invoker) spawned by the driver: the reader prints a
  JSON verdict on stdout and the driver records it as `coldread-verdict.json` —
  the agent never writes or edits either file. The read is FOCUSED: a preamble
  instructs the reader to **judge ONLY from the materials in this request** —
  never explore the repo or search beyond them — and to answer
  `UNVERIFIABLE-FROM-REQUEST` for a point it cannot judge from the request rather than
  researching it. The three questions: (1) within the conflicted hunks, is each side's
  behaviour preserved or its loss explicitly justified (name anything silently lost);
  (2) is every change in the resolution diff explained by the conflict — no content
  from outside the two sides/base (name any unexplained hunk); (3) does the resolution
  contradict any record included in this request? Typecheck and tests are the
  checks and verify gates' job (§9), never the reader's. A MECHANICAL or JUDGED
  completion requires a confirming verdict. The verdict must VALIDATE: overall
  `verdict` ∈ {`confirm`,`reject`}, non-empty `notes`, optional per-question
  `answers` (q1-q3), and optional 1-2-line `feedback` for the resolving agent
  (surfaced on a reject; reused as the PR-description prefix on a HELD
  escalation).
  **Infra failure is never a content decision:** a cold read that could not RUN
  (spawn error, non-zero exit, unparseable stdout, or a recognizable auth/login
  failure) is retried on a backoff (auth auto-refreshes into the credentials
  file), then hard-halts as `ERR35_COLDREAD_UNAVAILABLE` (§14.3) — the case is
  neither rejected nor frozen, and the command is re-runnable once the tooling
  is restored.
  **Bounded, never looping:** after `COLDREAD_REJECT_LIMIT` (2) content
  rejections of a case the driver stops retrying and escalates it HELD
  (published with the `[AUTO-ESCALATED: cold read rejected 2x]` prefix) — two
  rejections mean the owner should look, not the agent loop. Defense in depth:
  a resolution whose tree keeps CHANGING is force-HELD after
  `RESOLVE_COLDREAD_CAP` (2) distinct resolution trees (journaled
  `resolve-not-converged` / `ERR26_RESOLVE_NOT_CONVERGED`, owner review) — the
  driver never loops.
  **Fail-closed:** an
  `UNVERIFIABLE-FROM-REQUEST` answer on ANY of q1-q3 is treated as a reject even under
  an overall `confirm` — the reader could not judge that point and researching beyond
  the request is forbidden. A confirming verdict's content
  (verdict + notes) is journaled on the `resolved` entry for the audit trail.
  The reader is context-free by construction — the driver spawns it fresh with
  only the request; within a single trust domain the invoker could still stub
  the subprocess, so provenance ultimately rests on the invocation layer (§12).

After a JUDGED resolution or a HELD freeze the driver **prepares** the PR MATERIALS but
never PR prose: it writes `pr/materials.md` (conflicted paths, the case run, per-side
`git log --oneline` over those paths, reproduction command) into the case dir. The agent
studies the case and writes `pr/title.txt` + `pr/body.md` itself; the PR is then created
EXCLUSIVELY by the driver's `publish` stage (§14). PR heads are REAL
commits pushed by the driver via `git push` — never synthetic constructions, never API
ref fabrication:

- **HELD**: the fix/sweep ref is pushed at the case run's TOP commit verbatim (entry
  and parents models alike). HELD PRs are published AFTER the pass's
  target pushes (§14.4 order), so the origin base already carries the clean prefix
  and the PR's diff is the run's real changes (1..cap commits) only — no
  pending-range bloat. The pre-PR height check (`ERR14_BASE_BEHIND`) blocks a publish
  whose origin base is behind the expected pass height or diverged; together with the
  push order it is the guarantee (no per-diff assertions).
- **JUDGED**: the fix/sweep ref is pushed at the REAL merge commit and the NON-draft
  PR is created BEFORE the target push; the target push then lands the same commit on
  the base and GitHub auto-marks the PR merged — history preserved, zero
  merge-of-merge noise, no dependence on the merge button.

The DRIVER pushes; the agent never hand-pushes anything — driver-journaled
pass pushes are the only pushes. Refs move via `git push` ONLY; the API is used for
PR creation/comments (normal use), never to fabricate refs/commits as a push
workaround. A failing push (e.g. through the credential proxy) is a hard halt,
journaled, surfaced as `ERR15_PUSH_FAILED`, and REPORTED to the owner
— never retried blindly, never worked around.

## 8. Driver loop

The stages below are INTERNAL — none is invocable on its own; the bracketed command is
the state-machine command that runs it (SWEEP-STATE-MACHINE.md).

```
plan     [start]      # pin watermark, enumerate heights, derive coverage, emit plan.json
run      [next-case]  # execute plan: CLEAN merges + skips + DEFERRED marks; halt at first
                      #   case needing judgment per branch; emit case files; continue with
                      #   other branches (one branch's case never blocks siblings, only
                      #   descendants via the barrier)
verify   [finish]     # §9 gate: everything-rebuild + CI commands, leave-one-out attribution;
                      #   red -> roll back the offender + HELD(gate)
publish  [finish]     # §14: the ONLY PR-creation path — check battery, then
                      #   push the fix/sweep ref (git push) and create the PR via the
                      #   GitHub API (JUDGED non-draft, HELD active or draft — §14.1)
push     [finish]     # §14.4: verify-gated pass pushes — target branches
                      #   (flips JUDGED PRs to merged), closure checks, posted urges
report   [finish]     # journal-ONLY end-of-sweep summary (merged / resolved /
                      #   held / open-cases / pushed + escalations); no git, no GitHub, so
                      #   a dead/abnormally-terminated session still leaves a readable
                      #   status. The end-of-sweep owner message is a thin wrapper over it.
```

**Start guards:** `sweep start` refuses, and no pass opens, when its
preconditions fail — each surfaced as a §14.3 start-time refusal. The workspace
check runs first: `--workspace` must be the group root, never the `--repo` clone
or a subdirectory of it (`ERR37_WORKSPACE_IN_CLONE`). Right after it, and BEFORE
any fetch, one guard runs:

- **`ERR46_INVENTORY_INVALID`** — a missing or empty inventory, or any entry
  error (unknown key, bad value — §2), refuses the start. On success the
  resolved inventory path is pinned into machine state and every later command
  reads it from there.

Only after both guards pass does `start` fetch origin (+ upstream) and derive
the blocked set from the origin fix/sweep refs.

The resolution stage is `report-case` (SWEEP-STATE-MACHINE.md): checks gate, then the
cold read, then merge (MECHANICAL), PR materials (JUDGED) or freeze (HELD), reopening the
branch and its descendants. `--tier held` is the direct freeze path: no resolution commit
required, no scope guard or cold-read gate — the driver prepares the PR materials (§14)
and journals HELD, and `finish` publishes it. This is how an agent declares "cannot
resolve" without a resolution attempt.

**Same-pass continuation:** a gated branch is still journaled `arrived` (barrier
semantics — descendants may proceed on its partial progress), but every `resolve`
journals a `reopened` entry for the branch AND its transitive inventory descendants.
Reopened branches are re-processed by the next `run`: live re-derivation continues the
branch above the resolved height (next case or clean to the watermark) and lets
descendants pick up the resolution — the pass converges without waiting for a new
watermark.

`run` after a `resolve` is idempotent: completed branches re-verify as up-to-date and
are skipped. A crash between a resolve's ref-update and its journal append (the
double-resolve guard's target, §7) is HEALED by the next `run`: an open case whose
branch tip already contains the case head gets a synthetic `resolved` entry (reason
`crash-heal`) plus `reopened` for the branch and its descendants — no second merge,
and the pass converges instead of leaving the case open forever. The
plan-equivalence "halt loudly" check belongs to `run` — BEFORE
executing, the live re-derivation must match the pass's last written plan for all
not-yet-arrived branches (a mismatch means git moved under us); `plan` on a pass with
journal activity reports rather than halts (post-merge state legitimately differs
from the opening snapshot, which is preserved as `plan-initial.json`). Branches the
driver itself already mutated or demoted this pass (journaled `merge`/`case`) are
excluded like origin-synced branches: the §3 execution re-probe's clean→case/skip
demotion is a sanctioned transition (§3), not git moving under us — this also
covers a crash between the journal entry and the branch's `arrived`. All mutations
happen via journaled subcommands; the journal is
`pass-<watermark12>/journal.jsonl`, append-only.

**Pass pinning:** only `plan` may open a pass (creating the pass dir from a freshly
resolved watermark). `run`/`resolve`/`status` attach to the latest OPEN pass dir
(no `pass-complete` journal entry) — or `--pass <watermark12>` explicitly — and take
the watermark and fork point from its `plan-initial.json`, never re-resolving refs.
A mid-pass `git fetch` therefore cannot silently start a new pass or orphan the
in-flight journal and HELD registry. `run` journals `pass-complete` when it finishes
with no open cases and the §9 gate is green.

**Origin sync (§13):** the driver never operates on refs/remotes directly. At
`run --execute`, before a branch's first mutation this pass, one journaled sync step
reconciles the LOCAL ref with `origin/<branch>` through the guardRef choke point
(`plan` and dry-run `run` never write refs): no local ref → create it at the origin
tip (`branch-materialized`; its §9 rollback target is the creation point); local
strictly behind origin → fast-forward (`branch-synced`; a checked-out worktree uses
the N1 dirty-guard + reset pattern); local ahead of origin → unpushed driver work, no
action, no noise; DIVERGED → journaled DriverHalt for THAT branch only — it is
skipped this pass (arriving for the barrier with an empty interval, like HELD) and
reported; siblings keep processing. Diverged branches are owner escalations, never
force-resolved by the driver or the agent.

**Durable holds live on ORIGIN.** HELD outlives the pass as an open
`fix/sweep/*` ref plus its PR; `start` re-derives the blocked set from those and
journals `origin-blocked` rows, and `plan`/`run` treat blocked branches as arriving
with an empty interval (barrier satisfied, no merges). The pass journal is the
intra-pass registry; ORIGIN is the cross-pass one. There is no local cross-pass
state file — a local copy can go stale and be read back as the current sweep
state while an open pass sits beside it, so ORIGIN is the only durable
registry. Before ANY ref mutation on a branch, its pre-pass tip is
journaled (`pre-ref`) — the §9 rollback target.

**Unblock paths:** (a) DERIVED — at `start`, a fix ref merged into its target is
resolved and the ref deleted; a branch whose tip already CONTAINS the held head
(the resolution landed externally) is likewise unblocked;
(b) a mechanical/judged `report-case` on the branch clears it. Blocks are never
cleared silently; there is no manual override.

**Urging:** the blocked row
carries the fix branch and its PR number. When a pass finds NEW pending content for a
blocked branch beyond what it was last urged about — and "last urged" is read from
the PR's OWN comments (`sweep-urge: <head>` markers), never from a local
cache — `propagate
push --execute` POSTS the urge as a PR comment on the freeze PR — pending-commit
count since the freeze, the newest heads with subjects — refreshes the
machine block in the PR body (§14.4), journals `urge`, and records the new
`lastUrgedHead` (only after a successful post; a failed post is
`ERR17_URGE_FAILED`). One urge per new head, not per pass — quiet passes stay
quiet. `plan`/`run` only DETECT would-urge (no writes, no network); posting lives
exclusively in the networked `push` stage.

**Naming:** resolution/freeze branches are
`fix/sweep/<slug(branch)>--<slug(parent)>-h<height>-<sha8>` (gate-fix cases:
`fix/sweep/<slug(branch)>--<gate-fix case id>`); case ids are
`<slug(branch)>--<slug(parent)>-h<height>` — the parent slug is essential
because two parents of one branch conflicting at the same height are distinct
cases (with branch+height alone, the second would trip the double-resolve guard
and deadlock).

**Dry-run purity:** without `--execute`, `run` performs NO state changes at all — no
merges, no unfreezes, no urge artifacts, no journal entries.
`resolve` without `--execute` likewise writes nothing (N7): a re-verification failure
is reported on stderr only, and the cold-read request is not regenerated.

**Protected refs:** the single ref-write choke point refuses to move `main`,
`design/*`, `maint/*`, `everything*`, `test/*`, and anything outside the pass's
resolved scope — regardless of what a step/case file or CLI flag says.

## 9. Verification gate

Implemented as the driver's `verify` stage, run by `finish` (reusing `verify.ts`'s
everything-rebuild + CI command list with leave-one-out attribution), after `run` has
completed the executable portion of the pass. Red result →
the offending branch is rolled back to its journaled `pre-ref` (recorded before its
first mutation this pass) and journaled HELD(gate); re-verify
without it. A pass is only `pass-complete` when the gate is green. Nothing is pushed
before verification passes:
the push stage refuses (`ERR18_VERIFY_PENDING`) unless the journal shows a green
`verify` after the pass's last mutation (§14.4).

**The recipe = THIS PASS'S PUBLISHABLE RESULT.** The gate must
validate what will be published, not a static branch list. The recipe is DERIVED from
the pass: the branches that ADVANCED this pass (a `pre-ref` was journaled), in the
plan's DAG order (parents before children), **minus** any branch that is held/frozen
(journal/origin) or carries an open case — those are unpublished, frozen-by-design,
and still carry unresolved conflicts, so verifying them would recreate historical stack
conflicts against the base and wedge the gate (a permanently-held branch could never let
it go green). The rebuild base is the fork trunk `main_patched` per the §3 merge-source
model (module/feat branches root there), NOT bare `main` — merging a fork branch onto
`main` recreates the fork-content conflicts it was merged past; `main_patched ⊇ main`, so
upstream-chain-from-main branches still integrate cleanly in this throwaway target (the
§3 push-time purity rule is enforced against the real refs, never this discarded build).
`verify.ts` seeds the workspace rr-cache into `.git/rr-cache` before the rebuild so
resolutions recorded this pass replay rather than reappearing as false offenders. A
build-conflict or leave-one-out offender that is itself held/frozen (or has no this-pass
`pre-ref`) is a **non-blocking gate observation** — journaled and surfaced to the owner,
the publishable set proceeds — never `ERR18`; the blocking rollback+freeze path fires
ONLY for a publishable branch that WOULD be pushed this pass. The static `recipe:` in
`registry/scope.yaml` degrades to a planless fallback (manual `verify` with no pass).

## 10. Module layout (new files, flat per convention; reuse map)

| New | Purpose |
|-----|---------|
| `heights.ts` | watermark pinning, chain enumeration, height↔sha, coverage derivation (binary ancestry search) |
| `interval.ts` | eligible-line construction (§4) + linear merge-point sweep (§3) |
| `tiers.ts` | tier types, floors, demotion transitions (the only legal transitions) |
| `plan.ts` | DAG validation, breadth-wise plan derivation, no-op/skip + leaf un-skip logic |
| `deferred.ts` | ancestor-HELD matching rule (§5) |
| `scope-guard.ts` | automerge-vs-resolved subset check (§7) |
| `steps.ts` | step/case JSON schemas + first-principles re-verification |
| `propagate.ts` | the six-command surface + the internal plan/run/publish/push/verify/report stages, journal, worktree + PR-materials preparation, pass pushes |
| `candidates.ts` | inventory-candidate discovery + inheritance derivation (§13) |
| `publish.ts` | §14: result-id registry + halt-id mapping, mechanical text checks (ERR08 + lint WARNs + ERR06), pre-PR height check, machine block (§14.4), GitHub REST transport (injectable) |

Reused as-is: `git.ts` (merge-tree, rev-list, worktree helpers), `merge.ts` (the shared
rerere cache), `scope.ts` (inventory scope + edition-composition closure), `verify.ts`,
`registry.ts`. The registry validator `validate.ts` (`validateRegistry(repo,
features)`) runs as `sweep.ts validate-registry` — the `fork-registry-generate`
skill runs it. It enforces rules 1-5 only: (1) owning branch exists, (2) every
`owned_paths` glob matches at least one file on the branch, (3) `test_anchors` +
`design_docs` exist, (4) `key_symbols` spot-check (WARN), (5) sweepable branch
without an inventory entry. Entries without `branch` skip rules 1-4 — there is
nothing on git to check them against.

## 11. Testing

- Unit: synthetic fixture repos (extend `fixtures.ts`) covering — non-monotonic conflict
  window (conflict at k, clean at k+m: sweep must merge past k); DEFERRED positive /
  path-disjoint negative / no-historical-tip variant; multi-parent barrier ordering incl.
  a HELD parent arriving with an empty interval; no-op skip + leaf un-skip chain; scope
  guard violation demotions; step re-verification rejecting a forged head/parent/height;
  watermark pinning (chain never re-read mid-pass); tier floor for edition-flagged
  entries; idempotent re-run after partial execution.
- Remote branches + candidates (§13; fixtures fake `origin` via
  refs/remotes/origin/* — `FixtureRepo.setOrigin`): all four sync states end-to-end at
  the cmdRun level (materialize / fast-forward / ahead-no-op / diverged-halt with
  siblings proceeding); `plan` flags `materialize`; dry-run `run` makes zero ref
  writes; candidate derivation — clear cut-from an inventory branch, merged-into
  descendant (`requiresEntryEdit`), ambiguous cut point (two owners → `unclear` +
  open question), pre-fork branch (`no fork-era ancestry`); candidates re-derived
  and re-reported every pass; candidates
  never appear in the merge plan; an inventory entry with a parent missing from the
  inventory/structural set hard-halts `plan` naming the entry.
- Real cases: pinned-SHA case files in `scripts/sweep/test-cases/` (replay-model,
  checkout-free) mined from the fork + upstream DAG for each taxonomy class above where
  a real instance exists; they double as regression anchors and rerere seeds where a
  recorded resolution exists.

## 12. Trust model — what the driver enforces vs what must sit outside it

The driver's re-verification recomputes VALUES from git, but its POINTERS — the plan,
journal and every `--flag` — live in the agent-writable workspace and are
supplied by whoever invokes the CLI. Inside a single trust domain the driver is a
correctness core, not an enforcement boundary. It becomes an enforcement core only
under an owner-controlled invocation layer, which is the ADOPTION CONDITION, not an
afterthought:

- a wrapper (or separate OS/service identity) that pins the CLI flags (`--repo`,
  `--workspace`, `--upstream`, config paths), owns the pass directory read-write,
  and is the only principal allowed to run the mutating commands
  (`next-case`/`report-case`/`finish`);
- cold-read PROVENANCE: the driver spawns the reader itself and validates the
  verdict's shape, but inside a single trust domain the invoker could stub the
  subprocess — provenance ultimately rests on the invocation layer;
- push/PR execution behind the fork's enforcement layer: agent identity separation,
  branch protection, required CI.

In-driver, defense-in-depth only: the protected-ref guard at the single ref-write
choke point (§8) and first-principles re-derivation of everything derivable from git.

## 13. Remote branches and inventory candidates

The driver works with remote branches: a branch existing only as an `origin/*`
remote-tracking ref is fully in scope. New branches are auto-discovered with a
mechanically derived CANDIDATE record whose core is proper inheritance (parent
AND descendants); unclear inheritance = ask the owner; **the inventory may only
contain branches with proper/valid inheritance.**

### 13.1 Remote-branch materialization + sync (code-enforced)

The driver never operates on refs/remotes directly — it reconciles local branches
with origin, then everything else stays local-ref-only:

- **Scope/plan:** an inventory branch with no local ref but an existing
  `origin/<branch>` is IN scope, planned normally (probes/coverage read the origin
  commit — §4 source refs), plan row flagged `materialize: true`. A branch existing
  in NEITHER place stays a loud drift warning.
- **Sync step:** at `run --execute`, per in-scope branch BEFORE its first mutation
  (journaled, through the guardRef choke point, `--execute`-gated — `plan` and
  dry-run `run` never write refs): no local ref → create at origin tip
  (`branch-materialized`); strictly behind → fast-forward (`branch-synced`, N1
  dirty-guard + reset for checked-out worktrees); ahead → unpushed driver work, no
  action, no noise; DIVERGED → per-branch DriverHalt (journaled): external history
  the driver cannot reconcile — the branch is skipped this pass (empty-interval
  barrier arrival) and reported; other branches proceed. Diverged branches are
  **owner escalations** (agent duty: report, never force-resolve).

### 13.2 Candidate discovery with inheritance derivation

**Detection (code):** branches — local or origin/* — matching the sweepable
namespaces (`module/**`, `feat/**`, `edition/**`, minus config/scope exclusions), or
qualified by the edition-composition closure, that have NO inventory
entry. Candidates are **never merged or planned for propagation** — discovery and
reporting only.

**Inheritance derivation (code, `candidates.ts`):** mechanical and evidence-backed,
both directions, every finding recorded with SHAs.

- *Ownership model:* an established branch (inventory + main_patched) owns the
  commits of its first-parent line that are neither reachable from the pinned trunk
  nor on a DECLARED ancestor's line — declared inheritance explains sharing;
  undeclared sharing does not (two entries sharing an undeclared fork-era segment
  both "own" it — the ambiguous-cut-point case). A candidate owns only commits on no
  other line.
- *Fork point:* the candidate's first-parent-line divergence point from the fork
  ancestry (first non-own commit walking tip-down) + its trunk coverage height
  (heights.ts; −1 when below the pass chain).
- *Proposed PARENTS, strongest evidence first:* (1) `cut-from` — the fork point is
  owned by exactly ONE branch; owned by several → the specific "cut point ambiguous
  between X@sha and Y@sha — which parent?" question; (2) `merged-from` — P-own
  commits reachable from the candidate tip off its first-parent line and above the
  fork point (fork-era reachability; commits reachable from the trunk
  never qualify); (3) `merge-base` — deepest merge-base among inventory branches,
  ALWAYS an open question (thin evidence), never `clear` by itself.
- *Proposed DESCENDANTS (the inverse):* `merged-into` — candidate-own commits
  reachable from D's tip off D's first-parent line; `cut-of` — D's first-parent line
  contains the candidate (or shares undeclared fork-era history with it; direction is
  topologically undecidable and becomes an open question). A descendant finding is
  flagged `requiresEntryEdit`: D's EXISTING entry needs its `parents` amended
  (owner-approved, like any entry change).
- *Confidence:* `clear` ONLY when at least one parent is derived and no open
  question exists — unambiguous parent set, no merge-commit fork point, fork-era
  ancestry present, no both-direction evidence, proposed edges acyclic (checked
  against the declared DAG). Everything else is `unclear` and carries the SPECIFIC
  question(s) for the owner. Never guess; never `clear` on thin evidence.
- *Known limit:* "c cut from D" and "D cut from c" produce identical DAGs; where
  both sides continued the driver applies the established-branch prior (candidate cut
  from the inventory branch). Safe because no entry exists until the owner approves
  the placement.

**Artifacts + reporting (code):** candidates are derived FRESH from git every
pass — no cross-pass candidate store of any kind. Every pass appends a
`candidate` journal entry per discovery (append-only audit) and writes the full
derived set to the pass dir's `candidates.json` — per candidate: branch, tip,
remoteOnly, forkPoint {sha,height}, coverage,
proposedParents[{branch,evidence[]}],
proposedDescendants[{branch,evidence[],requiresEntryEdit}], confidence,
openQuestions[], changedFiles vs the strongest parent (capped at 40;
`changedFilesTotal` notes the real count). `plan` prints the CANDIDATES section,
ending with the standing instruction verbatim: *"Report these to the owner.
clear → propose the derived placement for approval; unclear → ask the owner the
open question. The inventory may only contain branches with proper/valid
inheritance — never add an entry without it."* A candidate is reported EVERY
pass until the owner acts in config — an inventory entry or a scope exclusion;
a branch that gains an entry (or vanishes) simply stops deriving as a
candidate.

**Plan-purity exception (explicit):** writing `candidates.json` +
`candidate` journal entries from `plan` is derived REPORT state — reports, never git
refs. Ref writes remain exclusive to `--execute` paths through the guardRef choke
point.

**The invariant and where it is enforced:** "the inventory may only contain branches
with proper/valid inheritance" is code-enforced at plan time —
`plan.ts validateInventoryInheritance` hard-halts, naming the entry, when an in-scope
inventory entry declares a parent missing from the inventory/structural set (a
silently rewired root is never acceptable), and `scope.ts` hard-halts on any DAG
cycle. What stays AGENT DUTY (doctrine, not code): relaying the CANDIDATES section to
the owner, proposing `clear` placements for approval, asking the `unclear` open
questions verbatim, and only ever creating/amending entries (via the
fork-registry-generate skill + seeds.yaml PR) after owner approval with the approved
`parents:`.

## 14. Publish tool and result-ID contract

PR heads are REAL commits — a real conflicting-height commit for HELD, the real
merge commit for JUDGED. Two structural rules keep that safe: HELD PRs are
created only AFTER the pass's target pushes (so the base is current and the
diff = the case run only, no pending-range bloat), and the pre-PR height check
plus the verify-gated push order keep unpushed protected content out of PR
ancestry. The agent writes the PR prose; adequacy checks are mechanical
(§14.2).

### 14.1 The `publish` stage — the ONLY sanctioned PR-creation path

**Agent-writes-prose principle:** the driver NEVER generates PR prose. At
resolve/freeze it writes `pr/materials.md` (structured facts only: conflicted paths,
the case run, per-side `git log --oneline` over those paths, reproduction command).
The agent studies the case — the worktree and materials ARE the source of
understanding — and writes `pr/title.txt` + `pr/body.md` itself, then runs
`report-pr`; the `publish` stage (run by `finish`) creates the PR. The tool:

1. **Re-verifies the case** from the journal + git (the journal is a pointer, git is
   the authority): the case must have an open `held` disposition (live conflict
   recomputed against the current tip, path set unchanged) or a `judged` resolution
   (merge commit still on the branch). Mechanical/crash-heal resolutions get no PR.
2. **Determines the PR head** (real commits only, no synthetic construction):
   HELD — the case run's TOP commit verbatim; JUDGED — the real merge commit. Then
   runs the **pre-PR height check** (`ERR14_BASE_BEHIND`): the origin base branch
   must be at least at the expected pass height — for HELD the local tip must be
   contained in origin (targets pushed first, §14.4 order; higher is fine, someone
   else committed); for JUDGED origin must not have diverged and must NOT already
   contain the merge commit (JUDGED PRs are created BEFORE the target push). Lower
   or diverged = halt.
3. **Runs the check battery** and emits ONE machine-readable JSON object on stdout:
   `{ok, issues: [{id, detail}], pr?: {url, number}}`. Any ERR* id blocks; WARN* ids
   are advisory and never block.
4. **On all-clear + `--execute`**: pushes the fix/sweep ref at the head commit via
   `git push` (refs move via git push ONLY — the API is never used to fabricate
   refs/commits; a failing push is `ERR15_PUSH_FAILED`, journaled, and an
   owner report — never worked around), then creates the PR via the GitHub
   REST API (POST /pulls — normal API use): HELD = active when the case carries
   a marker-clean resolution, draft for a pristine-conflict exhibit, with the
   machine block appended below the agent's body (§14.4); JUDGED = non-draft. API requests
   go to api.github.com with `Authorization: Bearer <substitute token>` (the
   credential proxy swaps the header on the wire), CONNECT-tunnelled through
   HTTPS_PROXY. The substitute token is read from the ENVIRONMENT (`GH_TOKEN`,
   fallback `GITHUB_TOKEN`) at each networked write and never persisted — the
   agent manages no token file (an internal `--token-file` override exists for
   the flag CLI and tests; a file wins when present; same model on every
   networked command: `start`, `publish`, `push`). No token anywhere →
   `ERR11_TOKEN_MISSING`; a 401/403 from the API is `ERR41_TOKEN_REJECTED`,
   which names the token's SOURCE — a retry with the same token can never
   clear it. Journals `pr-published {case, url, number, head}`.
5. **Without `--execute`**: dry-run — the full battery runs, but there are NO
   network calls and NO pushes of any kind; the transport is never constructed.

Cross-pass publishes attach like `resolve` (latest open pass, or `--pass <wm12>`).

### 14.2 PR text — mechanical checks only

The agent writes `pr/title.txt` + `pr/body.md` itself from studying the case.
The checks on that text are MECHANICAL only: `ERR08_TEXT_MISSING` (title/body
absent or empty), the advisory lint WARNs (`WARN01_TEMPLATE_TEXT`,
`WARN02_NO_DECISION_LINE`), and the adequacy gate `ERR06_DUPLICATE_CASE`. The
writing rules — no bare "review needed", describe behaviour not line counts,
label ours/theirs, no unexplained references — are agent doctrine; no reader
loop enforces them.

The RESOLUTION cold read at `resolve` (§7) is the one and only cold read.

### 14.3 Result-ID registry (single source of truth)

Blocking (any one → no publish/push):

| id | meaning |
|----|---------|
| `ERR01_CASE_NOT_OPEN` | no open journaled held/judged disposition for the case (unresolved, mechanical, or never journaled) |
| `ERR02_CASE_STALE` | live state moved: resolution landed externally, conflict healed, path set drifted, or the judged merge left the branch |
| `ERR06_DUPLICATE_CASE` | another open case or published PR shares the conflict signature (same path set + same head sha or identical conflict blobs); the topmost case by DAG order is named |
| `ERR07_PR_EXISTS` | an open PR is already recorded for this case (journal) or found via the API by head branch name |
| `ERR08_TEXT_MISSING` | pr/title.txt or pr/body.md absent or empty |
| `ERR11_TOKEN_MISSING` | a networked `--execute` with no token in the environment (`GH_TOKEN`/`GITHUB_TOKEN`) and no `--token-file` override |
| `ERR12_ORIGIN_UNRESOLVED` | `--execute` but owner/repo cannot be derived from the origin remote URL |
| `ERR13_API_FAILED` | a GitHub API call failed during execute (non-2xx / transport error) |
| `ERR41_TOKEN_REJECTED` | the GitHub API answered 401/403 — the token was REJECTED; the detail names the token's source (`$GH_TOKEN` / `$GITHUB_TOKEN` / `--token-file`) and a retry with the same token can never clear it |
| `ERR14_BASE_BEHIND` | pre-PR height check: the origin base branch is missing, behind the expected pass height, diverged — or (JUDGED) already contains the merge commit (order violation) |
| `ERR15_PUSH_FAILED` | a `git push` failed (any push, any stage) — hard halt; report to the owner and STOP; publication is blocked until the infrastructure is fixed; no fallback of any kind |
| `ERR16_CLOSURE_FAILED` | a JUDGED PR did not flip to merged after its target push (checked via the API) |
| `ERR17_URGE_FAILED` | posting an urge comment / refreshing the machine block (§14.4) failed (the `lastUrgedHead` is NOT advanced — the urge retries next push) |
| `ERR18_VERIFY_PENDING` | `push --execute` refused: no green `verify` journal entry after the pass's last mutation (§9) |

Never assign these numbers to new ids: ERR03, ERR04, ERR05, ERR09, ERR10,
ERR19, WARN04.

Start-time refusals (`sweep start` returns them and no pass opens; like
`ERR30_PASS_OPEN`, `ERR37_WORKSPACE_IN_CLONE` and `ERR39_FETCH_FAILED` they
block `start` itself):

| id | meaning |
|----|---------|
| `ERR46_INVENTORY_INVALID` | missing or empty inventory, or any entry error (unknown key, bad value — §2); on success the resolved inventory path is pinned into machine state |

Advisory (returned in `issues`, never block):

| id | meaning |
|----|---------|
| `WARN01_TEMPLATE_TEXT` | body mentions zero conflictedPaths, or contains a known driver-template phrase (the driver never writes prose) |
| `WARN02_NO_DECISION_LINE` | the first body line carries no ask/decision |
| `WARN03_MANY_PRS` | more than 8 PRs published this pass |
| `WARN05_STALE_VERDICT_CLEARED` | a stale on-disk cold-read verdict record (attesting an earlier resolution tree) was cleared before a fresh read — advisory, never blocks |

`resolve` outcome id (not a DriverHalt — `resolve` returns 0, the case is frozen HELD
for the owner and journaled `resolve-not-converged`):

| id | meaning |
|----|---------|
| `ERR26_RESOLVE_NOT_CONVERGED` | the resolution cold-read did not converge in `RESOLVE_COLDREAD_CAP` (2) distinct resolution trees — the anti-thrash cap force-HELD the case rather than looping |
| `ERR35_COLDREAD_UNAVAILABLE` | a cold-read TOOLING failure — the `claude -p` cold read could not RUN (spawn error, non-zero exit, unparseable stdout, or a recognizable auth/login failure). An INFRA error, NEVER a content decision: `report-case` and `report-pr` hard-halt (mirrors `ERR15`), report to the owner and STOP; the case is NOT frozen HELD (nor rejected, nor left in the confirm/reject "invalid verdict" ambiguity), and the command is re-runnable once the tooling is restored. Only a cold read that actually RAN and judged the content may reject → HELD |

DriverHalt reasons, mapped onto the same scheme in `run`/`resolve` CLI output (the
human text stays in `detail`; the journal keeps the raw reason plus the id):

| id | halt reason |
|----|-------------|
| `ERR20_BRANCH_DIVERGED` | `sync-diverged` (§13 — owner escalation, never force-resolve; also fired when a push target has diverged from origin) |
| `ERR21_MERGE_FAILED` | `merge-failed` (§3 backstop — branch-local halt) |
| `ERR22_DIRTY_WORKTREE` | `dirty-worktree` (N1 checked-out safety) |
| `ERR23_PROTECTED_REF` | `protected-ref` (§8 choke point) |
| `ERR24_PLAN_DRIFT` | plan drift — git moved under us (§8) |
| `ERR25_BAD_CASE_ID` | `--case` does not match the generated case-id shape (N5) |

### 14.4 The `push` stage — pass publication

The DRIVER pushes; the agent never hand-pushes anything. Per-pass order:
**verify green → JUDGED PRs created (`publish`, non-draft, head = the real
merge commit on a pushed fix/sweep ref) → `push` pushes the target branches (the
same commits land on the bases; GitHub auto-flips the JUDGED PRs to merged)
→ HELD PRs created (`publish`, active or draft; bases now current, diff = the
case run) → urge comments posted.** The push stage (run by `finish`):

1. **Verify gate**: refuses (`ERR18_VERIFY_PENDING`) unless the journal shows a
   green `verify` after the pass's last `merge`/`resolved` (nothing is pushed
   before verify is green — §9).
2. **Target pushes**: every branch the driver mutated this pass (journaled
   `merge`/`resolved`), in plan order, is pushed `git push origin <branch>` — ONE
   push per branch, clean prefix and judged merge commits together. Already
   up-to-date or origin-ahead branches are skipped (higher is fine); a DIVERGED
   target is `ERR20_BRANCH_DIVERGED` (owner escalation); a failed push is
   `ERR15_PUSH_FAILED` — hard halt, journaled, owner report, NO fallback.
   Every push is journaled (`push {branch, to}`) — driver-journaled pass pushes
   are the ONLY pushes.
3. **JUDGED closure check**: for each published JUDGED PR whose target was pushed,
   the API is asked whether the PR flipped to merged; a still-open PR is
   `ERR16_CLOSURE_FAILED` (investigate — the commit on the base and the PR head
   should be the same object).
4. **Urge posting** (§8): for each still-frozen branch with NEW pending content and
   a published freeze PR, POST the urge comment and PATCH the PR body's
   machine block, then record `lastUrgedHead` (post-first — a failed post is
   `ERR17_URGE_FAILED` and does not advance the tracking).

Without `--execute`, `push` is a pure report: what would be pushed, flipped and
urged — no writes, no network.

**Machine block:** every HELD PR body carries a driver-maintained,
clearly-delimited block (`<!-- sweep:d004 -->` … `<!-- /sweep:d004 -->`) appended
below the agent-written body at publish and refreshed by every posted urge: the
count of further pending upstream commits beyond the freeze. The agent never edits
the machine block; the driver never touches the agent's prose above it.
