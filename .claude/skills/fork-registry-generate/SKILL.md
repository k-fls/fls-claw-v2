---
name: fork-registry-generate
description: (Re)generate the fork feature inventory (fork-registry entries) into a maintenance-group workspace — mechanical fields derived fresh from git, judgment fields merged from seeds.yaml. Use when bootstrapping a sweep workspace, when the inventory drifted from branch tips, or as step 3 of creating any new module/feat/edition branch.
---

# Fork-registry generation

The fork feature inventory is no longer kept on a registry branch (owner
decision 2026-07-10: `maint/fork-registry` dissolved). It is a **generated
artifact**: mechanical fields are derived fresh from git at generation time,
judgment fields are merged from `seeds.yaml` (next to this skill — their
canonical home). A stamped bootstrap snapshot lives at
`scripts/sweep/bootstrap/fork-registry@<tree-hash>/` for cheap re-bootstrap
without regeneration.

## Inputs

- Schema: `scripts/sweep/registry/schema/feature-entry.schema.json`
- Judgment seeds: `.claude/skills/fork-registry-generate/seeds.yaml`
- Latest snapshot (fallback when a seed entry is missing):
  `scripts/sweep/bootstrap/fork-registry@*/features/`
- Scope/exclusion policy: `scripts/sweep/registry/scope.yaml`

## Generate into a target directory (group workspace)

For every branch in the rule-5 set — `module/*`, `feat/*`, `edition/*`
excluding `experimental/*`, `wip/*`, `everything*`, `worktree-agent-*`,
`integration/*`, `test/*` (compare `git branch --list`) — write
`<target>/<kind>.<slug>.yaml`:

1. **Mechanical fields (derive fresh, never copy):**
   - `branch` — the branch itself; `kind` from the namespace; `id` =
     `<kind>.<slug>` = filename stem.
   - `parents` / `dependents` — from the confirmed topology (merge-commit
     subjects `Merge branch 'X' into Y`; tip-ancestry is NOT trustworthy
     post-sweep). Cross-check against existing entries before changing edges.
   - `owned_paths` — globs covering the branch's **ADDITIONS relative to its
     parents**. NEVER derive from a symmetric `git diff main_patched <branch>`
     (polluted by propagation lag; verified pitfall: `src/provider-surfaces.test.ts`
     appears in the agc diff but originates in shared commit `14810a50`).
     Confirm each candidate with `git log --diff-filter=A <branch> -- <path>`
     and absence on the parents (`git ls-tree <parent> -- <path>` empty).
   - `touch_paths` — upstream/shared files the branch MODIFIES (hooks into):
     changed-but-not-added relative to parents; this is the merge-risk surface.
   - `key_symbols` — spot-check anchors (`"Sym — path"` or
     `"SymA / SymB — path"`), verified with `git grep -F <sym> <branch>`.
   - `test_anchors` / `design_docs` — existing files only (validator rule 3
     ALERTs on missing paths; `design_docs` may be `path@branch`).
   - `maintenance.verified_against` — the branch tip
     (`git rev-parse <branch>`) AT GENERATION TIME; `maintenance.last_verified`
     — today's date. This is what validator rule 6 checks drift against.
2. **Judgment fields (merge, never invent):** `name`, `summary`,
   `invariants`, `overlap_hints`, `routing` (keywords, always_check_on),
   `prompt.extra_context` — taken from `seeds.yaml` by feature id; when the
   seed lacks an entry, fall back to the latest snapshot's entry; when both
   lack it, leave the field out and add
   `maintenance.notes: "skeleton — needs enrichment"`.
3. Validate the result: `pnpm exec tsx scripts/sweep/sweep.ts
   validate-registry --repo <repo> --inventory <target>` — fix ALERTs before
   using the inventory for routing.

## Authoring judgment for NEW features

When you cut a new `module/*`, `feat/*` or `edition/*` branch, **the registry
entry (seed + regenerate) is step 3 of the new-feature workflow** — do not
defer it:

1. Add a `features.<id>` block to `seeds.yaml`: `name`, 2-5 sentence
   `summary` readable with zero repo context, `overlap_hints` (what upstream
   work would duplicate this), `routing.keywords`, and — most valuable —
   `invariants`: assumptions about UPSTREAM code this feature depends on
   (e.g. "poll-loop must keep graceful-stop semantics"). A broken invariant
   is at least OVERLAP-TOUCH for the overlap-check subagent.
2. Regenerate the entry (steps above) so mechanical fields are derived, and
   commit the seeds change together with the feature branch's first PR.

## Snapshot refresh policy

The committed snapshot is a bootstrap convenience, not live state. When the
live inventory drifts materially (new features, ownership corrections,
status changes — not mere `verified_against` tip movement), commit a NEW
stamped snapshot via PR: copy the generated `features/` to
`scripts/sweep/bootstrap/fork-registry@<hash12>/` where `<hash12>` is the
first 12 chars of `git hash-object`-style tree hash of the directory
content (for a committed source: `git rev-parse <ref>:<path>`), and write a
`MANIFEST.md` recording snapshot date, source, full tree hash, and the
entry → `verified_against` table. Old snapshots may be deleted once nothing
references them; the git history is the archive.
