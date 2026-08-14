import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { addTempWorktree, commitInfo, gitPush, isAncestor } from './git.js';
import { exportRrCache, writeRrCacheDir } from './merge.js';
import {
  createCaseWorktree,
  DriverHalt,
  failureSummary,
  firstRedParticipant,
  guardRef,
  type InstallRunner,
} from './propagate.js';
import {
  appendJournal,
  cmdPlan,
  cmdPublish,
  cmdPush,
  cmdReport,
  cmdRun,
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdSweepStart,
  cmdVerify,
  coldReadWithRetry,
  conflictHunks,
  openCases,
  passDir,
  publishableRecipe,
  readJournal,
  supersededCaseIds,
  type Cli,
  type ColdReadInvoker,
  type JournalEntry,
  type MachineVerdict,
} from './propagate.js';
import type { GithubTransport } from './publish.js';
import { verifyEverything } from './verify.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'prop-ws-'));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

function writeInventory(
  entries: Array<{
    id: string;
    branch?: string;
    kind?: string;
    parents?: string[];
    scope_guard?: string;
    summary?: string;
    owned_paths?: string[];
  }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'prop-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      `kind: ${e.kind ?? 'feat'}`,
      ...(e.branch ? [`branch: ${e.branch}`] : []),
      ...(e.summary ? [`summary: ${JSON.stringify(e.summary)}`] : []),
      ...(e.scope_guard ? [`scope_guard: ${e.scope_guard}`] : []),
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
      ...(e.owned_paths ? ['owned_paths:', ...e.owned_paths.map((p) => `  - ${JSON.stringify(p)}`)] : []),
    ].join('\n');
    writeFileSync(join(dir, `${e.id}.yaml`), yaml + '\n');
  }
  return dir;
}

/**
 * Inventory with a single branchless entry: `sweep start` requires a
 * non-empty, warning-free inventory, and a branchless entry satisfies that
 * while contributing nothing to scope (structural-only fixtures).
 */
function branchlessInventory(): string {
  return writeInventory([{ id: 'planned.seed' }]);
}

/** routing.yaml carrying just the global scope-guard mode lever. */
function writeRouting(mode: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'prop-rt-')), 'routing.yaml');
  cleanups.push(() => rmSync(join(f, '..'), { recursive: true, force: true }));
  writeFileSync(f, `scope_guard_mode: ${mode}\n`);
  return f;
}

function baseCli(repo: FixtureRepo, ws: string, inv: string | null, over: Partial<Cli> = {}): Cli {
  return {
    cmd: 'plan',
    repo: repo.dir,
    workspace: ws,
    inventory: inv ?? undefined,
    scopeFile: join(inv ?? ws, 'no-scope.yaml'), // non-existent -> empty scope
    upstream: 'main',
    execute: false,
    ...over,
  };
}

/**
 * main_patched (x=fork) vs a trunk with a clean prefix then a PERSISTENT
 * conflict: U0 is clean (util), U1 diverges x and stays conflicting above the
 * merge point (like the real role-grant profile) — so the case survives the
 * clean-prefix merge and resolve has a real conflict to re-verify.
 */
function conflictFixture(): { repo: FixtureRepo } {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // height 0 (clean into mp)
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }); // height 1 (persistent x conflict)
  cleanups.push(() => repo.destroy());
  return { repo };
}

// --- §7 trust boundary: case.json is a POINTER, re-derived from git+registry ---
// Reached through the one resolution surface (`report-case`): a forged
// case.json fails re-derivation and report-case refuses with ERR02_CASE_STALE
// rather than journaling a halt row.

function machineState(dir: string): { phase: string; currentCase: { caseId: string; tier?: string } | null } {
  return JSON.parse(readFileSync(join(dir, 'machine-state.json'), 'utf8')) as {
    phase: string;
    currentCase: { caseId: string; tier?: string } | null;
  };
}
function currentCaseId(dir: string): string {
  return machineState(dir).currentCase!.caseId;
}
/** The agent's edit: write files into the case worktree `next-case` handed over. */
function resolveWorktree(dir: string, caseId: string, files: Record<string, string>): void {
  const wt = join(dir, caseId, 'worktree');
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(wt, p, '..'), { recursive: true });
    writeFileSync(join(wt, p), content);
  }
}
function readCase(dir: string, caseId: string): { automergeTree: string; conflictedPaths: string[] } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as {
    automergeTree: string;
    conflictedPaths: string[];
  } & Record<string, unknown>;
}
function editCase(dir: string, caseId: string, mut: (c: Record<string, unknown>) => void): void {
  const path = join(dir, caseId, 'case.json');
  const c = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mut(c);
  writeFileSync(path, JSON.stringify(c, null, 2));
}

const confirm: ColdReadInvoker = async () => ({
  verdict: 'confirm',
  notes: 'behaviour preserved; every hunk explained',
});

describe('report-case — case re-verification rejects forged pointers (§7, FIX A)', () => {
  async function setupCase(): Promise<{ repo: FixtureRepo; ws: string; inv: string; dir: string; caseId: string }> {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    return { repo, ws, inv, dir, caseId: currentCaseId(dir) };
  }
  /** Resolve in the worktree, then report — the surviving resolution path. */
  async function reportWith(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    dir: string,
    caseId: string,
    out?: string,
  ): Promise<number> {
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    return cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
      confirm,
    );
  }
  const issuesOf = (out: string): Array<{ id: string; detail: string }> =>
    (JSON.parse(readFileSync(out, 'utf8')) as { issues?: Array<{ id: string; detail: string }> }).issues ?? [];
  const staleIds = (out: string): string[] => issuesOf(out).map((i) => i.id);
  /** report-case surfaces each reverify error verbatim as an ERR02 detail. */
  const staleDetails = (out: string): string[] => issuesOf(out).map((i) => i.detail);

  it('rejects a forged head sha', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    const tip = repo.sha('main_patched');
    editCase(dir, caseId, (c) => {
      (c.head as { sha: string }).sha = '0'.repeat(40);
    });
    const out = join(ws, 'rc.json');
    expect(await reportWith(repo, ws, inv, dir, caseId, out)).toBe(1);
    expect(staleIds(out)).toContain('ERR02_CASE_STALE');
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
    expect(repo.sha('main_patched')).toBe(tip); // nothing merged on a forged pointer
  });

  it('rejects forged conflicted paths (extra file allowed)', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    editCase(dir, caseId, (c) => {
      (c.conflictedPaths as string[]).push('src/anything.ts');
    });
    const out = join(ws, 'rc.json');
    expect(await reportWith(repo, ws, inv, dir, caseId, out)).toBe(1);
    expect(staleIds(out)).toContain('ERR02_CASE_STALE');
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
  });

  it('rejects a forged tier floor', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    editCase(dir, caseId, (c) => {
      c.tierFloor = 'judged';
    });
    const out = join(ws, 'rc.json');
    expect(await reportWith(repo, ws, inv, dir, caseId, out)).toBe(1);
    expect(staleIds(out)).toContain('ERR02_CASE_STALE');
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
  });

  it('rejects a replayed report after success (double-resolve guard)', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    expect(await reportWith(repo, ws, inv, dir, caseId)).toBe(0); // first: success
    const afterFirst = repo.sha('main_patched');
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED');
    expect(readJournal(dir).filter((e) => e.action === 'resolved').length).toBe(1);
    // Replay: the case is disposed and the machine holds no ready case, so a
    // second report is REFUSED — no second merge, no second `resolved` row.
    // (reverifyCase's own "the resolution already landed" arm is exercised by
    // publish.test.ts's ERR02 test, which publishes a case whose head landed.)
    expect(await reportWith(repo, ws, inv, dir, caseId)).not.toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'resolved').length).toBe(1);
    expect(repo.sha('main_patched')).toBe(afterFirst);
  });

  it('rejects a report for a case that was never journaled', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    // Forge the machine's current case: a fabricated id + a case.json copied from
    // the real one. The pass journal has no `case` row for it, which is what
    // reverifyCase refuses — before any worktree or checks work happens.
    const fakeId = 'main_patched-h99';
    mkdirSync(join(dir, fakeId), { recursive: true });
    const real = readCase(dir, caseId);
    writeFileSync(join(dir, fakeId, 'case.json'), JSON.stringify({ ...real, id: fakeId }, null, 2));
    const st = machineState(dir);
    writeFileSync(
      join(dir, 'machine-state.json'),
      JSON.stringify({ ...st, currentCase: { ...st.currentCase, caseId: fakeId } }, null, 2),
    );
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(1);
    expect(staleIds(out)).toContain('ERR02_CASE_STALE');
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
  });

  // N2: plan.json is a SNAPSHOT, not authority — parents and scope are
  // re-derived from the registry, so forging the plan buys nothing.
  it('halts on a forged parent edge in plan.json (drift vs the registry)', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    const planPath = join(dir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      branches: Array<{ branch: string; parents: unknown[] }>;
    };
    plan.branches
      .find((b) => b.branch === 'main_patched')!
      .parents.push({
        parent: 'feat/fake',
        model: 'parents',
        mergePoint: null,
        verdict: 'skip',
        case: null,
        deferredTo: null,
        skipReason: null,
      });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));

    const out = join(ws, 'rc.json');
    expect(await reportWith(repo, ws, inv, dir, caseId, out)).toBe(1);
    expect(staleIds(out)).toContain('ERR02_CASE_STALE');
    expect(staleDetails(out).some((d) => d.includes('plan drift'))).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false); // no merge
  });

  it('a branch smuggled into plan.json (+ forged case/journal) is refused by the registry scope', async () => {
    const { repo } = conflictFixture();
    repo.checkout('feat/evil', { create: true, at: 'main_patched' }); // exists in the repo, NOT in the registry
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const real = readCase(dir, currentCaseId(dir));

    // Forge: plan.json grows a feat/evil row; a case + journal entry are forged
    // for it, and the machine is pointed at that fabricated case.
    const planPath = join(dir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { branches: unknown[]; order: string[] };
    plan.order.push('feat/evil');
    plan.branches.push({
      branch: 'feat/evil',
      kind: 'inventory',
      tierFloor: 'clean',
      isLeaf: true,
      alwaysMerge: false,
      ancestors: [],
      parents: [
        {
          parent: 'main',
          model: 'entry',
          mergePoint: null,
          verdict: 'case',
          case: null,
          deferredTo: null,
          skipReason: null,
        },
      ],
    });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const fakeId = 'feat__evil--main-h1';
    mkdirSync(join(dir, fakeId), { recursive: true });
    writeFileSync(
      join(dir, fakeId, 'case.json'),
      JSON.stringify({ ...real, id: fakeId, branch: 'feat/evil', parent: 'main' }, null, 2),
    );
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'case', branch: 'feat/evil', caseId: fakeId }) + '\n',
    );
    const st = machineState(dir);
    writeFileSync(
      join(dir, 'machine-state.json'),
      JSON.stringify({ ...st, currentCase: { ...st.currentCase, caseId: fakeId, branch: 'feat/evil' } }, null, 2),
    );

    const before = repo.sha('feat/evil');
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
        confirm,
      ),
    ).toBe(1);
    expect(staleIds(out)).toContain('ERR02_CASE_STALE');
    expect(staleDetails(out).some((d) => d.includes('registry-derived pass scope'))).toBe(true);
    expect(repo.sha('feat/evil')).toBe(before);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.branch === 'feat/evil')).toBe(false);
  });
});

describe('run — resume idempotence + window trimming (reached via next-case)', () => {
  it('idempotent resume: a second run does not re-merge already-arrived branches', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    // `next-case` runs the pass stage internally: clean prefix merged, `arrived`
    // journaled, the conflict served.
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const afterFirst = repo.sha('main_patched');
    const arrivals1 = readJournal(dir).filter((e) => e.action === 'arrived').length;
    expect(arrivals1).toBeGreaterThan(0);
    // The resume path: the SAME stage re-run must be a no-op — no second merge,
    // no second barrier arrival.
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true, internal: true }))).toBe(0);
    expect(repo.sha('main_patched')).toBe(afterFirst);
    expect(readJournal(dir).filter((e) => e.action === 'arrived').length).toBe(arrivals1);
  });

  it('a clean merge through a BLOCKED ancestor height is trimmed — the branch merges nothing', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main'); // pin the fork point BELOW U0 so U0 is chain height 0
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/c', { create: true, at: 'main_patched' }); // coverage -1
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    repo.checkout('main_patched');
    repo.git('merge', '--no-edit', '-m', 'main_patched merges U0', 'main'); // main_patched covers h0
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { base, ...o });
    // A HELD ancestor (main_patched blocked at h0), seeded as the `origin-blocked`
    // journal row `sweep start` derives from origin: the row's headSha is a
    // side commit at chain height 0 (like a fix/sweep ref head containing the
    // conflict head), so the block height re-derives to 0 live. Appended AFTER
    // start, whose clean-slate boundary would otherwise wipe it.
    repo.checkout('held-marker', { create: true, at: 'main' });
    repo.commit('marker: not in main_patched', { 'src/marker.ts': 'm\n' });
    const markerSha = repo.sha('held-marker');
    repo.checkout('main');
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'main_patched',
      caseId: 'origin:fix/sweep/main_patched--main-h0-deadbeef',
      fixBranch: 'fix/sweep/main_patched--main-h0-deadbeef',
      headSha: markerSha,
      prNumber: 12,
    });
    const cTip = repo.sha('feat/c');
    expect(await cmdRun(cli({ cmd: 'run', execute: true, internal: true }))).toBe(0);
    // The merge was available and clean, and is NOT taken: height 0 is the
    // ancestor's own unresolved conflict, so nothing at or above it has been
    // integrated. Taking it would advance feat/c onto a state the trunk has never
    // seen — which the integration rebuild would then blame feat/c for.
    expect(repo.sha('feat/c')).toBe(cTip);
    expect(readJournal(dir).some((e) => e.action === 'merge' && e.branch === 'feat/c')).toBe(false);
    // …and no pre-ref, so it is not "advanced this pass" and cannot enter the
    // verify recipe. That is the whole mechanism, in one assertion.
    expect(readJournal(dir).some((e) => e.action === 'pre-ref' && e.branch === 'feat/c')).toBe(false);
  });

  /**
   * A GATE fix keeps its scope after it becomes a PR.
   *
   * In the pass that takes it, a gate hold carries no conflict head, so it is
   * unmeasurable and trims everything. One pass later the same block arrives
   * from origin as a `fix/sweep/…--gate-fix-…` ref whose head has a perfectly
   * measurable coverage — the offender's own tip. Reading that as a conflict
   * height hands descendants everything below a branch that is still RED, and
   * makes the trim depend on which pass took the hold.
   */
  it('a gate fix arriving from origin still trims the WHOLE range, not its ref height', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main');
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/c', { create: true, at: 'main_patched' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    repo.checkout('main_patched');
    repo.git('merge', '--no-edit', '-m', 'main_patched merges U0', 'main'); // covers h0
    repo.checkout('main');
    repo.commit('U1: more', { 'src/more.ts': 'm\n' });
    repo.checkout('main_patched');
    repo.git('merge', '--no-edit', '-m', 'main_patched merges U1', 'main'); // tip covers h1
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    // The distinction this pins: main_patched's TIP covers h1, so reading the
    // gate-fix ref head as a conflict height would trim at 1 and leave h0
    // eligible — feat/c would merge the h0 step of a branch that is RED. Only a
    // whole-range block leaves nothing.
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { base, ...o });
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    // The gate-fix ref head is main_patched's OWN tip: a real, measurable height
    // (0). Only the ref NAME says this is a gate fix rather than a conflict.
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'main_patched',
      caseId: 'origin:fix/sweep/main_patched--gate-fix-main_patched-deadbeef',
      fixBranch: 'fix/sweep/main_patched--gate-fix-main_patched-deadbeef',
      headSha: repo.sha('main_patched'),
      prNumber: 13,
    });
    const cTip = repo.sha('feat/c');
    expect(await cmdRun(cli({ cmd: 'run', execute: true, internal: true }))).toBe(0);
    // Height 0 is NOT a conflict point here — the branch is red, so no prefix of
    // it is proven clean and feat/c takes nothing, exactly as in the pass that
    // took the hold.
    expect(repo.sha('feat/c')).toBe(cTip);
    expect(readJournal(dir).some((e) => e.action === 'merge' && e.branch === 'feat/c')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'pre-ref' && e.branch === 'feat/c')).toBe(false);
  });
});

describe('report-case — cold-read request context + the scope-guard mode lever (§7)', () => {
  it('embeds the inventory summary and owned_paths and per-side histories over the conflicted paths', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    // The entry matches by owned_paths covering the conflicted path
    // (main_patched itself has no inventory entry — structural).
    const inv = writeInventory([
      {
        id: 'x-surface',
        branch: 'feat/none',
        summary: 'owns the x surface',
        owned_paths: ['src/x.ts'],
      },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);

    // Written at CASE EMISSION so the reader is never context-starved.
    const request = readFileSync(join(dir, caseId, 'coldread-request.md'), 'utf8');
    expect(request).toContain('## Case context (driver-derived)');
    expect(request).toContain('owns the x surface');
    expect(request).toContain('src/x.ts');
    // Per-side `git log --oneline` over the conflicted paths.
    expect(request).toContain('mp: x = fork'); // ours
    expect(request).toContain('U1: x = up1'); // theirs

    // Still regenerated (with the same context) for the report-case cold read,
    // now carrying the resolution diff.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
        confirm,
      ),
    ).toBe(0);
    const regen = readFileSync(join(dir, caseId, 'coldread-request.md'), 'utf8');
    expect(regen).toContain('## Case context (driver-derived)');
    expect(regen).toContain('## Resolution diff (automerge tree -> resolved tree)');
    expect(regen).toContain('RESOLVED');
  });

  it('per-feature override beats the global mode; a mode forged in case.json is ignored', async () => {
    // feat/z conflicts against main_patched; single-line x so the resolution is
    // trivially in-hunk (we assert the DERIVED mode, not a hunk violation).
    function featZ(): FixtureRepo {
      const repo = initFixtureRepo();
      repo.commit('base: x', { 'src/x.ts': 'orig\n' });
      repo.checkout('main_patched', { create: true, at: 'main' });
      repo.checkout('feat/z', { create: true, at: 'main_patched' });
      repo.commit('feat/z: x = fork', { 'src/x.ts': 'fork\n' });
      repo.checkout('main');
      repo.commit('U0: util', { 'src/util.ts': 'u\n' });
      repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
      cleanups.push(() => repo.destroy());
      return repo;
    }
    /** Serve feat/z's case, resolve it in the worktree, and read the DERIVED
     * scope-guard mode off report-case's decision (dry-run: computed, unwritten). */
    async function derivedMode(inv: string, routing: string, forge?: (c: Record<string, unknown>) => void) {
      const repo = featZ();
      const ws = mkWorkspace();
      const dir = passDir(ws, repo.sha('main').slice(0, 12));
      const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { routingFile: routing, ...o });
      expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
      expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
      const caseId = currentCaseId(dir);
      expect(readJournal(dir).find((e) => e.action === 'case' && e.caseId === caseId)!.branch).toBe('feat/z');
      if (forge) editCase(dir, caseId, forge);
      resolveWorktree(dir, caseId, { 'src/x.ts': 'MERGED\n' });
      const outFile = join(ws, 'o.json');
      expect(
        await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', out: outFile }), confirm),
      ).toBe(0);
      return (JSON.parse(readFileSync(outFile, 'utf8')) as { scopeGuard: { mode: string } }).scopeGuard.mode;
    }

    // Override: entry says conflict-hunks, global says same-files -> conflict-hunks wins.
    expect(
      await derivedMode(
        writeInventory([{ id: 'z', branch: 'feat/z', parents: ['main_patched'], scope_guard: 'conflict-hunks' }]),
        writeRouting('same-files'),
      ),
    ).toBe('conflict-hunks');

    // Forged: case.json carries scope_guard: same-files, but config says
    // conflict-hunks and there is no per-feature override -> config wins.
    expect(
      await derivedMode(
        writeInventory([{ id: 'z', branch: 'feat/z', parents: ['main_patched'] }]),
        writeRouting('conflict-hunks'),
        (c) => {
          c.scope_guard = 'same-files';
        },
      ),
    ).toBe('conflict-hunks');
  });
});

describe('report-case — the cold-read fail-closed reduction', () => {
  const unverifiable: ColdReadInvoker = async () => ({
    verdict: 'confirm',
    answers: { q1: 'ok', q2: 'UNVERIFIABLE-FROM-REQUEST', q3: 'ok' },
    notes: 'looks plausible but I could not check q2 from the request',
  });
  const allAnswered: ColdReadInvoker = async () => ({
    verdict: 'confirm',
    answers: { q1: 'ok', q2: 'ok', q3: 'ok' },
    notes: 'behaviour preserved; every hunk explained',
  });

  it('an UNVERIFIABLE-FROM-REQUEST answer on Q1-Q3 fails closed as a REJECTION even under an overall confirm (2nd strike -> HELD)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    const postRun = repo.sha('main_patched');
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    // FIRST strike: treated as a rejection (fail-closed) — no merge, no freeze.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        unverifiable,
      ),
    ).toBe(1);
    expect(repo.sha('main_patched')).toBe(postRun); // NOT merged despite the overall confirm
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId && e.rejected === true)).toBe(
      true,
    );
    // SECOND strike: HELD (fail-closed, escalated).
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED AGAIN\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        unverifiable,
      ),
    ).toBe(0);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId);
    expect(held).toBeTruthy();
    expect((held!.notes as string[]).join(' ')).toContain('UNVERIFIABLE-FROM-REQUEST');
    expect(repo.sha('main_patched')).toBe(postRun);
    // The HELD arm reopens the branch (+ its descendants) like every disposition.
    expect(readJournal(dir).some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(true);
  });

  it('a plain confirm with all three answers present still merges (the answers are advisory when verifiable)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        allAnswered,
      ),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(true);
  });

  it('a dry-run report on a forged case leaves the journal byte-identical and exits 1 (N7)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    editCase(dir, caseId, (c) => {
      (c.head as { sha: string }).sha = '0'.repeat(40); // forged -> reverify fails
    });
    const before = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical' }), confirm),
    ).toBe(1);
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toBe(before); // nothing appended
  });
});

describe('report-case — the resolved merge writes refs and worktrees safely (N1/B6)', () => {
  it('a resolved merge on a checked-out CLEAN branch moves the ref AND resets the worktree', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const wtPath = addBranchWorktree(repo, 'main_patched');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    resolveWorktree(dir, currentCaseId(dir), { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      ),
    ).toBe(0);
    // The worktree FOLLOWED the ref: content matches the resolved tree, clean status, tip == HEAD.
    expect(readFileSync(join(wtPath, 'src/x.ts'), 'utf8')).toBe('RESOLVED\n');
    expect(repo.git('-C', wtPath, 'status', '--porcelain')).toBe('');
    expect(repo.git('-C', wtPath, 'rev-parse', 'HEAD')).toBe(repo.sha('main_patched'));
  });

  it('a resolved merge on a checked-out DIRTY branch halts without moving the ref', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const wtPath = addBranchWorktree(repo, 'main_patched');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    // Dirty AFTER the run (the run itself needed the clean worktree for its merge).
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted\n');
    const before = repo.sha('main_patched');
    // The guard fires as a DriverHalt. NOTE: report-case lets it PROPAGATE —
    // it has no DriverHalt catch that journals a
    // `halt` row and returns 1, so the agent sees a stack trace instead of the
    // machine's stop contract. The load-bearing invariant still holds and is
    // asserted below: the ref is NOT moved and the dirt is untouched.
    await expect(
      cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      ),
    ).rejects.toThrow(/dirty — refusing to move its ref/);
    expect(repo.sha('main_patched')).toBe(before); // ref not moved
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
    expect(repo.git('-C', wtPath, 'status', '--porcelain')).toContain('dirty.txt'); // dirt untouched
  });

  it('materializes the automerge tree in a case worktree and cleans it up on disposal (SPEC 1)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    const wtPath = join(dir, caseId, 'worktree');
    expect(existsSync(wtPath)).toBe(true);
    // The conflicted file carries conflict markers (the automerge content).
    expect(readFileSync(join(wtPath, 'src/x.ts'), 'utf8')).toContain('<<<<<<<');
    expect(readJournal(dir).some((e) => e.action === 'case-worktree' && e.caseId === caseId)).toBe(true);

    // Disposed -> worktree removed + journaled.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      ),
    ).toBe(0);
    expect(existsSync(wtPath)).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'worktree-removed' && e.caseId === caseId)).toBe(true);
  });
});

/** main_patched (x=fork) + a child that owns its own file — descendant convergence. */
function parentChildFixture(): { repo: FixtureRepo } {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('feat/c', { create: true, at: 'main_patched' });
  repo.commit('feat/c: own', { 'src/c.ts': 'c\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
  cleanups.push(() => repo.destroy());
  return { repo };
}

describe('run — same-pass continuation + crash heal (§8, B5i)', () => {
  it('a resolved branch reaches the watermark and its child picks up the resolution', async () => {
    const { repo } = parentChildFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    expect(readJournal(dir).find((e) => e.action === 'case' && e.caseId === caseId)!.branch).toBe('main_patched');
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('fork');

    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
    ).toBe(0);
    expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(true);
    expect(
      readJournal(dir)
        .filter((e) => e.action === 'reopened')
        .map((e) => e.branch)
        .sort(),
    ).toEqual(['feat/c', 'main_patched']);

    // The next pass stage (next-case) continues the reopened branches.
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('RESOLVED');
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/c')).toBe(true);
  });

  it('a crash that loses the trailing journal rows heals on the next run (no duplicate merge)', async () => {
    const { repo } = parentChildFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
    ).toBe(0);
    const mpTip = repo.sha('main_patched');

    // Simulate the crash: the ref stays moved, the trailing `resolved` +
    // `reopened` journal entries vanish (ref-updated-but-journal-missing).
    stripJournal(dir, new Set(['resolved', 'reopened']));

    // The run HEALS: a synthetic crash-heal `resolved` + `reopened`, descendants
    // pick up the resolution, no duplicate merge, nothing left open.
    expect(await cmdRun(cli({ cmd: 'run', execute: true, internal: true }))).toBe(0);
    const journal = readJournal(dir);
    const healed = journal.find((e) => e.action === 'resolved' && e.reason === 'crash-heal');
    expect(healed).toBeTruthy();
    expect(healed!.caseId).toBe(caseId);
    expect(repo.sha('main_patched')).toBe(mpTip); // no duplicate merge
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'feat/c')).toBe(true);
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('RESOLVED'); // descendant converged
    const openIds = journal
      .filter((e) => e.action === 'case')
      .map((e) => e.caseId as string)
      .filter((id) => !journal.some((e) => (e.action === 'resolved' || e.action === 'held') && e.caseId === id));
    expect(openIds).toEqual([]);
  });

  it('does not deadlock: each parent conflict is its own case, resolved sequentially', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/a.ts': 'orig\n', 'src/b.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/p1', { create: true, at: 'main_patched' });
    repo.commit('p1: a', { 'src/a.ts': 'P1\n' });
    repo.checkout('main_patched');
    repo.checkout('feat/p2', { create: true, at: 'main_patched' });
    repo.commit('p2: b', { 'src/b.ts': 'P2\n' });
    repo.checkout('main_patched');
    repo.checkout('feat/c', { create: true, at: 'main_patched' });
    repo.commit('c: a+b', { 'src/a.ts': 'C\n', 'src/b.ts': 'C\n' });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'p1', branch: 'feat/p1', parents: ['main_patched'] },
      { id: 'p2', branch: 'feat/p2', parents: ['main_patched'] },
      { id: 'c', branch: 'feat/c', parents: ['feat/p1', 'feat/p2'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);

    /** Serve the next feat/c case and resolve every conflicted path to `content`. */
    async function serveAndResolve(content: string): Promise<{ caseId: string; height: number }> {
      expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
      const caseId = currentCaseId(dir);
      const row = readJournal(dir).find((e) => e.action === 'case' && e.caseId === caseId)!;
      expect(row.branch).toBe('feat/c');
      resolveWorktree(dir, caseId, Object.fromEntries((row.conflictedPaths as string[]).map((p) => [p, content])));
      expect(
        await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
      ).toBe(0);
      return { caseId, height: (row.head as { height: number }).height };
    }

    const first = await serveAndResolve('MERGED\n');
    // The next serve surfaces the OTHER parent's case at the SAME height — a
    // distinct id (B8: no collision), and it is RESOLVABLE (would deadlock under
    // branch+height ids).
    const second = await serveAndResolve('MERGED2\n');
    expect(second.caseId).not.toBe(first.caseId);
    expect(second.height).toBe(first.height);
  });
});

/**
 * The multi-parent TOCTOU shape: feat/child has TWO parents whose per-parent
 * probes both ran against the SAME derivation tip. Parent pa merges first and
 * advances the tip; parent pb's clean `merge` verdict is then stale — its merge
 * against the advanced tip conflicts on src/f.ts. Without the execution
 * re-probe, this hits commitTreeMerge's conflicted-tree throw (a bare Error)
 * and the whole run aborts, blocking every remaining branch.
 */
describe('run — B11: multi-parent TOCTOU re-probe + demotion to a case', () => {
  function toctouFixture(): { repo: FixtureRepo } {
    const repo = initFixtureRepo();
    repo.commit('base: f', { 'src/f.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/pa', { create: true, at: 'main_patched' });
    repo.commit('pa: f = A', { 'src/f.ts': 'A\n' });
    repo.checkout('main_patched');
    repo.checkout('feat/pb', { create: true, at: 'main_patched' });
    repo.commit('pb: f = B', { 'src/f.ts': 'B\n' });
    repo.checkout('main_patched');
    repo.checkout('feat/child', { create: true, at: 'main_patched' });
    repo.commit('child: own file', { 'src/c.ts': 'c\n' });
    repo.checkout('feat/down', { create: true, at: 'feat/child' });
    repo.commit('down: own file', { 'src/d.ts': 'd\n' });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());
    return { repo };
  }

  it('parent A merges, parent B demotes to a case from the CURRENT tip, siblings/descendants proceed; the case resolves', async () => {
    const { repo } = toctouFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'pa', branch: 'feat/pa', parents: ['main_patched'] },
      { id: 'pb', branch: 'feat/pb', parents: ['main_patched'] },
      { id: 'child', branch: 'feat/child', parents: ['feat/pa', 'feat/pb'] },
      { id: 'down', branch: 'feat/down', parents: ['feat/child'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);

    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    // Both child parents probe clean against the derivation tip (the crash setup).
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as {
      branches: Array<{ branch: string; parents: Array<{ parent: string; verdict: string }> }>;
    };
    const childRow = plan.branches.find((b) => b.branch === 'feat/child')!;
    expect(childRow.parents.map((p) => [p.parent, p.verdict])).toEqual([
      ['feat/pa', 'merge'],
      ['feat/pb', 'merge'],
    ]);

    // Pre-fix this REJECTED (commitTreeMerge's bare Error escaped cmdRun);
    // post-fix the pass completes and gates the branch on a proper case.
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const journal = readJournal(dir);

    // Parent A landed; parent B did not.
    const childMerges = journal.filter((e) => e.action === 'merge' && e.branch === 'feat/child');
    expect(childMerges.map((e) => e.parent)).toEqual(['feat/pa']);
    expect(await isAncestor(repo.dir, repo.sha('feat/pa'), 'feat/child')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('feat/pb'), 'feat/child')).toBe(false);

    // The demotion is journaled and a case emitted with the RECOMPUTED conflict
    // set against the post-merge tip (B11).
    const demoted = journal.find((e) => e.action === 'demoted' && e.branch === 'feat/child')!;
    expect(demoted.parent).toBe('feat/pb');
    expect(demoted.to).toBe('case');
    expect(demoted.conflictedPaths).toEqual(['src/f.ts']);
    const caseEntry = journal.find((e) => e.action === 'case' && e.branch === 'feat/child')!;
    expect(caseEntry.parent).toBe('feat/pb');
    expect(caseEntry.conflictedPaths).toEqual(['src/f.ts']);
    const caseId = caseEntry.caseId as string;
    expect(currentCaseId(dir)).toBe(caseId); // …and it is the case the agent is served
    const caseFile = readCase(dir, caseId);
    expect((caseFile.head as { sha: string }).sha).toBe(repo.sha('feat/pb'));
    // Driver worktree materialized with the conflict markers (SPEC 1).
    expect(readFileSync(join(dir, caseId, 'worktree', 'src/f.ts'), 'utf8')).toContain('<<<<<<<');

    // Siblings + descendant unaffected: everyone arrived; the child's barrier
    // arrival lets feat/down proceed on the PARTIAL (pa-only) progress —
    // inherited gating keeps pb's content out until the case resolves.
    const arrivedBranches = journal.filter((e) => e.action === 'arrived').map((e) => e.branch);
    for (const b of ['main_patched', 'feat/pa', 'feat/pb', 'feat/child', 'feat/down'])
      expect(arrivedBranches).toContain(b);
    expect(await isAncestor(repo.dir, repo.sha('feat/pa'), 'feat/down')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('feat/pb'), 'feat/down')).toBe(false);

    // The emitted case is ACTIONABLE: report-case re-derives the same head/tree/paths.
    resolveWorktree(dir, caseId, { 'src/f.ts': 'MERGED\n' });
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
    ).toBe(0);
    expect(repo.git('show', 'feat/child:src/f.ts')).toBe('MERGED');

    // Continuation machinery (§8): the reopened descendant picks up the resolution.
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    expect(repo.git('show', 'feat/down:src/f.ts')).toBe('MERGED');
    expect(await isAncestor(repo.dir, repo.sha('feat/pb'), 'feat/child')).toBe(true);
  });
});

describe('publish — N5 case-id shape (ERR25) is checked before any path join', () => {
  it('rejects separators, dots and traversal before any path join', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    for (const bad of ['../../etc/passwd-h1', 'a/b-h1', 'a..b-h1', 'x.y-h1', 'no-height-suffix']) {
      expect(await cmdPublish(baseCli(repo, ws, inv, { cmd: 'publish', execute: true, caseId: bad }))).toBe(2);
    }
    expect(existsSync(join(ws, 'propagation'))).toBe(false); // refused before any pass/path work
  });
});

describe('report — journal-derived owner summary', () => {
  it('prints a journal-derived summary incl. open/unresolved cases', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);

    // Case still open: report shows a merged clean prefix + one open case.
    const out1 = join(ws, 'report-open.json');
    expect(await cmdReport(baseCli(repo, ws, inv, { cmd: 'report', out: out1 }))).toBe(0);
    const r1 = JSON.parse(readFileSync(out1, 'utf8')) as {
      mergedCount: number;
      openCases: Array<{ caseId: string }>;
      held: unknown[];
      resolved: unknown[];
      sealed: boolean;
    };
    expect(r1.mergedCount).toBeGreaterThanOrEqual(1);
    expect(r1.openCases.map((o) => o.caseId)).toContain(caseId);
    expect(r1.resolved.length).toBe(0);
    expect(r1.held.length).toBe(0);

    // Freeze it HELD; report now reflects the disposition (open -> held).
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    const out2 = join(ws, 'report-held.json');
    expect(await cmdReport(baseCli(repo, ws, inv, { cmd: 'report', out: out2 }))).toBe(0);
    const r2 = JSON.parse(readFileSync(out2, 'utf8')) as {
      openCases: unknown[];
      held: Array<{ caseId: string }>;
    };
    expect(r2.openCases.length).toBe(0);
    expect(r2.held.map((h) => h.caseId)).toContain(caseId);
  });
});

describe('propagate run — no-op skip + leaf un-skip chain (§6)', () => {
  it('un-skips the cheapest parent chain so the leaf lands a real (empty) merge', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: f', { 'src/f.ts': 'base\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('feat/a: f = X', { 'src/f.ts': 'X\n' });
    repo.checkout('feat/b', { create: true, at: 'feat/a' });
    repo.commit('feat/b: own', { 'src/b.ts': 'b\n' });
    repo.checkout('main');
    repo.commit('U0: f = X', { 'src/f.ts': 'X\n' });
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['feat/a'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (over: Partial<Cli>): Cli => baseCli(repo, ws, inv, over);
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'skip' && e.branch === 'feat/a')).toBe(true);
    const forced = journal.filter((e) => e.action === 'merge' && e.forced === true);
    expect(forced.map((e) => e.branch).sort()).toEqual(['feat/a', 'feat/b']);
    expect((await commitInfo(repo.dir, 'feat/b')).parents.length).toBe(2);
  });
});

// --- FIX C: pass pinning + durable freezes --------------------------------
describe('propagate — pass pinning (§8, FIX C)', () => {
  it('run stays on the pinned watermark even if upstream advances after plan', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/u0.ts': '0\n' });
    const w1 = repo.sha('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = branchlessInventory();
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' })); // pins watermark W1

    // Upstream advances AFTER plan.
    repo.commit('U1: extra', { 'src/u1.ts': '1\n' });
    const u1 = repo.sha('main');
    expect(u1).not.toBe(w1);

    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    // main_patched absorbed U0 (the pinned watermark) but NOT U1 (post-pin).
    expect(await isAncestor(repo.dir, w1, 'main_patched')).toBe(true);
    expect(await isAncestor(repo.dir, u1, 'main_patched')).toBe(false);
    // The run attached to the W1 pass; no pass dir was opened for U1.
    expect(readJournal(passDir(ws, w1.slice(0, 12))).length).toBeGreaterThan(0);
    expect(readJournal(passDir(ws, u1.slice(0, 12))).length).toBe(0);
  });

  it('an origin-blocked branch is skipped (empty interval); a fresh pass without the row derives unblocked', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));

    // Block main_patched via the journal row `sweep start` would derive from an
    // unmerged origin fix/sweep ref with an open PR — appended BEFORE
    // plan, exactly where start writes it.
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'main_patched',
      caseId: 'origin:fix/sweep/main_patched--main-h1-deadbeef',
      fixBranch: 'fix/sweep/main_patched--main-h1-deadbeef',
      headSha: null,
      prNumber: 12,
    });
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const before = repo.sha('main_patched');
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(repo.sha('main_patched')).toBe(before); // blocked -> empty interval, no merge
    expect(
      readJournal(dir).some((e) => e.action === 'skip' && e.branch === 'main_patched' && e.reason === 'held'),
    ).toBe(true);

    // The block is PASS-LOCAL derived state: a fresh pass whose journal
    // carries no origin-blocked row (start found no ref / the PR was resolved)
    // derives main_patched unblocked and processes it normally.
    const ws2 = mkWorkspace();
    const dir2 = passDir(ws2, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws2, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws2, inv, { cmd: 'run', execute: true }));
    expect(repo.sha('main_patched')).not.toBe(before); // clean prefix (U0) merged
    expect(readJournal(dir2).some((e) => e.action === 'case' && e.branch === 'main_patched')).toBe(true);
  });
});

// --- FIX B: verify gate + rollback ----------------------------------------
describe('propagate verify — §9 gate rolls back a red offender (FIX B)', () => {
  it('attributes the offender, rolls it back to its pre-ref, HELD(gate), re-verifies green', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/base.ts': 'b\n' });
    repo.checkout('feat/off', { create: true, at: 'main' });
    repo.commit('feat/off: clean', { 'src/off.ts': 'ok\n' });
    const cleanTip = repo.sha('feat/off');
    repo.commit('feat/off: introduces BAD', { BAD: 'boom\n' }); // a pass merge would land this
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    // A minimal open pass: the plan's order plus a pre-ref for feat/off at its
    // clean pre-merge tip, as if `run` had merged BAD into it this pass. The
    // recipe is DERIVED from exactly that — it advanced and is not held.
    const { dir, wm12 } = seedVerifyPass(ws, repo, ['feat/off'], [{ branch: 'feat/off', ref: cleanTip }]);
    const cmdsFile = join(ws, 'cmds.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'test ! -f BAD' }]));

    const code = await cmdVerify(
      baseCli(repo, ws, null, {
        cmd: 'verify',
        execute: true,
        pass: wm12,
        commandsFile: cmdsFile,
      }),
    );
    expect(code).toBe(0); // re-verify green after rollback
    expect(repo.sha('feat/off')).toBe(cleanTip); // rolled back to pre-ref
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.branch === 'feat/off' && e.reason === 'gate')).toBe(true);
    expect(journal.filter((e) => e.action === 'verify').map((e) => e.ok)).toEqual([false, true]);
    // Gate hold: the journaled held row IS the block — no head, no PR,
    // no durable local state is written.
    const gateRow = journal.find((e) => e.action === 'held' && e.branch === 'feat/off')!;
    expect(gateRow.reason).toBe('gate');
    // A gate hold is NOT a case — no conflict, no head, no merge. `height` and
    // `conflictedPaths` are ABSENT rather than placeholders asserting a
    // measurement nobody took: absent means "not applicable"; -1 means
    // "measured, answer -1", and readers of gate-fix cases really do
    // arithmetic on it.
    expect(gateRow.height).toBeUndefined();
    expect(gateRow.conflictedPaths).toBeUndefined();
    expect(existsSync(join(ws, 'sweep-ledger.json'))).toBe(false); // no durable local state
  });
});

// --- verify gate validates THIS PASS'S PUBLISHABLE RESULT -----------------
/**
 * Seed a minimal OPEN pass on disk: plan(-initial).json carrying `order`, one
 * `pre-ref` per advanced branch, plus any extra journal lines (held/case/…).
 */
function seedVerifyPass(
  ws: string,
  repo: FixtureRepo,
  order: string[],
  advanced: Array<{ branch: string; ref: string }>,
  extra: Array<Record<string, unknown>> = [],
): { dir: string; wm12: string } {
  const mainTip = repo.sha('main');
  const wm12 = mainTip.slice(0, 12);
  const dir = passDir(ws, wm12);
  mkdirSync(dir, { recursive: true });
  const plan = {
    schemaVersion: 1,
    watermark: mainTip,
    watermark12: wm12,
    forkPoint: mainTip,
    chainLength: 0,
    order,
    branches: order.map((branch) => ({
      branch,
      kind: 'inventory',
      tierFloor: 'clean',
      isLeaf: true,
      alwaysMerge: false,
      ancestors: [],
      parents: [],
    })),
    warnings: [],
  };
  writeFileSync(join(dir, 'plan-initial.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  for (const e of [...advanced.map((a) => ({ action: 'pre-ref', branch: a.branch, ref: a.ref })), ...extra]) {
    appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  }
  return { dir, wm12 };
}

/**
 * A branch built on a DIVERGED fork line: `module/held` forks the base commit
 * and edits line 3 -> FORK; `main` advances the SAME line -> UP1. Merging
 * module/held onto bare `main` therefore conflicts unresolvably (recreating the
 * historical module-stack conflict), while `module/good` forks main's tip and
 * only adds a file (clean). Optionally also builds `main_patched` (fork trunk,
 * line 3 -> FORK) + `module/m` on it (adds a file, keeps FORK).
 */
function divergedFixture(opts: { withMainPatched?: boolean } = {}): { repo: FixtureRepo } {
  const repo = initFixtureRepo();
  const baseSha = repo.commit('D-051 base: x', { 'src/x.ts': 'a\nb\nMID\nd\ne\n' });
  repo.checkout('module/held', { create: true, at: baseSha });
  repo.commit('module/held: x line3 -> FORK', { 'src/x.ts': 'a\nb\nFORK\nd\ne\n' });
  if (opts.withMainPatched) {
    repo.checkout('main_patched', { create: true, at: baseSha });
    repo.commit('mp: x line3 -> FORK', { 'src/x.ts': 'a\nb\nFORK\nd\ne\n' });
    repo.checkout('module/m', { create: true, at: 'main_patched' });
    repo.commit('module/m: add m (keeps FORK)', { 'src/m.ts': 'export const m = 1;\n' });
  }
  repo.checkout('main');
  repo.commit('main advances: x line3 -> UP1', { 'src/x.ts': 'a\nb\nUP1\nd\ne\n' });
  repo.checkout('module/good', { create: true, at: 'main' });
  repo.commit('module/good: add good (clean on main)', { 'src/good.ts': 'export const good = 1;\n' });
  repo.checkout('main');
  cleanups.push(() => repo.destroy());
  return { repo };
}

describe('publishableRecipe — pure recipe derivation', () => {
  it('keeps advanced branches in DAG order, drops held/frozen and open-case branches', () => {
    const journal: JournalEntry[] = (
      [
        { action: 'pre-ref', branch: 'main_patched', ref: 'x' },
        { action: 'pre-ref', branch: 'module/a', ref: 'x' },
        { action: 'pre-ref', branch: 'module/b', ref: 'x' }, // advanced but held below
        { action: 'pre-ref', branch: 'module/c', ref: 'x' }, // advanced but open case below
        { action: 'held', branch: 'module/b', caseId: 'B1', height: -1, conflictedPaths: [] },
        { action: 'case', branch: 'module/c', parent: 'main_patched', caseId: 'C1' },
      ] as Array<Record<string, unknown>>
    ).map((e) => ({ ts: '', ...e }) as JournalEntry);
    const order = ['main_patched', 'module/a', 'module/b', 'module/c'];
    // held = the PR_ID-blocked set (origin/journal-derived): module/b
    // plus a blocked branch that never advanced — never in the recipe.
    const held = new Set(['module/b', 'module/frozen-elsewhere']);
    expect(publishableRecipe(journal, order, held)).toEqual(['main_patched', 'module/a']);
  });

  it('bug #63: a case SUPERSEDED by a reopen (stale, never disposed) does NOT exclude its branch once the fresh re-emitted case resolves', () => {
    // module/c: stale case C-h1 emitted, parent resolved → c reopened → fresh
    // case C-h2 emitted against the advanced parent, then RESOLVED. The stale
    // C-h1 is never dispositioned; without supersession it would keep c out of
    // the publishable set forever (and, in openCases, be served first → an
    // ERR02_CASE_STALE loop). It must be treated as dead.
    const journal: JournalEntry[] = (
      [
        { action: 'pre-ref', branch: 'main_patched', ref: 'x' },
        { action: 'pre-ref', branch: 'module/c', ref: 'x' },
        { action: 'case', branch: 'module/c', parent: 'main_patched', caseId: 'C-h1', head: { sha: 'aaa', height: 1 } }, // stale
        { action: 'resolved', branch: 'main_patched', caseId: 'M1' },
        { action: 'reopened', branch: 'module/c' }, // supersedes C-h1
        { action: 'case', branch: 'module/c', parent: 'main_patched', caseId: 'C-h2', head: { sha: 'bbb', height: 2 } }, // fresh
        { action: 'resolved', branch: 'module/c', caseId: 'C-h2' },
      ] as Array<Record<string, unknown>>
    ).map((e) => ({ ts: '', ...e }) as JournalEntry);
    const order = ['main_patched', 'module/c'];
    expect(publishableRecipe(journal, order, new Set())).toEqual(['main_patched', 'module/c']);
  });
});

describe('reopen-superseded cases (bug #63/#64 — every open-case reader)', () => {
  const j = (rows: Array<Record<string, unknown>>): JournalEntry[] =>
    rows.map((e) => ({ ts: '', ...e }) as JournalEntry);

  // The exact live shape: module/container-queue emits h169, its parent
  // resolves → the branch is reopened → a FRESH superset case h180 is emitted.
  const liveShape = (): JournalEntry[] =>
    j([
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-h169', head: { sha: 'aaa', height: 169 }, conflictedPaths: ['p1'] },
      { action: 'arrived', branch: 'module/x' },
      { action: 'reopened', branch: 'module/x' },
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-h180', head: { sha: 'bbb', height: 180 }, conflictedPaths: ['p1', 'p2'] },
      { action: 'arrived', branch: 'module/x' },
    ]);

  it('supersededCaseIds: the pre-reopen case is superseded; the post-reopen re-emit is not', () => {
    expect(supersededCaseIds(liveShape())).toEqual(new Set(['x-h169']));
  });

  it('openCases: serves ONLY the fresh case (the stale one would be served first → ERR02 loop, bug #63)', () => {
    const open = openCases(liveShape());
    expect(open.map((c) => c.caseId)).toEqual(['x-h180']);
  });

  it('a case RE-EMITTED under the SAME caseId after a reopen survives (last-entry, not firstIndex)', () => {
    const journal = j([
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-h5', head: { sha: 'a', height: 5 }, conflictedPaths: ['p1'] },
      { action: 'reopened', branch: 'module/x' },
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-h5', head: { sha: 'a', height: 5 }, conflictedPaths: ['p1'] }, // same id, re-emitted
    ]);
    expect(supersededCaseIds(journal)).toEqual(new Set());
    expect(openCases(journal).map((c) => c.caseId)).toEqual(['x-h5']);
  });

  it('a reopen that re-emits NOTHING (branch healed / merged clean / deferred) leaves no open case', () => {
    const journal = j([
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-h1', head: { sha: 'a', height: 1 }, conflictedPaths: ['p1'] },
      { action: 'reopened', branch: 'module/x' },
      { action: 'merge', branch: 'module/x', parent: 'main_patched' }, // clean re-merge, no new case
    ]);
    expect(supersededCaseIds(journal)).toEqual(new Set(['x-h1']));
    expect(openCases(journal)).toEqual([]);
  });

  it('a disposed case is not resurrected by a later reopen of its branch', () => {
    const journal = j([
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-h1', head: { sha: 'a', height: 1 }, conflictedPaths: ['p1'] },
      { action: 'resolved', branch: 'module/x', caseId: 'x-h1' },
      { action: 'reopened', branch: 'module/x' }, // reopens for descendants; x-h1 stays resolved
    ]);
    expect(openCases(journal)).toEqual([]);
  });
});

describe('propagate verify — publishable set', () => {
  it('(a1) a held branch that would conflict on the base is EXCLUDED — the pass stays green (fix 1)', async () => {
    const { repo } = divergedFixture();
    const ws = mkWorkspace();
    // module/held is held (journal); module/good advanced cleanly. DAG order lists
    // the held branch FIRST (like the real recipe whose head was a frozen module).
    const { wm12 } = seedVerifyPass(
      ws,
      repo,
      ['module/held', 'module/good'],
      [{ branch: 'module/good', ref: repo.sha('module/good') }],
      [{ action: 'held', branch: 'module/held', caseId: 'gate-x', height: -1, conflictedPaths: [] }],
    );
    // Heldness = the journaled `held` disposition above — the derived
    // blocked view reads the journal; no local state file is involved.
    const heldTip = repo.sha('module/held');
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    // Dry-run first: prove the derived recipe dropped module/held and the base is
    // bare `main` (no main_patched in this fixture).
    const out = join(ws, 'dry.json');
    await cmdVerify(baseCli(repo, ws, null, { cmd: 'verify', pass: wm12, commandsFile: cmds, out }));
    const dry = JSON.parse(readFileSync(out, 'utf8')) as { recipe: string[]; baseRef: string };
    expect(dry.recipe).toEqual(['module/good']);
    expect(dry.baseRef).toBe('main');
    // Execute: green despite module/held being unresolvable against the base.
    const code = await cmdVerify(
      baseCli(repo, ws, null, { cmd: 'verify', execute: true, pass: wm12, commandsFile: cmds }),
    );
    expect(code).toBe(0);
    const journal = readJournal(passDir(ws, wm12));
    expect(journal.some((e) => e.action === 'verify' && e.ok === true)).toBe(true);
    expect(journal.some((e) => e.action === 'verify-observation')).toBe(false); // never became an offender
    expect(repo.sha('module/held')).toBe(heldTip); // untouched — not rolled back
  });

  /**
   * A build conflict is journaled as a CONFLICT, with the evidence it has.
   *
   * The row that motivated this carried an offender, no failing commands, no
   * base verdict and no files — every evidence field empty, because none of them
   * applies before a single command runs. Read cold it is a branch accused of
   * nothing, and the only rows nearby holding filenames belong to other branches.
   * The conflicted paths ARE the evidence; they belong in the row that accuses.
   */
  it('a build-conflict red journals the conflict and its paths — not empty test-shaped fields', async () => {
    const repo = initFixtureRepo();
    cleanups.push(() => repo.destroy());
    repo.commit('base: x', { 'src/x.ts': 'base\n' });
    repo.checkout('module/a', { create: true, at: 'main' });
    repo.commit('a: x -> AAA', { 'src/x.ts': 'AAA\n' });
    repo.checkout('main');
    repo.checkout('module/b', { create: true, at: 'main' });
    repo.commit('b: x -> BBB', { 'src/x.ts': 'BBB\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const bTip = repo.sha('module/b');
    // Both advanced this pass, so the offender is PUBLISHABLE: the gate bites,
    // rolls it back to its pre-ref and freezes it HELD(gate).
    const { wm12 } = seedVerifyPass(
      ws,
      repo,
      ['module/a', 'module/b'],
      [
        { branch: 'module/a', ref: repo.sha('module/a') },
        { branch: 'module/b', ref: bTip },
      ],
    );
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const out = join(ws, 'o.json');
    // module/a merges, module/b collides with it on src/x.ts -> the build stops
    // there; the re-verify without module/b is green, so the command succeeds.
    const code = await cmdVerify(
      baseCli(repo, ws, null, {
        cmd: 'verify',
        execute: true,
        pass: wm12,
        commandsFile: cmds,
        out,
      }),
    );
    expect(code).toBe(0);
    const journal = readJournal(passDir(ws, wm12));
    const red = journal.find((e) => e.action === 'verify' && e.ok === false)!;
    expect(red).toMatchObject({
      offender: 'module/b',
      failureKind: 'merge-conflict',
      conflictBranch: 'module/b',
      unresolved: ['src/x.ts'],
      merged: ['module/a'],
    });
    // The test-shaped fields are ABSENT, not empty: no command ran, no base
    // probe ran, and an empty `failedCommands` reads as "the tests passed".
    expect(red.failedCommands).toBeUndefined();
    expect(red.baseGreen).toBeUndefined();
    expect(red.baseFailingFiles).toBeUndefined();
    // The freeze says why it froze, in the row that freezes.
    const gateHold = journal.find((e) => e.action === 'held' && e.reason === 'gate')!;
    expect(gateHold.branch).toBe('module/b');
    expect(gateHold.detail as string).toContain('could not be merged into the integration rebuild');
    expect(gateHold.detail as string).toContain('src/x.ts');
    // …and so does the result the agent reports from. `rolledBackFor`, not
    // `failureKind`: this result's `ok` is the RE-VERIFY without the offender,
    // and it is GREEN — naming the conflict as this verdict's kind would label a
    // green answer a merge conflict.
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      ok?: boolean;
      failureKind?: string;
      rolledBackFor?: string;
      unresolved?: string[];
      rolledBack?: string;
      reverify?: { ok: boolean };
    };
    expect(res).toMatchObject({
      ok: true,
      rolledBackFor: 'merge-conflict',
      unresolved: ['src/x.ts'],
      rolledBack: 'module/b',
      reverify: { ok: true },
    });
    expect(res.failureKind).toBeUndefined();
    // The post-rollback journal row follows the same rule.
    const rolled = journal.find((e) => e.action === 'verify' && e.rolledBack === 'module/b')!;
    expect(rolled.ok).toBe(true);
    expect(rolled.rolledBackFor).toBe('merge-conflict');
    expect(rolled.failureKind).toBeUndefined();
    expect(rolled.reverifyFailedCommands).toBeUndefined(); // green: nothing to name
  });

  it('(b) a module branch verifies against main_patched, not bare main (fix 1 base)', async () => {
    const { repo } = divergedFixture({ withMainPatched: true });
    const ws = mkWorkspace();
    const { wm12 } = seedVerifyPass(ws, repo, ['module/m'], [{ branch: 'module/m', ref: repo.sha('module/m') }]);
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    // Control: building module/m on BARE main recreates the fork-line conflict.
    const onMain = await verifyEverything(repo.dir, {
      recipe: ['module/m'],
      baseRef: 'main',
      commands: [{ cmd: 'true' }],
    });
    expect(onMain.ok).toBe(false);
    expect(onMain.build.conflictBranch).toBe('module/m');
    // cmdVerify picks main_patched (the merge-source base) -> clean -> green.
    const out = join(ws, 'dry.json');
    await cmdVerify(baseCli(repo, ws, null, { cmd: 'verify', pass: wm12, commandsFile: cmds, out }));
    expect((JSON.parse(readFileSync(out, 'utf8')) as { baseRef: string }).baseRef).toBe('main_patched');
    const code = await cmdVerify(
      baseCli(repo, ws, null, { cmd: 'verify', execute: true, pass: wm12, commandsFile: cmds }),
    );
    expect(code).toBe(0);
  });

  it('(c) the workspace rr-cache is installed before the rebuild, resolving a would-be conflict', async () => {
    const repo = initFixtureRepo();
    cleanups.push(() => repo.destroy());
    repo.commit('base: x', { 'src/x.ts': 'base\n' });
    repo.checkout('module/a', { create: true, at: 'main' });
    repo.commit('a: x -> AAA', { 'src/x.ts': 'AAA\n' });
    repo.checkout('main');
    repo.checkout('module/b', { create: true, at: 'main' });
    repo.commit('b: x -> BBB', { 'src/x.ts': 'BBB\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const RESOLUTION = 'RESOLVED\n';
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'grep -q RESOLVED src/x.ts' }]));

    // 1. Record the a-then-b resolution once, by hand, with rerere enabled.
    const rec = await addTempWorktree(repo.dir, 'main');
    try {
      repo.git('-C', rec.path, '-c', 'rerere.enabled=true', 'merge', '--no-edit', 'module/a'); // clean
      let conflict = false;
      try {
        repo.git(
          '-C',
          rec.path,
          '-c',
          'rerere.enabled=true',
          '-c',
          'rerere.autoUpdate=true',
          'merge',
          '--no-edit',
          'module/b',
        );
      } catch {
        conflict = true;
      }
      expect(conflict).toBe(true);
      writeFileSync(join(rec.path, 'src/x.ts'), RESOLUTION);
      repo.git('-C', rec.path, 'add', 'src/x.ts');
      repo.git('-C', rec.path, '-c', 'rerere.enabled=true', 'commit', '--no-edit', '--no-verify');
    } finally {
      await rec.remove();
    }
    // 2. Export the recorded resolution to the workspace rr-cache; drop the local cache.
    const rrFiles = await exportRrCache(repo.dir, {});
    expect(writeRrCacheDir(join(ws, 'rr-cache'), rrFiles)).toBeGreaterThan(0);
    rmSync(join(repo.dir, '.git/rr-cache'), { recursive: true, force: true });

    // 3. Control (no rr-cache): the a-then-b rebuild conflicts on module/b.
    const control = await verifyEverything(repo.dir, {
      recipe: ['module/a', 'module/b'],
      baseRef: 'main',
      commands: [{ cmd: 'true' }],
      rrCacheDir: null,
    });
    expect(control.ok).toBe(false);
    expect(control.build.conflictBranch).toBe('module/b');

    // 4. cmdVerify seeds .git/rr-cache from the workspace before the build -> replay.
    const { wm12 } = seedVerifyPass(
      ws,
      repo,
      ['module/a', 'module/b'],
      [
        { branch: 'module/a', ref: repo.sha('module/a') },
        { branch: 'module/b', ref: repo.sha('module/b') },
      ],
    );
    const code = await cmdVerify(
      baseCli(repo, ws, null, { cmd: 'verify', execute: true, pass: wm12, commandsFile: cmds }),
    );
    expect(code).toBe(0); // rerere replay resolved x -> RESOLVED, command passes
    expect(readJournal(passDir(ws, wm12)).some((e) => e.action === 'verify' && e.ok === true)).toBe(true);
  });

  it('(d) a REAL regression on a PUBLISHABLE branch still goes RED, rolls back + freezes (derived recipe)', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/base.ts': 'b\n' });
    repo.checkout('feat/off', { create: true, at: 'main' });
    repo.commit('feat/off: clean', { 'src/off.ts': 'ok\n' });
    const cleanTip = repo.sha('feat/off');
    repo.commit('feat/off: introduces BAD', { BAD: 'boom\n' }); // as if a pass merge landed BAD
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    // No --recipe: the recipe is DERIVED (feat/off advanced, not held) -> gate bites.
    const { wm12 } = seedVerifyPass(ws, repo, ['feat/off'], [{ branch: 'feat/off', ref: cleanTip }]);
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'test ! -f BAD' }]));
    const code = await cmdVerify(
      baseCli(repo, ws, null, { cmd: 'verify', execute: true, pass: wm12, commandsFile: cmds }),
    );
    expect(code).toBe(0); // re-verify green after the offender is rolled back + held
    const journal = readJournal(passDir(ws, wm12));
    expect(journal.some((e) => e.action === 'verify-observation')).toBe(false); // blocking gate path, not the non-blocking one
    expect(journal.filter((e) => e.action === 'verify').map((e) => e.ok)).toEqual([false, true]);
    expect(journal.some((e) => e.action === 'held' && e.branch === 'feat/off' && e.reason === 'gate')).toBe(true);
    expect(repo.sha('feat/off')).toBe(cleanTip); // rolled back to its pre-ref
    // The journaled gate hold blocks the branch for the rest of the pass.
    expect(existsSync(join(ws, 'sweep-ledger.json'))).toBe(false); // no durable local state
  });
});

// --- urging (posted by `push`) + unfreeze paths ------------------------------

/** Fake GitHub transport for cmdPush tests (closure checks + urge posting). */
/**
 * A fake origin for push tests. STATEFUL about comments: a POSTed comment is
 * served back by the next GET, because that is how origin behaves and the urge
 * dedup depends on it (the `sweep-urge` marker is the dedup
 * record). `comments` may be shared between two fakes to
 * model two pushes against ONE origin.
 */
function fakePushGithub(
  overrides: Record<string, { status: number; body: unknown }> = {},
  comments: Array<{ body: string }> = [],
): {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  comments: Array<{ body: string }>;
  factory: (token: string) => GithubTransport;
} {
  const state = {
    calls: [] as Array<{ method: string; path: string; body?: unknown }>,
    comments,
    factory: (_t: string): GithubTransport => ({
      async request(method, path, body) {
        state.calls.push({ method, path, body });
        for (const [key, res] of Object.entries(overrides)) {
          const [m, suffix] = key.split(' ');
          if (method === m && path.includes(suffix)) return res;
        }
        if (method === 'GET' && path.includes('/pulls?'))
          return { status: 200, body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12 }] };
        if (method === 'GET' && /\/pulls\/\d+$/.test(path))
          return { status: 200, body: { number: 12, merged: true, body: 'agent prose' } };
        if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) return { status: 200, body: { ok: true } };
        if (method === 'GET' && path.includes('/comments')) {
          // Page 1 serves everything; later pages are empty (ghPaginated stops).
          const page = /[?&]page=(\d+)/.exec(path)?.[1] ?? '1';
          return { status: 200, body: page === '1' ? state.comments : [] };
        }
        if (method === 'POST' && path.includes('/comments')) {
          state.comments.push({ body: String((body as { body?: unknown })?.body ?? '') });
          return { status: 201, body: { id: state.comments.length } };
        }
        return { status: 404, body: null };
      },
    }),
  };
  return state;
}

/** Append a fake green `verify` entry (the §9 gate; tests skip the real rebuild). */
function fakeGreenVerify(dir: string): void {
  appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ ts: new Date().toISOString(), action: 'verify', ok: true }) + '\n');
}

describe('propagate — blocked-branch urging is POSTED by push, once per NEW pending head (§8)', () => {
  /** The journal row `sweep start` derives from an unmerged origin fix/sweep ref with an open PR. */
  const originBlockedRow = (fixBranch: string, prNumber: number | null = null): Record<string, unknown> => ({
    action: 'origin-blocked',
    branch: 'main_patched',
    caseId: `origin:${fixBranch}`,
    fixBranch,
    headSha: null,
    prNumber,
  });
  const FIX = 'fix/sweep/main_patched--main-h1-deadbeef';

  it('run only detects; push posts the urge (comment + machine-block refresh + lastUrgedHead), suppresses, re-urges on a new head', async () => {
    const { repo } = conflictFixture(); // U0 util, U1 x conflict
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const wm12 = repo.sha('main').slice(0, 12);
    // Blocked from pass start (origin-derived): prNumber unknown — push
    // locates the PR by head branch.
    appendJournal(dir, originBlockedRow(FIX));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));

    // `run` never posts or journals urges (posting is push's job); the blocked
    // branch is skipped with an empty interval. Nothing merges, so the run
    // seals the pass — push attaches to it explicitly via --pass.
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(0);

    // push POSTS the urge: PR located by head branch, body PATCHed (the
    // machine block), comment POSTed, lastUrgedHead advanced (dedup cache).
    fakeGreenVerify(dir);
    const gh = fakePushGithub();
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile, pass: wm12 }), gh.factory)).toBe(0);
    const urges1 = readJournal(dir).filter((e) => e.action === 'urge');
    expect(urges1.length).toBe(1);
    expect(urges1[0].prNumber).toBe(12);
    expect(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/12'))).toBe(true);
    const comment = gh.calls.find((c) => c.method === 'POST' && c.path.includes('/comments'))!;
    expect(String((comment.body as { body: string }).body)).toContain('still blocked');
    // The dedup record is the COMMENT's own marker on origin — no local file.
    expect(String((comment.body as { body: string }).body)).toContain(`<!-- sweep-urge: ${repo.sha('main')} -->`);
    expect(existsSync(join(ws, 'sweep-ledger.json'))).toBe(false);

    // A second push suppresses — same origin, so it reads back its own marker.
    const gh2 = fakePushGithub({}, gh.comments);
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile, pass: wm12 }), gh2.factory)).toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(1);
    expect(gh2.calls.filter((c) => c.method === 'POST' && c.path.includes('/comments')).length).toBe(0);

    // A NEW pass with new upstream content re-urges once (posted by push). The
    // block arrives in the new pass's journal exactly as start re-derives it
    // from the still-unmerged origin ref (this time with the PR number known).
    repo.commit('U2: more util', { 'src/util2.ts': 'u2\n' });
    const wm12b = repo.sha('main').slice(0, 12);
    const dir2 = passDir(ws, wm12b);
    appendJournal(dir2, originBlockedRow(FIX, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const gh3 = fakePushGithub();
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile, pass: wm12b }), gh3.factory)).toBe(0);
    const urgesNew = readJournal(dir2).filter((e) => e.action === 'urge');
    expect(urgesNew.length).toBe(1);
    expect(urgesNew[0].head).toBe(repo.sha('main')); // newest head (U2)
  });

  it('a failed urge post is ERR17 and does NOT advance lastUrgedHead (retries next push)', async () => {
    const { repo } = conflictFixture();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const wm12 = repo.sha('main').slice(0, 12);
    appendJournal(dir, originBlockedRow(FIX, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    fakeGreenVerify(dir);
    const gh = fakePushGithub({ 'POST /comments': { status: 500, body: { message: 'boom' } } });
    const out = join(ws, 'push-out.json');
    expect(
      await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile, out, pass: wm12 }), gh.factory),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR17_URGE_FAILED')).toBe(true);
    expect(existsSync(join(ws, 'sweep-ledger.json'))).toBe(false); // urge dedup is origin-derived now
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(0);
  });
});

describe('propagate push — verify-gated pass pushes (§14.4)', () => {
  it('refuses without a green verify (ERR18); with it, pushes mutated targets (one push per branch) and journals them', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const preTip = repo.sha('main_patched');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true })); // merges the U0 prefix, gates on U1
    const localTip = repo.sha('main_patched');
    expect(localTip).not.toBe(preTip); // the prefix merge landed locally

    // Dry-run: pure report, no pushes.
    const outDry = join(ws, 'push-dry.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', out: outDry }))).toBe(0);
    const dry = JSON.parse(readFileSync(outDry, 'utf8')) as { verifyGreen: boolean; wouldPush: string[] };
    expect(dry.verifyGreen).toBe(false);
    expect(dry.wouldPush).toEqual(['main_patched']);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(preTip); // untouched

    // Execute without green verify: ERR18, nothing pushed.
    const out1 = join(ws, 'push-1.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, out: out1 }))).toBe(1);
    expect(
      (JSON.parse(readFileSync(out1, 'utf8')) as { issues: Array<{ id: string }> }).issues.some(
        (i) => i.id === 'ERR18_VERIFY_PENDING',
      ),
    ).toBe(true);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(preTip);

    // Green verify -> the target push lands on origin and is journaled.
    fakeGreenVerify(dir);
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true }))).toBe(0);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(localTip);
    const pushes = readJournal(dir).filter((e) => e.action === 'push');
    expect(pushes.length).toBe(1);
    expect(pushes[0].branch).toBe('main_patched');
    expect(pushes[0].kind).toBe('target');

    // A second push is a no-op (up-to-date skip, journaled).
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true }))).toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'push').length).toBe(1);
    expect(readJournal(dir).some((e) => e.action === 'push-skip' && e.reason === 'up-to-date')).toBe(true);
  });

  it('a failing target push is ERR15 PER BRANCH (categorized `push-failed`) — reported, journaled, NO hard-halt row; the branch retries next run', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    fakeGreenVerify(dir);
    // Break the transport (simulates the credential-proxy failure mode)
    // DETERMINISTICALLY: a dead local path — never the real github.com.
    repo.breakOriginTransport(bare);
    const out = join(ws, 'push-out.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      issues: Array<{ id: string; detail: string }>;
      failed: Array<{ branch: string; category: string }>;
    };
    const issue = res.issues.find((i) => i.id === 'ERR15_PUSH_FAILED');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('report to the owner');
    expect(issue!.detail).toContain('retries on the next finish');
    // Per-branch categorized failure, ERR15 as the LABEL — never a stop.
    expect(res.failed.length).toBe(1);
    expect(res.failed[0].branch).toBe('main_patched');
    expect(res.failed[0].category).toBe('transient'); // dead local path -> deterministic category
    const journal = readJournal(dir);
    expect(
      journal.some((e) => e.action === 'push-failed' && e.branch === 'main_patched' && e.id === 'ERR15_PUSH_FAILED'),
    ).toBe(true);
    expect(journal.some((e) => e.action === 'halt' && e.id === 'ERR15_PUSH_FAILED')).toBe(false);
    // RESUMABLE: fix the transport, re-push -> the failed branch lands.
    repo.healOriginTransport(bare);
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true }))).toBe(0);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
  });

  it('a pre-receive-hook / branch-protection rejection is categorized `rejected` (NOT `diverged`) and journals the owner-escalation row (finding 3)', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    fakeGreenVerify(dir);
    // A REAL declining pre-receive hook on the bare origin (the branch-
    // protection shape): git reports "[remote rejected] … (pre-receive hook
    // declined)" AND "failed to push some refs" — which the old categorizer
    // mislabeled `diverged`.
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch: main_patched" >&2\nexit 1\n', {
      mode: 0o755,
    });
    const out = join(ws, 'push-out.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      failed: Array<{ branch: string; category: string; detail: string }>;
    };
    expect(res.failed.length).toBe(1);
    expect(res.failed[0].branch).toBe('main_patched');
    expect(res.failed[0].category).toBe('rejected');
    expect(res.failed[0].detail).toContain('cannot heal by retrying');
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'push-failed' && e.branch === 'main_patched' && e.category === 'rejected')).toBe(true);
    // Owner-action-required: the DISTINCT escalation row (surfaced by finish
    // as needsOwner) — and never a halt, never a force-resolve.
    expect(journal.some((e) => e.action === 'push-escalated' && e.branch === 'main_patched' && e.category === 'rejected')).toBe(true);
    expect(journal.some((e) => e.action === 'halt')).toBe(false);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).not.toBe(repo.sha('main_patched')); // origin untouched
  });

  it('JUDGED closure check: a PR that did not flip to merged after the target push is ERR16', async () => {
    const { repo } = conflictFixture();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    // Fake a published JUDGED PR for this pass (#21).
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'pr-published', caseId: 'x', mode: 'judged', number: 21 }) + '\n',
    );
    fakeGreenVerify(dir);
    // merged: true -> ok (closure confirmed).
    const ghOk = fakePushGithub({ 'GET /pulls/21': { status: 200, body: { number: 21, merged: true } } });
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile }), ghOk.factory)).toBe(0);
    // merged: false -> ERR16 (fresh pass state: reuse the journal, drop the green verify staleness by re-adding).
    const ghOpen = fakePushGithub({ 'GET /pulls/21': { status: 200, body: { number: 21, merged: false, state: 'open' } } });
    const out = join(ws, 'push-out.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile, out }), ghOpen.factory)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR16_CLOSURE_FAILED')).toBe(true);
  });
});

// --- B6: checked-out worktree dirty-check + abort ---------------------------
describe('propagate — B6: journaledMerge guards the checked-out worktree', () => {
  it('halts (does not touch) when the target worktree is dirty', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // clean merge available for main_patched
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    // Check out main_patched in a worktree and dirty it.
    const wtPath = mkdtempSync(join(tmpdir(), 'b6-wt-'));
    repo.git('worktree', 'add', wtPath, 'main_patched');
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted\n');
    cleanups.push(() => {
      try {
        repo.git('worktree', 'remove', '--force', wtPath);
      } catch {
        /* ignore */
      }
    });

    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const before = repo.sha('main_patched');
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(1);
    expect(repo.sha('main_patched')).toBe(before); // not touched
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.reason === 'dirty-worktree')).toBe(true);
    expect(repo.git('-C', wtPath, 'status', '--porcelain')).toContain('dirty.txt'); // worktree not stranded mid-merge
  });
});

// --- B7: forced un-skip at coverage -1 (fork-only) --------------------------
describe('propagate — B7: leaf un-skip completes when the forced parent has no chain coverage', () => {
  it('a forced merge with height -1 passes step verification', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: f', { 'src/f.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: f = fork', { 'src/f.ts': 'fork\n' }); // main_patched conflicts with U0 -> stays coverage -1
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('feat/a: own', { 'src/a.ts': 'a\n' });
    repo.checkout('feat/b', { create: true, at: 'feat/a' });
    repo.commit('feat/b: own', { 'src/b.ts': 'b\n' });
    repo.checkout('main');
    repo.commit('U0: f = up1', { 'src/f.ts': 'up1\n' }); // progress; conflicts main_patched
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['feat/a'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    // main_patched gates on its own U0 conflict, but the feat/b leaf un-skip must
    // still complete (forced merges at height -1, main_patched coverage -1).
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.reason === 'step-verification-failed')).toBe(false);
    const forced = readJournal(dir).filter((e) => e.action === 'merge' && e.forced === true);
    expect(forced.map((e) => e.branch).sort()).toEqual(['feat/a', 'feat/b']);
    expect((await commitInfo(repo.dir, 'feat/b')).parents.length).toBe(2);
  });
});

// --- N4: dry-run purity -----------------------------------------------------
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

describe('propagate — N4: dry-run run makes NO state changes', () => {
  it('leaves the workspace byte-identical', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const before = snapshotTree(ws);
    // Dry-run run (no --execute): must not write anything.
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: false }))).toBe(0);
    expect(snapshotTree(ws)).toEqual(before);
    const mpBefore = repo.sha('main_patched');
    expect(repo.sha('main_patched')).toBe(mpBefore); // no merges either
  });
});

// --- N1: protected-ref guard at the write choke point -----------------------
describe('propagate — N1: protected-ref guard refuses at the write', () => {
  it('refuses protected namespaces and out-of-scope branches; allows in-scope + fix/sweep', () => {
    const scope = new Set(['feat/in', 'main_patched']);
    for (const bad of ['main', 'design/x', 'maint/y', 'everything', 'test/z']) {
      expect(() => guardRef(bad, scope)).toThrow(DriverHalt);
    }
    expect(() => guardRef('feat/out', scope)).toThrow(/outside the pass/);
    expect(() => guardRef('feat/in', scope)).not.toThrow();
    // fix/sweep/* is scope-exempt (new) but still namespace-checked.
    expect(() => guardRef('fix/sweep/2026-x', new Set(), { fixSweep: true })).not.toThrow();
    expect(() => guardRef('main', new Set(), { fixSweep: true })).toThrow(/protected/);
  });
});

// --- SPEC 1: driver-created resolution worktree -----------------------------
describe('propagate — SPEC 1: resolution worktree created at case emission, removed on resolve', () => {
  it('re-emitting a case recreates the worktree idempotently (no "already registered" failure)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const wtPath = join(dir, caseId, 'worktree');
    expect(existsSync(wtPath)).toBe(true);

    // The worktree + its git registration persist; force the branch to be
    // re-processed (as a reopen/re-emit would) by dropping its `arrived` marker.
    // createCaseWorktree is then called AGAIN on the already-registered path —
    // which must recover, not fail with "missing but already registered"/"already exists".
    stripJournal(dir, new Set(['arrived']));
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);

    // Idempotent recovery: a fresh worktree with the conflict markers, no failure warning.
    expect(readFileSync(join(wtPath, 'src/x.ts'), 'utf8')).toContain('<<<<<<<');
    const wtWarns = readJournal(dir).filter(
      (e) => e.action === 'warning' && String(e.message ?? '').includes('case worktree creation failed'),
    );
    expect(wtWarns).toEqual([]);
  });
});

// --- N1: checked-out-branch safety for ALL ref writers ----------------------
/** Check `branch` out in a throwaway worktree (auto-removed). */
function addBranchWorktree(repo: FixtureRepo, branch: string): string {
  const wtPath = mkdtempSync(join(tmpdir(), 'n1-wt-'));
  repo.git('worktree', 'add', wtPath, branch);
  cleanups.push(() => {
    try {
      repo.git('worktree', 'remove', '--force', wtPath);
    } catch {
      /* ignore */
    }
  });
  return wtPath;
}

describe('propagate — N1: ref writers keep a checked-out branch worktree consistent', () => {
  it('verify rollback on a checked-out branch resets its worktree to the pre-ref', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/base.ts': 'b\n' });
    repo.checkout('feat/off', { create: true, at: 'main' });
    repo.commit('feat/off: clean', { 'src/off.ts': 'ok\n' });
    const cleanTip = repo.sha('feat/off');
    repo.commit('feat/off: introduces BAD', { BAD: 'boom\n' });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());
    const wtPath = addBranchWorktree(repo, 'feat/off'); // checked out at the BAD tip

    const ws = mkWorkspace();
    const { wm12 } = seedVerifyPass(ws, repo, ['feat/off'], [{ branch: 'feat/off', ref: cleanTip }]);
    const cmdsFile = join(ws, 'cmds.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'test ! -f BAD' }]));

    expect(
      await cmdVerify(
        baseCli(repo, ws, null, {
          cmd: 'verify',
          execute: true,
          pass: wm12,
          commandsFile: cmdsFile,
        }),
      ),
    ).toBe(0);
    expect(repo.sha('feat/off')).toBe(cleanTip); // rolled back
    // The checked-out worktree followed the rollback: BAD gone, clean, HEAD == pre-ref.
    expect(existsSync(join(wtPath, 'BAD'))).toBe(false);
    expect(repo.git('-C', wtPath, 'status', '--porcelain')).toBe('');
    expect(repo.git('-C', wtPath, 'rev-parse', 'HEAD')).toBe(cleanTip);
  });
});

// --- B4: merge + defer combined verdict (§5) + origin-rebuilt HELD (N3) ------
describe('propagate run — B4: clean-prefix merge with a DEFERRED conflict above it', () => {
  it('journals BOTH the merge and the defer pointer behind a blocked DIRECT parent', async () => {
    // Direct-parent MIN rule: the "clean-prefix merge + defer above" case is
    // multi-parent. feat/c = feat/a + feat/b: the conflict at h1 arrives via the
    // ADVANCED parent feat/b, and is deferred behind the BLOCKED parent feat/a
    // (blocked at h1, its tip lacks u1 so it stays frozen — no auto-unfreeze).
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' }); // blocked parent
    repo.checkout('feat/b', { create: true, at: 'main_patched' }); // advanced parent
    repo.checkout('feat/c', { create: true, at: 'main_patched' });
    repo.commit('c: x = cfork', { 'src/x.ts': 'cfork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // height 0
    const u1 = repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }); // height 1
    // feat/a stops at h0 (its tip does NOT contain u1 -> stays frozen); feat/b
    // advances to h1, carrying the conflicting x change into feat/c.
    repo.checkout('feat/a');
    repo.git('merge', '--no-edit', '-m', 'a merges U0', u0);
    repo.checkout('feat/b');
    repo.git('merge', '--no-edit', '-m', 'b merges U0', u0);
    repo.git('merge', '--no-edit', '-m', 'b merges U1', u1);
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      { id: 'c', branch: 'feat/c', parents: ['feat/a', 'feat/b'] },
    ]);
    // Cross-pass block: feat/a carries an origin-blocked journal row
    // whose headSha is u1 (as a fix/sweep ref head would contain it) — the
    // block height is RE-DERIVED from it against this pass's chain (h1).
    // feat/c's h1 conflict (via feat/b) is at height 1 >= MIN(feat/a=1) ->
    // DEFERRED behind the DIRECT parent feat/a.
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'feat/a',
      caseId: 'origin:fix/sweep/feat__a--main_patched-h1-deadbeef',
      fixBranch: 'fix/sweep/feat__a--main_patched-h1-deadbeef',
      headSha: u1,
      prNumber: 12,
    });
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);

    const journal = readJournal(dir);
    // feat/c: the clean-prefix merge (h0, util via feat/a) AND the defer behind
    // the blocked DIRECT parent feat/a; NO own case emitted.
    const merge = journal.find((e) => e.action === 'merge' && e.branch === 'feat/c');
    expect(merge).toBeTruthy();
    const defer = journal.find((e) => e.action === 'defer' && e.branch === 'feat/c');
    expect(defer).toBeTruthy();
    expect(defer!.deferredTo).toBe('feat/a');
    // Deferred, not an own case: NO PR, no case emitted.
    expect(journal.some((e) => e.action === 'case' && e.branch === 'feat/c')).toBe(false);
    // The prefix content landed; the disputed height did not.
    expect(repo.git('show', 'feat/c:src/util.ts')).toBe('u');
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('cfork');
  });
});

// --- B5i: crash between ref-update and journal append ------------------------
/** Drop every journal entry whose action is in `actions` (simulated crash). */
function stripJournal(dir: string, actions: Set<string>): void {
  const path = join(dir, 'journal.jsonl');
  const kept = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !actions.has((JSON.parse(l) as { action: string }).action));
  writeFileSync(path, kept.join('\n') + '\n');
}

// --- B11: multi-parent TOCTOU — execution re-probe + demotion ----------------
describe('propagate run — B11: stale clean verdict re-probed at execution', () => {
  it('re-probe that turns NO-OP demotes merge -> skip (§6 tree equality), journaled', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: f', { 'src/f.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/qa', { create: true, at: 'main_patched' });
    repo.commit('qa: f = X', { 'src/f.ts': 'X\n' });
    repo.checkout('main_patched');
    repo.checkout('feat/qb', { create: true, at: 'main_patched' });
    repo.commit('qb: f = X (identical change, distinct commit)', { 'src/f.ts': 'X\n' });
    repo.checkout('main_patched');
    repo.checkout('feat/kid', { create: true, at: 'main_patched' });
    repo.commit('kid: own file', { 'src/k.ts': 'k\n' });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'qa', branch: 'feat/qa', parents: ['main_patched'] },
      { id: 'qb', branch: 'feat/qb', parents: ['main_patched'] },
      { id: 'kid', branch: 'feat/kid', parents: ['feat/qa', 'feat/qb'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);

    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    const journal = readJournal(dir);
    // qa landed as the only real merge; qb's verdict (a real merge at derivation)
    // became a genuine no-op once qa's identical content landed.
    expect(journal.filter((e) => e.action === 'merge' && e.branch === 'feat/kid').map((e) => e.parent)).toEqual([
      'feat/qa',
    ]);
    const demoted = journal.find((e) => e.action === 'demoted' && e.branch === 'feat/kid')!;
    expect(demoted.parent).toBe('feat/qb');
    expect(demoted.to).toBe('skip');
    expect(demoted.conflictedPaths).toEqual([]); // clean re-probe, just tree-equal
    expect(
      journal.some(
        (e) => e.action === 'skip' && e.branch === 'feat/kid' && e.parent === 'feat/qb' && e.reason === 'no-op',
      ),
    ).toBe(true);
    expect(journal.some((e) => e.action === 'case' && e.branch === 'feat/kid')).toBe(false);
    expect(repo.git('show', 'feat/kid:src/f.ts')).toBe('X');
  });
});

// --- focused resolution cold read + fail-closed UNVERIFIABLE -----------------
describe('propagate resolve — focused cold-read contract', () => {
  it('request carries the three bounded questions + the judge-from-request preamble; there is no open-ended Q4', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;

    const request = readFileSync(join(dir, caseId, 'coldread-request.md'), 'utf8');
    // Preamble (verbatim intent).
    expect(request).toContain('Judge ONLY from the materials in this request');
    expect(request).toContain('UNVERIFIABLE-FROM-REQUEST');
    // Exactly the three bounded questions.
    expect(request).toMatch(/^1\. Within the conflicted hunks/m);
    expect(request).toMatch(/^2\. Is every change in the resolution diff explained by the conflict/m);
    expect(request).toMatch(/^3\. Does the resolution contradict any record/m);
    // No open-ended, universe-researcher fourth question.
    expect(request).not.toContain('follow-on invariants');
    expect(request).not.toMatch(/^4\./m);
  });

});

// --- rerere.enabled set repo-wide, journaled once ----------------------------
describe('propagate run — repo-wide rerere.enabled, idempotent journaling', () => {
  it('enables rerere.enabled in the clone before the first mutation and journals it exactly once', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    // The clone starts without the config.
    expect(repo.git('config', '--default', '', '--get', 'rerere.enabled')).toBe('');

    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    expect(repo.git('config', '--default', '', '--get', 'rerere.enabled')).toBe('true');
    expect(readJournal(dir).filter((e) => e.action === 'rerere-enabled').length).toBe(1);

    // A second execute run (config already true) does NOT re-journal.
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'rerere-enabled').length).toBe(1);
  });
});

// --- derived merge_status — BECOME re-runs / release cascade E2E -------------
describe('derived merge_status — blocked view from origin rows + journal', () => {
  it('defer behind an origin-blocked parent; re-derives (BECOME re-runs) next pass; a resolved block releases C to its own case', async () => {
    // Same shape as B4: C = A + B; A is PR_ID-blocked at h1 (u1), B advanced
    // through u1, so C's conflict (via B) at h1 defers behind A.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main'); // pinned fork point: heights stay comparable across passes
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.checkout('feat/b', { create: true, at: 'main_patched' });
    repo.checkout('feat/c', { create: true, at: 'main_patched' });
    repo.commit('c: x = cfork', { 'src/x.ts': 'cfork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    const u1 = repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    repo.checkout('feat/a');
    repo.git('merge', '--no-edit', '-m', 'a merges U0', u0);
    repo.checkout('feat/b');
    repo.git('merge', '--no-edit', '-m', 'b merges U0', u0);
    repo.git('merge', '--no-edit', '-m', 'b merges U1', u1);
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const ledgerPath = join(ws, 'sweep-ledger.json'); // must never be created
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      { id: 'c', branch: 'feat/c', parents: ['feat/a', 'feat/b'] },
    ]);
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { base, ...o });
    const blockRow = {
      action: 'origin-blocked',
      branch: 'feat/a',
      caseId: 'origin:fix/sweep/feat__a--main_patched-h1-deadbeef',
      fixBranch: 'fix/sweep/feat__a--main_patched-h1-deadbeef',
      headSha: u1, // ref head contains the conflict head -> height re-derives to 1
      prNumber: 12,
    };

    // PASS 1: A blocked (origin row); C hits its conflict at h1 >= MIN(A@h1)
    // -> DEFER (journal row = the state; nothing durable is written).
    const dir1 = passDir(ws, repo.sha('main').slice(0, 12));
    appendJournal(dir1, blockRow);
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(readJournal(dir1).some((e) => e.action === 'defer' && e.branch === 'feat/c')).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false); // no durable local state
    expect(existsSync(ledgerPath)).toBe(false); // no durable local state
    // No case/PR for the deferred branch.
    expect(readJournal(dir1).some((e) => e.action === 'case' && e.branch === 'feat/c')).toBe(false);
    const cTipDeferred = repo.sha('feat/c');

    // PASS 2 (new upstream head): nothing is stored — start re-derives A's
    // block from the still-unmerged origin ref, and C's BECOME re-runs: the
    // same conflict re-probes and re-defers. C takes nothing, emits no case.
    repo.commit('U2: more util', { 'src/util2.ts': 'u2\n' });
    const dir2 = passDir(ws, repo.sha('main').slice(0, 12));
    appendJournal(dir2, blockRow);
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(readJournal(dir2).some((e) => e.action === 'defer' && e.branch === 'feat/c')).toBe(true);
    expect(readJournal(dir2).some((e) => e.action === 'case' && e.branch === 'feat/c')).toBe(false);
    expect(repo.sha('feat/c')).toBe(cTipDeferred); // took NOTHING while deferred

    // OWNER completes A: its tip comes to contain u1 (the PR merge landed),
    // resolving x to owner-chosen content that CONFLICTS with C's cfork — so
    // C's fresh re-merge hits its own new conflict ("gets hit another PR").
    repo.checkout('feat/a');
    repo.commit('tmp: owner resolution content', { 'src/x.ts': 'owner\n' });
    const aResolvedTree = repo.git('rev-parse', 'feat/a^{tree}');
    repo.git('reset', '--hard', 'HEAD~1');
    const aTip = repo.sha('feat/a');
    const aMerged = repo.git('commit-tree', aResolvedTree, '-p', aTip, '-p', u1, '-m', 'owner merged the resolution PR');
    repo.git('reset', '--hard', aMerged);
    repo.checkout('main');

    // PASS 3: start would find the fix ref MERGED into origin/feat/a ->
    // resolved + deleted -> NO origin-blocked row this pass. A derives
    // unblocked; C re-merges FRESH and hits its own conflict vs the resolved
    // content -> its own case this time ("gets hit another PR").
    repo.commit('U3: even more util', { 'src/util3.ts': 'u3\n' });
    const dir3 = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    const cCase = readJournal(dir3).find((e) => e.action === 'case' && e.branch === 'feat/c');
    expect(cCase).toBeTruthy(); // fresh re-merge -> own conflict -> own PR path
    expect(readJournal(dir3).some((e) => e.action === 'skip' && e.branch === 'feat/a' && e.reason === 'held')).toBe(
      false,
    ); // A is unblocked
    // A case alone does not block; only held/defer do. C is mid-case (open) —
    // the OPEN CASE gates the pass; no local state file is ever created.
    expect(existsSync(ledgerPath)).toBe(false); // no durable local state
  });

  it('a branch with TWO concurrent blocks contributes its LOWEST height to descendants (finding #4 — no last-row collapse)', async () => {
    // feat/a carries TWO origin-blocked rows (multi-parent → several concurrent
    // held PRs): one at h0 (u0) and one at h1 (u1), journaled in that order so
    // a last-writer-wins map would keep the HIGHER h1 row. feat/c's conflict
    // (via either parent line) sits at h0: the DEFER height-MIN must compare
    // against MIN(h0, h1) = h0 — with the collapsed h1 row the h0 conflict
    // would wrongly pass as C's own case instead of deferring behind A.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main');
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.checkout('feat/b', { create: true, at: 'main_patched' });
    repo.checkout('feat/c', { create: true, at: 'main_patched' });
    repo.commit('c: x = cfork', { 'src/x.ts': 'cfork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: x = up0', { 'src/x.ts': 'up0\n' }); // h0 — the conflicting height
    const u1 = repo.commit('U1: util', { 'src/util.ts': 'u\n' }); // h1 — clean
    repo.checkout('feat/a');
    repo.git('merge', '--no-edit', '-m', 'a merges U0', u0);
    repo.checkout('feat/b');
    repo.git('merge', '--no-edit', '-m', 'b merges U0', u0);
    repo.git('merge', '--no-edit', '-m', 'b merges U1', u1);
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      { id: 'c', branch: 'feat/c', parents: ['feat/a', 'feat/b'] },
    ]);
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { base, ...o });
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'feat/a',
      caseId: 'origin:fix/sweep/feat__a--main_patched-h0-cafecafe',
      fixBranch: 'fix/sweep/feat__a--main_patched-h0-cafecafe',
      headSha: u0, // block at h0 — the LOWER (safest) height
      prNumber: 12,
    });
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'feat/a',
      caseId: 'origin:fix/sweep/feat__a--main_patched-h1-deadbeef',
      fixBranch: 'fix/sweep/feat__a--main_patched-h1-deadbeef',
      headSha: u1, // block at h1 — the LATER journal row (the old collapse survivor)
      prNumber: 13,
    });
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);

    const journal = readJournal(dir);
    // C DEFERS behind A (its h0 conflict >= MIN(h0, h1)) — it does NOT get its
    // own case (with the collapsed h1 row it wrongly would).
    expect(journal.some((e) => e.action === 'defer' && e.branch === 'feat/c')).toBe(true);
    expect(journal.some((e) => e.action === 'case' && e.branch === 'feat/c')).toBe(false);
  });
});

// --- STAY rule over ALL direct parents (journal fixpoint view) ---------------
describe('derived DEFERRED — stays while ANY direct parent is blocked (STAY as a journal fixpoint)', () => {
  /** feat/a + feat/b -> feat/x, all cut from main_patched with no divergence. */
  function dagFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.checkout('feat/b', { create: true, at: 'main_patched' });
    repo.checkout('feat/x', { create: true, at: 'main_patched' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // pass progress
    cleanups.push(() => repo.destroy());
    return repo;
  }
  const inventory = (): string =>
    writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      { id: 'x', branch: 'feat/x', parents: ['feat/a', 'feat/b'] },
    ]);

  it('a journaled defer keeps X DEFERRED while a SIBLING parent (not the recorded deferredTo) is still blocked', async () => {
    const repo = dagFixture();
    const ws = mkWorkspace();
    const inv = inventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    // X deferred earlier this pass behind feat/a; feat/a has NO blocked row
    // (cleared), but the SIBLING parent feat/b is origin-blocked — the fixpoint
    // view keeps X DEFERRED off ALL direct parents, not the recorded pointer.
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'feat/b',
      caseId: 'origin:fix/sweep/feat__b--main_patched-h5-deadbeef',
      fixBranch: 'fix/sweep/feat__b--main_patched-h5-deadbeef',
      headSha: null,
      prNumber: 12,
    });
    appendJournal(dir, { action: 'defer', branch: 'feat/x', parent: 'feat/a', deferredTo: 'feat/a' });
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const xTip = repo.sha('feat/x');
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    expect(
      readJournal(dir).some((e) => e.action === 'skip' && e.branch === 'feat/x' && e.reason === 'deferred'),
    ).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'merge' && e.branch === 'feat/x')).toBe(false);
    expect(repo.sha('feat/x')).toBe(xTip); // took nothing while sticky
  });

  it('with NO blocked parent the stale defer row clears in the fixpoint and X processes normally', async () => {
    const repo = dagFixture();
    const ws = mkWorkspace();
    const inv = inventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    appendJournal(dir, { action: 'defer', branch: 'feat/x', parent: 'feat/a', deferredTo: 'feat/a' });
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    // No sticky suppression: X is processed (merges its parents' fresh tips).
    expect(
      readJournal(dir).some((e) => e.action === 'skip' && e.branch === 'feat/x' && e.reason === 'deferred'),
    ).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'merge' && e.branch === 'feat/x')).toBe(true);
  });
});

// --- §6 un-skip vs blocked branches on the LIVE run path ---------------------
describe('propagate run — un-skip never force-merges into/through a blocked branch', () => {
  it('a leaf whose only chain passes a DEFERRED intermediate aborts the un-skip (no forced merges)', async () => {
    // leaf feat/l -> feat/d -> entry main_patched; main_patched is PR_ID-
    // blocked (gate hold) which keeps feat/d sticky-DEFERRED; U0 gives the
    // pass progress so the leaf un-skip rule fires.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/d', { create: true, at: 'main_patched' });
    repo.checkout('feat/l', { create: true, at: 'feat/d' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'd', branch: 'feat/d', parents: ['main_patched'] },
      { id: 'l', branch: 'feat/l', parents: ['feat/d'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    // Journal-derived blocks: main_patched PR_ID (origin row, gate-like —
    // no head/PR), feat/d DEFERRED (a journaled defer behind the blocked parent;
    // the fixpoint view keeps it sticky while main_patched is blocked).
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'main_patched',
      caseId: 'origin:fix/sweep/main_patched--main-h0-deadbeef',
      fixBranch: 'fix/sweep/main_patched--main-h0-deadbeef',
      headSha: null,
      prNumber: 12,
    });
    appendJournal(dir, { action: 'defer', branch: 'feat/d', parent: 'main_patched', deferredTo: 'main_patched' });

    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const dTip = repo.sha('feat/d');
    const lTip = repo.sha('feat/l');
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);

    const journal = readJournal(dir);
    // The blocked intermediate took NOTHING — no merge landed on or through it.
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'feat/d')).toBe(false);
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'feat/l' && e.forced === true)).toBe(false);
    expect(repo.sha('feat/d')).toBe(dTip);
    expect(repo.sha('feat/l')).toBe(lTip);
    // Both still arrive (the leaf simply stays skipped this pass), and the
    // leaf's skip carries the sanctioned 'unskip-blocked' reason (the step
    // verifier's leaf-rule exemption).
    expect(journal.some((e) => e.action === 'arrived' && e.branch === 'feat/l')).toBe(true);
    expect(journal.some((e) => e.action === 'skip' && e.branch === 'feat/l' && e.reason === 'unskip-blocked')).toBe(
      true,
    );
  });
});

// --- §6 un-skip conflict pre-probe on the LIVE run path ----------------------
describe('propagate run — un-skip aborts when a chain hop genuinely conflicts (no ERR21)', () => {
  it('a conflicting intermediate hop aborts the un-skip; the hop branch keeps its OWN case; rc 0', async () => {
    // leaf feat/l -> feat/m -> entry main_patched. The entry merges U0 cleanly
    // at its own step (tip MOVES), feat/m then genuinely conflicts with the
    // moved tip (its own case, NOT a blocked merge_status), while feat/l is
    // up-to-date with feat/m — the leaf un-skip fires and its ONLY chain runs
    // THROUGH the conflicting hop. Unguarded, the forced feat/m <- main_patched
    // merge reaches clean-only commitTreeMerge -> ERR21 hard-halt.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/m', { create: true, at: 'main_patched' });
    repo.commit('feat/m: x = mfork', { 'src/x.ts': 'mfork\n' });
    repo.checkout('feat/l', { create: true, at: 'feat/m' });
    repo.commit('feat/l: own', { 'src/l.ts': 'l\n' });
    repo.checkout('main');
    repo.commit('U0: x = up0', { 'src/x.ts': 'up0\n' }); // progress; conflicts feat/m only
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'm', branch: 'feat/m', parents: ['main_patched'] },
      { id: 'l', branch: 'feat/l', parents: ['feat/m'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const mTip = repo.sha('feat/m');
    const lTip = repo.sha('feat/l');
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);

    const journal = readJournal(dir);
    // The un-skip ABORTED: no forced merge journaled anywhere, no halt of any
    // kind (in particular no ERR21_MERGE_FAILED and no step-verification-failed
    // — the all-skip is sanctioned), and no tip moved.
    expect(journal.some((e) => e.action === 'merge' && e.forced === true)).toBe(false);
    expect(journal.some((e) => e.action === 'halt')).toBe(false);
    expect(repo.sha('feat/m')).toBe(mTip);
    expect(repo.sha('feat/l')).toBe(lTip);
    // The conflicting hop branch is handled by its OWN normal case derivation
    // — exactly one case, never double-handled by the un-skip.
    expect(journal.some((e) => e.action === 'case' && e.branch === 'feat/m')).toBe(true);
    expect(journal.filter((e) => e.action === 'case').length).toBe(1);
    // The leaf arrives all-skip with the sanctioned conflict-abort reason.
    expect(journal.some((e) => e.action === 'arrived' && e.branch === 'feat/l')).toBe(true);
    expect(
      journal.some((e) => e.action === 'skip' && e.branch === 'feat/l' && e.reason === 'unskip-conflict'),
    ).toBe(true);
  });
});

describe('coldReadWithRetry (ERR35 transient auth — delay + retry, auth is auto-refreshed)', () => {
  const authErr = (): MachineVerdict => ({ verdict: 'error', notes: '', reason: 'cold read auth/login failure: Not logged in' });
  it('retries an infra/auth error and returns the first CONTENT verdict once auth recovers', async () => {
    let n = 0;
    const attempt = (): MachineVerdict => {
      n += 1;
      return n < 3 ? authErr() : { verdict: 'confirm', notes: 'ok' };
    };
    const v = await coldReadWithRetry(attempt, [0, 0, 0, 0]); // zero backoff in tests
    expect(v.verdict).toBe('confirm');
    expect(n).toBe(3); // failed twice (auth warming up), succeeded on the 3rd
  });

  it('propagates the infra error only AFTER exhausting the backoff (→ ERR35)', async () => {
    let n = 0;
    const attempt = (): MachineVerdict => {
      n += 1;
      return authErr();
    };
    const v = await coldReadWithRetry(attempt, [0, 0, 0]);
    expect(v.verdict).toBe('error');
    expect(n).toBe(3); // all attempts spent before giving up
  });

  it('does NOT retry a content reject — a valid verdict returns immediately', async () => {
    let n = 0;
    const attempt = (): MachineVerdict => {
      n += 1;
      return { verdict: 'reject', notes: 'drops the fork behaviour' };
    };
    const v = await coldReadWithRetry(attempt, [0, 0, 0]);
    expect(v.verdict).toBe('reject');
    expect(n).toBe(1); // no retry on a real content decision
  });
});

describe('materials token-opt helpers (#3)', () => {
  it('conflictHunks extracts only the marker regions + context, not far-away lines', async () => {
    const repo = initFixtureRepo();
    cleanups.push(() => repo.destroy());
    const content = [
      'top of file',
      'a',
      'b',
      'c',
      'd',
      'e',
      '<<<<<<< ours',
      'OURS LINE',
      '=======',
      'THEIRS LINE',
      '>>>>>>> theirs',
      'x',
      'y',
      'z',
      'bottom of file',
    ].join('\n');
    repo.commit('conflict', { 'src/x.ts': content });
    const hunks = await conflictHunks(repo.dir, 'HEAD', ['src/x.ts'], 2);
    expect(hunks).toContain('--- src/x.ts ---');
    expect(hunks).toContain('<<<<<<< ours');
    expect(hunks).toContain('OURS LINE');
    expect(hunks).toContain('THEIRS LINE');
    expect(hunks).toContain('>>>>>>> theirs');
    expect(hunks).not.toContain('top of file'); // far above → excluded
    expect(hunks).not.toContain('bottom of file'); // far below → excluded
  });
})

describe('failing-output capture: summary + regions, nothing cropped before blame', () => {
  /**
   * If only a tail (`output.slice(-4000)`) were kept as the ONLY copy, blame
   * (a pure text scrape) could not see files whose diagnostics fall outside
   * the window — a gate-fix case gets scoped to whatever lands in the last
   * 4000 characters.
   */
  const bigTscOutput = (files: number, perFile: number): string => {
    const out: string[] = ['$ pnpm run typecheck'];
    for (let f = 0; f < files; f++) {
      for (let e = 0; e < perFile; e++) {
        out.push(`src/mod-${f}.ts(${e + 10},3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node?`);
      }
    }
    return out.join('\n');
  };

  it('summarises every failing file, not just the tail', () => {
    const output = bigTscOutput(40, 3); // ~120 diagnostics, far past a 4000-char tail
    expect(output.length).toBeGreaterThan(4000);
    const s = failureSummary(output, '/tmp/full.txt');
    expect(s).toContain('120 diagnostic(s) across 40 file(s)');
    // The FIRST file is the one a tail would have dropped — it must be present.
    expect(s).toContain('src/mod-0.ts');
    expect(s).toContain('src/mod-39.ts');
    expect(s).toContain('/tmp/full.txt');
  });

  it('gives each file a line RANGE into the full log', () => {
    const output = ['$ pnpm run typecheck', "src/a.ts(1,1): error TS2304: Cannot find name 'x'.", "src/b.ts(2,1): error TS2307: Cannot find module 'y'.", "src/a.ts(9,1): error TS2304: Cannot find name 'z'."].join('\n');
    const s = failureSummary(output, null);
    // src/a.ts: 2 diagnostics on log lines 2 and 4 -> range 2-4.
    expect(s).toMatch(/src\/a\.ts\s+2 err\s+TS2304\s+lines 2-4/);
    expect(s).toMatch(/src\/b\.ts\s+1 err\s+TS2307\s+lines 3-3/);
  });

  it('makes a BROKEN TOOLCHAIN legible as such', () => {
    // The broken-toolchain shape: every file failing on missing node types.
    const s = failureSummary(bigTscOutput(38, 1), null);
    expect(s).toContain('38 file(s)');
    expect(s).toContain('TS2580'); // one code across the board = environment, not code
  });

  it('returns empty for output with no diagnostics (callers omit the section)', () => {
    expect(failureSummary('$ pnpm test\nall good\n', null)).toBe('');
  });
});

describe('driver push carries credentials', () => {
  /**
   * The clone's origin is plain https with NO credential helper anywhere —
   * not in the clone, the image, or container.json — so a bare `git push`
   * dies on `could not read Username for 'https://github.com'`. The driver
   * must carry credentials on every push it makes.
   */
  it('gitPush passes a credential helper and disables the terminal prompt', async () => {
    const repo = initFixtureRepo();
    cleanups.push(() => repo.destroy());
    const bare = repo.attachBareOrigin();
    const sha = repo.sha('main');

    // A push to a LOCAL bare remote needs no credentials, so this asserts the
    // wiring is present and harmless rather than that auth happened.
    await gitPush(repo.dir, sha, 'pushed-by-driver');
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/pushed-by-driver')).toBe(sha);
  });

  it('the helper reads GH_TOKEN at call time — no token is written into config', async () => {
    const repo = initFixtureRepo();
    cleanups.push(() => repo.destroy());
    repo.attachBareOrigin();
    await gitPush(repo.dir, repo.sha('main'), 'cfg-check');
    // Nothing persisted: a later reader of .git/config must not find a helper,
    // and above all not a token baked into one.
    const cfg = repo.git('config', '--local', '--list');
    expect(cfg).not.toContain('credential.helper');
    expect(cfg).not.toContain('GH_TOKEN');
    expect(cfg).not.toContain('x-access-token');
  });
});

describe('dependencies are installed INTO the worktree, from ITS OWN manifests', () => {
  /**
   * No shared dependency pools: a pool can be installed with --ignore-scripts
   * so native addons never build, keyed on the PRE-MERGE tip while the
   * worktree holds the MERGED tree, or keyed on manifests alone so no fix can
   * invalidate it — and each such fault reaches the sweep as a code failure
   * and turns into branch-targeted work. Measured, a per-worktree install with
   * a warm store is ~5s — not worth a caching layer that costs correctness.
   *
   * What must hold: the environment is a function of the TREE UNDER TEST,
   * and a tree whose deps will not install yields NO verdict at all.
   */
  function repoWithManifests(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base manifests', {
      'package.json': JSON.stringify({ name: 'x', dependencies: { a: '1' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\npackages:\n  a@1: {}\n',
    });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('main');
    repo.commit('upstream adds a dependency', {
      'package.json': JSON.stringify({ name: 'x', dependencies: { a: '1', yaml: '2' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\npackages:\n  a@1: {}\n  yaml@2: {}\n',
    });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  it('installs from the MERGED manifests a case worktree carries, not the pre-merge tip', async () => {
    // `yaml` is declared by upstream `main` and not
    // by `main_patched`. The merge brings both the code that imports it and the
    // manifest that declares it — an environment built from the branch
    // tip would lack `yaml` and blame the agent for `TS2307`.
    const repo = repoWithManifests();
    const ws = mkWorkspace();
    const seen: string[] = [];
    const install: InstallRunner = async (wt) => {
      seen.push(readFileSync(join(wt, 'package.json'), 'utf8'));
      mkdirSync(join(wt, 'node_modules'), { recursive: true });
      return true;
    };
    const cli = { repo: repo.dir, workspace: ws, upstream: 'main', execute: true, cmd: 'plan' } as Cli;
    const dir = join(ws, 'p');
    mkdirSync(dir, { recursive: true });
    const caseFile = {
      schemaVersion: 1,
      id: 'main_patched--main-h0',
      branch: 'main_patched',
      parent: 'main',
      head: { sha: repo.sha('main'), height: 0 },
      run: [{ sha: repo.sha('main'), height: 0 }],
      tierFloor: 'clean',
      conflictedPaths: [],
      automergeTree: repo.git('rev-parse', 'main^{tree}'),
      reproduction: { command: '' },
      deferredCheck: { firstConflictHeight: 0, transitiveAncestors: [] },
    } as unknown as Parameters<typeof createCaseWorktree>[2];
    mkdirSync(join(dir, caseFile.id), { recursive: true });
    writeFileSync(join(dir, caseFile.id, 'case.json'), JSON.stringify(caseFile));
    await createCaseWorktree(cli, dir, caseFile, repo.sha('main_patched'), undefined, install);
    // The manifest the installer saw must be the one the CHECKS will run against.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('yaml');
  });

  it('a tree whose dependencies will not install yields NO verdict — never a green, never a blame', async () => {
    const repo = repoWithManifests();
    const ws = mkWorkspace();
    const dir = join(ws, 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(ws, 'checks.json'), JSON.stringify({ typecheck: [{ cmd: 'tsc', cwd: '.' }], test: [] }));
    writeFileSync(
      join(dir, 'plan.json'),
      JSON.stringify({
        order: ['main_patched'],
        branches: [{ branch: 'main_patched', parents: [{ parent: 'main', verdict: 'merge' }] }],
      }),
    );
    const cli = { repo: repo.dir, workspace: ws, upstream: 'main', execute: true, cmd: 'plan' } as Cli;
    let ranChecks = 0;
    const red = await firstRedParticipant(
      cli,
      dir,
      join(ws, 'checks.json'),
      async () => {
        ranChecks++;
        return { ok: false, failedNames: ['tsc'], output: 'boom' };
      },
      async () => false, // the install fails
    );
    // No branch is accused, and the checks never ran in an environment we do not
    // trust. A bogus GREEN here is the durable one — `branch-check` memoises it
    // for the whole pass and the branch's only typecheck is skipped.
    expect(red).toBeNull();
    expect(ranChecks).toBe(0);
    expect(readJournal(dir).some((e) => e.id === 'WARN13_DEPS_UNUSABLE')).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'branch-check')).toBe(false);
  });
});

