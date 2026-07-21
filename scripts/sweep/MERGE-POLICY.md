# Merge & publication policy — canonical (D-049)

Status: owner-settled 2026-07-21. This file is the AUTHORITY on tiers, batching,
noise, review, and publication. PROPAGATION.md holds driver mechanics; on conflict,
this file wins. Supersedes: case-1..4 ladder (DESIGN.md §6), doc 02 §5 step-3
"one PR per DAG edge batch", D-030 exhibit-commit construction, the API push
workaround, "merging remains owner-only".

## 1. Merge tiers (per parent→branch merge attempt)

| Tier | Trigger | Action | Review | PR |
|---|---|---|---|---|
| CLEAN | no textual conflict (merge-tree) | bulk direct merge | none | none |
| MECHANICAL | conflict the agent is allowed to resolve (qualification: §7) | direct merge | cold-read confirm required | none — journal + cold-read artifact only |
| JUDGED | non-obvious conflict, agent-resolved | merge; same commit pushed to target → PR auto-marks merged | cold-read confirm required | yes (history) |
| HELD | unresolved / cold-read reject / scope-guard violation / red verify gate / escalation | clean prefix merges first; draft PR at the conflicting head | **owner** (the only review state) | draft PR, real diff (D-030 head) |
| DEFERRED | conflict belongs to a HELD ancestor: held height ∈ (floor, N′] window AND conflicted paths intersect | no merge of that range; freeze; auto-unfreeze when ancestor clears | none | none |

Tier rules:
- CLEAN vs conflict: computed (merge-tree). MECHANICAL vs JUDGED: agent-claimed, driver demote-only.
- Floors: `edition/*` and `tier_floor: judged` entries → min JUDGED (D-015). Edition
  JUDGED **auto-merges** (intended); owner-gating happens only by escalation to HELD.
- Only HELD needs external review. Anything review-worthy at any tier is ESCALATED to
  HELD and inherits ALL HELD rules. Old "case 3" (open provisional PR) is retired.
- Scope guard: resolution diff ⊄ allowed set → HELD. Lever: `same-files` (default;
  extra file = violation) / `conflict-hunks` (strict; must stay in marker regions).
- Red verify gate → HELD(gate).
- Same-height conflict, disjoint paths from the held ancestor → own conflict, normal
  ladder (not DEFERRED).

## 2. Case unit — commit stacking

- A case = the MAXIMAL RUN of consecutive conflicting heights whose conflicted path
  sets intersect (one logical decision), capped (default 5, configurable).
- The run breaks at: a clean height, a disjoint-path conflict (own case later), the cap.
- Applies to ALL conflict tiers: MECHANICAL/JUDGED resolve the run as one case (one
  cold-read); HELD's draft PR head = the run's TOP commit → diff = the whole run.
- DEFERRED windows and urge tracking are computed against the run's top.
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
  parent merge + shared rerere (D-006).
- JUDGED PR closure: push the SAME merge commit → no merge-of-merge commits.
- Frozen branch: skipped every pass; one posted urge-comment per NEW pending head
  (`lastUrgedHead`), silent otherwise.
- MECHANICAL: no PR at all — journal + cold-read artifact only.

## 5. Publication & pushes

- The DRIVER pushes; the agent NEVER hand-pushes anything (rule 3 amended: driver-
  journaled pass pushes are the only pushes).
- Nothing is pushed before `propagate verify` is green for the pass (D-012).
- Per-pass push order, per branch: target branches (CLEAN/MECHANICAL/prefix merges) →
  JUDGED closure pushes (PR flips to merged) → HELD draft PRs (base is then current,
  so the HELD diff = the case run only).
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

- Owner attention surface = HELD draft PRs + D-046 messages (candidates, failures,
  one end-of-sweep result). JUDGED PRs are history, not owner work.
- D-004 annotation: a frozen branch's HELD PR carries the count of further pending
  upstream commits (kept current via urge comments).
- HELD PR text: written by the AGENT from studying the case (materials + worktree);
  driver provides facts only; text gated by the two-round cold read (hard cap).

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
