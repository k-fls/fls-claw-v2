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
| MECHANICAL | conflict the agent is allowed to resolve (what qualifies is regulated separately, not here) | direct merge | cold-read confirm required | none — journal + cold-read artifact only |
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
