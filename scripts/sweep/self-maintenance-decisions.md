# FLSclaw self-update/self-maintenance — decision log (append-only)

Append-only. Newest entries at the bottom. Each entry: date, decision, why.

---

## 2026-07-10 — initial decisions (from design discussion with owner)

**D-001 Detection = per-branch merge-tree; `everything` = verification only.**
Affected-file/conflict detection is done per in-scope branch via new-style `git merge-tree`
(never single-base `--merge-base=`, never cherry-pick fallback — known two-merge-base pitfall).
The `everything` branch is rebuilt only as the post-merge build+test verification gate.
Owner confirmed the everything-as-detector idea was a suggestion, not a requirement.

**D-002 PoI has two classes: annotate vs gate.**
Annotate (merge now, analyze/report async): new folders, new skills, files over size
threshold, touches to security-sensitive surfaces (credentials, egress, container spawn).
Gate (stops propagation for that branch only): textual conflicts and test failures.
Semantically broken but textually clean merges demote to gate class via the test gate.

**D-003 "main" in owner's spec = main + main_patched.**
`main` stays a pristine FF-only mirror; all real merge work happens on `main_patched`
and downward along the DAG (merge-forward, resolve at topmost affected branch).

**D-004 No deep PR chains.**
While a branch has an open conflict PR, the sweeper freezes that branch and annotates the
PR with the count of further pending upstream commits. Case-3 (provisional resolution in
open PR) is the only continue-on-top case.

**D-005 Branch freeze/status indication = registry file, not git branch metadata.**
Primary: per-branch entries in a state file (JSON) on a dedicated maintenance branch —
diffable, pushable, survives clones; git has no good pushable per-branch metadata
(branch descriptions are local-only, notes attach to commits not branches).
Optional at-a-glance indicator: lightweight tag `sweep-frozen/<branch>` created/deleted
alongside the registry entry. Registry is authoritative; tags are cosmetic.

**D-006 Shared rerere cache** committed to the maintenance branch so recurring conflicts
(e.g. poll-loop dedup "keep both") auto-resolve in the scripted phase.

**D-007 Implementation home.** Work happens in the canonical checkout
`/home/user/workspace/fls/fls-claw-v2-clean` (branch topology confirmed there), on a new
branch off `main_patched`, built in an isolated worktree. Nothing pushed and nothing
touching prod without explicit owner ack. Deploy stays out of scope for the agent group
("ready to deploy" is a report, not an action).

**D-008 Orchestration resilience.** Subagents run in background; a null result (API error /
death) is retried up to 2×; progress and decisions checkpoint into this file so the loop
survives context compaction and transient API failures.

**D-009 Feature inventory = registry of ready-to-use subagent prompts.** Owner's guidance:
per-feature entries must carry enough pointers (branch, files, symbols, design doc) that a
subagent can check only its subset without re-exploring the repo each sweep.

**D-010 Test-case registry.** Define a taxonomy of merge/PoI situations, mine real commits
for each from merged history and pending upstream updates, and record them so a test run =
worktree at a specific commit + replay of a few updates.

## 2026-07-10 — pipeline-spec decisions (draft v1, while design agents run)

**D-011 Unit of merge = upstream first-parent commit (PR merge).** Stop-point bisection
and replay operate on the first-parent chain, matching upstream's PR cadence; individual
intra-PR commits are never merged separately.

**D-012 Rollback on red tests.** Stage-5 merges record each branch's pre-sweep ref; if
the everything-rebuild verification fails, the offending branch is rolled back to it and
demoted to a gate-PoI (case 4), then verification reruns without it. Nothing is pushed
before verification passes.

**D-013 State mutations only via script subcommands.** Agents never edit
sweep-state.json or refs by hand; sweep.ts validates and journals every mutation
(sweep-log.jsonl audit trail).

**D-014 Case-4 PRs carry a NOTES.md + reproduction command instead of committed
conflict markers.** Branch sits at its stop point; the conflicted merge is reproducible
with one recorded command.

**D-015 edition/* is always case-3 minimum** (PR + owner ack) because it is the
deployed product. Deploy itself is never performed by the procedure.

## 2026-07-10 — reconciliation with existing design doc 02 (recon finding)

**Finding:** `docs/design/02-self-maintaining-flsclaw.md` (branch design/flsclaw) already
designs the maintenance estate (groups fls-maintainer/watcher/change-author/support/
registrar, GitHub-App credential split, propose≠approve≠apply trust chain, non-agentic
updater, M0-M3 maturity ladder). It was adversarially reviewed 2026-07-02. The current
work = the detailed mechanics of its §5 upgrade pipeline.

**D-016 No new design doc number.** Sweep-mechanics refinements append to doc 02 (§5) and
scratchpads/topic-2-self-maintenance.md, per the suite's conventions. Component mapping:
scan stage = fls-upstream-watcher, PoI classification/plan = fls-maintainer, merges/PRs =
fls-change-author, owner approval = GitHub PR review.

**D-017 Two-store split (supersedes the "maintenance branch holds everything" phrasing of
D-005; freeze registry file remains authoritative).** Git-facing merge-topology state that
scripts must read/write (sweep-state.json: per-branch lastMergedUpstream + frozen status;
rr-cache; sweep reports archive) lives in the repo on a dedicated never-merged ops branch
`maint/state`. Job lifecycle (jobs, job_events, classifications decided-by) lives in the
doc-02 maintainer ledger (SQLite). Ledger rows reference state-branch commits by SHA.

**D-018 No yaml dependency in sweep tooling.** yaml@2.9.0 exists only on the ops-registry
stack; sweep tooling bases off main_patched. Machine-readable = JSON (mount-allowlist.json
precedent); human artifacts + prompt templates = markdown.

**D-019 Branch naming per doc 02 push policy:** batch sweep branches `sweep/<date>`,
conflict-resolution branches `fix/sweep/<date>-<topic>` (within change-author's
sweep/* + fix/* push grant).

**D-020 M0-first implementation.** Sweep scripts are standalone tsx tools (scripts/sweep/,
Usage-line + positional-args convention, vitest-covered) runnable by the operator with no
dependency on the estate/dependent-groups code (still partial on feat/dependent-groups).
The estate wraps the scripts later; nothing in the tooling assumes an agent is running it.

**D-021 File placement.** Tooling: `scripts/sweep/*.ts`. Maintenance data (sweep-scope.json,
feature inventory, test-case registry, prompt templates): `estate/sweep/` (estate/ is the
doc-02-sanctioned, config-wired home for maintenance-estate assets). Mutable state:
`estate/sweep/state/` on the maint/state branch only.

## 2026-07-10 — feature-inventory design accepted (with amendments)

**D-022 YAML accepted for the registry; D-018 revised.** The design subagent's case is
stronger than the no-yaml rule: the fork already has the exact idiom (feat/ops-registry:
version-controlled YAML, yaml@2.9.0, fail-closed loader), every field is structured, and
one parser beats two. The sweep tooling branch therefore adds yaml@2.9.0 to package.json
(same version as the ops stack — identical addition, no future merge conflict).

**D-023 One never-merged ops branch, `maint/fork-registry`** (unifies D-017's maint/state
with the agent's meta/fork-registry): carries `fork-registry/**` (curated: entries,
schema, routing.yaml, prompts, test-case registry) AND `sweep-state/**` (volatile:
sweep-state.json, sweep-log.jsonl, rr-cache, reports). Cut from main; never merges in or
out; read by scripts via `git show` with no checkout; extends the change-author push
allowlist. Per-file audit trails keep curated vs volatile churn separable.

**D-024 Registry fail-closed rule adopted:** invalid registry or stale entry (validator
ALERT) routes the affected PoIs to the catch-all triage prompt — never a silent
INDEPENDENT.

**D-025 Nothing is committed to design/flsclaw.** Doc-02 §5 refinement + topic-2
scratchpad entry are prepared as a patch file in the deliverables for owner review
(standing rule: no commits to the design suite without explicit owner OK; the checkout
also holds owner WIP).

## 2026-07-10 — test-case mining results + first-sweep intelligence (better-to-know)

**D-026 Test-case registry v1 mined and verified.** All 10 taxonomy classes have real
pinned instances (SHAs verified; conflict sets reproduced via new-style merge-tree).
Draft preserved in session scratchpad (test-case-registry-draft.md); will be committed
as fork-registry/test-cases/*.yaml on maint/fork-registry after the registry branch
exists (sequenced to avoid two agents writing one branch).

**Better-to-know — the pending upstream range (56 first-parent commits, 2.1.34→2.1.41)
is NOT benign; live conflict matrix vs current tips:**
- main_patched: 4 conflicts, all originating in its three fix/main/* constituents —
  incl. a modify/delete (upstream #2942 DELETED container/agent-runner/src/current-batch.ts
  that our duplicate-send-message fix modifies → fork flag must be re-homed onto
  db/session-state) and upstream #2930 rewriting command-gate startup+failopen + adding
  its own src/command-gate.test.ts, colliding with our OPEN slash-command bug fix
  (fix/main/command-gate-mention-prefix — the known @mention-prefix bug).
- module/egress-lockdown: 12 conflicts — genuine feature co-evolution (upstream #2934
  perimeter-env vs our 143-line rewrite; #2943 mount-security suite vs our own 465-line
  test suite add/add). Textbook case-3/4 + OVERLAP-HIGH material.
- feat/mitm-credential-proxy & edition/fls-ai-bot: 15; feat/onecli-broker: 16;
  module/runtime-updater: 8; fix/ncl-crud-side-effects: 1 (groups.ts vs #2890 templates).
- Clean: fix/duplicate-result-dispatch, fix/chat-sdk-format-fallback,
  fix/main/chat-sdk-mention-boundary, docs/notes.
- Also: #2981 tasks-core deletes src/modules/scheduling/* (fork branches touching
  scheduling surfaces beware); #2965 rate-limit-event-shape auto-merges but semantically
  overlaps our classifyResultMessage machinery (T5-type watch item).
First-sweep strategy: resolve the 4-file core ONCE on main_patched, propagate, then
handle per-branch deltas; egress-lockdown overlap goes to owner as OVERLAP-HIGH.

**D-027 Replay-harness quirk:** the repo's formatter PostToolUse hook can dirty
throwaway worktrees — harness must `git restore .` before assertions; replay uses
detached worktrees; T2 pins double as rerere seeds.

## 2026-07-10 — registry branch built (implementation progress)

**maint/fork-registry created** (worktree /home/user/workspace/fls/wt/maint-fork-registry,
tip a3823484): schema, routing.yaml, both prompts, 26 feature entries (3 complete:
mitm-credential-proxy / agent-group-contributions / ops-registry; 21 skeletons; 2 planned:
ops-kb WS-I, estate-config WS-J), sweep-state.json seeded for 34 branches (all at
cb6e3d11; telegram excluded). All globs/anchors/docs validated against owning branches.

**Better-to-know flags raised by the builder (need eventual human/agent enrichment):**
- feat/ssh-auth tip is NOT an ancestor of edition/fls-ai-bot although edition contains the
  ssh-auth module files (parallel/earlier merge; broken-ssh-auth + everything-ssh-l3
  exist) — entry marked in-progress with reconciliation note.
- File evidence suggests sibling root modules cross-merged beyond the memory DAG's edges
  (container-bootstrap / egress-lockdown) — flagged in entries; the DAG in scope config
  should be re-verified against merge history before the first real sweep.
- WS-C and WS-D turned out to have real branches (feat/question-fanout,
  feat/dependent-groups) — skeletons, not planned entries.

Test-case YAML materialization now running on the same branch (sequenced after the
registry build). Sweep tooling (scripts/sweep on feat/maintenance-sweep) still building.

## 2026-07-10 — test-case registry committed

maint/fork-registry advanced a3823484 → 2b94b97c: fork-registry/test-cases/ with README
(replay model + anchors + quirks), 16 case files (T2 family split t2a/t2b/t2c with
shared family key), fixtures/pending-range-recon.md snapshot. All 44 embedded SHAs
re-verified full-length. Better-to-know: plain YAML scalars containing " #NNNN" PR
references silently truncate as comments — case files use block scalars for those; any
future YAML writer for the registry must watch for this.

## 2026-07-10 — implementation complete, end-to-end verified

Final tips (all LOCAL-ONLY, nothing pushed, prod untouched, main checkout undisturbed):
- feat/maintenance-sweep @ c9f96cf7 (worktree ../wt/feat-maintenance-sweep): scripts/sweep/
  CLI + 16 lib modules + DESIGN.md + README runbook; 94 sweep tests, full suite 662 pass,
  tsc + format clean. Scope rule (D-028): scan/merge scope = registry feature branches
  UNION sweep-state active branches; docs/* unprotected (legit sweep target); design/*,
  maint/*, everything*, main protected.
- maint/fork-registry @ ca693b0e (worktree ../wt/maint-fork-registry): 27 feature entries,
  routing + 2 prompts + schema, 16 test cases, pending-range recon snapshot, sweep-state
  for 34 branches. Validator end-to-end: ok=true, 0 alerts.
Cross-validation: replay harness (built independently) passed 15/15 mechanically
replayable registry cases; real-repo scan verdicts: 4 branches clean-ready
(docs/notes + 3 fix/*), 29 gated at PR #2890 groups.ts, stop points null → first real
sweep MUST start by resolving the 4-file core on main_patched.

Owner decisions pending (deliberately not taken autonomously):
1. Apply the design-suite appendix (self-maintenance-design-appendix.md) to doc 02 +
   topic-2 scratchpad on design/flsclaw.
2. Push policy: activate PR flow = push feat/maintenance-sweep, maint/fork-registry;
   GitHub App + branch protection per doc 02 §7.
3. Run the first M0 sweep (runbook scripts/sweep/README.md) — starts with the
   main_patched 4-file resolution (case-2/3 work) + egress-lockdown OVERLAP-HIGH call.
4. Estate-group bootstrap (blocked on feat/dependent-groups recovery).

## 2026-07-10 — OWNER RESTRUCTURE: maint/fork-registry branch dissolved

**D-029 (owner decision, supersedes D-023).** The separate ops branch is eliminated.
Rationale: most of its content is either tooling config or regenerable/derivable state.
New layout:
- feat/maintenance-sweep gains: registry schema/routing/prompts, test-cases (regression
  suite; pinned resolutions double as rerere seeds), a fork-registry-generate skill whose
  instructions canonically carry the per-feature JUDGMENT SEEDS (invariants — owner:
  "part of building instructions, no doubt" — plus overlap hints and known ownership
  corrections), and a moment-stamped bootstrap snapshot
  scripts/sweep/bootstrap/fork-registry@<features-tree-hash-12>/ + MANIFEST (date,
  source ref, per-entry verified_against).
- Derived, never stored: per-branch lastMergedUpstream (= git merge-base vs
  upstream/main), frozen status (= open fix/sweep/* PRs once the PR flow is active),
  scan reports. State cannot go stale because it is computed.
- Group-owned (transferred to the target agent group at bootstrap): job ledger (freeze
  records until the PR flow exists, PoI lifecycle), report archive, local rr-cache
  (rebuilt from pinned cases via seed-rerere).
- Exclusion policy (namespace globs, telegram) stays as committed config — policy, not
  state.
maint/fork-registry (tip ca693b0e) and its worktree are kept untouched as a superseded
backup until the owner deletes them. Restructure implementation running on the tooling
agent.

## 2026-07-10 — restructure complete and verified

feat/maintenance-sweep @ 2ab9975c (4 new commits). Snapshot folder
bootstrap/fork-registry@e91f4b4e33e9/ (tree hash verified, entries diff-verified
verbatim vs ca693b0e). seeds.yaml extracted (27 seeds; 4 entries with invariants, 27
with overlap hints). New ledger.ts replaces state.ts; new subcommand seed-rerere
(rebuilds rr-cache from t2a/t2b pinned resolutions — structured resolution_ref fields
added to our copies of those cases, pointing at recorded merges 70798713/8fc0ca9e).
Sweep tests 100/100; full suite 668/668; tsc + format clean. Post-restructure smoke scan
with the snapshot inventory reproduced the pre-restructure verdicts EXACTLY (33 branches,
4 clean / 29 gated, same 43 PoIs, 0 diffs); replay 15 pass / 1 policy-skip; validator
0 alerts / 2 expected verified_against-drift warns. Not carried over (deliberate):
sweep-state/ entirely (derivable or moved to scope.yaml config), the dissolved branch's
README (superseded). maint/* namespace is in the exclusion globs so the superseded
backup branch can never re-enter sweep scope.

## 2026-07-10 — server install (owner-directed)

**D-030 fls-maintainer group created on the v2 server** (~/nanoclaw2, edition/fls-ai-bot
@ ca2fec6): `ncl groups create` → id f6cc450d-a1dd-4e7b-ae18-6653e5e9e249, folder
groups/fls-maintainer/, container config ensured atomically (fork fix present in the
deployed edition). Doctrine installed as CLAUDE.local.md (group CLAUDE.md is
spawn-composed — never hand-edit). No mounts (owner decision): the group works via gh
only, cloning k-fls/fls-claw-v2 into its own workspace; bootstrap, sweep loop, PR rules,
and push allowlist (sweep/* + fix/sweep/* only) are spelled out in the doctrine.

**D-031 feat/maintenance-sweep pushed to origin k-fls** (required for a gh-only group to
obtain the tooling; first branch of the suite published, at owner direction).

Pending owner actions: (a) Slack channel + messaging-group + wiring to
f6cc450d-a1dd-4e7b-ae18-6653e5e9e249; (b) GH_TOKEN credential in the group's credential
scope (PAT: repo on k-fls/fls-claw-v2, read on upstream) — the doctrine makes the group
stop and ask if it's missing. Group is inert until wired.

## 2026-07-13 — first live sweep shakeout + owner rulings

The group's first digest exposed: (a) 9 design-suite feat branches exist only locally —
owner ruling (D-032): they STAY LOCAL for now and are excluded from the agent's active
inventory as status:planned entries (owned_paths kept so overlap routing still flags
upstream collisions with the unpublished work, e.g. upstream 019-wiring-threads vs local
019-topics). Encoded durably as `local_only_features` in seeds.yaml + SKILL.md rule,
pushed as 7e55cc66. (b) Doctrine gaps fixed in CLAUDE.local.md: analysis never waits
for permission (only mutations follow case rules); PRs carry details, digests carry
links — never ask the owner to act on unreferenced context; chat "don't do X" applies
to that occasion only. (c) Known drift left alone per owner: fix/duplicate-result-
dispatch local-only; fix/main/duplicate-send-message-reply origin 1 behind local.
Upstream meanwhile advanced to 2d3257c (v2.1.47, incl. #3010 channel-adapter-defaults).

## 2026-07-13 — git push through MITM proxy: real fix authored

**Diagnosis refined.** feat/mitm-credential-proxy ALREADY ships a programmatic `github`
provider (src/providers/github-credential.ts) with a `githubTransportCodec` that
base64-decodes/swaps/re-encodes git-HTTPS Basic auth — so NO github.json discovery doc
was needed (adding one would collide with the programmatic provider id and throw). The
actual bug: `fromTransport` read only the PASSWORD half of base64("user:pass"), so when
git carries the PAT in the USERNAME field — `https://<PAT>@github.com` (empty password)
or `https://<PAT>:x-oauth-basic@github.com` — the substitute passed through un-swapped →
GitHub "Invalid username or token". The empty-password token-only URL is the likely
real-world trigger for the maintainer group.

**Fix (branch fix/mitm-github-git-https-basic @ 9712d2a4, off feat/mitm-credential-proxy,
NOT pushed):** fromTransport now picks the non-sentinel half (empty pw or x-oauth-basic
sentinel ⇒ PAT is username; else PAT is password). Added codeload.github.com +
uploads.github.com host rules. 16 provider tests (all 4 Basic arrangements + edge cases
+ e2e swap through buildBearerSwapHandler), 275 mitm tests green, tsc clean. Reused the
existing transportCodec abstraction; change confined to the fork-only provider file.

**Inert until host deploy** (changes host-side proxy only) — rides the owner's slot-deploy
+ graceful `ncl shutdown` restart. Verify post-deploy: maintainer clone
`git push origin HEAD:refs/heads/throwaway-verify` succeeds.

**Owner sanity-check:** codec assumes GitHub git-HTTPS carries the PAT as either username
(empty/x-oauth-basic password) or password (any username) — NOT PAT-as-username with a
genuine non-sentinel password. True for GitHub PATs; worth confirming vs the maintainer
group's git credential-helper config.

**Meanwhile the agent is NOT blocked:** it created branches fix/sweep/2026-07-13-* and
PRs #4-#7 via the GitHub API (gh / Contents API — plaintext headers the proxy already
swaps), never via git push. API path is the stopgap until the proxy fix deploys; doctrine
should say push-failure ≠ hard stop, use the API path.

## 2026-07-13 — OWNER DECISION: case-4 freeze PRs carry the real diff (D-030)

**D-030 (owner decision, supersedes the case-4 NOTES.md shape in DESIGN.md §6).**
Trigger: the 2026-07-13 sweep produced NOTES.md-only freeze PRs #5 and #12 —
single-file PRs with no reviewable diff — and #12 re-raised the container-queue ×
tasks-core OVERLAP-HIGH at 18:58Z, three hours AFTER the owner decided it (Option A,
coexistence) and the fix merged (PR #7, 15:58Z; #5 closed as superseded). #12 was
opened from the stale pre-decision branch and against the agent's own 16:01Z scan
showing the branch merging clean.

Owner ruling: **NOTES.md-only PRs are wrong.** A decision/freeze PR must be a real PR:
either genuinely unmergeable (head = upstream stop-point commit, so GitHub shows the
actual pending upstream diff and flags the conflict itself — no committed conflict
markers) or mergeable with a provisional resolution (case-3 shape). All notes/analysis
go in the PR DESCRIPTION, never a committed file. Resolving later lands a merge commit
on the same branch, flipping the same PR from unmergeable exhibit to mergeable
resolution.

Guards adopted with it:
1. Before opening a freeze PR, check `fix/sweep/*` PRs open AND closed for the same
   branch; closed freeze + merged fix = decided — record, never re-open.
2. Decision write-back is a mandatory sweep step: outcomes go into the live inventory
   entry (`prompt.extra_context`) immediately and into seeds.yaml via PR.
3. Never freeze a branch the current scan reports as merging clean.

Applied 2026-07-13: DESIGN.md §6 + seeds.yaml (container-queue decision record) on
feat/maintenance-sweep @ 4475d9d9 (pushed); server-side fls-maintainer CLAUDE.local.md,
inventory/module.container-queue.yaml (prompt.extra_context), sweep-ledger.json
(container-queue entry corrected) — .bak-20260713 backups alongside. Registry
validator green (pre-existing rule-6 WARNs only). PR #12 closed as superseded by #7
and its branch fix/sweep/2026-07-13-container-queue-overlap-high deleted (owner-
authorized, 2026-07-13).

## 2026-07-14 — OWNER CORRECTION: merge-source semantics + scope rule (D-032)

**Root cause of the noisy edition PR #16 (closed):** stage-5 as specced merged
upstream/main directly into EVERY branch (July-sweep fan-out + rerere). With real
conflicts, leaves re-present their parents' conflicts — 10 non-edition-owned files on
edition/fls-ai-bot, duplicated across parallel PRs — violating "resolve once at the
topmost affected branch". Spec error, not agent error.

**D-032a Merge sources = DAG parents.** main FFs from upstream; main_patched merges
main; every other branch merges its inventory `parents` tips (roots ← main_patched),
parents-before-children. upstream/main is never merged directly anywhere else.
Descendants inherit both resolutions and gating through parents. Scan verdicts must
preview the actual parent-merge, not upstream-vs-branch.

**D-032b Scope rule (owner):** non-inventory branches are ignored entirely UNLESS their
tip is an ancestor of an edition/* branch; such edition-constituent branches merge
`main` only (upstream-PR-candidate purity) and are flagged "add an inventory entry".

Implementation dispatched to the tooling agent (tests + DESIGN.md + doctrine edits on
the current estate/ file, preserving the D-030 content added 2026-07-13/14 by later
sessions). Note: two D-030 commits (4475d9d9, 5216fa6a) changed case-4 freeze-PR
behavior — real upstream diff in a draft PR, never NOTES.md — superseding D-014.

## 2026-07-14 — D-032 implemented, deployed

feat/maintenance-sweep @ f34f2fca (pushed). Merge model: main(ff) and main_patched are
the only upstream entry points; inventory branches merge parents' tips (multi-parent,
DAG order, per-source rerere); edition-ancestor non-inventory branches merge main only;
everything else non-inventory ignored. Inherited gating = parent tip doesn't move →
child noop. Sweep tests 108/108, full 676/676. Doctrine deployed to server, verified
identical.

Real-repo partition after the fix: main_patched GATED (the #2890 4-file core);
25 inventory branches → 8 up-to-date / 13 clean / 4 gated on PARENT merges (credentials
6, mitm 5, command-gate 2, vs every branch re-presenting up to 16 upstream files
before); edition-ancestor flagged for entries: fix/chat-sdk-format-fallback,
fix/duplicate-result-dispatch, fix/main/chat-sdk-mention-boundary,
fix/ncl-crud-side-effects, onecli-cleanup (new, gated 17 files); ignored 6 incl.
fix/main/command-gate-mention-prefix + fix/main/duplicate-send-message-reply (in
main_patched but not yet absorbed by edition — will re-enter scope once the parent
cascade reaches edition, or via inventory entries).

## 2026-07-14 — D-033 (owner): edition-composition test becomes transitive-historical

A non-inventory branch qualifies if it was EVER merged into any branch which was ever
merged (transitively) into any edition — not just if its current tip is an ancestor of
an edition tip (that missed the lagging chain: fix merged into main_patched, edition
not yet caught up). Mechanics: fork-era merge-edge extraction via second-parent
reachability (M^2 ∈ B, M^2 ∉ main — directional, subject-independent), transitive
closure seeded from edition/*; tip-ancestry kept as cheap fast path. Expected effect:
fix/main/command-gate-mention-prefix + fix/main/duplicate-send-message-reply re-enter
scope; docs/notes and unmerged new fix/* branches stay ignored. Implementation running.

## 2026-07-14 — D-033 implemented, deployed

feat/maintenance-sweep @ 2007a211 (pushed); doctrine deployed to server, verified
identical. Better-to-know — the implementation CORRECTED the sketched mechanics: literal
per-merge-commit edge extraction (M^2 ∈ B) fails directionality, because a branch cut
FROM main_patched contains main_patched's merged heads and would qualify (and would
shadow-prune main_patched itself). Final formulation: "B was merged into X" ⇔ some
commit on B's OWN first-parent line — excluding commits reachable from main and commits
on another member's first-parent line — is reachable from X; main_patched is seeded as a
structural composition member. Closure timing: 4.6s full-scan on the real repo,
per-run memoization only.

Real-repo partition: composition 7 (both lagging fix/main/* branches re-entered, chain
raw-git verified; + 4 prior + onecli-cleanup); ignored 4 (docs/notes + the three
unmerged fix/* PR branches — an early false positive on fix/mitm-github-git-https-basic
was caught and fixed). Tests 113/113 sweep, 681/681 full.

## 2026-07-17 — OWNER DECISION: cold-reader subagent gate before draft PRs (D-031)

**D-031.** Trigger: PRs #34/#35 (2026-07-14) were framed from inside the sweep
session — resolutions described by line counts and diff mechanics ("concurrent-insert
at line 37", "596 vs 610 lines"), ours/theirs without branch names, a forward
reference to another PR, and "Review needed" contradicted by "no judgment call,
mechanically sound" in the same body, leaving the actual ask undiscoverable.

Owner ruling: before every `gh pr create --draft`, the maintainer MUST spawn a
subagent with NO sweep context, handing it only the draft title, draft description,
changed-files list, and the PR-composition rules. The subagent judges the text as the
owner opening the PR cold: WHAT does it do and to which branch, WHY is the owner
summoned (the specific decision/check), HOW would the owner verify it (what would
make the resolution wrong, where to look). If any answer is not derivable from the
text alone, the subagent rewrites title+description and the rewrite is used; the gate
re-runs once after material edits. Explicit catch-list: bare "Review needed" with no
concrete ask, line-count/mechanics framing instead of behavior-kept/lost + risk,
unlabeled ours/theirs/base or session shorthand, references to other PRs without
inline explanation.

Applied 2026-07-17: estate/fls-maintainer/CLAUDE.local.md on feat/maintenance-sweep
@ e9345186 (pushed); live server copy replaced from estate (identical before edit —
verified no drift; backup CLAUDE.local.md.bak-20260717); agent clone fast-forwarded.
Existing drafts #34/#35 left as-is for owner review.

## 2026-07-18 — OWNER DECISION: result gates before push/PR, cold-reader gate on all PRs (D-034)

**D-034** (numbering note: D-032/D-032b/D-033 were allocated 2026-07-14 by the sweep
sessions for the edition-composition scope rules — see DESIGN.md deviations 6-7; the
decision-number sequence is now shared between this log and repo docs — always grep
both before minting a number).

Trigger: maintainer self-reflection after three incidents — PR #40 opened with an
EMPTY diff; a fix/sweep branch carrying ~351 commits (wrong merge base or source)
pushed without anyone noticing the anomaly; case-2 PR #41 shipped with a
session-shorthand title ("/start filter decision") because the D-031 cold-reader gate
only covered drafts. Root pattern: the sweep executes steps procedurally with no
"does this output make sense" check before irreversible actions.

Adopted (agent's own proposals, owner-endorsed):
1. Pre-push gate: first-parent commit count of `<base>..<fix-branch>` must match the
   scan's pending range; anomalous count = halt and investigate, never push.
2. Pre-PR gate: `git diff <base>...<fix-branch> --stat` non-empty AND files plausibly
   = upstream range + owned_paths/touch_paths; empty diff = record branch as current
   in ledger, delete fix branch, no PR.
3. D-031 cold-reader gate widened to EVERY PR, case-2 included.
4. New non-negotiable rule 7: "Verify results, not steps" — anomalous output means
   halt, never proceed-and-see.

Applied 2026-07-18: estate/fls-maintainer/CLAUDE.local.md on feat/maintenance-sweep
@ 64ed2557 + acf283a4 (renumber D-032→D-034 after the collision was caught); live
server copy regenerated from the branch (backup CLAUDE.local.md.bak-20260718); agent
clone's branch ref updated via fetch refspec (clone was checked out on a fix branch —
do NOT merge into its current branch when syncing).

## 2026-07-18 — OWNER ROLLBACK: all unsupervised sweep merges force-reset

Executed after the two-audit review (PR-trail + git-integrity). Every sweep merge from
the 2026-07-13 22:59Z self-merge batch onward was removed from the protected branches
by force-push reset to pre-sweep tips. KEPT: the supervised 07-13 morning work — #4/#6
(main_patched core resolutions; main_patched now at 11d82a65) and #7 (container-queue
Option A; a13c3e2c). Owner fix PRs #1/#2 (pgp-armor, creds-inline-pgp) were re-merged
onto the reset tips (crypto 63b2f06c, credentials 24663af8). feat/maintenance-sweep
rebuilt as 2007a211 + cherry-picked D-031/D-034 doctrine commits = fe9b2088 (undoes
the #33 300-commit self-merge, keeps all doctrine). Undone with the resets: #9-#19,
#23, #25-#36, direct push 73d02022 — including the PR #34 cross-branch command-gate
copy (credentials back to its pre-existing 596-line stale copy), the PR #15 egress
`return false` stub, and the #35/#36 command-gate resolutions.

Open PRs #40-#44 closed (head branches kept as reference for the redo). Agent stopped
by owner beforehand; its clone's local branches force-synced to the new origin tips;
sweep-ledger.json rewritten — all branches marked rolled-back, `ownerRollback` block
records what was kept and that sweeps stay FROZEN until the owner lifts it (backup:
sweep-ledger.json.bak-20260718-preundo). Local owner clone synced; local main_patched
(453c746b) is strictly ahead of origin with owner fix merges — intentionally untouched.
edition/fls-ai-bot (PROD) had no sweep merges and was not touched.

Prerequisites before sweeps resume (owner): branch protection + agent identity
separation + real CI (options A/B from the 2026-07-18 audit discussion), plus the
C-list doctrine additions (disclosure parity, no silent downgrades, security-file hard
list, stacked-head rule).

## 2026-07-18 — OWNER DESIGN SESSION: mechanical propagation driver (D-035..D-040)

Owner's post-rollback direction: sequencing, scope, and framing of merges/PRs must be
mechanical; the agent's only role is resolving the specific conflict the driver hands
it, then re-running the driver. Full spec: scripts/sweep/PROPAGATION.md on
feat/propagation-driver.

**D-035 Tier ladder + driver-authored step contract.** Every parent→branch merge lands
in one of CLEAN / MECHANICAL / JUDGED / HELD / DEFERRED. CLEAN-vs-conflict is computed
(merge-tree); MECHANICAL-vs-JUDGED is claimed by the resolving agent and only ever
DEMOTED by the driver (scope-guard violation, cold-read rejection, red verify gate);
edition/* floor = JUDGED (D-015 restated). The driver is the only author of merge
parameters (plan.json / step-<branch>.json); the executor re-verifies every step from
first principles (parent ∈ inventory, head on eligible line, height ≤ watermark,
barrier satisfied) — agents cannot re-generate or re-frame merge parameters.

**D-036 Pass model + DEFERRED.** Pass pins an upstream watermark; trunk first-parent
chain enumerated once, heads are {sha, height} pairs; per-branch coverage DERIVED via
monotonic ancestry binary search (never stored). Breadth-wise all-parents barrier
(arrival may carry an empty interval). No MIN-watermark capping for descendants of a
HELD branch (owner override of the reviewer suggestion): a collision that gated parent
P textually re-manifests at child C, else it is genuinely clean for C and P's
resolution flows down later. New tier DEFERRED: C's first conflicting height == an
ancestor's HELD height AND conflicted paths intersect → freeze C, NO PR, journal points
at the ancestor, auto-unfreeze when it clears; paths disjoint → C's own conflict,
normal ladder.

**D-037 Linear merge-point sweep; bisection retired for propagation.** "Merge up to k
conflicts" is not monotonic in k (later upstream commits can rewrite a disputed region
clean). Full-range probe first; on conflict, linear merge-tree sweep; merge at the
LARGEST clean height (may lie beyond intermediate conflicting heights); report the
smallest conflicting height above the merge point. stop-points.ts bisection stays for
the scan forecast only.

**D-038 Scope guard.** On resolve: git diff --name-only <automerge-tree>
<resolved-tree> must be ⊆ the case's conflicted paths; any extra path auto-demotes
(MECHANICAL→JUDGED, JUDGED→HELD), journaled. Driver also emits the cold-read artifact
(conflict hunks + resolution diff + D-031 questions, nothing else) and requires a
verdict file before accepting MECHANICAL/JUDGED — the resolving agent cannot frame the
question.

**D-039 Leaf must-merge via un-skip chain.** No-op parent merges are skipped
(journaled). Leaves / always_merge entries must land ≥1 real merge per pass with
upstream progress; if all chains skipped, the driver un-skips the cheapest parent
chain (empty merge commits). NO merge-main-directly exception — hierarchy has zero
special cases.

**D-040 JUDGED PR closure.** Resolution branch fix/sweep/<date>-<topic> at the merge
commit; after cold-read confirmation the SAME merge commit is pushed to the target so
GitHub auto-marks the PR merged — audit trail with zero merge-of-merge noise. HELD PRs
keep the D-030 real-diff draft shape. Driver PREPARES branches + gh commands + PR body;
pushing/PR creation stay behind the push policy and the 2026-07-18 sweep freeze.

Implementation: branch feat/propagation-driver (off feat/maintenance-sweep fe9b2088),
worktree /home/user/workspace/fls/wt/feat-propagation-driver. Push authorized by owner
(branch only, no merge).

## 2026-07-18 — propagation driver implemented, validated, pushed

feat/propagation-driver @ 6311e770 (8 commits off feat/maintenance-sweep fe9b2088,
PUSHED to origin, NOT merged — owner review pending). scripts/sweep gains
PROPAGATION.md + heights/interval/tiers/plan/deferred/scope-guard/steps/propagate
(+tests). Suite 171/171 (baseline 113), tsc + format clean, verified independently
by the coordinating session after Opus-subagent implementation.

Post-validation corrections folded in during the build (spec §4/§5/§8 updated):
(1) D-036 DEFERRED refined to the WINDOW rule — defer when an intersecting HELD
ancestor height lies in (floor, N'], floor = largest clean height below the conflict
(exact-equality could never fire on coarse parents-model lines); (2) fork-only parent
tips join the eligible line (else owner fixes stall until the next upstream bump);
(3) same-pass continuation — resolve journals `reopened` for the branch + transitive
descendants, arrivedSet honours it; (4) `--tier held` = direct freeze path, no
resolution attempt required. Also: fork point pinned per pass via plan.json
(fixture-drift bug caught by the continuation test); plan-initial.json archival
snapshot.

Real-DAG regression cases: scripts/sweep/test-cases/propagation/ (7 mined case files
+ chain.txt + probes + 3 profiles + FINDINGS.md; 9 replay tests guarded by cat-file
checks). Mining findings of note: pending first-parent chain = 98 heads (watermark
082f5c7ea993); conflict sets are strictly monotone in the current range (no real
non-monotonic window exists today — synthetic fixtures carry that semantics; re-mine
when upstream lands a revert); conflicted automerge-tree OIDs are clone-local (marker
content), so replay asserts tree OIDs only for clean/no-op merges.

NOT wired into the live sweep doctrine; sweeps remain FROZEN per the 2026-07-18
rollback prerequisites. Adopting the driver into the fls-maintainer runbook is an
owner decision.

## 2026-07-20 — adversarial review absorbed: resolve trust boundary inverted (D-041)

Owner forwarded an adversarial review of feat/propagation-driver: "right solution,
right shape — but the trust boundary is drawn in the wrong place" (run verified its
own derivation while resolve consumed agent-writable case.json verbatim). All
findings verified real and fixed; branch now @ aa1fd601 (pushed, still unmerged).
Suite 179/179, tsc + format clean, independently re-verified.

**D-041 (fix round, spec §7/§8/§9 updated):**
1. case-*.json is a POINTER — resolve re-derives head/automerge-tree/conflicted-
   paths/tier-floor from git+registry, enforces open-case journal match and a
   double-resolve guard (branch tip must not already contain the head).
2. §9 gate implemented: `propagate verify` (reuses verify.ts everything-rebuild,
   leave-one-out); pre-refs journaled before first mutation per branch; red →
   rollback + HELD(gate) + ledger freeze; `pass-complete` requires green verify.
3. Freezes are durable (group ledger, branch-keyed) and passes are pinned: only
   `plan` opens a pass; run/resolve/verify/status attach to the latest open pass and
   read watermark+fork point from plan-initial.json — a mid-pass fetch can no longer
   orphan the journal/HELD registry.
4. Cold-read verdicts validated (confirm|reject + non-empty notes + resolvedTree
   freshness binding; {} never confirms). merge+defer journals the defer. Plan-
   equivalence halt moved to run. fix/sweep branches carry -h<height>. PR bodies
   meet D-030/D-031 (labeled ours/theirs, behavior-kept/lost, concrete ask).

**POLICY CHANGE (flagged for owner veto): out-of-scope resolution → HELD outright,
no merge** — supersedes the demote-one-tier ladder settled 2026-07-18; a demotion to
JUDGED still landed the out-of-scope content, defeating the guard.

Owner-attention items from the round: (a) ledger unfreeze is branch-keyed on any
mechanical/judged resolve — the cross-pass "owner merged the freeze PR, continue"
path relies on a fresh case in a later pass (confirm intended); (b) recomputed
automerge-tree drift vs the recorded OID is a hard halt — resolving in a different
clone than the one that ran will halt (conservative, by design). Structural limits
stand as reviewed: cold-read PROVENANCE and push/PR gating need enforcement outside
the agent-writable workspace (branch protection + separate identity + CI).

## 2026-07-20 — owner rounds: scope lever, freeze urging, probe determinism, pin-by-patch (D-042)

feat/propagation-driver @ 4ae1c8f6 (pushed, unmerged). Suite 187/187, tsc + format
clean, independently verified.

**D-042 (owner directives on the D-041 report):**
1. Scope-guard LEVER: `scope_guard_mode` — `same-files` (DEFAULT, owner: don't
   escalate when only the conflicted files are touched; an extra FILE still → HELD)
   vs `conflict-hunks` (opt-in strict: edits must lie inside marker regions).
   routing.yaml global + per-inventory-entry override; re-derived at resolve, never
   read from case.json.
2. Frozen-branch URGING: ledger gains heldHead/fixBranch/lastUrgedHead; when a pass
   finds pending content newer than last urged, the driver PREPARES a gh pr comment
   (count + newest heads) and journals `urge` — one urge per new head, quiet re-runs.
   Unfreeze paths added so the loop terminates: derived (tip contains heldHead after
   the owner merges the freeze PR), `propagate unfreeze` (manual), resolve. Gate
   freezes (no PR) never urge.
3. Probe DETERMINISM (root cause found on the real p7 case): merge-tree conflict
   markers embed the literal command-line labels (branch-name vs sha ⇒ b636a908 vs
   5f23b068) and conflictStyle adds a ||||||| section (diff3 ⇒ aa0b27d0). git.ts now
   probes with pinned SHAs + forced `-c merge.conflictStyle=merge`; automerge trees
   are reproducible across clones/configs; the resolve drift-halt fires only on
   genuine movement. Consequence: run recomputes the case's automerge tree against
   the post-prefix-merge tip and DROPS cases that healed (journal `case-healed`) —
   the non-monotonic window handled end-to-end.
4. Test longevity (owner: role-grant tests must stay alive long-term): the owner's
   2026-07-20 rebase of fix/main/role-grant-scope-clarity (a512bc9f → 630db68f) left
   the mined p7 tip reflog-only. PIN-BY-PATCH: `git diff --binary main..a512bc9f`
   committed as test-cases/propagation/pins/…​.patch; test synthesizes the tip in a
   detached temp worktree when the sha is gone (byte-exact: tree 278894c5, clean
   tree ea6cfe40 @h61, roles.ts conflict @h62; fallback exercised every run). ALL
   propagation-case skips are now LOUD (console.warn naming the vanished anchor).
   Multi-commit fork-tip cases (p2/p4/p5/p6) stay re-mine-on-rebase (README).

## 2026-07-20 — second review round absorbed: rump fixes + trust model (D-043)

feat/propagation-driver @ aea7444a (pushed, unmerged). Suite 196/196, tsc + format
clean, independently verified.

**D-043 (review rump, all findings verified before fixing):**
- B8 DEADLOCK: case ids now branch--parent-h<height> (two parents conflicting at one
  height were one id; the double-resolve guard bricked the second for the pass).
  Fix-branch topics carry the parent slug too.
- B6: checked-out-worktree merges require a clean worktree and abort+halt on a
  surprise conflict (never strand a worktree mid-merge).
- B7: forced un-skip merges tolerate derived coverage -1 (fork-only passes).
- N4: dry-run performs ZERO state changes (would-unfreeze/would-urge reported only).
- N1 (in-driver slice): protected-ref guard at the single ref-write choke point —
  refuses main/design/*/maint/*/everything*/test/* and out-of-pass-scope branches
  regardless of step/case/CLI content; fix/sweep/* namespace-checked, scope-exempt.
- Spec promises implemented: driver-created resolution worktree per case
  (<passdir>/<caseid>/worktree, automerge tree materialized, cleaned on resolve);
  annotate-class journal entry for clean merges passing through a HELD height.
- Bonus real bug (coder-found): sweep's first-conflict floor of -1 silently dropped
  fork-only conflict heads at height -1 — no case emitted; floor now -Infinity.

**§12 trust model added (adoption condition, per reviewer):** in-driver
re-verification recomputes VALUES from git, but pointers (plan/journal/ledger/CLI
flags) are agent-writable — the driver is an enforcement core ONLY under an
owner-controlled wrapper/identity that pins flags, owns the pass dir + ledger, and
gates unfreeze (N2); composes with identity separation + branch protection + CI
(rollback prerequisites). Deliberately NOT solved in-driver: principal distinction,
scope authority, cold-read provenance, push gating.

Also this session: owner authorized ref anchors for test-used commits —
test/pins/propagation-cases-20260720 @ 453c746b pushed to origin (contains a512bc9f,
822f75b1, 1148dca2; publishes local-only main_patched ancestry incl. rolled-back
73d02022 under a pin ref only). Auto-gc in the canonical checkout is blocked by a
stale gc.log (owner to clean; pins make it safe).

## 2026-07-21 — OWNER: propagation driver adopted (D-044; renumbered from a D-041 collision — D-041..D-043 were allocated 2026-07-20); group refresh + heads backup

Repo heads: all 70 origin branches backed up as refs/backup/20260721/* plus a local
bundle (~/workspace/fls/backups/fls-claw-v2-origin-heads-20260721.bundle).

feat/propagation-driver review round 2 fixes (N1-N7: worktree-safe ref writes,
registry as resolve authority, crash-heal, cold-read request regeneration, case-id
sanitization, cross-pass HELD via ledger heldPaths) committed as ff5b548c
(207/207 tests, tsc clean) and fast-forwarded into feat/maintenance-sweep.

**D-044:** the maintainer's merge work runs exclusively through
scripts/sweep/propagate.ts (spec PROPAGATION.md, D-035..D-040); the agent resolves
driver-emitted cases in driver worktrees + produces context-free cold reads; pushes
and PRs remain behind D-030/031/034 gates and the 2026-07-18 freeze (local passes on
owner request). Doctrine step 4 rewritten @ f15b1c21 (estate + live).

fls-maintainer group refreshed: full folder backup, then fresh workspace (new clone
@ f15b1c21, bootstrap inventory, empty ledger carrying the freeze note); first driver
pass exercised via ncl chat (details in session log). Enforcement layer (agent
identity, branch protection, required CI — §12 adoption conditions) still pending.

## 2026-07-21 — OWNER: remote-branch sync + inventory candidates (D-045)

**D-045** (owner directives after the first live test drive):
1. The driver works with remote branches by MATERIALIZING them — remote-only
   inventory branches are planned from origin/* and get local branches created (or
   fast-forwarded) at run --execute through guardRef, journaled; local AHEAD = fine;
   DIVERGED = per-branch halt + owner escalation, never force-resolved. Supersedes
   the bootstrap tracking-branch loop and its stale-local trap.
2. New sweepable-namespace branches without inventory entries are auto-discovered as
   CANDIDATES with evidence-backed INHERITANCE in both directions (proposed parents:
   cut-from / merged-into / merge-base evidence with SHAs; proposed descendants:
   flagged requires-entry-edit). confidence 'clear' only for exactly one coherent
   acyclic placement; otherwise the record carries the specific open question and the
   agent must ASK THE OWNER. Standing invariant, code-enforced at every plan/run
   derivation: the inventory may only contain branches with proper/valid inheritance.
   Candidates are never merged; owner approval required before any entry is added or
   a descendant's parents are amended.
Implemented @ 28fbc7d4 on feat/maintenance-sweep (217 tests, tsc clean; spec §13);
agent clone + live doctrine redeployed. Accepted behavior: a diverged branch skips
the pass without blocking pass-complete (frozen-branch semantics; escalation = digest).

## 2026-07-21 — OWNER: communication policy (D-046) + session-store gap closed

**Session-store gap (root cause of the "re-asking settled questions" incident):** the
2026-07-21 group refresh wiped the group FOLDER but sessions live in
data/v2-sessions/<agent-group-id>/ + the sessions DB table. The pre-rollback Slack
session (created 07-10, 133k tokens) survived and resumed, dragging the whole old
context into the new sweep. Fixed: container stopped, sessions backed up
(~/backups/fls-maintainer-sessions-20260721.tar.gz), 2 session rows deleted, session
dirs + persistent container home + conversation archives removed. A COMPLETE group
refresh = folder + data/v2-sessions/<id> + sessions rows.

**D-046 (owner directive, doctrine @ 17abcafe):** channel rule = does the agent need
to stop? Doesn't stop → send_message one-line progress heartbeat (statements, never
questions). Stops → FINAL message block, exactly three cases: (1) new branch
candidates with suggested parents/descendants + recommendation — ask and stop;
(2) genuinely bad/unusual failures — report and stop; (3) one end-of-sweep result:
which PRs need which decision, one line each, or a single done-line. No digests, no
plan posts, no prose, no re-asking recorded decisions. (Commit history note: D-046
was amended 3× getting the channel semantics right — final form is 17abcafe.)

Noise-source cleanup: container-queue Option A extra_context RESTORED to the live
inventory (lost in the refresh because the raw bootstrap snapshot was copied instead
of a seeds-merged regeneration — refreshes must regenerate via fork-registry-generate
or re-apply seeds); stale fully-merged feat/propagation-driver branch deleted from
origin (+ its candidate YAML; backup ref refs/backup/20260721/feat/propagation-driver);
open candidate remaining for the owner: feat/channels/slack-reaction-typing (fork
point on a merge commit — parent ambiguous).

## 2026-07-21 — D-047: draft-PR freeze exception, driver bugs as issues, TOCTOU crash fix

**D-047 (owner directives after the first full driver sweep):**
1. Freeze amendment: driver-prepared fix/sweep/* branches + their DRAFT PRs are
   pushed/created by the AGENT (cold-read gated) — a prepared-but-local PR defeats
   "look at these PRs". Merging remains owner-only.
2. Driver bugs → the agent files GitHub issues (label sweep-driver, repro + journal
   pointer), cites the number in its final message; no fix prose in chat.
3. Boundary rule (owner, after the tooling session created PRs #49-#54 itself —
   closed/deleted): the owner-side session NEVER does the agent's work; it fixes
   doctrine/driver/workspace and the agent redoes the work itself.
4. B11 crash fix @ 235817e2: multi-parent TOCTOU — execution-time cleanliness
   re-probe demotes stale clean verdicts to cases/skips (journal 'demoted');
   commitTreeMerge failures become branch-local merge-failed halts; plan-drift
   check excludes driver-mutated branches. Tests 219. Deployed to the group clone.
Doctrine @ 4eea8b0e; live copy deployed. Candidate A (slack-reaction-typing) still
awaits the owner's placement answer; candidate B was a stale local-branch remnant
(cleaned).

## 2026-07-21 — OWNER: MERGE-POLICY.md canonical (D-049)

Owner dictated the corrected tier table + rules; written to scripts/sweep/
MERGE-POLICY.md (authority over PROPAGATION/DESIGN/doctrine). Highlights: CLEAN/
MECHANICAL merge PR-less (MECHANICAL = "conflict the agent is allowed to resolve" —
qualification rule REGULATED SEPARATELY, owner rule PENDING = G1); JUDGED non-draft
history PR auto-flipped by pushing the same merge commit; HELD = the only review
state (case 3 retired; escalation path = HELD); edition floor JUDGED auto-merges;
case = maximal run of consecutive path-intersecting conflicting heights (cap
routing.stack_cap, default 5); driver performs ALL pushes (verify-gated, order:
targets -> JUDGED closures -> HELD drafts -> posted urges); pre-PR height check
(ERR14); push failure = ERR15 = D-046 case-2 report, never worked around; exhibit
mechanism + API ref-fabrication deleted (ERR03/04 retired, never reused); doc 02 §5
"one PR per DAG edge batch" superseded. Audit + implementation @ 604cbbe8
(POLICY-AUDIT.md = the finding map; 250 tests). Pending owner: G1 rule;
rerere.enabled config policy for case worktrees; proxy push-fix deploy (first
propagate push will ERR15-report until deployed).

## 2026-07-22 — D-050: cold-read policy from evidence

Ran a data evaluation of the two cold reads against the bad-PR corpus (#13/#15/#33/
#34/#35/#55-#60 + live-pass verdicts). Findings drove owner decisions:
- **Kind 2 (PR-text) KILLED.** Zero unique historical catches; only ever produced
  cosmetic rewording; ~300k tokens/19min in one batch; adequacy already covered by
  ERR05 (recorded-decision) + ERR06 (duplicate) + lint. ERR09/ERR10/WARN04 retired.
- **Kind 1 (resolution) KEPT for all resolved cases** — it was the ONLY gate that
  catches the two real code defects in the corpus (#15 egress `return false` stub;
  #34 cross-branch copy) — both NOTHING-CATCHES for tsc + era tests + structural
  gates (stub type-checks; copied tests validate copied code; scope guard passes
  content inside conflicted paths). Owner: keep-all but FOCUS it — 3 bounded
  questions + judge-from-request-only preamble; deleted the open-ended
  "follow-on invariants" question (verify gate's job); UNVERIFIABLE -> fail-closed HELD.
  The one live false-positive (wirings reject) is now structurally suppressed (ERR05
  record + the reader gets the context it was starved of).
- ERR06 loosened to subset+shared-blob (caught the #60 near-duplicate the equality
  gate missed). rerere.enabled set repo-wide in the agent clone (owner (b)).
Implemented @ fad5133a (250 tests). Autonomous cycle: deploying to group + running.

## 2026-07-22 — D-051: verify validates the pass's publishable set (autonomous fix)

Found by the D-050 live run: the pass stopped at verify (RED, offender
module/runtime-updater ×8), never reaching push (so the predicted ERR15 proxy
failure was not even hit). Diagnosis: verify built a STATIC scope.yaml recipe merged
onto bare `main`, headed by the permanently-HELD module/runtime-updater; that merge
recreates 14 historical module-stack conflicts with no resolution → build aborts →
held branch blamed → no pre-ref → blocking ERR18 → whole push stage wedged. Because
something is always held, verify could NEVER be green ⇒ nothing ever publishes. Root
error: verify validated the whole frozen universe, not the pass's publishable result.
Fixes @ 27680ee5 (256 tests): recipe = advanced-this-pass branches (journal pre-ref),
DAG order, minus held/frozen/open-case, on main_patched not bare main; held offender
= non-blocking verify-observation, ERR18 only for a publishable branch with a pre-ref;
verify installs the rr-cache. DRIVER-mechanics decision (MERGE-POLICY §5 only requires
"verify green before push", does not define the recipe) — taken under the owner's
autonomous mandate. Residual risk flagged: a published child of a held parent is safe
only when their conflict paths are disjoint (else DEFERRED freezes the child);
governed by plan derivation, worth a check if a child ever publishes under a held
parent. SEPARATE pre-existing debt (NOT fixed — branch content, agent's job on a
future sweep): module/runtime-updater fails prettier format:check on 8 files.
Deploying + re-running.

## 2026-07-22 — D-052: bounded resolve cycle (stale-verdict clear + convergence cap)

Found by the 2026-07-22 clean run: the pass burned 4×~130k-token compactions across 5
cases and died with ZERO `resolved` and NO owner message. Root cause: `resolve --case X
--execute --resolved-ref <ref>` regenerated `coldread-request.md` unconditionally but
NEVER cleared `coldread-verdict.json`. The verdict carries a `resolvedTree` freshness
binding; when the agent's resolution commit changed between attempts (re-resolve / amend
/ different `--resolved-ref`), the on-disk verdict still attested to the OLD tree, so
every retry rejected as "stale" while the driver kept rewriting the already-fresh
REQUEST. Told "stale", the agent deleted+regenerated the REQUEST (the wrong file — the
stale one was the VERDICT), so the mismatch never cleared → unbounded
delete/regenerate/re-read loop. Fixes (propagate.ts cmdResolve, 260 tests): (1) on
`--execute` regeneration, a verdict attesting a DIFFERENT tree is auto-retired to
`coldread-verdict.stale.json` (RENAMED, recoverable) + journaled
`stale-verdict-cleared`/`WARN05_STALE_VERDICT_CLEARED`, so the clean "produce the verdict"
path fires for the new tree; a MATCHING verdict is kept (idempotent re-run still confirms
in one shot). (2) Every missing/stale-verdict message names `coldread-verdict.json` and
states the driver owns `coldread-request.md` — NEVER delete it. (3) Anti-thrash cap:
`coldread-attempt` journal entries track distinct resolution trees; beyond
`RESOLVE_COLDREAD_CAP` (3) the case is force-HELD (`ERR26_RESOLVE_NOT_CONVERGED`, owner
review) rather than looped. (4) `propagate report` — a journal-ONLY end-of-sweep summary
(merged / resolved / held / open-cases / pushed; no git, no GitHub) so a dead session
still leaves a readable status and the D-046 owner message is a thin wrapper that always
emits. DRIVER-mechanics decision under the owner's autonomous mandate; doctrine
(CLAUDE.local.md) + PROPAGATION.md §7/§14 + ID tables updated. Skeptical re-review point:
auto-clearing can only ever discard a verdict whose `resolvedTree` != this
`--resolved-ref`'s tree (a matching one is untouched), and it RENAMES rather than deletes,
so a mis-passed `--resolved-ref` is recoverable — it cannot silently drop a still-valid
verdict for the resolution being confirmed.

## 2026-07-22 — D-053: sweep state machine (canonical agent interface)

Built the resumable SWEEP STATE MACHINE that becomes the AGENT-facing surface, superseding
the flag-based `plan/run/resolve/publish/push` as the agent's commands (those stay as the
driver's internals). Spec: `scripts/sweep/SWEEP-STATE-MACHINE.md` (owner-settled). Five
commands + `abort`, all on `scripts/sweep/sweep-machine.ts` (thin CLI) over new functions in
`propagate.ts` (in-module reuse of every deterministic internal): `start` (refuse an open
pass — ERR30; pin watermark via cmdPlan; init machine-state), `next-case` (drive cmdRun —
CLEAN/skip/DEFERRED + barrier/reopen — and serve the topmost undispositioned case or
finalize; ZERO agent params), `report-case --tier` (deterministic checks: worktree snapshot
→ empty/unresolved-markers → scope guard → branch-scoped tests (opt-in --commands-file) →
ERR05/ERR06 adequacy → per-case attempt cap force-HELD; then cold read PLACEMENT — mechanical
runs it HERE → merge, judged/held defer → "provide PR description"; demote-only), `report-pr`
(single cold read over resolution diff AND description; held PUBLISHES the draft NOW — it
lands nothing on a target so it skips the ERR14 origin-currency check and the target push;
judged merges + records intent, PR created at finish; description-only defect → rewrite,
code reject/UNVERIFIABLE → fail-closed HELD), `finish` (verify publishable set → JUDGED PRs
→ push targets + closures + urges → owner report → upstream-advanced check; multi-step +
resumable — red verify / ERR15 halt and re-run from the stopped phase; pushes never redo).

The cold read is the ONLY LLM call in the loop, run by the driver as a synchronous `claude
-p` subprocess through an INJECTABLE `ColdReadInvoker` (default shells `claude -p`, parses a
JSON verdict from stdout, fail-closed on unparseable; tests inject a fake) — so on the
state-machine path there is NO `coldread-verdict.json` file and NO freshness binding (the
driver holds the tree and pipes the request straight in). Branch-scoped tests + the GitHub
transport are likewise injectable. State: a `machine-state.json` (phase ∈ open/case-ready/
awaiting-pr/finishing/complete + currentCase + watermark) in the pass dir + the journal, so
every command is resumable and a dead container resumes exactly; all transitions journaled.

KEPT (not removed) the old `cmdResolve`/`cmdPublish`/`cmdPush` flag path and its verdict-file
+ freshness machinery: it is still the driver's tested implementation and the source of the
sub-helpers the machine reuses (reverifyCase, freezeHeld, journaledResolvedMerge, publishHead,
cmdVerify, cmdPush, cmdPublish-for-JUDGED). Removing it would delete the reused internals and
break dozens of tests for no benefit; it is simply no longer the agent surface. Tests: 260 →
278 green (18 new in `sweep-machine.test.ts`); tsc clean. Doctrine (CLAUDE.local.md sweep-loop
rewritten to the five-command flow + ERR30-34 id rows), PROPAGATION.md (agent-surface note),
MERGE-POLICY.md (state-machine cross-ref + HELD-publish-timing amendment) updated. Skeptical
re-review points: (a) HELD-draft publish at `report-pr` deliberately bypasses cmdPublish's
ERR14 held-base check via a dedicated `publishHeldDraftNow` (D-053 changes the D-049 held-
after-push timing) — confirm that is intended; (b) the "cheap branch-scoped test" default is
a no-op unless `--commands-file` is supplied (finish's full rebuild is authoritative) — the
deployment must wire a real cheap command list; (c) the report-pr HELD cold read judges the
description against the CONFLICT (no resolution exists for a frozen exhibit).

## 2026-07-22 — D-053: sweep state machine (zero-param agent interface)

Owner redesign (SWEEP-STATE-MACHINE.md): the agent surface becomes 5 commands
(start/next-case/report-case --tier/report-pr/finish + abort) over the unchanged
deterministic propagate internals; the driver owns all state (machine-state.json:
phase+currentCase+watermark, + journal), so the agent passes ZERO identifying params
— only edits the worktree, writes PR prose, claims --tier. Structurally removes
wrong-case/wrong-ref/stale-verdict/forged-plan/delete-wrong-file. Cold read = driver
spawns `claude -p` synchronously (injectable; fail-closed; no verdict file/freshness);
placement: mechanical at report-case, judged/held at report-pr over resolution+
description in ONE call. Publish timing: HELD draft published at report-pr (lands
nothing on a target, no verify dep); JUDGED/CLEAN/target pushes gated to finish behind
the full-integration verify (D-012). Candidate inheritance = deterministic git
derivation + owner escalation (never claude -p); overlap/PoI = owner report, not inline.
Crash-resumable; silent death impossible (journal-derived report). @ b6e830c6, 278
tests. Known gap: report-case branch-scoped tests default no-op until --commands-file
wired (finish full rebuild is the authoritative gate). Old cmdResolve/Publish/Push kept
as reused internals, no longer the agent surface.

## 2026-07-22 — D-054: observable progress + cold-read auth/infra-halt

Observability: driver prints low-frequency major-step `SWEEP-STEP:` lines; the single
`SWEEP-RESULT:` line is the agent's guidance; nested flag-command output suppressed
when internal (cli.internal) so a backgrounded command streams exactly one result
(kills the multi-JSON parse hazard). Doctrine: next-case/finish run BACKGROUNDED with
an UNFILTERED monitor; agent relays each SWEEP-STEP via send_message, acts on the one
SWEEP-RESULT. Cold-read AUTH (owner fix): `claude` scrubs env for its bash
subprocesses so the spawned `claude -p` lost CLAUDE_CODE_OAUTH_TOKEN — inject it from
~/.claude/.credentials.json into spawnSync env (proxy then authenticates). Cold-read
INFRA-vs-CONTENT gap (flagged design flaw): MachineVerdict gains verdict:'error';
spawn/exit/unparseable/auth-text → ERR35_COLDREAD_UNAVAILABLE HARD HALT (report+stop,
case stays retryable) — no longer silently freezes every resolution HELD as if judged
bad. @ eb608f68, 287 tests. STILL the agent's own fix behavior (D-046) is the backstop;
now the driver detects it deterministically.

## 2026-07-22 — D-055: infra-fail never HELD + pass-lifecycle/workspace correctness

Triggered by owner ("failures must be reported immediately, not HELD") + a ground-truth
artifact registry. Root cause of the whole "cleanup mess": C-1 — the driver's
--workspace resolved to the fork CLONE (repo/), so the pass, a throwaway 460-byte
sweep-ledger.json, and a missing rr-cache all landed in the clone — splitting per-pass
from durable state, DIVERGING the real freeze ledger, and KILLING rerere
(rerereSeeded:0, every conflict re-resolved). Fixes @ 4db1c893 (298 tests):
- Cold-read INFRA failure (spawn/exit/unparseable/auth, or the 'claude -p failed …
  fail-closed' reject-notes poison) → ERR35 hard-halt + owner report, NEVER HELD/reject,
  on report-case, report-pr AND the legacy cmdResolve. Only a cold read that RAN and
  rejected → HELD. State machine runs the read inline (no verdict file) = immune to
  stale poison.
- C-1: --workspace defaults to group root (dirname(--repo)); start refuses a workspace
  at/under the fork-clone toplevel (ERR37, keyed off `git -C <repo> --show-toplevel`,
  NOT 'any work tree' — the group root legitimately sits inside the outer nanoclaw2
  repo; caught by checking the real server layout before committing).
- C-3/C-5/C-2b: start removes the WHOLE prior pass tree + quarantines inherited
  verdicts (in-container teardown; host rm fails on container-uid files). C-4: abort
  appends pass-complete so attachPass stops re-attaching an aborted pass.
Operator escape hatch: bin/clean-slate.sh (+ server-dir copy) — idempotent, --dry-run/
--reset-branches, targets both propagation locations + DB session rows + root-owned
transcript dir (docker-as-root) + temp cli-local wiring/destination. Registry itself
(state table + artifact registry + C-1..C-7) is the authoritative map for future work.
NOT yet deployed/run — held for owner go.

## 2026-07-22 — D-056: per-case job is TIGHT and bounded (agent context blowup)

Triggered by a live run: resolving ONE merge conflict burned ~130k tokens/case and
compacted the agent's context repeatedly. Root cause is doctrine, not driver: (a) the
case worktree is the WHOLE repo checkout (752 files), and (b) the "Case comprehension"
block told the agent to "study the case worktree and materials until you can explain
both sides… if you cannot explain both sides, study the case MORE" — an open-ended
research directive that, in a 752-file tree, sends the agent grep/read/log/exploring
far beyond the conflict. Owner: "the agent should be acting only per merge resolution,
this should not require huge context, not 100k." AGENT-facing changes ONLY — no
driver analysis/cold-read/state-machine logic touched; tests stay 298 green.
- CLAUDE.local.md "Case comprehension" → MINIMAL SCOPE: the driver already did all
  analysis; the agent's ONLY job per case is to edit out the conflict markers in the
  named conflicted paths, opening/reading NOTHING else; the two sides + the
  materials brief ARE the context; "cannot decide" → `--tier held`, NEVER "explore
  more." Stacked-RUN rule (one decision/resolution/cold read) preserved.
- CLAUDE.local.md sweep-loop step 3 (route annotate-PoIs + per-feature overlap
  subagents) neutralized: candidate/overlap/PoI analysis is the DRIVER's now
  (D-045) — the agent only relays what the driver surfaces; per-sweep overlap
  subagents were dead pre-driver work and a context sink. Autonomy-boundaries and
  the PR-text (D-031) block tightened to the same principle (no repo exploration to
  write PR prose; not-enough-context → held).
- propagate.ts materials generators (machineCaseMaterials + prepareCaseMaterials)
  gain a prominent header: "RESOLVE ONLY these conflicted paths… do not open or read
  any other file… if the two sides + this brief are not enough, use `--tier held`,"
  with the conflicted paths listed first. Materials kept small (short directive, not
  more content) — wording change only, no code logic altered.
Working tree left for owner review (no commit/push).

## 2026-07-23 — D-057: merge-propagation sweep redesign (block model + rooted scope + unified HELD publish)

Owner-directed redesign of the sweep driver's freeze/defer/publish machinery, folding
several live-run pains into one change-set. Implemented on feat/maintenance-sweep and
gate-green (308 tests, tsc clean). Authority: MERGE-POLICY.md §1/§5 rewritten to match.
- **Pending-diff worktree** (propagate.ts cleanPrefixTree + createCaseWorktree): the
  driver commits the CLEAN PREFIX (automerge tree, conflicted paths reset to base/ours)
  as the case worktree HEAD and writes ONLY the conflicting delta (marker content) to
  the working tree, so `git status` = exactly the conflicted paths and the agent reviews
  only that delta, never the 752-file checkout (the D-056 context sink). On-disk bytes +
  `add -A; write-tree` snapshot are identical to the old full checkout → empty-check /
  scope-guard / cold-read diff unaffected.
- **ROOTED case scope** (doctrine): the agent investigates/fixes only what the merge
  DIRECTLY causes (the conflict + any change the merge forces, e.g. a caller of a changed
  signature, even outside the pending files); unrelated reads/edits banned; cannot resolve
  rooted → `--tier held`; a cross-file rooted fix stays cold-read gated and, if sound,
  ships as a HELD-review PR (never auto-merged). Supersedes D-056's open-ended rooted-read
  latitude with a merge-implication boundary.
- **merge_status block model** (types.ts, ledger.ts): per branch `merge_status ∈
  {PR_ID | DEFERRED | NONE}` (NONE = absent), invariant `blocked(X) ⇔ merge_status(X) !=
  NONE` always. No height/path stored (heights are live per-pass). PR_ID persists from
  hold until the branch is COMPLETELY resolved (owner merges the PR AND the merge lands),
  never cleared mid-way; DEFERRED sticky while any direct parent is blocked, clears only
  when ALL parents NONE → re-merge fresh. Replaces the retired independent freeze fields
  (status:'frozen', frozenBy, heldHead, heldPaths, fixBranch, pendingBehindFreeze);
  readLedger up-converts legacy files.
- **Pure height-MIN DEFER** (deferred.ts checkDeferred; plan.ts + propagate.ts thread a
  live blockHeightOf map into both derivePlan and deriveLive): X's own conflict at height
  h defers iff a direct parent is blocked AND h ≥ MIN(blocked parents' heights); below the
  MIN it is X's OWN conflict (normal ladder). RETIRES the pre-D-057 `(floor, N′]` window +
  conflicted-path intersection + per-transitive-ancestor rule — no path check, direct
  parents only. (The clean-prefix-merge + defer-above case is inherently multi-parent; a
  single-parent chain auto-unfreezes because the parent tip already contains the held head.)
- **Unified HELD publish** (publish.ts, propagate.ts publishHead): key = does a
  MARKER-CLEAN resolution exist? marker-clean → ACTIVE (non-draft) PR at the resolved
  merge commit, owner reviews & merges (driver never auto-merges a HELD PR — auto-merge
  stays JUDGED); markers remain / `--tier held` → DRAFT PR from the PRISTINE conflict
  (clean-prefix + original automerge tree, NO agent edits — owner resolves fresh). Retires
  the synthetic exhibit-head mechanism entirely.
- **Cold-reviewer feedback** (ColdReadVerdict/MachineVerdict gain a bounded `feedback`):
  a short 1-2 line reason returned on a reject is surfaced to the agent to revise, and
  reused as the PR-description prefix on any HELD escalation.
- **Scope-exceeded → active PR** and **2×-reject → escalation**: a scope violation no
  longer demotes to HELD before the cold read — `scopeExceeded` is carried forward, the
  cold read judges the RESOLUTION, agree+scope → HELD ACTIVE PR flagged `[AUTO-ESCALATED:
  scope exceeded]` (never auto-merged); scope-OK+agree → JUDGED. Cold-read rejections are
  counted per case: 1st reject surfaces feedback (no freeze), 2nd reject stops retrying →
  HELD (active if marker-clean, else draft pristine) flagged `[AUTO-ESCALATED: cold read
  rejected 2x]` + feedback. Tightens/replaces the old 3-distinct-tree convergence cap
  (`[AUTO-ESCALATED: resolution did not converge]`).
D-057 label used in code comments only (not agent-facing). Docs: MERGE-POLICY.md updated
this session; doctrine (CLAUDE.local.md) rooted-scope wording folded in with the change-set.

## 2026-07-23 — D-058: PRs-at-finish + stateless origin-derived start (on top of D-057)

Follow-on to D-057, folding the publish-timing and cross-pass-persistence machinery into
one change-set. Implemented on feat/maintenance-sweep and gate-green (326 tests; the new
`scripts/sweep/tsconfig.json` typecheck below is clean). Authority: MERGE-POLICY.md
header + §1/§5 and SWEEP-STATE-MACHINE.md §2/§3 amended to match.
- **ALL PRs are created at `finish`, after verify** (propagate.ts cmdSweepFinish +
  cmdSweepReportPr): `report-pr` now publishes NOTHING — it records the publish INTENT
  (a `pr-intent` journal row: tier, resolved merge commit, active-vs-draft, escalation
  prefix + reviewer feedback). JUDGED history PRs AND held PRs (active + draft) are all
  created in `finish` post-verify, in phases verify → judged-prs → push (targets +
  closures + urges) → held-prs → report. This SUBSUMES the D-057 open item #5 (active
  HELD-review PRs could bypass the full-integration verify gate and land unverified
  prefix merges when the owner merged one before `finish`): the ERR14 held-ordering now
  applies to every held PR because their bases are the pushed, verified tips.
- **`start` is stateless / origin-derived + networked** (propagate.ts cmdSweepStart +
  deriveOriginMergeStatus): it reconstructs the blocked set from the origin `fix/sweep/*`
  refs — merged into `origin/<target>` → resolved + delete the ref; unmerged WITH an open
  PR → PR_ID (blocked); unmerged WITHOUT an open PR → delete the orphan ref (so a branch
  can never be stuck blocked-but-invisible). `start` fetches origin+upstream first (fetch
  failure = `ERR39_FETCH_FAILED`, so no pass opens on a stale view) and now takes
  `--token-file` (it queries GitHub for open PRs; the lookup is fail-closed — only an
  authoritative HTTP 200 may decide blocked-vs-orphan, so an API failure never deletes a
  ref with a live PR). The ledger `merge_status` authority and the D-057 reconcile/settle
  machinery are RETIRED: the block-model semantics still describe within-pass blockedness,
  but persistence across passes lives in origin's refs, so the local pass dir is disposable
  — a pass that crashes before `finish` published nothing, and the next `start` re-derives
  a clean picture from origin.
- **`scripts/sweep/tsconfig.json` typecheck gate**: the root tsconfig includes only
  `src/**`, so `tsc --noEmit` NEVER type-checked `scripts/sweep` (vitest only type-strips)
  — the driver had no real typecheck. Added `scripts/sweep/tsconfig.json` (extends root,
  `noEmit`, includes `scripts/sweep/**/*.ts`); `tsc -p scripts/sweep` is now the real
  typecheck gate for the driver.
Key files: scripts/sweep/propagate.ts (cmdSweepStart, deriveOriginMergeStatus,
cmdSweepReportPr, cmdSweepFinish), scripts/sweep/tsconfig.json. D-058 label used in code
comments only (not agent-facing). Docs updated this session: MERGE-POLICY.md,
SWEEP-STATE-MACHINE.md, estate/fls-maintainer/CLAUDE.local.md.

## 2026-07-23 — D-059: interactive PR review loop (on top of D-058)

Follow-on to D-058, turning held PRs into a two-way review loop instead of a one-shot
publish. Implemented on feat/maintenance-sweep and gate-green (338 tests; `tsc -p
scripts/sweep` clean). Authority: MERGE-POLICY.md + SWEEP-STATE-MACHINE.md D-059
amendments; agent-facing doctrine (CLAUDE.local.md) folded in this session.
- **`start` per-ref classification, orphan-delete RETIRED** (deriveOriginMergeStatus): a
  MERGED ref is now the ONLY delete. Per origin `fix/sweep/*` ref — merged into
  `origin/<target>` → resolved + delete; closed-unmerged PR → REOPEN the PR (PATCH
  `state=open`, reopenPullRequest) → PR_ID; ref present with NO PR (crashed publish) →
  create/recover the PR from the ref head (createRecoveryPr — the ref resolution is
  authoritative, never re-derived; draft-vs-active from whether markers remain in its own
  diff) → PR_ID; ref ABSENT → re-derive the conflict fresh (new case → new PR at finish);
  open PR + a NEW human comment → REISSUE (below); open PR + no new comment → PR_ID. A
  ref whose slug matches no scope branch is journaled `origin-ref-unknown` and left alone.
  Every GitHub lookup/write is FAIL-CLOSED (non-200 = ERR13; missing token = ERR11) — an
  API failure never reads as "no PR" nor deletes a ref with a live PR.
- **Stateless `sweep-addressed` marker** (publish.ts renderSweepAddressed / SWEEP_ADDRESSED_RE
  / classifyComments / postSweepAddressed): the driver posts a
  `<!-- sweep-addressed: <comment-id> -->` comment on every held PR at `finish` (0 on a
  first publish, else the highest human comment id the published resolution addressed) and
  RE-ASSERTS the current value on every urge comment. A HUMAN comment is any PR
  issue-comment WITHOUT the marker — AUTHOR-BLIND, so it survives the shared PAT (the
  driver's own comments carry the same author but ARE excluded by content). The effective
  addressed id is the MAX over all marker occurrences (monotonic); a ref is due for reissue
  when the newest human comment id exceeds it (or ≥1 human comment and no marker yet).
- **REISSUE = revise, not re-resolve** (materializeReissueCase, reissueCaseMaterials,
  cmdSweepReportCase force-HELD): `start` manufactures the prior case again this pass —
  conflict head = the ref head's 2nd parent, parent+height parsed from the deterministic
  ref name, the conflict RE-PROBED live against `origin/<target>`, the worktree
  materialized FROM the prior resolution, and ALL human PR comments stored verbatim
  (pr-comments.json) for the materials. The agent REVISES that resolution to address the
  comments (never starts over, edits only the conflicted paths). `report-case` ALWAYS
  forces the reissue HELD (a revision must not merge in place and bypass the open review);
  a non-driver-shaped or healed ref degrades to a plain PR_ID block (journaled warning).
- **Force-with-lease reissue, same PR** (cmdPublish reissue path, git.ts gitPush
  forceWithLease): the revised head is pushed onto the EXISTING fix ref with `git push
  --force-with-lease` on the start-classified prior head (compare-and-swap, never blind);
  the driver PATCHes the SAME PR's title/body from the agent's revised prose and posts a
  fresh marker at the addressed id — never a second PR for the same review.
- **`finish` PR summary + stats** (collectPassPullRequests, cmdSweepFinish success result):
  the ONE success `SWEEP-RESULT` now carries a `pullRequests` list — every PR this pass
  touched (open-at-start, reopened, recovered, created, reissued), each with number, url,
  title, live status, and a `kind` (review-open-at-start / reopened / recovered-publish /
  judged-history / held-review / held-review-reissued) — plus a `stats` block (branches in
  scope, clean merges, resolved mechanical/judged, held, deferred branches, PRs
  created-judged/created-held/reissued/reopened/recovered/open-at-start, upstream-advanced,
  watermark) and an `instruction` to REPORT the PR list + stats to the owner. Titles are
  journal-derived (pr/title.txt) with a best-effort live refresh (a lookup failure keeps
  the journal values — the summary never fails a green finish).
Key files: scripts/sweep/propagate.ts (deriveOriginMergeStatus, materializeReissueCase,
createRecoveryPr, reissueCaseMaterials, cmdSweepReportCase, cmdPublish, cmdSweepFinish,
collectPassPullRequests), scripts/sweep/publish.ts (classifyComments / getPrsByHead /
reopenPullRequest / postSweepAddressed / listIssueComments), scripts/sweep/git.ts
(gitPush forceWithLease). D-059 label used in code comments only (not agent-facing). Docs
updated this session: MERGE-POLICY.md, SWEEP-STATE-MACHINE.md,
estate/fls-maintainer/CLAUDE.local.md.

## 2026-07-24 — D-059 FINAL: review-driven PR loop + push resilience (redesign of the 2026-07-23 D-059)

The 2026-07-23 D-059 built the loop on ISSUE COMMENTS (any new human comment triggered a
reissue; a no-PR ref was an orphan to delete). This FINAL revision moves the whole loop
onto SUBMITTED REVIEWS and makes `finish` per-branch push-resilient. Implemented on
feat/maintenance-sweep and gate-green (349 tests; `tsc -p scripts/sweep` clean).
Authority: MERGE-POLICY.md + SWEEP-STATE-MACHINE.md D-059 amendments (2026-07-24);
agent-facing doctrine (CLAUDE.local.md) folded in this session.
- **Trigger = SUBMITTED REVIEWS ONLY** (publish.ts classifyReviewTrigger + listReviews;
  marker retagged to `<!-- sweep-addressed: <review_id> -->`): a reissue is due iff a
  submitted, non-`*[bot]` review exists whose id is above the marker (or ≥1 such review
  and no marker yet). PENDING reviews are dropped; loose issue comments and standalone
  inline comments NEVER trigger — they only FEED the reissue dialog. The marker is
  recognized ONLY as its own line (SWEEP_ADDRESSED_LINE_RE, anchored), the bot/human
  split is by CONTENT (the shared PAT authors both), and the effective addressed id is
  the MAX over all marker occurrences (monotonic). This retires the D-059-initial
  comment-id trigger.
- **Review-state → action table, all landing verify-gated at `finish`**
  (deriveOriginMergeStatus open-PR arm + landApproved): APPROVED + the ref head still
  merges CLEANLY into the current target → the DRIVER lands it (merges into the local
  target now, journals `origin-approved` + `resolved` tier `approved`, pre-ref recorded;
  the branch is left UNBLOCKED, `finish` verifies + pushes → the PR auto-flips merged,
  D-040) — NO reissue, and the driver still never hand-merges the PR; APPROVED but STALE
  (target advanced, no longer clean) → REISSUE (re-resolve vs the new base);
  CHANGES_REQUESTED / COMMENTED / other → REISSUE → forced HELD (stays in the review
  loop, never merges in place).
- **`start` per-ref classification — orphan-delete RETIRED, a MERGED ref is the ONLY
  delete** (deriveOriginMergeStatus): merged / `merged_at`-set (squash/rebase) → resolved
  + delete the ref, NEVER a reopen (a merged PR 422s a reopen); closed-unmerged → REOPEN
  (PATCH state=open) → PR_ID; ref-present-with-NO-PR (crashed publish) → RECOVER (create
  the PR from the ref head, the ref resolution authoritative, never re-derived) → PR_ID;
  ref ABSENT → re-derive the conflict fresh; a ref whose slug matches no scope branch is
  journaled `origin-ref-unknown` and left alone. Every lookup/write is fail-closed
  (non-200 = ERR13; token missing while unmerged refs exist = ERR11). Supersedes the
  D-058 (b) "unmerged-without-a-PR → orphan, delete it" rule.
- **Reissue feed = the FULL time-ordered dialog** (buildReviewDialog +
  materializeReissueCase + reissueCaseMaterials): PR description + issue comments + inline
  review comments + review bodies merged time-ordered; the agent's OWN prior turns
  (driver-posted marker-bearing comments + the PR description it wrote) served TAG-STRIPPED
  and marked `you (prior)`, every other turn keyed by its GitHub @login, the PR
  description pinned as the opening turn. The agent REVISES the prior resolution (edits
  only the conflicted paths), never restarts; `report-case` ALWAYS forces the reissue HELD
  (cmdSweepReportCase); `finish` republishes to the SAME PR (cmdPublish reissue path,
  git.ts gitPush force-with-lease onto the start-classified prior head — never a second
  PR). Owner-pushed commits on the fix branch (head not driver-shaped) → the case is
  REBUILT from the CURRENT ref head (the owner's edit is the revision base), conflict head
  re-derived from the ref-name sha8, journaled `reissue-rebuilt`. A truly unusable ref
  (unparseable name, unrecoverable conflict head, healed conflict, missing origin base) is
  ESCALATED ONCE (a driver comment naming the problem + the marker at the triggering
  review id, so no per-pass re-trigger); the branch stays blocked, no reissue case.
- **Push resilience + resumable partial finish** (cmdPush + cmdSweepFinish): `finish`
  pushes each target branch INDEPENDENTLY; a failure is categorized (diverged / transient
  / auth) and journaled `push-failed`, and the remaining branches proceed — `ERR15` is now
  a PER-BRANCH label, NOT a hard stop. A failed held publish is likewise per-case and
  non-fatal (`publish-failed`, retries next finish). A partial finish is NOT sealed (the
  machine state stays `finishing`) and is RESUMABLE — re-running `finish` retries exactly
  the failed pushes/publishes (landed branches skip as up-to-date, verify re-gates,
  pushes/PR-creates never redo). Only a GLOBAL failure with no per-branch rows (red verify
  gate, missing token, closure check) still halts.
- **`finish` SWEEP-RESULT summary + stats** (collectPassPullRequests + cmdSweepFinish):
  the one success/partial result carries `status` (complete|partial), `pullRequests`
  (every PR the pass touched — open-at-start / reopened / recovered / judged-history /
  held-review / held-review-reissued / approved-landed, each with number, url, title, live
  status, `kind`, and a landed/failureCategory annotation), `branches` (per-branch landed
  vs failed), `failedPushes`/`failedPublishes`, a `stats` block (branches in scope, clean
  merges, resolved mechanical/judged, approved-landed, held, deferred branches, PRs
  created-judged/created-held/reissued/reopened/recovered/open-at-start, targets
  landed/failed by category, upstream-advanced, watermark), and an `instruction` to REPORT
  landed-vs-conflicted branches + the PR list + stats to the owner.
Key files: scripts/sweep/propagate.ts (deriveOriginMergeStatus, landApproved,
materializeReissueCase, buildReviewDialog, reissueCaseMaterials, createRecoveryPr,
cmdSweepReportCase, cmdPublish, cmdPush, cmdSweepFinish, collectPassPullRequests),
scripts/sweep/publish.ts (classifyReviewTrigger, listReviews, SWEEP_ADDRESSED_LINE_RE,
renderSweepAddressed, classifyComments, listIssueComments/listReviewComments,
reopenPullRequest), scripts/sweep/git.ts (gitPush forceWithLease). D-059 label used in
code comments only (not agent-facing). Docs updated this session: MERGE-POLICY.md,
SWEEP-STATE-MACHINE.md, estate/fls-maintainer/CLAUDE.local.md.

## 2026-07-24 — VALIDATION BUGFIX: reopen-superseded stale case → ERR02 loop (bug #63)

Live full-sweep validation of D-057/058/059 on the fls-maintainer group surfaced a real
driver bug (the agent correctly diagnosed it, filed GitHub issue #63, aborted cleanly, and
reported to owner — never worked around it). Root cause, subtler than the agent's first
read:

- Resolving a case reopens its branch + transitive descendants (§8). The next `run`
  re-derives each reopened branch against its now-ADVANCED parent and re-emits a FRESH case
  — new conflict head, new HEIGHT (so a new caseId), new conflict set. Observed:
  `main_patched--main-h174` resolved → `main_patched` re-merged main to h180 →
  `module/container-queue` re-emitted as `--main_patched-h180`
  (paths `[poll-loop.ts, src/index.ts]`) superseding the original `--main_patched-h169`
  (paths `[poll-loop.ts]`).
- The pre-reopen case is NEVER dispositioned (it was superseded, not resolved/held), so it
  lingered in every "open case" reader. `openCases` sorts by journal index → served the
  STALE `-h169` case FIRST; the agent resolved against it; `report-case` recomputed the
  fresh tree and fired `ERR02_CASE_STALE` (recorded head ≠ recomputed). Re-running
  `next-case` (the sanctioned ERR02 recovery) re-served the same stale case →
  INFINITE LOOP, forcing abort. `openCaseBranches` would also have excluded the branch
  from the publishable set forever, and the pass-complete gate would never seal.

Fix (propagate.ts): a single `supersededCaseIds(journal)` helper — a case whose LAST
`case` entry precedes its branch's most-recent `reopened` is dead (uses the last entry, not
`firstIndex`, so a same-caseId re-emit after the reopen survives). Wired into `openCases`,
`openCaseBranches`, and the status log. A reopen that re-emits nothing (branch healed /
merged clean / deferred) correctly leaves the branch with no open case. Derived-state only
(D-058 model) — no new journal action. Regression test in `publishableRecipe`. Gate:
`tsc -p scripts/sweep` clean, 361 tests green. Shipped 55f2e8d9 on feat/maintenance-sweep,
deployed to the fls-maintainer clone (clean-slate --reset-branches), re-run for validation.

Also validated live this run BEFORE the bug: the D-057 resolve→cold-read→confirm→merge
flow end-to-end (`main_patched--main-h174` groups.ts, mechanical, cold-read verdict
`confirm` with substantive notes), pending-diff `case-worktree` materialization
(`rerereSeeded`), worktree idempotency (23 emitted / 23 removed), and the D-058/ERR21
un-skip pre-probe (2 clean `unskip-conflict` aborts, no ERR21). Issue #63 belongs to the
maintainer agent — driver fixed here; the agent verifies/closes it on its successful re-run.

### 2026-07-24 addendum — bug #64 (same root cause, unpatched reader) + test-coverage correction

The #63 fix patched three open-case readers but MISSED a fourth: `duplicateCaseIssue`
(the ERR06_DUPLICATE_CASE detector). So `next-case` correctly served the fresh h180 case,
but `report-case` fired ERR06 every time — the superseded h169 (undisposed, a path-subset
of h180 with a byte-identical shared-path conflict blob) read as a live topmost sibling,
and `next-case` would never serve it → a SECOND infinite loop (agent filed issue #64,
stopped cleanly). Fix: `supersededCaseIds` is now consulted in `duplicateCaseIssue` too
(4 readers total). Lesson: a lingering-derived-state fix must patch EVERY reader of that
state — enumerate them.

Correctness guard the expanded tests caught pre-deploy: a resolve/hold reopens the branch
for DESCENDANT propagation (§8); the naive "case before reopen = superseded" rule wrongly
marked the just-held case superseded, dropping it from the ERR06 scan (two pre-existing
ERR06 tests went red). `supersededCaseIds` now supersedes only UNDISPOSED cases.

Test-coverage correction (owner flagged "why dont you have regression tests"): the #63
commit shipped ONE test that only exercised `openCaseBranches` — which is exactly why the
ERR06 reader slipped through. Now: a dedicated describe unit-testing `supersededCaseIds`
AND `openCases` directly on the live h169→reopen→h180 serving shape + edges (same-caseId
re-emit survives, reopen-without-re-emit leaves no open case, disposed case not resurrected);
and an ERR06 (#64) fixture test via `duplicateCaseIssue` with a CONTROL (no-reopen → ERR06
DOES fire) proving the fixture is a genuine signature match. tsc clean, 367 tests green.
Shipped 0787fd88, redeployed (clean-slate --reset-branches), fresh validation sweep running.

### 2026-07-24 addendum — bug #65 (ERR05 decided-already dead-ends the judged path)

Third bug found by the live validation run (after #63/#64). `report-case` and the publish
check battery (`reverifyCase`) both ran `decidedAlready` (ERR05) UNCONDITIONALLY and then
hard-blocked. But ERR05's own prescribed action is "apply the recorded decision AS A JUDGED
resolution, not re-ask the owner" — so `report-case --tier judged` (the agent doing exactly
that) re-hit ERR05 with no exit. Agent looped on module/host-rpc, filed #65, stopped.

Fix (5a68c9bf): ERR05 is SATISFIED by a judged resolution. report-case pushes it only when
effectiveTier !== 'judged' (still steers mechanical/held to judged); the publish battery
runs decidedAlready only when mode !== 'judged'. ERR06 (duplicate) unchanged — blocks any
tier. Tests: sweep-machine.test.ts — judged decided-already NOT blocked (→ awaiting-pr);
mechanical STILL blocked (→ ERR05, steer to judged, no merge). tsc clean, 369 tests.

Deployed via IN-PLACE code update (git reset the group clone to origin, NO clean-slate) so
the pass was PRESERVED — the 3 already-resolved cases (main_patched + module/container-queue
x2) kept, agent resumed from module/host-rpc rather than re-running from scratch. This is
both faster and more likely to reach finish (the agent hits a context compaction ~every 3
cases and a full 12-case restart accumulates more of them).

PATTERN (3 bugs, same shape): each was a report-case/publish GATE that dead-ended a
legitimate forward path — #63/#64 a reopen-superseded case lingering in open-case/duplicate
readers, #65 an adequacy gate not recognizing its own prescribed exit tier. The 360-test
suite missed all three because they only surface with reopen/decided state across MULTIPLE
cases in one pass. A focused audit of the remaining gates (ERR07/ERR14/ERR16/ERR3x) for
similar no-forward-path dead-ends is warranted (proposed to owner).

AGENT-AUTONOMY (separate from the driver): the maintainer agent hits a context compaction
roughly every 3 resolved cases and tends to go idle at the next case-ready; it resumes when
told "after any compaction, re-run next-case and continue." A durable doctrine amendment to
CLAUDE.local.md (self-resume after compaction) is pending, to be applied after this run.

### 2026-07-24 addendum — ERR35 cold-read transient-auth: delay + retry (owner-directed)

Owner clarified auth is REFRESHED AUTOMATICALLY into the credentials file, so the ERR35
"Not logged in" the agent hit at a fresh-container cold-start is transient (the refresh
had not landed yet), not a manual-/login situation. The single-shot cold-read invoker
hard-failed it to ERR35 and stopped the whole sweep on a self-healing condition.

Fix (66322b2f): `coldReadWithRetry` wraps the single-shot read with backoff [0,5s,15s,30s].
A verdict:'error' (infra/auth, D-054) waits + retries; a real confirm/reject returns
immediately (never retried); only after the whole backoff is spent does it propagate to
ERR35. The OAuth token is re-read FRESH from ~/.claude/.credentials.json on EVERY attempt
(the file is the auto-refreshed source of truth; ambient env is only the fallback), so a
retry uses the just-refreshed token. Tests: retry-then-recover, exhaust-then-ERR35,
never-retry-a-reject (injectable zero backoff). tsc clean, 372 tests. Deployed to the
fls-maintainer group clone IN-PLACE (git reset to origin, pass preserved).

PROCESS NOTE (owner corrections this session): (1) STOP driving the agent — repeatedly
chatting it to "keep going" IS doing the agent's work (boundary violation); the agent's
self-continuation is a doctrine matter, not something to hand-crank. (2) Always close the
loop: fix -> commit -> push -> UPDATE THE AGENT GROUP (deploy), and verify the group's
running clone actually carries the change. See [[flsclaw-agent-work-boundary]].

### 2026-07-24 addendum — gate audit + findings A/B fixed; compaction stall filed as #66

A parallel gate audit (owner-requested) of the report-case/publish gates for the #63/#64/#65
dead-end class found two more, both fixed:

- **Finding A (813894ff)** — ERR05 decided-already re-fired every attempt; owner clarified it
  should be a FIRST-ATTEMPT-only steer. Guard is now `effectiveTier !== 'judged' &&
  priorTrees.size === 0` (subsumes the earlier capExceeded patch and the #65 tier-gate). The
  give-up cap is per-case-per-SWEEP (this pass's journal), not global.
- **Finding B (18801cc9)** — a byte-identical duplicate of a HELD topmost looped ERR06
  ("resolve THAT case" — impossible, it's frozen) and wedged finish (ERR34). Owner direction:
  the duplicate inherits the first case's PR; dup detection is branch-AGNOSTIC (conflict
  signature only). Fix: duplicateCaseIssue flags a HELD topmost as `heldDuplicateOf`;
  report-case CONSOLIDATES (journals `held-duplicate`, a new terminal disposition in
  lastDisposition that drains openCases but is not `held`, so finish skips its publish) instead
  of blocking; an UNDISPOSED topmost keeps the plain block. Within-pass consolidation;
  across-pass the child re-consolidates while the twin stays held (never opens its own PR).

Both had regression tests added; tsc clean, 374 tests green. Pushed to origin
(feat/maintenance-sweep @ 18801cc9). NOT yet deployed to the fls-maintainer group (still on
c28b49d4 = #63/#64/#65 + ERR35-retry + self-continuation doctrine); deploy on next clean-slate.

Also filed **issue #66** (k-fls/fls-claw-v2): the sweep agent stalls when a context compaction
lands while it is parked waiting on a BACKGROUNDED driver command (next-case/finish). Confirmed
from the session transcript: compactions during foreground work resume fine; only the
background-wait ones break (the turn resets with no queued action). This is an agent
turn-lifecycle/harness issue, NOT driver logic — fix options in the issue: (a) foreground the
driver commands (doctrine), (b) poll-loop re-inject on compaction (runtime). Owner decision pending.

PROCESS: the doctrine self-continuation amendment helped (agent self-ran 3 cases, crossed
foreground compactions) but cannot fix the background-wait compaction (the agent isn't running
to follow it) — hence #66.

## 2026-07-27 — D-060: ONE quality gate at `report-case` + a flag-free agent surface

Settles the per-command flow drafted in `driver-command-flow.md` (2026-07-25). The gate
that judges a resolution moves to a single place, and the agent stops managing driver
configuration. Implemented on feat/maintenance-sweep and gate-green (386 tests;
`tsc -p scripts/sweep` clean). Authority: MERGE-POLICY.md + SWEEP-STATE-MACHINE.md D-060
amendments. AGENT-FACING DOCTRINE (estate CLAUDE.local.md) IS NOT TOUCHED — see the open
item below; it still documents the pre-D-060 surface and needs an owner-requested pass.
- **The SINGLE quality gate is `report-case`, for ALL THREE tiers.** Judged and held no
  longer defer their cold read to `report-pr`; a case is judged once, where the
  resolution exists. Order for a RESOLVED case: 5a checks → 5b report-attempt → 5c cold
  read. A `held` CLAIM on a still-pristine conflict skips all three (nothing to check).
- **5a CHECKS GATE** (`loadChecksConfig` + injectable `ChecksRunner`): `checks.typecheck`
  THEN `checks.test` run in the case worktree from `scripts/sweep/checks.json`, now
  SHIPPED IN THE REPO (host `pnpm run typecheck`/`pnpm test` + `container/agent-runner`
  tsc/bun) so the agent never authors a command list. A failure writes
  `<caseDir>/{typecheck,test}-output.txt`, journals `checks-fail {kind,failed}`, and
  returns `ERR36_TYPECHECK_FAILED` / `ERR40_TESTS_FAILED` ("read the output, fix, re-run")
  with the phase left at `case-ready`. `checksFailCount` is reset-on-pass and shared by
  both kinds; at `CHECKS_FAIL_LIMIT` (10) the driver resets the worktree to the PRISTINE
  conflict and freezes a HELD DRAFT tagged `[AUTO-ESCALATED: checks failing]` — the
  agent's failing tree is never published. A missing checks-file skips the gate entirely
  (the pre-D-060 behavior), so nothing breaks in a clone that lacks one.
- **5b report-attempt is POST-CHECKS.** `RESOLVE_COLDREAD_CAP` now counts only trees that
  actually reached the reviewer; a tree rejected by typecheck/tests costs no attempt.
- **`report-pr` is PR AUTHORING ONLY** — no cold read, no checks, no tests, no network.
  Input is `pr/body.md` whose FIRST line is the H1 title (`# <title>`), the rest the body;
  the legacy `title.txt`+`body.md` pair is still accepted and both files are normalized on
  disk so the finish-time publish is unchanged. Missing title/body → `ERR08`; WARN01/WARN02
  stay advisory. Judged still merges in place + records intent; held still records
  active-vs-draft.
- **The `defect: description` verdict is RETIRED** (consequence, and a bug fixed in the
  same breath). The cold reader never sees PR prose again, so the classification is
  meaningless — but `coldReadRejectionCount` still EXCLUDED description-defect rejects
  from `COLDREAD_REJECT_LIMIT`. A stray `"defect":"description"` from the reader would
  therefore un-count a real resolution reject: the case never reaches the 2× HELD
  escalation, and re-reporting an UNCHANGED tree records no new report-attempt either, so
  the convergence cap would not catch it — an unbounded revise loop. Every reject now
  counts; the prompt no longer asks for a defect, and `machineColdReadPrompt` dropped its
  `description` parameter.
- **Agent surface (flag-free).** Execute is the DEFAULT (`--dry-run` opts out); the GH
  token is read from `GH_TOKEN`/`GITHUB_TOKEN` at each networked write (`--token-file`
  survives as an internal/test override); `start` resolves and PINS `inventory` +
  `checksFile` into machine state and every later command reads them via
  `applyPassConfig`. Net agent flags: `--tier` on `report-case`, nothing else.
- **Red tests at `finish` STOP the pass.** An unattributable red where the checks tests
  failed (build clean, no single-branch offender) journals `finish-tests-failed` and
  returns `status:"stopped"`, `stoppedAt:"finish-tests"`, `ERR40_TESTS_FAILED`, "publish
  nothing" — fixing red tests is code work or an owner decision, never a re-run. The
  ATTRIBUTABLE red is unchanged: offender rolled back to HELD(gate), `halted:"verify"`,
  `ERR18`, resumable.
- **`ERR40_TESTS_FAILED`, not ERR37** (owner decision, 2026-07-27). The draft spec named
  it ERR37, which is already `ERR37_WORKSPACE_IN_CLONE` (raised by `start`, documented in
  SWEEP-STATE-MACHINE.md §D-055 and asserted in two tests). ERR38/ERR39 are taken; ERR40
  is the first free id. `driver-command-flow.md` was corrected to match.
- **Test coverage.** The four report-pr cold-read tests are retired with the behavior they
  covered (the judged 1st-reject/2nd-HELD case is re-established at `report-case`); the
  report-pr ERR35 test becomes the judged-tier ERR35 at `report-case`; report-pr gains a
  no-second-cold-read test and an H1-title/ERR08 test; the checks gate gains six
  (ERR36 short-circuits before tests, ERR40 + fixed re-report reaching the cold read,
  CHECKS_FAIL_LIMIT → pristine HELD DRAFT, reset-on-pass, held-claim skips the gate,
  no-checks-file skips the gate); ERR41 gains three (403 with a token-file naming the
  file, 401 off a stale ambient `$GITHUB_TOKEN` naming the var and never echoing the
  token, and a 500 still classifying as ERR13), plus one asserting the worktree dep links exist, resolve to the clone, and stay out of the resolved tree. 386 tests total.
- **Case worktrees get the clone's dep trees LINKED (`linkNodeModules`) — without this the
  gate is unusable.** A `git worktree add` checkout has NO `node_modules`, and the gate runs
  IN the case worktree, so `pnpm run typecheck` died with `tsc: not found` on EVERY resolved
  case — a failure no agent edit can fix, which would have marched `checksFailCount` to
  CHECKS_FAIL_LIMIT and force-frozen every case as a bogus `[AUTO-ESCALATED: checks failing]`
  HELD draft (i.e. a whole sweep of junk PRs). Found by probing a real worktree before the
  first live run, not in tests. `createCaseWorktree` now symlinks `node_modules` and
  `container/agent-runner/node_modules` from the clone when present; both are gitignored at
  every depth, so they never reach `snapshotWorktreeTree`'s `git add -A` and cannot leak into
  a merge or PR. Verified end-to-end: `pnpm run typecheck` exits 0 in a linked worktree.
- **OPEN — verify before the first live pass.** `checks.json` runs the WHOLE host suite
  (`pnpm test` = `vitest run`, ~2 min locally at 386 tests) inside `report-case`, once per
  RESOLVED case per attempt. If that proves too slow in the container, narrow the `test`
  list to a cheap subset and leave the full suite to the `finish` gate — the config is
  data, no code change.
- **`ERR41_TOKEN_REJECTED` — an in-flight auth failure now reports its CAUSE.** Because
  D-060 makes the driver pick a token off the ENVIRONMENT silently, a rejected token was
  indistinguishable from any other API error: every 401/403 surfaced as the generic
  `ERR13_API_FAILED`, whose contract is "retry once, then report" — a retry with the same
  rejected token can never clear it, so the agent burns a retry and reports the wrong
  cause. `apiFailureIssue` now classifies 401/403 as `ERR41_TOKEN_REJECTED` and NAMES THE
  TOKEN SOURCE (`--token-file <path>` / `$GH_TOKEN` / `$GITHUB_TOKEN`), never echoing the
  token itself, so a stale ambient `$GITHUB_TOKEN` is diagnosable from the failing output
  instead of looking like a revoked grant. Applied at all four networked catch sites
  (publish, push, approved-rollback escalation, start's origin reconciliation);
  fail-closed behavior is unchanged, and non-auth failures stay `ERR13`.
- **OPEN — the estate doctrine (`CLAUDE.local.md`) is now BEHIND the driver, deliberately.**
  It still documents the pre-D-060 surface: `--inventory` on every invocation, `--execute`
  on mutating commands, `--token-file` on start/finish, `--commands-file`, writing
  `pr/title.txt`, cold-read rejects arriving from `report-pr`, and a dead
  `ERR33_BRANCH_TESTS_FAILED` row (ERR36/ERR40/ERR41 are absent). Doctrine is owner
  territory and is NOT changed without a request — flagged here for the owner to decide.
  Note the live conflict: doctrine says "never use `$GITHUB_TOKEN`" while the driver
  falls back to exactly that; with the ERR41 fix the failure at least names the source
  rather than reading as a generic API error.

## 2026-07-28 — D-061: a red build is a CASE, not a dead end (base gate + gate-fix cases + blame by git history)

The first live D-060 pass ended in the worst possible shape: it merged the trunk into 11
branches, produced 8 cases and 3 HELD, and then went red at `finish` with NO CLEAN
ATTRIBUTION — because the offender was not a branch the pass had mutated at all. The fork
trunk had carried a type error since `fcee39ea` (2026-07-04): `isAdmin` passing
`string | null | undefined` into `hasAdminPrivilege(userId: string, …)`. `origin/main_patched`
was 198 commits behind and never had it, so nothing on origin was ever red and it sat
unnoticed for 24 days. An hour of agent time, zero usable output, and an `ERR18` whose
message asked a HUMAN to go fix something. Two things were wrong, and they are the two
halves of D-061: nothing ever asked whether the thing the pass builds on is green, and when
a build breaks for a reason no case caused, the driver had no way to route the fix to the
agent — it could only ask a person, which is exactly the outcome this whole system exists to
avoid. Implemented on feat/maintenance-sweep across 2026-07-28..29 and gate-green (436 tests;
`tsc -p scripts/sweep` clean). Authority: MERGE-POLICY.md + SWEEP-STATE-MACHINE.md D-061
amendments (written in this pass).

- **A — BASE GATE: `start` typechecks the trunk tip before opening a pass.** The anchor is
  the live TRUNK TIP (`main_patched`, else `--upstream`), NOT `resolveBase()`'s merge-base
  commit: a build has to be green at what it actually builds on. TYPECHECK ONLY — tests are
  far slower and the finish-time verify still runs them; a missing checks-file or an empty
  list skips the gate exactly as before. Checked IN ISOLATION before any merge, whatever
  fails is unambiguously PRE-EXISTING, so the report can name a culprit instead of
  shrugging. `ERR42_BASE_RED` is the id: "already red BEFORE any merge", which is a
  different statement from every other red the driver reports. The whole 2026-07-28 dead end
  becomes a ~40s answer.
- **A′ — a red base OPENS the pass rather than refusing (superseding A as first shipped).**
  Refusing was correct and useless: it blocked every pass with no agent route to a fix,
  because gate-fix cases trigger at `finish` and a refusing `start` never gets there. So the
  red is now carried forward, the pass is opened, and a gate-fix case is materialized on it.
  The DELIBERATE cost: the D-055 clean-slate wipe of a prior COMPLETE pass now happens as it
  always does, so the earlier invariant "a base-red refusal destroys nothing" is RETIRED (its
  test was replaced with coverage of the unattributable path, which still refuses). `ERR42`
  now fires only where there is nothing to serve — nothing blameable, or the same base sha
  was already served a gate fix that did not land.
- **A″ — the base anti-loop record lives at the WORKSPACE ROOT, not in the journal.** The
  within-pass guard is a journal row, and `start` deletes the whole pass dir before the base
  gate's case is minted — so an unfixed red base minted a byte-identical case on EVERY
  start, forever, with no memory of the attempt that had just failed. The record is
  `<workspace>/sweep-base-gate-attempts.json`, keyed `<anchor>@<sha>` and capped: the moment
  a fix actually lands the anchor moves, the key changes, and a genuinely new red base is
  served normally. A corrupt or unwritable guard file degrades to one extra case — never a
  blocked `start`, because a loop guard that can wedge the machine is worse than the loop.
- **B — GATE-FIX CASES: the unattributable red becomes work the agent can do.** The driver
  blames a branch (C), materializes a worktree AT THAT BRANCH'S TIP — no merge, nothing
  pending, no markers — writes the failing build as the case materials, and hands it over
  like any other case. It then flows through machinery that already exists: the D-060 checks
  gate PROVES the fix green, the cold read judges it, and the tier decides how it ships.
  `judged` → a SINGLE-PARENT commit on the branch plus a `reopen` of every descendant so the
  fix is pulled through the DAG, and THE SAME PASS CAN STILL COMPLETE (this is what lets a
  trunk-rooted fix salvage a pass instead of forcing a restart). `held` → a
  `fix/sweep/<slug(branch)>--<caseId>` ref + ACTIVE PR that BLOCKS the next sweep until the
  owner merges it. ANTI-LOOP: one attempt per (branch, file-set) per pass — a fix that does
  not fix leaves verify red, which would otherwise prepare the same case forever; the key is
  per BRANCH so one looping branch never suppresses another branch's first attempt.
- **B′ — `finish` verify now runs TYPECHECK before tests.** Pre-D-061 it ran tests ONLY, so a
  type error surfaced indirectly (a suite failing to import) or not at all, and the verify log
  held no compiler diagnostics — leaving attribution nothing to parse and every unattributable
  red falling back to the accused branch, which defeats the entire point. `cmdVerify` also
  journals the failing OUTPUT (bounded 20k) because the VerifyResult never reaches `finish`.
- **B″ — five root causes found while making the flow actually work end to end.** Each was
  diagnosed from the journal delta, not guessed, and each is recorded because the shape
  recurs: a mechanism written for merges silently mis-handles a case that is not a merge.
  (1) `crashHeal` closed every gate-fix case on the very next command — its rule is "the
  branch tip already contains the case head, so it was resolved before a crash", and a gate
  fix's head IS the tip, so `isAncestor(tip, tip)` was trivially true. (2) The judged tier
  halted at `judged-prs`: that step selects by DISPOSITION, and a gate fix's disposition is
  `resolved`/`judged` like any other — but a JUDGED history PR exists only to be auto-flipped
  by the target push landing the SAME merge commit, machinery specific to a propagation merge.
  Gate fixes are excluded from the selection and record no pr-intent; the commit is the record.
  (3) The held publish ran three staleness probes ("the resolution landed", clean-probe,
  same-path-set) that are all meaningless for a gate fix and all fired unconditionally — the
  agent's fix was journaled `publish-failed` and thrown away. (4) The held publish built
  `[tip, head.sha]`, a degenerate self-merge whose PR diff reads as an empty merge instead of
  the fix; now single-parent. (5) An EMPTY gate-fix case could be served (no files, empty
  output) from the rollback arm that journals no attribution row — it now refuses on
  `files.length === 0`, because handing the agent something to fix with nothing in it
  pre-empts the honest STOP.
- **B‴ — the gate-fix case was made to pass as a conflict case by stuffing fake values into
  fields that mean something else; all of them are root-fixed.** The id `gate-fix-<branch>-h-1`
  existed only to satisfy the conflict id regex — and `-h-1` is a LEGITIMATE conflict height
  (coverage really returns -1 for a head below the pass chain), so the disguise was
  indistinguishable from a real id, while being IDENTICAL for every gate fix on a branch (a
  second gate fix on that branch inherited the first's disposition and could never be served).
  Ids are now `gate-fix-<slug(branch)>-<8 hex of the anti-loop key>`, and id validation is
  "conflict form OR gate-fix form". The height `-1` made the D-004 pending-count report more
  pending commits than the chain holds on EVERY held gate-fix PR; the head now carries its real
  coverage. The `(gate-fix)` parent LABEL was being embedded in the fix ref name, which
  `start` parses a real scope branch and trunk height back out of — so every reviewed held
  gate-fix PR escalated on the next pass with "cannot parse parent/height from the ref name",
  the driver blaming itself. Gate-fix refs now have their own form and `start` recognises it
  and escalates ONCE with an honest reason (it carries a fix, not a conflict resolution — there
  is no revision case to serve; merge or close it). Three further sentinels turned out to be
  benign but load-bearing BY LUCK and are now pinned by tests: `same-files` scope guard (the
  other legal mode bounds edits by marker spans, and a gate-fix tree has no markers, so every
  gate fix would be scope-flagged), the JUDGED tier floor (which keeps it out of the mechanical
  arm and its second-parent merge), and the tip tree standing in as "the tree the agent started
  from".
- **C — BLAME BY GIT HISTORY, not by registry declarations (owner-approved 2026-07-28).**
  Which branch a fix belongs on was first computed from `owned_paths`/`touch_paths`. On the
  live registry that answer is simply wrong: for `src/command-gate.ts`, FOUR entries declare
  the file, two of them have never modified it, one has no git ref at all — and the branch
  that actually carries the defect is not among them. Declarations are aspirational; they say
  where a feature INTENDS to live. Git history says who wrote the line that broke.
- **C′ — authorship is the FIRST-PARENT line, not a set difference (round two, 2026-07-29).**
  The first history rule counted `rev-list <branch> ^<inventory parents>`, which cannot
  identify authorship once work has propagated: the moment a commit is merged up or down it
  enters the other set and the answer inverts. Measured on the live fork for
  `src/command-gate.ts` — `^parents`: main_patched 6, module/command-gate 0;
  `^main ^all-other-branches`: 2 / 0; `--first-parent`: 3 / 3;
  `--first-parent --no-merges`: 0 / 3, the correct answer. A propagation merge records the
  RECEIVING branch as first parent and the donated branch as second, so the first-parent chain
  is a branch's OWN authoring line and steps straight over everything it absorbed; `--no-merges`
  then drops the integration commits, which are not edits — accepting someone else's edit is
  not making one. The rule is
  `authored(branch, file) = rev-list --count --first-parent --no-merges <branch> ^main -- <file>`,
  with `^main` for EVERY branch including the trunk (upstream is never ours to fix, and it is
  the only floor that does not move as work propagates). The driver's own file was the second
  smoking gun: the old rule handed `scripts/sweep/propagate.ts` to the trunk purely because the
  trunk had absorbed 34 of the sweep's own commits. If `main` itself does not resolve, blame
  returns NOTHING rather than dropping the exclusion and swallowing upstream history.
- **C″ — the owner rule, and a refusal instead of a guess.** Several branches can author over
  one file; the SHALLOWEST by hierarchy depth wins, so the fix lands closest to the root and
  propagates to every descendant instead of being applied on N leaves. No candidate at all →
  the trunk `main_patched` (an untouched file that fails is inherited from upstream or broken
  by the trunk's own merge of it, and the trunk is the one place a fix reaches everyone). A
  genuine TIE at the shallowest depth REFUSES, naming the tied branches — the previous version
  fell through to `localeCompare` and then reported "earliest by hierarchy", a decision made by
  spelling and described as a rule. Failing files are GROUPED PER ATTRIBUTED BRANCH, one case
  each, shallowest first: a red build routinely names files belonging to different branches, and
  a single case forced them all onto one worktree where the fix for someone else's file either
  cannot be made or lands where it reaches nobody.
- **D — ONE hierarchy implementation (`scripts/sweep/hierarchy.ts`).** The depth rule was wrong
  in three compounding ways, each hiding the next, and the owner caught all three by reading the
  live journal. (1) It keyed the DAG by entry ID while `parents` hold BRANCH names, so EVERY
  edge was dropped and every depth collapsed to 0. (2) It used `1 + MIN(parents)` — the shortest
  route — when a branch can only merge after ALL its parents, so it must be MAX; MIN produced 8
  parent inversions on the live inventory (`feat/mitm-credential-proxy` at 3, level with its own
  parent `module/host-rpc`). (3) With every depth 0 the sort fell through to `localeCompare`, so
  the winner was chosen ALPHABETICALLY and then reported as "earliest by hierarchy (depth 0)" —
  a string asserting a rule that decided nothing. Live consequence: a gate-fix case minted on
  `edition/fls-ai-bot`, a deployable leaf at true depth 6, for a defect in `module/command-gate`
  at depth 2. There is now ONE implementation, keyed by BRANCH, with `main`=0 and
  `main_patched`=1 as named constants; `depth = 1 + MAX(parents)` and `minPath` = the SHORTEST
  chain to `main` excluding `main` deliberately disagree and are BOTH recorded so no caller
  re-derives either; unresolvable → `null`, sorted LAST, never 0 (that coercion is exactly what
  let a leaf outrank three root-adjacent modules); `assertNoParentInversion` ships with the code.
  Verified against all 27 live inventory entries: 0 unresolved, 0 inversions, reproducing the
  hand-computed table.
- **New error ids.** `ERR42_BASE_RED` — red BEFORE any merge, pre-existing, not caused by
  propagation. `ERR43_CHECKS_MALFORMED` — a checks file that does not PARSE used to be a silent
  skip that disabled the per-case gate AND the finish verify list, so a pass could run to
  completion reporting everything green having typechecked and tested nothing; it is now loud at
  all three consumers, while an ABSENT file still skips silently (that is the deliberate
  "repo without checks" behaviour and is separately tested). `ERR44_WORKTREE_RESET_FAILED` — the
  two sites that announce "the worktree is now pristine" now refuse when the reset failed
  instead of asserting a reset that did not happen and publishing an exhibit built from a tree
  nobody reset. (`ERR41_TOKEN_REJECTED` shipped with D-060 and is recorded there.)
- **Diagnostics from a sub-cwd command are re-rooted before blame.** The shipped checks run
  `bun test` in `container/agent-runner`, so that runner prints `src/auth/x.ts` while every
  registry pattern is written from the clone root — blame matched nothing, or worse matched a
  ROOT-level `src/…` owner and named an unrelated branch. Sections are split on the `$ <cmd>`
  headers the runner already writes; header-less output is re-rooted only when the failing
  commands share ONE cwd, the only unambiguous case.
- **D-060 follow-ups fixed in the same session (found by the first live pass, which was aborted
  and published nothing).** (1) The case-worktree dep SYMLINKS leaked into every resolved tree:
  the repo ignores `node_modules/` and a TRAILING SLASH matches DIRECTORIES ONLY, while git
  records a symlink as mode 120000 — a FILE. Fixed with `$GIT_COMMON_DIR/info/exclude`, which
  must be the COMMON dir (git does not read `info/exclude` from a linked worktree's private
  dir — writing there is a silent no-op). The old test asserted a NAME was absent from the tree
  and passed while the bug shipped; it now asserts on TREE MODES. (2) The runner typecheck
  EMITTED into the tree it checks (no `noEmit`, no `outDir`, `rootDir ./src`), writing compiled
  `.js` next to every source file, which the same `git add -A` swept into the resolution;
  `--noEmit` added. (3) The agent was told to read a 973 KB log (an uncapped vitest run of 1860
  tests) for 11 failing names — the named file is now the failing commands plus the last 250
  lines, with the full log kept beside it.

Key files: `scripts/sweep/hierarchy.ts` (new), `scripts/sweep/attribute.ts` (new),
`scripts/sweep/propagate.ts` (`runBaseChecks`/`baseCheckAnchor`, the base-gate attempt record,
`materializeGateFixCases`, `createGateFixWorktree`, `gateFixCaseId`/`gateFixKey`/
`gateFixHeadHeight`, `reverifyGateFixCase`, `gateFixCaseMaterials`, `rootChecksOutput`,
`malformedChecksIssue`, `cmdSweepStart`, `cmdSweepReportCase`, `cmdSweepReportPr`,
`cmdSweepFinish`, `publishHead`, `crashHeal`, `fixBranchName`), `scripts/sweep/fixtures.ts`
(`merge()` — a LINEAR fixture cannot tell the two blame rules apart, so history now has real
merge topology). D-061 label used in code comments only (not agent-facing). Docs updated in
this pass: MERGE-POLICY.md, SWEEP-STATE-MACHINE.md.

### OPEN items — D-061

- **The registry's `parents:` is MERGE topology, which is a different relation from "cut
  from".** It is generated from merge-commit subjects, so a branch that was git-branched off
  another — never merged from it — does not declare that edge. Consequence: git-stacked
  branches are declared equal-depth SIBLINGS, and because a branch cut from another carries
  that branch's commits on its own first-parent line, both look like authors at the same
  depth, and blame REFUSES the tie. Censused over the 710 real `.ts` paths of the live fork:
  59 refuse this way. Concrete cases — `module/runtime-updater` was cut from
  `module/credentials` (`84ca7982`) but both declare `module/interactions-helpers` (25 files);
  `module/host-rpc` and `module/interactions-helpers` were cut from
  `module/container-bootstrap` (`cce71eca`) but all three declare
  `module/agent-group-contributions` (30 files). Adding those edges by hand resolves all 59.
  THE INVENTORY WAS NOT TOUCHED: it is registry data and the owner's call. Note this is NOT a
  regression from the blame change — the previous rule refused 55 of the same 59 with identical
  tied sets, and answered the other 4 wrongly (`main_patched`). The tie is the honest output of
  a registry gap, and it is a useful signal; the fix belongs in the inventory, not in a
  tie-break by spelling.
- **A cut-point signal could separate them, and THREE derivations have already failed.**
  Recorded so nobody re-treads them: (1) set difference `<branch> ^<declared parents>` — credits
  the trunk with work it merely ABSORBED (6 commits on a file it never wrote); (2) set
  difference `^main ^<all other branches>` — zeroes out any branch whose work has been absorbed
  anywhere (the true author scored 0); (3) "the newest shared first-parent commit" as the cut
  point — picked DESCENDANTS as parents. A fourth derivation is under investigation; until it
  is proven on the live inventory this is unresolved, and the refusal stands as the behaviour.
- **Blame census, for calibration when this is revisited.** Of 710 real `.ts` paths: 271
  attributed to a branch, 380 (54%) have NO candidate and fall back to `main_patched` — these
  are pure-upstream paths the fork has never edited, which is exactly what the fallback is
  for — and 59 refuse as depth ties. The fallback rate is expected to stay high and is not by
  itself evidence of a defect.
- **~~A base-red refusal now leaves the pass OPEN.~~ CLOSED at `5cbc7158`** — the refusal seals the
  pass instead of wedging the next `start`. D-062 then settled the owner call this item left open:
  sealing is safe ONLY when the pass holds nothing to publish. A refusal at `start` qualifies (the
  pass is empty); a mid-pass hold does NOT — `sealRefusedPass` there would strand held fixes as
  `pr-intent` notes with `finish` unattachable. See D-062.
- **~~The estate doctrine (`CLAUDE.local.md`) is now further behind.~~ CLOSED at `5cbc7158` (error
  ids, gate-fix doctrine) and in D-062 (the split into conditionally-read files).** Every id the
  driver emits now has a greppable row, including the three nobody had noticed were missing
  (`ERR46`, `WARN05`, `WARN08`).
- **~~Live exercise, unconfirmed.~~ RUN 2026-07-29 — see D-062.** The flow was confirmed live
  through the held escalation and found three defects the tests could not reach; it did NOT reach a
  published fix, and the judged salvage path remains unexercised live. Both carried into D-062.

---

## D-062 — the first live gate-fix pass: one cause, three symptoms

**Date:** 2026-07-29. **Branch:** `feat/maintenance-sweep`. **Driver:** `d2dd83a5`, `c6a95730`, plus
this round. **Trigger:** the D-061 live exercise the previous entry asked for, run against the real
`fls-maintainer` clone with `main_patched` at `e4c82f34` (red since `fcee39ea`, 2026-07-04, upstream).

**D-061 works through the held escalation.** Measured: `start` base-gated `main_patched` red →
blame attributed `src/command-gate.ts` to `module/command-gate` (depth 2, exactly as predicted) →
gate-fix case rooted on the base anchor → `next-case` served it with the GATE-FIX briefing →
checks gate ran (`checks-fail` on tests, then `checks-pass`) → cold read → 2 rejects →
auto-escalated to `held` with `pr-intent`. None of §6's failure signals fired; cut-point
exceptions re-verified live. **What it never reached is a published fix** — and that is the finding.

### One cause: state captured before the pass mutates refs

- **Symptom 1 — the gate-fix anchor drifts.** `start` minted the case against `main_patched@e4c82f34`
  at 13:54:37; `next-case` merged `main` in at 13:55:36 (→ `d0df574a`) *before serving it*. The case
  worktree stayed cut from the PRE-merge tree, so `resolve` diffed the resolution against the MOVED
  tip: a correct **+4/−3** fix to one file read as **24 files / −399 lines**, the deletions being
  everything the merge had just brought in (timezone feature, container hardening). Cold read
  rejected twice on that phantom. Its feedback told the agent to strip ~23 files its worktree had
  never touched — un-actionable, so the agent re-submitted the **identical tree** into the 2nd
  strike. Not agent stubbornness: the steer was impossible to act on.
- **Symptom 2 — a red base poisons every descendant.** With the base fix held, propagation continued.
  `module/host-rpc` failed typecheck at 14:23 on the *inherited* error, pulled `src/command-gate.ts`
  into its resolution to go green, and was held at 14:44 for exactly that ("Remove the
  src/command-gate.ts changes — they are out of scope for this merge"). `module/interactions-helpers`
  went the same way. Every downstream case faces the same fork: carry the base fix (rejected
  out-of-scope) or fail a check it did not break. Both roads end in `held`.
- **Symptom 3 — a cut-point exception goes stale by the pass doing its job.** *(different mechanism,
  same theme — recorded because the first diagnosis wrongly lumped it with symptom 1.)* `absorbed`
  was verified as `merge-base --is-ancestor <branch-tip> <as_of>`. Every pass merges the parent DOWN
  into each branch, advancing the tip past `as_of` — so `module/crypto` was flagged
  `WARN08_CUT_POINT_EXCEPTION_STALE` at verify while its own remainder was still **0**, the sole
  commit outside `main_patched` being `7a6727a0 "Merge main_patched into module/crypto
  (propagation)"`. Re-anchoring `as_of` cannot fix this; the next pass falsifies the new value.

**Outcome of the pass:** halted at `finish`/`finishStep: verify`, 3 held cases, **0 PRs published**,
pass left OPEN (so the next `start` would answer `ERR30_PASS_OPEN`). Cleaned with `clean-slate.sh
--keep-cli-wiring`; branches deliberately NOT reset (`main_patched` is 212 commits ahead of origin).

### Shipped

- **B2 — an unresolved gate-fix FREEZES propagation** (`cmdRun`, before any mutation). Whole-run, not
  per-branch: `arrived` is the loop's completion marker, so a branch that never arrives leaves the
  pass unfinishable — the suite caught that on the first attempt. Descendants must not merge off a
  red base anyway.
- **A held gate-fix routes to `finish`, and does NOT seal.** First implementation called
  `sealRefusedPass` — which writes `pass-complete` + phase `complete`. That is for a pass refused at
  `start` with nothing in it; used mid-pass it records a pass holding real fixes as finished-normally
  AND makes `finish` unattachable, stranding the held fix as a `pr-intent` note that can never become
  a PR, so the base could never go green. `finish` is the one path that ends a pass and its
  `held-prs` step is what publishes. **This also answers the D-061 open item** asking whether the
  anti-loop path should seal: sealing is only ever safe when the pass holds nothing to publish.
- **`ERR46_COLDREAD_UNGROUNDED`** — a reject must name a path in the resolution diff or the question
  it failed. `notes` was always validated non-empty; `feedback` never was, and the schema sanctioned
  omitting it ("omit when nothing is"), so a reject could reach the agent as a bare "cold read
  rejected — revise the resolution". Worse on the fail-closed path: an `UNVERIFIABLE` answer rejects
  even under `verdict: "confirm"`, and a confirming reader has every reason to omit feedback.
  Refusing the *verdict* spends no strike. (`ERR43` was taken by `CHECKS_MALFORMED`; hence 46.)
- **Gate-fix cold reads get their own framing and questions.** The request was the MERGE form with
  every merge-specific field empty — `Parent: (gate-fix)`, "Conflict hunks" an empty fence, ours and
  theirs both `(no commits)`. The reader answered Q1 ("within the conflicted hunks…")
  `UNVERIFIABLE-FROM-REQUEST` because there was nothing to read, which rejects fail-closed
  regardless of verdict: **no gate-fix resolution could pass as prompted.** It also reached for merge
  doctrine it was never given ("merge-forced consequential edits"), because nothing said a CHECK had
  failed or which one. Now: `Kind: GATE-FIX`, the failing command, the captured check output, no
  merge scaffolding, and Q1/Q2 rewritten to "does it fix the cause, not suppress it" / "is every
  change necessary for the check". Q3 is unchanged deliberately — it is the one that transferred, and
  the one that landed the *real* objection on the live run (the `FILTERED_COMMANDS` reorder
  contradicting the recorded `keep /start filtered` decision).
- **`absorbed` is now `rev-list --count --no-merges <branch> ^<into> == 0`**; `as_of` becomes
  provenance rather than the thing tested. `--no-merges` is load-bearing: the merges a pass creates
  on a branch carry the parent's content down, they are not work the branch authored.
- **`ERR18_VERIFY_PENDING` split into its two arms, and the driver refuses an unchanged re-run.**
  Doctrine flattened both into "re-run `finish`"; the agent obeyed on the no-clean-attribution arm
  and spent a second full `finish` reproducing an identical block. The anti-loop keys on
  `sha1(refs/heads + cut-point-exceptions)`, journaled as `verify-halt` — the mechanism `start`
  already had via `baseGateAttempted`, which `finish` lacked.
- **Doctrine split into conditionally-read files** (284 → 233 lines), on the rule *the driver knows
  the moment → the driver hands the path; the agent has to notice → doctrine keeps a trigger*:
  `ERRORS.md` (one greppable line per id), `PR-DESCRIPTIONS.md` (**not** mentioned in doctrine — 11
  driver sites carry the path), `REGISTRY-UPKEEP.md` (doctrine trigger). This closes the standing
  D-060/D-061 open item about doctrine trailing the driver, and adds three ids the driver emitted but
  doctrine never carried: `ERR46`, `WARN05_STALE_VERDICT_CLEARED`, `WARN08_CUT_POINT_EXCEPTION_STALE`
  — the last being the warning that halted this very sweep with no row telling the agent what to do.

### Method note — why 456 green tests missed all of this

Every gate-fix fixture built `main` with **no commit after the branch point**, so there was no
pending prefix merge and the branch *could not move* under an open case. One commit
(`gateFixRepoWithUpstream`) makes the drift reachable. Each of the five new tests was verified RED on
the unmodified driver before the fix, and the `absorbed` one was re-checked by restoring the old
predicate. §8 of the handover still applies: fixture-green is not sufficient here, and none of this
is confirmed until a live pass runs it.

### OPEN items — D-062

- **Live re-run outstanding.** Nothing here is confirmed live. `main_patched` is now `d0df574a`
  (still red, different sha from `e4c82f34`, so `baseGateAttempted` will not block) — the next pass
  should base-gate it, freeze propagation, and reach a published `fix/sweep` PR. That is the first
  thing to verify, and the judged salvage path (fix → reopen → same pass completes) is still
  unexercised live.
- **Deploy is not done.** Driver + all four estate files must deploy together: the doctrine pointers
  to `ERRORS.md` and `PR-DESCRIPTIONS.md` are dead until those files are in the group dir, which is
  strictly worse than the inline table they replaced.
- **The agent smuggled an unrelated fix into a gate-fix.** The `FILTERED_COMMANDS` reorder in
  `classifyAtMessagingGroup` has nothing to do with the `isAdmin` typecheck error and contradicts a
  recorded decision — it looks like an attempt at the known slash/mention bug taken inside an
  unrelated case. The cold read caught it (Q3). Whether doctrine needs an explicit "a gate-fix
  touches only what the check forces" rule, beyond the new Q2, is an owner call.
- **Carried from D-061, unchanged:** the registry `parents:` merge-topology gap and its 59 blame
  ties; the fourth cut-point derivation (a further four approaches have since failed — see the
  handover §8); `module/runtime-updater`'s duplicate entry; the six no-remote inventory entries;
  `seeds.yaml` applied by hand.
