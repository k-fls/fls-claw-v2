# Mining findings — propagation-driver real cases (2026-07-18)

Repo: `/home/user/workspace/fls/fls-claw-v2-clean` (read-only; probes via
new-style `git merge-tree --write-tree`, loose objects only, no refs).
Watermark: `upstream/main` = `082f5c7ea99342fcb324ab78baacb0c4e6894029`.
Chain: `git rev-list --first-parent --reverse main..upstream/main` → **98**
first-parent heads (`chain.txt`; the "~330" figure counts all commits, not
merge units). Chain base `main` =
`cb6e3d117c127054ca5bc5a53645d794d93cc595`.

Evidence artifacts in this directory:
- `chain.txt`, `chain-subjects.txt` — height→SHA/subject table.
- `profiles/*.txt` — 44 full linear profiles (one merge-tree probe per
  height per branch tip; 4312 probes total): 42 live branch tips + 2
  historical tips.
- `probes/tip-and-h1-scan.txt` — 28 branches × {watermark, height 1}.
- `probes/key-probes-detail.txt` — full merge-tree output (conflict kinds)
  for the pinned probes.
- `cases/p1..p7.yaml` — the mined cases (schema documented in README.md).

## Path correction (affects the briefing)

The #2890 hot spot path is **`src/cli/resources/groups.ts`**, not
`src/groups.ts` (which exists in neither `main_patched` nor
`upstream/main`). Five pending PRs touch it: #2890 (h1), #2416 (h57),
#3035 (h86), #2906 (h92), #3022 (h94).

## Per-class status

| class | status | case id |
|---|---|---|
| 1 non-monotonic window | **not found** (evidence below); closest shape pinned | `p1-nonmonotonic-window-notfound` |
| 2 deferred-positive | **verified** | `p2-deferred-positive-hostrpc-egress` |
| 3 same-commit-disjoint | **not found** as ancestor pair; sibling shape verified | `p3-same-commit-disjoint-telegram-sibling` |
| 4 multi-parent | **verified** | `p4-multi-parent-mitm` |
| 5 no-op skip | **verified** (4 instances) | `p5-noop-skip-mitm-interactions-helpers` |
| 6 clean-through-held | **verified** | `p6-clean-through-held-docs-notes` |
| 7 largest-clean-height | **verified** | `p7-conflict-profile-role-grant` |

### Class 1 — non-monotonic window: NOT FOUND (a real result)

Across all 44 profiled tips × 98 heights there is **zero**
CONFLICT→CLEAN transition and **zero** path-level dropout (no path ever
leaves a conflict set as the head advances). Conflict sets in this range
are strictly monotone-growing. Corroborating: the pending range contains
no revert commits (`git log --grep` over `main..upstream/main` is empty),
removing the main mechanism that creates windows. Re-run check:

```
for f in profiles/*.txt; do grep -v '^DONE' $f | \
  awk -v F=$f '{st=($3=="CLEAN")?"C":"X"; if(prev=="X"&&st=="C")print F": window at "$1; prev=st}'; done
```

The only real "conflicted historically, clean today" shape is branch-tip
advancement: `main_patched@ad619134…` (2026-07-10 tip) conflicts at h1 on
groups.ts; current `main_patched@453c746b…` is clean there (resolution
merge `73d02022d77bf786dd3110de626004748e349f2e`). Pinned in p1. The
synthetic fixture (spec §11) remains the only executable window test.

### Class 2 — deferred-positive: verified

P=`module/host-rpc` (tip `1386c873…`), C=`module/egress-lockdown` (tip
`01b10d1c…`, inventory parents `[module/host-rpc]`, parent tip is git
ancestor of child tip). Both first-conflict at **height 1**
(`c87f2e55…`, PR #2890) on the identical set
`{src/cli/resources/groups.ts}` (content conflict). Five more pairs with
the same shape listed in the case file.

### Class 3 — same-commit-disjoint: no ancestor-pair instance

Grouped by first-conflict height: h1 (all module/*, most feat/*, edition,
fix/ncl-crud-side-effects, fix/creds-*, fix/pgp-*, fix/mitm-github-*),
h3 (fix/main/approval-card-rendering `{src/cli/dispatch.ts}`,
fix/main/approval-privilege-routing `{dispatch.test.ts, dispatch.ts}`),
h12 (fix/main/command-gate-mention-prefix), h62
(fix/main/role-grant-scope-clarity), h77 (fix/duplicate-result-dispatch),
h92 (main_patched), h96 (module/container-queue). Every ancestry-linked
pair sharing a first-conflict height shares it at h1 and every h1 set
contains groups.ts → always intersecting (deferred, class 2). The only
disjoint same-commit pair is **siblings**:
`fix/channels/telegram-markdown-nesting` at h1 conflicts on
`{.claude/skills/add-deltachat/* (add/add), package.json, pnpm-lock.yaml,
setup/index.ts}` — disjoint from the module family's `{groups.ts}`.
Pinned in p3 with the required synthesized-registry replay note.

### Class 4 — multi-parent: verified, unusually rich

`feat/mitm-credential-proxy` has **six** inventory parents. Coverage
split: `module/container-queue` covers height **88** (it merged upstream
directly at some point); the other five cover height **0**. Per-parent
probe verdicts hit all classes at once: 2 no-op skips (ancestor parents),
1 clean real merge (`module/credentials`), 2 fork-internal conflicts
(`module/egress-lockdown`, `module/host-rpc` — on launch-shape/config
paths, zero upstream involvement), 1 upstream-carrying conflict
(`module/container-queue`, 15 paths). Surprise worth noting: **parents can
conflict with their own child** (egress-lockdown → mitm), and one parent
(host-rpc) is simultaneously an inventory ancestor of another parent
(egress-lockdown) of the same child.

### Class 5 — no-op skip: verified ×4

Tree-equality proven for: mitm←interactions-helpers,
mitm←agent-group-contributions (both result in the child tree
`33315cda…`), egress-lockdown←host-rpc (`467d2e58…`),
onecli-broker←mitm (`e8338c7d…`). Counter-example in the same branch:
mitm←credentials exits 0 but yields a DIFFERENT tree (`0f4198eb…`) —
skip detection must compare trees, not exit codes.

### Class 6 — clean-through-held: verified

`docs/notes` (`b2214875…`) and `fix/main/last-owner-guard` (`1148dca2…`)
merge the whole 98-height range clean (all-heights profiles + tip probes,
result trees pinned) while siblings are held at h1 (module family), h62
(role-grant) and h92 (main_patched). Ancestor-flavored near-instance
(main_patched passing h62's roles.ts region cleanly via recorded
resolution while ancestor branch role-grant stays held there) documented
in the case notes — its overall probe is not clean (groups.ts), so the
strict "textually CLEAN" instance is the sibling shape.

### Class 7 — largest-clean-height: verified

`fix/main/role-grant-scope-clarity` (`a512bc9f…`, coverage 0): clean
1–61, conflict 62–98, constant set `{src/cli/resources/roles.ts}` at
every conflicting height. Largest clean height **61**
(`1ccef326dc8b84656c38690001f8902e1a505311`), smallest conflicting above
**62** (`1725d86fbd8a841c9202aa61d041c068a79b26d6`, PR #3006).
resolution_ref `822f75b1…` (merge into main_patched). Three alternate
transition points (h12, h77, h96) listed in the case file.

## Other DAG surprises

- `main_patched` coverage is height **91** — a plain docs commit
  (`ef220b53…`), not a PR merge: the 07-13/14 sweep merged a mid-chain
  commit, so coverage can legitimately point between PR units.
- All first-conflict path sets at h1 include groups.ts except the
  pre-fork-era `fix/channels/telegram-markdown-nesting` (excluded branch,
  750 commits behind).
- `module/container-queue` is the only module branch with nonzero pending
  coverage (88) — it breaks the "modules get upstream only via
  main_patched" mental model and is why it is the interesting parent in p4.
