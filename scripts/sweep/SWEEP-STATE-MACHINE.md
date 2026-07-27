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

D-058 amendment (2026-07-23): publish timing + a stateless origin-derived `start`.
(a) EVERY PR is now created at `finish`, after the full-integration verify — JUDGED
history AND HELD (active/draft). `report-pr` publishes NOTHING; it records the publish
intent (tier, resolved commit, active-vs-draft, escalation prefix + feedback) into the
journal, and `finish` creates all PRs from it. So even an ACTIVE held-review PR sits on
the verified tip (it can no longer bypass the verify gate), and a pass that crashes
before `finish` leaves no PR on origin.
(b) `sweep start` is NETWORKED and origin-derived. It fetches origin+upstream (fetch
failure = ERR39), then reconstructs the blocked set from the origin `fix/sweep/*` refs
— merged into `origin/<target>` → resolved + delete the ref; unmerged WITH an open PR →
blocked; unmerged WITHOUT a PR → orphan, delete it. It reads the GitHub token from the
ENVIRONMENT (`GH_TOKEN`, fallback `GITHUB_TOKEN`) at each networked write — the agent
manages no token file (D-060; `--token-file` survives as an internal/test override). The ledger `merge_status` authority (and the D-057
reconcile/settle machinery) is retired: the local pass dir is disposable, so `start`
always re-derives a clean picture from origin.

D-059 amendment (2026-07-24): held PRs become a review-driven loop; `finish` is
per-branch push-resilient. Supersedes the D-058 orphan-delete.
(a) `start` re-classifies every origin `fix/sweep/*` ref (`deriveOriginMergeStatus`):
merged / squash-rebase-merged → resolved + delete (the ONLY delete; NEVER a reopen);
closed-unmerged → REOPEN → PR_ID; ref-present-no-PR → recover (create PR from the ref) →
PR_ID; ref-absent → re-derive fresh. For an OPEN held PR the driver reads its SUBMITTED
reviews (not comments): a reissue is due iff a non-`*[bot]` review exists beyond the
`<!-- sweep-addressed: <review_id> -->` marker. APPROVED + still-clean → the driver LANDS
it (merges into the local target; `finish` verifies + pushes → the PR auto-flips merged);
APPROVED + stale, CHANGES_REQUESTED, COMMENTED, other → REISSUE. Loose issue/inline
comments never trigger — they only feed the dialog.
(b) A REISSUE case is manufactured at `start` (`materializeReissueCase`): the conflict is
re-probed live against `origin/<target>`, the worktree is materialized FROM the prior
resolution (owner-pushed edits rebuilt from the current ref head), and the FULL
time-ordered review dialog is stored for the materials. `report-case` ALWAYS forces the
reissue HELD; `report-pr` records intent; `finish` republishes to the SAME PR
(force-with-lease onto the existing fix ref) — never a second PR.
(c) `finish` pushes per-branch (`cmdPush`): a failure is categorized + journaled
(`ERR15` a per-branch LABEL, not a stop); a partial finish is not sealed and is
RESUMABLE (landed branches skip, failed retry). The one success/partial `SWEEP-RESULT`
carries `pullRequests` + `stats` (landed/failed by category, PRs created/reissued/
reopened/recovered) + an instruction to report landed-vs-conflicted to the owner. Only a
GLOBAL failure (verify/token/closure) halts. See MERGE-POLICY.md D-059 for the semantics.

D-060 amendment (2026-07-25): ONE quality gate, and a smaller agent surface.
(a) `report-case` is the single gate for ALL tiers: a new CHECKS GATE (typecheck THEN
tests, from the repo-shipped `scripts/sweep/checks.json`, `ERR36`/`ERR40`, reset-on-pass
counter, `CHECKS_FAIL_LIMIT`=10 → pristine HELD DRAFT) followed by the cold read, which
now runs for judged and held too. `report-attempt` is recorded POST-checks, so
`RESOLVE_COLDREAD_CAP` counts only trees that reached the reviewer.
(b) `report-pr` is PR AUTHORING ONLY — no cold read, no checks, no network. The cold
reader never sees PR prose again, so the `defect: description` verdict (and the prose
rewrite loop it drove) is RETIRED: every reject is a resolution reject.
(c) Agent surface: execute is the DEFAULT (`--dry-run` opts out); the GH token comes from
the ENVIRONMENT; `start` resolves and PINS the inventory + checks-file into pass state,
so no later command takes either flag. PR text is `pr/body.md` with an H1 first line.
(d) RED TESTS at `finish` with no attributable offender STOP the pass (publish nothing,
report to the owner) instead of halting resumably.
(e) An in-flight networked 401/403 is `ERR41_TOKEN_REJECTED`, not the generic
`ERR13_API_FAILED` whose contract is "retry once" — a retry with the same rejected token
can never clear it. Because (c) makes the driver pick a token off the environment
silently, the detail NAMES THE SOURCE (`--token-file <path>` / `$GH_TOKEN` /
`$GITHUB_TOKEN`) and never echoes the token, so a stale ambient `$GITHUB_TOKEN` is
distinguishable from a revoked grant. Fail-closed behavior is unchanged.

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
- **NETWORKED + origin-derived (D-058):** `start` first `git fetch`es origin and
  upstream (a fetch failure is `ERR39`, so a pass never opens on a stale view), then
  reconstructs the blocked set from the origin `fix/sweep/*` refs BEFORE planning
  (D-059 FINAL — the orphan-delete of D-058 is RETIRED, a MERGED ref is now the ONLY
  delete): merged / squash-rebase-merged into `origin/<target>` → resolved, delete the
  ref (NEVER a reopen on a merged PR); closed-unmerged PR → REOPEN it → blocked;
  ref-present-with-NO-PR (crashed publish) → RECOVER — create the PR from the ref head →
  blocked; ref-absent → re-derive the conflict fresh. For an OPEN held PR the driver
  reads its SUBMITTED reviews and reissues iff a non-`*[bot]` review exists beyond the
  `<!-- sweep-addressed: <review_id> -->` marker (`classifyReviewTrigger`): APPROVED +
  still merges cleanly → the driver LANDS it (`landApproved` — merges into the local
  target now, journals `origin-approved` + `resolved` tier `approved`, leaves the branch
  UNBLOCKED; `finish` verifies + pushes → the PR auto-flips merged); APPROVED-but-stale /
  CHANGES_REQUESTED / COMMENTED / other → REISSUE (`materializeReissueCase`). Loose
  issue/inline comments never trigger; they only feed the reissue dialog. It takes
  the GH token from the environment (`GH_TOKEN`/`GITHUB_TOKEN`; missing while unmerged
  refs exist = `ERR11`), and every lookup/write is fail-closed (non-200 = `ERR13`). The
  ledger's `merge_status` is no longer read — the pass dir is disposable and `start` is
  idempotent on origin; a pass that crashed before `finish` published nothing, so the
  re-derived picture is clean.
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
- **REISSUE case (D-059 FINAL):** when `next-case` served a reissue (a held PR got a new
  review), the worktree already holds the PRIOR RESOLUTION as the pending files and the
  case materials carry the FULL time-ordered review dialog. The agent REVISES that
  resolution to address the review — it does NOT restart, and edits stay in the
  conflicted paths. `report-case` ALWAYS forces the reissue to HELD (whatever the claimed
  `--tier`) so a revision never merges in place and bypasses the open review; the sole
  exception is the APPROVED-still-clean case, which the driver already LANDED at `start`
  (no reissue served). The revision then flows `report-pr` → `finish`, which republishes
  to the SAME PR (force-with-lease onto the existing fix ref) — never a second PR.
- Driver, blocking, internal (deterministic first): snapshot the worktree tree →
  uncommitted/empty check → scope guard (resolution diff ⊆ conflicted paths; a
  violation no longer demotes to HELD here — `scopeExceeded` is CARRIED forward to
  the cold read, D-057) → ERR05 recorded-decision / adequacy.
- **THE SINGLE QUALITY GATE (D-060).** `report-case` is where a resolution is
  judged — for ALL THREE tiers — and it is the only stage that runs checks or a
  cold read. A RESOLVED case (no conflict markers left) passes through, in order:
  - **5a. CHECKS GATE.** `checks.typecheck` THEN `checks.test`, run in the case
    worktree from the pass's pinned `checks.json` (shipped in the repo; a missing
    file or empty list skips that gate). A failure writes
    `<caseDir>/{typecheck,test}-output.txt`, journals `checks-fail`, and returns
    `ERR36_TYPECHECK_FAILED` / `ERR40_TESTS_FAILED` with "read the output, fix the
    pending files, re-run report-case" — the phase stays `case-ready` and NO
    report-attempt is charged. All green → `checks-pass` (which RESETS the
    counter). At `CHECKS_FAIL_LIMIT` (10) consecutive failures the driver stops
    asking: it resets the worktree to the PRISTINE conflict and freezes a HELD
    DRAFT tagged `[AUTO-ESCALATED: checks failing]` — the agent's failing
    resolution is never published.
  - **5b. report-attempt** is recorded HERE, post-checks, so `RESOLVE_COLDREAD_CAP`
    counts only trees that actually reached the reviewer. Beyond the cap → HELD
    ACTIVE, `[AUTO-ESCALATED: resolution did not converge]`.
  - **5c. COLD READ** (`claude -p`) over the RESOLUTION DIFF ONLY — no PR prose
    exists yet, so there is nothing else to judge and no defect to classify; every
    reject is a resolution reject. Infra failure → `ERR35` hard halt (case stays
    put). Reject → the reviewer's short feedback is returned for a
    revise-and-retry (1st strike, no freeze); the 2nd reject escalates to HELD
    ACTIVE. Confirm + scope-exceeded → HELD ACTIVE (owner reviews & merges;
    escalation prefix + feedback, D-057). Confirm + in-scope, by tier:
    `mechanical` → merge in place → `merged, take next case`; `judged` → `provide
    PR description` (the merge itself lands at `report-pr`); `held` → freeze HELD
    ACTIVE → `provide PR description`.
  - A `held` CLAIM on a still-pristine conflict skips 5a-5c entirely (there is no
    resolution to check or read) — straight to HELD DRAFT + `provide PR
    description`, based on the pristine conflict.
- Return instructions (examples, authoritative): `merged, take next case` /
  `provide PR description` / `can't report judged with conflicts present, use held` /
  `uncommitted` / `read <output-file> …, fix the pending files, re-run report-case`
  (ERR36/ERR40) / `cold read rejected — revise the resolution and re-run` (1st
  strike) / `held` (scope-exceeded, the 2nd cold-read reject, the convergence cap,
  or the checks limit).
- Pure function of (current case, worktree tree). Re-callable; no accumulating loop
  state beyond the journaled attempt cap.

### `report-pr`  (judged and held only; mechanical has no PR)
- **PR AUTHORING ONLY (D-060).** NO cold read, NO checks, NO tests, NO network —
  the single quality gate already ran at `report-case`, and re-reading here would
  be a second `claude -p` over content that was already judged.
- PR text: `pr/body.md` in the case dir, whose FIRST line is the H1 title
  (`# <title>`); everything below it is the body. (A legacy `pr/title.txt` +
  `pr/body.md` pair is still accepted; the resolved values are normalized back to
  both files so the finish-time publish reads them unchanged.) A missing title or
  body → `ERR08_TEXT_MISSING`; the driver NEVER generates PR prose (D-048).
  Deterministic text checks add `WARN01_TEMPLATE_TEXT` / `WARN02_NO_DECISION_LINE`
  — advisory, never blocking.
- On pass, by tier — RECORD PR INTENT, PUBLISH NOTHING (D-058). Every PR is created at
  `finish`, after verify; `report-pr` only journals what to create:
  - `judged`: merge the resolution in place on the branch, then record the PR intent —
    the JUDGED history PR is created at `finish`, before the target push that
    auto-flips it to merged. (A JUDGED PR auto-merges when its merge commit reaches the
    target branch, and that push must clear the full-integration verify, so it cannot
    happen mid-pass.)
  - `held`: record the held PR intent — active-vs-draft decided by whether a
    MARKER-CLEAN resolution exists: marker-clean (the agent actually resolved) → an
    ACTIVE (non-draft) PR at the RESOLVED merge commit, which the OWNER reviews &
    MERGES (the driver NEVER auto-merges a HELD PR — auto-merge stays JUDGED); markers
    remain / no valid resolution → a DRAFT PR built from the PRISTINE conflict
    (clean-prefix commit + the original upstream-vs-ours conflict, ZERO agent edits, so
    the owner resolves fresh rather than the agent's mangled try). Escalated holds
    (scope-exceeded / cold-read-rejected-2x / non-convergence cap) prepend an
    `[AUTO-ESCALATED: …]` prefix + the reviewer feedback to the description. `finish`
    creates it AFTER verify + the target pushes, so the base is current (the HELD diff =
    the case run only) and the ERR14 held-ordering holds for every held PR.
- Then → `take next case`.

### `sweep finish`
- The ONLY thing gated to here is anything that LANDS CODE ON A TARGET BRANCH — because
  the full-integration verify (everything-rebuild, D-012) is the only gate that catches
  semantically-broken-but-clean cross-branch merges, and it cannot run until all cases
  are resolved (the integrated tree is incomplete before then).
- The ONLY stage that publishes ANYTHING (D-058: all PRs are created here, after
  verify). Steps, in order (MERGE-POLICY §5):
  1. verify the publishable set (full rebuild, D-051 semantics: this pass's advanced
     branches on main_patched; held/frozen excluded; red on a publishable branch →
     rollback to pre-ref + HELD(gate); red on a non-publishable branch → non-blocking).
     The gate runs `checks.test` (host + runner) from the pass's pinned `checks.json`.
     **RED TESTS WITH NO SINGLE-BRANCH OFFENDER STOP THE PASS (D-060):** the failing
     names are journaled (`finish-tests-failed`) and the result is
     `status:"stopped"`, `stoppedAt:"finish-tests"`, `ERR40_TESTS_FAILED`,
     "REPORT to the owner … publish nothing" — nothing is pushed or published.
     Fixing red tests is code work or an owner decision, never a re-run; that is
     distinct from the attributable red above, which rolls the offender back and
     IS resumable (`halted:"verify"`, `ERR18`).
  2. create the JUDGED history PRs (non-draft), before the target push.
  3. push target branches (CLEAN / MECHANICAL / prefix merges) + JUDGED closure pushes
     (same merge commit → the JUDGED PRs auto-flip merged) + closure checks + urge
     comments (D-004 pending-count) on frozen branches with new pending heads.
  4. create the HELD PRs — active (marker-clean resolution, owner merges) or draft
     (pristine conflict, owner resolves), D-057 — from the recorded intent. AFTER the
     target pushes so the bases are current and the ERR14 held-ordering holds; the
     driver NEVER auto-merges a held PR.
  5. journal-derived owner report (which PRs need the owner, or the done-line).
  6. check upstream advanced past the pinned watermark → `start again` or `done`.
- **PUSH RESILIENCE (D-059 FINAL):** step 3 pushes each target branch INDEPENDENTLY —
  a failure is categorized (diverged / transient / auth) and journaled per branch, and
  the remaining branches proceed. `ERR15_PUSH_FAILED` is now a PER-BRANCH LABEL, NOT a
  hard stop; a failed held publish (step 4) is likewise per-case and non-fatal. Only a
  GLOBAL failure with no per-branch rows (red verify, missing token, closure check)
  still HALTS `finish`. A partial finish is NOT sealed (machine state stays `finishing`),
  so re-running `finish` retries exactly the failed pushes/publishes — landed branches
  skip as up-to-date, verify re-gates, pushes/PR-creates never redo.
- **The one `SWEEP-RESULT` carries the pass summary (D-059 FINAL):** `status`
  (`complete` | `partial`), `pullRequests` (every PR the pass touched — open-at-start /
  reopened / recovered / judged-history / held-review / held-review-reissued /
  approved-landed — each with number, url, title, live status, `kind`, and a
  landed/failureCategory annotation), `branches` (per-branch landed vs failed),
  `failedPushes` / `failedPublishes`, a `stats` block (branches in scope, clean merges,
  resolved mechanical/judged, approved-landed, held, deferred branches, PRs created-judged
  / created-held / reissued / reopened / recovered / open-at-start, targets landed/failed
  by category, upstream-advanced, watermark), and an `instruction` telling the agent to
  REPORT the landed-vs-conflicted branches + the PR list + stats to the owner.
- Multi-step and resumable: a red verify or a GLOBAL `finish` halt → report + HALT +
  re-runnable from the stopped phase; pushes and PR-creates never redo. A pass that
  crashes BEFORE `finish` has published nothing — the next `start` re-derives a clean
  origin picture and redoes the pass.

## 3. Publish-timing rule (the reasoning, one line)

ALL publication happens at `finish`, after the full-integration verify (D-058): CLEAN /
MECHANICAL / JUDGED-closure land code on a target branch, so they need the verify gate;
and HELD PRs (active or draft) are created there too — even though a HELD PR lands
nothing on a target branch itself, creating it at `finish` keeps it on the verified tip
and off origin when a pass crashes mid-way. `report-pr` records the publish intent;
`finish` is the single publish point.

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
