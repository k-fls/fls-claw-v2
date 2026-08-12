# Sweep result codes

Every sweep command returns `issues: [{id, detail}]`. Look the id up here: one line per
code, each giving what happened and what you do about it. `ERR*` blocks the command,
`WARN*` never does. The `detail` on the result carries the specifics (which file, which
branch, which output to read) — this list tells you what to DO. If a command's own
`instruction` disagrees with a line here, follow the instruction and say so in your
report. An id that is not listed here: report it to the owner verbatim, with the detail,
and stop.

Three actions recur, and most lines end in one of them. FIX AND RETRY: change the named
thing, run the same command again. REPORT AND STOP: tell the owner the id and the detail,
and do nothing else — retrying or improvising makes it worse. ASK THE OWNER: present the
choice and wait.

ERR01_CASE_NOT_OPEN — the case has no open disposition to publish against: it was never reported, or it already merged. You are working a case that is finished. Run next-case; if that disagrees, REPORT AND STOP.
ERR02_CASE_STALE — git moved since this case was prepared: the resolution landed elsewhere, the conflict healed by itself, or the conflicted files drifted. Nothing here is yours to salvage. Stop working this case and run next-case.
ERR06_DUPLICATE_CASE — another open case or an already-published pull request has the same conflict signature; the detail names the case that owns it. Do not resolve this one twice: consolidate into the named case and take the next one.
ERR07_PR_EXISTS — a pull request is already recorded for this case. Do not write or publish a second one. Take the next case, and mention it in your report.
ERR08_TEXT_MISSING — pr/body.md is missing or empty. Write it, first line `# Title` as a markdown H1 and the body below, then FIX AND RETRY report-pr.
ERR11_TOKEN_MISSING — no GitHub token is present in the environment for networked work. Credentials are not yours to obtain or install. REPORT AND STOP.
ERR12_ORIGIN_UNRESOLVED — the origin remote's URL does not yield an owner/repository. A misconfigured clone. REPORT AND STOP.
ERR13_API_FAILED — a GitHub API call failed (non-2xx or transport error). One retry is legitimate if the instruction says so; if it fails again, REPORT AND STOP.
ERR41_TOKEN_REJECTED — GitHub answered 401/403: the token was REJECTED. The detail names where the token came from, never the token itself. Retrying with the same token can never clear it. REPORT AND STOP.
ERR14_BASE_BEHIND — the base branch on origin is missing, behind the pass, diverged from it, or already contains this merge. Publication order or the remote state is wrong, and neither is yours to correct. REPORT AND STOP.
ERR15_PUSH_FAILED — a `git push` failed. Never hand-push, never retry by another route: publication stays blocked until the infrastructure is fixed. REPORT AND STOP.
ERR16_CLOSURE_FAILED — a merged-history pull request did not flip to merged after its push landed. Nothing is broken in your work; the owner needs to know. REPORT AND STOP.
ERR17_URGE_FAILED — posting the pending-count comment on a blocked branch's pull request failed. Harmless to the pass and retried on a later one; mention it in your report.
ERR18_VERIFY_PENDING — something tried to publish before the full verify was green for the current state. Follow the instruction (it names the stage to run); do not push anything yourself.
ERR20_BRANCH_DIVERGED — a branch has diverged from its counterpart on origin. Never force-resolve a divergence. REPORT AND STOP.
ERR21_MERGE_FAILED — a merge the driver attempted failed outright. This is not a conflict to resolve — it is a halt. REPORT AND STOP.
ERR22_DIRTY_WORKTREE — a worktree holds uncommitted state where the driver requires it clean. Do not commit or stash to clear it; follow the instruction, and REPORT AND STOP if it names no fix.
ERR23_PROTECTED_REF — an operation targeted a ref the sweep must never write. REPORT AND STOP.
ERR24_PLAN_DRIFT — the repository moved underneath the pass, so the plan no longer matches reality. Run next-case; if it repeats, REPORT AND STOP.
ERR25_BAD_CASE_ID — a case identifier is malformed. You never construct one, so this means something upstream of you is wrong. REPORT AND STOP.
ERR30_PASS_OPEN — a previous pass is still open, with merges and possibly published pull requests in flight. Continuing and aborting have different, irreversible consequences. ASK THE OWNER, present both options exactly as the instruction states them, and wait. Never choose.
ERR31_AWAITING_PR — the current case is resolved but still needs its pull-request text. Run report-pr for it before anything else.
ERR32_UNRESOLVED — conflict markers are still present, or nothing changed at all. Either finish resolving the pending files and FIX AND RETRY, or claim `--tier held` on the untouched conflict so the owner gets a clean one.
ERR34_CASES_REMAIN — finish was called while cases are still open (a fix that advanced a branch reopens its descendants, which is expected). Run next-case, work what it serves, then finish again. The same pass still completes.
ERR35_COLDREAD_UNAVAILABLE — the independent reviewer could not RUN: a spawn failure, an authentication failure, or unreadable output. This is tooling, never a judgment on your resolution — your case is not held and not rejected. REPORT AND STOP; the command is re-runnable once the tooling is fixed.
ERR36_TYPECHECK_FAILED — the typecheck gate failed inside your worktree; the detail names the output file. Read it, fix the pending files, and FIX AND RETRY report-case. This costs you no attempt. If you are convinced the failure predates your edit, re-run with `--not-my-bug` IN ADDITION to your `--tier` (never on your first report of a case).
ERR40_TESTS_FAILED — the test gate failed. At report-case: same as the typecheck gate — read the named output, fix, FIX AND RETRY, `--not-my-bug` if it is not yours. At finish: the build is red with no single branch to blame, so nothing was merged or pushed anywhere — REPORT AND STOP, saying plainly that the pass published nothing and naming the failing tests.
ERR37_WORKSPACE_IN_CLONE — the pass was pointed at a workspace inside the clone, which would break the shared conflict-resolution cache. A configuration fault. REPORT AND STOP.
ERR38_PASS_CLEAR_FAILED — the previous pass directory could not be removed, so a new pass cannot safely open. REPORT AND STOP.
ERR39_FETCH_FAILED — `git fetch` failed at start, so the pass would open on a stale view of the remote. REPORT AND STOP.
ERR43_CHECKS_MALFORMED — the checks configuration file does not parse, so the quality gates would silently check nothing. REPORT AND STOP.
ERR44_CASE_LOOPING — this case has been served too many times with no conclusion, and the next serve is refused. You are not going to fix it by looking again. Run report-case --tier held and write the diagnosis you already have: an unfixable case WITH a diagnosis is a valid outcome, an unanswered one is not.
ERR44_WORKTREE_RESET_FAILED — the driver could not reset your worktree to the pristine conflict, so it will not claim to publish one. REPORT AND STOP.
ERR45_CUT_POINTS_MALFORMED — the owner-approved blame-exceptions file does not parse, so blame would be computed from the wrong answers it exists to correct. REPORT AND STOP.
WARN01_TEMPLATE_TEXT — your pull-request body names none of the conflicted files, or reuses stock template phrasing. Rewrite it in your own words, naming the files and what changed. Advisory: it does not block publication, but it means the text is not doing its job.
WARN02_NO_DECISION_LINE — the first line of your body states no ask and no decision. Make that first line say what the reader must decide or know. Advisory.
WARN03_MANY_PRS — this pass produced an unusually large number of pull requests. Say so in your report to the owner.
WARN06_RESOLUTION_TREE_MISSING — the recorded resolution for a held case is gone from the object store, so the pristine conflict is published as a draft instead. Nothing to redo; state it in your report.
WARN07_RESOLUTION_TIP_MOVED — the branch moved after the case was frozen and the frozen resolution no longer merges cleanly, so the pristine conflict is published as a draft instead. State it in your report.
WARN08_CUT_POINT_EXCEPTION_STALE — an owner-approved exception used for blaming red builds no longer matches the repository. Relay it to the owner; only they can update it.
WARN09_GATE_FIX_SERVED — a failing check was proven not to be caused by your resolution, and a fix case was created on the branch that owns it. This is the good outcome of `--not-my-bug`. Run next-case and work it.
WARN11_PRE_MERGE_CHECK_SKIPPED — the pre-merge branch check did not run, so branches merged unverified. Mention it in your report.
WARN12_SCOPE_WIDENED — the failure is owned by this merge rather than by either side, so your allowed files now ALSO include the named ones. Fix the failure there and re-run report-case; the reviewer is told those files were added and why, so this is not a scope violation.
WARN13_DEPS_UNUSABLE — a branch's dependencies would not install, so it could not be checked at all. Report it; a tree with no working environment yields no verdict.
WARN14_ENVIRONMENT_FAULT — the failure is an environment fault (a missing binary, an unresolvable module, a broken native binding), not a code defect. No code change can fix it and no fix case is created. REPORT AND STOP.
WARN15_UPSTREAM_RED — the red is in upstream code, where the sweep cannot commit and a fix would reach nobody. The fork is about to merge a broken upstream commit, which the owner needs to know. REPORT AND STOP.
WARN16_ESCALATION_BASE_BEHIND — a held case shipped as a draft whose diff is wider than the case itself, because the pass could not push first. Explain that in your report so the owner is not surprised by the size of the diff.
WARN17_VERIFY_FLAKY — the full verify gave different answers on repeated runs. Report it; an unstable gate is a defect in its own right.
WARN18_BASE_GATED — the base branch is itself waiting on a fix pull request, so verification was skipped and nothing can land. REPORT AND STOP, naming the pull request the owner must merge.
WARN19_GATE_COVERS_OTHER_DEFECT — the branch is gated by a fix for a DIFFERENT set of failing files, so merging it will not turn this branch green and a second fix will be needed. No case was created. Relay both facts to the owner.
WARN20_ANCESTOR_GATED — the branch descends from an ancestor that took a fix this pass and is still red; nothing below it can pass until that lands. Relay it.
WARN21_CHECKS_FLAKY — a check failed and then passed on the same tree. Follow the instruction; if the case proceeds, say in your report that a gate was unstable.
WARN46_CASE_LOOPING — this case has been served repeatedly with no conclusion, and one more serve will be refused outright. Stop investigating now: claim `--tier held` and write the diagnosis you have.
