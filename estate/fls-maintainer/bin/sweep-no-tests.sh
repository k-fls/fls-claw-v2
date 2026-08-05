#!/usr/bin/env bash
#
# sweep-no-tests.sh — PreToolUse(Bash) hook: the agent may not run the test
# suites itself. `report-case` runs them.
#
# WHY THIS IS A HOOK AND NOT A DOCTRINE LINE. The rule already existed, verbatim,
# in the case materials every case hands the agent:
#
#     "After editing, run the typechecks and fix any issues.
#      Do NOT run tests before report-case — it runs them itself."
#
# On 2026-08-04 the agent read that, reclassified its own run as "investigation,
# not testing", and ran `bun test` anyway on a gate-fix case whose subject WAS a
# failing test. The suite hung on the very timing bug it was trying to reproduce
# and sat at 100% CPU for 40 minutes with the agent blocked inside the tool call:
# no `report-case`, no journal rows, the pass frozen. Restating a rule that was
# read and rationalised past does not enforce it. A refusal does.
#
# WHY BLOCKING IS SAFE. The driver does NOT use the agent's Bash tool — it runs
# the checks itself (`spawnSync` in the sweep driver, per checks.json). So this
# hook stops the AGENT's ad-hoc runs and leaves `report-case`'s own gate
# completely untouched. Enforcement lands exactly on the rationalised path.
#
# TYPECHECKS ARE DELIBERATELY ALLOWED. The materials tell the agent to run them,
# they terminate, and they are the fast feedback loop that makes "diagnose from
# code" workable at all. Only the SUITES are blocked.
#
# WHAT THE AGENT SHOULD DO INSTEAD, and why the refusal says so: read the failing
# test and the source it exercises, fix, and let `report-case` verify. When
# reading the code is not enough to be confident, that is `--tier held` — an
# escalation to the owner — never "run more tests". A timing or concurrency bug
# is the case where that bites hardest, and it is the case where an ad-hoc run is
# least likely to terminate.
#
# Contract: PreToolUse hooks receive the tool call as JSON on stdin. Exit 0 to
# allow; exit 2 to BLOCK, with the reason on stderr (the agent reads it).
set -uo pipefail

payload=$(cat)

# `jq` is not guaranteed in the container image; fall back to a bounded grep of
# the raw payload. Extract only the command string so a mention of "bun test" in
# a file being written cannot trigger a false block.
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null) || cmd=''
if [ -z "$cmd" ]; then
  cmd=$(printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -c 4000)
fi
[ -z "$cmd" ] && exit 0

# Test-suite invocations only. Typecheck commands (`tsc`, `pnpm run typecheck`)
# are intentionally NOT matched.
if printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])(bun[[:space:]]+test|vitest|jest)([[:space:]]|$)' \
  || printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])(pnpm|npm|yarn|bun)[[:space:]]+(run[[:space:]]+)?test([[:space:]]|$)'; then
  cat >&2 <<'MSG'
BLOCKED: you may not run the test suites — `report-case` runs them for you.

This is the rule in your case materials ("Do NOT run tests before report-case"),
enforced. It is absolute, and it has no gate-fix exception: on 2026-08-04 a bare
`bun test` on a gate-fix case hung for 40 minutes on the very timing bug it was
meant to reproduce, and froze the pass.

Do this instead:
  - read the failing test and the source it exercises, and diagnose FROM THE CODE;
  - make the fix, then run `report-case` — that is your verification step;
  - if reading the code is not enough to be confident, claim `--tier held` and
    say what you could not determine. Escalating is a valid outcome; an
    ever-widening search is not.

Typechecks are still yours to run (`pnpm run typecheck`, `tsc`).
MSG
  exit 2
fi

exit 0
