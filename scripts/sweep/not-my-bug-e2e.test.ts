/**
 * scripts/sweep/not-my-bug-e2e.test.ts — the not-my-bug deadlock, end to end.
 *
 * This is the deadlock as a repo, walked through the REAL command surface with
 * the REAL checks runner: `makeNotMyBugIncidentFixture` builds the shape that
 * can stall a pass indefinitely — a conflict on
 * `src/cli/resources/groups.ts` blocked by a bun test the case never touched,
 * already red three commits below the branch tip — and the test drives
 * `start → next-case → report-case → report-case --not-my-bug → next-case → …`
 * exactly as the agent would.
 *
 * WHAT IS REAL HERE, and why it matters: the check commands are programs on
 * disk, so the whole chain runs for real — command execution, bun-shaped output,
 * `rootChecksOutput` re-rooting per cwd, `countFailingFiles` parsing, subset
 * filtering, the temp-worktree probes and the bisect over actual commits. Only
 * the cold reader (a `claude -p` subprocess) and the dependency install (a
 * network `pnpm install`) are stubbed. The unit tests script probe outcomes;
 * this one is the check that the pieces agree with each other and with git.
 *
 * It also pins the ordering that makes the mechanism useful at all:
 * `next-case` MUST serve the gate-fix case. Journaling it before the abort's
 * `reopened` row would supersede it the instant it was created — every
 * assertion in the unit tests could pass and the pass still could not move.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeNotMyBugIncidentFixture } from './fixtures.js';
import {
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdSweepReportPr,
  cmdSweepStart,
  openCases,
  passDir,
  readJournal,
  supersededCaseIds,
  type Cli,
  type ColdReadInvoker,
  type InstallRunner,
  type JournalEntry,
} from './propagate.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const confirm: ColdReadInvoker = async () => ({ verdict: 'confirm', notes: 'both sides preserved' });
/** No network install; the fixture's trees declare manifests, so a pool must exist. */
const fakeInstall: InstallRunner = async (dir) => {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  return true;
};

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/**
 * Inventory with a single branchless entry: `sweep start` requires a
 * non-empty, warning-free inventory, and a branchless entry satisfies that
 * while contributing nothing to scope (structural-only fixture).
 */
function branchlessInventory(): string {
  const dir = tmp('nmb-inv-');
  writeFileSync(join(dir, 'planned.seed.yaml'), 'id: planned.seed\nname: planned.seed\nkind: feat\n');
  return dir;
}

/** The real checks contract: a typecheck that passes and the bun-shaped runner. */
function incidentChecksFile(ws: string): string {
  const f = join(ws, 'checks.json');
  writeFileSync(
    f,
    JSON.stringify({
      typecheck: [{ cmd: 'sh tools/typecheck.sh', cwd: '.' }],
      test: [{ cmd: 'sh run-tests.sh', cwd: 'container/agent-runner', filter: 'sh run-tests.sh {files}' }],
    }),
  );
  return f;
}

describe('the not-my-bug deadlock, end to end (real checks, real commits)', () => {
  it('walks conflict -> blocked by someone else’s red -> gate fix -> both cases resolve', async () => {
    const { repo, introducer, failingTest, conflictedPath } = makeNotMyBugIncidentFixture();
    cleanups.push(() => repo.destroy());
    const ws = tmp('nmb-ws-');
    const inv = branchlessInventory();
    const cli = (over: Partial<Cli> = {}): Cli => ({
      // The gate-fix worktree and the case worktree are built deep inside
      // `run`; without this seam they spawn a real pnpm, fail, and the driver
      // (correctly) refuses to serve a case into a tree with no environment.
      installRunner: fakeInstall,
      cmd: 'plan',
      repo: repo.dir,
      workspace: ws,
      inventory: inv,
      scopeFile: join(inv, 'no-scope.yaml'),
      upstream: 'main',
      execute: true,
      ...over,
    });
    const out = join(ws, 'result.json');
    const readResult = <T>(): T => JSON.parse(readFileSync(out, 'utf8')) as T;
    const dirOf = (): string => {
      const j = JSON.parse(readFileSync(join(ws, 'start.json'), 'utf8')) as { watermark12: string };
      return passDir(ws, j.watermark12);
    };

    // ---- start ------------------------------------------------------------
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start', checksFile: incidentChecksFile(ws), out: join(ws, 'start.json') }))).toBe(0);
    const dir = dirOf();

    // ---- next-case: the groups.ts conflict --------------------------------
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case', out }), undefined, fakeInstall)).toBe(0);
    const served = readResult<{ status: string; caseId: string; conflictedPaths: string[]; worktree: string }>();
    expect(served.status).toBe('case-ready');
    expect(served.conflictedPaths).toEqual([conflictedPath]);
    const conflictCaseId = served.caseId;

    // The agent resolves the conflict — correctly, and only in its own file.
    writeFileSync(join(served.worktree, conflictedPath), 'export const createGroup = () => "fork+upstream";\n');

    // ---- report-case #1: blocked by a test it may not touch ---------------
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', out }), confirm, undefined, fakeInstall),
    ).toBe(1);
    const blocked = readResult<{ instruction: string; issues: Array<{ id: string }> }>();
    expect(blocked.issues.some((i) => i.id === 'ERR40_TESTS_FAILED')).toBe(true);
    // The failure is in a file the agent cannot edit — and the ONLY message that
    // tells it a check failed is this one, so the escape hatch is named here.
    expect(blocked.instruction).toContain('--not-my-bug');

    // ---- report-case #2: raise the claim ----------------------------------
    expect(
      await cmdSweepReportCase(
        cli({ cmd: 'report-case', tier: 'judged', notMyBug: true, out }),
        confirm,
        undefined,
        fakeInstall,
      ),
    ).toBe(1);
    const adjudicated = readResult<{
      status: string;
      issues: Array<{ id: string }>;
      introducedBy: { sha: string; subject: string } | null;
      gateFix: { caseId: string; branch: string; files: string[] };
      notMyBug: { verdict: string; owner: string };
    }>();
    expect(adjudicated.status).toBe('gate-fix-required');
    expect(adjudicated.notMyBug.verdict).toBe('pre-existing');
    expect(adjudicated.notMyBug.owner).toBe('branch');
    // A PROCEED arm must never carry an ERR id — an ERR id parks the case.
    expect(adjudicated.issues.every((i) => i.id.startsWith('WARN'))).toBe(true);
    // THE SEARCH FLOOR (owner directive). This gate fix is on `main_patched`
    // ITSELF, so the floor — the current trunk head — IS the branch tip and the
    // window is empty: no commit below it may be named or rooted on, and the
    // search returns without probing rather than paying for an answer that would
    // be refused. `introducer` is P3, below the tip, so it is deliberately NOT
    // reported here.
    //
    // Unfloored, the search can root a case hundreds of commits behind the
    // tip: the worktree becomes a weeks-old tree, the checks gate demands
    // THAT whole suite green, and it may be red in a second unrelated file whose
    // fix has not been written yet — one test in scope, a pre-history demanded green.
    expect(adjudicated.introducedBy).toBeNull();
    expect(adjudicated.gateFix.branch).toBe('main_patched');
    expect(adjudicated.gateFix.files).toEqual([failingTest]);
    // The case is rooted AT THE TIP, so the agent gets current code.
    expect(readJournal(dir).find((e) => e.action === 'gate-fix')!.rootAt).toBe(repo.sha('main_patched'));
    expect(introducer).toBeTruthy(); // fixture sanity: the introducer exists, it is just below the floor

    const afterAbort = readJournal(dir);
    // The conflict case is superseded; the gate fix is NOT (the defect that made
    // the whole mechanism serve nothing), and the discard is recorded.
    expect(supersededCaseIds(afterAbort).has(conflictCaseId)).toBe(true);
    expect(supersededCaseIds(afterAbort).has(adjudicated.gateFix.caseId)).toBe(false);
    const discarded = afterAbort.find((e: JournalEntry) => e.action === 'not-my-bug-discarded')!;
    expect(discarded).toBeTruthy();
    // No local ref survives the abort: a ref is not a delivery channel.
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/sweep/')).toBe('');
    // Nothing merged: the branch tip is untouched by the aborted case.
    expect(repo.git('show', `main_patched:${conflictedPath}`)).toContain('"fork"');

    // ---- next-case: it must SERVE the gate fix ----------------------------
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case', out }), undefined, fakeInstall)).toBe(0);
    const gateServed = readResult<{ status: string; caseId: string; conflictedPaths: string[]; worktree: string }>();
    expect(gateServed.status).toBe('case-ready');
    expect(gateServed.caseId).toBe(adjudicated.gateFix.caseId);
    // The failing file IS the edit scope now — the thing the conflict case could
    // not do, and the whole reason the pass deadlocked.
    expect(gateServed.conflictedPaths).toEqual([failingTest]);

    // ---- the agent fixes the test, in scope --------------------------------
    writeFileSync(join(gateServed.worktree, failingTest), 'test("task-run turn wiring", () => ok);\n');
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', out }), confirm, undefined, fakeInstall),
    ).toBe(0);
    const fixed = readResult<{ tier: string; instruction: string }>();
    expect(fixed.tier).toBe('judged');
    const gateJournal = readJournal(dir);
    expect(gateJournal.some((e) => e.action === 'checks-pass' && e.caseId === gateServed.caseId)).toBe(true);
    expect(gateJournal.some((e) => e.action === 'coldread' && e.caseId === gateServed.caseId)).toBe(true);

    // ---- report-pr lands the gate fix on the branch ------------------------
    mkdirSync(join(dir, gateServed.caseId, 'pr'), { recursive: true });
    writeFileSync(
      join(dir, gateServed.caseId, 'pr', 'body.md'),
      `# fix(tests): restore the task-run turn wiring test\n\nBroken by ${introducer.slice(0, 12)}.\n`,
    );
    expect(await cmdSweepReportPr(cli({ cmd: 'report-pr', out }))).toBe(0);
    // The branch is green again, at the tip, where every descendant inherits it.
    expect(repo.git('show', `main_patched:${failingTest}`)).toContain('ok');

    // ---- next-case re-derives the conflict, and it now passes the gate -----
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case', out }), undefined, fakeInstall)).toBe(0);
    const reserved = readResult<{ status: string; caseId: string; conflictedPaths: string[]; worktree: string }>();
    expect(reserved.status).toBe('case-ready');
    expect(reserved.conflictedPaths).toEqual([conflictedPath]);
    writeFileSync(join(reserved.worktree, conflictedPath), 'export const createGroup = () => "fork+upstream";\n');
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', out }), confirm, undefined, fakeInstall),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'checks-pass' && e.caseId === reserved.caseId)).toBe(true);

    // ---- and the conflict lands ------------------------------------------
    mkdirSync(join(dir, reserved.caseId, 'pr'), { recursive: true });
    writeFileSync(
      join(dir, reserved.caseId, 'pr', 'body.md'),
      '# merge: groups create keeps the fork transaction\n\nBoth sides preserved.\n',
    );
    expect(await cmdSweepReportPr(cli({ cmd: 'report-pr', out }))).toBe(0);
    expect(repo.git('show', `main_patched:${conflictedPath}`)).toContain('fork+upstream');
    // Nothing left open: the red that blocked the pass is fixed on the branch,
    // and the conflict it was blocking is resolved.
    expect(openCases(readJournal(dir))).toEqual([]);
  });

  it('a regression the case DID cause is refused, named, and mints no gate-fix case', async () => {
    const { repo, failingTest, conflictedPath } = makeNotMyBugIncidentFixture();
    cleanups.push(() => repo.destroy());
    // Start from a branch whose test is GREEN, so the only red is what the agent
    // is about to write — the mirror image of the case above.
    repo.checkout('main_patched');
    repo.commit('fix(tests): restore the task-run turn wiring test', {
      [failingTest]: 'test("task-run turn wiring", () => ok);\n',
    });
    const ws = tmp('nmb-ws-');
    const inv = branchlessInventory();
    const cli = (over: Partial<Cli> = {}): Cli => ({
      // The gate-fix worktree and the case worktree are built deep inside
      // `run`; without this seam they spawn a real pnpm, fail, and the driver
      // (correctly) refuses to serve a case into a tree with no environment.
      installRunner: fakeInstall,
      cmd: 'plan',
      repo: repo.dir,
      workspace: ws,
      inventory: inv,
      scopeFile: join(inv, 'no-scope.yaml'),
      upstream: 'main',
      execute: true,
      ...over,
    });
    const out = join(ws, 'result.json');
    expect(
      await cmdSweepStart(cli({ cmd: 'sweep-start', checksFile: incidentChecksFile(ws), out: join(ws, 'start.json') })),
    ).toBe(0);
    const { watermark12 } = JSON.parse(readFileSync(join(ws, 'start.json'), 'utf8')) as { watermark12: string };
    const dir = passDir(ws, watermark12);

    expect(await cmdSweepNextCase(cli({ cmd: 'next-case', out }), undefined, fakeInstall)).toBe(0);
    const served = JSON.parse(readFileSync(out, 'utf8')) as { caseId: string; worktree: string };

    // Resolve the conflict AND break the shared test while doing it — the exact
    // shape a "not my bug" claim must not be able to launder.
    writeFileSync(join(served.worktree, conflictedPath), 'export const createGroup = () => "fork+upstream";\n');
    writeFileSync(join(served.worktree, failingTest), 'test("task-run turn wiring", () => BROKEN);\n');

    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', out }), confirm, undefined, fakeInstall),
    ).toBe(1);
    expect(
      await cmdSweepReportCase(
        cli({ cmd: 'report-case', tier: 'judged', notMyBug: true, out }),
        confirm,
        undefined,
        fakeInstall,
      ),
    ).toBe(1);
    const refused = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('caused-by-case');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(supersededCaseIds(journal).has(served.caseId)).toBe(false);
    expect(refused.instruction).toContain('These failures are YOURS');
    expect(refused.instruction).toContain(failingTest);
  });
});
