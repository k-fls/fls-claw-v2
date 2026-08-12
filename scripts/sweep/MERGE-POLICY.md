# Merge & publication policy — canonical

This file is the AUTHORITY on tiers, batching, noise, review, and publication.
`PROPAGATION.md` holds driver mechanics; on conflict, this file wins. The AGENT
drives these tiers through the SWEEP STATE MACHINE (`SWEEP-STATE-MACHINE.md`:
`start` / `next-case` / `report-case --tier` / `report-pr` / `finish`) — the
state machine wraps these semantics and governs the command surface.

Publication timing, in one line: EVERY PR — JUDGED history and HELD (active or
draft) alike — is created at `finish`, AFTER the full-integration verify is
green. `report-pr` publishes NOTHING; it records the publish intent (tier,
resolved commit, active-vs-draft, escalation prefix + reviewer feedback) into
the journal, and `finish` creates all PRs from that. A pass that crashes before
`finish` has published nothing.

## 1. Merge tiers (per parent→branch merge attempt)

| Tier | Trigger | Action | Review | PR |
|---|---|---|---|---|
| CLEAN | no textual conflict (merge-tree) | bulk direct merge | none | none |
| MECHANICAL | conflict the agent is allowed to resolve (qualification: §7) | direct merge | cold-read confirm required | none — journal + cold-read artifact only |
| JUDGED | non-obvious conflict, agent-resolved | merge; same commit pushed to target → PR auto-marks merged | cold-read confirm required | yes (history) |
| HELD | unresolved / cold-read reject×2 / scope-guard violation / red verify gate / non-convergence cap / escalation | clean prefix merges first; PR head = the resolved merge commit if marker-clean, else the pristine conflict | **owner** (the only review state) | ACTIVE PR (marker-clean resolution, owner merges) or DRAFT PR (pristine conflict), real diff |
| DEFERRED | own conflict at height h ≥ MIN(blocked DIRECT parents' heights); a parent is blocked ⇔ `merge_status != NONE` | clean prefix committed; STOP — no merge above, NO PR; sticky while any direct parent is blocked; clears when all parents NONE → re-merge fresh | none | none |

Tier rules:
- CLEAN vs conflict: computed (merge-tree). MECHANICAL vs JUDGED: agent-claimed,
  driver demote-only.
- Floors: `edition/*` and `tier_floor: judged` entries → min JUDGED. Edition
  JUDGED **auto-merges** (intended); owner-gating happens only by escalation to
  HELD.
- Blocked = the `merge_status` block model: per branch `merge_status ∈
  {PR_ID | DEFERRED | NONE}` (NONE = absent field) and `blocked(X) ⇔
  merge_status(X) != NONE` ALWAYS. No height/path is stored — heights are live
  per-pass values. PR_ID persists from the hold until the branch is COMPLETELY
  resolved (the owner resolves the PR AND the merge lands on the branch), never
  cleared at any intermediate step; DEFERRED is sticky while any direct parent
  is blocked. This is the WITHIN-PASS model; across passes the block set is
  carried by ORIGIN — the live `fix/sweep/*` ref plus its open PR — never by a
  local store, so the pass dir is disposable and `sweep start` re-derives a
  clean picture every time.
- Blocked-state derivation at `sweep start` (networked; fetch first — a fetch
  failure is `ERR39_FETCH_FAILED`, a pass never opens on a stale view). Per
  origin `fix/sweep/*` ref: merged into `origin/<target>` (head is an ancestor)
  OR the PR reports `merged_at` (squash/rebase-merged) → resolved + DELETE the
  ref — a MERGED ref is the ONLY delete, and never triggers a reopen;
  closed-unmerged PR → REOPEN it (PATCH `state=open`) → PR_ID; ref present with
  NO PR (a crashed publish) → recover — create the PR from the ref head, the
  ref's resolution authoritative, never re-derived → PR_ID; ref ABSENT →
  re-derive the conflict fresh (new case → new PR at `finish`); a ref whose slug
  matches no scope branch is journaled `origin-ref-unknown` and left alone.
  Every lookup/write is fail-closed (non-200 = ERR13; missing token while
  unmerged refs exist = ERR11) — an API failure never reads as "no PR" and never
  deletes a ref with a live PR.
- Case worktree = a PENDING DIFF: the driver commits the CLEAN PREFIX (the
  automerge tree with the conflicted paths reset to base/ours) as the case
  worktree's HEAD and writes ONLY the conflicting delta (marker content) into
  the working tree, so `git status` shows exactly the conflicted paths and the
  agent reviews/edits only that delta — never the whole tree. On-disk bytes and
  the `add -A; write-tree` snapshot equal a full checkout, so the empty-check,
  scope guard, and cold-read diff see the same content.
- Only HELD needs external review. HELD is the ONLY review state: anything
  review-worthy at any tier is ESCALATED to HELD and inherits ALL HELD rules.
- HELD publish is UNIFIED on one key — does a MARKER-CLEAN resolution exist?
  Marker-clean (the agent actually resolved) → ACTIVE (non-draft) PR at the
  resolved merge commit; the owner reviews & merges — the driver NEVER
  auto-merges a HELD PR (auto-merge stays JUDGED). Markers remain / `--tier
  held` with no valid resolution → DRAFT PR built from the PRISTINE conflict
  (clean-prefix commit + the original upstream-vs-ours automerge tree, NO agent
  edits — the owner resolves fresh, never an invalid attempt).
- The quality gate is SINGLE and lives at `report-case`. Every RESOLVED case
  clears a CHECKS GATE (typecheck THEN tests, from the repo-shipped
  `scripts/sweep/checks.json`) before the cold read, and the cold read runs for
  ALL tiers there — judged and held included. A checks failure returns
  `ERR36_TYPECHECK_FAILED` / `ERR40_TESTS_FAILED` for a fix-and-re-run and
  charges no report-attempt; at `CHECKS_FAIL_LIMIT` (10) consecutive failures
  the driver resets the worktree to the pristine conflict and freezes a HELD
  DRAFT (`[AUTO-ESCALATED: checks failing]`) — a failing resolution is never
  published. A checks file that does not PARSE is loud
  (`ERR43_CHECKS_MALFORMED`, at `start`, `report-case`, and `finish`); an
  ABSENT one skips silently (intended). A failed worktree reset is
  `ERR44_WORKTREE_RESET_FAILED`, never reported as "the worktree is pristine".
  `report-pr` is PR AUTHORING ONLY — it reads `pr/body.md` (H1 first line =
  title) and records intent, with no cold read, no checks, and no network. The
  cold reader never sees PR prose, so every reject is a resolution reject.
- Scope guard: resolution diff ⊄ allowed set. Lever: `same-files` (default;
  extra file = violation) / `conflict-hunks` (strict; must stay in marker
  regions). A scope violation does not demote to HELD BEFORE the cold read:
  `scopeExceeded` is carried forward, the cold read judges the RESOLUTION, and
  if it AGREES the case is HELD publishing that resolution — an ACTIVE PR
  flagged `[AUTO-ESCALATED: scope exceeded]` (owner merges; never auto-merged).
  Scope OK + agrees → JUDGED; rejects → the reject path below.
- Cold-read rejections are COUNTED per case: the 1st reject does NOT freeze —
  the reviewer's short feedback is surfaced to the agent to revise and re-run;
  on the 2nd reject the driver stops retrying and passes the case HELD (ACTIVE
  if marker-clean, else DRAFT pristine conflict) with `[AUTO-ESCALATED: cold
  read rejected 2x]` + the reviewer feedback prepended to the PR description.
  Independently, a resolution whose tree keeps CHANGING beyond the convergence
  cap is force-HELD with `[AUTO-ESCALATED: resolution did not converge]`.
- Red verify gate → HELD(gate).
- DEFER rule = PURE HEIGHT-MIN over blocked DIRECT parents: X's own conflict at
  height h is DEFERRED iff some direct parent is blocked AND h ≥ MIN(blocked
  parents' heights). Below that MIN every parent is clean, so the conflict is
  X's OWN (normal ladder → its own PR). No path check, no per-transitive-
  ancestor window: a clean intermediate parent (merge_status NONE) correctly
  stops propagation until it re-merges the resolved content.

## 2. Case unit — commit stacking

- A case = the MAXIMAL RUN of consecutive conflicting heights whose conflicted
  path sets intersect (one logical decision), capped (default 5, configurable).
- The run breaks at: a clean height, a disjoint-path conflict (own case later),
  the cap.
- Applies to ALL conflict tiers: MECHANICAL/JUDGED resolve the run as one case
  (one cold-read); HELD's PR head = the run's TOP commit → diff = the whole run.
- The DEFER height-check (run top vs MIN blocked-parent height) and urge
  tracking are computed against the run's top.
- Never stack disjoint-path conflicts; never stack across a clean height.

## 3. Hierarchy / batching

- Merge sources: `main` ← upstream FF only; `main_patched` ← `main`; every
  other branch ← inventory parents' tips ONLY (edition-composition branches ←
  `main` only — DESIGN.md §10). Never upstream directly.
- Order: breadth-wise; a branch is processed only after ALL parents arrived
  this pass (HELD/empty-interval counts as arrival).
- Pass: watermark pinned at `plan`; heads = {sha, height} on the trunk
  first-parent chain; coverage derived, never stored; only `plan` opens a pass;
  `run`/`report-case` attach to it.
- Merge point: full-range probe first (1 probe, common case); on conflict
  linear sweep; merge at LARGEST clean height (may skip past intermediate
  conflicting heights); the case starts at the smallest conflicting height
  above it (stacked per §2). Never bisect conflicts.
- Only the interval's upper bound is strict; the lower bound extends
  automatically for branches that skipped/froze earlier (a merge carries full
  ancestry).
- After HELD: the clean prefix below the conflict still merges; descendants
  receive the partial tip.
- Resolve reopens the branch + transitive descendants → same-pass continuation
  to the watermark.
- ONE HIERARCHY (`scripts/sweep/hierarchy.ts`), keyed by BRANCH — inventory
  `parents` hold branch NAMES, not entry ids. `depth = 1 + MAX(parent depths)`:
  a branch merges only after ALL its parents, so its position is governed by
  its DEEPEST one. `minPath` = the shortest chain to `main`, excluding `main` —
  what a report or an escalation names. Unresolvable → `null`, sorted LAST,
  never 0. `parents` is MERGE topology: a branch CUT from another that its
  entry does not declare as a parent lands at the wrong depth — visible as
  blame refusing a tie (§8) rather than as a wrong answer.

## 4. Noise minimization

- No-op merge (merge-tree result tree == branch tree) → skip, journal only, no
  merge commit.
- Exception: leaves + `always_merge` entries must land ≥ 1 real merge per pass
  with progress; if all chains no-op'd → un-skip the CHEAPEST parent chain
  (empty merge commits top-down). No merge-main-directly shortcut.
- One case at a time per branch (halt at first conflict run); one branch's case
  never blocks siblings, only descendants.
- Same conflict resolved once at the topmost affected branch; descendants
  inherit via parent merge + shared rerere (`rerere.enabled` set repo-wide in
  the agent clone).
- JUDGED PR closure: push the SAME merge commit → no merge-of-merge commits.
- Blocked branch: skipped every pass; one posted urge comment per NEW pending
  head — "last urged" is read from the PR's own `sweep-urge` comment markers,
  never a local cache — silent otherwise.
- MECHANICAL: no PR at all — journal + cold-read artifact only.

## 5. Publication & pushes

- The DRIVER pushes; the agent NEVER hand-pushes anything — driver-journaled
  pass pushes are the only pushes.
- Nothing is pushed OR published before the full-integration verify is green
  for the pass; this extends to ALL PR creation.
- ALL PRs are created at `finish`, after verify; nothing is published at
  `report-pr` (it records intent only). Per-pass order at `finish`: create the
  JUDGED history PRs → push target branches (CLEAN/MECHANICAL/prefix merges) +
  the JUDGED closure push (same merge commit → those PRs flip to merged) →
  create the HELD PRs (active or draft; bases are then current, so the HELD
  diff = the case run only, and the ERR14 held-ordering holds for every held
  PR).
- `finish` pushes each target branch INDEPENDENTLY; a failure is categorized
  (diverged / transient / auth) and journaled — `ERR15` is a PER-BRANCH label,
  NOT a hard stop, and the remaining branches proceed. A held-publish failure
  is likewise per-case and non-fatal. A partial finish is RESUMABLE: the pass
  is not sealed, so re-running `finish` retries exactly the failed
  pushes/publishes (landed branches skip as up-to-date, verify re-gates);
  pushes and PR-creates never redo. The success/partial `SWEEP-RESULT` reports
  `pullRequests` (every PR the pass touched) and a `stats` block (landed/failed
  branches by category, PRs created/reissued/reopened/recovered) with an
  instruction to report landed-vs-conflicted to the owner. Only a GLOBAL
  failure with no per-branch rows (red verify gate, missing token, closure
  check) halts.
- Red verify at `finish`: a red on a publishable branch rolls the offender back
  to its pre-pass ref and holds it HELD(gate) — resumable. An unattributable
  red is blamed by git history and served as gate-fix case(s) (§8). Red tests
  with NO servable offender — no blameable branch, no parseable diagnostics, or
  the same files already attempted — STOP the pass (`ERR40_TESTS_FAILED`):
  publish nothing, report to the owner.
- Pre-PR height check (blocking ID): the origin base branch must be AT LEAST at
  the expected pass height; higher is fine (someone else committed);
  lower/diverged = halt.
- All GitHub writes go through the driver tooling with the ERR/WARN ID
  contract. Refs move via `git push` ONLY; the API is used for PR
  creation/comments (normal use), never to fabricate refs/commits as a push
  workaround. A networked 401/403 is `ERR41_TOKEN_REJECTED`: the detail names
  the token SOURCE (`--token-file` / `$GH_TOKEN` / `$GITHUB_TOKEN`) and never
  echoes the token; retrying with the same token cannot clear it.
- Infrastructure failures (e.g. pushes failing through the credential proxy)
  are REPORTED to the owner and never worked around — such issues are not
  sweep-agent duty.

## 6. Review & reporting integration

- Owner attention surface = HELD PRs (active or draft) + owner messages
  (candidates, failures, one end-of-sweep result). JUDGED PRs are history, not
  owner work.
- A blocked branch's HELD PR carries the count of further pending upstream
  commits, kept current via urge comments and a driver-maintained machine block
  in the PR body.
- HELD PR text: written by the AGENT from studying the case (materials +
  worktree); the driver provides facts only and never generates prose; text
  checks are mechanical (lint + the duplicate gate). Writing rules: no bare
  "review needed"; describe behavior, not line counts; label ours/theirs; no
  unexplained references.
- Held PRs are a two-way REVIEW loop:
  - **Trigger = SUBMITTED REVIEWS ONLY.** A held PR is re-served this pass (a
    REISSUE) iff a submitted, non-`*[bot]` review exists whose id is above the
    driver's `<!-- sweep-addressed: <review_id> -->` marker (or ≥ 1 such review
    and no marker yet). The marker is a driver comment recognized ONLY when it
    is a line by itself, id-bounded; bot/human split is by CONTENT (a shared
    PAT authors both), and the effective addressed id is the MAX over all
    marker occurrences (monotonic — a re-asserted value never regresses). Loose
    issue comments and standalone inline comments NEVER trigger a reissue —
    they feed the reissue dialog and nothing else. PENDING (unsubmitted)
    reviews are ignored.
  - **Review-state → action (all landing verify-gated at `finish`).** APPROVED
    + still merges cleanly into the CURRENT target → the DRIVER lands it: the
    fix-ref head is merged into the local target (journaled, pre-ref recorded
    so `abort` rolls back), the branch is left UNBLOCKED, and `finish`
    verifies + pushes the target — the push auto-flips the PR to merged. NO
    reissue, and the driver still never hand-merges the PR on GitHub.
    APPROVED + STALE (the target advanced past the point where the head merges
    cleanly) → REISSUE: the agent re-resolves against the new base, keeping the
    approved intent. CHANGES_REQUESTED / COMMENTED / other → REISSUE → forced
    HELD (the revision stays in the review loop; it never merges in place and
    bypasses the open review).
  - **Reissue feed = the FULL time-ordered dialog** (PR description + issue
    comments + inline review comments + review bodies): the agent's own prior
    turns are served tag-stripped and marked `you (prior)`; every other turn is
    keyed by its GitHub @login; the PR description is the opening turn. The
    agent REVISES the prior resolution to address the review — it never
    restarts (edits stay in the conflicted paths) — and the revision
    republishes to the SAME PR (force-with-lease onto the existing fix ref,
    PATCH the same PR, a fresh marker at the triggering review id).
    Owner-pushed commits on the fix branch → the case is rebuilt from the
    CURRENT ref head (the owner's edit is the revision base).
  - A reviewed GATE-FIX PR (§8) is never reissued — a reissue re-probes a live
    conflict, and a gate fix never had one; it is escalated once with an honest
    ask ("it carries a fix, not a conflict resolution — merge or close it") and
    stays blocked.

## 7. MECHANICAL/resolve qualification (G1)

Regulates WHICH conflicts the agent may resolve (MECHANICAL or JUDGED) and
which are HELD. G1 governs textual conflicts only; floors (§1) apply on top:
`edition/*` / `tier_floor` entries never claim MECHANICAL. Gate-fix cases (§8)
are not merges and are governed there, not here.

### 7.1 ALLOWED — the agent resolves

A case qualifies if EVERY conflicted path falls under ≥1 rule. MECHANICAL only when
the resolution is byte-derivable; otherwise JUDGED. Driver demote-only.

- **A1 standing record** — paths + both-sides shape covered by a STANDING record:
  a §7.4 rule, an inventory `invariants`/`extra_context` entry, or a rerere
  replay. Re-apply exactly. MECHANICAL if rerere replays; JUDGED if re-applied to
  moved code. One-time adjudications are NOT records — they live on their PRs and
  die with their refs; cite config or a live PR, never a remembered decision.
- **A2 known-recurring keep-both** — both sides insert adjacent/at the same point;
  canonical keep-both in rr-cache. MECHANICAL.
- **A3 additive union** — both sides only ADD:
  (a) list-shaped regions: imports, exports, config knobs, migration barrels, test
      suites, doc lists — union, no base or side line lost. MECHANICAL when hunks
      are disjoint-additive; JUDGED when interleaving is needed.
  (b) function/method PARAMETERS: both sides add params to the same signature —
      union ALL params and update ALL call sites accordingly. JUDGED.
  (c) class/struct/interface/data-type FIELDS: union of fields, with constructors/
      initializers/serializers updated accordingly. JUDGED.
  For (b)/(c) the resolution's allowed path set extends to the files referencing
  the unioned symbol (call sites / constructors) — driver computes the extension;
  anything beyond it is still F5. Union completeness is checkable; call-site
  completeness is backstopped by the verify gate (typecheck/tests); ordering and
  initializer semantics belong to the cold read.
- **A4 verifiable subsumption** — the losing side's commits on the conflicted paths
  are git-ancestors of the winning side's line, or a verified textual superset.
  Take the superset. MECHANICAL. An UNVERIFIED superset claim fails review even
  when it happens to be right.
- **A5 verified replacement** — a side removed a fork-relied mechanism but a
  replacement demonstrably exists on that side: cite symbol + file:line + preserved
  behavior in the record. JUDGED only.
- **A6 comment/prose-only side** — one side's delta is comments/docs only: keep the
  code side, fold the text. MECHANICAL for pure-docs paths; JUDGED when folding
  into code.

Boundary on all of §7.1: only material from the two sides, the base, a cited
record, or the A3(b/c) computed call-site extension. Third-branch content or
edits beyond the allowed set → HELD outright.

### 7.2 FORBIDDEN — always HELD

Any single trigger escalates the whole case.

- **F1 design conflict, no record** — a side removed/reshaped a mechanism the other
  depends on; A5 fails and A1 fails. Includes modify/delete of fork-modified files
  (first occurrence) and seam-threatening invariant trips.
- **F2 security-semantics change** — conflicted hunks alter ENFORCEMENT behavior on
  a sensitive surface (credentials, egress/firewall, container spawn, host-rpc
  auth — the surfaces whose inventory entries carry security invariants) with no
  covering record. A sensitive PATH alone does not force HELD — it floors the
  claim at JUDGED.
- **F3 contradicts a standing record** — would drop/invert/re-decide anything a
  §7.4 rule or an inventory invariant settles. One-time adjudications are
  REF-SCOPED: while the deciding PR/ref stands, contradicting it is F3; once the
  refs are cleaned the question is legitimately open again.
- **F4 intent not establishable** — owner in-flight fix branches, DIVERGED branches
  (owner escalations — PROPAGATION.md §13), unclear candidates; the HELD PR must
  NAME the underivable premise.
- **F5 out-of-scope resolution** — beyond the allowed set (incl. A3(b/c) extension)
  or third-branch content. HELD, no merge.
- **F6 driver escalations** — cold-read reject, red verify gate, scope-guard trip
  (§1); G1 never overrides them.

### 7.3 Tie-breaker

1. DERIVE first (the forensics standard): check code, records, structure. A HELD PR
   that merely asks the owner to do the agent's reading is a defect, not caution.
2. Any unverifiable premise → HELD, naming that exact premise as the ask.
3. Qualifying but unsure between tiers → claim JUDGED.

### 7.4 Standing records (owner-approved)

PATH-SPECIFIC standing rules live on the inventory entry that names the path
(`prompt.extra_context` / `invariants`); the driver embeds them into the case
materials mechanically when a conflicted path matches. This section holds only
REPO-WIDE resolution conventions that no single entry can carry:

- **R1 migration numbering** — `src/db/migrations/**` numbering collisions: the
  fork side-numbers its migrations (`NN-fls-MM` files / `flsMigrationNNN`
  symbols); renumber the FORK migration, never upstream's. Resolves under A1.

## 8. Gate-fix cases — a red build is a case, not a merge

A red build whose failing files can be blamed on a branch becomes a GATE-FIX
CASE served on that branch: a worktree AT THE BLAMED BRANCH'S TIP, no merge,
nothing pending, no conflict markers, the failing build as materials. §7 (G1)
governs textual CONFLICTS and does not apply; the scope is the files the driver
named plus what fixing them DIRECTLY forces, guarded `same-files`
(`conflict-hunks` bounds edits by marker spans, and there are no markers here).
The floor is JUDGED — new code is never MECHANICAL — so every gate fix takes a
cold read.

- **Tiers.** `judged` → a SINGLE-PARENT commit on the branch (not a propagation
  merge; a second parent would fabricate a self-merge) + `reopen` of every
  descendant so the fix is pulled through the DAG. NO judged history PR and no
  pr-intent: that PR exists only to be auto-flipped by the target push landing
  the SAME merge commit, which a single-parent commit never does. The commit is
  the record, and the SAME pass can still complete. `held` → a
  `fix/sweep/<slug(branch)>--<caseId>` ref + ACTIVE PR at a single-parent
  commit, created at `finish` like every other PR, which BLOCKS the next sweep
  until the owner merges it. There is no pristine-conflict DRAFT fallback — a
  gate fix has no conflict exhibit to build one from. At `CHECKS_FAIL_LIMIT`
  the attempted fix is KEPT and frozen HELD ACTIVE (`[AUTO-ESCALATED: checks
  failing]`), never reset.
- **Red base.** `sweep start` never judges the build; a red base is an ordinary
  red for `finish`'s verify to find. It produces one gate-fix case ROOTED ON
  THE BASE ANCHOR carrying every failing file — a commit on a descendant can
  never turn the base green. The trunk is eligible for blame like any branch:
  it is a scope entry and the default parent of every root.
- **Anti-loop.** One attempt per (branch, file-set) per pass. Across passes,
  the anti-loop is the fix's own PR: an unmerged
  `fix/sweep/<slug(branch)>--gate-fix-*` ref on origin is an ACTIVE GATE that
  skips the branch, is reported by `next-case`, and self-clears when the owner
  merges the PR. A gate on the trunk skips everything beneath it, since a
  blocked direct parent already defers its descendants.
- **BLAME = GIT HISTORY, NOT `owned_paths`/`touch_paths`.** Which branch a fix
  belongs on is decided by authorship on the first-parent line —
  `rev-list --count --first-parent --no-merges <branch> ^main -- <file>` — over
  every branch in the hierarchy, the trunk included, with `^main` (upstream,
  never ours to fix) as the one exclusion for all of them. Registry path
  declarations say where a feature INTENDS to live; they drive routing and
  validation, never blame. Shallowest by hierarchy depth (§3) wins, so the fix
  lands closest to the root and propagates instead of being applied on N
  leaves; no candidate → the trunk `main_patched`; a TIE at the shallowest
  depth REFUSES by name, never breaks by spelling. Failing files are grouped
  per attributed branch — one case each, shallowest first, because a judged
  trunk fix plus its reopen can moot a descendant's case before it is worked.
  Owner-approved CUT-POINT EXCEPTIONS
  (`scripts/sweep/cut-point-exceptions.yaml`) feed blame with facts about this
  fork's git history that topology alone cannot express; an unparseable
  exceptions file stops the blame it feeds (`ERR45_CUT_POINTS_MALFORMED` —
  silently dropped exceptions would put blame back on the answers they exist to
  correct), while an ABSENT one skips silently.
- **Mint boundary.** A gate fix is never created on upstream `main` — the sweep
  cannot commit there, and a fix rooted there reaches nobody. The refusal is
  reported to the owner ("upstream is red at ⟨sha⟩ for ⟨files⟩"), because the
  fork is about to merge a broken upstream commit.
