---
name: fork-registry-generate
description: (Re)generate the fork feature inventory (scripts/sweep/inventory/*.yaml) — mechanical fields derived fresh from git, judgment fields preserved from the committed entries. Use when the inventory drifted from branch topology, or as step 3 of creating any new module/feat/edition branch.
---

# Fork-registry generation

The fork feature inventory is **config tracked in the fork repo** at
`scripts/sweep/inventory/*.yaml` — one strict-schema entry per feature, owner-
authored intent only, and the single canonical copy. Mechanical fields are
derived fresh from git at generation time; the judgment fields (`name`,
`summary`, `routing`) are preserved from the entry already committed there.
Changes land as ordinary commits/PRs on the driver branch; git history is the
archive.

The inventory is configuration only. It never carries state and never carries
prose addressed to the sweep agent: no status, no verification stamps, no
notes, no recorded decisions, no free-text guidance. A decision lives in the
code it produced, or on the pull request that made it; what a resolution must
respect is read from the repository, not from an entry. `sweep start` fails
hard on any entry with an unknown key or bad value (strict schema:
`scripts/sweep/registry/schema/feature-entry.schema.json`, enforced by
`parseFeatureEntry` in `scripts/sweep/registry.ts`).

## Inputs

- Schema: `scripts/sweep/registry/schema/feature-entry.schema.json`
- Current inventory (the canonical judgment fields): `scripts/sweep/inventory/`
- Scope/exclusion policy: `scripts/sweep/registry/scope.yaml`

## Generate

For every branch in the rule-5 set — `module/*`, `feat/*`, `edition/*`
excluding `experimental/*`, `wip/*`, `everything*`, `worktree-agent-*`,
`integration/*`, `test/*` (compare `git branch --list`) — write
`scripts/sweep/inventory/<kind>.<slug>.yaml`:

**Local-only features** — implemented on the owner's machine but deliberately
NOT on origin. Emit them **without `branch`**
(and without `parents`/`test_anchors`; keep `owned_paths` as intended paths so
overlap routing keeps working) — an entry without `branch` is out of sweep
scope and raises no missing-branch alerts. When one appears on origin, drop it
from `local_only_features` and generate it normally.

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
   - `key_symbols` — spot-check anchors (`"Sym — path"` or
     `"SymA / SymB — path"`), verified with `git grep -F <sym> <branch>`.
   - `test_anchors` / `design_docs` — existing files only (validator rule 3
     ALERTs on missing paths; `design_docs` may be `path@branch`).
2. **Judgment fields (preserve, never invent):** `name`, `summary` and
   `routing` (keywords, always_check_on) are carried over verbatim from the
   committed entry. When an entry is new, write them; when a field is missing,
   leave it out and name the gap in the commit message. Add no other prose:
   the schema rejects it.
3. Validate the result: `pnpm exec tsx scripts/sweep/sweep.ts
   validate-registry --repo <repo> --inventory scripts/sweep/inventory` — fix
   ALERTs before committing.

## Authoring judgment for NEW features

When you cut a new `module/*`, `feat/*` or `edition/*` branch, **the registry
entry (seed + regenerate) is step 3 of the new-feature workflow** — do not
defer it:

1. Write the entry's judgment fields: `name`, a 2-5 sentence `summary`
   readable with zero repo context, and `routing.keywords`.
2. Derive the mechanical fields (steps above), and commit the entry together
   with the feature branch's first PR.
