# Merge & publication policy — canonical (D-049)

Status: owner-settled 2026-07-21. This file is the AUTHORITY on tiers, batching,
noise, review, and publication. PROPAGATION.md holds driver mechanics; on conflict,
this file wins. The AGENT drives these tiers through the D-053 SWEEP STATE MACHINE
(`SWEEP-STATE-MACHINE.md`: `start`/`next-case`/`report-case --tier`/`report-pr`/
`finish`); this file's tier/merge/publication semantics are UNCHANGED — the state
machine wraps them, with one publication-timing rule (D-058): EVERY PR — JUDGED
history and HELD (active or draft) alike — is created at `finish`, AFTER the
full-integration verify is green. `report-pr` publishes NOTHING; it records the
publish intent (tier, resolved commit, active-vs-draft, escalation prefix +
feedback) into the journal, and `finish` creates all PRs from that. Supersedes: case-1..4 ladder (DESIGN.md §6), doc 02 §5 step-3
"one PR per DAG edge batch", D-030 exhibit-commit construction, the API push
workaround, "merging remains owner-only".

D-057 amendment (2026-07-23): blockedness is now the `merge_status ∈ {PR_ID |
DEFERRED | NONE}` block model (invariant `blocked ⇔ merge_status != NONE`),
replacing the independent ledger freeze fields; DEFERRED is pure height-MIN over
blocked DIRECT parents (the `(floor, N′]` path-intersection window is retired);
HELD publish is unified into one ACTIVE PR at the resolved merge commit when the
resolution is marker-clean (owner reviews & merges — the driver never auto-merges
it) or a DRAFT PR at the pristine conflict when unresolved; scope-exceeded-but-
cold-read-agreed and twice-cold-read-rejected escalate to a flagged HELD PR; the
case worktree is a pending diff (clean prefix committed, agent sees only the
conflicting delta). §1 carries the detail.

D-058 amendment (2026-07-23): publish timing + blocked-state persistence.
(a) ALL PRs are created at `finish`, after verify (§5) — JUDGED history PRs AND
HELD PRs (active and draft). `report-pr` no longer publishes anything; it records the
publish intent (tier, resolved merge commit, active-vs-draft, any escalation prefix +
reviewer feedback) into the journal. This SUBSUMES the D-057 open item on held ordering
— an ACTIVE HELD-review PR can no longer bypass the verify gate; the ERR14 held-
ordering (bases current) now applies to every held PR. A pass that crashes before
`finish` has published NOTHING.
(b) Blocked state is ORIGIN-DERIVED, not ledger-persisted. `sweep start` (now
networked, `--token-file`) reconstructs the blocked set from the origin `fix/sweep/*`
refs: a ref merged into `origin/<target>` → resolved, delete the ref; unmerged WITH an
open PR → blocked (PR_ID); unmerged WITHOUT an open PR → an orphan, delete it (so a
branch is never stuck blocked-but-invisible). The ledger's `merge_status` field is no
longer the authority (the D-057 reconcile/settle machinery is retired) — the block-
model semantics in §1 still describe within-pass blockedness, but persistence across
passes now lives in origin's refs, so the local pass dir is disposable and `start`
re-derives a clean picture every time. A fetch failure at `start` is ERR39 (never open
a pass on a stale view).

D-059 amendment (2026-07-24): held PRs are a two-way REVIEW loop, and `finish`
publishing is per-branch resilient. Supersedes the D-058 (b) orphan-delete rule and any
comment-trigger wording.

(a) **Trigger = SUBMITTED REVIEWS ONLY.** A held PR is re-served this pass (a REISSUE)
iff a submitted, non-`*[bot]` review exists whose id is above the driver's
`<!-- sweep-addressed: <review_id> -->` marker (or ≥1 such review and no marker yet).
The marker is a driver comment recognized ONLY when it is a line by itself, id-bounded;
bot/human split is by CONTENT (the shared PAT authors both), and the effective addressed
id is the MAX over all marker occurrences (monotonic — a re-asserted value never
regresses). Loose issue comments and standalone inline comments NEVER trigger a
reissue — they feed the reissue dialog and nothing else. PENDING (unsubmitted) reviews
are ignored.

(b) **Review-state → action (all landing verify-gated at `finish`).** For an open held
PR whose newest review is beyond the marker:
- **APPROVED + still merges cleanly into the CURRENT target** → the DRIVER lands it: the
  fix-ref head is merged into the local target now (journaled `origin-approved` +
  `resolved` tier `approved`, pre-ref recorded so `abort` rolls back), the branch is
  left UNBLOCKED, and `finish` verifies + pushes the target — the push auto-flips the PR
  to merged (D-040). NO reissue, and the driver still never hand-merges the PR on GitHub.
- **APPROVED + STALE** (the target advanced so the head no longer merges cleanly) →
  REISSUE: the agent re-resolves against the new base, keeping the approved intent.
- **CHANGES_REQUESTED / COMMENTED / other** → REISSUE → forced HELD (the revision stays
  in the review loop; it never merges in place and bypasses the open review).

(c) **`start` per-ref classification (orphan-delete RETIRED — a MERGED ref is the ONLY
delete).** Per origin `fix/sweep/*` ref: merged into `origin/<target>` (head is an
ancestor) OR the PR reports `merged_at` (squash/rebase-merged) → resolved + delete the
ref, NEVER a reopen; closed-unmerged PR → REOPEN it (PATCH `state=open`) → PR_ID;
ref present with NO PR (crashed publish) → recover — create the PR from the ref head,
the ref resolution authoritative, never re-derived → PR_ID; ref ABSENT → re-derive the
conflict fresh (new case → new PR at `finish`); a ref whose slug matches no scope branch
is journaled `origin-ref-unknown` and left alone. Every lookup/write is fail-closed
(non-200 = ERR13; missing token while unmerged refs exist = ERR11) — an API failure
never reads as "no PR" nor deletes a ref with a live PR. This SUPERSEDES the D-058 (b)
"unmerged WITHOUT an open PR → orphan, delete it" rule.

(d) **Reissue feed = the FULL time-ordered dialog** (PR description + issue comments +
inline review comments + review bodies): the agent's own prior turns are served
tag-stripped and marked `you (prior)`; every other turn is keyed by its GitHub @login;
the PR description is the opening turn. The agent REVISES the prior resolution to address
the review — it never restarts (edits stay in the conflicted paths) — and the revision
republishes to the SAME PR (force-with-lease onto the existing fix ref, PATCH the same
PR, a fresh marker at the triggering review id). Owner-pushed commits on the fix branch →
the case is rebuilt from the CURRENT ref head (the owner's edit is the revision base).

(e) **Push resilience at `finish`.** `finish` pushes each target branch INDEPENDENTLY; a
failure is categorized (diverged / transient / auth) and journaled — `ERR15` is a
PER-BRANCH label, NOT a hard stop, and the remaining branches proceed. A held-publish
failure is likewise per-case and non-fatal. A partial finish is RESUMABLE: the pass is
not sealed, so re-running `finish` retries exactly the failed pushes/publishes (landed
branches skip as up-to-date, verify re-gates); pushes and PR-creates never redo. The
success/partial `SWEEP-RESULT` reports `pullRequests` (every PR the pass touched) and a
`stats` block (landed/failed branches by category, PRs created/reissued/reopened/
recovered) with an instruction to report landed-vs-conflicted to the owner. Only a GLOBAL
failure with no per-branch rows (red verify gate, missing token, closure check) halts.

D-060 amendment (2026-07-25): the quality gate is SINGLE and lives at `report-case`.
Tier semantics are UNCHANGED; what moves is WHERE a resolution is judged. Every
RESOLVED case now clears a CHECKS GATE (typecheck THEN tests, from the repo-shipped
`scripts/sweep/checks.json`) before the cold read, and the cold read runs for ALL
tiers there — including judged and held, which previously deferred it to `report-pr`.
A checks failure returns `ERR36_TYPECHECK_FAILED` / `ERR40_TESTS_FAILED` for a fix-and-
re-run and charges no report-attempt; ten consecutive failures reset the worktree to
the pristine conflict and freeze a HELD DRAFT (`[AUTO-ESCALATED: checks failing]`) so a
failing resolution is never published. `report-pr` becomes PR AUTHORING ONLY — it reads
`pr/body.md` (H1 first line = title) and records intent, with no cold read, no checks
and no network. Consequently the cold reader never sees PR prose, and the
`defect: description` verdict (with the prose-rewrite loop it drove) is RETIRED: every
reject counts as a resolution reject toward the 2× HELD escalation. At `finish`, red
tests with no attributable single-branch offender STOP the pass (`ERR40_TESTS_FAILED`,
publish nothing, report to the owner) rather than halting resumably.

D-061 amendment (2026-07-28): a RED BUILD becomes a GATE-FIX CASE, and a pass never
opens on a base that is already red. Tier semantics are unchanged; what is new is a case
KIND that is not a merge at all, and a base gate in front of the pass.

(a) **BASE GATE.** `sweep start` typechecks the FORK TRUNK TIP (`main_patched`, else
`--upstream`) in isolation before anything is merged — the pinned checks file's `typecheck`
list only; tests stay at `finish`; no checks-file / an empty list skips it. Checked before
any merge, whatever fails is unambiguously PRE-EXISTING (`ERR42_BASE_RED`), so it is
reported as such instead of surfacing at `finish` as a red verify nobody can attribute.
Live 2026-07-28: a type error on the trunk since 2026-07-04 was merged into 11 branches and
only discovered at `finish` — an hour of work and no usable output.

(b) **GATE-FIX CASE — a case that is not a merge.** An unattributable red (at `finish`, or
on the base at `start`) used to dead-end in an ERR18/ERR40 asking a HUMAN to fix something
the agent may not deliver — it can neither push nor open a PR. It is now a CASE: a worktree
AT THE BLAMED BRANCH'S TIP, no merge, nothing pending, no markers, the failing build as
materials. §7 (G1) governs textual CONFLICTS and does not apply; the scope is the files the
driver named plus what fixing them DIRECTLY forces, guarded `same-files` (`conflict-hunks`
bounds edits by marker spans, and there are no markers here). The floor is JUDGED — new
code is never MECHANICAL — so every gate fix takes a cold read. Tiers:
- **judged** → a SINGLE-PARENT commit on the branch (not a propagation merge; a second
  parent would fabricate a self-merge) + `reopen` of every descendant so the fix is pulled
  through the DAG. NO judged history PR and no pr-intent: that PR exists only to be
  auto-flipped by the target push landing the SAME merge commit, which a single-parent
  commit never does. The commit is the record, and the SAME pass can still complete.
- **held** → a `fix/sweep/<slug(branch)>--<caseId>` ref + ACTIVE PR at a single-parent
  commit, created at `finish` like every other PR, which BLOCKS the next sweep until the
  owner merges it. There is no pristine-conflict DRAFT fallback — a gate fix has no
  conflict exhibit to build one from. At `CHECKS_FAIL_LIMIT` the attempted fix is KEPT and
  frozen HELD ACTIVE (`[AUTO-ESCALATED: checks failing]`), never reset.
A red BASE produces one gate-fix case ROOTED ON THE BASE ANCHOR carrying every failing file
(a commit on a descendant can never turn the base green). ANTI-LOOP: one attempt per
(branch, file-set) per pass; for the base, one per `<anchor>@<sha>` recorded at the
workspace root, because `start` wipes the pass dir the journal lives in.

(c) **BLAME = GIT HISTORY, NOT `owned_paths`/`touch_paths`.** Which branch a fix belongs on
is decided by authorship on the first-parent line —
`rev-list --count --first-parent --no-merges <branch> ^main -- <file>` — over every branch
in the hierarchy, the trunk included, with `^main` (upstream, never ours to fix) as the one
exclusion for all of them. Registry path declarations say where a feature INTENDS to live
and were measurably wrong where it mattered; they still drive routing and validation, but
they no longer decide blame. Shallowest by hierarchy depth wins, so the fix lands closest to
the root and propagates instead of being applied on N leaves; no candidate → the trunk
`main_patched`; a TIE at the shallowest depth REFUSES by name, never breaks by spelling.
Failing files are grouped per attributed branch — one case each, shallowest first, because a
judged trunk fix plus its reopen can moot a descendant's case before it is worked.

(d) **ONE HIERARCHY** (`scripts/sweep/hierarchy.ts`), keyed by BRANCH — inventory `parents`
hold branch NAMES, not entry ids. `depth = 1 + MAX(parent depths)`: a branch merges only
after ALL its parents, so its position is governed by its DEEPEST one (MIN produced 8 parent
inversions on the live inventory). `minPath` = the shortest chain to `main`, excluding
`main` — what a report or an escalation names. Unresolvable → `null`, sorted LAST, never 0.
Note the consequence for §3's ordering claims: `parents` is MERGE topology and a branch
CUT from another that its entry does not declare as a parent lands at the wrong depth —
visible today as blame refusing a tie rather than as a wrong answer.

(e) **New error ids:** `ERR42_BASE_RED` (red before any merge — pre-existing, not caused by
propagation), `ERR43_CHECKS_MALFORMED` (an unparseable checks file is loud at `start`,
`report-case` and `finish`; an ABSENT one still skips silently, which is intended),
`ERR44_WORKTREE_RESET_FAILED` (a failed reset is never reported as "the worktree is
pristine"), and from D-060 `ERR41_TOKEN_REJECTED` (a networked 401/403 names the token
SOURCE — `--token-file` / `$GH_TOKEN` / `$GITHUB_TOKEN` — and never echoes the token;
retrying with the same token cannot clear it).

## 1. Merge tiers (per parent→branch merge attempt)

| Tier | Trigger | Action | Review | PR |
|---|---|---|---|---|
| CLEAN | no textual conflict (merge-tree) | bulk direct merge | none | none |
| MECHANICAL | conflict the agent is allowed to resolve (qualification: §7) | direct merge | cold-read confirm required | none — journal + cold-read artifact only |
| JUDGED | non-obvious conflict, agent-resolved | merge; same commit pushed to target → PR auto-marks merged | cold-read confirm required | yes (history) |
| HELD | unresolved / cold-read reject×2 / scope-guard violation / red verify gate / non-convergence cap / escalation | clean prefix merges first; PR head = the resolved merge commit if marker-clean, else the pristine conflict | **owner** (the only review state) | ACTIVE PR (marker-clean resolution, owner merges) or DRAFT PR (pristine conflict), real diff (D-030) |
| DEFERRED | own conflict at height h ≥ MIN(blocked DIRECT parents' heights); a parent is blocked ⇔ `merge_status != NONE` | clean prefix committed; STOP — no merge above, NO PR; sticky while any direct parent is blocked; clears when all parents NONE → re-merge fresh (D-057) | none | none |

Tier rules:
- CLEAN vs conflict: computed (merge-tree). MECHANICAL vs JUDGED: agent-claimed, driver demote-only.
- Floors: `edition/*` and `tier_floor: judged` entries → min JUDGED (D-015). Edition
  JUDGED **auto-merges** (intended); owner-gating happens only by escalation to HELD.
- Blocked = the `merge_status` block model (D-057): per branch `merge_status ∈
  {PR_ID | DEFERRED | NONE}` (NONE = absent field) and `blocked(X) ⇔ merge_status(X)
  != NONE` ALWAYS. No height/path is stored — heights are live per-pass values.
  PR_ID persists from the hold until the branch is COMPLETELY resolved (owner
  resolves the PR AND the merge lands on the branch), never cleared at any
  intermediate step; DEFERRED is sticky while any direct parent is blocked. This one
  block replaces the retired independent freeze fields (status:'frozen', frozenBy,
  heldHead, heldPaths, fixBranch, pendingBehindFreeze). D-058: this is the WITHIN-PASS
  model; the block set is no longer PERSISTED in the ledger's `merge_status` — `sweep
  start` re-derives it from the origin `fix/sweep/*` refs each pass (see the D-058
  amendment), so PR_ID persistence is carried by the live ref + its open PR, not a
  stored field.
- Case worktree = a PENDING DIFF (D-057): the driver commits the CLEAN PREFIX (the
  automerge tree with the conflicted paths reset to base/ours) as the case worktree's
  HEAD and writes ONLY the conflicting delta (marker content) into the working tree, so
  `git status` shows exactly the conflicted paths and the agent reviews/edits only that
  delta — never the whole tree. On-disk bytes and the `add -A; write-tree` snapshot are
  identical to the old full checkout, so empty-check / scope-guard / cold-read diff are
  unaffected.
- Only HELD needs external review. Anything review-worthy at any tier is ESCALATED to
  HELD and inherits ALL HELD rules. Old "case 3" (open provisional PR) is retired.
- HELD publish is UNIFIED on one key — does a MARKER-CLEAN resolution exist? Marker-
  clean (the agent actually resolved) → ACTIVE (non-draft) PR at the resolved merge
  commit; the owner reviews & merges — the driver NEVER auto-merges a HELD PR (auto-
  merge stays JUDGED). Markers remain / `--tier held` with no valid resolution → DRAFT
  PR built from the PRISTINE conflict (clean-prefix commit + the original
  upstream-vs-ours automerge tree, NO agent edits — the owner resolves fresh, not the
  agent's mangled attempt).
- Scope guard: resolution diff ⊄ allowed set. Lever: `same-files` (default; extra file
  = violation) / `conflict-hunks` (strict; must stay in marker regions). A scope
  violation no longer demotes to HELD BEFORE the cold read (D-057): `scopeExceeded` is
  carried forward, the cold read judges the RESOLUTION, and if it AGREES the case is
  HELD publishing that resolution — an ACTIVE PR flagged `[AUTO-ESCALATED: scope
  exceeded]` (owner merges; never auto-merged). Scope OK + agrees → JUDGED as before;
  rejects → the reject path below.
- Cold-read rejections are COUNTED per case (D-057): the 1st reject does NOT freeze —
  the reviewer's short feedback is surfaced to the agent to revise and re-run; on the
  2nd reject the driver stops retrying and passes the case HELD (ACTIVE if marker-clean,
  else DRAFT pristine conflict) with `[AUTO-ESCALATED: cold read rejected 2x]` + the
  reviewer feedback prepended to the PR description. This tightens/replaces the old
  3-distinct-tree convergence cap (its own prefix `[AUTO-ESCALATED: resolution did not
  converge]`).
- Red verify gate → HELD(gate).
- DEFER rule (D-057) = PURE HEIGHT-MIN over blocked DIRECT parents: X's own conflict at
  height h is DEFERRED iff some direct parent is blocked AND h ≥ MIN(blocked parents'
  heights). Below that MIN every parent is clean, so the conflict is X's OWN (normal
  ladder → its own PR). The pre-D-057 rule — an intersecting HELD-ancestor height in the
  `(floor, N′]` window plus a conflicted-path intersection — is RETIRED: no path check,
  no per-transitive-ancestor window. A clean intermediate parent (merge_status NONE)
  correctly stops propagation until it re-merges the resolved content.

## 2. Case unit — commit stacking

- A case = the MAXIMAL RUN of consecutive conflicting heights whose conflicted path
  sets intersect (one logical decision), capped (default 5, configurable).
- The run breaks at: a clean height, a disjoint-path conflict (own case later), the cap.
- Applies to ALL conflict tiers: MECHANICAL/JUDGED resolve the run as one case (one
  cold-read); HELD's PR head = the run's TOP commit → diff = the whole run.
- The DEFER height-check (run top vs MIN blocked-parent height) and urge tracking are computed against the run's top.
- Never stack disjoint-path conflicts; never stack across a clean height.

## 3. Hierarchy / batching

- Merge sources: `main` ← upstream FF only; `main_patched` ← `main`; every other
  branch ← inventory parents' tips ONLY (D-032b composition branches ← `main` only).
  Never upstream directly.
- Order: breadth-wise; a branch is processed only after ALL parents arrived this pass
  (HELD/empty-interval counts as arrival).
- Pass: watermark pinned at `plan`; heads = {sha, height} on the trunk first-parent
  chain; coverage derived, never stored; only `plan` opens a pass; `run`/`resolve`
  attach to it.
- Merge point: full-range probe first (1 probe, common case); on conflict linear
  sweep; merge at LARGEST clean height (may skip past intermediate conflicting
  heights); the case starts at the smallest conflicting height above it (stacked per
  §2). Never bisect conflicts.
- Only the interval's upper bound is strict; the lower bound extends automatically
  for branches that skipped/froze earlier (a merge carries full ancestry).
- After HELD: the clean prefix below the conflict still merges; descendants receive
  the partial tip.
- Resolve reopens the branch + transitive descendants → same-pass continuation to
  the watermark.

## 4. Noise minimization

- No-op merge (merge-tree result tree == branch tree) → skip, journal only, no merge
  commit.
- Exception: leaves + `always_merge` entries must land ≥1 real merge per pass with
  progress; if all chains no-op'd → un-skip the CHEAPEST parent chain (empty merge
  commits top-down). No merge-main-directly shortcut.
- One case at a time per branch (halt at first conflict run); one branch's case never
  blocks siblings, only descendants.
- Same conflict resolved once at the topmost affected branch; descendants inherit via
  parent merge + shared rerere (D-006; rerere.enabled set repo-wide in the agent clone
  — owner (b), 2026-07-22).
- JUDGED PR closure: push the SAME merge commit → no merge-of-merge commits.
- Frozen branch: skipped every pass; one posted urge-comment per NEW pending head
  (`lastUrgedHead`), silent otherwise.
- MECHANICAL: no PR at all — journal + cold-read artifact only.

## 5. Publication & pushes

- The DRIVER pushes; the agent NEVER hand-pushes anything (rule 3 amended: driver-
  journaled pass pushes are the only pushes).
- Nothing is pushed OR published before `propagate verify` is green for the pass
  (D-012; extended to all PR creation by D-058).
- ALL PRs are created at `finish`, after verify is green (D-058); nothing is published
  at `report-pr` (it records intent only). Per-pass order at `finish`: create the
  JUDGED history PRs → push target branches (CLEAN/MECHANICAL/prefix merges) + the
  JUDGED closure push (same merge commit → those PRs flip to merged) → create the HELD
  PRs (active or draft; bases are then current, so the HELD diff = the case run only,
  and the ERR14 held-ordering holds for every held PR).
- Pre-PR height check (blocking ID): the origin base branch must be AT LEAST at the
  expected pass height; higher is fine (someone else committed); lower/diverged = halt.
- All GitHub writes go through the driver tooling with the ERR/WARN ID contract
  (single subcommand or split — implementation's choice). Refs move via `git push`
  ONLY; the API is used for PR creation/comments (normal use), never to fabricate
  refs/commits as a push workaround.
- Infrastructure failures (e.g. pushes failing through the credential proxy) are
  REPORTED to the owner (D-046 case 2) and never worked around — such issues are not
  sweep-agent duty.

## 6. Review & reporting integration

- Owner attention surface = HELD PRs (active or draft) + D-046 messages (candidates, failures,
  one end-of-sweep result). JUDGED PRs are history, not owner work.
- D-004 annotation: a frozen branch's HELD PR carries the count of further pending
  upstream commits (kept current via urge comments).
- HELD PR text: written by the AGENT from studying the case (materials + worktree);
  driver provides facts only; text checks are mechanical (lint + recorded-decision/
  duplicate gates); the D-031 writing rules apply (D-050).

## 7. MECHANICAL/resolve qualification (G1)

Status: owner-settled 2026-07-21 (evidence corpus: PRs #4-#60, T/p test-case
registry, pass journals). Regulates WHICH conflicts the agent may resolve
(MECHANICAL or JUDGED) and which are HELD. G1 governs textual conflicts only;
floors (§1) apply on top: `edition/*` / `tier_floor` entries never claim MECHANICAL.

### 7.1 ALLOWED — the agent resolves

A case qualifies if EVERY conflicted path falls under ≥1 rule. MECHANICAL only when
the resolution is byte-derivable; otherwise JUDGED. Driver demote-only.

- **A1 recorded decision** — paths + both-sides shape covered by a recorded decision
  (seeds `prompt_extra_context` / inventory `extra_context` / rerere seed). Re-apply
  exactly, never re-ask. MECHANICAL if rerere replays; JUDGED if re-applied to moved
  code. *(Option A / command-gate composition / wirings records.)*
- **A2 known-recurring keep-both** — both sides insert adjacent/at the same point;
  canonical keep-both in rr-cache. MECHANICAL. *(poll-loop T2 family.)*
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
  Take the superset. MECHANICAL. *(Negative control: an UNVERIFIED superset claim
  fails review even when accidentally right — PR #35.)*
- **A5 verified replacement** — a side removed a fork-relied mechanism but a
  replacement demonstrably exists on that side: cite symbol + file:line + preserved
  behavior in the record. JUDGED only. *(wirings: messaging-groups.ts:213.)*
- **A6 comment/prose-only side** — one side's delta is comments/docs only: keep the
  code side, fold the text. MECHANICAL for pure-docs paths; JUDGED when folding
  into code.

Boundary on all of §7.1: only material from the two sides, the base, a cited
record, or the A3(b/c) computed call-site extension. Third-branch content or edits
beyond the allowed set → HELD outright *(the PR #34 rollback)*.

### 7.2 FORBIDDEN — always HELD

Any single trigger escalates the whole case.

- **F1 design conflict, no record** — a side removed/reshaped a mechanism the other
  depends on; A5 fails and A1 fails. Includes modify/delete of fork-modified files
  (first occurrence) and seam-threatening invariant trips.
- **F2 security-semantics change** — conflicted hunks alter ENFORCEMENT behavior on
  a sensitive surface (routing.yaml `sensitive_surfaces` / seeds security
  invariants) with no covering record. A sensitive PATH alone does not force HELD —
  it floors the claim at JUDGED.
- **F3 contradicts a recorded decision** — would drop/invert/re-decide anything a
  record settles; never re-open a decided question (D-030).
- **F4 intent not establishable** — owner in-flight fix branches, DIVERGED branches
  (D-045), unclear candidates; the HELD PR must NAME the underivable premise.
- **F5 out-of-scope resolution** — beyond the allowed set (incl. A3(b/c) extension)
  or third-branch content. HELD, no merge.
- **F6 driver escalations** — cold-read reject, red verify gate, scope-guard trip
  (§1); G1 never overrides them.

### 7.3 Tie-breaker

1. DERIVE first (the forensics standard): check code, records, structure. A HELD PR
   that merely asks the owner to do the agent's reading is a defect, not caution.
2. Any unverifiable premise → HELD, naming that exact premise as the ask.
3. Qualifying but unsure between tiers → claim JUDGED.
