# Tool result IDs — one line each, greppable

`ERR*` blocks, `WARN*` advises. Do what the line says — never argue with or work
around a blocking id.

**Look one up with a single grep, from anywhere:**

```bash
grep -F '<THE_ID_FROM_THE_RESULT>' /workspace/agent/ERRORS.md
```

Every id's full guidance is on ONE line, so that grep returns everything you need
and nothing else. An id with more than one arm has one line per arm and the same
grep returns both — read both and pick the one the driver's `detail` names. Never
act on an id you have not grepped: the line is the contract, the message in the
result is only the instance.

No id appears in this prose on purpose — every literal id below is a real row, so
a grep never returns documentation about grepping.

ERR01_CASE_NOT_OPEN :: run `report-case` first; mechanical gets no PR
ERR02_CASE_STALE :: re-run `next-case`; work from the fresh case
ERR05_DECIDED_ALREADY :: apply the quoted record as a judged resolution; don't ask the owner
ERR06_DUPLICATE_CASE :: resolve the named topmost case; this one inherits it
ERR07_PR_EXISTS :: work with the existing PR; never open a second
ERR08_TEXT_MISSING :: write `pr/title.txt` + `pr/body.md` from the case materials — how to write them: /workspace/agent/PR-DESCRIPTIONS.md
ERR11_TOKEN_MISSING :: write the `get_credential` output to a file, pass `--token-file <path>`
ERR12_ORIGIN_UNRESOLVED :: point the clone's origin at a github.com URL; report if you cannot
ERR13_API_FAILED :: retry once; still failing → stop-case 2 report
ERR14_BASE_BEHIND :: unclear → report to the owner
ERR15_PUSH_FAILED :: per-branch, NOT a stop: report landed-vs-failed, re-run `finish`; a DIVERGED branch needs the owner. No hand-push, ever
ERR16_CLOSURE_FAILED :: investigate, report; publish nothing more until understood
ERR17_URGE_FAILED :: retries next `finish`; recurring → stop-case 2 report
ERR18_VERIFY_PENDING [offender rolled back + HELD] :: re-run `finish` — the frozen offender drops out of the publishable set, so the re-run has a DIFFERENT input; if the driver serves a GATE-FIX case, resolve it like any other case
ERR18_VERIFY_PENDING [no clean attribution] :: do NOT re-run — same refs, same exceptions file, same result. Investigate the named cause, FIX it, and only then re-run. Cannot be fixed from inside the pass (e.g. a stale cut-point exception) → stop-case 2 report to the owner. Live 2026-07-29: re-running on this variant cost a second full `finish` and reproduced the identical block
ERR20_BRANCH_DIVERGED :: owner escalation; never force-resolve (no reset, no force-push)
ERR21_MERGE_FAILED :: note it in the end-of-sweep result; file a driver issue if it recurs
ERR22_DIRTY_WORKTREE :: clean/commit the named worktree, re-run; never `reset --hard` someone else's work
ERR24_PLAN_DRIFT :: investigate what moved; report before continuing
ERR26_RESOLVE_NOT_CONVERGED :: auto-escalated to HELD → stop re-resolving, take the next case
ERR30_PASS_OPEN :: `finish` or `abort` first
ERR31_AWAITING_PR :: `report-pr` first
ERR32_UNRESOLVED :: resolve the remaining markers, re-run `report-case`
ERR33_BRANCH_TESTS_FAILED :: open the named log, fix the resolution, re-report
ERR34_CASES_REMAIN :: finish every case first
ERR35_COLDREAD_UNAVAILABLE :: stop-case 2 report; the case stays put — re-run once restored
ERR36_TYPECHECK_FAILED :: open the named output file, fix the pending files, re-run `report-case`
ERR39_FETCH_FAILED :: fix connectivity/creds, re-run `start`; never open a pass on a stale view
ERR40_TESTS_FAILED :: same as ERR36; at `finish` it is a stop-case 2 report (publish nothing)
ERR41_TOKEN_REJECTED :: the GitHub token was REJECTED — re-auth; a retry with the same token cannot clear it
ERR42_BASE_RED :: the base was already broken BEFORE any merge — stop-case 2 report naming the branch and failing checks; the pass is already sealed, so do NOT run `abort`
ERR43_CHECKS_MALFORMED :: the named checks file does not PARSE, so no gate can run — stop-case 2 report quoting the file and the parse error; never continue with the gates silently skipped
ERR44_WORKTREE_RESET_FAILED :: the worktree could not be reset to the pristine conflict and still holds your edits — clear it in-container and re-run `report-case`; never call it pristine
ERR45_CUT_POINTS_MALFORMED :: the cut-point exceptions file does not PARSE, so blame cannot be trusted and no gate-fix case is served — stop-case 2 report quoting the file and the parse error
ERR46_COLDREAD_UNGROUNDED :: the cold read REJECTED but its feedback names nothing you can act on (no path from the resolution diff, no failed question). The VERDICT is refused, not your resolution — no strike was spent. Re-run the cold read; if it comes back ungrounded again, stop-case 2 report rather than guessing what it meant
WARN01_TEMPLATE_TEXT :: rewrite the body from the case materials
WARN02_NO_DECISION_LINE :: open the body with the exact decision the owner is asked to make
WARN03_MANY_PRS :: >8 PRs this pass — re-check for consolidation
WARN05_STALE_VERDICT_CLEARED :: a cold-read verdict attesting a DIFFERENT tree was retired; produce a fresh verdict for the tree you actually resolved
WARN08_CUT_POINT_EXCEPTION_STALE :: a cut-point exception no longer holds against the current refs, so it was NOT applied and blame may be wrong — do not re-run blindly; report the stale entry to the owner
