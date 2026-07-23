# Sweep state machine — canonical agent interface (D-053)

Status: owner-settled 2026-07-22. AUTHORITY on the agent-facing sweep interface.
Supersedes the flag-based `propagate plan/run/resolve/publish/push` as the AGENT
surface; those internals (merge-tree, heights, stacking, MERGE-POLICY tiers, D-030
heads, verify, push) become the driver's implementation, wrapped by this machine.
MERGE-POLICY.md still governs tiers/merge/publication semantics; this file governs the
command surface and who-does-what.

D-057 amendment (2026-07-23): HELD publish is now UNIFIED on one key — does a
MARKER-CLEAN resolution exist? Marker-clean (the agent actually resolved) → an
ACTIVE (non-draft) PR at the resolved merge commit that the OWNER reviews & merges
(the driver NEVER auto-merges a HELD PR — auto-merge stays JUDGED); unresolved
(markers remain / no valid resolution) → a DRAFT PR built from the PRISTINE conflict
(clean-prefix commit + the original upstream-vs-ours conflict, ZERO agent edits).
Scope-exceeded-but-cold-read-agreed and twice-cold-read-rejected escalate to a
flagged HELD PR (`[AUTO-ESCALATED: …]` prefix + reviewer feedback). The old
draft-only HELD model and the demote-on-scope-before-cold-read step are RETIRED.
Blockedness is the `merge_status ∈ {PR_ID | DEFERRED | NONE}` block model (invariant
`blocked ⇔ merge_status != NONE`), replacing the independent freeze fields. See
MERGE-POLICY.md §1 for the full semantics.

## 1. Principle

- The DRIVER is a resumable state machine owning ALL state (pinned watermark, current
  case, phase, journal) in the pass dir. Crash-resumable: a dead container resumes at
  the exact phase; a silent death is impossible (every report is journal-derived).
- The AGENT has ZERO identifying params. It only: (a) edits code in the driver-prepared
  worktree, (b) writes a free-text PR description at a fixed path, (c) claims one
  `--tier` word. No `--case`, no `--resolved-ref`, no plan/branch/sha — the driver
  holds all of it. This structurally removes the wrong-case / wrong-ref / stale-verdict
  / forged-plan / delete-wrong-file bug classes.
- The ONLY LLM call inside the loop is the COLD READ, run by the driver via `claude -p`
  (synchronous subprocess; context-free by process isolation; the driver pipes the
  request in and reads the verdict from stdout — no verdict file, no freshness binding).
- Bounded reasoning that is NOT an LLM call: candidate inheritance is deterministic git
  derivation (first-parent lines, merge-base, reachability closure — D-045); ambiguity
  escalates to the OWNER, never to `claude -p`. Overlap/PoI is annotate-class awareness
  surfaced to the owner as a report, not an inline gate in the case loop.

## 2. Commands

### `sweep start`
- Refuse if a pass is already open (require `finish` or `abort` first) — never
  blind-wipe an in-flight pass (that stranded resolved-but-unpushed merges before).
- Pin the top upstream commit = watermark; ALL downstream work is against it.
- Reset working state to a known base; initialize the journal.
- **Clean-slate boundary (D-055):** the pass lives at ONE canonical location
  `<--workspace>/propagation/pass-<watermark12>`, printed by `start` and `status`.
  `--workspace` is the GROUP ROOT (parent of the clone), defaulted from `--repo`;
  `start` REFUSES a workspace that IS `--repo`'s toplevel or a subdirectory of it
  (ERR37) so the pass never lands in the clone (which split per-pass state from
  the durable group ledger + rr-cache and killed rerere) — a group root nested in
  an OUTER git repo (the real server, `~/nanoclaw2`) is accepted. After the
  open-pass refusal, `start` removes the
  WHOLE prior pass tree at the canonical location (worktrees + case dirs +
  `coldread-*` + `pr/`) so no leftover journal/HELD or poisoned
  `coldread-verdict.json` is ever inherited. `abort` seals the pass with
  `pass-complete` (like `finish`) so it is never re-attached. The driver owns the
  lifecycle; teardown runs IN-CONTAINER (host `rm` fails on container-uid files).

### `sweep next-case`
- Deterministic, internal, no `claude -p`: fetch, scan, plan (DAG/breadth-wise order),
  execute CLEAN merges + no-op skips + DEFERRED holds (the `merge_status` block
  model, MERGE-POLICY §1), advance to the next conflict.
- Handles the barrier/reopen internally (resolve reopens descendants; next-case just
  serves the next ready case). The agent never sees the DAG.
- Prepares the conflict worktree for that case.
- Returns EITHER:
  - `case ready` — worktree path, branch, conflicted files, and what changed since
    start/last call (driver-authored case materials, D-048); OR
  - `no more cases — finalize` → agent calls `finish`.

### `report-case --tier mechanical|judged|held`
- `--tier` is the ONLY agent param — a CLAIM; the driver is demote-only.
- Driver, blocking, internal (deterministic first): snapshot the worktree tree →
  uncommitted/empty check → scope guard (resolution diff ⊆ conflicted paths; a
  violation no longer demotes to HELD here — `scopeExceeded` is CARRIED forward to
  the cold read, D-057) → branch-scoped tests (cheap; NOT the full rebuild) →
  ERR05 recorded-decision / adequacy → per-case attempt cap (force-HELD beyond N,
  D-052).
- COLD READ placement — fires once per case, where all reviewable content exists:
  - `mechanical` (no description ever): cold read (`claude -p`) HERE, over the
    resolution diff. Confirm → merge in place → `merged, take next case`. Confirm
    but scope-exceeded → HELD publishing the resolution as an ACTIVE PR (owner
    reviews & merges; escalation prefix + reviewer feedback, D-057). Reject → the
    reviewer's short feedback is returned for a revise-and-retry (1st strike, no
    freeze); the 2nd reject stops retrying and escalates to HELD (D-057).
  - `judged` / `held`: NO cold read here (deferred to `report-pr`, §report-pr).
    On deterministic pass → `provide PR description`.
- Return instructions (examples, authoritative): `merged, take next case` /
  `provide PR description` / `can't report judged with conflicts present, use held` /
  `uncommitted` / `tests failed: <details path>` / `cold read rejected — revise the
  resolution and re-run` (1st strike) / `held` (scope-exceeded, or the 2nd cold-read
  reject, D-057).
- Pure function of (current case, worktree tree). Re-callable; no accumulating loop
  state beyond the journaled attempt cap.

### `report-pr`  (judged and held only; mechanical has no PR)
- Reads the agent's free-text PR description from the fixed path.
- SINGLE cold read (`claude -p`) over the resolution diff AND the description together
  (one call covers both code and prose): judges resolution soundness AND whether the
  description misrepresents the code. This is the kept kind-1 read with the
  description in view — NOT the retired standalone prose gate (D-050); adequacy
  (ERR05 / duplicate) stays mechanical.
- Verdict handling (D-057):
  - Description-only defect on a sound resolution → `rewrite: <reason>` (agent
    rewrites, re-calls) — NOT a freeze.
  - Resolution rejection (incl. UNVERIFIABLE-FROM-REQUEST, which fails closed) is
    COUNTED per case. On a `judged` claim the 1st reject returns the reviewer's
    feedback for a revise-and-retry (re-snapshots the worktree, no freeze); the 2nd
    reject stops retrying and escalates to HELD. On a `held` claim a reject keeps the
    case frozen-and-unpublished and returns `rewrite` until the description is
    accurate.
  - Confirm on a `judged` claim but scope-exceeded → HELD publishing the resolution
    as an ACTIVE PR (owner reviews & merges; escalation prefix + reviewer feedback).
- On pass, by tier:
  - `held`: PUBLISH THE HELD PR NOW via the UNIFIED publish (D-057) — push the
    `fix/sweep` branch and open the PR. Active-vs-draft is decided by whether a
    MARKER-CLEAN resolution exists: marker-clean (the agent actually resolved) → an
    ACTIVE (non-draft) PR at the RESOLVED merge commit, which the OWNER reviews &
    MERGES (the driver NEVER auto-merges a HELD PR — auto-merge stays JUDGED);
    markers remain / no valid resolution → a DRAFT PR built from the PRISTINE
    conflict (clean-prefix commit + the original upstream-vs-ours conflict, ZERO
    agent edits, so the owner resolves fresh rather than the agent's mangled try).
    Escalated holds (scope-exceeded / cold-read-rejected-2x / non-convergence cap)
    prepend an `[AUTO-ESCALATED: …]` prefix + the reviewer feedback to the
    description. Reason: the driver auto-merges nothing here, so publishing it lands
    nothing on a target branch by itself, and the owner should see the held case the
    moment it is frozen (D-047: a prepared-but-unpublished PR is useless).
  - `judged`: RECORD PR INTENT ONLY; the PR is created and closed at `finish` (§finish).
    Reason: a JUDGED PR is history that AUTO-MERGES when its merge commit is pushed to
    the target branch — that push must clear the full-integration verify (below), so it
    cannot happen mid-pass. It is a record nobody acts on early; create-early/merge-late
    would be two-phase complexity for no owner benefit.
- Then → `take next case`.

### `sweep finish`
- The ONLY thing gated to here is anything that LANDS CODE ON A TARGET BRANCH — because
  the full-integration verify (everything-rebuild, D-012) is the only gate that catches
  semantically-broken-but-clean cross-branch merges, and it cannot run until all cases
  are resolved (the integrated tree is incomplete before then).
- Steps, in order (MERGE-POLICY §5):
  1. verify the publishable set (full rebuild, D-051 semantics: this pass's advanced
     branches on main_patched; held/frozen excluded; red on a publishable branch →
     rollback to pre-ref + HELD(gate); red on a non-publishable branch → non-blocking).
  2. push target branches (CLEAN / MECHANICAL / prefix merges).
  3. push JUDGED closures (same merge commit → PR auto-flips merged); create the JUDGED
     history PRs.
  4. (HELD PRs — active or draft, D-057 — are already published from `report-pr`.)
  5. post urge comments (D-004 pending-count) on frozen branches with new pending heads.
  6. journal-derived owner report (which PRs need the owner, or the done-line).
  7. check upstream advanced past the pinned watermark → `start again` or `done`.
- Multi-step and resumable: a red verify or `ERR15_PUSH_FAILED` (proxy) → report +
  HALT + re-runnable from the stopped phase; pushes never redo.

## 3. Publish-timing rule (the reasoning, one line)

Postpone iff the DRIVER's action LANDS CODE ON A TARGET BRANCH (needs the
full-integration verify): CLEAN / MECHANICAL / JUDGED-closure → `finish`. A HELD PR
(active or draft, D-057) is published at `report-pr`: the driver never auto-merges a
HELD PR, so publishing it lands nothing on a target branch by itself.

## 4. Division of labor

- AGENT (tools, iteration): resolve the conflict code; write the PR description; claim
  `--tier`. Nothing else — a one-shot `claude -p` is bad at open-ended resolution, which
  is why this alone stays the agent.
- DRIVER `claude -p` (one-shot, context-free): the cold read only.
- DRIVER code (deterministic): fetch / scan / plan / merge / DAG / candidate inheritance
  (git ancestry + merge-base + reachability) / verify / push / PR create+close / git /
  state / journal.
- OWNER (escalation via report, never inline chat): HELD PR review (active PRs the
  owner merges; draft pristine-conflict PRs the owner resolves); ambiguous candidate
  inheritance; overlap/PoI awareness; genuine failures (ERR15, etc.).

## 5. Properties

- Crash-resumable; silent death impossible.
- Zero agent identifying params → the misdirection bug classes are structurally gone.
- Scope guard preserved and strengthened (the agent cannot point the driver at the
  wrong case).
- Owner surface = HELD PRs (active or draft) + the one journal-derived report; JUDGED
  PRs are history.
- The agent doctrine collapses to: call these five commands in order; do what each
  returns.
