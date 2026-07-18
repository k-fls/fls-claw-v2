# Mined propagation-driver test cases (2026-07-18)

Real-DAG regression cases for the mechanical propagation driver
(`scripts/sweep/PROPAGATION.md` §3–§6), mined from
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
commit per D-011). NOTE: the "~330 pending commits" figure is total commits;
the first-parent chain has exactly 98 heads.

The `#2890` hot spot is height 1 (`c87f2e55…`) and the disputed path is
`src/cli/resources/groups.ts` — **not** `src/groups.ts` (that path does not
exist in either tree; the briefing's path was wrong).

## Schema — fields beyond the old test-case format

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

## Verification quirks (inherited + new)

- Never use `--merge-base=` single-base merge-tree (multiple merge bases
  exist between fork branch pairs; see old README).
- `git merge-tree --write-tree` writes loose tree/blob objects but no refs —
  safe on a read-only repo.
- Heights below a branch's `coverage_height` probe as trivially CLEAN
  (the head is an ancestor; result tree = branch tree). A "largest clean
  height" at or below coverage means the sweep makes no upstream progress.
