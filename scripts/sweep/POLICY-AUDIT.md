# Policy consistency audit — MERGE-POLICY.md (D-049) vs driver / spec / docs / doctrine / skill

Date: 2026-07-21. Authority: `scripts/sweep/MERGE-POLICY.md` (owner-settled D-049; wins over everything).
Scope audited: `scripts/sweep/*.ts` + tests, `PROPAGATION.md`, `DESIGN.md`, `README.md`,
`estate/fls-maintainer/CLAUDE.local.md`, `.claude/skills/fork-registry-generate/`.
READ-ONLY audit — nothing fixed yet. Policy § references are to MERGE-POLICY.md sections.

## Class: DRIVER-REMOVE (exhibit mechanism + API ref fabrication — entire mechanism retired)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| R1 | publish.ts:116-133 | `overlayTree` — "Base tree with ONLY `paths` overlaid" | §1 HELD row; header "Supersedes … D-030 exhibit-commit construction" | Delete overlayTree (exhibit tree builder) | DRIVER-REMOVE | S |
| R2 | publish.ts:144-160 | `buildExhibit` — "Construct the exhibit head … parent = the ORIGIN base-branch tip" | §1 HELD: "draft PR at the conflicting head … real diff (D-030 head)" | Delete; HELD PR head = the case run's TOP conflicting-height commit on a current base (clean prefix pushed first) | DRIVER-REMOVE | M |
| R3 | publish.ts:171-195 | `checkExhibitDiff` — "ERR03 hard assert on the exhibit diff" | §5 pre-PR height check replaces exhibit asserts | Delete ERR03 check; see C2 for its replacement | DRIVER-REMOVE | S |
| R4 | publish.ts:204-222 | `checkExhibitAncestry` — "ERR04 … must add NOTHING beyond the origin tip" | §5 (obsolete once refs move only via driver push after verify green) | Delete ERR04 check (protected-content safety re-provided by the push stage ordering) | DRIVER-REMOVE | S |
| R5 | publish.ts:665-724 | `publishExhibit` — "entirely via the REST API (no `git push` — broken through the proxy)"; POST /git/blobs, /git/trees, /git/commits, /git/refs (l.696-715) | §5: "Refs move via `git push` ONLY; the API … never to fabricate refs/commits as a push workaround" | Delete remote blob/tree/commit/ref fabrication; keep only POST /pulls (+comments) on refs already pushed by the driver | DRIVER-REMOVE | M |
| R6 | publish.ts:26-32 | header: "`git push` to github fails through the credential proxy" (design rationale) | §5: infra failures are REPORTED (D-046 case 2), never worked around | Delete the workaround rationale; document report-on-push-failure instead | DRIVER-REMOVE | S |
| R7 | propagate.ts:2250-2258 | cmdPublish "(3) EXHIBIT HEAD: origin-parented synthetic commit" + checks | §1/§5 | Replace exhibit construction + ERR03/ERR04 battery with the push-based HELD/JUDGED head flow | DRIVER-REMOVE | M |
| R8 | propagate.ts:2381-2391 | `publishExhibit(…)` call + "Local anchor for the remote ref … update-ref" | §5 | Replace with: driver `git push` of the fix/sweep ref, then POST /pulls | DRIVER-REMOVE | M |
| R9 | propagate.ts:2166-2176 | duplicateCaseIssue: "rebuild the sibling's exhibit tree … sib.tree === selfExhibit.tree" | §1/§2 (exhibit gone; case unit is now a run) | Rework duplicate signature to path-set + run-top sha (no exhibit trees) | DRIVER-REMOVE | S |
| R10 | publish.test.ts:215-330, 639-694 (and propagate.test.ts:1340 area) | "publish — exhibit head construction (§14, D-048)" | all of the above | Rewrite tests for the push-based head shape; delete overlay/exhibit/ERR03/ERR04/publishExhibit tests | DRIVER-REMOVE | L |

## Class: DRIVER-CODE (missing or wrong behavior to implement)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| C1 | propagate.ts / whole driver | (no `git push` invocation exists anywhere — verified by grep over all sweep .ts) | §5: "The DRIVER pushes … per-pass push order: target branches → JUDGED closure pushes → HELD draft PRs"; §5 "Nothing pushed before `propagate verify` is green" | Add a journaled pass-push stage (driver-executed `git push`), gated on verify green, in the mandated order | DRIVER-CODE | L |
| C2 | publish.ts / propagate.ts cmdPublish (absent) | — | §5: "Pre-PR height check (blocking ID): the origin base branch must be AT LEAST at the expected pass height … lower/diverged = halt" | Implement the blocking pre-PR height check with a new ERR id | DRIVER-CODE | M |
| C3 | propagate.ts:2125-2131 + publish.ts:721 | "only JUDGED resolutions and HELD freezes get a PR" … `draft: true` (all PRs drafts, JUDGED head = synthetic exhibit) | §1 JUDGED: "merge; same commit pushed to target → PR auto-marks merged"; §4: "JUDGED PR closure: push the SAME merge commit" | JUDGED PR head = the REAL merge commit (pushed fix/sweep ref); not a draft exhibit; no synthetic tree | DRIVER-CODE | M |
| C4 | propagate.ts (absent; D-040) | (no closure path exists — nothing ever flips a JUDGED PR to merged) | §4/§5 JUDGED closure | Implement closure: after target pushes, push the same merge commit so GitHub auto-marks the PR merged; journal it | DRIVER-CODE | M |
| C5 | interval.ts:87-89 + 182-196 | "reporting the SMALLEST conflicting height above the merge point as the agent's case" | §2: "A case = the MAXIMAL RUN of consecutive conflicting heights whose conflicted path sets intersect … capped (default 5) … applies to ALL conflict tiers" | Implement run stacking in the merge-point sweep (break at clean height / disjoint paths / cap) | DRIVER-CODE | L |
| C6 | types.ts:319-327, 411-424 | `ConflictCase`/`CaseFile` carry a single `head` | §2: "HELD's draft PR head = the run's TOP commit → diff = the whole run" | Extend case schemas with the run (all heights + top head); one cold-read per run | DRIVER-CODE | M |
| C7 | deferred.ts:47-59 + plan.ts:130-137 | `checkDeferred(firstConflictHeight, …)` — window vs the single first conflict | §2: "DEFERRED windows and urge tracking are computed against the run's top" | Feed the run's TOP height into the DEFERRED window | DRIVER-CODE | S |
| C8 | propagate.ts:518-522 | urge tracks `pending[pending.length-1]` (newest chain head) | §2 (urge tracking vs run top), §4 (`lastUrgedHead`) | Recompute urge tracking against the pending case-run top after stacking lands | DRIVER-CODE | S |
| C9 | propagate.ts:500-502, 545-549 | "PREPARE (never execute) a PR comment" … writes `gh pr comment …` into urge-commands.sh (`gh` does not exist in the container) | §4: "one POSTED urge-comment per NEW pending head" ; §5 API "used for PR creation/comments (normal use)" | POST the urge comment via the driver's GitHub API tooling (ERR/WARN contract); drop the prepared-gh-command file | DRIVER-CODE | M |
| C10 | propagate.ts:536-543, 1998 | pending count lives only in never-posted urge-comment.md; PR body has no driver-maintained count | §6 D-004: "a frozen branch's HELD PR carries the count of further pending upstream commits (kept current via urge comments)" | Ensure the HELD PR carries the pending count and posted urges keep it current | DRIVER-CODE | S |
| C11 | propagate.ts:935-951 (createCaseWorktree) | (no shared rerere install in case worktrees; only legacy merge.ts:139-141 installs rr-cache) | §4: "descendants inherit via parent merge + shared rerere (D-006)" | Install the workspace rr-cache into driver case worktrees (and export new resolutions) | DRIVER-CODE | S |
| C12 | publish.ts:70-77 + PROPAGATION.md §14.3 | HALT_IDS / ERR01..ERR13 registry built around the exhibit + API-fabrication flow | §5 "ERR/WARN ID contract" + all changes above | Renumber/replace registry: retire ERR03/ERR04 (exhibit), add ids for pre-PR height check, push failure (report, blocking), JUDGED closure, urge-post failure | DRIVER-CODE | M |

## Class: SPEC (PROPAGATION.md)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| S1 | PROPAGATION.md:25 | MECHANICAL = "Trivial conflict (e.g. two disjoint appends)" | §1: "conflict the agent is allowed to resolve (what qualifies is regulated separately, not here)" | Reword the MECHANICAL row; point at the (to-be-provided) separate regulation | SPEC | S |
| S2 | PROPAGATION.md:27 | HELD: "Draft PR via `publish` (exhibit head, §14 D-048)" | §1 HELD row | Reword: draft PR at the run-top conflicting head on a current base | SPEC | S |
| S3 | PROPAGATION.md:87-89 | "Report the smallest conflicting height above the merge point as the case" | §2/§3: case STARTS there but is the stacked maximal run (cap 5) | Add the §2 case-stacking rule to §3 (and §5 DEFERRED-window wording "against the run's top") | SPEC | M |
| S4 | PROPAGATION.md:264-276 | "the PR is then created EXCLUSIVELY by `propagate publish` … whose head is an **exhibit head**: a synthetic commit …" | §1/§5 | Rewrite: HELD head = run-top commit on current base; no synthetic commit; clean prefix pushed first | SPEC | M |
| S5 | PROPAGATION.md:280-281 | "(Pushing target branches is owner-gated; see the doctrine.)" | §5: "The DRIVER pushes" | Delete owner-gating clause; driver pushes after verify green | SPEC | S |
| S6 | PROPAGATION.md:364-371 | "the driver PREPARES a PR comment … As with PRs, the driver prepares and never calls gh." | §4 posted urges; §5 API comments = normal use | Rewrite: driver POSTS the urge comment (API), one per new pending head | SPEC | S |
| S7 | PROPAGATION.md:387-395 (§9) | "Nothing is pushed before verification passes" (true, but no push stage/order is specified anywhere) | §5 push order + pre-PR height check | Add the per-pass push order (targets → JUDGED closure → HELD PRs) and the pre-PR height check to the spec | SPEC | M |
| S8 | PROPAGATION.md:585-621 (§14.1) | "creates the fix/sweep ref AND the draft PR via the GitHub REST API … (blobs → tree → commit → ref …). No `gh`, no `python3`, no `git push` — none of those work in the agent container" | §5: refs via `git push` ONLY; infra failures REPORTED, never worked around | Rewrite §14.1: publish operates on driver-pushed refs; API only for PR creation/comments; push failure = D-046 case-2 report | SPEC | M |
| S9 | PROPAGATION.md:597-601, 623-651 | §14.1 step 2 "Builds the EXHIBIT HEAD … HARD-ASSERTS diff == conflictedPaths exactly" | §1/§5 | Delete the exhibit-head step; describe the D-030-style head + height check battery | SPEC | M |
| S10 | PROPAGATION.md:660-661, 681-691 (§14.3) | ERR03 "exhibit diff != conflictedPaths"; ERR04 "exhibit ancestry" | §5 ERR/WARN contract | Update the ID registry per C12 (retire exhibit ids; add height/push/closure/urge ids) | SPEC | S |

## Class: SPEC (DESIGN.md / README.md — retired-case remnants)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| D1 | DESIGN.md:66-68 | "Exception: case-3 provisional resolutions may be advanced on top of." | §1: "Old 'case 3' (open provisional PR) is retired" | Strike the exception; D-004 freeze+annotate stays | SPEC | S |
| D2 | DESIGN.md:151-197 (§6) | case 1-4 ladder ("Case 3 — resolvable but confirmation wanted …", "Case 4 — unresolvable …") | policy header: "Supersedes: case-1..4 ladder (DESIGN.md §6)" | Add a supersession banner on §6 pointing at MERGE-POLICY §1 (keep the historical text marked superseded) | SPEC | S |
| D3 | DESIGN.md:214 | "`edition/*` merges are always case-3 minimum (PR + owner ack)" | §1: "Edition JUDGED **auto-merges** (intended); owner-gating happens only by escalation to HELD" | Correct (or fold into the D2 banner) | SPEC | S |
| D4 | README.md:126-129 | "`fix/sweep/*` branches + PRs for gates (cases 2-4 in DESIGN.md §6), pushes per the push policy" | §1 tier table | Point at MERGE-POLICY tiers instead of DESIGN §6 cases | SPEC | S |

## Class: DOCTRINE (estate/fls-maintainer/CLAUDE.local.md)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| T1 | CLAUDE.local.md:17-19 (rule 3) | "You may push only `sweep/*` and `fix/sweep/*` branches." | §5: "rule 3 amended: driver-journaled pass pushes are the only pushes" | Rewrite rule 3: the agent hand-pushes NOTHING; all pushes are driver-journaled pass pushes (which include target branches) | DOCTRINE | S |
| T2 | CLAUDE.local.md:48-60 (GitHub §) | "`git push` to github FAILS through the credential proxy … Never retry pushes, never hand-roll a push workaround" + "All PR-related API WRITES are performed internally by `propagate publish` … `--token-file`" | §5: refs move via git push ONLY; infra failures REPORTED (D-046 case 2), never worked around | Delete/rewrite the whole paragraph: driver pushes refs; API = PR create/comments only; a failing push is a case-2 owner report, never designed around | DOCTRINE | M |
| T3 | CLAUDE.local.md:163-167 | "builds the tiny-diff exhibit head, asks 'should this PR exist' …" | §1/§5 | Reword publish description to the new head shape + height check | DOCTRINE | S |
| T4 | CLAUDE.local.md:168-172 | "pushes only `fix/sweep/*` and ONLY as a side effect of `propagate publish`; … merging ANY PR remains owner-only until branch protection + required CI exist." | §1 JUDGED auto-merge; §5 driver pushes targets; header supersedes "merging remains owner-only" | Rewrite standing rules: driver pushes targets/closures/HELD PRs after verify green; JUDGED auto-merges; only HELD is owner review | DOCTRINE | M |
| T5 | CLAUDE.local.md:196-197 | ERR03 "exhibit diff ≠ conflict set"; ERR04 "exhibit would carry local-only protected commits" | §5 ERR contract (C12) | Update the Tool result IDs table to the new registry | DOCTRINE | S |
| T6 | CLAUDE.local.md:240-247 | "case 2 … merging remains owner-only (standing rule above); case 3 (resolvable but judgment-worthy …) — publish the draft PR with your PROVISIONAL resolution …; case 4 … (exhibit head …). `edition/*` is always case 3 minimum." | §1: case 3 retired; HELD is the only review state; edition JUDGED auto-merges | Rewrite autonomy boundaries in tier terms (CLEAN/MECHANICAL/JUDGED/HELD/DEFERRED); anything review-worthy ESCALATES to HELD | DOCTRINE | M |
| T7 | CLAUDE.local.md:257-262 | "case 3 provisional resolutions and case 4 freeze/decision PRs — is a **DRAFT** (`propagate publish` creates drafts by design)" | §1: HELD = draft; JUDGED PR = history that auto-flips merged | Rewrite: only HELD PRs are drafts; JUDGED PRs are audit history, closed by the closure push | DOCTRINE | S |

## Class: SKILL (.claude/skills/fork-registry-generate/)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| K1 | seeds.yaml:406-407 | "… case-3 provisional-resolution draft PR, replay downward via rerere. Never freeze/re-ask." | §1: case 3 retired | Reword the recorded decision's directive to tier terms ("resolve as JUDGED — PR history, auto-merge") while preserving the owner's recorded intent; SKILL.md itself encodes no tier/PR policy (no findings) | SKILL | S |

## Class: GAP (policy points nothing regulates — do NOT invent; owner input needed)

| # | artifact:line | quote (short) | policy § | required change | class | size |
|---|---|---|---|---|---|---|
| G1 | (nowhere) | §1 MECHANICAL: "what qualifies is regulated separately, not here" — no artifact (spec, doctrine, skill, config) regulates which conflicts the agent may resolve or the MECHANICAL/JUDGED boundary; the old regulation was the retired case-2/3 rules | §1 | Owner must supply the agent-resolvability rule; until then only the demote-only mechanism exists | GAP | — |
| G2 | (nowhere) | §2 stacking cap "default 5, configurable" — no config key exists anywhere (checked config.ts, routing.yaml surface) | §2 | Needs an owner-blessed config home (routing.yaml vs config.ts) when C5 lands | GAP | — |

## Ambiguities — questions for the owner (policy does not fully determine the fix)

1. G1: what is the rule for which conflicts the agent is allowed to resolve (MECHANICAL qualification and the resolve-at-all boundary)? Policy explicitly defers it; nothing supplies it.
2. JUDGED PR sequencing: is the PR created (head = fix/sweep ref at the real merge commit, pushed) BEFORE the target push that flips it, and is a branch whose push would carry both clean prefix and judged merge commits pushed once (order = bookkeeping) or split into two pushes?
3. JUDGED PR draft-ness: policy says HELD is "the only review state" — should JUDGED history PRs be created non-draft?
4. HELD head for entry-model cases: the run top is an upstream trunk commit — is the fix/sweep ref pushed at that commit verbatim (D-030 head), and what (if any) diff assertion replaces the retired ERR03/ERR04?
5. ERR id numbering: reuse the ERR03/ERR04 slots for the new checks or retire those numbers permanently?
6. Doctrine records `git push` through the credential proxy as broken (CLAUDE.local.md:50): confirm the intended behavior is hard-halt + D-046 case-2 report on first push failure (sweep publication blocked until the host fix deploys) — no fallback.
7. Urge posting and closure pushes need credentials during `run`/push stage: extend `--token-file` to those subcommands, or centralize all networked steps in one publish/push subcommand?
8. D-004 count on the HELD PR: driver-appended annotation on the agent-written body, or agent-written from driver materials with the driver only keeping it current via urge comments?

## Proposed implementation order

1. **Spec target first**: rewrite PROPAGATION.md §1/§3/§5(→ new push §)/§7/§8/§9/§14 + ID registry to match MERGE-POLICY (S1-S10), so code changes have a written target.
2. **Case stacking core** (C5, C6, C7, C8 + G2 config once answered): interval.ts run detection, types/case files, plan/steps/deferred/urge-top plumbing, tests.
3. **Push engine** (C1, C2): journaled verify-gated pass-push stage with the mandated order + pre-PR height check + infra-failure report path.
4. **Publish rewrite** (R1-R9, C3, C4, C9, C10): remove exhibit + API ref fabrication; PR creation/comments on driver-pushed refs; JUDGED closure; posted urges; D-004 count.
5. **ID registry renumber** (C12, S10, T5) — done together with 3-4.
6. **Tests** (R10 + new push/closure/stacking coverage) — alongside 2-4.
7. **Docs**: DESIGN.md banners + §8, README pointer (D1-D4).
8. **Doctrine rewrite** (T1-T4, T6, T7).
9. **seeds.yaml wording** (K1) — as an owner-approved edit (it is recorded-decision text).
10. **rerere in case worktrees** (C11) — independent, any time.
