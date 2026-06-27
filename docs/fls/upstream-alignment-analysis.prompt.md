# Upstream-alignment analysis — subagent brief (reusable)

Run this as a read-only analysis whenever we want to find places our fork should
align with upstream after pulling in new upstream commits. Update the three refs
(B / U / F) to current values before each run.

---

ROLE: You are auditing a FORK of an open-source project (nanoclaw / "NanoClaw v2")
for SEMANTIC alignment opportunities with upstream. Work read-only (git only); do
not modify, checkout, or build anything — other work may be happening concurrently.

CONTEXT:
- This repo is a fork. Our fork added a stack of feature modules on top of an
  upstream base, then we merged a large batch of new upstream commits into all our
  branches. All TEXTUAL merge conflicts are already resolved; builds/tests pass.
- The merge resolved textual conflicts ONLY. What remains un-examined: places where
  OUR fork independently built some capability AND upstream has SINCE introduced its
  OWN similar capability — usually in DIFFERENT files, so git never flagged a
  conflict. These SILENT semantic overlaps (convergent evolution) are the target:
  fork logic that should perhaps adopt the principles/abstractions upstream introduced.

GOAL: A rigorous, evidence-backed list of genuine alignment candidates — fork-added
logic that semantically parallels a capability upstream NEWLY introduced, where we
should consider changing or relocating our logic to align with upstream's principles.

REFERENCE POINTS (git refs — VERIFY/UPDATE before running):
- B (fork base: before our fork's work AND before the new upstream commits) = `d85efea2` (nanocoai v2.1.1).
- U (upstream now) = `upstream/main`  (was `2afbd182`).
- F (our integrated fork: ALL our modules on base B, WITHOUT the new upstream commits) = `everything` (was `3915e5b4`).
  If `everything` is stale/missing a module, our feature branches live on remote `origin` as `module/*` and `feat/*`; the leaves are `feat/mitm-credential-proxy`, `feat/ssh-auth`, `feat/onecli-broker`. Cross-check individual branch tips if `everything` omits one.

METHOD:
1. OUR fork's additions = `git diff --stat B F` and `git log --oneline B..F`. Focus on
   NEW files/modules our fork introduced (e.g. `src/modules/*`, new top-level features).
2. UPSTREAM's new capabilities = `git diff --stat B U` and `git log --oneline B..U`
   (read the commit messages — they describe the features).
3. For each non-trivial capability OUR fork added, ask: did upstream ALSO introduce
   something for the same concern (even in different files / with a different design)?
   That pairing is a candidate.

THE RIGOROUS TEST — apply to EVERY candidate before reporting; do NOT skip a step:
- (a) The OUR side must be FORK-ONLY: its file/symbol must NOT exist on `upstream/main`.
      Verify: `git cat-file -e upstream/main:<path>` (absent ⇒ fork-only), or
      `git show upstream/main:<path> | grep -c <symbol>` (0 ⇒ fork-only).
      If it IS on upstream, it is NOT our logic to align — DISCARD.
- (b) The UPSTREAM side must be GENUINELY NEW: on U but NOT at B. Verify:
      `git cat-file -e d85efea2:<path>` (absent ⇒ new) or `git log d85efea2..upstream/main -- <path>`.
- (c) EXCLUDE same-file fork-modifications of files that ALREADY existed on upstream
      (e.g. our edits to `src/egress-lockdown.ts`, which existed on upstream before we
      forked it). Those were direct merge conflicts and are ALREADY DECIDED by the
      merge. We only want SILENT overlaps living in DIFFERENT files.
- (d) EXCLUDE anything tied to `cli-policies` or any branch/feature with NO remote on
      `origin` (out of scope).

OUTPUT — for each SURVIVING candidate:
- Our implementation: file(s) + one line on what it does (+ the fork-only evidence).
- Upstream's parallel capability: file(s) + what it does (+ the new-on-upstream evidence).
- The semantic overlap (why they are convergent).
- Recommendation: change / relocate / adopt-upstream-principle / leave-divergent — with reasoning.
- Confidence + blast radius.

DISCIPLINE — be skeptical and unbiased:
- Two VERIFIED candidates beat six plausible-but-wrong ones.
- Anything you cannot back with a git command: say so and EXCLUDE it.
- Also list candidates you CONSIDERED and REJECTED, each with the test it failed
  (e.g. "on upstream — fails (a)"). The rejected list is as valuable as the accepted one.
- Common false-positive trap: reading upstream/base code as "ours" (e.g. memory
  scaffold, approval primitives, CLAUDE.local seeding all live on upstream — NOT ours).

Return the full analysis as your final message. Make no changes.
