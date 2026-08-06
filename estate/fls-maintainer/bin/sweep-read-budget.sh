#!/usr/bin/env bash
#
# sweep-read-budget.sh — PreToolUse(Read) hook: refuse the THIRD read of the same
# file within one case.
#
# WHY THIS IS A HOOK AND NOT A DOCTRINE LINE. The rule is already in doctrine, in
# the case materials, in capitals:
#
#     "STOP READING after ONE pass over the implicated code … If you have read
#      those and made no edit, you are done investigating: claim `--tier held`
#      and write the diagnosis. RE-READING A FILE YOU HAVE ALREADY READ is the
#      signal that reading has stopped producing decisions."
#
# It has been read and rationalised past three times now:
#   2026-08-04  35 min, 12 reads of poll-loop.ts, 2 compactions, no edit, no report
#   2026-08-05  30 min, 13 reads, 0 edits
#   2026-08-05  75 min on one gate fix, 2 compactions, 44 min with no submission
#
# The first answer was doctrine (reads dropped ~3x, still no conclusion). The
# second was `diagnosisOnly`, which stopped the loop by forbidding the fix — and
# with it the base defect could never be repaired, so it was deleted. The third
# answer was a serve bound in `next-case`, which counts how many times a case is
# HANDED OUT. That is the wrong axis for this: the agent above never asked for
# another case. It read, and read, inside a single serve, where the driver is
# blind — it sees `next-case` and `report-case`, and nothing in between.
#
# A hook sees every tool call. This is the only layer that can observe the loop
# while it is happening.
#
# WHAT IS BLOCKED, PRECISELY. The third read of the SAME REGION of the same file
# in the same case — path AND offset, not path alone.
#
# That distinction is load-bearing. A transcript audit of the 2026-08-05 session
# measured 99 of 136 reads carrying offset/limit: the agent PAGES through large
# files. Counting by path would refuse the third page of a 2000-line file, which
# is honest work, and would have made this hook worse than the loop it bounds.
# The same audit found 87 of 136 reads (64%) were re-reads, 49% of all Read
# bytes, with `command-gate.ts` read 15 times and `poll-loop.ts` 10 — those are
# the same regions, over and over, and that is what this refuses.
#
# First reads are never touched, and a second is allowed — re-reading once after
# an edit is ordinary work. Only the third says "reading is no longer producing
# decisions", which is doctrine's own wording. The counter resets when the case
# changes, so a budget is per case and never leaks across them.
#
# WHY NOT BLOCK ALL READING PAST A TOTAL. Because a big case legitimately touches
# many files once each, and a cap on distinct files would refuse honest work. The
# repetition is the signal, not the volume.
#
# Contract: PreToolUse hooks receive the tool call as JSON on stdin. Exit 0 to
# allow; exit 2 to BLOCK, with the reason on stderr (the agent reads it).
set -uo pipefail

STATE=/tmp/sweep-read-counts.json
LIMIT=${SWEEP_READ_LIMIT:-2} # allow this many, refuse the next

payload=$(cat)

path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || path=''
offset=$(printf '%s' "$payload" | jq -r '.tool_input.offset // 0' 2>/dev/null) || offset=0
[ -z "$offset" ] && offset=0
if [ -z "$path" ]; then
  path=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -c 2000)
fi
[ -z "$path" ] && exit 0

# Only files inside a case worktree count. Reading the materials, the failing
# output, or anything else the driver wrote is not the loop this bounds.
case "$path" in
*/propagation/pass-*/*/worktree/*) ;;
*) exit 0 ;;
esac

# The case a read belongs to is the one in its own path — no need to consult the
# machine state, and it stays correct if the driver moves on mid-flight.
case_id=$(printf '%s' "$path" | sed -n 's#.*/propagation/pass-[^/]*/\([^/]*\)/worktree/.*#\1#p')
[ -z "$case_id" ] && exit 0

count=$(python3 - "$STATE" "$case_id" "$path" "$offset" <<'PY' 2>/dev/null || echo 1
import json, os, sys
state_path, case_id, path, offset = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
# Key on the REGION, so paging forward through a big file is free and only
# returning to the same window is charged.
path = f"{path}@{offset}"
try:
    s = json.load(open(state_path))
except Exception:
    s = {}
if s.get("case") != case_id:            # new case -> fresh budget
    s = {"case": case_id, "counts": {}}
n = s["counts"].get(path, 0) + 1
s["counts"][path] = n
tmp = state_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f)
os.replace(tmp, state_path)
print(n)
PY
)

[ "$count" -le "$LIMIT" ] && exit 0

cat >&2 <<MSG
BLOCKED: you have already read this part of this file ${LIMIT} times in this case.

  $path  (offset ${offset})

Re-reading a file you have already read is the signal that reading has stopped
producing decisions — that is your own doctrine, and this is it enforced. Three
times an agent has read one file a dozen times across compactions and finished
with no edit, no report-case and no escalation.

Decide now, on what you already have:
  - if you can name the fix, make the edit and run \`report-case\`;
  - if you cannot, run \`report-case --tier held\` and write the diagnosis —
    what fails, why it is not fixable in the named files, and where the fix
    belongs. That is a VALID outcome and the PR is how it reaches the owner.

Other files — and other parts of this one — are still yours to read.
Only this region is exhausted.
MSG
exit 2
