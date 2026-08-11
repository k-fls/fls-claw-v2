/**
 * scripts/sweep/not-my-bug-e2e.test.ts — the 2026-08-01 deadlock, end to end.
 *
 * This is the incident as a repo, walked through the REAL command surface with
 * the REAL checks runner: `makeNotMyBugIncidentFixture` builds the same shape
 * that stalled pass `87175bdb89ad` for three days — a conflict on
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
 * It also pins the defect that made the first cut of this mechanism useless:
 * `next-case` MUST serve the gate-fix case. Journaling it before the abort's
 * `reopened` row superseded it the instant it was created — every assertion in
 * the unit tests passed and the pass still could not move.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, makeNotMyBugIncidentFixture, type FixtureRepo } from './fixtures.js';
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

describe('the 2026-08-01 deadlock, end to end (real checks, real commits)', () => {
  it('walks conflict -> blocked by someone else’s red -> gate fix -> both cases resolve', async () => {
    const { repo, introducer, failingTest, conflictedPath } = makeNotMyBugIncidentFixture();
    cleanups.push(() => repo.destroy());
    const ws = tmp('nmb-ws-');
    const inv = tmp('nmb-inv-');
    const cli = (over: Partial<Cli> = {}): Cli => ({
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
    // A PROCEED arm must never carry an ERR id (the ERR42 defect, 52 idle minutes).
    expect(adjudicated.issues.every((i) => i.id.startsWith('WARN'))).toBe(true);
    // THE SEARCH FLOOR (owner, 2026-08-04). This gate fix is on `main_patched`
    // ITSELF, so the floor — the current trunk head — IS the branch tip and the
    // window is empty: no commit below it may be named or rooted on, and the
    // search returns without probing rather than paying for an answer that would
    // be refused. `introducer` is P3, below the tip, so it is deliberately NOT
    // reported here.
    //
    // Live 2026-08-04 the unfloored version rooted a case 299 commits behind the
    // tip: the worktree became a three-week-old tree, the checks gate demanded
    // THAT whole suite green, and it was red in a second unrelated file whose fix
    // had not been written yet — one test in scope, a pre-history demanded green.
    expect(adjudicated.introducedBy).toBeNull();
    expect(adjudicated.gateFix.branch).toBe('main_patched');
    expect(adjudicated.gateFix.files).toEqual([failingTest]);
    // The case is rooted AT THE TIP, so the agent gets current code.
    expect(readJournal(dir).find((e) => e.action === 'gate-fix')!.rootAt).toBe(repo.sha('main_patched'));
    expect(introducer).toBeTruthy(); // fixture sanity: the introducer exists, it is just below the floor

    const afterAbort = readJournal(dir);
    // The conflict case is superseded; the gate fix is NOT (the defect that made
    // the whole mechanism serve nothing), and the agent's work is pinned.
    expect(supersededCaseIds(afterAbort).has(conflictCaseId)).toBe(true);
    expect(supersededCaseIds(afterAbort).has(adjudicated.gateFix.caseId)).toBe(false);
    const preserved = afterAbort.find((e: JournalEntry) => e.action === 'not-my-bug-preserved')!;
    expect(repo.git('rev-parse', '--verify', `${preserved.ref as string}^{tree}`)).toBe(preserved.tree);
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
    // and the conflict it was blocking is resolved. This is the run that stalled
    // for three days on 2026-08-01.
    expect(openCases(readJournal(dir))).toEqual([]);
  });

  it('a multi-owner failure set is PARTITIONED: the owned file mints, the interaction remainder is reported, and neither leaks into the other (5bfdf9af0869)', async () => {
    // The live 2026-08-10 shape: several proven-pre-existing failures, of which
    // the ownership probe attributes only a SUBSET to a branch. Pre-fix the
    // remainder was folded into the one minted case — files on a branch the
    // probes had just shown does NOT own them — and the agent could only answer
    // with a prose diagnosis (PR #81).
    const { repo, failingTest, conflictedPath, interactionTest } = makeNotMyBugIncidentFixture({ interaction: true });
    cleanups.push(() => repo.destroy());
    const ws = tmp('nmb-ws-');
    const inv = tmp('nmb-inv-');
    const cli = (over: Partial<Cli> = {}): Cli => ({
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
    writeFileSync(join(served.worktree, conflictedPath), 'export const createGroup = () => "fork+upstream";\n');

    // #1 reports the failure; #2 raises the claim. BOTH tests are red in the
    // worktree (the merged tree holds both markers), and both are pre-existing.
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
    const adjudicated = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      instruction: string;
      gateFix: { caseId: string; branch: string; files: string[] };
      notMyBug: { verdict: string; owner: string; files: string[] };
    };
    expect(adjudicated.status).toBe('gate-fix-required');
    expect(adjudicated.notMyBug.verdict).toBe('pre-existing');
    // BOTH files were adjudicated...
    expect(adjudicated.notMyBug.files.sort()).toEqual([interactionTest, failingTest].sort());
    // ...but the minted case carries ONLY the file the branch was proven to
    // own. Pre-fix this array held both files (the output re-parse), which is
    // the mis-attribution this test pins.
    expect(adjudicated.gateFix.branch).toBe('main_patched');
    expect(adjudicated.gateFix.files).toEqual([failingTest]);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'gate-fix')!.files).toEqual([failingTest]);
    // The remainder is on the record and in the agent's mouth — not dropped.
    const rem = journal.find((e) => e.action === 'not-my-bug-remainder')!;
    expect(rem).toBeTruthy();
    expect(rem.files).toEqual([interactionTest]);
    expect(rem.disposition).toBe('interaction');
    expect(adjudicated.instruction).toContain('NOT covered by any gate fix');
    expect(adjudicated.instruction).toContain(interactionTest);
  });

  /**
   * DEFECT 2 (2026-08-10, PR #81): a gate-fix agent claiming `--tier held`
   * because "the fix belongs upstream" used to freeze a PROSE diagnosis the
   * owner had to re-verify by hand — while a one-probe question ("is it already
   * red at the parent head?") settles the claim mechanically. Proven claims now
   * become a case at the owner; only disproven/unprovable ones freeze.
   *
   *   main             base: check-broken.sh green; src/shared.ts orig
   *   main_patched     [trunk variant] BREAKS src/broken.ts, then edits shared.ts
   *   module/cg        branches from main_patched, [branch variant] BREAKS
   *                    src/broken.ts itself; edits shared.ts (the conflict)
   *
   * Both variants walk: conflict case on module/cg -> checks red on
   * src/broken.ts -> --not-my-bug -> gate fix on module/cg (its tip IS red) ->
   * agent claims --tier held. They diverge exactly at the parent-head probe.
   */
  function heldRouteFixture(brokenOn: 'trunk' | 'branch'): { repo: FixtureRepo } {
    const repo = initFixtureRepo();
    repo.commit('base: shared surface + check script', {
      'check-broken.sh':
        '#!/bin/sh\nif grep -q BROKEN src/broken.ts 2>/dev/null; then\n  echo "src/broken.ts(1,1): error TS2345: broken by design"\n  exit 1\nfi\nexit 0\n',
      'src/broken.ts': 'export const fine = true;\n',
      'src/shared.ts': 'orig\n',
    });
    repo.checkout('main_patched', { create: true, at: 'main' });
    if (brokenOn === 'trunk') repo.commit('trunk: break the check', { 'src/broken.ts': 'BROKEN\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    if (brokenOn === 'branch') repo.commit('cg: break the check', { 'src/broken.ts': 'BROKEN\n' });
    repo.commit('cg: edit shared', { 'src/shared.ts': 'cg\n' });
    repo.checkout('main_patched');
    repo.commit('mp: edit shared', { 'src/shared.ts': 'mp\n' }); // the conflict for module/cg's case
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    return { repo };
  }
  function heldRouteHarness(brokenOn: 'trunk' | 'branch'): {
    repo: FixtureRepo;
    cli: (over?: Partial<Cli>) => Cli;
    out: string;
    dirOf: () => string;
  } {
    const { repo } = heldRouteFixture(brokenOn);
    cleanups.push(() => repo.destroy());
    const ws = tmp('nmb-ws-');
    const inv = tmp('nmb-inv-');
    writeFileSync(
      join(inv, 'cg.yaml'),
      ['id: cg', 'name: cg', 'kind: feat', 'status: shipped', 'branch: module/cg', 'parents:', '  - main_patched'].join('\n') + '\n',
    );
    const checks = join(ws, 'checks.json');
    writeFileSync(
      checks,
      JSON.stringify({ typecheck: [], test: [{ cmd: 'sh check-broken.sh', cwd: '.', filter: 'sh check-broken.sh {files}' }] }),
    );
    const out = join(ws, 'result.json');
    const cli = (over: Partial<Cli> = {}): Cli => ({
      cmd: 'plan',
      repo: repo.dir,
      workspace: ws,
      inventory: inv,
      scopeFile: join(inv, 'no-scope.yaml'),
      upstream: 'main',
      execute: true,
      checksFile: checks,
      ...over,
    });
    const dirOf = (): string => {
      const j = JSON.parse(readFileSync(join(ws, 'start.json'), 'utf8')) as { watermark12: string };
      return passDir(ws, j.watermark12);
    };
    return { repo, cli, out, dirOf };
  }
  /** start -> conflict case -> red checks -> --not-my-bug -> gate fix on module/cg -> serve it. */
  async function serveCgGateFix(h: ReturnType<typeof heldRouteHarness>): Promise<string> {
    const { cli, out } = h;
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start', out: join(out, '..', 'start.json') }))).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case', out }), undefined, fakeInstall)).toBe(0);
    const served = JSON.parse(readFileSync(out, 'utf8')) as { caseId: string; worktree: string; branch: string };
    writeFileSync(join(served.worktree, 'src/shared.ts'), 'MERGED\n');
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', out }), confirm, undefined, fakeInstall),
    ).toBe(1); // red on src/broken.ts — a file the case never touched
    expect(
      await cmdSweepReportCase(
        cli({ cmd: 'report-case', tier: 'judged', notMyBug: true, out }),
        confirm,
        undefined,
        fakeInstall,
      ),
    ).toBe(1);
    const adjudicated = JSON.parse(readFileSync(out, 'utf8')) as { status: string; gateFix: { caseId: string; branch: string } };
    expect(adjudicated.status).toBe('gate-fix-required');
    expect(adjudicated.gateFix.branch).toBe('module/cg'); // the tip is red, so the branch owns it — so far
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case', out }), undefined, fakeInstall)).toBe(0);
    const gateServed = JSON.parse(readFileSync(out, 'utf8')) as { status: string; caseId: string };
    expect(gateServed.status).toBe('case-ready');
    expect(gateServed.caseId).toBe(adjudicated.gateFix.caseId);
    return gateServed.caseId;
  }

  it('held gate fix, defect red at the parent head: the claim is PROVEN and re-minted at the owner, not frozen as prose', async () => {
    const h = heldRouteHarness('trunk');
    const cgCaseId = await serveCgGateFix(h);
    const dir = h.dirOf();

    // The agent gives up in scope and claims held — the PR #81 move.
    expect(
      await cmdSweepReportCase(h.cli({ cmd: 'report-case', tier: 'held', out: h.out }), confirm, undefined, fakeInstall),
    ).toBe(1);
    const routed = JSON.parse(readFileSync(h.out, 'utf8')) as {
      status: string;
      instruction: string;
      gateFix: { caseId: string; branch: string; files: string[] };
    };
    // Pre-fix: tier 'held', a frozen prose PR, and no new case. Post-fix: the
    // probe found src/broken.ts already red at main_patched's head, so the fix
    // is re-minted THERE and this case is superseded.
    expect(routed.status).toBe('gate-fix-required');
    expect(routed.gateFix.branch).toBe('main_patched');
    expect(routed.gateFix.files).toEqual(['src/broken.ts']);
    const journal = readJournal(dir);
    const ownerRow = journal.find((e) => e.action === 'gate-fix-owner' && e.owner === 'main_patched')!;
    expect(ownerRow).toBeTruthy();
    expect(ownerRow.files).toEqual(['src/broken.ts']);
    expect(journal.some((e) => e.action === 'gate-fix' && e.branch === 'main_patched')).toBe(true);
    // No prose freeze happened for the routed case, and it is out of the way.
    expect(journal.some((e) => e.action === 'held' && e.caseId === cgCaseId)).toBe(false);
    expect(supersededCaseIds(journal).has(cgCaseId)).toBe(true);

    // The trunk case is servable — the recursion moved strictly UP and the
    // machinery can hand it to an agent that can actually land the fix.
    expect(await cmdSweepNextCase(h.cli({ cmd: 'next-case', out: h.out }), undefined, fakeInstall)).toBe(0);
    const next = JSON.parse(readFileSync(h.out, 'utf8')) as { status: string; caseId: string };
    expect(next.status).toBe('case-ready');
    expect(next.caseId).toMatch(/^gate-fix-main_patched-/);
  });

  it('held gate fix, parent head GREEN: nobody upstream owns it — the recursion stops and the held diagnosis stands, carrying the disproof', async () => {
    const h = heldRouteHarness('branch');
    const cgCaseId = await serveCgGateFix(h);
    const dir = h.dirOf();

    expect(
      await cmdSweepReportCase(h.cli({ cmd: 'report-case', tier: 'held', out: h.out }), confirm, undefined, fakeInstall),
    ).toBe(0);
    const held = JSON.parse(readFileSync(h.out, 'utf8')) as { tier: string; instruction: string };
    expect(held.tier).toBe('held');
    // The freeze happened, as before this change...
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.caseId === cgCaseId)).toBe(true);
    // ...but it now carries the probe's ANSWER instead of only the agent's
    // belief, and no case was minted on the innocent parent.
    expect(held.instruction).toContain('nobody upstream owns this');
    const selfRow = journal.find((e) => e.action === 'gate-fix-owner' && e.owner === 'self')!;
    expect(selfRow).toBeTruthy();
    expect(selfRow.files).toEqual(['src/broken.ts']);
    expect(journal.some((e) => e.action === 'gate-fix' && e.branch === 'main_patched')).toBe(false);
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
    const inv = tmp('nmb-inv-');
    const cli = (over: Partial<Cli> = {}): Cli => ({
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
