# Sweep-Pipeline Test-Case Registry

Regression test cases for the automated upstream-sweep pipeline (per-branch
merge-tree conflict scan → PoI classification → merge/gate). Each case pins a
historical fork state and an upstream commit range whose replay must be
classified/handled exactly as recorded in `expected:`.

All SHAs were verified (`git cat-file -e <sha>^{commit}`) and every recorded
conflict set was reproduced with new-style `git merge-tree` on 2026-07-10.

## Layout

```
test-cases/
  README.md                     this file
  cases/<id>.yaml               one case per file (schema below)
  fixtures/pending-range-recon.md   dated recon snapshot of cb6e3d11..0c0f4c25
```

## Anchor commits

| anchor | SHA |
|---|---|
| fork point (nanocoai v2.1.1) | `d85efea229ea63fb0bd4f57a039f4ef73ece563b` |
| June-2026-sweep upstream tip (v2.1.17-era) | `2afbd1823356a610302cc13e95f87204d3413d43` |
| July-2026-sweep upstream tip = current `main` (v2.1.23) | `cb6e3d117c127054ca5bc5a53645d794d93cc595` |
| `upstream/main` as of 2026-07-10 (v2.1.41+) | `0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9` |
| `main_patched` tip as of 2026-07-10 | `ad619134b9b0b783996265d0b121a616bab4ccdc` |

## Replay model

A test run never touches real branches:

1. `git worktree add --detach <tmpdir> <fork_base_commit>` — throwaway worktree
   at the pinned historical fork state.
2. Replay the merge:
   - cases with `upstream_range`: `git merge <upstream_range.to>`. The
     `fork_base_commit` is chosen so its merge-base with `to` is at (or before)
     `upstream_range.from`, so the merge replays exactly that range.
   - cases with `merge_source` (fork-internal propagation replays, e.g. the
     T2 family): `git merge <merge_source>`.
3. Assert the pipeline's classification, conflict file set, and PoI list
   against `expected:`.
4. `git worktree remove --force <tmpdir>` (and prune the temporary merge
   commit refs, if any were created).

Non-destructive scan-only variant: `git merge-tree <fork_base_commit> <to>`
(see quirks) reproduces the conflict file set without any worktree at all.

## Quirks (learned the hard way — do not skip)

- **Formatter PostToolUse hook**: a repo-level formatter/linter hook reflows
  files edited during a session and can dirty even a throwaway worktree. Run
  `git restore .` in the throwaway worktree *before* asserting cleanliness or
  diffing merge results.
- **Never use single-base `merge-tree`** (`--merge-base=<x>`): several fork
  branch pairs have TWO merge bases (e.g. feat/mitm-credential-proxy ↔
  feat/onecli-broker: `upstream/main` plus a `module/credentials` merge).
  Single-base mode forces the wrong base and reports ~20 bogus add/add
  conflicts. New-style two-argument `git merge-tree <b1> <b2>` recursively
  merges the bases like real `ort` and is safe; real `git merge` is the
  ground truth.
- **T2 pins double as rerere seeds**: replaying `t2a-dedup-propagation` and
  `t2b-dupsend-propagation` and recording their canonical keep-both
  resolutions with `git rerere` pre-trains the cache the pipeline ships in
  `sweep-state/rr-cache/`.
- **Schema note**: exactly one of `upstream_range` / `merge_source` is the
  replay input. T2-family files carry an extra `family:` key grouping them.
  `t10-telegram-ancient` carries an `upstream_range` for data completeness,
  but the expected behavior is that the exclusion gate trips BEFORE any merge
  or merge-tree is attempted.
- Case `expected.conflicts` entries annotate non-content conflict kinds
  inline: `path (modify/delete)`, `path (add/add)`; unannotated = content
  conflict.
