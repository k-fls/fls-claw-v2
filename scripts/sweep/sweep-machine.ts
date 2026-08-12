/**
 * scripts/sweep/sweep-machine.ts — the AGENT-FACING sweep CLI
 * (DRIVER.md §1). Six commands, driven by a resumable machine-state
 * record in the pass dir; the agent passes ZERO identifying params (no --case,
 * no --resolved-ref, no --branch) — the driver holds the watermark, the current
 * case, the phase and the journal.
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/sweep-machine.ts <start|next-case|report-case|report-pr|finish|abort> [flags]
 *
 * Commands (do what each RETURNS; never pass ids):
 *   start                         fetch origin/upstream, derive the blocked set from the origin
 *                                 fix/sweep refs, then open a pass and pin the watermark
 *                                 (refuses an open pass — finish/abort first). Resolves + persists
 *                                 the inventory + checks-file; later commands read them from
 *                                 state. Optional start-only flags: --inventory <dir> (default
 *                                 ../inventory), --checks-file <path> (default scripts/sweep/checks.json)
 *   next-case                     advance the deterministic machinery; returns {status:"case-ready",…}
 *                                 (worktree/branch/conflictedPaths/materials) or {status:"finalize"}
 *   report-case --tier T          T ∈ mechanical|judged|held — the SINGLE quality gate: checks
 *              [--not-my-bug]     (typecheck THEN tests) then the cold read (mechanical → merge;
 *                                 judged/held → provide PR description).
 *                                 `--not-my-bug` is ADDITIONAL to the tier, never instead of it: the
 *                                 tier classifies your EDIT, the flag classifies the DRIVER'S TEST
 *                                 REPORT. Raise it when a reported failure is not caused by your
 *                                 resolution; the driver PROVES or DISPROVES it against the tree
 *                                 without your changes, then either aborts the merge and prepares a
 *                                 gate-fix case on the branch that owns it (naming the commit that
 *                                 introduced it), widens your edit scope when the merge itself is at
 *                                 fault, or tells you which failures are yours. No effect on the
 *                                 FIRST report-case — nothing has been reported to you yet.
 *   report-pr                     PR AUTHORING ONLY — reads pr/body.md (first line is the H1 title,
 *                                 `# <title>`; rest is the body), records PR intent, PUBLISHES NOTHING
 *                                 (every PR is created at finish). No cold read, no tests.
 *   finish                        verify (runs checks.test — tests red → STOP, publish nothing) → JUDGED
 *                                 PRs → push targets → urges → HELD PRs → owner report → start-again/done
 *   abort                         discard the open pass cleanly (rolls mutated branches back to pre-ref)
 *
 * Execute is the DEFAULT; --dry-run computes without writing. The substitute
 * GitHub token comes from the environment (GH_TOKEN, fallback GITHUB_TOKEN) at
 * each networked write — the agent manages no token file. The cold read
 * is a real `claude -p` subprocess. All the deterministic internals are the
 * `propagate` driver's — this file only wraps them as the six-command surface.
 */
import {
  cmdSweepAbort,
  cmdSweepFinish,
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdSweepReportPr,
  cmdSweepStart,
  parseCli,
  type Cli,
} from './propagate.js';

const SUBCOMMANDS: Record<string, (cli: Cli) => Promise<number>> = {
  start: (cli) => cmdSweepStart({ ...cli, cmd: 'sweep-start' }),
  'next-case': (cli) => cmdSweepNextCase({ ...cli, cmd: 'next-case' }),
  'report-case': (cli) => cmdSweepReportCase({ ...cli, cmd: 'report-case' }),
  'report-pr': (cli) => cmdSweepReportPr({ ...cli, cmd: 'report-pr' }),
  finish: (cli) => cmdSweepFinish({ ...cli, cmd: 'sweep-finish' }),
  abort: (cli) => cmdSweepAbort({ ...cli, cmd: 'sweep-abort' }),
};

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/sweep-machine.ts <start|next-case|report-case|report-pr|finish|abort> [--repo <path>] [--workspace <dir>] [--inventory <dir>] [--checks-file <path>] [--tier <t>] [--not-my-bug] [--dry-run] [--out <file>]';

const invokedDirectly = process.argv[1] && /sweep-machine\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const cli = parseCli(process.argv.slice(2));
  const handler = SUBCOMMANDS[cli.cmd];
  if (!handler) {
    console.error(`Unknown sweep command '${cli.cmd}'\n${USAGE}`);
    process.exit(2);
  }
  handler(cli).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      process.exit(1);
    },
  );
}

export { SUBCOMMANDS };
