# Mechanical propagation driver — specification

Status: v1 (2026-07-18, owner-settled design). Decision references D-035..D-040 point to
the decision log (`self-maintenance-decisions.md`). Supersedes the agent-sequenced merge
loop of DESIGN.md §5-6 for propagation ordering, merge execution, and case handling;
scan/PoI routing/inventory/verify machinery is reused, not replaced.

**Motivation (owner, 2026-07-18):** the sweep relied on agent behavior for sequencing and
scope/framing of merges and PRs; the 2026-07-13/14 incidents and the 2026-07-18 rollback
showed that everything ordering-, scope-, and framing-critical must be mechanical. The
agent's remaining role is exactly one thing: resolving a conflict the driver hands it,
inside a driver-managed worktree, followed by re-running the driver. The driver decides
what merges where, in what order, from which commit, and whether the agent's output is
acceptable.

## 1. Tier ladder (D-035)

Every parent→branch merge attempt lands in exactly one tier:

| Tier | Meaning | Handling |
|------|---------|----------|
| **CLEAN** | No textual conflict | Bulk-merged directly, no review |
| **MECHANICAL** | Trivial conflict (e.g. two disjoint appends); agent-resolved | Cold-read confirmed, merged directly, no PR |
| **JUDGED** | Non-obvious resolution, agent-resolved | PR for the audit trail, cold-read confirmed, auto-merged (merge commit pushed to target → PR flips to merged) |
| **HELD** | Unresolved / cold-read rejected / sophisticated | Real-diff draft PR (D-030 shape), branch frozen for the owner |
| **DEFERRED** | Conflict *belongs to an ancestor* currently HELD | Branch frozen, **no PR**; auto-unfreezes when the ancestor's HELD clears |

Tier decisions and constraints:
- CLEAN vs conflict is computed by the driver (new-style `git merge-tree`, D-001).
- MECHANICAL vs JUDGED is claimed by the resolving agent but only ever **demoted** by
  the driver, never promoted: a scope-guard violation (§7) demotes MECHANICAL→JUDGED and
  JUDGED→HELD; a cold-read rejection demotes to HELD.
- `edition/*` (and any inventory entry flagged `tier_floor: judged`) never merges below
  JUDGED — D-015 restated in ladder terms.
- A red verification gate (§9) demotes any already-executed tier to HELD(gate) with
  rollback to the journaled pre-pass ref (D-012). Textual cleanliness ≠ correctness;
  demotion is a first-class transition, not an exception path.
- A CLEAN merge that passes *through* a commit some ancestor is HELD on is annotate-class
  (D-002): flagged in the pass report, never gated.

## 2. Pass model — watermark, heights, breadth-wise barrier (D-036)

A **pass** is one driver run over the whole inventory DAG.

- **Watermark**: at pass start the driver pins `upstream/main`'s tip. The pass targets
  this SHA everywhere; upstream advancing mid-pass is invisible until the next pass.
- **Heights**: the driver enumerates the trunk first-parent chain once
  (`git rev-list --first-parent --reverse`, D-011 unit of merge) from the fork point and
  assigns each commit an index. A *merge head* is the pair `{sha, height}`; all
  comparisons (barrier, DEFERRED matching, coverage) use height with the sha as an
  integrity check. Never compare by commit date or subject.
  For `main_patched` the chain is enumerated on `main` (which FF-mirrors upstream);
  for parents-model branches "upstream coverage" is still measured against the same
  single trunk chain — content reaches them only through parents (D-032a).
- **Coverage** (derived, never stored — D-029 model): a branch's covered height =
  the highest chain index whose commit is an ancestor of the branch tip. Ancestry along
  a first-parent chain IS monotonic, so this is binary-searchable with
  `git merge-base --is-ancestor` (O(log n) probes). This derivation replaces any notion
  of stored `lastMergedUpstream`.
- **Order**: strict breadth-wise over the inventory DAG. A branch is processed only when
  ALL its inventory parents have been processed this pass — even a parent whose result
  is "skip" or "HELD with empty progress" counts as processed (arrival, possibly with an
  empty interval). `main` (FF) and `main_patched` are the only upstream entry points;
  every other branch merges only its inventory parents' tips (D-032a); the driver
  validates the inventory is a DAG before every pass and halts on a cycle.
- **Earliest boundary is soft**: only a head's height is strict. `git merge <sha>`
  merges the sha's entire ancestry, so the interval's lower end is bookkeeping — a
  branch that skipped or froze in earlier passes simply catches up when it next merges.

## 3. Merge-point selection — linear sweep, not bisect (D-037)

"Merging up to height k conflicts" is **not monotonic in k**: a later upstream commit
can rewrite a disputed region so the tip-level three-way merge is clean again. The
existing `stop-points.ts` bisection embeds the monotonicity assumption and is therefore
NOT reused for propagation (it stays for the scan's informational forecast only).

Per branch and per parent, over the parent's *eligible line* (§4):

1. Probe the full range first — one in-memory `merge-tree` against the parent's
   eligible tip. Clean → done (the common case; one probe total).
2. On conflict, sweep the eligible line **linearly** (one merge-tree probe per
   candidate head, oldest→newest), recording clean/conflicted per height.
3. Merge at the **largest clean height** — this may lie beyond intermediate conflicting
   heights (their content lands cleanly at tip level; desirable, fewer conflicts).
4. Report the **smallest conflicting height above the merge point** as the case for the
   agent: `{branch, parent, head: {sha, height}, conflictedPaths, automergeTree,
   reproduction}`.

Probes are milliseconds (checkout-free); upstream deltas are tens of commits — linear
cost is negligible and correctness beats O(log n).

**Probe determinism (2026-07-20):** automerge-tree OIDs depend on the literal
merge-tree invocation — conflict-marker LINES embed the command-line labels verbatim
(branch name vs sha → different blob → different tree) and `merge.conflictStyle`
adds/removes the `|||||||` base section. Verified on the real p7 case: identical
commits produced three distinct trees (branch-name labels / sha labels /
diff3 style). Every driver probe therefore (a) passes pinned SHAs, never ref names,
and (b) forces `-c merge.conflictStyle=merge`, making recorded automerge trees
reproducible across clones and user configs; the resolve-time drift halt then fires
only on genuine movement.

## 4. What is mergeable of a parent — eligible line

For entry-point branches (`main_patched`, D-032b edition-composition branches merging
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
next advances (violating the D-032a parent-tip inheritance model). The normal ladder,
no-op check, and DEFERRED rule apply to that head like any other.

## 5. DEFERRED — conflicts that belong to an ancestor (D-036)

When the sweep finds branch C's first conflicting height N′ against parent Q, and the
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
- Rationale (owner-settled 2026-07-18): the child carries the parent's delta, so a
  collision that gated P textually re-manifests at C — nothing is silent. If it does
  not re-manifest, the merge is genuinely clean for C, and P's eventual resolution
  flows down later as an ordinary delta. Convergence mechanism: next pass the barrier
  has C merge P (fresh resolution + shared rerere, D-006) *before* re-probing Q, so the
  formerly deferred conflict typically auto-resolves.

## 6. No-op skips and the leaf must-merge rule (D-039)

- A parent merge whose merge-tree result tree equals the branch's current tree is a
  **no-op**: the driver records `skip` in the journal and does not create a merge
  commit. Merge-base consequences are benign; the next real merge covers the gap.
- **Leaves and inventory entries flagged `always_merge: true` must land at least one
  real merge per pass** when the pass carries any upstream progress. If every parent
  chain above such a branch skipped as no-op, the driver **un-skips the cheapest parent
  chain**: the intermediate merges are no-ops by definition, so they cost one empty
  merge commit each but keep the invariant "every branch only ever merges its inventory
  parents" absolutely uniform. There is NO merge-main-directly exception for leaves
  (supersedes the earlier sketch); hierarchy has zero special cases.

## 7. Step contract and scope guard (D-035, D-038)

The driver is the only author of merge parameters. Artifacts live under
`<workspace>/propagation/pass-<watermark12>/`:

- `plan.json` — the whole-pass plan: DAG order, per-branch per-parent heads
  `{sha, height}`, skip/merge/defer verdicts, leaf un-skip chains. Pure derivation from
  git state + inventory; regenerating it must be a no-op (idempotent, resumable).
- `step-<branch>.json` — the per-branch contract the merge executor accepts. The
  executor **re-verifies from first principles** (never trusts the file author):
  parent ∈ inventory parents (or `main` for D-032b branches); head sha matches the
  claimed height and is on the parent's eligible line; height ≤ watermark; all parents
  arrived this pass (journal); skip claims re-computed via merge-tree; leaf rule
  honored. Verification failure = hard halt, journaled.
- `case-<branch>-<height>.json` + `case-.../automerge/` — a reported conflict: tier
  floor, conflicted paths, automerge tree (conflict markers), one-command reproduction,
  DEFERRED-check inputs. The agent resolves ONLY inside the driver-created worktree for
  that case, commits, and runs `resolve --case <id> --tier mechanical|judged`.
- **Case re-verification at resolve (trust boundary):** everything under the workspace
  is agent-writable, so `case-*.json` is a POINTER, never an authority. At resolve the
  driver re-derives from git + registry everything it is about to act on: the head sha
  must lie on the named parent's eligible line for this pass; the automerge tree and
  conflicted-path set are RECOMPUTED via merge-tree against the branch's current tip
  (the recorded values are only cross-checked for drift reporting); the tier floor is
  re-derived from the registry; the case must correspond to an open `case` journal
  entry with no later `resolved`/`held` for the same id, and the branch tip must not
  already contain the head (double-resolve guard — a crash between ref-update and
  journal append must not allow a second merge). Any mismatch = hard halt, journaled.
- **Scope guard (D-038, tightened 2026-07-20 post-review; lever added same day):** on
  resolve, the driver computes `git diff --name-only <automerge-tree> <resolved-tree>`
  and enforces the configured mode:
  - `same-files` (DEFAULT, owner 2026-07-20): the resolution may touch only the
    recomputed conflicted FILES; edits anywhere inside those files pass (hunk-level
    review belongs to the cold reader). Any extra file → **HELD, no merge** — a
    demotion to JUDGED would still land the out-of-scope content, defeating the guard
    (supersedes the earlier demote-one-tier rule).
  - `conflict-hunks` (strict, opt-in): additionally, within conflicted files the
    changed line regions must lie within the conflict-marker regions of the automerge
    tree; edits elsewhere in the file → HELD.
  The lever: global default `scope_guard_mode` in `registry/routing.yaml`; per-feature
  override `scope_guard:` on the inventory entry. Like the tier floor, the effective
  mode is RE-DERIVED from config at resolve — never read from the case file.
- **Cold-read artifact:** the driver emits `coldread-request.md` (conflict hunks from
  the automerge tree + resolution diff + the four cold-reader questions of D-031 —
  nothing else, so the resolving agent cannot frame the question) and requires
  `coldread-verdict.json` before accepting a MECHANICAL or JUDGED completion. The
  verdict must VALIDATE: `verdict` ∈ {`confirm`,`reject`}, non-empty `notes`, and a
  `resolvedTree` field equal to the tree OID of `--resolved-ref` (freshness binding —
  the verdict attests to THIS resolution, not an earlier one); malformed or stale
  verdicts are rejected, never treated as confirm. The verdict is produced by a
  context-free subagent per D-031/D-034 — the driver can enforce shape and freshness,
  but provenance (that a context-free reader wrote it) is doctrine-enforced and
  ultimately needs an enforcement layer outside the agent-writable workspace.

After a JUDGED resolution or a HELD freeze the driver **prepares** the PR mechanics but
does not talk to GitHub: it creates the local `fix/sweep/<date>-<topic>` branch at the
right commit (JUDGED: the merge commit; HELD: the parent's conflicting head, so the PR
shows the real pending diff and GitHub itself flags the conflict — D-030 shape) and
emits the exact `gh` commands + PR body file. Pushing and PR creation remain under the
push policy / doctrine gates (D-034 result gates, D-031 cold reader) — and stay frozen
until the owner lifts the 2026-07-18 sweep freeze.

JUDGED PR closure (D-040): after cold-read confirmation, the same merge commit is pushed
to the target branch; GitHub auto-marks the PR merged — history preserved, zero
merge-of-merge noise, no dependence on the merge button.

## 8. Driver loop

```
propagate plan                # pin watermark, enumerate heights, derive coverage, emit plan.json
propagate run                 # execute plan: CLEAN merges + skips + DEFERRED marks; halt at first
                              #   case needing judgment per branch; emit case files; continue with
                              #   other branches (one branch's case never blocks siblings, only
                              #   descendants via the barrier)
propagate resolve --case ID --tier T   # scope guard + cold-read gate, then merge (MECHANICAL) or
                              #   prepare PR (JUDGED) or freeze (HELD); reopens the branch
propagate status              # human-readable pass state from journal + derivation
```

`--tier held` is the direct freeze path: no resolution commit required, no scope guard
or cold-read gate — the driver prepares the D-030 real-diff draft PR at the conflicting
head and journals HELD. This is how an agent declares "cannot resolve" without a
resolution attempt.

**Same-pass continuation:** a gated branch is still journaled `arrived` (barrier
semantics — descendants may proceed on its partial progress), but every `resolve`
journals a `reopened` entry for the branch AND its transitive inventory descendants.
Reopened branches are re-processed by the next `run`: live re-derivation continues the
branch above the resolved height (next case or clean to the watermark) and lets
descendants pick up the resolution — the pass converges without waiting for a new
watermark.

`run` after a `resolve` is idempotent: completed branches re-verify as up-to-date and
are skipped. The plan-equivalence "halt loudly" check belongs to `run` — BEFORE
executing, the live re-derivation must match the pass's last written plan for all
not-yet-arrived branches (a mismatch means git moved under us); `plan` on a pass with
journal activity reports rather than halts (post-merge state legitimately differs
from the opening snapshot, which is preserved as `plan-initial.json`). All mutations
happen via journaled subcommands (D-013); the journal is
`pass-<watermark12>/journal.jsonl`, append-only.

**Pass pinning:** only `plan` may open a pass (creating the pass dir from a freshly
resolved watermark). `run`/`resolve`/`status` attach to the latest OPEN pass dir
(no `pass-complete` journal entry) — or `--pass <watermark12>` explicitly — and take
the watermark and fork point from its `plan-initial.json`, never re-resolving refs.
A mid-pass `git fetch` therefore cannot silently start a new pass or orphan the
in-flight journal and HELD registry. `run` journals `pass-complete` when it finishes
with no open cases and the §9 gate is green.

**Durable freezes (ledger):** HELD outlives the pass. On `held` the driver writes the
group ledger (`ledger.ts`: status `frozen`, `frozenBy` = case id, `heldHead` = the
conflicting head sha); `plan`/`run` treat ledger-frozen branches as arriving with an
empty interval (barrier satisfied, no merges). The per-pass journal remains the
intra-pass registry; the ledger is the cross-pass one. Before ANY ref mutation on a
branch, its pre-pass tip is journaled (`pre-ref`) — the §9 rollback target.

**Unfreeze paths:** (a) DERIVED — at plan/attach time, a ledger-frozen branch whose
current tip already CONTAINS its `heldHead` (the resolution landed externally, e.g.
the owner merged the freeze PR) is auto-unfrozen (journaled, reason `derived`);
(b) a mechanical/judged `resolve` on the branch unfreezes it; (c) manual override via
a journaled subcommand. Freezes are never cleared silently.

**Urging (owner 2026-07-20):** the ledger-frozen entry also carries `lastUrgedHead`.
When a pass finds NEW pending content for a frozen branch beyond what it was last
urged about (newest eligible head ≠ `lastUrgedHead`), the driver PREPARES a PR
comment for the freeze PR — pending-commit count since the freeze, the newest heads
with subjects — as `urge-comment.md` + a `gh pr comment` command next to the case's
PR artifacts, journals `urge`, and records the new `lastUrgedHead`. One urge per new
head, not per pass — quiet passes stay quiet. As with PRs, the driver prepares and
never calls gh.

**Naming:** resolution/freeze branches are `fix/sweep/<date>-<topic>-h<height>` so two
cases on one branch in one day cannot collide; case ids are unique per pass by
construction (branch + height).

## 9. Verification gate

Implemented as `propagate verify` (reusing the existing `verify.ts` everything-rebuild
+ CI command list with leave-one-out attribution): run it after `run` completes the
executable portion of a pass and after each `resolve` that lands a merge. Red result →
the offending branch is rolled back to its journaled `pre-ref` (recorded before its
first mutation this pass) and journaled HELD(gate) + ledger-frozen (D-012); re-verify
without it. A pass is only `pass-complete` when the gate is green. Nothing is pushed
before verification passes (D-034 gate 1-2 additionally apply to any push).

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
| `propagate.ts` | CLI (`plan/run/resolve/status`), journal, worktree + PR preparation |

Reused as-is: `git.ts` (merge-tree, rev-list, worktree helpers), `merge.ts` (merge-tree
+ commit-tree + update-ref execution, rerere install), `scan.ts`/`routing.ts` (PoI
annotate flow, unchanged), `scope.ts` (inventory scope + D-032b/D-033 composition),
`verify.ts`, `ledger.ts` (freeze bookkeeping), `record.ts`, `registry.ts`.
`stop-points.ts` remains for the scan forecast; propagation never calls it.

## 11. Testing

- Unit: synthetic fixture repos (extend `fixtures.ts`) covering — non-monotonic conflict
  window (conflict at k, clean at k+m: sweep must merge past k); DEFERRED positive /
  path-disjoint negative / no-historical-tip variant; multi-parent barrier ordering incl.
  a HELD parent arriving with an empty interval; no-op skip + leaf un-skip chain; scope
  guard violation demotions; step re-verification rejecting a forged head/parent/height;
  watermark pinning (chain never re-read mid-pass); tier floor for edition-flagged
  entries; idempotent re-run after partial execution.
- Real cases: pinned-SHA case files in `scripts/sweep/test-cases/` (replay-model,
  checkout-free) mined from the fork + upstream DAG for each taxonomy class above where
  a real instance exists; they double as regression anchors and rerere seeds where a
  recorded resolution exists (D-026/D-029 conventions).
