# estate/ — version-controlled scaffolds of the maintenance-estate groups

Per design doc 02 §11: the estate's group scaffolds live in the repo so the estate is
reviewable and restorable. Deploy = copy `estate/<group>/` contents into
`groups/<group>/` on the host (estate-sync; manual scp until the updater exists).
The deployed copy on the server is a MIRROR — edit here, then sync; never let the two
drift silently.

Current groups:
- `fls-maintainer/` — CLAUDE.local.md doctrine (group CLAUDE.md is composed at spawn;
  per-group content must be CLAUDE.local.md). Deployed on fls-claw-server v2 as group
  f6cc450d-a1dd-4e7b-ae18-6653e5e9e249, folder groups/fls-maintainer/.
