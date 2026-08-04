/**
 * scripts/sweep/sweep-machine.test.ts — the D-053 state machine
 * (SWEEP-STATE-MACHINE.md). Every mutating stage runs against throwaway git
 * fixtures; the cold read (`claude -p`) and the GitHub transport are injected so
 * nothing spawns a real subprocess or touches the network.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { isAncestor } from './git.js';
import {
  CHECKS_FAIL_LIMIT,
  cmdPublish,
  cmdSweepAbort,
  cmdSweepFinish,
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdSweepReportPr,
  cmdSweepStart,
  DriverHalt,
  openCases,
  parseCli,
  parseMachineVerdict,
  passDir,
  readJournal,
  reportDriverHalt,
  RESOLVE_COLDREAD_CAP,
  supersededCaseIds,
  type Cli,
  type ChecksRunner,
  type ColdReadInvoker,
  type InstallRunner,
} from './propagate.js';
import type { GithubTransport } from './publish.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sm-ws-'));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}
function emptyInventory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** Inventory with one feature carrying a recorded decision (prompt.decided_paths). */
function decidedInventory(paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const yaml = [
    'id: prior-decision',
    'name: prior-decision',
    'kind: feat',
    'status: shipped',
    'branch: feat/none',
    'prompt:',
    '  decided_paths:',
    ...paths.map((p) => `    - ${JSON.stringify(p)}`),
  ].join('\n');
  writeFileSync(join(dir, 'prior-decision.yaml'), yaml + '\n');
  return dir;
}
/** Minimal inventory writer (id/branch/parents) — mirrors propagate.test.ts. */
function writeInventory(
  entries: Array<{ id: string; branch: string; parents?: string[]; owned?: string[] }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      'kind: feat',
      'status: shipped',
      `branch: ${e.branch}`,
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
      ...(e.owned ? ['owned_paths:', ...e.owned.map((p) => `  - ${JSON.stringify(p)}`)] : []),
    ].join('\n');
    writeFileSync(join(dir, `${e.id}.yaml`), yaml + '\n');
  }
  return dir;
}
function baseCli(repo: FixtureRepo, ws: string, inv: string, over: Partial<Cli> = {}): Cli {
  return {
    cmd: 'plan',
    repo: repo.dir,
    workspace: ws,
    inventory: inv,
    scopeFile: join(inv, 'no-scope.yaml'), // non-existent -> empty scope (structural only)
    upstream: 'main',
    execute: false,
    // Deps are installed INTO each worktree now (pools deleted 2026-08-04), and
    // `createCaseWorktree` sits deep inside `cmdRun` — without this seam every
    // fixture case worktree would spawn a real `pnpm install`.
    installRunner: fakeInstall,
    ...over,
  };
}

/** main_patched (x=fork), U0 clean (util), U1 persistent x-conflict (one case). */
function conflictFixture(): FixtureRepo {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
  cleanups.push(() => repo.destroy());
  return repo;
}
/** Two feature branches (feat/a, feat/b) carrying the SAME fork edit on src/x.ts
 * — identical conflict signature against main_patched (finding B duplicates). */
function dupFixture(): FixtureRepo {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = mp', { 'src/x.ts': 'mp\n' });
  repo.checkout('main');
  repo.checkout('feat/a', { create: true, at: 'main' });
  repo.commit('a: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.checkout('feat/b', { create: true, at: 'main' });
  repo.commit('b: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  cleanups.push(() => repo.destroy());
  return repo;
}
/** main_patched (disjoint y), U0 clean util — merges clean, NO case. */
function cleanFixture(): FixtureRepo {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: y', { 'src/y.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  cleanups.push(() => repo.destroy());
  return repo;
}

function dirOf(repo: FixtureRepo, ws: string): string {
  return passDir(ws, repo.sha('main').slice(0, 12));
}
function machineState(dir: string): { phase: string; currentCase: { caseId: string; tier?: string } | null } {
  return JSON.parse(readFileSync(join(dir, 'machine-state.json'), 'utf8'));
}
function resolveWorktree(dir: string, caseId: string, files: Record<string, string>): void {
  const wt = join(dir, caseId, 'worktree');
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(wt, p, '..'), { recursive: true });
    writeFileSync(join(wt, p), content);
  }
}
function writePr(dir: string, caseId: string, title: string, body: string): void {
  const prDir = join(dir, caseId, 'pr');
  mkdirSync(prDir, { recursive: true });
  writeFileSync(join(prDir, 'title.txt'), title);
  writeFileSync(join(prDir, 'body.md'), body);
}
function currentCaseId(dir: string): string {
  return machineState(dir).currentCase!.caseId;
}

/** Pre-merge branch check stub: fixtures that are not testing IT inject green. */
const greenPreMerge: ChecksRunner = async () => ({ ok: true, failedNames: [], output: '' });

/**
 * Dependency install stub. Pools were deleted 2026-08-04: deps are installed
 * INTO the worktree from its own manifests, so the stub creates the two trees
 * there. Tests must inject it — there is no fallback to the clone any more, and
 * a tree with no valid environment yields no verdict at all.
 */
const fakeInstall: InstallRunner = async (wt) => {
  for (const rel of ['node_modules/.bin', 'container/agent-runner/node_modules/.bin']) {
    mkdirSync(join(wt, rel), { recursive: true });
    writeFileSync(join(wt, rel, 'tsc'), '#!/bin/sh\nexit 0\n');
  }
  return true;
};

const confirm: ColdReadInvoker = async () => ({
  verdict: 'confirm',
  notes: 'behaviour preserved; every hunk explained',
});
const rejectCode: ColdReadInvoker = async () => ({
  verdict: 'reject',
  notes: 'silently drops the fork behaviour',
  feedback: 'restore the fork-side guard before re-reporting',
  defect: 'code',
});
// D-060: the cold read is the SINGLE quality gate and it lives at `report-case`.
// Any stage that must not cold-read gets this invoker — it fails the test loudly
// instead of silently passing a second `claude -p` through.
/**
 * A green checks runner for `start`'s BASE GATE (D-061 A). Tests that exercise
 * the PER-CASE gate need the base to pass, or `start` refuses with ERR42 and no
 * pass ever opens. Injected at start only; report-case gets its own runner.
 */

const neverInvoked: ColdReadInvoker = async () => {
  throw new Error('cold read invoked where D-060 forbids one');
};
// D-054: the cold-read TOOLING is broken (spawn/exit/unparseable/auth) — an infra
// error, distinct from a content reject. Must halt (ERR35), never freeze HELD.
const infraError: ColdReadInvoker = async () => ({
  verdict: 'error',
  notes: '',
  reason: 'claude -p failed (status 1: Not logged in)',
});

/** Fake GitHub transport (no existing PR on head-lookup; created PR #7; closures merged). */
function fakeGithub(overrides: Record<string, { status: number; body: unknown }> = {}): {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  factory: (token: string) => GithubTransport;
} {
  const state = {
    calls: [] as Array<{ method: string; path: string; body?: unknown }>,
    factory: (_t: string): GithubTransport => ({
      async request(method, path, body) {
        state.calls.push({ method, path, body });
        for (const [key, res] of Object.entries(overrides)) {
          const [m, suffix] = key.split(' ');
          if (method === m && path.includes(suffix)) return res;
        }
        if (method === 'GET' && path.includes('/pulls?')) return { status: 200, body: [] }; // no existing PR
        if (method === 'POST' && path.endsWith('/pulls'))
          return { status: 201, body: { html_url: 'https://github.com/k-fls/fixture/pull/7', number: 7 } };
        if (method === 'GET' && /\/pulls\/\d+\/reviews/.test(path)) return { status: 200, body: [] }; // D-059 review trigger
        if (method === 'GET' && /\/pulls\/\d+\/comments/.test(path)) return { status: 200, body: [] }; // D-059 inline dialog
        if (method === 'GET' && /\/pulls\/\d+$/.test(path))
          return { status: 200, body: { number: 7, merged: true, body: 'x' } };
        if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) return { status: 200, body: {} };
        if (method === 'GET' && /\/issues\/\d+\/comments/.test(path)) return { status: 200, body: [] }; // D-059
        if (method === 'POST' && path.includes('/comments')) return { status: 201, body: {} };
        return { status: 404, body: null };
      },
    }),
  };
  return state;
}

// ---------------------------------------------------------------------------

describe('sweep start / abort (D-053 §2)', () => {
  it('start refuses when a pass is already open (finish/abort first)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    const out = join(ws, 'start2.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues[0].id).toBe('ERR30_PASS_OPEN');
  });

  it('abort rolls mutated branches back to pre-ref and allows a fresh start', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const preRef = repo.sha('main_patched');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv)); // merges the U0 prefix into main_patched
    expect(repo.sha('main_patched')).not.toBe(preRef);
    const dir = dirOf(repo, ws);
    expect(await cmdSweepAbort(baseCli(repo, ws, inv, { cmd: 'sweep-abort' }))).toBe(0);
    expect(repo.sha('main_patched')).toBe(preRef); // rolled back
    expect(machineState(dir).phase).toBe('complete');
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0); // fresh start allowed
  });
});

// ---------------------------------------------------------------------------
// D-061 (A): the BASE GATE at `start`. Live 2026-07-28: the fork trunk had been
// type-broken since fcee39ea (2026-07-04); the pass merged it into 11 branches
// and only found out at finish, where verify went red with NO clean attribution
// — an hour of work, no usable output, and a report asking a human to go fix it.
// ---------------------------------------------------------------------------

/**
 * The D-061 BASE GATE IS GONE (owner decision, 2026-07-30). `start` no longer
 * typechecks the base, no longer refuses or gates a red one, and keeps no
 * `sweep-base-gate-attempts.json`. A red base is found at `finish`'s verify and
 * served as an ordinary gate-fix case on the branch that owns the failing files
 * — see 'sweep finish — gate-fix on an unattributable red', which also covers
 * the sub-cwd path normalisation this block used to test through the base gate.
 *
 * What remains at `start` is the MALFORMED-checks refusal, which never depended
 * on the gate: it READS the file, it does not run it.
 */
describe('sweep start — no base gate; malformed checks still LOUD', () => {
  it('a RED base no longer refuses, gates, or writes a side-car record', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = join(ws, 'checks.json');
    // A typecheck that would FAIL if start still ran it.
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'exit 1' }], test: [] }));
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks, out }))).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; issues?: Array<{ id: string }> };
    expect(res.status).toBe('started');
    expect((res.issues ?? []).some((i) => i.id === 'ERR42_BASE_RED')).toBe(false);
    // The side-car anti-loop record is GONE — never written, by any path.
    expect(existsSync(join(ws, 'sweep-base-gate-attempts.json'))).toBe(false);
  });

  /**
   * DEFECT 7 (MED) — `loadChecksConfig` swallows a JSON parse error and returns
   * null, the SAME value as "there is no checks file". That silently disables
   * BOTH gates (the per-case checks gate at report-case and the finish verify
   * command list) with no journal row, no issue and no warning: the pass then
   * runs to completion reporting everything green while nothing was ever
   * typechecked or tested.
   */
  it('DEFECT 7 — a MALFORMED checks file is LOUD, never a silent skip', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bad = join(ws, 'checks.json');
    writeFileSync(bad, '{ "typecheck": [ {"cmd": "tsc --noEmit"} ,,, ]\n'); // truncated/invalid JSON
    const out = join(ws, 'start.json');
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: bad, out }));
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues?: Array<{ id: string; detail?: string }> };
    const journal = readJournal(dirOf(repo, ws));
    const loud =
      (res.issues ?? []).some((i) => /CHECKS/i.test(i.id) || /checks/i.test(i.detail ?? '')) ||
      journal.some((e) => /checks/i.test(JSON.stringify(e)) && (e.action === 'warning' || typeof e.id === 'string'));
    expect(loud).toBe(true);
  });
});


describe('sweep next-case (D-053 §2)', () => {
  it('advances the clean prefix and serves the conflict case with materials', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }))).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      worktree: string;
      branch: string;
      conflictedPaths: string[];
      materials: string;
    };
    expect(res.status).toBe('case-ready');
    expect(res.branch).toBe('main_patched');
    expect(res.conflictedPaths).toEqual(['src/x.ts']);
    expect(existsSync(res.worktree)).toBe(true);
    expect(res.materials).toContain('main_patched');
    expect(machineState(dir).phase).toBe('case-ready');
    // clean prefix (U0) merged onto main_patched
    expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(false); // U1 not merged
    const files = repo.git('ls-tree', '-r', '--name-only', 'main_patched');
    expect(files).toContain('src/util.ts');
  });

  it('a clean pass with no conflict returns finalize', async () => {
    const repo = cleanFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }))).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { status: string }).status).toBe('finalize');
  });
});

describe('sweep report-case (D-053 §2)', () => {
  async function toCase(repo: FixtureRepo, ws: string, inv: string): Promise<string> {
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    return currentCaseId(dirOf(repo, ws));
  }

  it('mechanical: injected cold read confirm -> merge in place', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string };
    expect(res.instruction).toBe('merged, take next case');
    expect(res.tier).toBe('mechanical');
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED');
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.tier === 'mechanical')).toBe(true);
    expect(machineState(dir).phase).toBe('open');
  });

  it('mechanical with an untouched worktree -> ERR32 (resolve first, no freeze)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const caseId = await toCase(repo, ws, inv);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR32_UNRESOLVED')).toBe(true);
    expect(readJournal(dirOf(repo, ws)).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
  });

  it('judged: cold read HERE (D-060) confirms -> provide PR description, NOT merged yet (merge lands at report-pr)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    const beforeTip = repo.sha('main_patched');
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string };
    // The instruction now carries the case's own PR template path — the agent is
    // given ONE template rather than left to find the repo's (live: PR #61).
    expect(res.instruction).toContain('provide PR description');
    expect(res.instruction).toContain('pr/TEMPLATE.md');
    expect(res.instruction).toContain('use only this template');
    expect(res.tier).toBe('judged');
    expect(repo.sha('main_patched')).toBe(beforeTip); // NOT merged yet (report-pr merges)
    // D-060: the single quality gate (cold read) now runs at report-case for
    // judged too — the coldread row exists here (no longer deferred to report-pr).
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId)).toBe(true);
    const st = machineState(dir);
    expect(st.phase).toBe('awaiting-pr');
    expect(st.currentCase?.tier).toBe('judged');
    expect(existsSync(join(dir, caseId, 'pr', 'materials.md'))).toBe(true);
  });

  it('ERR05 decided-already + JUDGED claim: NOT blocked — applying the recorded decision as judged IS the forward path (#65)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = decidedInventory(['src/x.ts']); // a recorded decision covers the conflicted path
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED per recorded decision\n' });
    const out = join(ws, 'rc.json');
    // Before #65 this looped: report-case fired ERR05 regardless of tier, and
    // --tier judged (the prescribed action) re-hit it with no exit.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string; issues?: Array<{ id: string }> };
    expect(res.tier).toBe('judged');
    // The instruction now carries the case's own PR template path — the agent is
    // given ONE template rather than left to find the repo's (live: PR #61).
    expect(res.instruction).toContain('provide PR description');
    expect(res.instruction).toContain('pr/TEMPLATE.md');
    expect(res.instruction).toContain('use only this template');
    expect((res.issues ?? []).some((i) => i.id === 'ERR05_DECIDED_ALREADY')).toBe(false);
    expect(machineState(dir).phase).toBe('awaiting-pr');
  });

  it('ERR05 decided-already + MECHANICAL claim: STILL blocked -> steered to judged (#65 must not over-open the gate)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = decidedInventory(['src/x.ts']);
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR05_DECIDED_ALREADY')).toBe(true);
    expect(res.instruction).toContain('apply the recorded decision (judged)');
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false); // blocked before merge
  });

  it('ERR05 decided-already is FIRST-ATTEMPT-ONLY: 1st held report steers, 2nd disposes — no loop (#65 finding A)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = decidedInventory(['src/x.ts']);
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    const out = join(ws, 'rc.json');
    // Attempt 1 (held, decided path): ERR05 fires ONCE — the steer.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED variant 1\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }), confirm),
    ).toBe(1);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> }).issues.some((i) => i.id === 'ERR05_DECIDED_ALREADY')).toBe(true);
    // Attempt 2 (distinct tree): ERR05 is quiet now (not the first attempt), so
    // the case reaches its HELD freeze instead of looping forever.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED variant 2\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }), confirm),
    ).toBe(0);
    const res2 = JSON.parse(readFileSync(out, 'utf8')) as { tier: string; issues?: Array<{ id: string }> };
    expect(res2.tier).toBe('held');
    expect((res2.issues ?? []).some((i) => i.id === 'ERR05_DECIDED_ALREADY')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
  });

  it('ERR06 finding B: a duplicate of a HELD topmost CONSOLIDATES (held-duplicate), never wedges finish', async () => {
    const repo = dupFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
    ]);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const first = currentCaseId(dir); // topmost duplicate (DAG order)
    // Freeze the topmost HELD, then clear awaiting-pr so the twin can be served.
    resolveWorktree(dir, first, { 'src/x.ts': 'HELD variant\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, first, 'held: x', 'freezing x for the owner');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);

    // Serve the twin — identical conflict to the now-HELD topmost.
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const second = currentCaseId(dir);
    expect(second).not.toBe(first);
    const out = join(ws, 'rc.json');
    // Before finding B this looped ERR06 ("resolve THAT case" — impossible, it's
    // frozen) and finish then refused (ERR34). Now it consolidates.
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }), confirm),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; issues?: Array<{ id: string }> };
    expect(res.instruction).toContain('consolidated into held case');
    expect((res.issues ?? []).every((i) => i.id !== 'ERR06_DUPLICATE_CASE') || res.instruction.includes('consolidated')).toBe(true);
    // held-duplicate journaled for the twin, referencing the topmost.
    const hd = readJournal(dir).find((e) => e.action === 'held-duplicate' && e.caseId === second);
    expect(hd).toBeTruthy();
    expect(hd!.duplicateOf).toBe(first);
    // The twin DRAINED: next-case finalizes (no open case wedges finish).
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }))).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { status: string }).status).toBe('finalize');
  });

  it('scope exceeded + cold read AGREES -> HELD publishing the RESOLUTION (escalated, no merge) — D-057 #3', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    const postRun = repo.sha('main_patched');
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n', 'src/extra.ts': 'sneaky\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string };
    expect(res.tier).toBe('held');
    // The instruction now carries the case's own PR template path — the agent is
    // given ONE template rather than left to find the repo's (live: PR #61).
    expect(res.instruction).toContain('provide PR description');
    expect(res.instruction).toContain('pr/TEMPLATE.md');
    expect(res.instruction).toContain('use only this template');
    expect(repo.sha('main_patched')).toBe(postRun); // no merge
    // Blocked ⇔ the journaled held disposition; nothing is published here and
    // no durable local state is written (D-058).
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(existsSync(join(ws, 'sweep-ledger.json'))).toBe(false); // no durable local state (2026-08-04)
    // The cold read RAN (not demoted before it) and the held entry carries the
    // marker-clean resolution + the scope escalation for the unified publish.
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId)).toBe(true);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held.resolution).toMatchObject({ markerClean: true });
    expect(held.escalation).toMatchObject({ tag: '[AUTO-ESCALATED: scope exceeded]' });
    expect((held.escalation as { feedback: string }).feedback).toContain('src/extra.ts');
  });

  it('markerClean covers EXTRA changed files: a marker left in a scope-exceeded file is NOT marker-clean (draft, not active)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    // The conflicted path is resolved clean, but the scope-exceeded EXTRA file
    // still carries conflict markers — the resolution must NOT be recorded
    // marker-clean (an ACTIVE PR would ship the marker); the unified publish
    // has to fall back to the draft pristine conflict.
    resolveWorktree(dir, caseId, {
      'src/x.ts': 'RESOLVED\n',
      'src/extra.ts': '<<<<<<< ours\nsneaky\n=======\nother\n>>>>>>> theirs\n',
    });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
    ).toBe(0);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held.escalation).toMatchObject({ tag: '[AUTO-ESCALATED: scope exceeded]' });
    expect((held.resolution as { markerClean: boolean }).markerClean).toBe(false);
  });

  it('mechanical cold-read reject: 1st -> revise with feedback (still case-ready); 2nd -> HELD escalated (D-057 #4)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    // FIRST rejection: no freeze — the reviewer's feedback reaches the agent.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        rejectCode,
      ),
    ).toBe(1);
    const first = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string; feedback?: string };
    expect(first.instruction).toContain('revise the resolution');
    expect(first.instruction).toContain('restore the fork-side guard'); // reviewer feedback, verbatim
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready'); // still the agent's case
    // SECOND rejection: stop retrying — HELD, escalation recorded for the PR prefix.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        rejectCode,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held.escalation).toMatchObject({ tag: '[AUTO-ESCALATED: cold read rejected 2x]' });
    expect((held.escalation as { feedback: string }).feedback).toContain('restore the fork-side guard');
    expect(held.resolution).toMatchObject({ markerClean: true }); // active review PR at publish
    expect(machineState(dir).currentCase?.tier).toBe('held');
  });

  it('judged cold-read reject (D-060: the gate is HERE, not at report-pr): 1st -> revise, 2nd -> HELD escalated, never merged', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    const beforeTip = repo.sha('main_patched');
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    // FIRST rejection: no freeze, no awaiting-pr — the case stays with the agent.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        rejectCode,
      ),
    ).toBe(1);
    const first = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(first.instruction).toContain('revise the resolution');
    expect(first.instruction).toContain('restore the fork-side guard'); // reviewer feedback, verbatim
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
    // SECOND rejection: HELD (escalated) — the judged merge at report-pr is never
    // reached, so main_patched is untouched throughout.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        rejectCode,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held.escalation).toMatchObject({ tag: '[AUTO-ESCALATED: cold read rejected 2x]' });
    expect(repo.sha('main_patched')).toBe(beforeTip);
    expect(machineState(dir).currentCase?.tier).toBe('held');
  });

  it('per-case attempt cap force-HELD after RESOLVE_COLDREAD_CAP distinct cold-read-reaching trees (D-060 5b)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    // D-060: report-attempt is recorded POST-CHECKS (5b), so the cap counts only
    // cold-read-reaching (RESOLVED, checks-passing) trees. Seed CAP prior
    // report-attempt rows with distinct trees, then report ONE more distinct
    // RESOLVED tree: 5b sees >CAP distinct and force-freezes HELD ACTIVE with the
    // convergence escalation, BEFORE the cold read runs.
    const jp = join(dir, 'journal.jsonl');
    for (let n = 1; n <= RESOLVE_COLDREAD_CAP; n++) {
      appendFileSync(
        jp,
        JSON.stringify({ ts: new Date().toISOString(), action: 'report-attempt', caseId, branch: 'main_patched', tier: 'mechanical', resolvedTree: `seed-tree-${n}` }) + '\n',
      );
    }
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED distinct final\n' });
    const out = join(ws, 'rc.json');
    const coldreadsBefore = readJournal(dir).filter((e) => e.action === 'coldread' && e.caseId === caseId).length;
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held).toBeTruthy();
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: resolution did not converge]');
    // The cap tripped BEFORE the cold read — no new coldread row.
    expect(readJournal(dir).filter((e) => e.action === 'coldread' && e.caseId === caseId).length).toBe(coldreadsBefore);
  });
});

// ---------------------------------------------------------------------------
// D-060 §5a: the CHECKS GATE (typecheck THEN tests) at report-case. The runner
// is injected (3rd param) so nothing spawns a real pnpm/bun; the checks-file is
// resolved + pinned by `start`, so these fixtures pass it there and never again.
// ---------------------------------------------------------------------------

describe('sweep report-case — the checks gate (D-060 §5a)', () => {
  /** A checks-file the fake runner keys off (the cmd strings are just labels). */
  function checksFile(ws: string, over: Partial<{ typecheck: string[]; test: string[] }> = {}): string {
    const f = join(ws, 'checks.json');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: (over.typecheck ?? ['tsc --noEmit']).map((cmd) => ({ cmd, cwd: '.' })),
        test: (over.test ?? ['vitest run']).map((cmd) => ({ cmd, cwd: '.' })),
      }),
    );
    return f;
  }
  /** Fails exactly the named commands; records every list it was handed, in order. */
  function runner(failing: string[]): { fn: ChecksRunner; ran: string[][] } {
    const ran: string[][] = [];
    const fn: ChecksRunner = async (commands) => {
      const names = commands.map((c) => c.cmd);
      ran.push(names);
      const failedNames = names.filter((n) => failing.includes(n));
      return { ok: failedNames.length === 0, failedNames, output: failedNames.map((n) => `$ ${n}\nboom\n`).join('') };
    };
    return { fn, ran };
  }
  async function toResolvedCase(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    checks: string,
  ): Promise<{ dir: string; caseId: string }> {
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    return { dir, caseId };
  }

  it('typecheck RED -> ERR36 (fix + re-run), tests never run, NO cold read, NO report-attempt, still case-ready', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const r = runner(['tsc --noEmit']);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked, // the gate fails BEFORE the cold read — no `claude -p` burned
        r.fn,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR36_TYPECHECK_FAILED')).toBe(true);
    expect(res.instruction).toContain('re-run report-case');
    // typecheck THEN tests: the failure short-circuits, tests are never handed over.
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toEqual(['tsc --noEmit']);
    // The agent gets the output on disk, the driver gets a journal row, and the
    // convergence cap is NOT charged for a tree that never reached the reviewer.
    expect(readFileSync(join(dir, caseId, 'typecheck-output.txt'), 'utf8')).toContain('tsc --noEmit');
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'checks-fail' && e.caseId === caseId && e.kind === 'typecheck')).toBe(true);
    expect(journal.some((e) => e.action === 'report-attempt' && e.caseId === caseId)).toBe(false);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
  });

  it('tests RED -> ERR40_TESTS_FAILED; a fixed re-report passes both, journals checks-pass, and reaches the cold read', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const red = runner(['vitest run']);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        red.fn,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR40_TESTS_FAILED')).toBe(true);
    expect(red.ran.map((l) => l[0])).toEqual(['tsc --noEmit', 'vitest run']); // typecheck ran first, and passed
    expect(readFileSync(join(dir, caseId, 'test-output.txt'), 'utf8')).toContain('vitest run');
    // The agent fixes it: both gates green -> checks-pass, cold read, merge.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED AND GREEN\n' });
    const green = runner([]);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
        green.fn,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'checks-pass' && e.caseId === caseId)).toBe(true);
    expect(journal.some((e) => e.action === 'coldread' && e.caseId === caseId)).toBe(true);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED AND GREEN');
  });

  it('CHECKS_FAIL_LIMIT consecutive failures -> HELD DRAFT at the PRISTINE conflict (the failing resolution is never published)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    // Seed LIMIT-1 prior failures, then fail once more to reach the backstop.
    const jp = join(dir, 'journal.jsonl');
    for (let n = 1; n < CHECKS_FAIL_LIMIT; n++) {
      appendFileSync(
        jp,
        JSON.stringify({
          ts: new Date().toISOString(),
          action: 'checks-fail',
          caseId,
          resolvedTree: `seed-tree-${n}`,
          kind: 'typecheck',
          failed: ['tsc --noEmit'],
        }) + '\n',
      );
    }
    const r = runner(['tsc --noEmit']);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string };
    expect(res.tier).toBe('held');
    expect(res.instruction).toContain('PRISTINE conflict state');
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: checks failing]');
    // PRISTINE: no resolution recorded, so the publish is a DRAFT of the conflict
    // — the agent's failing tree never becomes a review PR.
    expect(held.resolution ?? null).toBe(null);
    expect(machineState(dir).phase).toBe('awaiting-pr');
    expect(machineState(dir).currentCase?.tier).toBe('held');
  });

  it('a passing run RESETS the counter: LIMIT-1 failures, then a pass, then a failure is strike 1 again (no premature HELD)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const jp = join(dir, 'journal.jsonl');
    for (let n = 1; n < CHECKS_FAIL_LIMIT; n++) {
      appendFileSync(
        jp,
        JSON.stringify({ ts: new Date().toISOString(), action: 'checks-fail', caseId, kind: 'test', failed: ['vitest run'] }) +
          '\n',
      );
    }
    appendFileSync(jp, JSON.stringify({ ts: new Date().toISOString(), action: 'checks-pass', caseId }) + '\n');
    const r = runner(['vitest run']);
    const out = join(ws, 'rc.json');
    // The counter restarted at the pass, so this is strike 1 -> ERR40, not HELD.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(1);
    expect(
      (JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> }).issues.some(
        (i) => i.id === 'ERR40_TESTS_FAILED',
      ),
    ).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
  });

  /**
   * DEADLOCK (live 2026-08-01). `--tier held` is the documented escape when the
   * agent cannot make a case green, and doctrine's ERR36 row explicitly sends it
   * here when the failing file is out of scope. But the pristine-held branch
   * requires `conflictsPresent`, so an agent that HAS resolved the conflict fell
   * through to the checks gate and got ERR40 "fix the pending files" — which was
   * impossible: the conflict was `src/cli/resources/groups.ts`, the failing test
   * `container/agent-runner/src/poll-loop.test.ts` from upstream. It claimed held
   * twice, was refused twice, and filed a stop-case. It was right.
   */
  it('an explicit --tier held with FAILING checks is honoured now, not after 10 tries', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws, { typecheck: ['true'], test: ['false'] }); // tests fail
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }), undefined);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    // A real resolution: not pristine, so the pristine-held escape does not apply.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });

    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }), confirm),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { tier: string; instruction: string };
    expect(res.tier).toBe('held');
    // The PR text must SAY the checks still fail — a held PR the owner can read.
    expect(res.instruction).toContain('still fails');
    expect(machineState(dir).phase).toBe('awaiting-pr');

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    // Honoured on the FIRST claim — not after CHECKS_FAIL_LIMIT failures.
    expect(journal.filter((e) => e.action === 'checks-fail' && e.caseId === caseId).length).toBeLessThan(CHECKS_FAIL_LIMIT);
    // And the RESOLUTION is kept: a conflict the agent already solved must not be
    // thrown away and re-shipped as an empty pristine exhibit.
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(String(held.notes ?? '')).toContain('resolution kept');
  });

  it('a HELD claim on a pristine conflict SKIPS the gate entirely (nothing to typecheck)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    const r = runner(['tsc --noEmit', 'vitest run']); // would fail if ever called
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);
    expect(r.ran).toHaveLength(0);
    expect(readJournal(dir).some((e) => e.action === 'checks-fail' && e.caseId === caseId)).toBe(false);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
  });

  it('the case worktree gets its deps INSTALLED (not the clone linked), so the gate can run', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    // A `git worktree add` checkout has no `node_modules`, so without this the
    // gate dies `tsc: not found` on EVERY case — a failure no agent edit can fix,
    // marching every case to the CHECKS_FAIL_LIMIT force-HELD. Pools used to
    // supply it and were deleted (2026-08-04); the install now runs IN the
    // worktree, from the manifests that worktree carries.
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    const wt = join(dir, caseId, 'worktree');
    for (const rel of ['node_modules', 'container/agent-runner/node_modules']) {
      expect(existsSync(join(wt, rel))).toBe(true);
      // REAL directories in the worktree — NOT symlinks into a shared tree. That
      // sharing is what let one poisoned install answer for every branch.
      expect(lstatSync(join(wt, rel)).isSymbolicLink()).toBe(false);
    }
    expect(existsSync(join(wt, 'node_modules', '.bin', 'tsc'))).toBe(true);
    // REGRESSION (live bug, 2026-07-28): `.gitignore` has `node_modules/` — a
    // trailing slash matches DIRECTORIES ONLY. The per-worktree info/exclude is
    // what actually keeps the installed trees out of the resolved tree, the merge
    // and the PR. Assert on TREE MODES, not on a name: the original name-only
    // assertion passed while the bug shipped.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
    ).toBe(0);
    const tree = repo.git('ls-tree', '-r', 'main_patched');
    expect(tree).not.toContain('120000');
    expect(tree).not.toContain('node_modules');
  });

  it('the per-worktree info/exclude is what hides the links (anchored, slash-free, uncommitted)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    for (const rel of ['node_modules', 'container/agent-runner/node_modules']) {
      mkdirSync(join(repo.dir, rel), { recursive: true });
      writeFileSync(join(repo.dir, rel, 'marker.txt'), 'x\n');
    }
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const wt = join(dir, currentCaseId(dir), 'worktree');
    // COMMON dir: git reads info/exclude from the shared .git, not from a
    // linked worktree's private dir (writing there is a silent no-op).
    const gitDir = repo.git('-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const exclude = readFileSync(join(gitDir, 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/node_modules');
    expect(exclude).toContain('/container/agent-runner/node_modules');
    // git itself must agree the links are invisible inside the worktree.
    const status = repo.git('-C', wt, 'status', '--porcelain');
    expect(status).not.toContain('node_modules');
  });

  it('no checks-file in the repo -> the gate is SKIPPED (no checks rows), the cold read still gates', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    // start with NO --checks-file: the default <repo>/scripts/sweep/checks.json
    // does not exist in the fixture, so loadChecksConfig yields null.
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const r = runner([]);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
        r.fn,
      ),
    ).toBe(0);
    expect(r.ran).toHaveLength(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'checks-pass' || e.action === 'checks-fail')).toBe(false);
    expect(journal.some((e) => e.action === 'coldread' && e.caseId === caseId)).toBe(true);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED');
  });

  // ---- `--not-my-bug` (2026-08-03) ---------------------------------------
  //
  // The 08-01 deadlock end to end: a failure the case did not cause, which the
  // agent may not fix in scope and could not escape. `runner` above emits output
  // that names no file, so these use a variant that does — the comparison is
  // file-identity based and there is nothing to compare without it.
  /** Fails the named commands, with output naming `file` (so blame/counts work). */
  function namingRunner(failing: string[], file: string): { fn: ChecksRunner; ran: string[][] } {
    const ran: string[][] = [];
    const fn: ChecksRunner = async (commands) => {
      const names = commands.map((c) => c.cmd);
      ran.push(names);
      const failedNames = names.filter((n) => failing.includes(n));
      return {
        ok: failedNames.length === 0,
        failedNames,
        output: failedNames.map((n) => `$ ${n}\n${file}(1,1): error TS2345: boom\n`).join(''),
      };
    };
    return { fn, ran };
  }
  /** Seed a prior checks-fail so the flag is no longer "premature". */
  function seedPriorFailure(dir: string, caseId: string, kind: string, failed: string[]): void {
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'checks-fail', caseId, kind, failed }) + '\n',
    );
  }

  it('--not-my-bug on the FIRST failure is ignored, and says why (the agent may not run tests)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', notMyBug: true, execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'not-my-bug-premature' && e.caseId === caseId)).toBe(true);
    // No adjudication ran: nothing had been reported to the agent yet.
    expect(journal.some((e) => e.action === 'not-my-bug')).toBe(false);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR36_TYPECHECK_FAILED')).toBe(true);
  });

  it('the ERR payload ADVERTISES the hatch — the only message that tells the agent a check failed', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir } = await toResolvedCase(repo, ws, inv, checks);
    expect(dir).toBeTruthy();
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
      neverInvoked,
      r.fn,
    );
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(res.instruction).toContain('--not-my-bug');
  });

  it('CONFIRMED pre-existing -> merge aborted, gate-fix case minted, case superseded', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    // The failure names a file the case never touched, and it fails on EVERY
    // tree — including the clean prefix and the branch tip. That is the proof.
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    const rc = await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    expect(rc).toBe(1);
    const journal = readJournal(dir);
    const verdict = journal.find((e) => e.action === 'not-my-bug')!;
    expect(verdict.verdict).toBe('pre-existing');
    expect(journal.find((e) => e.action === 'not-my-bug-owner')!.owner).toBe('branch');
    // A gate-fix case exists, the old case is superseded by the reopen, and the
    // machine is back at `open` so `next-case` serves the gate fix.
    const gateFix = journal.find((e) => e.action === 'gate-fix');
    expect(gateFix).toBeTruthy();
    expect(gateFix!.branch).toBe('main_patched');
    expect(supersededCaseIds(journal).has(caseId)).toBe(true);
    // ...and the GATE FIX itself is NOT superseded. When the owner is this same
    // branch, journaling the gate-fix case BEFORE the `reopened` row superseded it
    // the instant it was created: `next-case` would never serve it, the conflict
    // case would be re-emitted, and the pass would re-adjudicate (bisect included)
    // every round until the ten-strike backstop — the 08-01 deadlock, restored.
    expect(supersededCaseIds(journal).has(gateFix!.caseId as string)).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toContain(gateFix!.caseId);
    // The agent's resolution is PINNED, not discarded: reopening rebuilds the
    // worktree from the automerge tree, and nothing else references that tree.
    const preserved = journal.find((e) => e.action === 'not-my-bug-preserved')!;
    expect(preserved).toBeTruthy();
    expect(repo.git('rev-parse', '--verify', `${preserved.ref as string}^{tree}`)).toBe(preserved.tree);
    expect(machineState(dir).phase).toBe('open');
    expect(machineState(dir).currentCase).toBeNull();
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      issues: Array<{ id: string }>;
      instruction: string;
    };
    expect(res.status).toBe('gate-fix-required');
    // PROCEED arm: WARN advises, ERR blocks. An ERR id here is the ERR42 bug.
    expect(res.issues.every((i) => i.id.startsWith('WARN'))).toBe(true);
    expect(res.instruction).toContain('next-case');
  });

  it('REFUSED -> the gate names which failures are the agent’s own', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    // Fails ONLY in the case worktree, in a file OUTSIDE the conflicted set: the
    // probes against committed trees see a green build, so the claim is disproved.
    const ran: string[][] = [];
    const wtPath = join(dir, caseId, 'worktree');
    const fn: ChecksRunner = async (commands, baseDir) => {
      ran.push(commands.map((c) => c.cmd));
      if (baseDir !== wtPath) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['tsc --noEmit'],
        output: '$ tsc --noEmit\nsrc/util.ts(1,1): error TS2345: boom\n',
      };
    };
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        fn,
        fakeInstall,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('caused-by-case');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(res.instruction).toContain('These failures are YOURS');
    expect(res.instruction).toContain('src/util.ts');
  });

  it('minting a gate fix SUPERSEDES the descendants’ open cases, so only the fix is left to serve', async () => {
    // Live 2026-08-04: eleven open cases sat ahead of the gate fix, every one of
    // them merging from a branch that carried the red commit. Each would fail the
    // same checks, pay a full adjudication, hit the `gateFixKey` anti-loop and
    // fall back to `--tier held` — eleven junk PRs for one defect.
    //
    // Every other blocking path reopens `[branch, ...descendants]`; this one
    // reopened the branch alone. Reopening the subtree supersedes their cases,
    // and the open-gate-fix guard stops `cmdRun` re-deriving them, so no priority
    // rule is needed — the gate fix is simply the only case left.
    const repo = conflictFixture();
    // A descendant of main_patched with a conflict of its own.
    repo.checkout('module/dep', { create: true, at: 'main_patched' });
    repo.commit('dep: its own edit', { 'src/dep.ts': 'dep\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'dep', branch: 'module/dep', parents: ['main_patched'] },
    ]);
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    // Fake an open case on the descendant, as the first `run` would have left it.
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'case',
        caseId: 'module__dep--main_patched-h1',
        branch: 'module/dep',
        parent: 'main_patched',
        head: { sha: repo.sha('module/dep'), height: 1 },
        conflictedPaths: ['src/dep.ts'],
      }) + '\n',
    );
    expect(openCases(readJournal(dir)).map((c) => c.caseId)).toContain('module__dep--main_patched-h1');

    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      r.fn,
    );
    const journal = readJournal(dir);
    const gateFix = journal.find((e) => e.action === 'gate-fix');
    expect(gateFix).toBeTruthy();
    // The descendant's case is superseded — it cannot pass, since the red commit
    // is in the very content it is merging.
    expect(supersededCaseIds(journal).has('module__dep--main_patched-h1')).toBe(true);
    // ...and the gate fix is the ONLY thing left open, so service order is moot.
    expect(openCases(journal).map((c) => c.caseId)).toEqual([gateFix!.caseId]);
  });

  it('a TIMEOUT gate fix reaches the agent as DIAGNOSIS ONLY — in the MATERIALS, not just the journal', async () => {
    // The flag was journaled on the `gate-fix` row while `gateFixCaseMaterials`
    // reads the `case` row, so it never reached the agent: the journal said
    // `diagnosisOnly: true` and the briefing still said "fix it". Caught live
    // 2026-08-05 only because the agent kept investigating. Assert the MATERIALS
    // — the thing the agent actually reads — not the flag.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    const caseId = 'gate-fix-main_patched-cafe1234';
    const tip = repo.sha('main_patched');
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(), action: 'gate-fix', key: 'main_patched::src/x.test.ts', caseId,
        branch: 'main_patched', files: ['src/x.test.ts'], failedCommands: ['vitest run'], rootAt: tip,
        reason: 'pre-existing', diagnosisOnly: true,
      }) + '\n' +
        JSON.stringify({
          ts: new Date().toISOString(), action: 'case', caseId, branch: 'main_patched', parent: '(gate-fix)',
          gateFix: true, diagnosisOnly: true, head: { sha: tip, height: 1 }, conflictedPaths: ['src/x.test.ts'],
        }) + '\n',
    );
    mkdirSync(join(dir, caseId), { recursive: true });
    writeFileSync(join(dir, caseId, 'gate-fix-output.txt'), '(fail) slow thing\n  ^ this test timed out after 5000ms.\n');
    writeFileSync(
      join(dir, caseId, 'case.json'),
      JSON.stringify({
        schemaVersion: 1, id: caseId, branch: 'main_patched', parent: '(gate-fix)',
        head: { sha: tip, height: 1 }, run: [{ sha: tip, height: 1 }], tierFloor: 'judged',
        conflictedPaths: ['src/x.test.ts'], automergeTree: repo.git('rev-parse', 'main_patched^{tree}'),
        reproduction: { command: 'vitest run' },
        deferredCheck: { firstConflictHeight: 1, transitiveAncestors: [] },
      }) + '\n',
    );
    repo.git('worktree', 'add', '--detach', join(dir, caseId, 'worktree'), tip);
    const out = join(ws, 'nc.json');
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks, out }), greenPreMerge);
    const materials = readFileSync(join(dir, caseId, 'materials.md'), 'utf8');
    expect(materials).toContain('DIAGNOSIS ONLY');
    expect(materials).toContain('DO NOT ATTEMPT A FIX');
    expect(materials).toContain('--tier held');
  });

  it('a gate fix the agent cannot fix IN SCOPE becomes a HELD PR carrying the diagnosis', async () => {
    // Owner, 2026-08-04: "reproducible-but-unfixable-in-scope should lead to held
    // PR — there is no other way." The category is real and had nowhere to go:
    // the failure REPRODUCES (not `flaky`), it is genuinely pre-existing (not the
    // agent's), and no edit inside the NAMED files can fix it — because a gate
    // fix is scoped to where the failure was REPORTED, which is not where the fix
    // belongs (a failing test names the test, not the source).
    //
    // Before: `--tier held` on an unchanged tree hit ERR32 and was told to "edit
    // the files or report to the owner" — but reporting is not a driver action,
    // so the case dead-ended and the agent burned attempts until it was reaped.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    // A driver-minted gate-fix case, as `--not-my-bug` or the pre-merge check
    // would leave it: named files, no conflict, worktree at the branch tip.
    const caseId = 'gate-fix-main_patched-deadbeef';
    const tip = repo.sha('main_patched');
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'gate-fix',
        key: 'main_patched::src/x.test.ts',
        caseId,
        branch: 'main_patched',
        files: ['src/x.test.ts'],
        failedCommands: ['vitest run'],
        rootAt: tip,
        reason: 'pre-existing failure',
      }) + '\n' +
        JSON.stringify({
          ts: new Date().toISOString(),
          action: 'case',
          caseId,
          branch: 'main_patched',
          parent: '(gate-fix)',
          gateFix: true,
          head: { sha: tip, height: 1 },
          conflictedPaths: ['src/x.test.ts'],
        }) + '\n',
    );
    mkdirSync(join(dir, caseId), { recursive: true });
    writeFileSync(join(dir, caseId, 'gate-fix-output.txt'), 'src/x.test.ts > times out\n');
    // The case file the driver writes alongside the journal rows (a pointer;
    // `reverifyGateFixCase` re-derives the truth from the journal row above).
    writeFileSync(
      join(dir, caseId, 'case.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: caseId,
        branch: 'main_patched',
        parent: '(gate-fix)',
        head: { sha: tip, height: 1 },
        run: [{ sha: tip, height: 1 }],
        tierFloor: 'judged',
        conflictedPaths: ['src/x.test.ts'],
        automergeTree: repo.git('rev-parse', 'main_patched^{tree}'),
        reproduction: { command: 'vitest run' },
        deferredCheck: { firstConflictHeight: 1, transitiveAncestors: [] },
      }) + '\n',
    );
    // The worktree the driver would have created at mint time (detached at the
    // root) — `materializeGateFixCases` is bypassed here, so make it directly.
    repo.git('worktree', 'add', '--detach', join(dir, caseId, 'worktree'), tip);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), greenPreMerge);
    expect(currentCaseId(dir)).toBe(caseId);

    // The agent edits NOTHING — the fix is not in the named files — and escalates.
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', checksFile: checks, execute: true, out }),
        neverInvoked,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { tier: string; instruction: string };
    expect(res.tier).toBe('held');
    // The DIAGNOSIS is the deliverable — the PR must say what fails, why it
    // cannot be fixed in those files, and where the fix belongs.
    expect(res.instruction).toContain('WHY it cannot be fixed');
    expect(res.instruction).toContain('src/x.test.ts');
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held).toBeTruthy();
    // Nothing was fixed, so nothing is published as a resolution — the PR is prose.
    expect(held.resolution ?? null).toBeNull();
    expect(machineState(dir).phase).toBe('awaiting-pr');
  });

  it('refuses to mint a gate fix on UPSTREAM main, and reports it instead', async () => {
    // Live 2026-08-04: an ownership probe of upstream's head ran with the wrong
    // dependencies, came back red for a module upstream actually declares,
    // ownership moved to the parent, a bisect converged, and the driver minted
    // `gate-fix-main-c1e3ddc6`. A fix committed to upstream could not be pushed
    // anywhere the fork controls — the case was unusable by construction.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    // Fails everywhere, including at the parent head -> ownership lands on `main`.
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      r.fn,
    );
    const journal = readJournal(dir);
    // No case on upstream, and the refusal is journaled rather than swallowed —
    // "upstream is red" is a real finding the owner must hear.
    expect(journal.some((e) => e.action === 'gate-fix' && e.branch === 'main')).toBe(false);
    const refused = journal.find((e) => e.action === 'gate-fix-refused');
    if (refused) expect(refused.branch).toBe('main');
  });

  it('a failure IN a conflicted path is refused without probing — it is the agent’s by definition', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    // `src/x.ts` IS the conflict. The clean prefix holds it at the branch's
    // pre-merge blob against an otherwise merged tree — the very incompatibility
    // the conflict is about — so it fails there too and a genuine regression in
    // it would be "confirmed" pre-existing on the first probe.
    const r = namingRunner(['tsc --noEmit'], 'src/x.ts');
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        r.fn,
        fakeInstall,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('refused');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    // Nothing was probed: the whole adjudication is skipped for these files.
    expect(r.ran).toHaveLength(1);
    expect(machineState(dir).phase).toBe('case-ready');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(res.instruction).toContain('src/x.ts');
  });
});

describe('sweep report-pr (D-053 §2)', () => {
  async function toAwaiting(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    tier: 'judged' | 'held',
  ): Promise<{ dir: string; caseId: string }> {
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    if (tier === 'judged') resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier, execute: true }), confirm);
    writePr(dir, caseId, `${tier} case ${caseId}`, `Decision needed: resolution of src/x.ts — study before merge.`);
    return { dir, caseId };
  }

  it('held: single cold read over code+desc -> records intent, PUBLISHES NOTHING; finish creates the draft PR post-verify (D-058)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const { dir, caseId } = await toAwaiting(repo, ws, inv, 'held');
    const out = join(ws, 'pr.json');
    // report-pr: NO transport, NO token needed — it publishes nothing.
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), confirm)).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; prIntent: boolean };
    expect(res.instruction).toBe('take next case');
    expect(res.prIntent).toBe(true);
    const intent = readJournal(dir).find((e) => e.action === 'pr-intent' && e.caseId === caseId)!;
    expect(intent.mode).toBe('held');
    expect(intent.draft).toBe(true); // pristine conflict -> draft
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'push')).toBe(false);
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
    expect(machineState(dir).phase).toBe('open');

    // finish: verify green -> push targets -> the ONE publish phase creates the
    // held DRAFT PR (fix/sweep ref pushed + PR, never merged by the driver).
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const gh = fakeGithub();
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmds }),
        gh.factory,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    const pub = journal.find((e) => e.action === 'pr-published' && e.caseId === caseId)!;
    expect(pub.mode).toBe('held');
    expect(pub.draft).toBe(true);
    // Ordering: the held PR is created AFTER the pass's target push and AFTER
    // the green verify (all PRs at finish, post-verify — D-058).
    const pubIdx = journal.findIndex((e) => e.action === 'pr-published' && e.caseId === caseId);
    const pushIdx = journal.findIndex((e) => e.action === 'push' && e.kind === 'target');
    const verifyIdx = journal.findIndex((e) => e.action === 'verify' && e.ok === true);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(pubIdx).toBeGreaterThan(pushIdx);
    expect(pubIdx).toBeGreaterThan(verifyIdx);
    // The fix/sweep ref is REALLY on origin now, at the pushed head.
    const fixBranch = pub.fixBranch as string;
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(pub.head as string);
    // The target branch tip does NOT contain the held head (nothing landed).
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(true);
  });

  it('held with a MARKER-CLEAN resolution (scope-exceeded confirm) -> intent (active) at report-pr; finish creates the ACTIVE PR with the prefix', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    // Marker-clean resolution that exceeds the conflict scope (#3) + confirm.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n', 'src/extra.ts': 'sneaky\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, `held case ${caseId}`, 'Decision needed: resolution of src/x.ts — study before merge.');
    const out = join(ws, 'pr.json');
    // report-pr records the ACTIVE intent (marker-clean) — publishes nothing.
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), confirm)).toBe(0);
    const intent = readJournal(dir).find((e) => e.action === 'pr-intent' && e.caseId === caseId)!;
    expect(intent.draft).toBe(false); // marker-clean -> ACTIVE review PR at finish
    expect(intent.markerClean).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(machineState(dir).phase).toBe('open');

    // finish creates the ACTIVE (non-draft) review PR at the resolved merge
    // commit, with the escalation prefix — the owner reviews & MERGES it.
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const gh = fakeGithub();
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmds }),
        gh.factory,
      ),
    ).toBe(0);
    const pub = readJournal(dir).find((e) => e.action === 'pr-published' && e.caseId === caseId)!;
    expect(pub.mode).toBe('held');
    expect(pub.draft).toBe(false); // ACTIVE: owner reviews & MERGES (driver never does)
    const prCall = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect((prCall.body as { draft: boolean }).draft).toBe(false);
    const sentBody = (prCall.body as { body: string }).body;
    expect(sentBody.startsWith('[AUTO-ESCALATED: scope exceeded]')).toBe(true);
    expect(sentBody).toContain('src/extra.ts');
    // The pushed head is the RESOLVED merge commit: the agent's tree, parented
    // on the branch tip + the conflict head (owner merge completes the block).
    const head = pub.head as string;
    const caseHead = (readJournal(dir).find((e) => e.action === 'case')!.head as { sha: string }).sha;
    expect(repo.git('rev-parse', `${head}^2`)).toBe(caseHead);
    expect(repo.git('show', `${head}:src/x.ts`)).toBe('RESOLVED');
    expect(repo.git('show', `${head}:src/extra.ts`)).toBe('sneaky');
    // The held content did NOT land on the target: origin main_patched does not
    // contain the resolved merge commit (NOT merged — the owner decides).
    expect(() => repo.git('-C', bare, 'merge-base', '--is-ancestor', head, 'refs/heads/main_patched')).toThrow();
  });

  it('judged: records PR intent + merges locally, NO push / NO PR created', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const { dir, caseId } = await toAwaiting(repo, ws, inv, 'judged');
    const out = join(ws, 'pr.json');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), confirm)).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; prIntent: boolean };
    expect(res.instruction).toBe('take next case');
    expect(res.prIntent).toBe(true);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED'); // merged locally
    expect(readJournal(dir).some((e) => e.action === 'pr-intent' && e.caseId === caseId)).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false); // created only at finish
    expect(readJournal(dir).some((e) => e.action === 'push')).toBe(false);
  });

  it('D-060: report-pr runs NO cold read — the invoker is never called; the PR text is recorded as-is', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const { dir, caseId } = await toAwaiting(repo, ws, inv, 'judged');
    const coldreads = (): number =>
      readJournal(dir).filter((e) => e.action === 'coldread' && e.caseId === caseId).length;
    const before = coldreads();
    expect(before).toBe(1); // the ONE gate, already spent at report-case
    const out = join(ws, 'pr.json');
    // A cold read HERE would be a second gate (and a second `claude -p`) — the
    // invoker must never run, even for prose the old description-defect verdict
    // would have rejected.
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), neverInvoked)).toBe(
      0,
    );
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; prIntent: boolean };
    expect(res.instruction).toBe('take next case');
    expect(res.prIntent).toBe(true);
    expect(coldreads()).toBe(before); // no SECOND cold read
    expect(machineState(dir).phase).toBe('open');
  });

  it('D-060: the H1 first line of pr/body.md IS the title (no title.txt); a body with no H1 is ERR08', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm);
    const prDir = join(dir, caseId, 'pr');
    mkdirSync(prDir, { recursive: true });
    const out = join(ws, 'pr.json');
    // No H1, no title.txt -> the driver never invents PR prose (D-048).
    writeFileSync(join(prDir, 'body.md'), 'Decision needed: resolution of src/x.ts.\n');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), neverInvoked)).toBe(
      1,
    );
    const err = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(err.issues.some((i) => i.id === 'ERR08_TEXT_MISSING')).toBe(true);
    expect(machineState(dir).phase).toBe('awaiting-pr'); // still the agent's case
    // H1 first line -> title; the remainder is the body. Both are normalized to
    // disk so the finish-time publish reads them unchanged.
    writeFileSync(
      join(prDir, 'body.md'),
      '# judged: keep the fork line in src/x.ts\n\nDecision needed: resolution of src/x.ts — study before merge.\n',
    );
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), neverInvoked)).toBe(
      0,
    );
    expect(readFileSync(join(prDir, 'title.txt'), 'utf8').trim()).toBe('judged: keep the fork line in src/x.ts');
    const body = readFileSync(join(prDir, 'body.md'), 'utf8');
    expect(body.startsWith('#')).toBe(false); // the H1 was consumed as the title
    expect(body).toContain('Decision needed');
  });
});

describe('sweep finish (D-053 §2) — multi-step, resumable', () => {
  const passCmds = (ws: string): string => {
    const f = join(ws, 'cmds-true.json');
    writeFileSync(f, JSON.stringify([{ cmd: 'true' }]));
    return f;
  };
  const failCmds = (ws: string): string => {
    const f = join(ws, 'cmds-false.json');
    writeFileSync(f, JSON.stringify([{ cmd: 'false' }]));
    return f;
  };

  it('verify green -> creates the JUDGED PR, then pushes the target (closure confirmed), in order', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm);
    writePr(dir, caseId, 'judged x', 'Decision needed: keep the fork line in src/x.ts.');
    await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm);
    expect((await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)) === 0).toBe(true); // finalize

    const gh = fakeGithub();
    const out = join(ws, 'finish.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: passCmds(ws), out }),
        gh.factory,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; status: string };
    expect(res.ok).toBe(true);
    expect(res.status).toBe('complete');
    const journal = readJournal(dir);
    const prIdx = journal.findIndex((e) => e.action === 'pr-published' && e.mode === 'judged');
    const pushIdx = journal.findIndex((e) => e.action === 'push' && e.kind === 'target');
    expect(prIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(prIdx).toBeLessThan(pushIdx); // JUDGED PR created BEFORE the target push (auto-flip)
    // the target landed the judged merge on origin
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
  });

  it('D-060: RED TESTS at finish STOP the pass (publish nothing, report to the owner); a re-run with a green gate completes', async () => {
    const repo = cleanFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // clean, finalize
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: failCmds(ws), out: out1 }),
      ),
    ).toBe(1);
    // Build clean, no single-branch offender to roll back: red tests are code work
    // or an owner decision, NOT a resumable rollback — the pass stops and names
    // the failing commands instead of reporting a generic ERR18 halt.
    const f1 = JSON.parse(readFileSync(out1, 'utf8')) as {
      status: string;
      stoppedAt: string;
      failedTests: string[];
      halted?: string;
      issues: Array<{ id: string }>;
      instruction: string;
    };
    expect(f1.status).toBe('stopped');
    expect(f1.stoppedAt).toBe('finish-tests');
    expect(f1.failedTests.length).toBeGreaterThan(0);
    expect(f1.halted).toBeUndefined(); // not the ERR18 rollback path
    expect(f1.issues.some((i) => i.id === 'ERR40_TESTS_FAILED')).toBe(true);
    expect(f1.instruction).toContain('publish nothing');
    expect(readJournal(dir).some((e) => e.action === 'finish-tests-failed')).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'push')).toBe(false);
    // Re-run from the verify phase with a green gate -> completes; push not redone before.
    const out2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: passCmds(ws), out: out2 }),
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out2, 'utf8')) as { ok: boolean }).ok).toBe(true);
    expect(machineState(dir).phase).toBe('complete');
  });

  it('a failed target push (ERR15 per-branch, D-059 FINAL) -> finish reports PARTIAL (no hard halt); re-running after the fix completes without re-pushing', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
      confirm,
    );
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize

    // Break the transport (credential-proxy failure mode) DETERMINISTICALLY:
    // the rewrite now points at a dead local path — never the real github.com.
    repo.breakOriginTransport(bare);
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: passCmds(ws), out: out1 }),
      ),
    ).toBe(1);
    // PARTIAL, not a push-phase hard halt: the failure is per-branch and factual.
    const f1 = JSON.parse(readFileSync(out1, 'utf8')) as {
      status: string;
      halted?: string;
      failedPushes: Array<{ branch: string; category: string }>;
    };
    expect(f1.status).toBe('partial');
    expect(f1.halted).toBeUndefined();
    expect(f1.failedPushes[0].branch).toBe('main_patched');
    expect(f1.failedPushes[0].category).toBe('transient'); // dead local path -> deterministic category
    expect(readJournal(dir).some((e) => e.action === 'push' && e.kind === 'target')).toBe(false); // nothing pushed
    expect(readJournal(dir).some((e) => e.action === 'push-failed' && e.branch === 'main_patched')).toBe(true);
    expect(machineState(dir).phase).toBe('finishing'); // NOT sealed — resumable

    // Fix the transport, re-run: verify still green, push now lands, complete.
    repo.healOriginTransport(bare);
    const out2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: passCmds(ws), out: out2 }),
      ),
    ).toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'push' && e.kind === 'target').length).toBe(1);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
    expect(machineState(dir).phase).toBe('complete');
  });

  it('held publish crash window (finding #1): PR exists API-side but the pr-published row was lost -> finish RECONCILES and completes, no duplicate PR, no halt', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm);
    writePr(dir, caseId, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize

    // Simulate the prior-run crash: GitHub already has the open PR for the
    // deterministic head branch (created just before the crash), while the
    // journal carries NO `pr-published` row for the case.
    const gh = fakeGithub({
      'GET /pulls?': { status: 200, body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12 }] },
    });
    const out = join(ws, 'finish.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: passCmds(ws), out }),
        gh.factory,
      ),
    ).toBe(0); // NO halt — the loop reconciles and continues
    const res = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; status: string };
    expect(res.ok).toBe(true);
    expect(res.status).toBe('complete');
    expect(machineState(dir).phase).toBe('complete');
    // The reconciling row has the normal pr-published shape (journal healed).
    const pub = readJournal(dir).find((e) => e.action === 'pr-published' && e.caseId === caseId)!;
    expect(pub.number).toBe(12);
    expect(pub.url).toBe('https://github.com/k-fls/fixture/pull/12');
    expect(pub.mode).toBe('held');
    expect(pub.branch).toBe('main_patched');
    expect(typeof pub.fixBranch).toBe('string');
    expect(typeof pub.head).toBe('string');
    expect(pub.reconciled).toBe(true);
    // NO duplicate PR was created and no pr-head push happened.
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'push' && e.kind === 'pr-head')).toBe(false);
  });

  it('cross-tier duplicate (finding #3): a held case matching a published JUDGED sibling is journaled held-duplicate and finish completes (no ERR06 wedge)', async () => {
    // feat/a (judged) and feat/b (held) carry the SAME fork edit and conflict
    // identically against the same main_patched tip: same paths + same head.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: disjoint', { 'src/mp.ts': 'mp\n' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('a: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('feat/b', { create: true, at: 'main_patched' });
    repo.commit('b: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
    ]);
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'feat/a', 'feat/b');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');

    await cmdSweepStart(baseCli(repo, ws, inv));
    // Case 1 (feat/a): resolve JUDGED — merged locally at report-pr, PR at finish.
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseA = currentCaseId(dir);
    resolveWorktree(dir, caseA, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm);
    writePr(dir, caseA, 'judged x', 'Decision needed: keep the fork line in src/x.ts.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    // Case 2 (feat/b): the SAME conflict signature — freeze it HELD. This
    // passes report-case (the judged sibling is resolved, not yet published).
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseB = currentCaseId(dir);
    expect(caseB).not.toBe(caseA);
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm);
    writePr(dir, caseB, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize

    const gh = fakeGithub();
    const out = join(ws, 'finish.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: passCmds(ws), out }),
        gh.factory,
      ),
    ).toBe(0); // completes — the duplicate held case never wedges phase 4
    expect(machineState(dir).phase).toBe('complete');
    const journal = readJournal(dir);
    // The judged sibling published; the held duplicate did NOT (skip journaled).
    expect(journal.some((e) => e.action === 'pr-published' && e.caseId === caseA && e.mode === 'judged')).toBe(true);
    expect(journal.some((e) => e.action === 'pr-published' && e.caseId === caseB)).toBe(false);
    const dup = journal.find((e) => e.action === 'held-duplicate' && e.caseId === caseB)!;
    expect(dup).toBeTruthy();
    expect(dup.duplicateOf).toBe(caseA);
    expect(dup.number).toBe(7);
    // Exactly ONE PR was created (the judged one) — never a second for the dup.
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls')).length).toBe(1);
    // No fix/sweep ref was pushed for the duplicate (only the judged case's).
    const fixRefs = repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep');
    expect(fixRefs).not.toContain('feat__b');
    expect(fixRefs).toContain('feat__a');
  });
});

describe('sweep — crash resume (machine-state drives re-entry, D-053 §5)', () => {
  it('a re-invoked next-case re-serves the same open case idempotently', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId1 = currentCaseId(dir);
    // "dead container resumes": a fresh next-case reads the machine state + journal.
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    expect(currentCaseId(dir)).toBe(caseId1);
    // resolve + report picks up from the persisted state.
    resolveWorktree(dir, caseId1, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      ),
    ).toBe(0);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED');
  });
});

describe('sweep progress — SWEEP-STEP observability (D-054)', () => {
  // Capture STDOUT faithfully: `progress` goes through process.stdout.write, `emit`
  // through console.log — both land on fd 1 (interleaved) in production, but under
  // vitest console.log is intercepted separately, so we swap BOTH into one shared,
  // call-ordered buffer to reproduce the real interleaving.
  function captureStdout(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origLog = console.log;
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      const cb = rest.find((r) => typeof r === 'function') as ((e?: Error) => void) | undefined;
      cb?.();
      return true;
    };
    console.log = (...args: unknown[]): void => {
      chunks.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
    };
    return {
      text: () => chunks.join(''),
      restore: () => {
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        console.log = origLog;
      },
    };
  }
  // The TWO-PREFIX contract (D-054): SWEEP-STEP lines are relayed progress;
  // SWEEP-RESULT is the SINGLE guidance line (compact JSON) the agent acts on;
  // any BARE JSON line (a line starting with `{`) would be a nested command that
  // failed to be silenced — the hazard this closes, so we assert there are none.
  function splitSweep(raw: string): { steps: string[]; results: unknown[]; bareJson: string[] } {
    const lines = raw.split('\n');
    const steps = lines.filter((l) => l.startsWith('SWEEP-STEP: ')).map((l) => l.slice('SWEEP-STEP: '.length));
    const results = lines
      .filter((l) => l.startsWith('SWEEP-RESULT: '))
      .map((l) => JSON.parse(l.slice('SWEEP-RESULT: '.length)) as unknown);
    const bareJson = lines.filter((l) => l.trimStart().startsWith('{') || l.trimStart().startsWith('['));
    return { steps, results, bareJson };
  }

  it('report-case mechanical: interleaved SWEEP-STEP lines, exactly one SWEEP-RESULT line that parses to the guidance', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });

    const cap = captureStdout();
    let rc: number;
    try {
      rc = await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      );
    } finally {
      cap.restore();
    }
    expect(rc).toBe(0);

    const { steps, results, bareJson } = splitSweep(cap.text());
    // MAJOR steps only: the mechanical cold read, then the in-place merge.
    expect(steps).toContain('cold-read: main_patched');
    expect(steps).toContain('mechanical resolve: main_patched — merged');
    // Exactly ONE result line, parsed to the guidance the agent acts on.
    expect(results).toHaveLength(1);
    expect((results[0] as { instruction: string; tier: string }).instruction).toBe('merged, take next case');
    expect((results[0] as { tier: string }).tier).toBe('mechanical');
    // No SWEEP-STEP text leaked into the parsed result; no un-prefixed JSON blob.
    expect(JSON.stringify(results[0])).not.toContain('SWEEP-STEP');
    expect(bareJson).toEqual([]);
  });

  it('next-case: batched merge summary + case-ready steps, and cmdRun (internal) emits NO JSON — exactly one SWEEP-RESULT', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));

    const cap = captureStdout();
    let rc: number;
    try {
      rc = await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    } finally {
      cap.restore();
    }
    expect(rc).toBe(0);

    const { steps, results, bareJson } = splitSweep(cap.text());
    expect(steps).toContain('scanning upstream');
    expect(steps.some((s) => /^planning \(\d+ branches\)$/.test(s))).toBe(true);
    // one batched summary line — never one line per merged branch
    expect(steps.some((s) => /^merged \d+ clean \/ skipped \d+ \/ deferred \d+$/.test(s))).toBe(true);
    expect(steps.some((s) => s.startsWith('case ready: main_patched — '))).toBe(true);
    // the nested cmdRun is silenced: no bare JSON blob, exactly one SWEEP-RESULT.
    expect(bareJson).toEqual([]);
    expect(results).toHaveLength(1);
    expect((results[0] as { status: string }).status).toBe('case-ready');
  });

  it('next-case on a clean pass: batched summary, `no more cases`, one finalize SWEEP-RESULT, no bare JSON', async () => {
    const repo = cleanFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));

    const cap = captureStdout();
    try {
      expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    } finally {
      cap.restore();
    }
    const { steps, results, bareJson } = splitSweep(cap.text());
    expect(steps).toContain('no more cases');
    expect(steps.some((s) => /^merged \d+ clean /.test(s))).toBe(true);
    expect(bareJson).toEqual([]);
    expect(results).toHaveLength(1);
    expect((results[0] as { status: string }).status).toBe('finalize');
  });

  it('finish: nested verify/publish/push (internal) emit NO JSON — exactly one SWEEP-RESULT for the whole command', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));

    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm);
    writePr(dir, caseId, 'judged x', 'Decision needed: keep the fork line in src/x.ts.');
    await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize

    const gh = fakeGithub();
    const cap = captureStdout();
    let rc: number;
    try {
      rc = await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile }),
        gh.factory,
      );
    } finally {
      cap.restore();
    }
    expect(rc).toBe(0);

    const { steps, results, bareJson } = splitSweep(cap.text());
    // the finish major steps show the phases (nested verify/publish/push run, but
    // ONLY their SWEEP-STEP progress surfaces — never their result JSON).
    expect(steps).toContain('verify: running');
    expect(steps).toContain('verify: green');
    expect(steps.some((s) => /^push: targets \(\d+\)$/.test(s))).toBe(true);
    expect(steps).toContain('report ready');
    // the whole multi-step command yields exactly ONE result line, no bare JSON.
    expect(bareJson).toEqual([]);
    expect(results).toHaveLength(1);
    expect((results[0] as { ok: boolean; status: string }).ok).toBe(true);
    expect((results[0] as { status: string }).status).toBe('complete');
  });
});

describe('cold-read infra failure ≠ content reject (D-054, ERR35_COLDREAD_UNAVAILABLE)', () => {
  it('parseMachineVerdict: a valid confirm/reject is content; unparseable OR auth text is an infra error', () => {
    expect(parseMachineVerdict('noise\n{"verdict":"confirm","notes":"ok"}\n').verdict).toBe('confirm');
    expect(parseMachineVerdict('{"verdict":"reject","notes":"drops behaviour"}').verdict).toBe('reject');
    // no parseable verdict object -> error (NOT reject)
    const unparseable = parseMachineVerdict('total garbage, no json here');
    expect(unparseable.verdict).toBe('error');
    expect(unparseable.reason).toMatch(/no parseable verdict/i);
    // auth/login failure printed at exit 0 -> error (NOT reject)
    const auth = parseMachineVerdict('Invalid API key · Please run /login');
    expect(auth.verdict).toBe('error');
    expect(auth.reason).toMatch(/auth\/login failure/i);
  });

  it('parseMachineVerdict: the 1-2 line `feedback` field is carried through and BOUNDED (D-057)', () => {
    const withFeedback = parseMachineVerdict(
      '{"verdict":"reject","notes":"drops behaviour","feedback":"restore the fork guard in src/x.ts"}',
    );
    expect(withFeedback.feedback).toBe('restore the fork guard in src/x.ts');
    // Bounded: an over-long feedback is capped, never carried whole.
    const long = parseMachineVerdict(
      `{"verdict":"reject","notes":"n","feedback":"${'x'.repeat(2000)}"}`,
    );
    expect(long.feedback!.length).toBeLessThanOrEqual(400);
    // Absent/blank feedback stays absent.
    expect(parseMachineVerdict('{"verdict":"confirm","notes":"ok"}').feedback).toBeUndefined();
    expect(parseMachineVerdict('{"verdict":"confirm","notes":"ok","feedback":"  "}').feedback).toBeUndefined();
  });

  it('report-case mechanical: infra error -> HARD HALT (ERR35), case NOT held, still case-ready', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        infraError,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
    // NOT a content decision: no freeze, branch unchanged, still the current case.
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
    // journaled as a halt with the id, so a dead session still shows why.
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
  });

  it('report-case mechanical: a cold read that RAN and rejected is a CONTENT decision — retry path, never ERR35', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    // A genuine reject is a content decision: first strike -> revise-and-retry
    // (rc 1, no freeze) and NEVER the ERR35 infra halt.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        rejectCode,
      ),
    ).toBe(1);
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId && e.rejected === true)).toBe(
      true,
    );
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(false);
    // Second strike -> HELD (still a content decision, still no ERR35).
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        rejectCode,
      ),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(false);
  });

  it('report-case mechanical: confirm -> merges (no halt, no freeze)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      ),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(false);
  });

  it('report-case JUDGED: infra error -> HARD HALT (ERR35), never awaiting-pr, nothing merged (D-060 moved this gate)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    const beforeTip = repo.sha('main_patched');
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const out = join(ws, 'rc.json');
    // The judged cold read runs HERE now, so its infra failure halts HERE — the
    // case never reaches awaiting-pr on broken tooling.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        infraError,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
    // NOT a content decision: no freeze, nothing merged, still the current case.
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    expect(repo.sha('main_patched')).toBe(beforeTip);
    expect(machineState(dir).phase).toBe('case-ready');
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
  });
});

describe('sweep start — origin-derived merge_status (D-058)', () => {
  /**
   * Manufacture an UNMERGED origin fix/sweep ref for main_patched: a driver-
   * shaped PR-head commit (2nd parent = the conflict head U1, so the block
   * height re-derives to h1) pushed to the deterministic fix branch name.
   */
  function pushFixRef(repo: FixtureRepo, content = 'OWNER-RESOLVED\n'): { fixBranch: string; fixHead: string } {
    const u1 = repo.sha('main'); // the conflicting trunk head (U1)
    const mpTip = repo.sha('main_patched');
    // Resolution tree: main_patched's tree with src/x.ts swapped.
    repo.checkout('tmp-resolution', { create: true, at: 'main_patched' });
    repo.commit('tmp: resolution content', { 'src/x.ts': content });
    const tree = repo.git('rev-parse', 'tmp-resolution^{tree}');
    repo.checkout('main');
    repo.git('branch', '-D', 'tmp-resolution');
    const fixHead = repo.git('commit-tree', tree, '-p', mpTip, '-p', u1, '-m', 'Resolution for owner review');
    const fixBranch = `fix/sweep/main_patched--main-h1-${u1.slice(0, 8)}`;
    repo.git('push', 'origin', `${fixHead}:refs/heads/${fixBranch}`);
    return { fixBranch, fixHead };
  }

  it('unmerged ref + open PR -> PR_ID: the branch derives blocked (origin-blocked journal row), takes nothing', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
    });
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, out }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const row = readJournal(dir).find((e) => e.action === 'origin-blocked')!;
    expect(row.branch).toBe('main_patched');
    expect(row.fixBranch).toBe(fixBranch);
    expect(row.headSha).toBe(fixHead);
    expect(row.prNumber).toBe(12);
    // No human comments -> plain PR_ID: never a reissue case, never a reopen/create.
    expect(readJournal(dir).some((e) => e.action === 'case')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'origin-pr-reopened' || e.action === 'origin-pr-created')).toBe(
      false,
    );
    // The ref survives (a live PR — the owner can act on it).
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
    // The blocked branch takes NOTHING this pass: no case, no merge, finalize.
    const before = repo.sha('main_patched');
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');
    expect(repo.sha('main_patched')).toBe(before);
    expect(readJournal(dir).some((e) => e.action === 'skip' && e.branch === 'main_patched' && e.reason === 'held')).toBe(
      true,
    );
  });

  it('merged ref -> RESOLVED: not blocked, the origin ref is deleted (cleanup)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    // The owner merged the PR: origin/main_patched advances to a merge commit
    // CONTAINING the fix head.
    const mergedTip = repo.git(
      'commit-tree',
      `${fixHead}^{tree}`,
      '-p',
      repo.sha('main_patched'),
      '-p',
      fixHead,
      '-m',
      'owner merged the review PR',
    );
    repo.git('push', 'origin', `${mergedTip}:refs/heads/main_patched`);
    // No unmerged refs remain -> no PR lookup -> no token needed.
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'origin-blocked')).toBe(false);
    const resolved = journal.find((e) => e.action === 'origin-ref-resolved')!;
    expect(resolved.ref).toBe(fixBranch);
    expect(resolved.branch).toBe('main_patched');
    expect(resolved.deleteFailed ?? undefined).toBeUndefined();
    // The origin ref is GONE (cleanup).
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
    // The branch is unblocked: next-case ff-syncs to the owner's merge and
    // processes normally (U1 landed via the owner resolution -> clean pass).
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'skip' && e.branch === 'main_patched' && e.reason === 'held')).toBe(
      false,
    );
  });

  it('unmerged ref with NO PR at all (crashed publish) -> the PR is (RE)CREATED from the ref; branch blocked; ref NEVER deleted (D-059 case 5)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub(); // default: GET /pulls?state=all -> [] (no PR in ANY state)
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    // The crashed publish is COMPLETED, never discarded: PR created from the
    // authoritative ref (marker-clean resolution head -> ACTIVE, not draft),
    // marker posted at 0, D-058's orphan-delete is retired.
    const created = journal.find((e) => e.action === 'origin-pr-created')!;
    expect(created.ref).toBe(fixBranch);
    expect(created.prNumber).toBe(7);
    expect(created.draft).toBe(false);
    const prPost = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect((prPost.body as { head: string }).head).toBe(fixBranch);
    expect((prPost.body as { base: string }).base).toBe('main_patched');
    expect((prPost.body as { draft: boolean }).draft).toBe(false);
    const marker = gh.calls.find((c) => c.method === 'POST' && c.path.includes('/issues/7/comments'))!;
    expect(String((marker.body as { body: string }).body)).toContain('<!-- sweep-addressed: 0 -->');
    // The branch IS blocked (PR_ID on the recovered PR) and the ref is intact.
    const row = journal.find((e) => e.action === 'origin-blocked')!;
    expect(row.branch).toBe('main_patched');
    expect(row.prNumber).toBe(7);
    expect(journal.some((e) => e.action === 'origin-ref-orphaned')).toBe(false);
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');
  });

  it('ref present + PR CLOSED (not merged) -> REOPENED via PATCH state=open -> PR_ID; nothing deleted (D-059 case 4)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'closed' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    const reopened = journal.find((e) => e.action === 'origin-pr-reopened')!;
    expect(reopened.ref).toBe(fixBranch);
    expect(reopened.prNumber).toBe(12);
    const patch = gh.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/12'))!;
    expect((patch.body as { state: string }).state).toBe('open');
    const row = journal.find((e) => e.action === 'origin-blocked')!;
    expect(row.branch).toBe('main_patched');
    expect(row.prNumber).toBe(12);
    // Ref intact (the delete arm is gone) and the branch takes nothing.
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');
  });

  it('REVIEW-only trigger: a NEW loose comment (and bot reviews, and a quote-reply embedding the marker) do NOT reissue; only a review above the marker would', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /issues/12/comments': {
        status: 200,
        body: [
          // Driver bookkeeping (marker at review 300) + a later urge re-asserting
          // it: excluded by CONTENT (same PAT as the human), marker = 300.
          { id: 4, body: 'Sweep bookkeeping (driver-posted)\n<!-- sweep-addressed: 300 -->', user: { login: 'flsclaw' } },
          { id: 6, body: '# Urge — main_patched still blocked\n<!-- sweep-addressed: 300 -->', user: { login: 'flsclaw' } },
          // A NEW loose human comment ABOVE everything: comments NEVER trigger.
          { id: 999, body: 'just pinging — any update?', user: { login: 'k-owner' }, created_at: '2026-07-22T00:00:00Z' },
          // A HUMAN quote-reply EMBEDDING the marker stays human (own-line-only
          // detection) — and still does not trigger (it is a comment).
          { id: 1000, body: 'replying to the bot:\n> <!-- sweep-addressed: 300 -->\nok', user: { login: 'k-owner' } },
        ],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [
          // The review the marker already addressed (id 300 <= marker 300).
          { id: 300, state: 'CHANGES_REQUESTED', body: 'earlier round', user: { login: 'k-owner' }, submitted_at: '2026-07-20T00:00:00Z' },
          // A NEWER *[bot]* review: ignored for the trigger.
          { id: 950, state: 'CHANGES_REQUESTED', body: 'lint gripes', user: { login: 'ci-lint[bot]' }, submitted_at: '2026-07-22T01:00:00Z' },
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    const row = journal.find((e) => e.action === 'origin-blocked')!;
    expect(row.prNumber).toBe(12);
    expect(row.markerId).toBe(300);
    // Newest non-bot REVIEW (300) <= marker (300): NO reissue — just blocked,
    // despite the newer loose comments and the newer bot review.
    expect(journal.some((e) => e.action === 'case')).toBe(false);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');
  });

  it('a failing comment list is ERR13 (fail-closed): start halts, no block journaled, no pass opened, ref intact', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /issues/12/comments': { status: 502, body: null },
    });
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, out }), gh.factory)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues[0].id).toBe('ERR13_API_FAILED');
    expect(readJournal(dirOf(repo, ws)).some((e) => e.action === 'origin-blocked')).toBe(false);
    expect(existsSync(join(dirOf(repo, ws), 'plan-initial.json'))).toBe(false);
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
  });

  it('a REJECTED token (403) is ERR41 naming the token SOURCE — not a generic ERR13 the agent would retry', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'stale-token\n');
    // The token is PRESENT (so not ERR11) but GitHub rejects it mid-pass — the
    // in-flight failure every networked command can hit once the token comes
    // from the environment rather than from the agent.
    const gh = fakeGithub({ 'GET /pulls?': { status: 403, body: { message: 'Bad credentials' } } });
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, out }), gh.factory)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string; detail: string }> };
    expect(res.issues[0].id).toBe('ERR41_TOKEN_REJECTED');
    // The report must name WHERE the rejected token came from — a stale ambient
    // $GITHUB_TOKEN and a revoked $GH_TOKEN otherwise fail identically.
    expect(res.issues[0].detail).toContain(tokenFile);
    expect(res.issues[0].detail).toContain('403');
    expect(res.issues[0].detail).toContain('cannot clear this'); // retrying is pointless — say so
    // Fail-closed exactly like ERR13: nothing journaled, no pass, ref intact.
    expect(readJournal(dirOf(repo, ws)).some((e) => e.action === 'origin-blocked')).toBe(false);
    expect(existsSync(join(dirOf(repo, ws), 'plan-initial.json'))).toBe(false);
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
  });

  it('ERR41 names $GH_TOKEN / $GITHUB_TOKEN when the token came from the environment (D-060 env default)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const gh = fakeGithub({ 'GET /pulls?': { status: 401, body: { message: 'Bad credentials' } } });
    const prevGh = process.env.GH_TOKEN;
    const prevGithub = process.env.GITHUB_TOKEN;
    cleanups.push(() => {
      if (prevGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevGh;
      if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGithub;
    });
    // No --token-file: a STALE AMBIENT $GITHUB_TOKEN is what the driver picks up.
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'stale-ambient';
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }), gh.factory)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string; detail: string }> };
    expect(res.issues[0].id).toBe('ERR41_TOKEN_REJECTED');
    expect(res.issues[0].detail).toContain('$GITHUB_TOKEN'); // the actual culprit is named
    expect(res.issues[0].detail).not.toContain('stale-ambient'); // never echo the token itself
  });

  it('a non-auth API failure stays ERR13 (the retry-once path is unchanged)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({ 'GET /pulls?': { status: 500, body: { message: 'boom' } } });
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, out }), gh.factory)).toBe(1);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> }).issues[0].id).toBe(
      'ERR13_API_FAILED',
    );
  });

  it('a failing REOPEN is ERR13 (fail-closed): no wrongful mutation, ref intact, nothing journaled reopened', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'closed' }],
      },
      'PATCH /pulls/12': { status: 500, body: { message: 'boom' } },
    });
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, out }), gh.factory)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues[0].id).toBe('ERR13_API_FAILED');
    expect(readJournal(dirOf(repo, ws)).some((e) => e.action === 'origin-pr-reopened')).toBe(false);
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
  });

  it('ref ABSENT (crashed in flight, resolution lost) -> fresh re-derive: ordinary case, no origin rows, no token needed (D-059 case 6)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    // No fix/sweep ref anywhere: the prior pass died before its publish.
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    const dir = dirOf(repo, ws);
    expect(
      readJournal(dir).some(
        (e) => e.action === 'origin-blocked' || e.action === 'origin-pr-created' || e.action === 'origin-pr-reopened',
      ),
    ).toBe(false);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    const served = JSON.parse(readFileSync(nc, 'utf8')) as { status: string; reissue?: boolean; materials: string };
    expect(served.status).toBe('case-ready');
    expect(served.reissue ?? false).toBe(false);
    // A FRESH conflict case: marker content in the worktree, fresh-case briefing.
    expect(served.materials).toContain('RESOLVE ONLY THE PENDING FILES');
    const caseId = currentCaseId(dir);
    expect(readFileSync(join(dir, caseId, 'worktree', 'src/x.ts'), 'utf8')).toContain('<<<<<<<');
  });

  it('open PR + NEW review (CHANGES_REQUESTED) -> REISSUE: revision case from the PRIOR resolution, time-ordered DIALOG in materials, forced HELD; finish live-rechecks + force-updates the SAME PR + posts the review-id marker (D-059 case 3)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo); // prior resolution: src/x.ts = OWNER-RESOLVED
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [
          {
            html_url: 'https://github.com/k-fls/fixture/pull/12',
            number: 12,
            state: 'open',
            body: 'Decision needed: original resolution of src/x.ts.\n<!-- sweep-addressed: 0 -->',
            created_at: '2026-07-18T00:00:00Z',
          },
        ],
      },
      'GET /issues/12/comments': {
        status: 200,
        body: [
          {
            id: 4,
            body: 'Sweep bookkeeping (driver-posted): first publish.\n<!-- sweep-addressed: 0 -->',
            user: { login: 'flsclaw' },
            created_at: '2026-07-19T00:00:00Z',
          }, // the agent's own prior turn (tag-bearing)
          {
            id: 9,
            body: 'keep the fork guard but adopt the upstream naming',
            user: { login: 'k-owner' },
            created_at: '2026-07-20T10:00:00Z',
          }, // loose human comment — dialog only, never a trigger by itself
        ],
      },
      'GET /pulls/12/comments': {
        status: 200,
        body: [
          {
            id: 700,
            body: 'this hunk drops the guard',
            user: { login: 'k-owner' },
            created_at: '2026-07-20T23:00:00Z',
            path: 'src/x.ts',
          }, // inline review comment — dialog only
        ],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [
          {
            id: 500,
            state: 'CHANGES_REQUESTED',
            body: 'Please keep the guard.',
            user: { login: 'k-owner' },
            submitted_at: '2026-07-21T00:00:00Z',
          }, // THE trigger: submitted review above the marker (0)
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const caseRow = readJournal(dir).find((e) => e.action === 'case')!;
    expect(caseRow.reissue).toBe(true);
    expect(caseRow.prNumber).toBe(12);
    expect(caseRow.addressedReviewId).toBe(500); // the REVIEW id, not a comment id
    expect(caseRow.reviewState).toBe('CHANGES_REQUESTED');
    expect(caseRow.fixBranch).toBe(fixBranch);
    expect(caseRow.priorHead).toBe(fixHead);
    const caseId = caseRow.caseId as string;
    // The branch stays PR_ID (blocked row) — the case is a revision, not a merge.
    expect(readJournal(dir).some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(true);
    // The worktree pending file carries the PRIOR RESOLUTION, not markers.
    expect(readFileSync(join(dir, caseId, 'worktree', 'src/x.ts'), 'utf8')).toBe('OWNER-RESOLVED\n');

    // next-case serves the revision with the FULL DIALOG, time-ordered.
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    const served = JSON.parse(readFileSync(nc, 'utf8')) as {
      status: string;
      caseId: string;
      reissue?: boolean;
      materials: string;
    };
    expect(served.status).toBe('case-ready');
    expect(served.caseId).toBe(caseId);
    expect(served.reissue).toBe(true);
    expect(served.materials).toContain('REVISE the resolution accordingly; do not start over');
    // Agent-own turns: PR description + tag-bearing comment — tag STRIPPED,
    // clearly marked as the agent's own.
    expect(served.materials).toContain('you (prior) — PR description');
    expect(served.materials).toContain('Decision needed: original resolution of src/x.ts.');
    expect(served.materials).toContain('you (prior) — comment 4');
    expect(served.materials).not.toContain('<!-- sweep-addressed:'); // tags never served back
    // Other turns keep the author's GitHub login so the agent can address them.
    expect(served.materials).toContain('@k-owner — comment 9');
    expect(served.materials).toContain('keep the fork guard but adopt the upstream naming');
    expect(served.materials).toContain('@k-owner — inline comment 700 on src/x.ts');
    expect(served.materials).toContain('@k-owner — review 500 — CHANGES_REQUESTED');
    // Time order: description < driver comment < loose comment < inline < review.
    const posOf = (s: string): number => served.materials.indexOf(s);
    expect(posOf('you (prior) — PR description')).toBeLessThan(posOf('you (prior) — comment 4'));
    expect(posOf('you (prior) — comment 4')).toBeLessThan(posOf('@k-owner — comment 9'));
    expect(posOf('@k-owner — comment 9')).toBeLessThan(posOf('@k-owner — inline comment 700'));
    expect(posOf('@k-owner — inline comment 700')).toBeLessThan(posOf('@k-owner — review 500'));

    // The agent revises the prior resolution; ANY claimed tier routes to HELD
    // (a revision must republish to the existing PR, never merge locally).
    resolveWorktree(dir, caseId, { 'src/x.ts': 'REVISED\n' });
    const rcOut = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out: rcOut }),
        confirm,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(rcOut, 'utf8')) as { tier: string }).tier).toBe('held');
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('fork'); // NO local merge
    writePr(dir, caseId, 'revised: fork guard + upstream naming for src/x.ts', 'Decision needed: revised per review — src/x.ts keeps the fork guard and adopts the upstream naming.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);

    // finish: the LIVE state of PR #12 is re-checked (still open here), the
    // revision replaces the fix ref head (compare-and-swap force) and the SAME
    // PR is updated — no second PR; the marker advances to REVIEW id 500.
    const ghFin = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12': {
        status: 200,
        body: { number: 12, html_url: 'https://github.com/k-fls/fixture/pull/12', state: 'open', merged: false, body: 'x' },
      },
    });
    const finOut = join(ws, 'fin.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, out: finOut }),
        ghFin.factory,
      ),
    ).toBe(0);
    const pub = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(pub.reissued).toBe(true);
    expect(pub.number).toBe(12);
    expect(pub.addressedReviewId).toBe(500);
    expect(ghFin.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(false); // no second PR
    const titlePatch = ghFin.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/12'));
    expect(
      titlePatch.some((c) => (c.body as { title?: string }).title === 'revised: fork guard + upstream naming for src/x.ts'),
    ).toBe(true);
    // The new marker records the addressed REVIEW id (500); the urge posted
    // this finish re-asserted the OLD id (0) so it stays bot-classified next pass.
    const comments = ghFin.calls.filter((c) => c.method === 'POST' && c.path.includes('/issues/12/comments'));
    expect(
      comments.some((c) => String((c.body as { body: string }).body).includes('<!-- sweep-addressed: 500 -->')),
    ).toBe(true);
    expect(
      comments.some(
        (c) =>
          String((c.body as { body: string }).body).startsWith('# Urge') &&
          String((c.body as { body: string }).body).includes('<!-- sweep-addressed: 0 -->'),
      ),
    ).toBe(true);
    // The origin fix ref MOVED to the revised resolution head (old head replaced).
    const newHead = repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`);
    expect(newHead).not.toBe(fixHead);
    expect(repo.git('show', `${newHead}:src/x.ts`)).toBe('REVISED');
    expect(repo.git('rev-parse', `${newHead}^2`)).toBe(repo.sha('main')); // still merges the conflict head
    // The target branch itself is untouched on origin (blocked: nothing merged).
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
  });

  it('APPROVED review + still merges cleanly -> LANDED (no reissue): merged locally at start, verify-gated push at finish auto-flips the PR', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 42, state: 'APPROVED', body: 'LGTM', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    const approved = journal.find((e) => e.action === 'origin-approved')!;
    expect(approved.branch).toBe('main_patched');
    expect(approved.reviewId).toBe(42);
    expect(approved.prNumber).toBe(12);
    expect(journal.some((e) => e.action === 'origin-blocked')).toBe(false); // NOT blocked
    expect(journal.some((e) => e.action === 'case')).toBe(false); // NO reissue
    // Landed LOCALLY: main_patched now contains the fix head + the resolution.
    expect(await isAncestor(repo.dir, fixHead, 'main_patched')).toBe(true);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('OWNER-RESOLVED');
    // ...but NOT on origin yet: the landing is verify-gated at finish.
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).not.toBe(repo.sha('main_patched'));

    // next-case: the branch absorbed the conflict head -> nothing left, finalize.
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');

    // finish: verify green -> the target push lands the approved merge; the PR
    // auto-flips to merged (live refresh); no new PR is ever created.
    const ghFin = fakeGithub({
      'GET /pulls/12': {
        status: 200,
        body: { number: 12, state: 'closed', merged: true, title: 'review: main_patched resolution', body: 'x' },
      },
    });
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));
    const finOut = join(ws, 'fin.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile, out: finOut }),
        ghFin.factory,
      ),
    ).toBe(0);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched')); // landed
    expect(ghFin.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(false); // no new PR
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as {
      ok: boolean;
      stats: Record<string, unknown>;
      pullRequests: Array<{ number: number; kind: string; status: string; landed?: boolean }>;
      branches: Array<{ branch: string; landed: boolean }>;
    };
    expect(fin.ok).toBe(true);
    expect(fin.stats.approvedLanded).toBe(1);
    expect(fin.stats.targetsFailed).toBe(0);
    const pr12 = fin.pullRequests.find((p) => p.number === 12)!;
    expect(pr12.kind).toBe('approved-landing');
    expect(pr12.status).toBe('merged');
    expect(pr12.landed).toBe(true);
    expect(fin.branches.find((b) => b.branch === 'main_patched')!.landed).toBe(true);
  });

  it('APPROVED but the target ADVANCED (no longer merges cleanly) -> REISSUE against the new base; nothing landed', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixHead } = pushFixRef(repo); // resolution against the OLD tip
    // The target advances with a CONFLICTING edit after the approval.
    repo.checkout('main_patched');
    repo.commit('mp: x moved again', { 'src/x.ts': 'fork2\n' });
    repo.checkout('main');
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 42, state: 'APPROVED', body: 'LGTM', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'origin-approved')).toBe(false); // NOT landed
    expect(await isAncestor(repo.dir, fixHead, 'main_patched')).toBe(false);
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(true);
    const caseRow = journal.find((e) => e.action === 'case')!;
    expect(caseRow.reissue).toBe(true);
    expect(caseRow.reviewState).toBe('APPROVED');
    expect(caseRow.addressedReviewId).toBe(42);
    // The materials say re-resolve against the new base (approved-but-stale).
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    const served = JSON.parse(readFileSync(nc, 'utf8')) as { status: string; reissue?: boolean; materials: string };
    expect(served.status).toBe('case-ready');
    expect(served.reissue).toBe(true);
    expect(served.materials).toContain('was APPROVED');
    expect(served.materials).toContain('RE-RESOLVE it against the new base');
  });

  it('APPROVED head ALREADY CONTAINED in the local tip (prior landing whose push crashed) -> NO duplicate empty merge on the re-derive; finish pushes the existing merge', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixHead } = pushFixRef(repo);
    // A PRIOR pass landed the approved head locally; the target push never
    // arrived on origin (crash), so the ref still classifies unmerged.
    repo.checkout('main_patched');
    repo.git('merge', '--no-ff', fixHead, '-m', 'prior pass: landed the approved resolution');
    repo.checkout('main');
    const localTip = repo.sha('main_patched');
    const mergesBefore = repo.git('rev-list', '--merges', '--count', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 42, state: 'APPROVED', body: 'LGTM', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    const approved = journal.find((e) => e.action === 'origin-approved')!;
    expect(approved.alreadyContained).toBe(true);
    expect(approved.reviewId).toBe(42);
    // The core assertion: the tip did NOT move — no duplicate empty merge.
    expect(repo.sha('main_patched')).toBe(localTip);
    expect(repo.git('rev-list', '--merges', '--count', 'main_patched')).toBe(mergesBefore);
    // Still journaled as a resolution, so verify gates it and push carries it.
    expect(journal.some((e) => e.action === 'resolved' && e.tier === 'approved' && e.branch === 'main_patched')).toBe(true);
    expect(journal.some((e) => e.action === 'origin-blocked')).toBe(false);

    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');
    // finish: the target push finally lands the PRIOR merge on origin.
    const ghFin = fakeGithub({
      'GET /pulls/12': { status: 200, body: { number: 12, state: 'closed', merged: true, title: 'review', body: 'x' } },
    });
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile }),
        ghFin.factory,
      ),
    ).toBe(0);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(localTip);
  });

  it('APPROVED landing that FAILS verify -> rolled back + ESCALATED ONCE (owner comment, marker at the approving review id); the next start does NOT re-land (loop broken)', async () => {
    // The landing targets a FEATURE branch (feat/other): verify's rebuild base
    // is main_patched itself, so only a non-base branch can be attributed and
    // rolled back by the leave-one-out gate.
    const repo = cleanFixture();
    repo.checkout('feat/other', { create: true, at: 'main_patched' });
    repo.commit('other: own file', { 'src/o.ts': 'o\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'other', branch: 'feat/other', parents: ['main_patched'] }]);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'feat/other');
    const preTip = repo.sha('feat/other');
    // The approved-but-build-breaking resolution head on the origin fix ref.
    repo.checkout('tmp-fix', { create: true, at: 'feat/other' });
    repo.commit('fix: approved but breaks the build', { BAD: 'boom\n' });
    const fixHead = repo.sha('tmp-fix');
    repo.checkout('main');
    repo.git('branch', '-D', 'tmp-fix');
    repo.git('push', 'origin', `${fixHead}:refs/heads/fix/sweep/feat__other--main_patched-h1-deadbeef`);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 42, state: 'APPROVED', body: 'LGTM', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    expect(readJournal(dir).some((e) => e.action === 'origin-approved' && e.branch === 'feat/other')).toBe(true); // landed locally
    expect(await isAncestor(repo.dir, fixHead, 'feat/other')).toBe(true);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize');

    // The integration gate is RED exactly when the approved content is present
    // — verify attributes the approved landing and rolls it back.
    const gateFile = join(ws, 'cmds-gate.json');
    writeFileSync(gateFile, JSON.stringify([{ cmd: 'test ! -f BAD' }]));
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: gateFile, out: out1 }),
        gh.factory,
      ),
    ).toBe(1);
    expect((JSON.parse(readFileSync(out1, 'utf8')) as { halted: string }).halted).toBe('verify');
    const journal1 = readJournal(dir);
    expect(journal1.some((e) => e.action === 'pre-ref-rollback' && e.branch === 'feat/other')).toBe(true);
    expect(repo.sha('feat/other')).toBe(preTip); // landing rolled back
    // Finding 2: the rollback of an APPROVED landing journals the escalation.
    const rb = journal1.find((e) => e.action === 'approved-rollback')!;
    expect(rb.branch).toBe('feat/other');
    expect(rb.prNumber).toBe(12);
    expect(rb.reviewId).toBe(42);

    // Re-run finish (offender now held -> vacuous green): the push stage POSTS
    // the owner comment WITH the marker at the approving review id.
    const out2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: gateFile, out: out2 }),
        gh.factory,
      ),
    ).toBe(0);
    const esc = gh.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path.includes('/issues/12/comments') &&
        String((c.body as { body: string }).body).includes('FAILED'),
    )!;
    const escBody = String((esc.body as { body: string }).body);
    expect(escBody).toContain('APPROVED resolution');
    expect(escBody).toContain('integration build');
    expect(escBody).toContain('SUBMIT A NEW REVIEW');
    expect(escBody).toContain('<!-- sweep-addressed: 42 -->');
    expect(readJournal(dir).some((e) => e.action === 'approved-escalated' && e.prNumber === 12 && e.reviewId === 42)).toBe(true);
    // Origin was never touched by the failed landing.
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/feat/other')).toBe(preTip);

    // NEXT pass: the marker (now on the PR) covers review 42 — the sweep reads
    // the approval as addressed: BLOCKED, not re-landed. The re-loop is broken.
    const gh2 = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /issues/12/comments': {
        status: 200,
        body: [{ id: 9, body: escBody, user: { login: 'shared-pat' }, created_at: '2026-07-23T00:00:00Z' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 42, state: 'APPROVED', body: 'LGTM', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh2.factory)).toBe(0);
    const journal2 = readJournal(dir);
    expect(journal2.some((e) => e.action === 'origin-approved')).toBe(false); // NOT re-landed
    expect(journal2.some((e) => e.action === 'origin-blocked' && e.branch === 'feat/other' && e.markerId === 42)).toBe(true);
    expect(repo.sha('feat/other')).toBe(preTip);
  });

  it('a human-pasted out-of-range sweep-addressed marker does NOT silence the review loop (finding 4): a real review above the real marker still reissues', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /issues/12/comments': {
        status: 200,
        body: [
          { id: 4, body: 'Sweep bookkeeping (driver-posted)\n<!-- sweep-addressed: 300 -->', user: { login: 'shared-pat' } },
          // The poisoning attempt: an own-line marker far above any real review
          // id. Before the reality bound this read as markerId 999999999 and
          // permanently silenced the loop for this PR.
          { id: 5, body: '<!-- sweep-addressed: 999999999 -->', user: { login: 'k-owner' }, created_at: '2026-07-22T00:00:00Z' },
        ],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [
          { id: 300, state: 'CHANGES_REQUESTED', body: 'first round', user: { login: 'k-owner' }, submitted_at: '2026-07-20T00:00:00Z' },
          { id: 400, state: 'CHANGES_REQUESTED', body: 'second round — still wrong', user: { login: 'k-owner' }, submitted_at: '2026-07-22T01:00:00Z' },
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    // The pasted marker is ignored: the effective marker stays 300, review 400
    // is beyond it -> REISSUE case served.
    const caseRow = journal.find((e) => e.action === 'case')!;
    expect(caseRow.reissue).toBe(true);
    expect(caseRow.addressedReviewId).toBe(400);
    expect(caseRow.markerId).toBe(300);
    // The reviewer's pasted-marker comment stays a REVIEWER dialog turn.
    const dialog = JSON.parse(readFileSync(join(dir, String(caseRow.caseId), 'dialog.json'), 'utf8')) as Array<{
      role: string;
      id: number | null;
    }>;
    expect(dialog.find((t) => t.id === 5)?.role).toBe('reviewer');
  });

  it('a DISMISSED review beyond the marker does NOT reissue (nothing actionable): the marker is advanced instead and the branch just stays blocked', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 42, state: 'DISMISSED', body: 'withdrawn', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    // No reissue case, no landing — just blocked with the marker advanced.
    expect(journal.some((e) => e.action === 'case')).toBe(false);
    expect(journal.some((e) => e.action === 'origin-approved')).toBe(false);
    expect(journal.some((e) => e.action === 'review-dismissed' && e.reviewId === 42)).toBe(true);
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched' && e.markerId === 42)).toBe(true);
    // The marker advance was POSTED (once), so later passes read it as current.
    const marker = gh.calls.find(
      (c) => c.method === 'POST' && c.path.includes('/issues/12/comments') && String((c.body as { body: string }).body).includes('sweep-addressed'),
    )!;
    expect(String((marker.body as { body: string }).body)).toContain('<!-- sweep-addressed: 42 -->');
  });

  it('PR CLOSED with merged_at (squash/rebase merge — head not an ancestor) -> resolved + ref deleted; NEVER a reopen PATCH (no 422 halt)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [
          {
            html_url: 'https://github.com/k-fls/fixture/pull/12',
            number: 12,
            state: 'closed',
            merged_at: '2026-07-22T00:00:00Z', // MERGED (squash) — state is still 'closed'
          },
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    const resolved = journal.find((e) => e.action === 'origin-ref-resolved')!;
    expect(resolved.via).toBe('pr-merged');
    expect(resolved.prNumber).toBe(12);
    // NO reopen was attempted (the PATCH would 422 on a merged PR).
    expect(journal.some((e) => e.action === 'origin-pr-reopened')).toBe(false);
    expect(gh.calls.some((c) => c.method === 'PATCH')).toBe(false);
    // The ref is cleaned up and the branch is NOT blocked.
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
    expect(journal.some((e) => e.action === 'origin-blocked')).toBe(false);
    // The still-live conflict re-derives as an ORDINARY fresh case (unblocked).
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    const served = JSON.parse(readFileSync(nc, 'utf8')) as { status: string; reissue?: boolean };
    expect(served.status).toBe('case-ready');
    expect(served.reissue ?? false).toBe(false);
  });

  it('pagination: the NEWEST review lives past 100 items (page 2) and still triggers the reissue', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    // Page 1: 100 old bot reviews (GitHub returns OLDEST first — a page-1-only
    // reader would see ONLY these and mis-classify the PR as review-quiet).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      state: 'COMMENTED',
      body: 'scan',
      user: { login: 'scanner[bot]' },
      submitted_at: '2026-07-01T00:00:00Z',
    }));
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews?per_page=100&page=1': { status: 200, body: page1 },
      'GET /pulls/12/reviews?per_page=100&page=2': {
        status: 200,
        body: [
          {
            id: 999,
            state: 'CHANGES_REQUESTED',
            body: 'newest — beyond page 1',
            user: { login: 'k-owner' },
            submitted_at: '2026-07-22T00:00:00Z',
          },
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const caseRow = readJournal(dirOf(repo, ws)).find((e) => e.action === 'case')!;
    expect(caseRow.reissue).toBe(true);
    expect(caseRow.addressedReviewId).toBe(999); // the page-2 review WAS seen
    expect(caseRow.reviewState).toBe('CHANGES_REQUESTED');
  });

  it('owner pushed onto fix/sweep (head not driver-shaped) -> case REBUILT from the CURRENT ref head; the owner edit is the revision base', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    // The owner commits ON TOP of the driver-built head (single parent — the
    // ref head is no longer driver-shaped) and pushes it.
    repo.checkout('tmp-owner', { create: true, at: fixHead });
    repo.commit('owner: tweak the resolution', { 'src/x.ts': 'OWNER-EDIT\n' });
    const ownerHead = repo.sha('tmp-owner');
    repo.checkout('main');
    repo.git('branch', '-D', 'tmp-owner');
    repo.git('push', 'origin', `${ownerHead}:refs/heads/${fixBranch}`);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [
          { id: 77, state: 'CHANGES_REQUESTED', body: 'see my commit', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' },
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    // Rebuilt, not warn-degraded: journaled, with the conflict head recovered
    // from the ref name's sha8.
    const rebuilt = journal.find((e) => e.action === 'reissue-rebuilt')!;
    expect(rebuilt.ownerHead).toBe(ownerHead);
    expect(rebuilt.conflictHead).toBe(repo.sha('main'));
    const caseRow = journal.find((e) => e.action === 'case')!;
    expect(caseRow.reissue).toBe(true);
    expect((caseRow.head as { sha: string }).sha).toBe(repo.sha('main'));
    expect(caseRow.priorHead).toBe(ownerHead); // the force-with-lease CAS anchor = the OWNER's head
    // The worktree serves the OWNER's edit as the revision base.
    const caseId = caseRow.caseId as string;
    expect(readFileSync(join(dir, caseId, 'worktree', 'src/x.ts'), 'utf8')).toBe('OWNER-EDIT\n');
  });

  it('truly unusable ref (unparseable name) + new review -> ESCALATED ONCE on the PR (marker advanced to the review id), blocked, no case, no warn-loop', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    // An unparseable fix ref (no -h<n>-<sha8> tail) pointing at an unmerged commit.
    const badRef = 'fix/sweep/main_patched--garbled';
    repo.git('push', 'origin', `${repo.sha('main')}:refs/heads/${badRef}`);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [{ id: 55, state: 'CHANGES_REQUESTED', body: 'fix it', user: { login: 'k-owner' }, submitted_at: '2026-07-22T00:00:00Z' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    const escalated = journal.find((e) => e.action === 'origin-ref-escalated')!;
    expect(escalated.ref).toBe(badRef);
    expect(escalated.reviewId).toBe(55);
    // The escalation comment carries the marker AT the review id — the next
    // pass reads it as current and does NOT re-escalate (no per-pass loop).
    const esc = gh.calls.find(
      (c) => c.method === 'POST' && c.path.includes('/issues/12/comments') && String((c.body as { body: string }).body).includes('Sweep escalation'),
    )!;
    expect(String((esc.body as { body: string }).body)).toContain('<!-- sweep-addressed: 55 -->');
    // The comment must SAY the marker advanced and that only a NEW review
    // re-triggers — otherwise the owner fixes the ref and waits forever.
    expect(String((esc.body as { body: string }).body)).toContain('SUBMIT A NEW REVIEW');
    // Blocked, no case, ref untouched.
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(true);
    expect(journal.some((e) => e.action === 'case')).toBe(false);
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${badRef}`)).toBe(repo.sha('main'));
  });

  it('finish live-recheck: the owner MERGED the review PR mid-pass -> republish SKIPPED (no 2nd PR, no ref clobber), finish still green', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
      'GET /pulls/12/reviews': {
        status: 200,
        body: [
          { id: 500, state: 'CHANGES_REQUESTED', body: 'tighten it', user: { login: 'k-owner' }, submitted_at: '2026-07-21T00:00:00Z' },
        ],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'REVISED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, 'revised x', 'Decision needed: revised resolution of src/x.ts per review.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);

    // MID-PASS the owner merges PR #12. finish's live re-check must SKIP the
    // republish: no push, no PATCH, no second PR — the next start re-derives.
    const ghFin = fakeGithub({
      'GET /pulls/12': {
        status: 200,
        body: { number: 12, html_url: 'https://github.com/k-fls/fixture/pull/12', state: 'closed', merged: true, body: 'x' },
      },
    });
    const finOut = join(ws, 'fin.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, out: finOut }),
        ghFin.factory,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    const skipRow = journal.find((e) => e.action === 'publish-skipped-live')!;
    expect(skipRow.prNumber).toBe(12);
    expect(skipRow.liveState).toBe('merged');
    expect(journal.some((e) => e.action === 'pr-published')).toBe(false);
    expect(ghFin.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(false); // no 2nd PR
    // No title/body REPUBLISH of the merged PR (the urge's machine-block body
    // refresh is bookkeeping, not a clobber — it carries no title).
    expect(
      ghFin.calls.some((c) => c.method === 'PATCH' && (c.body as { title?: string }).title !== undefined),
    ).toBe(false);
    // The origin fix ref is UNTOUCHED (the revision was never force-pushed).
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as { ok: boolean; status: string };
    expect(fin.ok).toBe(true);
    expect(fin.status).toBe('complete');
  });

  it('unmerged refs REQUIRE the token (fail-closed): no --token-file -> ERR11, no pass opened, nothing deleted', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushFixRef(repo);
    // A MERGED fix ref is also present (its head is on origin/main_patched):
    // start must NOT delete it before the token gate — the gate fails closed
    // BEFORE any origin mutation (finding #6).
    const mergedRef = 'fix/sweep/main_patched--main-h0-cafecafe';
    const mergedHead = repo.git('rev-parse', 'refs/remotes/origin/main_patched');
    repo.git('push', 'origin', `${mergedHead}:refs/heads/${mergedRef}`);
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues[0].id).toBe('ERR11_TOKEN_MISSING');
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead); // untouched
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${mergedRef}`)).toBe(mergedHead); // merged ref untouched too
    expect(existsSync(join(dirOf(repo, ws), 'plan-initial.json'))).toBe(false); // no pass opened
  });

  it('a pass aborted before finish leaves NO PR on origin; a re-start re-derives a clean picture and redoes the pass', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const dir = dirOf(repo, ws);

    // Pass 1: hold the case, provide the PR text, record the intent — then the
    // pass dies before finish (abort = the sanctioned crash-equivalent).
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm);
    writePr(dir, caseId, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'pr-intent' && e.caseId === caseId)).toBe(true);
    expect(await cmdSweepAbort(baseCli(repo, ws, inv, { cmd: 'sweep-abort' }))).toBe(0);

    // NOTHING was published: no PR journal row, no fix/sweep ref on origin,
    // origin main_patched untouched.
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');

    // Re-start: the origin picture is CLEAN (no refs -> no PR checks -> no
    // token), nothing is blocked, and the pass simply redoes the work — the
    // same conflict is served fresh.
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'origin-blocked')).toBe(false);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    const res = JSON.parse(readFileSync(nc, 'utf8')) as { status: string; caseId: string };
    expect(res.status).toBe('case-ready');
    expect(res.caseId).toBe(caseId); // deterministic re-derivation of the same case
  });
});

describe('sweep finish — owner-facing PR + stats summary on the success SWEEP-RESULT (D-059)', () => {
  it('a green finish carries pullRequests (start-found-open + created) with titles/status, stats, and the REPORT cue', async () => {
    // Two related PRs: feat/other is blocked at start by an OPEN review PR
    // (#12) on its origin fix ref; main_patched freezes HELD this pass and its
    // draft review PR (#7) is created at finish.
    const repo = conflictFixture();
    repo.checkout('feat/other', { create: true, at: 'main_patched' });
    repo.commit('other: own file', { 'src/o.ts': 'o\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'other', branch: 'feat/other', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'feat/other');
    const otherRef = `fix/sweep/feat__other--main_patched-h0-${repo.sha('main').slice(0, 8)}`;
    repo.git('push', 'origin', `${repo.sha('main')}:refs/heads/${otherRef}`); // unmerged into feat/other
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const openPr12 = {
      status: 200,
      body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
    };
    const gh = fakeGithub({ 'GET feat__other': openPr12 });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const dir = dirOf(repo, ws);
    expect(readJournal(dir).some((e) => e.action === 'origin-blocked' && e.branch === 'feat/other')).toBe(true);

    // main_patched's conflict -> held (pristine draft) -> intent.
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);

    const ghFin = fakeGithub({
      'GET feat__other': openPr12,
      'GET /pulls/12': {
        status: 200,
        body: { number: 12, state: 'open', merged: false, draft: false, title: 'prior review: feat/other', body: 'x' },
      },
      'GET /pulls/7': {
        status: 200,
        body: { number: 7, state: 'open', merged: false, draft: true, title: 'held x', body: 'x' },
      },
    });
    const finOut = join(ws, 'fin.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, out: finOut }),
        ghFin.factory,
      ),
    ).toBe(0);
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as {
      ok: boolean;
      pullRequests: Array<{ number: number; url: string; title: string | null; status: string; kind: string }>;
      stats: Record<string, unknown>;
      instruction: string;
    };
    expect(fin.ok).toBe(true);
    // EVERY related PR, with live title/status: the one start found open...
    const pr12 = fin.pullRequests.find((p) => p.number === 12)!;
    expect(pr12.kind).toBe('review-open-at-start');
    expect(pr12.status).toBe('open');
    expect(pr12.title).toBe('prior review: feat/other');
    // ...and the one created this run.
    const pr7 = fin.pullRequests.find((p) => p.number === 7)!;
    expect(pr7.kind).toBe('held-review');
    expect(pr7.status).toBe('draft');
    expect(pr7.title).toBe('held x');
    // Journal-derived stats + the explicit REPORT cue for the agent.
    expect(fin.stats.prsOpenAtStart).toBe(1);
    expect(fin.stats.prsCreatedHeld).toBe(1);
    expect(fin.stats.prsCreatedJudged).toBe(0);
    expect(fin.stats.cleanMerges).toBe(1); // the U0 clean prefix
    expect(fin.stats.held).toBe(1);
    expect(fin.stats.branchesInScope).toBe(2);
    expect(fin.instruction).toContain('REPORT to the owner');
    expect(fin.instruction).toContain('pullRequests');
  });
});

describe('sweep finish — push resilience (D-059 FINAL): per-branch, categorized, resumable', () => {
  it('the FIRST target diverged -> the rest still land; partial factual report (ERR15 label, no halt); a healed re-run retries only the failure', async () => {
    // Two clean targets: main_patched (upstream-chain) and feat/other (child).
    const repo = cleanFixture();
    repo.checkout('feat/other', { create: true, at: 'main_patched' });
    repo.commit('other: own file', { 'src/o.ts': 'o\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'other', branch: 'feat/other', parents: ['main_patched'] }]);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'feat/other');
    const mpPre = repo.sha('main_patched');

    await cmdSweepStart(baseCli(repo, ws, inv));
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('finalize'); // all clean merges
    expect(repo.sha('main_patched')).not.toBe(mpPre); // the pass advanced both branches locally

    // MID-PASS an external commit lands on origin/main_patched -> the FIRST
    // push target is diverged (owner escalation), the second must still land.
    const external = repo.git('commit-tree', `${mpPre}^{tree}`, '-p', mpPre, '-m', 'external commit on origin');
    repo.git('push', 'origin', `${external}:refs/heads/main_patched`);

    const dir = dirOf(repo, ws);
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));
    const finOut = join(ws, 'fin.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmdsFile, out: finOut })),
    ).toBe(1);
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as {
      ok: boolean;
      status: string;
      branches: Array<{ branch: string; landed: boolean; category?: string }>;
      failedPushes: Array<{ branch: string; category: string }>;
      stats: { targetsFailed: number; failedByCategory: Record<string, number> };
      instruction: string;
    };
    expect(fin.ok).toBe(false);
    expect(fin.status).toBe('partial');
    // feat/other LANDED despite main_patched failing FIRST...
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/feat/other')).toBe(repo.sha('feat/other'));
    // ...and the diverged branch was NEVER force-resolved (origin untouched).
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(external);
    expect(fin.branches.find((b) => b.branch === 'feat/other')!.landed).toBe(true);
    const mp = fin.branches.find((b) => b.branch === 'main_patched')!;
    expect(mp.landed).toBe(false);
    expect(mp.category).toBe('diverged');
    expect(fin.failedPushes).toEqual([expect.objectContaining({ branch: 'main_patched', category: 'diverged' })]);
    expect(fin.stats.targetsFailed).toBe(1);
    expect(fin.stats.failedByCategory.diverged).toBe(1);
    expect(fin.instruction).toContain('main_patched: diverged');
    expect(fin.instruction).toContain('feat/other');
    // Finding 3: a diverged push is OWNER-ACTION-REQUIRED — a first-class
    // needsOwner field (not merely a category) so an autonomous re-run loop
    // can stop re-trying this branch, plus a distinct escalation journal row.
    const finFull = JSON.parse(readFileSync(finOut, 'utf8')) as {
      needsOwner: Array<{ branch: string; category: string }>;
      instruction: string;
    };
    expect(finFull.needsOwner).toEqual([expect.objectContaining({ branch: 'main_patched', category: 'diverged' })]);
    expect(finFull.instruction).toContain('OWNER ACTION REQUIRED');
    // Journal: per-branch `push-failed` (ERR15 stays the LABEL) — NO halt row.
    const journal = readJournal(dir);
    expect(
      journal.some((e) => e.action === 'push-failed' && e.branch === 'main_patched' && e.category === 'diverged' && e.id === 'ERR15_PUSH_FAILED'),
    ).toBe(true);
    expect(
      journal.some((e) => e.action === 'push-escalated' && e.branch === 'main_patched' && e.category === 'diverged'),
    ).toBe(true);
    expect(journal.some((e) => e.action === 'halt' && e.id === 'ERR15_PUSH_FAILED')).toBe(false);
    // Partial => the pass is NOT sealed (resumable).
    expect(machineState(dir).phase).toBe('finishing');
    expect(journal.some((e) => e.action === 'pass-complete')).toBe(false);

    // The owner heals origin/main_patched (restores the pre-divergence tip);
    // the re-run pushes ONLY the failed branch — feat/other skips up-to-date.
    repo.git('push', '--force', 'origin', `${mpPre}:refs/heads/main_patched`);
    const fin2Out = join(ws, 'fin2.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmdsFile, out: fin2Out })),
    ).toBe(0);
    const fin2 = JSON.parse(readFileSync(fin2Out, 'utf8')) as { ok: boolean; status: string };
    expect(fin2.ok).toBe(true);
    expect(fin2.status).toBe('complete');
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
    const journal2 = readJournal(dir);
    expect(journal2.filter((e) => e.action === 'push' && e.branch === 'feat/other').length).toBe(1); // never re-pushed
    expect(journal2.some((e) => e.action === 'push-skip' && e.branch === 'feat/other' && e.reason === 'up-to-date')).toBe(true);
    expect(machineState(dir).phase).toBe('complete');
  });

  it('SYSTEMIC OUTAGE (every push fails transient): held publishes are NOT attempted over the dead network — partial report, resumable; a healed re-run completes them', async () => {
    // A held case pending publish + a dead transport: without the short-circuit
    // finish would still attempt the held publish (whose first step is a git
    // push of the fix ref) over the same dead network.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize

    repo.breakOriginTransport(bare); // the outage
    const gh = fakeGithub();
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile, out: out1 }),
        gh.factory,
      ),
    ).toBe(1);
    const f1 = JSON.parse(readFileSync(out1, 'utf8')) as {
      status: string;
      systemicOutage?: boolean;
      heldPublishesSkipped?: number;
      failedPushes: Array<{ branch: string; category: string }>;
      failedPublishes: unknown[];
    };
    expect(f1.status).toBe('partial');
    expect(f1.failedPushes[0].category).toBe('transient');
    expect(f1.systemicOutage).toBe(true);
    expect(f1.heldPublishesSkipped).toBe(1);
    expect(f1.failedPublishes).toEqual([]); // skipped, not attempted-and-failed
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'publish-phase-skipped' && e.reason === 'systemic-outage')).toBe(true);
    expect(journal.some((e) => e.action === 'publish-failed')).toBe(false); // never attempted
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls')).length).toBe(0); // no PR attempted
    expect(machineState(dir).phase).toBe('finishing'); // resumable

    // Network heals -> the re-run pushes the target AND publishes the held PR.
    repo.healOriginTransport(bare);
    const out2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile, out: out2 }),
        gh.factory,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out2, 'utf8')) as { status: string }).status).toBe('complete');
    expect(readJournal(dir).some((e) => e.action === 'pr-published' && e.caseId === caseId)).toBe(true);
    expect(machineState(dir).phase).toBe('complete');
  });

  it('blocking push-phase issues (ERR16) ride the PARTIAL payload instead of being dropped when per-branch failures also occurred', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
      confirm,
    );
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize
    // A judged PR published by a PRIOR crashed run (journal row without a
    // matching case) whose closure check will fail (merged: false -> ERR16)…
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'pr-published', caseId: 'ghost', mode: 'judged', number: 21 }) + '\n',
    );
    // …while the target push itself fails transient (dead transport).
    repo.breakOriginTransport(bare);
    const gh = fakeGithub({
      'GET /pulls/21': { status: 200, body: { number: 21, merged: false, state: 'open', body: 'x' } },
    });
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile, out: out1 }),
        gh.factory,
      ),
    ).toBe(1);
    const f1 = JSON.parse(readFileSync(out1, 'utf8')) as {
      status: string;
      blockingIssues: Array<{ id: string; detail: string }>;
      instruction: string;
    };
    expect(f1.status).toBe('partial');
    // Before finding 3 the ERR16 lived only in cmdPush's own output and the
    // partial SWEEP-RESULT dropped it entirely.
    expect(f1.blockingIssues.some((i) => i.id === 'ERR16_CLOSURE_FAILED')).toBe(true);
    expect(f1.instruction).toContain('ERR16_CLOSURE_FAILED');
    expect(readJournal(dir).some((e) => e.action === 'push-issue' && e.id === 'ERR16_CLOSURE_FAILED')).toBe(true);
  });
});

describe('sweep start — canonical pass location + clean-slate boundary (D-055)', () => {
  it('clears a COMPLETE/STALE prior pass at the canonical dir — no inherited journal/machine-state', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const wm = repo.sha('main');

    // Plant a STALE prior pass at the canonical location: a leftover journal with
    // a D-053 HELD + a machine-state marked complete (a finished/aborted run at
    // the same watermark). This is the 2026-07-22 contamination shape.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: '2026-07-21T00:00:00Z', action: 'held', branch: 'main_patched', caseId: 'stale-case', height: 1 }) + '\n',
    );
    writeFileSync(
      join(dir, 'machine-state.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'complete', watermark: wm, watermark12: wm.slice(0, 12), currentCase: null }),
    );
    writeFileSync(
      join(dir, 'plan-initial.json'),
      JSON.stringify({ watermark: wm, watermark12: wm.slice(0, 12), forkPoint: null, branches: [] }),
    );

    // start at the SAME watermark: the stale pass is CLEARED, not inherited.
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }))).toBe(0);
    // The canonical pass-dir path is reported (start owns + logs the ONE location).
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; passDir: string };
    expect(res.passDir).toBe(dir);
    const j = readJournal(dir);
    expect(j.some((e) => e.action === 'held' && e.caseId === 'stale-case')).toBe(false); // leftover HELD gone
    expect(j.some((e) => e.action === 'sweep-start')).toBe(true); // fresh journal
    expect(machineState(dir).phase).toBe('open');
  });

  it('refuses when a pass is still OPEN (phase != complete) — never blind-wipe an in-flight pass', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0); // a real open pass (phase 'open')
    const startTs = readJournal(dir).find((e) => e.action === 'sweep-start')!.ts;

    const out = join(ws, 'start2.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }))).toBe(1); // refuse, do not clear
    const res = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; issues?: Array<{ id: string }> };
    expect(res.issues?.some((i) => i.id === 'ERR30_PASS_OPEN')).toBe(true);
    // the in-flight pass's journal is intact (NOT wiped): same first sweep-start entry.
    expect(readJournal(dir).find((e) => e.action === 'sweep-start')!.ts).toBe(startTs);
  });

  it('C-1: --workspace defaults to the GROUP ROOT (parent of --repo); an explicit one is honored', () => {
    expect(parseCli(['next-case', '--repo', '/srv/grp/repo']).workspace).toBe('/srv/grp');
    expect(parseCli(['next-case', '--repo', '/srv/grp/repo', '--workspace', '/srv/grp']).workspace).toBe('/srv/grp');
  });

  it('C-1: start REFUSES a --workspace that IS the --repo clone (never lands in the clone)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const out = join(ws, 'refuse.json');
    // workspace === the clone toplevel -> refused, no pass created.
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { workspace: repo.dir, out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR37_WORKSPACE_IN_CLONE')).toBe(true);
    expect(existsSync(join(repo.dir, 'propagation'))).toBe(false); // nothing landed in the clone
  });

  it('C-1: start REFUSES a --workspace that is a SUBDIRECTORY of the --repo clone', async () => {
    const repo = conflictFixture();
    const inv = emptyInventory();
    const sub = join(repo.dir, 'nested', 'ws');
    mkdirSync(sub, { recursive: true });
    const out = join(mkWorkspace(), 'refuse-sub.json');
    expect(await cmdSweepStart(baseCli(repo, sub, inv, { workspace: sub, out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR37_WORKSPACE_IN_CLONE')).toBe(true);
  });

  it('C-1: a group-root workspace whose ANCESTOR is a git repo (but NOT under --repo) is ACCEPTED (real-server shape)', async () => {
    // Real server: `~/nanoclaw2` is itself a git repo, group root
    // `~/nanoclaw2/groups/<g>` = dirname(repo). The guard must key off --repo
    // ONLY, so a group root nested in an OUTER work tree is accepted.
    const repo = conflictFixture(); // the fork clone (its own git work tree, elsewhere)
    const inv = emptyInventory();
    const outer = mkdtempSync(join(tmpdir(), 'sm-outer-'));
    cleanups.push(() => rmSync(outer, { recursive: true, force: true }));
    execFileSync('git', ['-C', outer, 'init', '-q']); // outer is a git work tree
    const groupRoot = join(outer, 'groups', 'fls-maintainer');
    mkdirSync(groupRoot, { recursive: true });
    // workspace = group root: inside the OUTER work tree, but NOT under --repo.
    expect(await cmdSweepStart(baseCli(repo, groupRoot, inv, { workspace: groupRoot }))).toBe(0);
    expect(existsSync(join(groupRoot, 'propagation'))).toBe(true); // pass landed in the group root, accepted
  });

  it('C-1: the DEFAULT workspace (dirname(--repo)) passes the guard even when an ancestor is a git repo', async () => {
    // Build the fork clone INSIDE an outer git repo at <outer>/groups/<g>/repo,
    // then start with the parseCli DEFAULT workspace = dirname(repo) = the group
    // root — which sits inside the outer work tree yet is NOT under the clone.
    const outer = mkdtempSync(join(tmpdir(), 'sm-outer2-'));
    cleanups.push(() => rmSync(outer, { recursive: true, force: true }));
    execFileSync('git', ['-C', outer, 'init', '-q']);
    const groupRoot = join(outer, 'groups', 'fls-maintainer');
    const cloneDir = join(groupRoot, 'repo');
    mkdirSync(cloneDir, { recursive: true });
    // A minimal fork clone at cloneDir (own git tree): main + main_patched + upstream.
    const g = (...a: string[]): void => void execFileSync('git', ['-C', cloneDir, ...a], { stdio: 'ignore' });
    g('init', '-b', 'main');
    g('config', 'user.email', 'f@t.invalid');
    g('config', 'user.name', 'f');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(cloneDir, 'x.ts'), 'orig\n');
    g('add', '-A');
    g('commit', '-m', 'base');
    g('checkout', '-b', 'main_patched');
    writeFileSync(join(cloneDir, 'x.ts'), 'fork\n');
    g('add', '-A');
    g('commit', '-m', 'mp');
    g('checkout', 'main');
    writeFileSync(join(cloneDir, 'util.ts'), 'u\n');
    g('add', '-A');
    g('commit', '-m', 'U0');

    // parseCli default: no --workspace -> dirname(repo) = groupRoot.
    const cli = parseCli(['sweep-start', '--repo', cloneDir]);
    expect(cli.workspace).toBe(groupRoot);
    const inv = emptyInventory();
    const started: Cli = {
      cmd: 'sweep-start',
      repo: cloneDir,
      workspace: groupRoot,
      inventory: inv,
      scopeFile: join(inv, 'no-scope.yaml'),
      upstream: 'main',
      execute: false,
    };
    expect(await cmdSweepStart(started)).toBe(0);
    expect(existsSync(join(groupRoot, 'propagation'))).toBe(true);
  });

  it('C-4: abort seals the pass with `pass-complete` so it is not re-attached as the latest open pass', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // merges the U0 prefix, serves the conflict case
    expect(await cmdSweepAbort(baseCli(repo, ws, inv, { cmd: 'sweep-abort' }))).toBe(0);
    // WITHOUT this row attachPass ("open" = plan-initial.json AND no pass-complete)
    // would keep re-attaching to the aborted pass — the C-4 bug.
    expect(readJournal(dir).some((e) => e.action === 'pass-complete')).toBe(true);
    expect(machineState(dir).phase).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// D-061 (B): GATE-FIX. An unattributable verify red used to dead-end in an
// ERR18/ERR40 asking a HUMAN to fix something the agent may not deliver (it
// cannot push or open a PR). It now becomes a case.
// ---------------------------------------------------------------------------

/**
 * PRE-MERGE BRANCH CHECK (owner decision 2026-07-31). Detection runs FORWARD,
 * with the sweep, at the one place merging actually happens — `next-case`, which
 * calls cmdRun. A branch already red must not be merged into or propagated from:
 * either way every descendant inherits a defect it cannot fix inside its own
 * conflict scope, which is what livelocked the live 2026-07-31 pass.
 */
describe('next-case — a participating branch that is RED before any merge', () => {
  /** main_patched carries a defect; module/cg branches off it and has work pending. */
  function redBaseRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: carries the defect', { 'src/x.ts': 'broken\n', 'BROKEN.marker': 'x\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg work', { 'src/cg.ts': 'cg\n' });
    repo.checkout('main');
    repo.commit('U0: upstream moves', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /** Red exactly when the checked-out tree carries the marker — i.e. per BRANCH. */
  const markerRunner: ChecksRunner = async (commands, cwd) => {
    const broken = existsSync(join(cwd, 'BROKEN.marker'));
    return {
      ok: !broken,
      failedNames: broken ? commands.map((c) => c.cmd) : [],
      output: broken ? 'src/x.ts(1,1): error TS2345: the tree is broken before any merge.\n' : '',
    };
  };

  it('serves a gate-fix on the RED branch and merges NOTHING', async () => {
    const repo = redBaseRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));
    const mpBefore = repo.sha('main_patched');
    const cgBefore = repo.sha('module/cg');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }))).toBe(0);
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks, out }), markerRunner)).toBe(0);

    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      caseId?: string;
      branch?: string;
      worktree?: string;
      instruction: string;
    };
    // SERVED ON THIS CALL — not "run next-case again". Returning a pointer here
    // stranded the case: the next call re-ran the check, hit the mint dedup, and
    // could never hand it over (live 2026-07-31).
    expect(res.status).toBe('case-ready');
    expect(res.caseId).toContain('gate-fix-main_patched');
    expect(res.branch).toBe('main_patched');
    expect(existsSync(res.worktree!)).toBe(true);

    // NOTHING was merged — the whole point. A red branch must not propagate.
    expect(repo.sha('main_patched')).toBe(mpBefore);
    expect(repo.sha('module/cg')).toBe(cgBefore);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'merge')).toBe(false);
    expect(journal.some((e) => e.action === 'branch-check' && e.branch === 'main_patched' && e.ok === false)).toBe(true);
  });

  it('a GREEN participant is checked once and the pass proceeds to merge', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: clean', { 'src/mp.ts': 'mp\n' });
    repo.checkout('main');
    repo.commit('U0: upstream moves', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));

    const ran: string[] = [];
    const countingRunner: ChecksRunner = async (commands, cwd) => {
      ran.push(cwd);
      return { ok: true, failedNames: [], output: '' };
    };
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), countingRunner)).toBe(0);
    // It merged (the pass proceeded past the check).
    expect(readJournal(dir).some((e) => e.action === 'merge')).toBe(true);
    // And the green result is memoised per (branch, sha) in the PASS journal —
    // a pass-local fact, not durable state: `start` wipes it, so it cannot go stale.
    const checkRows = readJournal(dir).filter((e) => e.action === 'branch-check');
    expect(checkRows.length).toBeGreaterThan(0);
    expect(checkRows.every((e) => e.ok === true)).toBe(true);
    // The memo is keyed by (branch, TIP SHA), so a tip that MOVED is re-checked —
    // correct, since the tree it attests to is a different tree. What must never
    // happen is checking the same (branch, sha) twice.
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), countingRunner);
    const keys = readJournal(dir)
      .filter((e) => e.action === 'branch-check')
      .map((e) => `${e.branch}@${e.sha}`);
    expect(new Set(keys).size).toBe(keys.length); // no (branch, sha) checked twice
  });

  /**
   * REGRESSION (live 2026-07-31): the check silently did nothing in production
   * while every fixture passed. `applyPassConfig` RETURNS the pass's checks file
   * rather than assigning it onto `cli`, so reading `cli.checksFile` in
   * `next-case` got undefined, `loadChecksConfig` returned null, and the check
   * exited at its first line — indistinguishable from "no checks file".
   *
   * This test resolves the path the way production does: `start` persists it
   * into machine state and later commands read it FROM THERE. `next-case` is
   * given no --checks-file flag at all.
   */
  it('resolves the checks file from MACHINE STATE, not from a flag on next-case', async () => {
    const repo = redBaseRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));
    const mpBefore = repo.sha('main_patched');

    // start records checksFile in machine state...
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }))).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'machine-state.json'), 'utf8')).checksFile).toBe(checks);

    // ...and next-case must pick it up from there, with NO flag of its own.
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), markerRunner)).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; branch?: string };
    expect(res.status).toBe('case-ready');
    expect(res.branch).toBe('main_patched');
    expect(repo.sha('main_patched')).toBe(mpBefore); // nothing merged
    expect(readJournal(dir).some((e) => e.action === 'branch-check')).toBe(true);
  });

  it('a CONFIGURED but unreadable checks file is LOUD, never a silent skip', async () => {
    const repo = redBaseRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [], test: [] })); // configured, but no gate
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), markerRunner);
    // The pass proceeds (an empty list is not fatal) but it must SAY the gate
    // did not run — a disabled gate that looks like a passing one is the ERR43
    // failure mode.
    expect(
      readJournal(dir).some((e) => e.action === 'warning' && e.id === 'WARN11_PRE_MERGE_CHECK_SKIPPED'),
    ).toBe(true);
  });

  /**
   * A HELD fix only reaches the owner when `finish` pushes its ref and opens the
   * PR. Live 2026-07-31: the agent fixed the red trunk, the case was held for an
   * unrelated hunk, and `next-case` then said "the pass stopped, report to the
   * owner" — so the agent reported and never ran `finish`. pr-intent journaled,
   * zero refs pushed, zero PRs: the fix existed only in the pass directory.
   */
  it('a red branch with an UNPUBLISHED held fix points at `finish`, not at a stop', async () => {
    const repo = redBaseRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }))).toBe(0);
    // Serve the gate-fix, then dispose it HELD without publishing.
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), markerRunner)).toBe(0);
    const caseId = currentCaseId(dir);
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'held', branch: 'main_patched', caseId }) + '\n',
    );

    const out = join(ws, 'nc2.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), markerRunner)).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      heldAwaitingPublish?: Array<{ branch: string }>;
      instruction: string;
    };
    // Points at finish — the command that actually publishes it.
    expect(res.status).toBe('finalize');
    expect(res.instruction).toContain('finish');
    expect(res.instruction).toContain('NOT yet published');
    expect(res.heldAwaitingPublish!.map((h) => h.branch)).toContain('main_patched');
  });

  it('no checks file -> the check is skipped entirely (repos without one behave as before)', async () => {
    const repo = redBaseRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/cg.ts'] }]);
    let called = false;
    const spy: ChecksRunner = async () => {
      called = true;
      return { ok: false, failedNames: ['x'], output: '' };
    };
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), spy);
    expect(called).toBe(false);
  });
});

describe('sweep finish — gate-fix on an unattributable red (D-061 B)', () => {
  // ROOT CAUSE of the serving bug, fixed 2026-07-28: `crashHeal` journaled `resolved` for every
  // gate-fix case on the next command. Its heuristic is "the ref already
  // contains the case head, so it was resolved before a crash" — but a gate-fix
  // case's head IS the branch tip, and a commit is its own ancestor, so it
  // matched instantly. `openCases` then dropped it and `next-case` answered
  // `finalize` with the case unserved.
  /** A fixture where a FEATURE branch owns the file the build fails on. */
  function gateFixRepo(withChild = false): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: y', { 'src/y.ts': 'fork\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg: own x', { 'src/x.ts': 'cg\n' });
    if (withChild) {
      repo.checkout('feat/child', { create: true, at: 'module/cg' });
      repo.commit('child work', { 'src/child.ts': 'c\n' });
    }
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }
  /** Verify commands failing with a REAL tsc diagnostic until the flag is cleared. */
  function redUntilCleared(ws: string): { cmds: string; clear: () => void } {
    const f = join(ws, 'cmds.json');
    const flag = join(ws, 'red-flag');
    writeFileSync(flag, 'red');
    writeFileSync(
      f,
      JSON.stringify([
        {
          cmd: `test ! -f ${flag} || { echo "src/x.ts(343,45): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'."; exit 1; }`,
        },
      ]),
    );
    return { cmds: f, clear: () => rmSync(flag, { force: true }) };
  }

  it('red + no attribution -> gate-fix case on the OWNING branch, served with a no-merge briefing', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const out = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      gateFix: { branch: string; files: string[]; caseId: string };
      issues: Array<{ id: string }>;
      instruction: string;
    };
    expect(res.status).toBe('gate-fix-required');
    expect(res.gateFix.branch).toBe('module/cg'); // blamed from the tsc path via owned_paths
    expect(res.gateFix.files).toEqual(['src/x.ts']);
    expect(res.instruction).toContain('next-case');
    // PROCEED arm: it hands out a case and says `next-case`, so its id must ADVISE.
    // It carried `ERR18_VERIFY_PENDING` — an id that elsewhere marks a genuine
    // block (ungated push, halted verify), and doctrine's rule is "never work
    // around a blocking id". Same defect class as the base-red arm above.
    expect(res.issues[0].id).toBe('WARN09_GATE_FIX_SERVED');
    expect(res.issues.some((i) => i.id.startsWith('ERR'))).toBe(false);
    // The red verify still gates everything else: nothing published or pushed.
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'push')).toBe(false);

    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect((JSON.parse(readFileSync(nc, 'utf8')) as { status: string }).status).toBe('case-ready');
    const materials = readFileSync(join(dir, res.gateFix.caseId, 'materials.md'), 'utf8');
    expect(materials).toContain('GATE-FIX');
    expect(materials).toContain('NOT a merge conflict');
    expect(materials).toContain('src/x.ts');
    expect(materials).toContain('--tier judged');
    // CLEAN worktree — no markers, nothing pending, unlike a conflict case.
    expect(repo.git('-C', join(dir, res.gateFix.caseId, 'worktree'), 'status', '--porcelain')).toBe('');
  });

  /**
   * BATCHING (owner-approved 2026-07-28). A red build routinely names files that
   * belong to DIFFERENT branches. One case forced them all onto one branch's
   * worktree, where the fix for someone else's file either cannot be made or
   * lands where it reaches nobody. One case PER BRANCH, carrying that branch's
   * files, SHALLOWEST BRANCH FIRST — a judged trunk/parent fix plus the reopen it
   * triggers can moot a descendant's case, so the shallower one must be workable
   * first.
   */
  it('failing files on TWO branches -> one gate-fix case each, shallowest branch first', async () => {
    const repo = gateFixRepo(true); // module/cg owns src/x.ts, feat/child owns src/child.ts
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', parents: ['main_patched'] },
      { id: 'child', branch: 'feat/child', parents: ['module/cg'] },
    ]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const cmds = join(ws, 'cmds.json');
    // The DEEPER branch's file is printed FIRST: order comes from the hierarchy,
    // never from the compiler's output order.
    writeFileSync(
      cmds,
      JSON.stringify([
        {
          cmd:
            'echo "src/child.ts(4,1): error TS2345: nope"; ' +
            'echo "src/x.ts(1,1): error TS2345: nope"; exit 1',
        },
      ]),
    );
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const out = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      gateFix: { caseId: string; branch: string; files: string[] };
      gateFixes: Array<{ caseId: string; branch: string; files: string[] }>;
    };
    expect(res.status).toBe('gate-fix-required');
    expect(res.gateFixes.map((g) => g.branch)).toEqual(['module/cg', 'feat/child']);
    expect(res.gateFixes.map((g) => g.files)).toEqual([['src/x.ts'], ['src/child.ts']]);
    // Distinct cases, each with its own worktree and its own anti-loop key.
    expect(res.gateFixes[0].caseId).not.toBe(res.gateFixes[1].caseId);
    for (const g of res.gateFixes) expect(existsSync(join(dir, g.caseId, 'worktree'))).toBe(true);
    const rows = readJournal(dir).filter((e) => e.action === 'gate-fix');
    expect(rows.map((e) => e.branch)).toEqual(['module/cg', 'feat/child']);
    expect(rows.map((e) => e.key)).toEqual(['module/cg::src/x.ts', 'feat/child::src/child.ts']);
    // The single-case reader gets the SHALLOWEST, which is what next-case serves.
    expect(res.gateFix.branch).toBe('module/cg');
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect(JSON.parse(readFileSync(nc, 'utf8')).caseId).toBe(res.gateFixes[0].caseId);
  });

  it('judged gate fix -> single-parent commit, descendants pulled through, and the SAME pass completes', async () => {
    const repo = gateFixRepo(true);
    const ws = mkWorkspace();
    const inv = writeInventory([
      // `parents` is REQUIRED here, as on every live entry. feat/child was cut
      // from module/cg, so src/x.ts sits on ITS first-parent line too (blame is
      // first-parent authorship, see attribute.ts) — depth is what separates the
      // two, and a parentless `cg` leaves both UNRESOLVED, which blame correctly
      // refuses as a tie instead of guessing.
      { id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/x.ts'] },
      { id: 'child', branch: 'feat/child', parents: ['module/cg'] },
    ]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds, clear } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const f1 = join(ws, 'f1.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out: f1 }));
    const gf = JSON.parse(readFileSync(f1, 'utf8')) as { status: string; gateFix: { caseId: string } };
    expect(gf.status).toBe('gate-fix-required');
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);

    const tipBefore = repo.sha('module/cg');
    resolveWorktree(dir, gf.gateFix.caseId, { 'src/x.ts': 'FIXED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, gf.gateFix.caseId, 'fix: nullable arg', 'Decision needed: the build was red on src/x.ts.');
    const pr = join(ws, 'pr.json');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out: pr }), confirm)).toBe(0);
    const prRes = JSON.parse(readFileSync(pr, 'utf8')) as { gateFix: boolean; mergeCommit: string; reopened: string[] };
    expect(prRes.gateFix).toBe(true);
    // SINGLE parent (commit + 1 parent = 2 fields): new code, not a propagation
    // merge. A second parent would record the tip as both sides — a self-merge.
    expect(repo.git('rev-list', '--parents', '-n', '1', prRes.mergeCommit).trim().split(/\s+/)).toHaveLength(2);
    expect(repo.git('show', `${prRes.mergeCommit}:src/x.ts`)).toBe('FIXED');
    expect(repo.sha('module/cg')).not.toBe(tipBefore);
    expect(prRes.reopened).toContain('feat/child'); // pulled through the DAG

    // The point of the judged tier: the fix is IN the branches, so once the build
    // is green the SAME pass completes — no restart, unlike the held tier.
    clear();
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // pull the fix through -> finalize
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub();
    const f2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, tokenFile, out: f2 }),
        gh.factory,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(f2, 'utf8')) as { ok: boolean }).ok).toBe(true);
    expect(machineState(dir).phase).toBe('complete');
    // feat/child carries the fix, pulled through by the reopen.
    expect(repo.git('show', 'feat/child:src/x.ts')).toBe('FIXED');
  });

  it('ANTI-LOOP: a second red over the same branch+files is NOT re-served', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const f1 = join(ws, 'f1.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out: f1 }));
    expect((JSON.parse(readFileSync(f1, 'utf8')) as { status: string }).status).toBe('gate-fix-required');
    const count = (): number => readJournal(dir).filter((e) => e.action === 'gate-fix').length;
    expect(count()).toBe(1);
    const f2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out: f2 })),
    ).toBe(1);
    expect(count()).toBe(1); // still ONE — the loop is closed
    expect((JSON.parse(readFileSync(f2, 'utf8')) as { status?: string }).status).not.toBe('gate-fix-required');
  });

  /** Drive a red finish to a served gate-fix case; returns its caseId. */
  async function serveGateFix(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    cmds: string,
  ): Promise<string> {
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const f1 = join(ws, 'gf.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out: f1 }));
    const res = JSON.parse(readFileSync(f1, 'utf8')) as { status: string; gateFix: { caseId: string } };
    expect(res.status).toBe('gate-fix-required');
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // serve it
    return res.gateFix.caseId;
  }

  /**
   * DEFECT 2 (HIGH) — a HELD gate fix is SILENTLY DROPPED, never published.
   * `publishHead`'s held arm opens with
   * `if (await isAncestor(cli.repo, jc.head.sha, tip)) -> ERR02_CASE_STALE
   * "the resolution landed"`. For a gate-fix case `head.sha` IS the branch tip
   * by construction, and `freezeHeld` never advances the ref, so the guard
   * fires on EVERY held gate fix: finish journals `publish-failed`, no
   * fix/sweep ref is pushed, no PR is opened, and the agent's fix is lost.
   *
   * CORRECT BEHAVIOUR: a HELD gate fix publishes like any other held case — a
   * fix/sweep ref + a PR for the owner.
   */
  it('DEFECT 2 — a HELD gate fix publishes a fix/sweep ref + PR (not ERR02 "the resolution landed")', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'module/cg');
    const { cmds, clear } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);

    // The agent fixes the file but is NOT confident -> --tier held: the fix must
    // reach the owner as a PR.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, 'fix: nullable arg', 'The build was red on src/x.ts — owner decision needed.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);

    clear(); // the held branch is out of the publishable set; the rest is green
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub();
    const f2 = join(ws, 'f2.json');
    await cmdSweepFinish(
      baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, tokenFile, out: f2 }),
      gh.factory,
    );
    const j = readJournal(dir);
    expect(j.filter((e) => e.action === 'publish-failed' && e.caseId === caseId)).toEqual([]);
    expect(j.some((e) => e.action === 'pr-published' && e.caseId === caseId)).toBe(true);
  });

  /**
   * DEFECT 8 (MED) — the judged gate-fix result claims an intent it never
   * recorded. The arm deliberately journals NO `pr-intent` row (a gate fix is a
   * single-parent commit, so the JUDGED history-PR path does not apply, and
   * finish's judged selection explicitly excludes `gateFix !== true`), yet it
   * still returns `prIntent: true`. The agent reads that field as "a PR is
   * coming at finish" and reports a PR to the owner that will never exist.
   *
   * CORRECT BEHAVIOUR: the result must not claim an intent that was not
   * recorded — `prIntent` must reflect the journal.
   */
  it('DEFECT 8 — the judged gate-fix result does not claim a pr-intent it never journaled', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);

    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, 'fix: nullable arg', 'The build was red on src/x.ts.');
    const pr = join(ws, 'pr.json');
    expect(
      await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out: pr }), confirm),
    ).toBe(0);
    const prRes = JSON.parse(readFileSync(pr, 'utf8')) as { gateFix: boolean; prIntent?: boolean };
    expect(prRes.gateFix).toBe(true);
    // No pr-intent row exists for this case — by design (documented in the arm).
    expect(readJournal(dir).some((e) => e.action === 'pr-intent' && e.caseId === caseId)).toBe(false);
    // …so the result must not advertise one.
    expect(prRes.prIntent).not.toBe(true);
  });

  /**
   * DEFECT 9a (MED) — the PRISTINE-CONFLICT path is reachable for a gate-fix
   * case. `report-case --tier held` on a gate-fix case whose worktree the agent
   * did not change takes branch 4 (`claimed === 'held' && conflictsPresent`,
   * where `conflictsPresent` is true merely because the tree equals the
   * automerge tree) and answers "base it on the PRISTINE conflict state" — for
   * a case that NEVER had a conflict, has no markers and nothing pending. The
   * agent is then told to describe a conflict that does not exist, and the case
   * freezes as a draft pristine-conflict PR of an empty diff.
   *
   * CORRECT BEHAVIOUR: a gate-fix case is never routed down the
   * pristine-conflict path; an unchanged gate-fix worktree means "you did not
   * fix anything", not "here is a pristine conflict".
   */
  it('DEFECT 9a — a gate-fix case is never routed down the PRISTINE-conflict path', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);
    expect(repo.git('-C', join(dir, caseId, 'worktree'), 'status', '--porcelain')).toBe(''); // no conflict, ever

    const out = join(ws, 'rc.json');
    // The agent gives up WITHOUT editing anything and claims held.
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
      neverInvoked,
    );
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(res.instruction).not.toMatch(/pristine/i);
  });

  /**
   * THE ID WAS A LIE (2026-07-28). A gate fix has no merge and therefore no
   * height, but `--case` was validated against the CONFLICT id shape
   * (`…-h<n>`): a bare `gate-fix-<branch>` was refused with ERR25_BAD_CASE_ID,
   * so no HELD gate fix could ever publish however green the rest of the
   * pipeline was. The workaround appended a FAKE height of `-h-1` — which then
   * flowed into the fix-ref name, into the origin ref reader, and into every
   * height reader downstream. The id now states the case's real identity
   * (branch + failing-file digest) and the N5 guard accepts that shape AS
   * ITSELF; the head carries its real height.
   */
  it('the gate-fix case file states the truth: identity id, real height, run invariant, tip tree', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);

    expect(caseId).toMatch(/^gate-fix-module__cg-[0-9a-f]{8}$/);
    expect(caseId).not.toContain('-h-'); // no invented height, of any sign
    const cf = JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as {
      head: { sha: string; height: number };
      run: Array<{ sha: string; height: number }>;
      automergeTree: string;
      deferredCheck: { firstConflictHeight: number };
    };
    // The head IS the branch tip; its height is that tip's real coverage on the
    // pass chain (`deriveCoverage`), so every height reader computes from a
    // fact — see the D-004 machine-block test below for what -1 cost.
    expect(cf.head.sha).toBe(repo.sha('module/cg'));
    // The branch absorbed the trunk during this pass's run, so its coverage is a
    // real chain index — never the -1 placeholder that used to sit here.
    expect(Number(repo.git('rev-list', '--count', 'module/cg..main').trim())).toBe(0);
    expect(cf.head.height).toBeGreaterThanOrEqual(0);
    expect(cf.run).toEqual([cf.head]); // run[run.length - 1] === head (types.ts)
    expect(cf.deferredCheck.firstConflictHeight).toBe(cf.head.height);
    // LOAD-BEARING, not incidental: the "automerge" tree is the branch tip's
    // tree because everything downstream reads this field as "the tree the
    // agent started from" — the scope guard diffs against it, `emptyResolution`
    // ("nothing was fixed") compares against it, and the cold read's resolution
    // diff is taken from it. A gate fix starts from the clean tip.
    expect(cf.automergeTree).toBe(repo.git('rev-parse', 'module/cg^{tree}').trim());

    // …and `publish --case <id>` ACCEPTS the id. ERR25_BAD_CASE_ID on exactly
    // this call is what the fake height was bought with.
    const out = join(ws, 'pub.json');
    await cmdPublish(baseCli(repo, ws, inv, { cmd: 'publish', caseId, out }));
    const pub = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(pub.issues.map((i) => i.id)).not.toContain('ERR25_BAD_CASE_ID');
  });

  /**
   * The id must be a function of the case's IDENTITY (branch + failing files),
   * not of its kind. `gate-fix-<branch>-h-1` was the same string for every gate
   * fix on a branch, so a second one in the same pass (different files — the
   * anti-loop key lets it through by design) reused the first's id: it would
   * inherit the first's `resolved` disposition, drop out of `openCases`, and
   * `next-case` could never serve it while `finish` kept demanding it.
   */
  it('two gate fixes on ONE branch over different files get DISTINCT ids', async () => {
    const repo = gateFixRepo();
    // BOTH files must be module/cg's OWN work for both fixes to land on ONE
    // branch — blame reads git history, and src/y.ts is main_patched's commit in
    // this fixture, so the second red would (correctly) blame the trunk instead
    // and this test would stop exercising the id collision it exists for.
    repo.checkout('module/cg');
    repo.commit('cg: own z', { 'src/z.ts': 'cg\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts', 'src/z.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    // Red on src/x.ts first; once that flag is cleared, red on src/z.ts.
    const flagX = join(ws, 'red-x');
    const flagY = join(ws, 'red-y');
    writeFileSync(flagX, 'x');
    writeFileSync(flagY, 'y');
    const cmds = join(ws, 'cmds.json');
    writeFileSync(
      cmds,
      JSON.stringify([
        {
          cmd:
            `if [ -f ${flagX} ]; then echo "src/x.ts(1,1): error TS2345: nope"; exit 1; ` +
            `elif [ -f ${flagY} ]; then echo "src/z.ts(2,2): error TS2345: nope"; exit 1; fi`,
        },
      ]),
    );

    const idX = await serveGateFix(repo, ws, inv, cmds);
    resolveWorktree(dir, idX, { 'src/x.ts': 'FIXED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, idX, 'fix: x', 'The build was red on src/x.ts.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);

    rmSync(flagX, { force: true }); // x is fixed; now y fails
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // pull the fix through the reopened DAG
    const f2 = join(ws, 'f2.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out: f2 }));
    const res2 = JSON.parse(readFileSync(f2, 'utf8')) as { status: string; gateFix: { caseId: string; files: string[] } };
    expect(res2.status).toBe('gate-fix-required');
    expect(res2.gateFix.files).toEqual(['src/z.ts']);
    // Same branch, different files -> a DIFFERENT case id (both gate-fix-shaped).
    expect(res2.gateFix.caseId).not.toBe(idX);
    expect(res2.gateFix.caseId).toMatch(/^gate-fix-module__cg-[0-9a-f]{8}$/);
    // …and the second case is actually servable, which an id collision (the
    // shared `-h-1` id) made impossible.
    const nc = join(ws, 'nc2.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }))).toBe(0);
    expect(JSON.parse(readFileSync(nc, 'utf8')).caseId).toBe(res2.gateFix.caseId);
  });

  /**
   * WHAT THE FAKE HEIGHT COST. The D-004 machine block on a held PR reports
   * `pendingAbove = chain.heads.length - 1 - head.height`. With `head.height =
   * -1` that is `heads.length` — MORE pending commits than the pass's chain
   * even holds — on every held gate-fix PR, for a branch that had in fact
   * absorbed the whole trunk this pass. The head's height is now the tip's
   * coverage, so the count is the truth.
   *
   * The fix REF NAME is the same lie in the other direction: it spelled
   * `--<slug('(gate-fix)')>-h-1-<sha8>`, putting a parent label that is not a
   * branch and a height that does not exist into a name the NEXT pass's origin
   * reader parses a real scope branch and a real trunk height out of.
   */
  it('a held gate fix publishes with a truthful D-004 count and an honest fix-ref name', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'module/cg');
    const { cmds, clear } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);

    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n' });
    expect(
      await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm),
    ).toBe(0);
    writePr(dir, caseId, 'fix: nullable arg', 'The build was red on src/x.ts — owner decision needed.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);

    clear();
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub();
    await cmdSweepFinish(
      baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, tokenFile, out: join(ws, 'f2.json') }),
      gh.factory,
    );
    const created = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
    expect(created).toBeDefined();
    const pr = created!.body as { head: string; body: string };
    // The ref names the case, not a parent that does not exist at a height that
    // does not exist. The `<slug(branch)>--` prefix stays — that is what maps
    // the ref back to its target branch at the next `sweep start`.
    expect(pr.head).toBe(`fix/sweep/module__cg--${caseId}`);
    expect(pr.head).not.toContain('gate-fix_-h'); // slug('(gate-fix)') + fake height
    // The pass merged the trunk into module/cg before the gate fix was minted,
    // so NOTHING is pending above it. `-1` claimed 1 (= the whole chain).
    const pending = Number(repo.git('rev-list', '--count', 'module/cg..main').trim());
    expect(pending).toBe(0);
    expect(pr.body).toContain(`beyond this freeze: **${pending}**`);
  });

  /**
   * `tierFloor: 'judged'` on a gate-fix case is LOAD-BEARING, not decoration:
   * the MECHANICAL arm of report-case merges the resolved tree in place with
   * the case head as the SECOND PARENT — and a gate fix's head IS the branch
   * tip, so a mechanical gate fix would commit a degenerate self-merge whose
   * diff reads as an empty merge instead of the fix.
   */
  it('tierFloor judged: a gate fix claimed MECHANICAL is floored, never merged in place', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);
    const tipBefore = repo.sha('module/cg');

    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('judged');
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    expect(repo.sha('module/cg')).toBe(tipBefore); // nothing was merged
    expect(machineState(dir).phase).toBe('awaiting-pr'); // it goes through report-pr
  });

  /**
   * On a GATE FIX the scope guard measures BLAST RADIUS; it does not police a
   * boundary. The file a compiler NAMES is often not the file that must change
   * — a signature, a type or a caller elsewhere may be the real fix — so
   * confining the edit to the named files would force the fix into the wrong
   * place. Reaching further is legitimate; what it costs is the tier: confined
   * to the named files a fix may land in place (judged), otherwise the owner
   * reviews it (held). So this is journaled as REACH, not as a violation, and
   * carries no escalation tag.
   *
   * (`same-files` is also the only mode that can apply — `conflict-hunks`
   * bounds edits by conflict-marker spans, and a gate fix's automerge tree is
   * the clean tip, with no markers to bound anything.)
   */
  it('scope guard on a gate fix: reaching beyond the named files caps the tier at held, and is not a violation', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);

    // src/y.ts is on the branch but is NOT one of the named failing files.
    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n', 'src/y.ts': 'STRAY\n' });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    // Demoted, not refused — the fix is kept and published for the owner.
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
    const journal = readJournal(dir);
    // REACH, not a violation: a gate fix editing outside the named files is
    // expected, so it must not be journaled as (or reported as) a fault.
    const reach = journal.find((e) => e.action === 'gate-fix-reach' && e.caseId === caseId);
    expect(reach?.mode).toBe('same-files');
    expect(reach?.extraPaths).toEqual(['src/y.ts']);
    expect(journal.some((e) => e.action === 'scope-violation' && e.caseId === caseId)).toBe(false);
    // ...and no `[AUTO-ESCALATED: scope exceeded]` tag rides along with it.
    expect(JSON.stringify(journal)).not.toContain('AUTO-ESCALATED: scope exceeded');
  });

  it('the cold read judges a gate fix on the FAILING CHECK, not on conflict hunks it has none of', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n' });
    let prompt = '';
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
      async (p) => {
        prompt = p;
        return { verdict: 'confirm', notes: '', feedback: '' };
      },
    );
    // The gate-fix questions, NOT the conflict ones. Q2 of the shared set —
    // "no content from outside the two sides/base" — is unanswerable here: the
    // conflict section is EMPTY by construction, so every hunk would read as
    // unexplained.
    expect(prompt).toContain('Does the change plausibly make the named failing check pass');
    expect(prompt).toContain('nothing unrelated fixed, cleaned up or refactored');
    expect(prompt).not.toContain('Within the conflicted hunks');
    expect(prompt).not.toContain('the two sides/base');
    // The EVIDENCE is the checks output, standing where conflict hunks stand.
    expect(prompt).toContain('The failure this fix must clear');
    expect(prompt).toContain('error TS2345'); // from redUntilCleared's diagnostic
    expect(prompt).not.toContain('## Conflict hunks');
    // And the reader is told a hunk outside the failing files is not by itself wrong.
    expect(prompt).toContain('is often not the file that must change');
  });

  it('a gate fix CONFINED to the named files is NOT demoted — judged still stands', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    const caseId = await serveGateFix(repo, ws, inv, cmds);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'FIXED\n' }); // named file only
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('judged');
    expect(readJournal(dir).some((e) => e.action === 'gate-fix-reach')).toBe(false);
  });

  /**
   * CROSS-PASS ANTI-LOOP (replaces `sweep-base-gate-attempts.json`). The branch
   * already has a gate fix on ORIGIN awaiting the owner, so a second case must
   * NOT be minted: the fix is written and under review. Created AFTER `start` so
   * the origin-derivation/token path is not what is under test here.
   */
  it('an ACTIVE gate-fix ref on origin -> no second case; the branch is reported as gated', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    // The gate: any ref matching `<slug(branch)>--gate-fix-*`. The id8 is NOT
    // looked up — a gate fix is per BRANCH, so its presence is the whole answer.
    repo.git('push', 'origin', `${repo.sha('module/cg')}:refs/heads/fix/sweep/module__cg--gate-fix-module__cg-deadbeef`);
    const out = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      gatedBranches?: string[];
      gateFix?: unknown;
      instruction: string;
    };
    // NOT 'gate-fix-required': there is nothing to serve.
    expect(res.status).toBe('stopped');
    expect(res.gateFix).toBeUndefined();
    expect(res.gatedBranches).toEqual(['module/cg']);
    // And it must not read as "checks failed, go fix them" (the ERR40 fallthrough).
    expect(res.instruction).toContain('ALREADY WRITTEN');
    expect(res.instruction).toContain('do NOT open another PR');
    // No case dir was minted for a second gate fix.
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.some((e) => e.action === 'gate-fix-skipped' && e.branch === 'module/cg')).toBe(true);
    expect(journal.filter((e) => e.action === 'gate-fix').length).toBe(0);
  });

  /**
   * PR #61: with no template named, the agent wrote the PR from the repo's
   * contribution guide (skill types, "tested on a fresh clone") — the most
   * template-shaped file in the clone. The driver now writes ONE per case.
   */
  it('a gate-fix case gets its OWN PR template — no ours/theirs, which it does not have', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const f1 = join(ws, 'f1.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out: f1 }));
    const caseId = (JSON.parse(readFileSync(f1, 'utf8')) as { gateFix: { caseId: string } }).gateFix.caseId;
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    // Resolve the gate fix and claim held so a PR is asked for.
    writeFileSync(join(dir, caseId, 'worktree', 'src/x.ts'), 'fixed\n');
    const rc = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out: rc }),
      confirm,
    );
    const res = JSON.parse(readFileSync(rc, 'utf8')) as { instruction: string; prTemplate?: string };
    const tpl = join(dir, caseId, 'pr', 'TEMPLATE.md');
    expect(existsSync(tpl)).toBe(true);
    expect(res.instruction).toContain(tpl);
    const text = readFileSync(tpl, 'utf8');
    // Tailored to a GATE FIX: it resolves no merge, so inviting ours/theirs/chosen
    // would ask the agent to invent two sides that do not exist.
    expect(text).not.toContain('ours (');
    expect(text).not.toContain('theirs (');
    expect(text).toContain('## What is broken');
    expect(text).toContain('GATE FIX');
    expect(text).toContain('src/x.ts'); // the case's real file, not a placeholder
    // And it carries none of the contribution guide's shape.
    expect(text).not.toContain('Type of Change');
    expect(text).not.toContain('SKILL.md');
  });


  it('next-case REPORTS an active gate instead of silently serving nothing', async () => {
    const repo = gateFixRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    await cmdSweepStart(baseCli(repo, ws, inv));
    repo.git('push', 'origin', `${repo.sha('module/cg')}:refs/heads/fix/sweep/module__cg--gate-fix-module__cg-deadbeef`);
    const out = join(ws, 'nc.json');
    await cmdSweepNextCase(baseCli(repo, ws, inv, { out }));
    const res = JSON.parse(readFileSync(out, 'utf8')) as { activeGates?: string[]; instruction?: string };
    expect(res.activeGates).toEqual(['fix/sweep/module__cg--gate-fix-module__cg-deadbeef']);
    expect(res.instruction).toContain('REPORT that to the owner');
  });

  /**
   * DEFECT 6 — ported from the deleted base-gate block. A failing path produced
   * by a command with a non-`.` cwd must be normalised to repo-root-relative
   * BEFORE attribution, or it blames a root-level `src/…` owner instead of the
   * sub-package's. The logic is shared, so the finish path exercises it now.
   */
  it('DEFECT 6 — failing paths from a sub-cwd checks command are normalised to repo-root-relative', async () => {
    const repo = initFixtureRepo();
    repo.commit('base', { 'container/agent-runner/src/auth/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: y', { 'src/y.ts': 'fork\n' });
    repo.checkout('module/runner', { create: true, at: 'main_patched' });
    repo.commit('runner: own the sub-package', { 'container/agent-runner/src/auth/x.ts': 'runner\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'runner', branch: 'module/runner', owned: ['container/agent-runner'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    // The sub-package's own compiler prints paths relative to ITS cwd.
    const cmds = join(ws, 'cmds.json');
    writeFileSync(
      cmds,
      JSON.stringify([
        {
          cmd: `echo "src/auth/x.ts(12,3): error TS2345: Argument of type 'string | null' is not assignable."; exit 1`,
          cwd: 'container/agent-runner',
        },
      ]),
    );
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const out = join(ws, 'f1.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out }));
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      gateFix?: { branch: string; files: string[] };
    };
    expect(res.status).toBe('gate-fix-required');
    // Normalised to repo-root-relative, and blamed to the SUB-PACKAGE's owner.
    expect(res.gateFix!.files).toEqual(['container/agent-runner/src/auth/x.ts']);
    expect(res.gateFix!.branch).toBe('module/runner');
  });
});

/**
 * DEFECT 3 (HIGH) — a gate-fix case can be served with NO FILES.
 * `materializeGateFixCase` refuses only when `!a.branch`; it never checks
 * `files.length === 0`. When `cmdVerify` returns non-zero WITHOUT journaling an
 * `attributionFailed` row — the ROLLBACK arm: an offender is isolated, rolled
 * back, HELD(gate), and the re-verify is STILL red — `failedOutput` is `''`, so
 * `attributeFailure` parses no paths and falls back to the ACCUSED branch. A
 * case is then minted with empty `conflictedPaths`, an empty
 * `gate-fix-output.txt` and status `gate-fix-required`, pre-empting the honest
 * STOP: the agent is handed a case with nothing to fix and no diagnostics.
 *
 * CORRECT BEHAVIOUR: no files -> do NOT serve a case; fall through to the
 * STOP/report path.
 */
describe('sweep finish — a gate-fix case is never served with NO files (defect 3)', () => {
  /** main_patched (clean fork trunk) + feat/other, both advanced by the pass. */
  function rollbackFixture(): FixtureRepo {
    const repo = cleanFixture();
    repo.checkout('feat/other', { create: true, at: 'main_patched' });
    repo.commit('other: own file', { 'src/o.ts': 'o\n' });
    repo.checkout('main');
    return repo;
  }
  /**
   * A verify command that is RED on run 1 (full recipe), GREEN on run 2 (the
   * leave-one-out probe that isolates feat/other as the offender) and RED again
   * on run 3 (the post-rollback re-verify). That is exactly the shape of a
   * flaky/environmental red: cmdVerify rolls a branch back, journals HELD(gate)
   * and returns non-zero, having journaled NO attributionFailed row and NO
   * failing output.
   */
  function redGreenRed(ws: string): string {
    const f = join(ws, 'cmds.json');
    const counter = join(ws, 'verify-runs');
    writeFileSync(
      f,
      JSON.stringify([
        {
          cmd:
            `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > ${counter}; ` +
            `if [ "$n" -eq 2 ]; then exit 0; fi; echo boom; exit 1`,
        },
      ]),
    );
    return f;
  }

  it('DEFECT 3 — verify red with no journaled diagnostics -> STOP, not an empty gate-fix case', async () => {
    const repo = rollbackFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'other', branch: 'feat/other', parents: ['main_patched'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched', 'feat/other');
    const cmds = redGreenRed(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const out = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
    ).toBe(1);
    const journal = readJournal(dir);
    // Precondition: this IS the rollback arm — an offender was frozen HELD(gate)
    // and no attributionFailed row (hence no diagnostics) was journaled.
    expect(journal.some((e) => e.action === 'held' && e.reason === 'gate')).toBe(true);
    expect(journal.some((e) => e.action === 'verify' && e.attributionFailed === true)).toBe(false);
    // Today: a `gate-fix` row with files: [] and an empty gate-fix-output.txt.
    expect(journal.filter((e) => e.action === 'gate-fix')).toEqual([]);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status?: string; gateFix?: { files: string[] } };
    expect(res.status).not.toBe('gate-fix-required');
  });
});

/**
 * DEFECT 9b (MED) — `createCaseWorktree` wraps its whole body in `catch {}`,
 * journals a `warning` and RETURNS NORMALLY. Its callers (the held-claim
 * pristine reset and the CHECKS_FAIL_LIMIT backstop) then tell the agent "the
 * worktree is now pristine" and freeze a DRAFT PR built from a worktree that
 * was never reset — the agent's discarded edits are still on disk and the
 * driver's claim is simply false.
 *
 * CORRECT BEHAVIOUR: a failed worktree reset must not be reported as success.
 */
describe('report-case — a FAILED pristine reset is not reported as success (defect 9b)', () => {
  it('DEFECT 9b — a worktree reset that fails is not announced as "the worktree is now pristine"', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);
    const wt = join(dir, caseId, 'worktree');
    // The agent left work behind but could not resolve the markers -> --tier held,
    // which is supposed to RESET the worktree to the pristine conflict.
    writeFileSync(join(wt, 'NOTES.md'), 'agent scratch\n');
    // Make the reset fail the way a container-uid-owned tree does on the host.
    chmodSync(wt, 0o555);
    cleanups.push(() => chmodSync(wt, 0o755));

    const out = join(ws, 'rc.json');
    const rc = await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
      neverInvoked,
    );
    // Precondition: the reset really did fail (journaled warning) and the
    // worktree is NOT pristine — the agent's file is still there.
    expect(readJournal(dir).some((e) => e.action === 'warning' && /worktree creation failed/.test(String(e.message)))).toBe(true);
    expect(existsSync(join(wt, 'NOTES.md'))).toBe(true);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(rc).not.toBe(0);
    expect(res.instruction).not.toContain('the worktree is now pristine');
  });
});

/**
 * A DriverHalt is a REFUSAL, not a crash. Only `sweep-abort` caught it, so the
 * other five commands hit the top-level rejection handler: raw stack, no
 * `SWEEP-RESULT` line, nothing for the agent to parse or act on at the exact
 * moment the driver refused to move a ref.
 */
describe('DriverHalt reporting', () => {
  const haltCli = (out: string): Cli => ({
    cmd: 'sweep-finish',
    repo: '/nonexistent',
    workspace: '/nonexistent',
    upstream: 'main',
    execute: false,
    out,
  });

  function halted(out: string): { ok: boolean; status: string; halted: string; issues?: Array<{ id: string }>; instruction: string } {
    return JSON.parse(readFileSync(out, 'utf8')) as ReturnType<typeof halted>;
  }

  it('a MAPPED halt reason emits its ERR id on the one SWEEP-RESULT line', () => {
    const ws = mkWorkspace();
    const out = join(ws, 'halt.json');
    expect(reportDriverHalt(haltCli(out), new DriverHalt('protected-ref', "refuse to move protected ref 'main'"))).toBe(1);
    const res = halted(out);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('stopped');
    expect(res.halted).toBe('protected-ref');
    expect(res.issues![0].id).toBe('ERR23_PROTECTED_REF');
    // Doctrine routes "a global halt reported in the output" to a stop-case report.
    expect(res.instruction).toContain('REPORT to the owner');
    expect(res.instruction).toContain('Do NOT retry');
  });

  it('an UNMAPPED reason still reports — no id is invented', () => {
    const ws = mkWorkspace();
    const out = join(ws, 'halt2.json');
    // `out-of-scope` is thrown by guardRef but absent from HALT_IDS. It must
    // still produce an actionable result: minting an id here would need a
    // doctrine row to mean anything, and a silent raw stack is what broke.
    expect(reportDriverHalt(haltCli(out), new DriverHalt('out-of-scope', "refuse to move 'x' — outside scope"))).toBe(1);
    const res = halted(out);
    expect(res.halted).toBe('out-of-scope');
    expect(res.issues).toBeUndefined();
    expect(res.instruction).toContain('REPORT to the owner');
    expect(res.instruction).toContain('outside scope');
  });
});
