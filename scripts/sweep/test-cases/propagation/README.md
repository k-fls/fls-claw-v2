# Mined propagation-driver test cases (2026-07-18)

Real-DAG regression cases for the mechanical propagation driver
(`scripts/sweep/DRIVER.md` §4.3–§4.5), mined from
`/home/user/workspace/fls/fls-claw-v2-clean` (fork k-fls/fls-claw-v2 of
nanocoai/nanoclaw). Follows the conventions of
`/home/user/workspace/fls/wt/feat-maintenance-sweep/scripts/sweep/test-cases/`
(full 40-char SHAs, block scalars for strings containing ` #NNNN`,
`resolution_ref` where a recorded resolution merge exists, never
single-base `git merge-tree --merge-base=`).

Every probe below was executed with new-style two-argument
`git merge-tree --write-tree [--name-only] <branch> <head>` on 2026-07-18.
Raw probe transcripts: `probes/`, full per-branch linear profiles: `profiles/`
(one line per height: `<height> <sha> CLEAN|CONFLICT [paths] tree=<oid>`).

## Anchors (all verified with `git rev-parse` / `git cat-file -e`)

| anchor | SHA |
|---|---|
| fork point (nanocoai v2.1.1) | `d85efea229ea63fb0bd4f57a039f4ef73ece563b` |
| `main` = chain base (height 0) | `cb6e3d117c127054ca5bc5a53645d794d93cc595` |
| `upstream/main` watermark = height 98 | `082f5c7ea99342fcb324ab78baacb0c4e6894029` |
| `main_patched` tip | `453c746b2d49a07d836077b3fbb9172864c8b564` |

## Height model

`chain.txt` = `git rev-list --first-parent --reverse main..upstream/main`
(98 commits; line N = height N; the unit of merge is the upstream PR merge
commit). NOTE: the "~330 pending commits" figure is total commits;
the first-parent chain has exactly 98 heads.

The `#2890` hot spot is height 1 (`c87f2e55…`) and the disputed path is
`src/cli/resources/groups.ts` — **not** `src/groups.ts` (that path does not
exist in either tree; the briefing's path was wrong).

## Schema — propagation-specific fields

New fields needed by the propagation semantics (documented here, used in
`cases/*.yaml`):

- `class:` taxonomy class 1–7 (non-monotonic-window, deferred-positive,
  same-commit-disjoint, multi-parent, noop-skip, clean-through-held,
  largest-clean-height).
- `status:` `verified` | `candidate-unverified` | `not-found-closest-shape`.
  A `not-found-closest-shape` case pins the nearest real shape plus the
  evidence that the strict class shape does not exist in this repo today.
- `watermark:` the pinned upstream tip SHA the pass targets (height 98).
- `chain:` `{base, tip, length, enumerate_cmd}` — the trunk first-parent
  chain the heights index into.
- `heights:` map of the heights this case pins, `height -> {sha, subject}`.
- `coverage_height:` per branch, highest chain height whose commit is an
  ancestor of the branch tip (derived, `git merge-base --is-ancestor`).
- `parent:` / `child:` `{branch, tip}` pair for parent/child cases.
- `conflicted_paths:` observed conflict file set of the pinned probe
  (annotated `(add/add)` etc. where non-content; unannotated = content).
- `automerge_tree:` tree OID written by the conflicting `merge-tree` probe
  (contains conflict markers; usable as the case's automerge tree).
- `result_tree:` / `current_tree:` tree OIDs for no-op-skip equality checks.
- `probes:` list of `{cmd, exit, conflicts, tree}` — exact re-runnable
  commands with observed results.
- `profile:` for linear-sweep cases, run-length encoding of the full
  clean/conflict profile over the chain.
- `resolution_ref:` recorded merge commit that resolved the pinned conflict
  (rerere seed), where one exists.
- `pin_patch:` (single-commit fork-branch cases only) path under `pins/` to a
  `git diff --binary main <tip>` patch. When the pinned `tip` sha is unreachable
  (`git cat-file -e` fails), the replay applies this patch to `main` in a
  detached temp worktree and `commit-tree`s it, recreating the exact tip tree
  with merge-base `main` — so all probes reproduce. See "Pin-by-patch" below.

## Pin-by-patch (2026-07-20)

`fix/main/role-grant-scope-clarity` (case `p7`) was **rebased by the owner** on
2026-07-20; its mined tip `a512bc9f` is now unreachable and will be gc-pruned.
Rather than re-anchor with a tag/ref (which we deliberately do not create), p7
carries `pin_patch: pins/p7-fix-main-role-grant-scope-clarity.patch`. Applying it
to `main` (`cb6e3d11`) yields tree `278894c58d4e067d73be2b9133260ff3a2851446`
(= `a512bc9f^{tree}`); the merge base with the chain is `main` either way (the
branch was cut from `main`), so p7's assertions hold identically (conflict-tree
OIDs are not asserted). The replay `synthesize`s this on demand and also has a
dedicated FALLBACK test that forces the synthesis path so it cannot rot while
the live sha still exists. All propagation-case skips are LOUD (`console.warn`
naming the case + vanished anchor) — a green run can never hide a pruned anchor.

Only SINGLE-commit fork branches are patch-pinned. The multi-commit fork tips
(`p2`/`p4`/`p5`/`p6`) are NOT: a patch vs `main` would be huge and fragile — if
those branches rebase, **re-mine** the case rather than patch-pin it.

## Verification quirks

- Never use `--merge-base=` single-base merge-tree (multiple merge bases
  exist between fork branch pairs).
- `git merge-tree --write-tree` writes loose tree/blob objects but no refs —
  safe on a read-only repo.
- Heights below a branch's `coverage_height` probe as trivially CLEAN
  (the head is an ancestor; result tree = branch tree). A "largest clean
  height" at or below coverage means the sweep makes no upstream progress.

## Anchor head (owner-authorized 2026-07-20)

Branch `test/pins/propagation-cases-20260720` (@ 453c746b2d49a07d836077b3fbb9172864c8b564,
pushed to origin) anchors every case-referenced commit that was not reachable from
origin/upstream refs: the pre-rebase `fix/main/role-grant-scope-clarity` tip
`a512bc9f…` (p7), its resolution merge `822f75b1…` (p7 resolution_ref), the local
`fix/main/last-owner-guard` tip `1148dca2…`, and the 2026-07-18 local main_patched
tip itself — the single head contains all four. The `test/*` namespace is
sweep-excluded, so the pin can never enter merge scope. NOTE: this head's ancestry
includes the owner's local-only main_patched merges and the rolled-back 2026-07-13
sweep-merge history (objects republished under a pin ref only — no product branch
points at them). The pin-by-patch fallback and loud skips remain as defense in depth.
