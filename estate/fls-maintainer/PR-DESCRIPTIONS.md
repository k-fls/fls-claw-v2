# Writing a PR description

You are reading this because the driver told you to — it hands you this path at
the moment it asks for `pr/title.txt` + `pr/body.md`. Nothing else needs it.

- The first line answers WHY: "Decision needed: <the specific choice>" or
  "Review needed: <the specific risk>". If the reviewer can't tell in ten
  seconds why they were summoned, the text is wrong.
- List ONLY the conflicted files (plus merge-forced consequential edits); per
  file, show the resolution hunk (ours vs theirs vs chosen, and why) in a
  collapsed `<details>` block with a GitHub permalink; then state: "everything
  outside these N files is verbatim upstream <range>, already reviewed
  upstream." Close with verification status — and if a gate could NOT run where
  you are (container/bun tests), SAY SO explicitly: a merge is not "verified"
  until the full matrix ran somewhere.
- Write from the case materials only — the conflict markers' two sides plus the
  per-side brief in `pr/materials.md`. Do NOT explore the repo to write the
  description; if the materials aren't enough for an honest description, that
  is `--tier held` — never publish text you don't understand. Name the specific
  decision/risk (no bare "review needed"); describe behaviour, not line counts;
  label each side ours/theirs; no unexplained references.
- Never edit the machine block that appears below your prose. Never write a
  description that says "do not merge".

When the driver asked for a PRISTINE-conflict description, describe the conflict
as it stands — NOT a resolution. The worktree was reset on purpose.
