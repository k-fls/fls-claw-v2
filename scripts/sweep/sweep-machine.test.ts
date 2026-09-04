/**
 * scripts/sweep/sweep-machine.test.ts — the sweep state machine
 * (DRIVER.md §6). Every mutating stage runs against throwaway git
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

import { initFixtureRepo, makeForkRunFixture, type FixtureRepo } from './fixtures.js';
import { isAncestor } from './git.js';
import {
  CHECKS_FAIL_LIMIT,
  DEAD_END_ATTEMPTS,
  cmdPublish,
  cmdRun,
  cmdSweepAbort,
  cmdSweepFinish,
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdReport,
  cmdSweepReportPr,
  cmdSweepStart,
  checkKey,
  DriverHalt,
  greenChecks,
  mutatedBranches,
  openCaseBranches,
  openCases,
  parseCli,
  parseMachineVerdict,
  passDir,
  appendJournal,
  gateFixCaseMaterialsForTest,
  duplicateGateFixes,
  gateFixRefName,
  publishGateFixTwins,
  journaledCases,
  readJournal,
  reportDriverHalt,
  RESOLVE_COLDREAD_CAP,
  supersededCaseIds,
  unstableEvidence,
  type Cli,
  type ChecksRunner,
  type ColdReadInvoker,
  type InstallRunner,
  type JournalEntry,
} from './propagate.js';
import { DRIVER_COMMIT_ENV } from './proposal.js';
import {
  MACHINE_BLOCK_BEGIN,
  MACHINE_BLOCK_END,
  parseMachineLines,
  renderSweepFailure,
  type GithubTransport,
} from './publish.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sm-ws-'));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}
/** Minimal inventory writer (id/branch/parents) — mirrors propagate.test.ts. */
function writeInventory(
  entries: Array<{ id: string; branch?: string; parents?: string[]; owned?: string[] }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      'kind: feat',
      ...(e.branch ? [`branch: ${e.branch}`] : []),
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
      ...(e.owned ? ['owned_paths:', ...e.owned.map((p) => `  - ${JSON.stringify(p)}`)] : []),
    ].join('\n');
    writeFileSync(join(dir, `${e.id}.yaml`), yaml + '\n');
  }
  return dir;
}
/**
 * Inventory with a single branchless entry: `sweep start` requires a
 * non-empty, warning-free inventory (ERR46), and a branchless entry satisfies
 * that while contributing nothing to scope (structural-only fixtures).
 */
function branchlessInventory(): string {
  return writeInventory([{ id: 'planned.seed' }]);
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
    // Deps are installed INTO each worktree, and
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
 * Dependency install stub. Deps are installed
 * INTO the worktree from its own manifests, so the stub creates the two trees
 * there. Tests must inject it — there is no fallback to the clone, and
 * a tree with no valid environment yields no verdict at all.
 */
const fakeInstall: InstallRunner = async (wt) => {
  for (const rel of ['node_modules/.bin', 'container/agent-runner/node_modules/.bin']) {
    mkdirSync(join(wt, rel), { recursive: true });
    writeFileSync(join(wt, rel, 'tsc'), '#!/bin/sh\nexit 0\n');
  }
  return { ok: true };
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
// The cold read is the SINGLE quality gate and it lives at `report-case`.
// Any stage that must not cold-read gets this invoker — it fails the test loudly
// instead of silently passing a second `claude -p` through.
/**
 * A green checks runner for `start`. Tests that exercise
 * the PER-CASE gate need the base to pass, or `start` refuses with ERR42 and no
 * pass ever opens. Injected at start only; report-case gets its own runner.
 */

const neverInvoked: ColdReadInvoker = async () => {
  throw new Error('cold read invoked where D-060 forbids one');
};
// The cold-read TOOLING is broken (spawn/exit/unparseable/auth) — an infra
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
        if (method === 'GET' && /\/pulls\/\d+\/reviews/.test(path)) return { status: 200, body: [] }; // review trigger
        if (method === 'GET' && /\/pulls\/\d+\/comments/.test(path)) return { status: 200, body: [] }; // inline dialog
        if (method === 'POST' && path === '/graphql') return { status: 200, body: { data: {} } };
        if (method === 'GET' && /\/pulls\/\d+$/.test(path))
          return { status: 200, body: { number: 7, node_id: 'PR_fake', merged: true, body: 'x' } };
        if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) return { status: 200, body: {} };
        if (method === 'GET' && /\/issues\/\d+\/comments/.test(path)) return { status: 200, body: [] }; // review-loop comments
        if (method === 'POST' && path.includes('/comments')) return { status: 201, body: {} };
        return { status: 404, body: null };
      },
    }),
  };
  return state;
}

// ---------------------------------------------------------------------------

describe('sweep start / abort (SWEEP-STATE-MACHINE.md §2)', () => {
  it('start refuses when a pass is already open — and ASKS THE OWNER rather than choosing', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    const out = join(ws, 'start2.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      issues: Array<{ id: string }>;
      instruction: string;
      openPass: { phase: string; mergedLocally: number; prsPublished: number; casesOpen: number };
    };
    expect(res.issues[0].id).toBe('ERR30_PASS_OPEN');
    // CONTINUE-or-ABORT is the OWNER's call. The instruction must not read as
    // a menu the agent picks from ("run `finish` or `abort` first") — the two
    // are not interchangeable: resuming keeps the pass's merges and PRs, while
    // aborting rolls every touched branch back to its pre-ref. Which is right
    // depends on WHY the pass stopped, which the agent cannot know.
    expect(res.instruction).toContain('ASK THE OWNER');
    expect(res.instruction).toMatch(/Do not choose/i);
    expect(res.instruction).toContain('CONTINUE');
    expect(res.instruction).toContain('ABORT');
    // …and the facts it must quote come from the driver, not from the agent's
    // own reading of the journal.
    expect(res.openPass.phase).toBeTruthy();
    expect(typeof res.openPass.mergedLocally).toBe('number');
    expect(typeof res.openPass.prsPublished).toBe('number');
    expect(typeof res.openPass.casesOpen).toBe('number');
  });

  it('abort rolls mutated branches back to pre-ref and allows a fresh start', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
// Start guard: the resolved inventory must be present, non-empty and
// warning-free before a pass opens (ERR46).
// ---------------------------------------------------------------------------

describe('sweep start — inventory guard (ERR46)', () => {
  it('refuses with ERR46 when the --inventory dir holds an entry with an unknown key', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = mkdtempSync(join(tmpdir(), 'sm-inv-'));
    cleanups.push(() => rmSync(inv, { recursive: true, force: true }));
    writeFileSync(join(inv, 'bad.yaml'), 'id: bad\nname: bad\nkind: feat\nbranch: feat/none\nstatus: shipped\n');
    const out = join(ws, 'start.json');
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string; detail: string }> };
    const issue = res.issues.find((i) => i.id === 'ERR46_INVENTORY_INVALID');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain("unknown key 'status'");
    expect(existsSync(join(ws, 'propagation'))).toBe(false);
  });

  it('proceeds when no residue exists and the inventory is valid, pinning the resolved path into machine state', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    expect(await cmdSweepStart(baseCli(repo, ws, inv))).toBe(0);
    const st = JSON.parse(readFileSync(join(dirOf(repo, ws), 'machine-state.json'), 'utf8')) as {
      phase: string;
      inventory?: string;
    };
    expect(st.phase).toBe('open');
    expect(st.inventory).toBe(inv);
  });
});

// ---------------------------------------------------------------------------
// `start` and a red base.
// ---------------------------------------------------------------------------

/**
 * `start` has NO base gate: it does not typecheck the base, does not refuse or
 * gate a red one, and keeps no `sweep-base-gate-attempts.json`. A red base is
 * found at `finish`'s verify and served as an ordinary gate-fix case on the
 * branch that owns the failing files
 * — see 'sweep finish — gate-fix on an unattributable red', which also covers
 * sub-cwd path normalisation.
 *
 * What `start` does keep is the MALFORMED-checks refusal, which never depended
 * on a gate: it READS the file, it does not run it.
 */
describe('sweep start — no base gate; malformed checks still LOUD', () => {
  it('a RED base does not refuse, gate, or write a side-car record', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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


describe('sweep next-case (SWEEP-STATE-MACHINE.md §2)', () => {
  it('advances the clean prefix and serves the conflict case with materials', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }))).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { status: string }).status).toBe('finalize');
  });
});

describe('sweep report-case (SWEEP-STATE-MACHINE.md §2)', () => {
  async function toCase(repo: FixtureRepo, ws: string, inv: string): Promise<string> {
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    return currentCaseId(dirOf(repo, ws));
  }

  it('mechanical: injected cold read confirm -> merge in place', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  it('judged: cold read HERE confirms -> provide PR description, NOT merged yet (merge lands at report-pr)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // The single quality gate (cold read) runs at report-case for
    // judged too — the coldread row exists here, not at report-pr.
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId)).toBe(true);
    const st = machineState(dir);
    expect(st.phase).toBe('awaiting-pr');
    expect(st.currentCase?.tier).toBe('judged');
    expect(existsSync(join(dir, caseId, 'pr', 'materials.md'))).toBe(true);
    // Its CONTENT was asserted nowhere, so the shared directives/per-side blocks
    // could have rendered wrong here and only `tsc` would have noticed.
    const prMaterials = readFileSync(join(dir, caseId, 'pr', 'materials.md'), 'utf8');
    expect(prMaterials).toContain('EDIT: the pending files below, nothing else.');
    expect(prMaterials).toContain('CANNOT DECIDE: `report-case --tier held`.');
    expect(prMaterials).toMatch(/## ours \(`[^`]+`\) — `git log --oneline` over the conflicted paths since the merge base/);
    expect(prMaterials).toMatch(/## theirs \(`[^`]+`\) — same range on the other side/);
    // No hunk ranges here: the conflict is RESOLVED by this point.
    expect(prMaterials).not.toContain('hunk(s) at lines');
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

  it('scope exceeded + cold read AGREES -> HELD publishing the RESOLUTION (escalated, no merge)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // no durable local state is written.
    expect(readJournal(dir).some((e) => e.action === 'pr-published')).toBe(false);
    expect(existsSync(join(ws, 'sweep-ledger.json'))).toBe(false); // no durable local state
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
    const inv = branchlessInventory();
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

  it('mechanical cold-read reject: 1st -> revise with feedback (still case-ready); 2nd -> HELD escalated', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    expect(held.resolution).toMatchObject({ markerClean: true }); // the work is kept for the owner
    expect(machineState(dir).currentCase?.tier).toBe('held');
  });

  it('judged cold-read reject (the gate is HERE, not at report-pr): 1st -> revise, 2nd -> HELD escalated, never merged', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

  it('per-case attempt cap force-HELD after RESOLVE_COLDREAD_CAP distinct cold-read-reaching trees', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    // report-attempt is recorded POST-CHECKS, so the cap counts only
    // cold-read-reaching (RESOLVED, checks-passing) trees. Seed CAP prior
    // report-attempt rows with distinct trees, then report ONE more distinct
    // RESOLVED tree: 5b sees >CAP distinct and force-freezes HELD with the
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
// The CHECKS GATE (typecheck THEN tests) at report-case. The runner
// is injected (3rd param) so nothing spawns a real pnpm/bun; the checks-file is
// resolved + pinned by `start`, so these fixtures pass it there and never again.
// ---------------------------------------------------------------------------

describe('sweep report-case — the checks gate (typecheck THEN tests)', () => {
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

  /**
   * THE GATE MEASURES THE TREE IT IS JUDGING, ENVIRONMENT INCLUDED.
   *
   * The prep install ran on the clean prefix, where a conflicted `package.json`
   * was still the base commit's. By report-case the agent has resolved it, so a
   * dependency the resolution adds or drops exists only here — and a gate run
   * against the prep environment answers about a tree that no longer exists.
   */
  it('installs into the case worktree BEFORE the gate runs', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const order: string[] = [];
    const install: InstallRunner = async (wt) => {
      order.push(`install ${wt}`);
      return { ok: true };
    };
    const runChecks: ChecksRunner = async () => {
      order.push('checks');
      return { ok: true, failedNames: [], output: '' };
    };
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
        runChecks,
        install,
      ),
    ).toBe(0);
    expect(order[0]).toBe(`install ${join(dir, caseId, 'worktree')}`);
    expect(order.slice(1)).toEqual(['checks', 'checks']); // typecheck, then tests
  });

  /**
   * THE MANIFESTS AT THE GATE ARE THE AGENT'S. An install that fails on THEM is
   * work the agent can do, and it is not a failing check: no check ran. Calling
   * it an environment fault would stop the pass over a file the agent could fix
   * in a line, and counting it against `CHECKS_FAIL_LIMIT` would spend the
   * case's attempts on a gate that never answered.
   */
  it('a resolution whose manifests do not install is the AGENT\'S, and costs no check', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const r = runner([]); // green if it ran — it must not run
    const badManifest: InstallRunner = async () => ({
      ok: false,
      failure: {
        command: 'pnpm install --frozen-lockfile',
        cwd: '.',
        output: 'EJSONPARSE  package.json: Unexpected token "<" in JSON at position 0',
      },
    });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked, // the gate never answered, so the reviewer is never paid for
        r.fn,
        badManifest,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; issues: Array<{ id: string }> };
    const ids = res.issues.map((i) => i.id);
    expect(ids).toContain('ERR49_MANIFEST_UNINSTALLABLE');
    expect(ids).not.toContain('WARN14_ENVIRONMENT_FAULT');
    expect(res.instruction).toContain('re-run report-case');
    expect(r.ran).toHaveLength(0); // no check ran
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'checks-fail')).toBe(false);
    // The case is still the agent's to finish, from the phase report-case needs.
    expect(openCases(journal).map((c) => c.caseId)).toContain(caseId);
    expect(machineState(dir).phase).toBe('case-ready');
  });

  /**
   * AN INSTALL THAT FAILS ON THE MACHINE IS TERMINAL, and terminal has to mean
   * DISPOSED. Refusing and leaving the case open puts it back in `openCases`
   * with `finish` answering ERR34_CASES_REMAIN forever and no legal move left
   * anywhere in the pass.
   */
  it('an install that fails on the MACHINE closes the case, trims what is below it, and finish hands it to the owner', async () => {
    const repo = conflictFixture();
    // A descendant, so "trimmed" is something the result can be asked about.
    repo.checkout('module/dep', { create: true, at: 'main_patched' });
    repo.commit('dep: its own edit', { 'src/dep.ts': 'dep\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'dep', branch: 'module/dep', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    repo.git('push', 'origin', 'module/dep');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    const r = runner([]);
    const deadNetwork: InstallRunner = async () => ({
      ok: false,
      failure: {
        command: 'pnpm install --frozen-lockfile',
        cwd: '.',
        output: 'WARN GET https://registry.npmjs.org/yaml error (ENOTFOUND).\nERR_PNPM_META_FETCH_FAIL',
      },
    });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        r.fn,
        deadNetwork,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.map((i) => i.id)).toContain('ERR47_ENVIRONMENT_UNUSABLE');
    expect(r.ran).toHaveLength(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'checks-fail')).toBe(false);
    expect(journal.some((e) => e.action === 'env-blocked' && e.caseId === caseId)).toBe(true);
    // DISPOSED — and reopened exactly as a held freeze reopens.
    expect(openCases(journal).map((c) => c.caseId)).not.toContain(caseId);
    const reopened = journal.filter((e) => e.action === 'reopened').map((e) => e.branch);
    expect(reopened).toContain('main_patched');
    expect(reopened).toContain('module/dep');

    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const finOut = join(ws, 'fin.json');
    await cmdSweepFinish(
      baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmds, out: finOut }),
      fakeGithub().factory,
    );
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as {
      issues?: Array<{ id: string }>;
      needsOwner?: Array<{ branch: string; category: string }>;
      coverage?: { excluded: Array<{ branch: string }> };
    };
    // NOT a bare "cases remain": the owner is named a machine to repair.
    expect((fin.issues ?? []).map((i) => i.id)).not.toContain('ERR34_CASES_REMAIN');
    expect((fin.needsOwner ?? []).map((n) => `${n.branch}:${n.category}`)).toContain('main_patched:environment');
    // The block is real: the branch and everything under it are out of the build.
    const excluded = (fin.coverage?.excluded ?? []).map((x) => x.branch);
    expect(excluded).toContain('main_patched');
    expect(excluded).toContain('module/dep');
  });

  it('typecheck RED -> ERR36 (fix + re-run), tests never run, NO cold read, NO report-attempt, still case-ready', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
   * DEADLOCK SHAPE. `--tier held` is the documented escape when the
   * agent cannot make a case green, and doctrine's ERR36 row explicitly sends it
   * here when the failing file is out of scope. But the pristine-held branch
   * requires `conflictsPresent`, so an agent that HAS resolved the conflict falls
   * through to the checks gate and gets ERR40 "fix the pending files" — which can
   * be impossible: the conflict is `src/cli/resources/groups.ts`, the failing test
   * `container/agent-runner/src/poll-loop.test.ts` from upstream. An agent that
   * claims held, is refused, and files a stop-case is right.
   */
  it('an explicit --tier held with FAILING checks is honoured now, not after 10 tries', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
    // A `git worktree add` checkout has no `node_modules`, so without this the
    // gate dies `tsc: not found` on EVERY case — a failure no agent edit can fix,
    // marching every case to the CHECKS_FAIL_LIMIT force-HELD. The install runs
    // IN the worktree, from the manifests that worktree carries.
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
    // REGRESSION GUARD: `.gitignore` has `node_modules/` — a
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  // ---- `--not-my-bug` ------------------------------------------------------
  //
  // The not-my-bug deadlock end to end: a failure the case did not cause, which the
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    // ...and the GATE FIX itself is NOT superseded. The owner here IS the branch
    // being reopened, and a gate-fix case is exempt from supersede: it stands
    // until it is concluded, so `next-case` has one to serve.
    expect(supersededCaseIds(journal).has(gateFix!.caseId as string)).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toContain(gateFix!.caseId);
    // The agent's resolution is DISCARDED and the loss recorded: it was never
    // pushed, and a local ref would never leave this clone.
    const discarded = journal.find((e) => e.action === 'not-my-bug-discarded')!;
    expect(discarded).toBeTruthy();
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/sweep/')).toBe('');
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

  /**
   * A runner whose answer depends on WHICH TREE it is asked about: at `tipSha`
   * only `owned` fails, everywhere else both files do. That is the shape the
   * ownership probe exists to detect — the raw log names more files than the
   * owner is responsible for.
   */
  function ownershipRunner(wtPath: string, tipSha: string, owned: string, other: string): ChecksRunner {
    return async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const at =
        baseDir && baseDir !== wtPath
          ? execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
          : '';
      const files = at === tipSha ? [owned] : [owned, other];
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\n${files.map((f) => `${f}(1,1): error TS2345: boom\n`).join('')}`).join(''),
      };
    };
  }

  it('a minted gate-fix case carries only the files its owner was PROVEN to own', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    // The branch tip the merge was attempted from — the clean prefix's parent,
    // and the commit `locateOwner` probes.
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        ownershipRunner(wtPath, tipSha, 'src/util.ts', 'src/unrelated.ts'),
        fakeInstall,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('pre-existing');
    // The probe proved the owner owns ONE of the two files in the log.
    const owner = journal.find((e) => e.action === 'not-my-bug-owner')!;
    expect(owner.owner).toBe('branch');
    expect(owner.files).toEqual(['src/util.ts']);
    // So the case is scoped to that file. Re-deriving the list by re-parsing the
    // raw log would hand this owner `src/unrelated.ts` too — a file the probe
    // showed it does not own, which nobody on this branch can fix and which the
    // checks gate would then demand green.
    const gateFix = journal.find((e) => e.action === 'gate-fix')!;
    expect(gateFix.files).toEqual(['src/util.ts']);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { gateFix: { files: string[] } };
    expect(res.gateFix.files).toEqual(['src/util.ts']);
  });

  /**
   * A feature branch UNDER the trunk, conflicting with what the trunk brings
   * down. The case therefore lands on `module/cg` with parent `main_patched`, so
   * BOTH possible owners are branches the sweep may mint on — a case whose parent
   * is upstream `main` cannot show a two-owner split, because upstream is outside
   * the mandate and no case is ever minted there.
   */
  function twoOwnerFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: files', { 'src/x.ts': 'orig\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg: x = cg', { 'src/x.ts': 'cg\n' });
    // module/cg AUTHORED `src/a.ts`, so it is the ceiling for it as well as the
    // floor: blame that could be lifted higher would be, and the two-owner split
    // this fixture is about needs each owner to be where its own file was written.
    //
    // WHAT THE TESTS BELOW PIN IS THE PARTITION, not the ceiling: that ONE
    // `locateOwner` verdict describes a SUBSET, so a failure spanning two owners
    // yields two correctly-scoped cases rather than one case carrying somebody
    // else's file. With both owners also being their own ceiling, a ceiling split
    // cannot stand in for a partition that lumped — `partitionOwners` has its own
    // unit pins, and this is the end-to-end one.
    repo.commit('cg: a', { 'src/a.ts': 'a-cg\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * Drive the two-owner adjudication: `src/a.ts` fails at the BRANCH tip,
   * `src/b.ts` only at the PARENT head, `src/c.ts` at neither (so the merge made
   * it — nobody upstream owns it). Every other tree, the case worktree and the
   * clean prefix included, fails all three: that is what proves the whole set
   * pre-existing.
   */
  async function adjudicateTwoOwners(
    repo: FixtureRepo,
    ws: string,
    inv: string,
  ): Promise<{ dir: string; caseId: string; out: string; code: number }> {
    const checks = checksFile(ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const parentHead = (JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as { head: { sha: string } }).head.sha;
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const at =
        baseDir && baseDir !== wtPath
          ? execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
          : '';
      const files = at === tipSha ? ['src/a.ts'] : at === parentHead ? ['src/a.ts', 'src/b.ts'] : ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\n${files.map((f) => `${f}(1,1): error TS2345: boom\n`).join('')}`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    const code = await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      fn,
      fakeInstall,
    );
    return { dir, caseId, out, code };
  }

  it('a failure spanning TWO owners mints one correctly-scoped case per owner', async () => {
    const repo = twoOwnerFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, code, out } = await adjudicateTwoOwners(repo, ws, inv);
    expect(code).toBe(1);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('pre-existing');
    // Two proven owners, each carrying only its own files. One `locateOwner`
    // verdict describes a SUBSET, so reading the first as the whole story either
    // folds `src/b.ts` into module/cg's case — asking a branch to fix a defect
    // that is not on it — or drops it, leaving the build red with nothing minted.
    const gateFixes = journal.filter((e) => e.action === 'gate-fix');
    expect(gateFixes.map((e) => e.branch).sort()).toEqual(['main_patched', 'module/cg']);
    expect(gateFixes.find((e) => e.branch === 'module/cg')!.files).toEqual(['src/a.ts']);
    expect(gateFixes.find((e) => e.branch === 'main_patched')!.files).toEqual(['src/b.ts']);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      gateFix: { branch: string; files: string[] };
      gateFixes: Array<{ branch: string; files: string[] }>;
      notMyBug: { owners: Array<{ owner: string; branch: string; files: string[] }> };
    };
    expect(res.status).toBe('gate-fix-required');
    expect(res.gateFixes.map((g) => [g.branch, g.files])).toEqual([
      ['main_patched', ['src/b.ts']],
      ['module/cg', ['src/a.ts']],
    ]);
    // SHALLOWEST OWNER FIRST, so the case `gateFix` names is the one `next-case`
    // will actually serve first in DAG order.
    expect(res.gateFix.branch).toBe('main_patched');
    expect(res.notMyBug.owners.map((o) => o.owner)).toEqual(['parent', 'branch']);
    // Every reopen is journaled before every mint, and the gate fixes stand
    // whatever the order: a gate-fix case is exempt from supersede.
    const firstMint = journal.findIndex((e) => e.action === 'gate-fix');
    const lastReopen = journal.map((e) => e.action).lastIndexOf('reopened');
    expect(lastReopen).toBeLessThan(firstMint);
    for (const gf of gateFixes) expect(supersededCaseIds(journal).has(gf.caseId as string)).toBe(false);
  });

  it('files no owner could be proven for are NAMED, never folded into a case', async () => {
    const repo = twoOwnerFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, out } = await adjudicateTwoOwners(repo, ws, inv);
    const journal = readJournal(dir);
    // `src/c.ts` is green on both sides in isolation: the merge made it, and the
    // merge is being aborted, so no gate fix can cover it. It must therefore
    // appear as itself — folded into an owner's case it would be a
    // misattribution, dropped it would be a red build nobody was told about.
    for (const e of journal.filter((e) => e.action === 'gate-fix')) {
      expect(e.files).not.toContain('src/c.ts');
    }
    const remainder = journal.find((e) => e.action === 'not-my-bug-owner' && e.owner === 'interaction')!;
    expect(remainder.files).toEqual(['src/c.ts']);
    const partition = journal.find((e) => e.action === 'not-my-bug-partition')!;
    expect((partition.remainder as { kind: string; files: string[] }).files).toEqual(['src/c.ts']);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      uncovered: { kind: string; files: string[] };
      instruction: string;
    };
    expect(res.uncovered).toEqual({ kind: 'interaction', files: ['src/c.ts'], detail: expect.any(String) });
    // The agent relays the instruction, so the remainder has to be IN it.
    expect(res.instruction).toContain('NOT COVERED BY ANY GATE FIX');
    expect(res.instruction).toContain('src/c.ts');
  });

  // ---- the ceiling: where an INHERITED red's fix goes -----------------------
  //
  // A branch that is red on content it did not write is a true observation and a
  // false accusation. Blame is lifted to the shallowest branch that AUTHORED the
  // failing files, so ONE case covers every red beneath it instead of one case
  // per branch that inherited the defect. Authorship only BOUNDS the lift; a
  // measurement at that level is what licenses it.

  /**
   * `module/cg` sits under the trunk and conflicts on `src/x.ts` with what the
   * trunk brings down, so the case lands there. `src/shared.ts` is the TRUNK's
   * own file — the module branch inherited it and never touched it.
   */
  function inheritedRedFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: shared', { 'src/shared.ts': 'broken\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg: x = cg', { 'src/x.ts': 'cg\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /** Drive the pass to a resolved case on `module/cg`, red on the trunk's file. */
  async function inheritedCase(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    checks: string = checksFile(ws),
  ): Promise<{ dir: string; caseId: string; tipSha: string; ceilingTip: string }> {
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    return { dir, caseId, tipSha, ceilingTip: repo.sha('main_patched') };
  }

  /** The sha a checks run was taken at, or '' where the directory is not a worktree. */
  function shaAt(baseDir: string): string {
    try {
      return execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  /**
   * Red everywhere, naming `file`; counts the runs the CEILING STEP takes.
   *
   * The step is over the moment its row is journaled, and the bisect probes the
   * same tip afterwards — so the row is what separates the two, not the commit.
   */
  function ceilingCountingRunner(file: string, ceilingTip: string, dir: string): { fn: ChecksRunner; atCeiling: string[] } {
    const atCeiling: string[] = [];
    const fn: ChecksRunner = async (commands, baseDir) => {
      const deciding = !readJournal(dir).some((e) => e.action === 'gate-fix-ceiling');
      if (baseDir && deciding && shaAt(baseDir) === ceilingTip) atCeiling.push(baseDir);
      const names = commands.map((c) => c.cmd);
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\n${file}(1,1): error TS2345: boom\n`).join(''),
      };
    };
    return { fn, atCeiling };
  }

  /** A `red-confirm` this pass already took for `sha`'s subtree, on some other branch. */
  function seedConfirmedRed(dir: string, repo: FixtureRepo, branch: string, sha: string): void {
    appendJournal(dir, {
      action: 'red-confirm',
      branch,
      sha,
      phase: 'test',
      cmd: 'tsc --noEmit',
      cwd: '.',
      subtree: repo.git('rev-parse', `${sha}^{tree}`),
      commands: ['tsc --noEmit'],
      ran: true,
      reproduced: true,
    });
  }

  /**
   * THE INHERITED RED, LIFTED FOR NOTHING. The trunk wrote the failing file, the
   * pass has already confirmed the trunk tip's subtree red, and identical bytes
   * cannot disagree — so the ceiling is established without running anything, and
   * the one case that gets minted covers every branch below it.
   */
  it('a red the branch INHERITED is minted on the branch that AUTHORED it, at no probe cost', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, caseId, ceilingTip } = await inheritedCase(repo, ws, inv);
    // The pass confirmed this red on a branch carrying the trunk tip's subtree.
    // WHICH branch took the measurement is not the question authorship answers.
    seedConfirmedRed(dir, repo, 'module/elsewhere', ceilingTip);
    const r = ceilingCountingRunner('src/shared.ts', ceilingTip, dir);
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
    // The floor is where the red was MEASURED; the ceiling is where the fix goes.
    expect(journal.find((e) => e.action === 'not-my-bug-owner')!.ownerBranch).toBe('module/cg');
    const ceiling = journal.find((e) => e.action === 'gate-fix-ceiling')!;
    expect(ceiling.decided).toBe('lift-shared');
    expect(ceiling.floor).toBe('module/cg');
    expect(ceiling.ceiling).toBe('main_patched');
    expect(ceiling.files).toEqual(['src/shared.ts']);
    const gateFixes = journal.filter((e) => e.action === 'gate-fix');
    expect(gateFixes.map((e) => e.branch)).toEqual(['main_patched']);
    expect(gateFixes[0].files).toEqual(['src/shared.ts']);
    // NOTHING WAS RUN FOR THE LIFT. The verdict for those bytes was already
    // journaled, and re-running it would buy the same observation twice.
    expect(r.atCeiling).toEqual([]);
    expect(journal.some((e) => e.action === 'red-confirm' && e.phase === 'ceiling')).toBe(false);
    // And the case is servable: the reopen covers the ceiling's subtree, which
    // contains the floor, so the fix is not superseded by its own reopen.
    expect(supersededCaseIds(journal).has(gateFixes[0].caseId as string)).toBe(false);
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }), greenPreMerge)).toBe(0);
    const served = JSON.parse(readFileSync(nc, 'utf8')) as { status: string; caseId: string; branch: string };
    expect(served.status).toBe('case-ready');
    expect(served.caseId).toBe(gateFixes[0].caseId);
    expect(served.branch).toBe('main_patched');
    expect(supersededCaseIds(readJournal(dir)).has(caseId)).toBe(true);
  });

  /**
   * A RED TWO BRANCHES SHARE IS A FLOOR, NOT A DEAD END. Nothing the probe
   * measured distinguishes them — so it names no owner — but authorship does, and
   * the level that WROTE the failing file can be handed the fix. The measurement
   * that licenses it is taken at the ceiling, where the content lives.
   */
  it('a red no branch can be handed is minted on the branch that AUTHORED it', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, caseId, tipSha } = await inheritedCase(repo, ws, inv);
    // The red at the case branch's own tip was confirmed on a SIBLING carrying
    // the identical subtree: the verdict holds and it accuses nobody there.
    seedConfirmedRed(dir, repo, 'module/elsewhere', tipSha);
    const r = namingRunner(['tsc --noEmit'], 'src/shared.ts');
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
    expect(journal.find((e) => e.action === 'not-my-bug-owner')!.owner).toBe('shared');
    const ceiling = journal.find((e) => e.action === 'gate-fix-ceiling')!;
    // Measured at the ceiling, because nothing had been: the shared verdict is
    // about the FLOOR's bytes and says nothing about the trunk tip's.
    expect(ceiling.decided).toBe('lift-measured');
    expect(ceiling.ceiling).toBe('main_patched');
    expect(journal.some((e) => e.action === 'red-confirm' && e.phase === 'ceiling' && e.reproduced === true)).toBe(true);
    const gateFixes = journal.filter((e) => e.action === 'gate-fix');
    expect(gateFixes.map((e) => e.branch)).toEqual(['main_patched']);
    expect(gateFixes[0].files).toEqual(['src/shared.ts']);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; gateFix: { branch: string } };
    expect(res.status).toBe('gate-fix-required');
    expect(res.gateFix.branch).toBe('main_patched');
    const nc = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: nc }), greenPreMerge)).toBe(0);
    const served = JSON.parse(readFileSync(nc, 'utf8')) as { status: string; caseId: string };
    expect(served.caseId).toBe(gateFixes[0].caseId);
    expect(supersededCaseIds(readJournal(dir)).has(caseId)).toBe(true);
  });

  /**
   * AN UNSTABLE CEILING LIFTS NOTHING AND MINTS NOTHING. The level that wrote the
   * failing file answers red once and green once on the identical tree, so there
   * is no verdict to carry there — and the floor's red is the same failure, now
   * known to be unstable where the content lives. Nobody is handed it, and the
   * agent keeps its resolution.
   */
  it('a ceiling that answers both ways blames nobody, and the resolution is KEPT', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, caseId, ceilingTip } = await inheritedCase(repo, ws, inv);
    // Red in the first worktree prepared at the ceiling, green in the second —
    // the varied re-run, which is the only one that can contradict the first.
    const seen = new Map<string, string>();
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      if (baseDir && shaAt(baseDir) === ceilingTip) {
        const first = seen.get(ceilingTip);
        if (first === undefined) seen.set(ceilingTip, baseDir);
        else if (first !== baseDir) return { ok: true, failedNames: [], output: '' };
      }
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/shared.ts(1,1): error TS2345: boom\n`).join(''),
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
    ).toBe(0);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'gate-fix-ceiling')!.decided).toBe('refused-unstable');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'not-my-bug-discarded')).toBe(false);
    const refusal = journal.find((e) => e.action === 'gate-fix-refused')!;
    expect(refusal.id).toBe('WARN21_CHECKS_FLAKY');
    expect(refusal.caseId).toBe(caseId);
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.resolution as { markerClean: boolean }).markerClean).toBe(true);
    expect(machineState(dir).phase).toBe('awaiting-pr');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { tier: string; issues: Array<{ id: string }> };
    expect(res.tier).toBe('held');
    expect(res.issues.map((i) => i.id)).toEqual(['WARN21_CHECKS_FLAKY']);
  });

  /**
   * A CEILING RED THAT NEEDS THE COMMAND BEFORE IT IS STILL A CEILING RED. The
   * measurement at the ceiling runs the whole failing list, and only the second
   * command fails — after the first has run in that worktree. Re-running the
   * accused command alone puts it in a tree where the first never ran, which is
   * not the experiment it failed in: it comes back green there however real the
   * defect is. Replaying the sequence is what settles it, and the ceiling is
   * lifted onto rather than refused for an instability nobody observed.
   */
  it('a ceiling red that needs the command before it is LIFTED onto, not refused as unstable', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const checks = checksFile(ws, { typecheck: ['tsc --noEmit', 'tsc -b'] });
    const { dir, caseId, ceilingTip } = await inheritedCase(repo, ws, inv, checks);
    /** Worktrees `tsc --noEmit` has already run in — the state `tsc -b` needs. */
    const typechecked = new Set<string>();
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const after = typechecked.has(baseDir) || names.includes('tsc --noEmit');
      if (names.includes('tsc --noEmit')) typechecked.add(baseDir);
      const failedNames =
        baseDir && shaAt(baseDir) === ceilingTip ? names.filter((n) => n === 'tsc -b' && after) : names;
      return {
        ok: failedNames.length === 0,
        failedNames,
        output: failedNames.map((n) => `$ ${n}\nsrc/shared.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      fn,
      fakeInstall,
    );
    const journal = readJournal(dir);
    // THE POINT: the ceiling was measured RED, not stamped unstable.
    expect(journal.find((e) => e.action === 'gate-fix-ceiling')!.decided).toBe('lift-measured');
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.phase === 'ceiling' && e.cmd === 'tsc -b')!;
    expect(confirm.reproduced).toBe(true);
    expect(confirm.aloneGreen).toBe(true);
    expect(confirm.context).toBe('sequence');
    // Nothing here is refused for an INSTABILITY: the accusation's other command
    // is simply green where the content lives, which is a separate rule and a
    // separate id. The resolution is kept either way.
    expect(journal.filter((e) => e.action === 'gate-fix-refused').map((e) => e.id)).not.toContain('WARN21_CHECKS_FLAKY');
    expect(journal.some((e) => e.action === 'not-my-bug-discarded')).toBe(false);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
  });

  /**
   * AN ACCUSATION THAT IS THE WHOLE EXPERIMENT IS SETTLED BY ONE RE-RUN.
   *
   * The ceiling probe runs the accused list and nothing else, so re-running that
   * list alone repeats the experiment exactly. Its green is therefore already the
   * check answering both ways over one oid — the instability — and a third sample
   * would only break the tie on a majority, which is not what any of this
   * measures. So no second worktree is bought, and no row claims a replay.
   */
  it('an accusation that IS the whole experiment is settled by ONE re-run, and its green is the instability', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, caseId, ceilingTip } = await inheritedCase(repo, ws, inv);
    // Red on every ODD run at the ceiling. One re-run sees green and stops; a
    // third would see red again and call the same bytes CONFIRMED.
    let ceilingRuns = 0;
    const worktrees = new Set<string>();
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      if (baseDir && shaAt(baseDir) === ceilingTip) {
        ceilingRuns++;
        if (!readJournal(dir).some((e) => e.action === 'gate-fix-ceiling')) worktrees.add(baseDir);
        if (ceilingRuns % 2 === 0) return { ok: true, failedNames: [], output: '' };
      }
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/shared.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      fn,
      fakeInstall,
    );
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'gate-fix-ceiling')!.decided).toBe('refused-unstable');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.phase === 'ceiling')!;
    expect(confirm.reproduced).toBe(false);
    expect(confirm.aloneGreen).toBe(true);
    // NO REPLAY WAS TAKEN, so no row may imply one — including the sentence.
    expect(confirm.replayVariation).toBeUndefined();
    expect(confirm.replayGreen).toBeUndefined();
    expect(String(confirm.detail)).toContain('the same command set');
    expect(String(confirm.detail)).not.toContain('replayed command sequence');
    // THE COST: the standing worktree and ONE re-run.
    expect(worktrees.size).toBe(2);
    expect(journal.find((e) => e.action === 'gate-fix-refused')!.id).toBe('WARN21_CHECKS_FLAKY');
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
  });

  /**
   * THE SETTLED SIBLING — the pin on the predicate, which compares the sequence
   * against WHAT THE ALONE RE-RUN RAN and not against the accusation.
   *
   * Both commands are accused here, so an accusation-based test would say the
   * sequence adds nothing and skip the replay. It adds a great deal: one command
   * is already settled this pass and is not re-run, so the alone re-run is a
   * STRICT SUBSET of the experiment, and the sequence puts the sibling back. The
   * red needs it. Read this before narrowing the predicate to the failing set.
   */
  it('a settled sibling makes the sequence richer than the alone re-run, and the replay is taken', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const checks = checksFile(ws, { typecheck: ['tsc --noEmit', 'tsc -b'] });
    const { dir, ceilingTip } = await inheritedCase(repo, ws, inv, checks);
    // `tsc --noEmit` is already confirmed red on the subtree the ceiling's tip
    // carries, so the confirming probe owes only `tsc -b`.
    seedConfirmedRed(dir, repo, 'module/elsewhere', ceilingTip);
    /** Worktrees `tsc --noEmit` has already run in — the state `tsc -b` needs. */
    const typechecked = new Set<string>();
    let ceilingRuns = 0;
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const after = typechecked.has(baseDir) || names.includes('tsc --noEmit');
      if (names.includes('tsc --noEmit')) typechecked.add(baseDir);
      if (baseDir && shaAt(baseDir) === ceilingTip && ++ceilingRuns > 1) {
        const failedNames = names.filter((n) => n === 'tsc -b' && after);
        return {
          ok: failedNames.length === 0,
          failedNames,
          output: failedNames.map((n) => `$ ${n}\nsrc/shared.ts(1,1): error TS2345: boom\n`).join(''),
        };
      }
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/shared.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      fn,
      fakeInstall,
    );
    const journal = readJournal(dir);
    // `tsc --noEmit` was RE-STATED from the settled verdict, never re-run...
    const restated = journal.find(
      (e) => e.action === 'red-confirm' && e.phase === 'ceiling' && e.cmd === 'tsc --noEmit',
    )!;
    expect(restated.ran).toBe(false);
    expect(restated.reason).toBe('confirmed-this-pass');
    // ...so the alone re-run ran `tsc -b` by itself, went green, and the replay
    // that put the sibling back is what confirmed it.
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.phase === 'ceiling' && e.cmd === 'tsc -b')!;
    expect(confirm.reproduced).toBe(true);
    expect(confirm.aloneGreen).toBe(true);
    expect(confirm.context).toBe('sequence');
    expect(confirm.replayVariation).toBeTruthy();
    expect(journal.find((e) => e.action === 'gate-fix-ceiling')!.decided).toBe('lift-measured');
  });

  /**
   * A RED WHERE THE CONTENT IS NOT IS REPORTED, AND IT DECIDES NOTHING.
   *
   * The same command is confirmed red at a commit that does not carry the failing
   * file, and content cannot break a tree it is absent from — so the machine may
   * be part of the story, and the coordinate travels with the case so the owner
   * can check it. What the match does NOT establish is that it is the SAME
   * failure: it is keyed on the COMMAND, and one command carries many failures.
   * A branch that forked before the failing file existed and is red on its own
   * unrelated defect matches every part of it. So the decision is taken exactly
   * as if the scan had not fired, and a confirmed red still gets its case.
   */
  it('a confirmed red where the failing file is ABSENT is NOTED, and the mint proceeds', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, caseId } = await inheritedCase(repo, ws, inv);
    // Upstream never had `src/shared.ts` — the trunk added it — and the same
    // command is confirmed red there.
    const absentAt = repo.sha('main');
    appendJournal(dir, {
      action: 'landing-check',
      branch: 'module/elsewhere',
      sha: absentAt,
      ok: false,
      confirmed: true,
      failed: ['tsc --noEmit'],
    });
    const r = namingRunner(['tsc --noEmit'], 'src/shared.ts');
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
    const rows = journal.filter((e) => e.action === 'gate-fix-ceiling');
    // The coordinate is a ROW OF ITS OWN, and the decision is a second row taken
    // as though the first had not happened.
    const noted = rows.find((e) => e.decided === 'environment-noted')!;
    expect(noted.detail).toContain('affects everything below main_patched');
    expect(noted.detail).toContain(`also red at ${absentAt.slice(0, 12)}`);
    expect(noted.detail).toContain('does not carry the content');
    expect(rows.map((e) => e.decided)).toEqual(['environment-noted', 'lift-measured']);
    // NOTHING IS REFUSED ON IT. A refusal here would tell the agent that no code
    // change can fix a defect that a code change fixes.
    expect(journal.some((e) => e.action === 'gate-fix-refused' && e.id === 'WARN14_ENVIRONMENT_FAULT')).toBe(false);
    const gateFixes = journal.filter((e) => e.action === 'gate-fix');
    expect(gateFixes.map((e) => e.branch)).toEqual(['main_patched']);
    // And it REACHES the agent: a coordinate that lives only in the journal is
    // one the case never sees.
    const briefing = readFileSync(join(dir, gateFixes[0].caseId as string, 'gate-fix-output.txt'), 'utf8');
    expect(briefing).toContain('does not carry the content');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; instruction: string };
    expect(res.status).toBe('gate-fix-required');
    expect(res.instruction).toContain('does not carry the content');
    expect(caseId).toBeTruthy();
  });

  /**
   * The trunk resolves a conflict at height 0 and then merges height 1, so it has
   * a commit AT each height; `module/cg` conflicts at height 0 and stops there.
   * Its case's merge point is therefore one commit BELOW the trunk tip — the
   * routine shape once a parent has moved on past the point a child stopped at.
   * `src/p.ts` and `src/s.ts` are both the trunk's own files.
   */
  function mergePointBehindTipFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.commit('mp: trunk files', { 'src/p.ts': 'p\n', 'src/s.ts': 's\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg: x = cg', { 'src/x.ts': 'cg\n' });
    // TWO conflicting parent commits, so the child's walk stops at the first
    // while the parent tip sits one commit above it — the case head carries the
    // parent's own files and is NOT the parent tip.
    repo.checkout('main_patched');
    repo.commit('mp: x = up1', { 'src/x.ts': 'up1\n' });
    repo.commit('mp: x = up2', { 'src/x.ts': 'up2\n' });
    repo.checkout('main');
    repo.commit('U0: pass progress', { 'src/u0.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * ONE TARGET, TWO MEASUREMENTS, TWO COMMITS — and either of them licenses it.
   *
   * A parent floor confirmed at the case's merge point and a lift confirmed at
   * the branch tip route to the SAME branch, so they are one defect and one case.
   * Their subtrees differ, so a check keyed at one of them finds no record for the
   * other's commands: keying only at the tip refuses a target whose other half was
   * solidly confirmed, and the agent is told nobody can be handed a defect the
   * pass measured twice.
   */
  it('a target assembled from two commits is minted when EITHER of them confirms it', async () => {
    const repo = mergePointBehindTipFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const cmds = ['tsc --noEmit', 'tsc --build'];
    const green: ChecksRunner = async () => ({ ok: true, failedNames: [], output: '' });
    const cli = (over: Partial<Cli> = {}): Cli => baseCli(repo, ws, inv, over);
    await cmdSweepStart(cli({ checksFile: checksFile(ws, { typecheck: cmds }) }));
    const dir = dirOf(repo, ws);
    // `module/cg` gets its case at the FIRST conflicting parent commit — the
    // walk's stop, one commit below the parent tip.
    await cmdSweepNextCase(cli(), green);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    seedPriorFailure(dir, caseId, 'typecheck', cmds);
    const wtPath = join(dir, caseId, 'worktree');
    const branchTip = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const mergePoint = (JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as { head: { sha: string } })
      .head.sha;
    const trunkTip = repo.sha('main_patched');
    // The premise: the trunk moved on past the point this case stopped at.
    expect(mergePoint).not.toBe(trunkTip);

    // `src/s.ts` fails at the branch tip (its floor), `src/p.ts` only at the merge
    // point (the parent's). At the TRUNK TIP only the first command fails — so the
    // lift is confirmed there for that command and for no other.
    const fn: ChecksRunner = async (commands, baseDir) => {
      const at = baseDir ? shaAt(baseDir) : '';
      const names = commands.map((c) => c.cmd).filter((n) => at !== trunkTip || n === cmds[0]);
      if (names.length === 0) return { ok: true, failedNames: [], output: '' };
      const files = at === branchTip || at === trunkTip ? ['src/s.ts'] : ['src/p.ts', 'src/s.ts'];
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\n${files.map((f) => `${f}(1,1): error TS2345: boom\n`).join('')}`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        cli({ cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        fn,
        fakeInstall,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    // Two floors, one target: the parent's own file stays where it was measured,
    // and the branch's inherited file is lifted to the same branch.
    expect(
      journal
        .filter((e) => e.action === 'gate-fix-ceiling')
        .map((e) => e.decided)
        .sort(),
    ).toEqual(['lift-measured', 'no-lift-same']);
    const gateFixes = journal.filter((e) => e.action === 'gate-fix');
    expect(gateFixes.map((e) => e.branch)).toEqual(['main_patched']);
    expect((gateFixes[0].files as string[]).sort()).toEqual(['src/p.ts', 'src/s.ts']);
    // The MERGE POINT is what licensed it — the tip carries a confirmation for one
    // command only — and the row says so, because a reader cannot otherwise tell
    // which observation the case rests on.
    const licensed = journal.find((e) => e.action === 'gate-fix-red-ref')!;
    expect(licensed.ref).toBe(mergePoint);
    expect(licensed.refs).toEqual([trunkTip, mergePoint]);
    expect(journal.some((e) => e.action === 'gate-fix-refused' && e.id === 'WARN22_RED_UNCONFIRMED')).toBe(false);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string };
    expect(res.status).toBe('gate-fix-required');
  });

  /**
   * `src/x.ts` is the conflict; `container/` is a second suite's cwd that no
   * resolution of that conflict touches. The two together are what the shortcut
   * needs to be sound: a failing subtree whose bytes the resolution did not
   * write.
   */
  function subtreeCwdFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x + container', { 'src/x.ts': 'orig\n', 'container/agent/poll.test.ts': 'ok\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /** The pinned contract for those fixtures: one command, running in `container`. */
  function containerChecksFile(ws: string): string {
    const f = join(ws, 'checks.json');
    writeFileSync(f, JSON.stringify({ typecheck: [{ cmd: 'bun test', cwd: 'container' }], test: [] }));
    return f;
  }

  /**
   * Drive a conflict case to a resolution, and hand back the two oids the
   * shortcut compares: the failing cwd at the RESOLVED tree, and at the CLEAN
   * PREFIX — the merge minus the resolution.
   */
  async function resolvedAndPrefixSubtree(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    resolution: Record<string, string>,
  ): Promise<{ dir: string; caseId: string; wtPath: string; prefix: string; resolvedOid: string; prefixOid: string }> {
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: containerChecksFile(ws) }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, resolution);
    seedPriorFailure(dir, caseId, 'typecheck', ['bun test']);
    const wtPath = join(dir, caseId, 'worktree');
    execFileSync('git', ['-C', wtPath, 'add', '-A'], { encoding: 'utf8' });
    const resolvedTree = execFileSync('git', ['-C', wtPath, 'write-tree'], { encoding: 'utf8' }).trim();
    const prefix = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return {
      dir,
      caseId,
      wtPath,
      prefix,
      resolvedOid: repo.git('rev-parse', `${resolvedTree}:container`),
      prefixOid: repo.git('rev-parse', `${prefix}:container`),
    };
  }

  /** Counts the runs `classifyFailure` would take: the clean prefix, nowhere else. */
  function baselineCounter(wtPath: string, prefix: string): { fn: ChecksRunner; runs: string[] } {
    const runs: string[] = [];
    const fn: ChecksRunner = async (commands, baseDir) => {
      if (baseDir !== wtPath && shaAt(baseDir) === prefix) runs.push(baseDir);
      const names = commands.map((c) => c.cmd);
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\ncontainer/agent/poll.test.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    return { fn, runs };
  }

  /**
   * THE SAME BYTES ALREADY FAILED WITHOUT THIS RESOLUTION.
   *
   * A check is a function of the subtree it runs in, so a failing command whose
   * subtree is an oid the pass already confirmed red AND is unchanged from the
   * clean prefix is a failure in content the resolution did not write. The
   * comparison the probe pair exists to make has already been made, by git: the
   * two probe runs — an install and a suite, twice — are simply not spent.
   */
  it('a failing subtree the resolution did not touch, already confirmed red, skips the probe pair', async () => {
    const repo = subtreeCwdFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const st = await resolvedAndPrefixSubtree(repo, ws, inv, { 'src/x.ts': 'RESOLVED\n' });
    // The resolution is entirely outside the failing command's cwd.
    expect(st.resolvedOid).toBe(st.prefixOid);
    appendJournal(st.dir, {
      action: 'red-confirm',
      branch: 'module/elsewhere',
      sha: repo.sha('main_patched'),
      phase: 'test',
      cmd: 'bun test',
      cwd: 'container',
      subtree: st.resolvedOid,
      commands: ['bun test'],
      ran: true,
      reproduced: true,
    });
    const r = baselineCounter(st.wtPath, st.prefix);
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    // THE DELETION: the baseline is never built and never run.
    expect(r.runs).toEqual([]);
    const verdict = readJournal(st.dir).find((e) => e.action === 'not-my-bug')!;
    expect(verdict.verdict).toBe('pre-existing');
    expect(verdict.via).toBe('subtree-verdict');
    expect(verdict.probes).toBe(0);
  });

  /**
   * A CONFIRMATION CAN ITSELF CARRY A RESOLUTION. Confirmations are taken at
   * branch tips, and a tip holds whatever landed on it — so an oid that matches
   * the RESOLVED tree proves nothing on its own. Two siblings take one conflict
   * from one parent, the first resolution lands and its tip is confirmed red
   * with those bytes in it, and the second agent writes the same resolution,
   * breaking something nobody was resolving. Only the prefix comparison
   * separates that from a genuine pre-existing red, and without it the failure
   * the resolution caused is waved through.
   */
  it('a red confirmed on bytes the resolution WROTE does not skip the probe pair', async () => {
    const repo = subtreeCwdFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    // The resolution reaches INTO the failing command's cwd — the sibling shape,
    // where the matched confirmation was taken on a tree carrying these bytes.
    const st = await resolvedAndPrefixSubtree(repo, ws, inv, {
      'src/x.ts': 'RESOLVED\n',
      'container/agent/poll.test.ts': 'BROKEN by the resolution\n',
    });
    expect(st.resolvedOid).not.toBe(st.prefixOid);
    appendJournal(st.dir, {
      action: 'red-confirm',
      branch: 'module/sibling',
      sha: repo.sha('main_patched'),
      phase: 'test',
      cmd: 'bun test',
      cwd: 'container',
      subtree: st.resolvedOid,
      commands: ['bun test'],
      ran: true,
      reproduced: true,
    });
    const r = baselineCounter(st.wtPath, st.prefix);
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    // THE POINT: the shortcut does not fire, so the baseline is measured — the
    // one tree that is genuinely without any resolution.
    expect(r.runs.length).toBeGreaterThan(0);
    const verdict = readJournal(st.dir).find((e) => e.action === 'not-my-bug')!;
    expect(verdict.via).toBeUndefined();
  });

  /**
   * WHAT FAILED, BY THE ONLY IDENTITY THAT IS EXACT. A gate-fix PR carries the
   * `(command, cwd, subtree oid)` of every failing command, read at the case
   * head — so a later pass can ask whether it is looking at the same failure
   * without guessing from a file name or matching error prose.
   */
  it('a published gate-fix PR carries the failure signature in its machine block', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg']) repo.git('push', 'origin', b);
    const { dir, caseId, ceilingTip } = await inheritedCase(repo, ws, inv);
    seedConfirmedRed(dir, repo, 'module/elsewhere', ceilingTip);
    const r = namingRunner(['tsc --noEmit'], 'src/shared.ts');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    const gateFix = readJournal(dir).find((e) => e.action === 'gate-fix')!;
    const gateCase = gateFix.caseId as string;
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    // Held with the worktree untouched: the sanctioned diagnosis-only outcome,
    // which is what publishes a PR the owner reads.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }),
        confirm,
        greenPreMerge,
        fakeInstall,
      ),
    ).toBe(0);
    const prDir = join(dir, gateCase, 'pr');
    mkdirSync(prDir, { recursive: true });
    writeFileSync(join(prDir, 'title.txt'), 'fix(sweep): the shared defect');
    writeFileSync(
      join(prDir, 'body.md'),
      '# Diagnosis\n\nThe failing test lives above this branch and the fix belongs with its owner.\n',
    );
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub();
    expect(
      await cmdPublish(baseCli(repo, ws, inv, { cmd: 'publish', caseId: gateCase, execute: true, tokenFile }), gh.factory),
    ).toBe(0);
    const prCall = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    const body = (prCall.body as { body: string }).body;
    const lines = parseMachineLines(body).get('sweep-failure') ?? [];
    expect(lines).toHaveLength(1);
    const head = (readJournal(dir).find((e) => e.action === 'case' && e.caseId === gateCase)!.head as { sha: string }).sha;
    const oid = repo.git('rev-parse', `${head}^{tree}`);
    // The digest is the case id's own suffix: one files digest, named the same
    // way wherever it appears.
    expect(lines[0]).toBe(`cmd=tsc --noEmit cwd=. subtree=${oid.slice(0, 12)} files=${gateCase.slice(-8)}`);
    expect(caseId).toBeTruthy();
  });

  /**
   * A GATE FIX FROZEN WITH THE FIX KEPT IS A DRAFT. There is no pristine
   * exhibit to fall back on, so the head is always the attempted fix — and the
   * agent reached this freeze by saying the fix cannot be made in scope. The
   * work still reaches the owner, and the flag is what stops it being offered
   * as mergeable.
   */
  it('a held gate fix that KEEPS its attempted fix publishes a DRAFT', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg']) repo.git('push', 'origin', b);
    const { dir, ceilingTip } = await inheritedCase(repo, ws, inv);
    seedConfirmedRed(dir, repo, 'module/elsewhere', ceilingTip);
    const r = namingRunner(['tsc --noEmit'], 'src/shared.ts');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    const gateCase = readJournal(dir).find((e) => e.action === 'gate-fix')!.caseId as string;
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    // The agent ATTEMPTED the fix and then concluded it cannot be completed
    // here: the tree carries real edits, so the freeze keeps them.
    resolveWorktree(dir, gateCase, { 'src/shared.ts': 'half a fix\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }),
        confirm,
        greenPreMerge,
        fakeInstall,
      ),
    ).toBe(0);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === gateCase)!;
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: checks failing]');
    expect(held.resolution).toBeTruthy(); // the attempt is KEPT — not an empty report
    writePr(dir, gateCase, 'fix(sweep): a partial fix for the shared defect', '# Diagnosis\n\nHalf of it.\n');
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub();
    expect(
      await cmdPublish(baseCli(repo, ws, inv, { cmd: 'publish', caseId: gateCase, execute: true, tokenFile }), gh.factory),
    ).toBe(0);
    const post = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect((post.body as { draft: boolean }).draft).toBe(true);
    expect(readJournal(dir).find((e) => e.action === 'pr-published' && e.caseId === gateCase)!.draft).toBe(true);
  });

  /**
   * Drive an inherited red to a SERVED gate-fix case whose character the mint
   * measured, with the same subtree recorded GREEN elsewhere in the pass — the
   * shape that makes the check itself, and not the assertion, the defect.
   */
  async function servedContestedGateFix(
    repo: FixtureRepo,
    ws: string,
    inv: string,
  ): Promise<{ dir: string; gateCase: string; wt: string }> {
    const { dir, ceilingTip } = await inheritedCase(repo, ws, inv);
    seedConfirmedRed(dir, repo, 'module/elsewhere', ceilingTip);
    // The SAME (subtree, command) measured green on another branch: one oid,
    // both answers, which is the only shape of disagreement that is one.
    appendJournal(dir, {
      action: 'landing-check',
      branch: 'module/green-side',
      sha: ceilingTip,
      ok: true,
      checks: [{ cmd: 'tsc --noEmit', cwd: '.', subtree: repo.git('rev-parse', `${ceilingTip}^{tree}`), ok: true }],
    });
    const r = namingRunner(['tsc --noEmit'], 'src/shared.ts');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    const gateCase = readJournal(dir).find((e) => e.action === 'gate-fix')!.caseId as string;
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge)).toBe(0);
    return { dir, gateCase, wt: join(dir, gateCase, 'worktree') };
  }

  /** A checks gate that passes, so a served gate fix reaches its cold read. */
  const greenGate: ChecksRunner = async () => ({ ok: true, failedNames: [], output: '' });

  /**
   * THE CHARACTER REACHES THE READER, IN THE RECORD IT JUDGES AGAINST.
   *
   * The cold reader is asked whether a change contradicts a record in its
   * request — so the rule that separates "make this check deterministic" from
   * "make it ask for less" has to BE in the request. It is a record, not a fourth
   * question: Q3 already binds to it, and a reader told the character can answer
   * about the diff in front of it without being taught anything new.
   */
  it('a contested gate fix carries its character and the instability rule into the cold read', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, gateCase, wt } = await servedContestedGateFix(repo, ws, inv);
    // The mint measured it: the same bytes answered both ways this pass.
    const caseRow = readJournal(dir).find((e) => e.action === 'case' && e.caseId === gateCase)!;
    expect(caseRow.reproduction).toBe('environment-conditional');
    const materials = readFileSync(join(dir, gateCase, 'materials.md'), 'utf8');
    expect(materials).toContain('REPRODUCTION: ENVIRONMENT-CONDITIONAL');
    expect(materials).toContain('An instability case is resolved by making the check deterministic');
    // The CRITERION, not just the list: an edit that leaves the outcome to chance
    // and one that stops asking are both named, so neither reads as permitted.
    expect(materials).toContain('one answer under any order, load or timing');
    expect(materials).toContain('stops the question being asked');
    // The raise to `environment-conditional` keeps the method instruction the
    // full-suite character carries — the agent still cannot observe this one.
    expect(materials).toContain('YOU CANNOT OBSERVE IT NARROWED EITHER');

    writeFileSync(join(wt, 'src/shared.ts'), 'ok\n');
    let seen = '';
    const capture: ColdReadInvoker = async (prompt) => {
      seen = prompt;
      return { verdict: 'confirm', notes: 'deterministic fix' };
    };
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
      capture,
      greenGate,
      fakeInstall,
    );
    // The character is NAMED, and the rule travels with it.
    expect(seen).toContain('Reproduction character (driver-measured): environment-conditional');
    expect(seen).toContain('An instability case is resolved by making the check deterministic');
    expect(seen).toContain('one answer under any order, load or timing');
    expect(seen).toContain('stops the question being asked');
    // …in the record block Q3 asks about, above the questions themselves.
    expect(seen.indexOf('An instability case is resolved')).toBeLessThan(seen.indexOf('## Cold-reader questions'));
    expect(seen).toContain('Does the change contradict any record included in this request?');
  });

  /**
   * A DIFF THAT MAKES THE CHECK ASK FOR LESS IS ANSWERABLE ON Q3. The reader
   * holds the widening and the rule it contradicts in one request, so rejecting
   * it is a reading of the record rather than an opinion about test hygiene —
   * which is exactly what keeps the driver out of the business of having taste.
   */
  it('a timeout-widening fix reaches the reader beside the record it contradicts', async () => {
    const repo = inheritedRedFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const { dir, gateCase, wt } = await servedContestedGateFix(repo, ws, inv);
    // The "fix": the assertion is untouched and the check is simply given longer.
    writeFileSync(join(wt, 'src/shared.ts'), 'broken\ntimeout: 30000\n');
    let seen = '';
    const rejectOnRecord: ColdReadInvoker = async (prompt) => {
      seen = prompt;
      return {
        verdict: 'reject',
        notes: 'q3',
        answers: {
          q1: 'no — the assertion is unchanged',
          q2: 'yes',
          q3: 'CONTRADICTS the record: the case is environment-conditional and this only widens a timeout',
        },
        feedback: 'make the check deterministic instead of giving it longer',
      } as Awaited<ReturnType<ColdReadInvoker>>;
    };
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
      rejectOnRecord,
      greenGate,
      fakeInstall,
    );
    // BOTH halves are in front of the reader: the widening, and the rule.
    expect(seen).toContain('timeout: 30000');
    expect(seen).toContain('An instability case is resolved by making the check deterministic');
    expect(seen).toContain('stops the question being asked');
    // And the reject is what the driver recorded — the case does not resolve.
    const journal = readJournal(dir);
    const cold = journal.filter((e) => e.action === 'coldread' && e.caseId === gateCase);
    expect(cold.length).toBeGreaterThan(0);
    expect(cold[cold.length - 1].verdict).toBe('reject');
    expect(journal.some((e) => e.action === 'resolved' && e.caseId === gateCase)).toBe(false);
  });

  /**
   * ONE OID, BOTH ANSWERS. A command measured green somewhere and confirmed red
   * somewhere else over the SAME subtree contradicted itself — the only shape of
   * disagreement that is one — and everything downstream of a confirmed red
   * treats it as settled, so the pass that saw both answers is the only place it
   * can be said.
   */
  it('a check green and confirmed red over one oid is reported as contested', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'true', cwd: '.' }], test: [] }));
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }), undefined, greenPreMerge);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
      confirm,
      greenPreMerge,
      fakeInstall,
    );
    const oid = repo.git('rev-parse', 'main_patched^{tree}');
    appendJournal(dir, {
      action: 'landing-check',
      branch: 'module/green-side',
      sha: repo.sha('main_patched'),
      ok: true,
      checks: [{ cmd: 'true', cwd: '.', subtree: oid, ok: true }],
    });
    appendJournal(dir, {
      action: 'red-confirm',
      branch: 'module/red-side',
      sha: repo.sha('main_patched'),
      phase: 'test',
      cmd: 'true',
      cwd: '.',
      subtree: oid,
      commands: ['true'],
      ran: true,
      reproduced: true,
    });
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const out = join(ws, 'f.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out }));
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      contestedChecks?: Array<{ cmd: string; subtree: string; greenOn: string; redOn: string }>;
      instruction: string;
    };
    expect(res.contestedChecks).toEqual([
      { cmd: 'true', cwd: '.', subtree: oid, greenOn: 'module/green-side', redOn: 'module/red-side' },
    ]);
    expect(res.instruction).toContain('answered BOTH ways over the SAME bytes');
    expect(res.instruction).toContain('module/green-side');
    expect(res.instruction).toContain('module/red-side');
  });

  /**
   * A runner GREEN at ONE tree and red at every other — the shape that carries
   * ownership past the branch tip and onto the parent head.
   */
  function parentOwnedRunner(wtPath: string, tipSha: string, file: string): ChecksRunner {
    return async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const at =
        baseDir && baseDir !== wtPath
          ? execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
          : '';
      if (at === tipSha) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\n${file}(1,1): error TS2345: boom\n`).join(''),
      };
    };
  }

  /**
   * THE OWNER IS UPSTREAM, so no case may be minted anywhere — and a case that
   * mints nothing has nothing to abort FOR. Destroying the resolution here buys
   * no gate fix and costs the whole case, which is then re-derived, re-worked and
   * refused again on the next round.
   */
  it('an owner that is UPSTREAM mints nothing and the resolution is KEPT', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const out = join(ws, 'rc.json');
    // The HELD arm exits 0: the case is finished and waiting for its PR text.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        parentOwnedRunner(wtPath, tipSha, 'src/util.ts'),
        fakeInstall,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('pre-existing');
    expect(journal.find((e) => e.action === 'not-my-bug-owner')!.owner).toBe('parent');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    const refusal = journal.find((e) => e.action === 'gate-fix-refused')!;
    expect(refusal.id).toBe('WARN15_UPSTREAM_RED');
    expect(refusal.branch).toBe('main');
    expect(refusal.caseId).toBe(caseId);
    expect(refusal.files).toEqual(['src/util.ts']);
    // NOTHING WAS DESTROYED: no discard row, and the held row ships the agent's
    // own tree.
    expect(journal.some((e) => e.action === 'not-my-bug-discarded')).toBe(false);
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    const resolution = held.resolution as { tree: string; markerClean: boolean };
    expect(resolution.markerClean).toBe(true);
    expect(repo.git('show', `${resolution.tree}:src/x.ts`)).toContain('RESOLVED');
    expect(machineState(dir).phase).toBe('awaiting-pr');
    expect(machineState(dir).currentCase).toMatchObject({ caseId, tier: 'held' });
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      tier: string;
      issues: Array<{ id: string }>;
      uncovered: { kind: string; files: string[] };
      instruction: string;
    };
    expect(res.tier).toBe('held');
    expect(res.issues.map((i) => i.id)).toEqual(['WARN15_UPSTREAM_RED']);
    expect(res.uncovered).toEqual({ kind: 'unmintable-red', files: ['src/util.ts'], detail: expect.any(String) });
    expect(res.instruction).toContain('your resolution stands');
  });

  /**
   * A branch owner and an UPSTREAM owner in one failing set. `src/mine.ts` is red
   * at the branch tip; `src/util.ts` exists only on upstream and is red at the
   * parent head.
   */
  function upstreamCoOwnerFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x + mine', { 'src/x.ts': 'orig\n', 'src/mine.ts': 'm\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * ONE MINTABLE OWNER IS ENOUGH TO ABORT, and the refused one still has to be
   * SAID. The mintable owner gets its case and the merge goes, exactly as before;
   * the owner nobody may be handed a fix for joins the files no gate fix covers,
   * rather than vanishing between a proven-owner row and a mint that never
   * happened.
   */
  it('one mintable owner and one refused: the mint happens, the refusal is reported', async () => {
    const repo = upstreamCoOwnerFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        ownershipRunner(wtPath, tipSha, 'src/mine.ts', 'src/util.ts'),
        fakeInstall,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    // One case, on the one owner a case may be rooted on.
    const gateFixes = journal.filter((e) => e.action === 'gate-fix');
    expect(gateFixes.map((e) => e.branch)).toEqual(['main_patched']);
    expect(gateFixes[0].files).toEqual(['src/mine.ts']);
    // The upstream owner is refused BEFORE the bisect and the abort, and the row
    // names the case it came from.
    const refusal = journal.find((e) => e.action === 'gate-fix-refused')!;
    expect(refusal.id).toBe('WARN15_UPSTREAM_RED');
    expect(refusal.branch).toBe('main');
    expect(refusal.caseId).toBe(caseId);
    expect(refusal.files).toEqual(['src/util.ts']);
    // No bisect was paid for the owner that was never going to mint.
    expect(journal.filter((e) => e.action === 'not-my-bug-bisect').map((e) => e.branch)).toEqual(['main_patched']);
    // A mintable owner exists, so the merge IS aborted and the resolution goes.
    expect(journal.some((e) => e.action === 'not-my-bug-discarded')).toBe(true);
    expect(supersededCaseIds(journal).has(caseId)).toBe(true);
    // Every reopen is journaled before every mint, and the fix is exempt from
    // supersede, so it stands.
    const firstMint = journal.findIndex((e) => e.action === 'gate-fix');
    const lastReopen = journal.map((e) => e.action).lastIndexOf('reopened');
    expect(lastReopen).toBeLessThan(firstMint);
    expect(supersededCaseIds(journal).has(gateFixes[0].caseId as string)).toBe(false);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      issues: Array<{ id: string }>;
      uncovered: { kind: string; files: string[]; detail: string };
      instruction: string;
    };
    expect(res.status).toBe('gate-fix-required');
    // The refused owner's files are covered by no gate fix, so they are reported
    // exactly where a remainder is reported.
    expect(res.uncovered).toEqual({ kind: 'unmintable-red', files: ['src/util.ts'], detail: expect.any(String) });
    expect(res.issues.map((i) => i.id)).toContain('WARN15_UPSTREAM_RED');
    expect(res.instruction).toContain('src/util.ts');
    // A PROCEED arm carries WARN ids only.
    expect(res.issues.every((i) => i.id.startsWith('WARN'))).toBe(true);
  });

  /**
   * THE PARTITION AND THE MINT ASK THE SAME QUESTION. A red confirmed on another
   * branch carrying the identical subtree stops the partition where it stands —
   * it can never become mintable, so probing and bisecting it buys nothing — and
   * the case ends HELD with the resolution kept.
   */
  it('a red whose verdict another branch owns stops the partition and keeps the resolution', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    appendJournal(dir, {
      action: 'red-confirm',
      branch: 'module/elsewhere',
      sha: tipSha,
      phase: 'test',
      cmd: 'tsc --noEmit',
      cwd: '.',
      subtree: repo.git('rev-parse', `${tipSha}^{tree}`),
      commands: ['tsc --noEmit'],
      ran: true,
      reproduced: true,
    });
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        r.fn,
        fakeInstall,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    // NOT a proven owner: the partition stops on a verdict that names nobody.
    expect(journal.find((e) => e.action === 'not-my-bug-owner')!.owner).toBe('shared');
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'not-my-bug-bisect')).toBe(false);
    expect(journal.some((e) => e.action === 'not-my-bug-discarded')).toBe(false);
    const refusal = journal.find((e) => e.action === 'gate-fix-refused')!;
    expect(refusal.id).toBe('WARN22_RED_UNCONFIRMED');
    expect(refusal.branch).toBe('main_patched');
    expect(refusal.caseId).toBe(caseId);
    expect(refusal.reason).toContain('module/elsewhere');
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.resolution as { markerClean: boolean }).markerClean).toBe(true);
    expect(machineState(dir).phase).toBe('awaiting-pr');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { tier: string; issues: Array<{ id: string }> };
    expect(res.tier).toBe('held');
    expect(res.issues.map((i) => i.id)).toEqual(['WARN22_RED_UNCONFIRMED']);
  });

  /**
   * THE CONFIRMING RE-RUN'S ANSWER IS THE ANSWER. The ownership probe's own pair
   * agrees — same worktree, same moment — and the varied re-run, in a separately
   * prepared worktree, does not. A side that answers both ways names no owner, so
   * nothing is bisected, nothing is minted and nothing is destroyed.
   */
  it('a side whose confirming re-run does not reproduce names no owner and keeps the resolution', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const out = join(ws, 'rc.json');
    // The probe reuses ONE worktree per commit; the confirming re-run gets a
    // freshly prepared one. A second directory at the same sha is therefore the
    // varied re-run, and it comes back green.
    const probeDir = new Map<string, string>();
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      if (baseDir && baseDir !== wtPath) {
        const at = execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const first = probeDir.get(at);
        if (first === undefined) probeDir.set(at, baseDir);
        else if (first !== baseDir) return { ok: true, failedNames: [], output: '' };
      }
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/util.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
        neverInvoked,
        fn,
        fakeInstall,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'not-my-bug')!.verdict).toBe('pre-existing');
    // NOT `branch`: the side is unstable, so it owns nothing.
    expect(journal.find((e) => e.action === 'not-my-bug-owner')!.owner).toBe('flaky');
    expect(journal.some((e) => e.action === 'not-my-bug-bisect')).toBe(false);
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'not-my-bug-discarded')).toBe(false);
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.resolution as { markerClean: boolean }).markerClean).toBe(true);
    expect(machineState(dir).phase).toBe('awaiting-pr');
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      tier: string;
      issues: Array<{ id: string }>;
      notMyBug: { owner: string };
    };
    expect(res.tier).toBe('held');
    expect(res.issues.map((i) => i.id)).toEqual(['WARN21_CHECKS_FLAKY']);
    expect(res.notMyBug.owner).toBe('flaky');
  });

  /**
   * Drive an adjudication whose WHOLE failing set is an INTERACTION: `src/c.ts`
   * is green at the branch tip and at the parent head and red only once the two
   * are merged. No owner is provable, so nothing is minted and the case's edit
   * scope is widened onto it. `fixed()` flips the suite green, standing in for
   * the agent taking the widening up.
   */
  async function adjudicateInteractionOnly(
    repo: FixtureRepo,
    ws: string,
    inv: string,
  ): Promise<{ dir: string; caseId: string; out: string; code: number; fn: ChecksRunner; fixed: () => void }> {
    // The configured commands are green shell no-ops: the CASE suite is the
    // injected runner below, while finish's integration verify runs these for
    // real against a trunk the held branch is cut out of.
    const checks = checksFile(ws, { typecheck: ['true'], test: ['true'] });
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    seedPriorFailure(dir, caseId, 'typecheck', ['true']);
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const parentHead = (JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as { head: { sha: string } })
      .head.sha;
    let red = true;
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const at =
        baseDir && baseDir !== wtPath
          ? execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
          : '';
      // Each side alone passes; the merged tree and its clean prefix fail.
      if (!red || at === tipSha || at === parentHead) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/c.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    const code = await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      fn,
      fakeInstall,
    );
    return { dir, caseId, out, code, fn, fixed: () => (red = false) };
  }

  // --- THE PULL REQUEST CARRIES THE FIX, NOT THE INSTRUCTIONS FOR IT --------
  //
  // An agent that resolves the conflict, works out the exact remedy for the red
  // it leaves behind, and writes that remedy into the PR body because the file
  // read as out of scope has done the work and shipped the description of it.
  // The claim is refused ONCE where the driver can show the red is inside the
  // claim's own reach.

  it('a held claim whose failures are ALL test files is refused once, then honored', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    // The repo names its tests, which is what puts them in the claim's reach.
    const f = join(ws, 'checks.json');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: [],
        test: [{ cmd: 'vitest run', cwd: '.' }],
        testPaths: ['**/*.test.ts'],
      }),
    );
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: f }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const red: ChecksRunner = async (commands) => ({
      ok: false,
      failedNames: commands.map((c) => c.cmd),
      output: commands
        .map((c) => `$ ${c.cmd}\n FAIL  src/x.test.ts > x is fork\n   -> expected 'RESOLVED' to be 'fork'\n`)
        .join(''),
    });
    const out = join(ws, 'rc.json');
    // FIRST claim: refused. The failing file is a test, tests are in scope, and
    // the agent is told to fix it rather than to describe fixing it.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
        neverInvoked,
        red,
        fakeInstall,
      ),
    ).toBe(1);
    const first = JSON.parse(readFileSync(out, 'utf8')) as {
      instruction: string;
      issues: Array<{ id: string }>;
      heldClaimRefused: { kind: string; files: string[] };
    };
    expect(first.issues.some((i) => i.id === 'ERR40_TESTS_FAILED')).toBe(true);
    expect(first.heldClaimRefused).toEqual({ kind: 'test-in-scope', files: ['src/x.test.ts'] });
    expect(first.instruction).toContain('src/x.test.ts');
    expect(first.instruction).toContain('INSIDE your edit scope');
    expect(first.instruction).toContain('asserts the MERGED behavior');
    expect(first.instruction).toContain('--not-my-bug');
    expect(readJournal(dir).find((e) => e.action === 'held-claim-refused' && e.caseId === caseId)).toMatchObject({
      kind: 'test-in-scope',
      files: ['src/x.test.ts'],
    });
    // Nothing is frozen and the case is still the agent's.
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');

    // SECOND claim: honored unconditionally. An agent shown the reach and still
    // unable to close it is exactly what HELD is for — and the head is a draft,
    // because the gate is red on the tree the pull request carries.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
        neverInvoked,
        red,
        fakeInstall,
      ),
    ).toBe(0);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: checks failing]');
    expect(held.resolution).toMatchObject({ markerClean: true });
    expect(machineState(dir).currentCase?.tier).toBe('held');
    // ONE refusal, ever.
    expect(readJournal(dir).filter((e) => e.action === 'held-claim-refused' && e.caseId === caseId)).toHaveLength(1);
  });

  it('a held claim over a red the MERGE itself produced is answered with the widening, no flag needed', async () => {
    // The same shape `--not-my-bug` adjudicates, asked by the DRIVER: both sides
    // are green alone and only the merged tree is red, so nobody upstream owns
    // it and the fix is inside this case's reach. No agent flag, and no
    // second-failure bar — the claim is being made now, so the question is asked
    // now.
    const repo = twoOwnerFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    const checks = checksFile(ws, { typecheck: ['true'], test: ['true'] });
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    const wtPath = join(dir, caseId, 'worktree');
    const tipSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const parentHead = (JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as { head: { sha: string } })
      .head.sha;
    const fn: ChecksRunner = async (commands, baseDir) => {
      const names = commands.map((c) => c.cmd);
      const at =
        baseDir && baseDir !== wtPath
          ? execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
          : '';
      if (at === tipSha || at === parentHead) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/c.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
        neverInvoked,
        fn,
        fakeInstall,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      widenedPaths: string[];
      issues: Array<{ id: string }>;
    };
    expect(res.status).toBe('scope-widened');
    expect(res.widenedPaths).toEqual(['src/c.ts']);
    expect(res.issues.some((i) => i.id === 'WARN12_SCOPE_WIDENED')).toBe(true);
    expect(readJournal(dir).find((e) => e.action === 'scope-widened' && e.caseId === caseId)!.files).toEqual([
      'src/c.ts',
    ]);
    expect(readJournal(dir).find((e) => e.action === 'held-claim-refused' && e.caseId === caseId)).toMatchObject({
      kind: 'scope-widened',
    });
    // Nothing minted, nothing frozen, nothing aborted: the case comes back to
    // the agent with a wider scope.
    expect(readJournal(dir).some((e) => e.action === 'gate-fix')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
  });

  it('a remainder nobody owns is carried on the FINISH result, not only mid-pass', async () => {
    // The agent assembles its end-of-pass report from the finish result alone,
    // so a failure the pass proved real and minted nothing for has to be IN that
    // object. Held with the red unfixed, `src/c.ts` is exactly that: still red,
    // no case, no owner — and the only place the owner can hear about it.
    const repo = twoOwnerFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    repo.git('push', 'origin', 'module/cg'); // the held PR is based on it
    const { dir, caseId, out, code, fn } = await adjudicateInteractionOnly(repo, ws, inv);
    expect(code).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; widenedPaths: string[] };
    expect(res.status).toBe('scope-widened');
    expect(res.widenedPaths).toEqual(['src/c.ts']);
    expect(readJournal(dir).some((e) => e.action === 'gate-fix')).toBe(false);

    // The agent gives up on the widened file and hands the case over as HELD.
    // The widening already showed it the reach, so the claim is honoured at
    // once and not refused a second time; src/c.ts is red when the pass ends.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }),
        confirm,
        fn,
        fakeInstall,
      ),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'held-claim-refused' && e.caseId === caseId)).toBe(false);
    writePr(dir, caseId, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const fin = join(ws, 'finish.json');
    await cmdSweepFinish(
      baseCli(repo, ws, inv, {
        cmd: 'sweep-finish',
        execute: true,
        tokenFile,
        out: fin,
      }),
      fakeGithub().factory,
    );
    const f = JSON.parse(readFileSync(fin, 'utf8')) as {
      uncoveredRemainders: Array<{
        files: string[];
        caseId: string;
        branch: string;
        parent: string;
        reason: string;
        detail: string;
      }>;
      instruction: string;
    };
    expect(f.uncoveredRemainders).toEqual([
      {
        files: ['src/c.ts'],
        caseId,
        branch: 'module/cg',
        parent: 'main_patched',
        reason: 'interaction',
        detail: expect.any(String),
      },
    ]);
    // The adjudication's own words travel with it, per side, so the agent never
    // has to reconstruct why the file is red from memory.
    expect(f.uncoveredRemainders[0].detail).toContain('nobody upstream owns this');
    expect(f.uncoveredRemainders[0].detail).toContain('probed green twice at the branch tip');
    expect(f.uncoveredRemainders[0].detail).toContain('probed green twice at the parent head');
    // The agent relays the instruction, so the remainder has to be IN it.
    expect(f.instruction).toContain('STILL RED, NO CASE');
    expect(f.instruction).toContain('src/c.ts');
  });

  it('a remainder the pass went on to COVER is not reported as uncovered', async () => {
    // Scope-widened and then fixed: `src/c.ts` is green in the tree that landed.
    // Reporting it anyway would send the owner after a failure that no longer
    // exists — the same defect in the other direction.
    const repo = twoOwnerFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    repo.git('push', 'origin', 'module/cg'); // the judged record PR is based on it
    const { dir, caseId, fn, fixed } = await adjudicateInteractionOnly(repo, ws, inv);
    expect(readJournal(dir).some((e) => e.action === 'scope-widened')).toBe(true);

    fixed();
    resolveWorktree(dir, caseId, { 'src/c.ts': 'FIXED\n' });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
        confirm,
        fn,
        fakeInstall,
      ),
    ).toBe(0);
    writePr(dir, caseId, 'fix: merge interaction', 'Resolution of src/x.ts; the merge itself broke src/c.ts, fixed here.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(true);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const fin = join(ws, 'finish.json');
    await cmdSweepFinish(
      baseCli(repo, ws, inv, {
        cmd: 'sweep-finish',
        execute: true,
        tokenFile,
        out: fin,
      }),
      fakeGithub().factory,
    );
    const f = JSON.parse(readFileSync(fin, 'utf8')) as {
      uncoveredRemainders: unknown[];
      instruction: string;
    };
    expect(f.uncoveredRemainders).toEqual([]);
    expect(f.instruction).not.toContain('STILL RED, NO CASE');
  });

  it('REFUSED -> the gate names which failures are the agent’s own', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

  /**
   * THE PROBE COMPARES TREES, NOT ENVIRONMENTS.
   *
   * Every COMMIT target the probe measures is installed into first. Taking the
   * case worktree as it stands puts a dependency-full baseline against a
   * dependency-less case tree, and every environment red in the case tree then
   * reads as "caused by the case" — a whole suite blamed on a resolution that
   * touched three files.
   */
  it('the probe measures the case worktree with dependencies, like every other target', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    const wtPath = join(dir, caseId, 'worktree');
    const installedIn: string[] = [];
    const install: InstallRunner = async (d) => {
      installedIn.push(d);
      mkdirSync(join(d, 'node_modules'), { recursive: true });
      return { ok: true };
    };
    const checkedIn: string[] = [];
    const fn: ChecksRunner = async (commands, baseDir) => {
      checkedIn.push(baseDir);
      if (baseDir !== wtPath) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['tsc --noEmit'],
        output: '$ tsc --noEmit\nsrc/util.ts(1,1): error TS2345: boom\n',
      };
    };
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true }),
        neverInvoked,
        fn,
        install,
      ),
    ).toBe(1);
    // The probe re-runs the case worktree as its third target. No tree is ever
    // measured without an environment...
    for (const d of checkedIn) expect(installedIn).toContain(d);
    // ...and the case worktree gets one of its own: the gate's, then the probe's.
    expect(installedIn.filter((d) => d === wtPath)).toHaveLength(2);
    expect(checkedIn).toContain(wtPath);
  });

  it('minting a gate fix SUPERSEDES the descendants’ open cases, so only the fix is left to serve', async () => {
    // Open cases ahead of the gate fix, each merging from a branch that carries
    // the red commit, would each fail the
    // same checks, pay a full adjudication, hit the `gateFixKey` anti-loop and
    // fall back to `--tier held` — a queue of junk PRs for one defect.
    //
    // Every blocking path reopens `[branch, ...descendants]`, this one
    // included. Reopening the subtree supersedes their cases,
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

  it('a TIMEOUT gate fix is served as an ORDINARY fix case — no gag in the materials', async () => {
    // There is no `diagnosisOnly` gag for timeouts: a reproducible timeout is
    // usually a deterministic test-isolation bug the checks gate can verify a
    // fix for perfectly well, and a "DO NOT ATTEMPT A FIX" briefing would only
    // guarantee the base stays broken. The termination problem such a gag
    // would cover belongs to the serve bound. Assert the MATERIALS
    // — the thing the agent actually reads — not a flag.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
        reason: 'pre-existing',
      }) + '\n' +
        JSON.stringify({
          ts: new Date().toISOString(), action: 'case', caseId, branch: 'main_patched', parent: '(gate-fix)',
          gateFix: true, head: { sha: tip, height: 1 }, conflictedPaths: ['src/x.test.ts'],
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
    expect(materials).not.toContain('DIAGNOSIS ONLY');
    expect(materials).not.toContain('DO NOT ATTEMPT A FIX');
    expect(materials).toContain('--tier held'); // escalation is still offered
    expect(materials).toContain('WHEN TO STOP READING'); // and the bounded look survives
  });

  it('a gate fix the agent cannot fix IN SCOPE becomes a HELD PR carrying the diagnosis', async () => {
    // Owner rule: "reproducible-but-unfixable-in-scope should lead to held
    // PR — there is no other way." The category is real:
    // the failure REPRODUCES (not `flaky`), it is genuinely pre-existing (not the
    // agent's), and no edit inside the NAMED files can fix it — because a gate
    // fix is scoped to where the failure was REPORTED, which is not where the fix
    // belongs (a failing test names the test, not the source).
    //
    // Without this path, `--tier held` on an unchanged tree hits ERR32 and is
    // told to "edit the files or report to the owner" — but reporting is not a
    // driver action, so the case dead-ends and the agent burns attempts until
    // it is reaped.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // The failure REPRODUCES on the unchanged tree, which is what makes this a
    // diagnosis rather than an expired premise.
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', checksFile: checks, execute: true, out }),
        neverInvoked,
        runner(['vitest run']).fn,
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

  /**
   * A driver-minted gate-fix case as the mint leaves it: the journal rows, the
   * case pointer, the captured failing output and a worktree detached at the
   * root. `materializeGateFixCases` is bypassed so each test can seed exactly
   * the evidence it is about.
   */
  function seedGateFixCase(
    repo: FixtureRepo,
    dir: string,
    opts: { branch?: string; files?: string[]; commands?: string[] } = {},
  ): { caseId: string; tip: string } {
    const branch = opts.branch ?? 'main_patched';
    const files = opts.files ?? ['src/x.test.ts'];
    const commands = opts.commands ?? ['vitest run'];
    const caseId = 'gate-fix-main_patched-deadbeef';
    const tip = repo.sha(branch);
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'gate-fix',
        key: `${branch}::${files.join(',')}`,
        caseId,
        branch,
        files,
        failedCommands: commands,
        rootAt: tip,
        reason: 'pre-existing failure',
      }) +
        '\n' +
        JSON.stringify({
          ts: new Date().toISOString(),
          action: 'case',
          caseId,
          branch,
          parent: '(gate-fix)',
          gateFix: true,
          head: { sha: tip, height: 1 },
          conflictedPaths: files,
        }) +
        '\n',
    );
    mkdirSync(join(dir, caseId), { recursive: true });
    writeFileSync(join(dir, caseId, 'gate-fix-output.txt'), `${files[0]} > times out\n`);
    writeFileSync(
      join(dir, caseId, 'case.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: caseId,
        branch,
        parent: '(gate-fix)',
        head: { sha: tip, height: 1 },
        run: [{ sha: tip, height: 1 }],
        tierFloor: 'judged',
        conflictedPaths: files,
        automergeTree: repo.git('rev-parse', `${branch}^{tree}`),
        reproduction: { command: commands.join(' && ') },
        deferredCheck: { firstConflictHeight: 1, transitiveAncestors: [] },
      }) + '\n',
    );
    repo.git('worktree', 'add', '--detach', join(dir, caseId, 'worktree'), tip);
    return { caseId, tip };
  }

  it('a held gate fix that KEPT an attempted fix is MEASURED before it freezes, and the red travels with it', async () => {
    // The arm that publishes a cannot-fix-in-scope hold sits ~190 lines above
    // the checks gate, so the tree it freezes has been measured by nothing. A
    // gate fix that reimplements code, declares a parameter it never forwards
    // and a binding it never reads passes `tsc` and fails the suite — and the
    // owner is handed it as a reviewed proposal with no verdict attached.
    //
    // The battery runs on the tree the hold is about, the failure is journaled,
    // and it rides the escalation prefix above the agent's prose. The hold is
    // NOT gated on the answer: this is still the escape hatch for a failure
    // nobody can fix inside the named files.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    const { caseId } = seedGateFixCase(repo, dir);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), greenPreMerge);
    expect(currentCaseId(dir)).toBe(caseId);

    // The agent WRITES something into the named file and then concedes.
    writeFileSync(join(dir, caseId, 'worktree', 'src/x.test.ts'), 'an attempted fix\n');
    const out = join(ws, 'rc.json');
    const r = runner(['vitest run']);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', checksFile: checks, execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);
    // MEASURED: both kinds ran, in order, over the worktree.
    expect(r.ran).toEqual([['tsc --noEmit'], ['vitest run']]);
    const journal = readJournal(dir);
    const fail = journal.find((e) => e.action === 'checks-fail' && e.caseId === caseId)!;
    expect(fail.kind).toBe('test');
    expect(fail.failed).toEqual(['vitest run']);
    // HELD ANYWAY, with the attempt kept and the verdict on the escalation.
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held.resolution).not.toBeNull();
    expect(String((held.escalation as { feedback: string }).feedback)).toContain('vitest run');
    expect(machineState(dir).phase).toBe('awaiting-pr');
  });

  it('a held gate fix whose UNCHANGED worktree PASSES concludes with no PR and releases the branch', async () => {
    // The empty-worktree hold publishes a DIAGNOSIS, and a diagnosis of a
    // failure that is not there is an empty commit asking the owner to run the
    // tests themselves. The mint confirmed its red somewhere else — a ceiling
    // ref, an integration tree — and the branch moved past it, so nothing on
    // these bytes was ever measured red.
    //
    // The case CONCLUDES on a terminal disposition (no PR, and `finish` does not
    // wedge on ERR34) and the branch is released: an open gate-fix case stops
    // every merge in the pass, and there is no defect to stop them for.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    const { caseId } = seedGateFixCase(repo, dir);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), greenPreMerge);

    const out = join(ws, 'rc.json');
    const r = runner([]); // everything green on the tree the case is rooted at
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', checksFile: checks, execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    const stale = journal.find((e) => e.action === 'gate-fix-stale' && e.caseId === caseId)!;
    expect(stale).toBeTruthy();
    expect(String(stale.detail)).toContain('vitest run');
    // Terminal: it drains from openCases, so `finish` has a legal move.
    expect(openCases(journal).map((c) => c.caseId)).not.toContain(caseId);
    // AND THE BRANCH IS ACTUALLY RELEASED. `openCaseBranches` feeds the recipe
    // (`blockedForRecipe`) and the coverage report; a stale case left in it cuts
    // the branch and everything above it from the finish build while its merges
    // go on running — released and excluded at once.
    expect([...openCaseBranches(journal)]).not.toContain('main_patched');
    expect(machineState(dir).phase).toBe('open');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(res.instruction).toContain('CONCLUDED');
  });

  it('a stale-concluded gate fix is reported as CONCLUDED, never as held', async () => {
    // The owner summary is the one artifact this case produces, and every other
    // terminal disposition in it stands for a pull request somebody is about to
    // read. Reporting a stale premise as held sends them looking for a PR that
    // was never opened — and its reason lives on `detail`, not `notes`, so the
    // held bucket renders it blank as well.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    const { caseId } = seedGateFixCase(repo, dir);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), greenPreMerge);
    const r = runner([]);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, {
          cmd: 'report-case',
          tier: 'held',
          checksFile: checks,
          execute: true,
          out: join(ws, 'rc.json'),
        }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);

    const out = join(ws, 'report.json');
    expect(await cmdReport(baseCli(repo, ws, inv, { cmd: 'report', out }))).toBe(0);
    const summary = JSON.parse(readFileSync(out, 'utf8')) as {
      held: Array<{ caseId: string }>;
      concluded: Array<{ caseId: string; reason: string }>;
      openCases: Array<{ caseId: string }>;
    };
    expect(summary.held.map((h) => h.caseId)).not.toContain(caseId);
    expect(summary.openCases.map((o) => o.caseId)).not.toContain(caseId);
    const row = summary.concluded.find((c) => c.caseId === caseId)!;
    expect(row).toBeTruthy();
    expect(row.reason).toContain('vitest run');
  });

  it('a DRY-RUN held gate fix measures nothing, freezes nothing and concludes nothing', async () => {
    // This arm now pays an install and the whole battery, and on the stale
    // reading it takes a TERMINAL disposition and releases the branch. A preview
    // that did any of that would not be a preview — the same guard the
    // held-duplicate arm above it has carried all along.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    const { caseId } = seedGateFixCase(repo, dir);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), greenPreMerge);
    const before = readJournal(dir).length;

    const out = join(ws, 'rc.json');
    const r = runner([]);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', checksFile: checks, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { dryRun?: boolean };
    expect(res.dryRun).toBe(true);
    // Nothing ran and nothing was written: no battery, no freeze, no disposition.
    expect(r.ran).toEqual([]);
    const journal = readJournal(dir);
    expect(journal.length).toBe(before);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(journal.some((e) => e.action === 'gate-fix-stale')).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toContain(caseId);
  });

  it('a green on the bytes a CONFIRMED red was measured on is held as an instability, never closed', async () => {
    // The other reading of the same green, and the opposite disposition. The
    // mint confirmed THIS subtree red; the gate measures it green with nothing
    // changed between. That is a check answering both ways over one oid, and
    // closing the case on the green files a contradiction as a fix — an
    // order-dependent failure a run in another environment masks looks exactly
    // like this and comes back.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }));
    const { caseId, tip } = seedGateFixCase(repo, dir);
    // The confirmation the mint rested on, taken on THESE bytes.
    appendJournal(dir, {
      action: 'red-confirm',
      branch: 'main_patched',
      cmd: 'vitest run',
      subtree: repo.git('rev-parse', `${tip}^{tree}`),
      reproduced: true,
    });
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile: checks }), greenPreMerge);

    const out = join(ws, 'rc.json');
    const r = runner([]);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', checksFile: checks, execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'gate-fix-stale')).toBe(false);
    expect(journal.find((e) => e.action === 'checks-nondeterministic' && e.caseId === caseId)?.id).toBe(
      'WARN21_CHECKS_FLAKY',
    );
    // It reaches the owner through the pass's OWN contested-check machinery, so
    // the PR machine block and the finish report both carry it.
    expect(unstableEvidence(journal).map((c) => c.cmd)).toContain('vitest run');
    // AND THE CONTESTED KEY NEVER ENTERS THE GREEN MEMO. `greenChecks` is read
    // by the landing gate and the pre-merge branch check as "already measured,
    // do not run" — a sibling carrying this identical subtree would be stamped
    // green and merge without any run, filing the contradiction as settled.
    expect(greenChecks(journal).has(checkKey(repo.git('rev-parse', `${tip}^{tree}`), 'vitest run'))).toBe(false);
    // Held, not closed: the case still goes to the owner with the finding.
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(machineState(dir).phase).toBe('awaiting-pr');
  });

  it('a PARENT-owned gate fix supersedes the PARENT’s other children too', async () => {
    // When ownership routes to a PARENT branch, the fix is minted there;
    // reopening only the CASE branch's subtree would leave the parent's OTHER
    // children with their cases, sorted ahead of the fix,
    // and served first. The same junk-PR queue this reopen prevents, one
    // level up: everything under a blocked branch is blocked, wherever the case
    // that found it happened to live.
    const repo = conflictFixture();
    repo.checkout('module/parent', { create: true, at: 'main_patched' });
    repo.commit('parent work', { 'src/p.ts': 'p\n' });
    repo.checkout('module/childA', { create: true, at: 'module/parent' });
    repo.commit('a', { 'src/a.ts': 'a\n' });
    repo.checkout('module/childB', { create: true, at: 'module/parent' });
    repo.commit('b', { 'src/b.ts': 'b\n' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'parent', branch: 'module/parent', parents: ['main_patched'] },
      { id: 'childA', branch: 'module/childA', parents: ['module/parent'] },
      { id: 'childB', branch: 'module/childB', parents: ['module/parent'] },
    ]);
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedPriorFailure(dir, caseId, 'typecheck', ['tsc --noEmit']);
    // childB has its own open case, derived against the parent.
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(), action: 'case', caseId: 'module__childB--module__parent-h1',
        branch: 'module/childB', parent: 'module/parent',
        head: { sha: repo.sha('module/childB'), height: 1 }, conflictedPaths: ['src/b.ts'],
      }) + '\n',
    );
    expect(openCases(readJournal(dir)).map((c) => c.caseId)).toContain('module__childB--module__parent-h1');

    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out: join(ws, 'rc.json') }),
      neverInvoked,
      r.fn,
    );
    const journal = readJournal(dir);
    const gf = journal.find((e) => e.action === 'gate-fix');
    if (gf && gf.branch !== 'main_patched') {
      // Whatever branch owned it, that branch's whole subtree must be reopened —
      // no sibling case may survive ahead of the fix.
      const reopened = new Set(journal.filter((e) => e.action === 'reopened').map((e) => e.branch as string));
      expect(reopened.has(gf.branch as string)).toBe(true);
    }
    // The invariant that matters regardless of which branch was blamed: no
    // ordinary case sits ahead of an open gate fix.
    const open = openCases(journal);
    const gateFixIds = new Set(journal.filter((e) => e.action === 'case' && e.gateFix === true).map((e) => e.caseId as string));
    if (open.some((c) => gateFixIds.has(c.caseId))) {
      expect(gateFixIds.has(open[0].caseId)).toBe(true);
    }
  });

  it('refuses to mint a gate fix on UPSTREAM main, and reports it instead', async () => {
    // An ownership probe of upstream's head can come back red (e.g. run with
    // the wrong dependencies for a module upstream actually declares) and a
    // bisect can then converge on upstream `main` itself. A fix committed to
    // upstream could not be pushed
    // anywhere the fork controls — such a case is unusable by construction.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  // ---- the DEAD END: evidence, not a gate ---------------------------------
  //
  // Three distinct trees that fail identically say the agent's edits are not
  // reaching the cause. The driver can prove that and nothing more, so it says
  // exactly that and leaves every decision where it was.

  /** A prior failure carrying the fields the dead-end comparison reads. */
  function seedFingerprintedFailure(dir: string, caseId: string, tree: string, fingerprints: string[]): void {
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'checks-fail',
        caseId,
        kind: 'typecheck',
        failed: ['tsc --noEmit'],
        resolvedTree: tree,
        fingerprints,
      }) + '\n',
    );
  }
  /** What `namingRunner(_, 'src/util.ts')`'s output fingerprints to. */
  const UTIL_FP = ['ts src/util.ts TS2345 boom'];

  it('3 DISTINCT trees failing identically -> the evidence is stated, and NOTHING about the disposition changes', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedFingerprintedFailure(dir, caseId, 'seed-tree-1', UTIL_FP);
    seedFingerprintedFailure(dir, caseId, 'seed-tree-2', UTIL_FP);
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    // The same exit code as any other checks failure — one more sentence on the
    // ordinary payload, not a new outcome.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      instruction: string;
      tier: string;
      issues: Array<{ id: string; detail: string }>;
    };
    expect(res.instruction).toContain(`Your last ${DEAD_END_ATTEMPTS} resolutions were different trees but`);
    expect(res.instruction).toContain('src/util.ts still reports the same TS2345');
    expect(res.instruction).toContain('the cause is somewhere you have not looked');
    // The same sentence on the issue detail, which is what the owner reads.
    expect(res.issues.find((i) => i.id === 'ERR36_TYPECHECK_FAILED')!.detail).toContain('Nothing you changed affected it');
    // INFORMATION ONLY: the tier is still the agent's claim, the id is the
    // ordinary one, the phase is unmoved and nothing was frozen.
    expect(res.tier).toBe('mechanical');
    expect(machineState(dir).phase).toBe('case-ready');
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    // The rope is the same length: this is attempt 3 of 10.
    expect(CHECKS_FAIL_LIMIT).toBe(10);
    expect(journal.filter((e) => e.action === 'checks-fail' && e.caseId === caseId)).toHaveLength(DEAD_END_ATTEMPTS);
    // A reader of the journal can see the driver knew.
    const stuck = journal.find((e) => e.action === 'checks-dead-end' && e.caseId === caseId)!;
    expect(stuck).toBeTruthy();
    expect(stuck.fingerprints).toEqual(UTIL_FP);
    expect(stuck.trees).toHaveLength(DEAD_END_ATTEMPTS);
  });

  it('the SAME tree re-reported is not evidence — an agent that has not edited has proved nothing', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedFingerprintedFailure(dir, caseId, 'same-tree', UTIL_FP);
    seedFingerprintedFailure(dir, caseId, 'same-tree', UTIL_FP);
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
      neverInvoked,
      r.fn,
    );
    expect((JSON.parse(readFileSync(out, 'utf8')) as { instruction: string }).instruction).not.toContain('different trees');
    expect(readJournal(dir).some((e) => e.action === 'checks-dead-end')).toBe(false);
  });

  it('a failure that MOVED is not evidence — different fingerprints mean the edits are reaching it', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedFingerprintedFailure(dir, caseId, 'seed-tree-1', ['ts src/util.ts TS2322 something else']);
    seedFingerprintedFailure(dir, caseId, 'seed-tree-2', UTIL_FP);
    const r = namingRunner(['tsc --noEmit'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
      neverInvoked,
      r.fn,
    );
    expect((JSON.parse(readFileSync(out, 'utf8')) as { instruction: string }).instruction).not.toContain('different trees');
    expect(readJournal(dir).some((e) => e.action === 'checks-dead-end')).toBe(false);
  });

  it('an EMPTY fingerprint set is never evidence — "we could not read the output" is not "you are stuck"', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = checksFile(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    // Three distinct trees, and a runner that names nothing in any of them.
    seedFingerprintedFailure(dir, caseId, 'seed-tree-1', []);
    seedFingerprintedFailure(dir, caseId, 'seed-tree-2', []);
    const r = runner(['tsc --noEmit']);
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
      neverInvoked,
      r.fn,
    );
    const journal = readJournal(dir);
    expect(journal.filter((e) => e.action === 'checks-fail' && e.caseId === caseId).pop()!.fingerprints).toEqual([]);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { instruction: string }).instruction).not.toContain('different trees');
    expect(journal.some((e) => e.action === 'checks-dead-end')).toBe(false);
  });

  // ---- NARROW RE-RUNS: cost only, and never a pass -------------------------

  /** A checks file whose test command can be narrowed to a file list. */
  function filterableChecks(ws: string): string {
    const f = join(ws, 'checks-filter.json');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }],
        test: [{ cmd: 'vitest run', cwd: '.', filter: 'vitest run {files}' }],
      }),
    );
    return f;
  }
  /** Seed the previous attempt's failing FILES — what a re-run may narrow to. */
  function seedFailingFiles(dir: string, caseId: string, files: string[]): void {
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'checks-fail',
        caseId,
        kind: 'test',
        failed: ['vitest run'],
        resolvedTree: 'seed-tree-1',
        files,
        fingerprints: [],
      }) + '\n',
    );
  }

  it('a GREEN narrow run does not end the gate: the FULL list runs before any pass verdict', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = filterableChecks(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedFailingFiles(dir, caseId, ['src/x.test.ts']);
    const r = runner([]);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
        r.fn,
      ),
    ).toBe(0);
    // typecheck (no filter, nothing to narrow), then the narrowed test run, then
    // the FULL list, and only then the flake confirmation of the green.
    expect(r.ran).toEqual([['tsc --noEmit'], ["vitest run 'src/x.test.ts'"], ['vitest run'], ['vitest run']]);
    const narrowAt = r.ran.findIndex((l) => l[0].includes('src/x.test.ts'));
    expect(r.ran.findIndex((l, i) => i > narrowAt && l[0] === 'vitest run')).toBeGreaterThan(narrowAt);
    // The pass could only have come after the full run.
    expect(readJournal(dir).some((e) => e.action === 'checks-pass' && e.caseId === caseId)).toBe(true);
  });

  it('a RED narrow run is the whole answer: no full suite, and it reports the CONFIGURED command', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = filterableChecks(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedFailingFiles(dir, caseId, ['src/x.test.ts']);
    const r = runner(["vitest run 'src/x.test.ts'"]);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(1);
    // The full suite was never paid for — the narrow red already proves the red.
    expect(r.ran).toEqual([['tsc --noEmit'], ["vitest run 'src/x.test.ts'"]]);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string; detail: string }> };
    const err = res.issues.find((i) => i.id === 'ERR40_TESTS_FAILED')!;
    // `vitest run` is what failed; which files were re-run was a cost decision,
    // and every consumer downstream matches the configured spelling.
    expect(err.detail).toContain('test failed: vitest run (see');
    expect(err.detail).not.toContain("vitest run 'src/x.test.ts'");
    const row = readJournal(dir).filter((e) => e.action === 'checks-fail' && e.caseId === caseId).pop()!;
    expect(row.failed).toEqual(['vitest run']);
    expect(row.narrowedTo).toEqual(['src/x.test.ts']);
    expect(row.narrowRed).toBe(true);
  });

  it('`--not-my-bug` turns narrowing OFF — that comparison is only valid between whole populations', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = filterableChecks(ws);
    const { dir, caseId } = await toResolvedCase(repo, ws, inv, checks);
    seedFailingFiles(dir, caseId, ['src/util.ts']);
    const r = namingRunner(['vitest run'], 'src/util.ts');
    const out = join(ws, 'rc.json');
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out }),
      neverInvoked,
      r.fn,
      fakeInstall,
    );
    // The gate's own run is the FULL list, even though a prior attempt named
    // files it could have narrowed to. The adjudication's probes narrow on BOTH
    // sides of their own comparison; this side may not.
    expect(r.ran[0]).toEqual(['tsc --noEmit']);
    expect(r.ran[1]).toEqual(['vitest run']);
  });

  it('with no previous failure there is nothing to narrow to — the first attempt runs whole', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const checks = filterableChecks(ws);
    const { dir } = await toResolvedCase(repo, ws, inv, checks);
    expect(dir).toBeTruthy();
    const r = runner(['vitest run']);
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        neverInvoked,
        r.fn,
      ),
    ).toBe(1);
    expect(r.ran).toEqual([['tsc --noEmit'], ['vitest run']]);
  });
});

describe('sweep report-pr (SWEEP-STATE-MACHINE.md §2)', () => {
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

  it('held: single cold read over code+desc -> records intent, PUBLISHES NOTHING; finish creates the draft PR post-verify', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // the green verify (all PRs at finish, post-verify).
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  it('report-pr runs NO cold read — the invoker is never called; the PR text is recorded as-is', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

  it('the H1 first line of pr/body.md IS the title (no title.txt); a body with no H1 is ERR08', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm);
    const prDir = join(dir, caseId, 'pr');
    mkdirSync(prDir, { recursive: true });
    const out = join(ws, 'pr.json');
    // No H1, no title.txt -> the driver never invents PR prose.
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

describe('sweep finish (SWEEP-STATE-MACHINE.md §2) — multi-step, resumable', () => {
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
    const inv = branchlessInventory();
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

  it('RED TESTS at finish stop the pass — nothing LANDS, but held escalations still publish; a re-run with a green gate completes', async () => {
    const repo = cleanFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // NOTHING LANDS — that is what the red gate guarantees, and it still holds.
    expect(readJournal(dir).some((e) => e.action === 'finish-tests-failed')).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'push')).toBe(false);
    // ...but the ESCALATIONS are published. A held PR is a REVIEW
    // ref the owner merges; it never touches a target branch, and the red is
    // very often the thing it is ABOUT: a gate fix whose real fix lives
    // outside the case's named files is correctly claimed `--tier held`, so it
    // is not merged and verify stays red — suppressing the
    // publish would keep the PR carrying the fix off GitHub while the
    // sweep reports "nothing published" holding the answer.
    expect(f1.instruction).toContain('NOTHING was merged or pushed');
    expect(f1.instruction).toContain('held review PR');
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

  it('a failed target push (ERR15 per-branch) -> finish reports PARTIAL (no hard halt); re-running after the fix completes without re-pushing', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
      'PATCH /pulls/12': { status: 200, body: { html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12 } },
    });
    const out = join(ws, 'finish.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: passCmds(ws), out }),
        gh.factory,
      ),
    ).toBe(0); // NO halt — the existing PR is adopted and the loop continues
    const res = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; status: string };
    expect(res.ok).toBe(true);
    expect(res.status).toBe('complete');
    expect(machineState(dir).phase).toBe('complete');
    // The published row has its normal shape, pointing at the PR that exists.
    const pub = readJournal(dir).find((e) => e.action === 'pr-published' && e.caseId === caseId)!;
    expect(pub.number).toBe(12);
    expect(pub.url).toBe('https://github.com/k-fls/fixture/pull/12');
    expect(pub.mode).toBe('held');
    expect(pub.branch).toBe('main_patched');
    expect(typeof pub.fixBranch).toBe('string');
    expect(typeof pub.head).toBe('string');
    // Adopted, not created — and the driver says which PR it adopted.
    expect(readJournal(dir).find((e) => e.action === 'pr-adopted')!.number).toBe(12);
    // NO duplicate PR…
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(false);
    // …and the PR now carries this pass's head and prose, because a PR the
    // driver did not journal is still this case's PR (D-070 rule 3).
    expect(gh.calls.some((c) => c.method === 'PATCH' && c.path.includes('/pulls/12'))).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'push' && e.kind === 'pr-head')).toBe(true);
  });

  it('a blocked trunk makes the build VACUOUS: the prefix merge still lands, and the result says what was covered', async () => {
    // Everything in the pass sits at or under the cut, so there is nothing the
    // integration build can judge — a valid pass, not a degraded one. What
    // makes it valid is the report: `coverage` names the branch it left out and
    // why, `pushedUnbuilt` names the branch that reached origin with no build
    // behind it, and `withheldPushes` is empty because nothing was held back.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const originBefore = repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const caseId = currentCaseId(dir);
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true }), confirm);
    writePr(dir, caseId, 'held x', 'Decision needed: resolution of src/x.ts — study before merge.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // finalize
    expect(repo.sha('main_patched')).not.toBe(originBefore); // the clean prefix merged

    const out = join(ws, 'finish.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: passCmds(ws), out }),
        fakeGithub().factory,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      ok: boolean;
      status: string;
      coverage: { built: string[]; excluded: Array<{ branch: string; reason: string; via?: string }> };
      pushedUnbuilt: string[];
      withheldPushes: Array<{ branch: string; reason: string }>;
      instruction: string;
    };
    expect(res.ok).toBe(true); // a partial build is a valid pass
    expect(res.status).toBe('complete');
    expect(res.coverage.built).toEqual([]);
    expect(res.coverage.excluded).toEqual([{ branch: 'main_patched', reason: 'cut-this-pass' }]);
    expect(res.pushedUnbuilt).toEqual(['main_patched']);
    expect(res.withheldPushes).toEqual([]);
    expect(res.instruction).toContain('PARTIAL BUILD');
    // The verify was vacuous and the merge still landed at its cut point.
    expect(readJournal(dir).some((e) => e.action === 'verify' && e.ok === true && typeof e.note === 'string')).toBe(true);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
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

describe('sweep — crash resume (machine-state drives re-entry, SWEEP-STATE-MACHINE.md §5)', () => {
  it('a re-invoked next-case re-serves the same open case idempotently', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

describe('sweep progress — SWEEP-STEP observability', () => {
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
  // The TWO-PREFIX contract: SWEEP-STEP lines are relayed progress;
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

describe('cold-read infra failure ≠ content reject (ERR35_COLDREAD_UNAVAILABLE)', () => {
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

  it('parseMachineVerdict: the 1-2 line `feedback` field is carried through and BOUNDED', () => {
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  it('report-case JUDGED: infra error -> HARD HALT (ERR35), never awaiting-pr, nothing merged', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

describe('sweep start — origin-derived merge_status', () => {
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
    const inv = branchlessInventory();
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

  /**
   * A DRIVER-shaped pristine-conflict exhibit on the deterministic fix ref: one
   * commit whose tree is the automerge, parented on the branch tip and on the
   * conflict head, under the driver's pinned identity.
   */
  function pushDriverExhibit(repo: FixtureRepo): { fixBranch: string; fixHead: string } {
    const u1 = repo.sha('main');
    const mpTip = repo.sha('main_patched');
    // merge-tree exits 1 on conflict and still prints the automerge tree oid.
    let out = '';
    try {
      out = execFileSync('git', ['-C', repo.dir, 'merge-tree', '--write-tree', mpTip, u1], { encoding: 'utf8' });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    const merged = out.split('\n')[0].trim();
    const fixHead = execFileSync(
      'git',
      ['-C', repo.dir, 'commit-tree', merged, '-p', mpTip, '-p', u1, '-m', 'Pristine conflict for a case'],
      { encoding: 'utf8', env: { ...process.env, ...DRIVER_COMMIT_ENV } },
    ).trim();
    const fixBranch = `fix/sweep/main_patched--main-h1-${u1.slice(0, 8)}`;
    repo.git('push', 'origin', `${fixHead}:refs/heads/${fixBranch}`);
    return { fixBranch, fixHead };
  }

  const openPr = {
    status: 200,
    body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
  };

  it('a DRIVER exhibit whose conflict HEALED has its ref deleted and stops blocking', async () => {
    // The PR poses a question. Once the question is gone, so is the PR: the ref
    // is deleted, GitHub closes it and keeps the commits, and the branch derives
    // fresh instead of waiting on an answer nobody needs.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch } = pushDriverExhibit(repo);
    // The owner resolved it by hand on the branch: main_patched now CONTAINS
    // the conflicting trunk head, so the merge probe is clean.
    repo.checkout('main_patched');
    repo.git('merge', '--no-ff', '--no-edit', '-X', 'ours', '-m', 'owner resolves U1 by hand', repo.sha('main'));
    repo.git('push', 'origin', 'main_patched');
    repo.checkout('main');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    const dropped = journal.find((e) => e.action === 'proposal-dropped')!;
    expect(dropped.ref).toBe(fixBranch);
    expect(dropped.reason).toContain('healed');
    expect(journal.some((e) => e.action === 'origin-blocked')).toBe(false); // no longer blocked
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
  });

  it('a marker-shaped line in an UNCONFLICTED file is not part of the conflict, however it changes', async () => {
    // The conflicted paths come from git. A file that merely CONTAINS a line of
    // seven angle brackets is not a conflict, and editing it for unrelated
    // reasons must not turn "the same question" into "a different question" —
    // which force-pushes a rebuilt exhibit and comments on a PR whose conflict
    // never moved.
    const repo = initFixtureRepo();
    repo.commit('base: x + a file that talks about markers', {
      'src/x.ts': 'orig\n',
      'docs/markers.md': 'how a conflict looks:\n<<<<<<< ours\nalpha\n',
    });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushDriverExhibit(repo);
    // The branch moves for a reason that has nothing to do with the conflict —
    // it edits the marker-shaped text.
    repo.checkout('main_patched');
    repo.commit('mp: reword the marker example', {
      'docs/markers.md': 'how a conflict looks:\n<<<<<<< ours\nbeta\n',
    });
    repo.git('push', 'origin', 'main_patched');
    repo.checkout('main');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    // The same conflict against a moved base: rebased, body kept, nothing said.
    const rebased = journal.find((e) => e.action === 'proposal-rebased')!;
    expect(rebased.reason).toContain('same');
    expect(journal.some((e) => e.action === 'proposal-rebuilt')).toBe(false);
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.includes('/comments'))).toBe(false);
  });

  /**
   * A DRIVER-shaped ANSWER on the fix ref: a resolution tree with no markers,
   * so its disposition turns on whether it still merges and still passes.
   */
  function pushDriverAnswer(repo: FixtureRepo): { fixBranch: string; fixHead: string } {
    const u1 = repo.sha('main');
    const mpTip = repo.sha('main_patched');
    repo.checkout('tmp-answer', { create: true, at: 'main_patched' });
    repo.commit('tmp: resolution content', { 'src/x.ts': 'RESOLVED\n' });
    const tree = repo.git('rev-parse', 'tmp-answer^{tree}');
    repo.checkout('main');
    repo.git('branch', '-D', 'tmp-answer');
    const fixHead = execFileSync(
      'git',
      ['-C', repo.dir, 'commit-tree', tree, '-p', mpTip, '-p', u1, '-m', 'Resolution for owner review'],
      { encoding: 'utf8', env: { ...process.env, ...DRIVER_COMMIT_ENV } },
    ).trim();
    const fixBranch = `fix/sweep/main_patched--main-h1-${u1.slice(0, 8)}`;
    repo.git('push', 'origin', `${fixHead}:refs/heads/${fixBranch}`);
    return { fixBranch, fixHead };
  }
  /** A checks-file with one typecheck command the fake runners key off. */
  function answerChecks(ws: string): string {
    const f = join(ws, 'answer-checks.json');
    writeFileSync(f, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));
    return f;
  }

  it('a driver ANSWER whose checks are RED has its ref deleted — the case derives fresh', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushDriverAnswer(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const runs: string[][] = [];
    const alwaysRed: ChecksRunner = async (commands) => {
      runs.push(commands.map((c) => c.cmd));
      return { ok: false, failedNames: commands.map((c) => c.cmd), output: 'boom\n' };
    };
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: answerChecks(ws) }), gh.factory, alwaysRed),
    ).toBe(0);
    // Red twice on the same tree IS a red: the probe confirms it and the delete
    // goes ahead.
    expect(runs.length).toBe(2);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.find((e) => e.action === 'proposal-dropped')!.reason).toContain('does not pass');
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
  });

  /**
   * A DRIVER-shaped DIAGNOSIS on a gate-fix ref: one empty commit on the branch
   * tip, no markers and no merge, whose whole content is the PR body. It is an
   * ANSWER by shape and it is RED by construction — the failure it reports is
   * the one nobody could fix inside the case's named files.
   */
  function pushDriverDiagnosis(repo: FixtureRepo): { fixBranch: string; fixHead: string } {
    const mpTip = repo.sha('main_patched');
    const tree = repo.git('rev-parse', 'main_patched^{tree}');
    const fixHead = execFileSync(
      'git',
      ['-C', repo.dir, 'commit-tree', tree, '-p', mpTip, '-m', 'Decision needed: where the fix belongs'],
      { encoding: 'utf8', env: { ...process.env, ...DRIVER_COMMIT_ENV } },
    ).trim();
    const fixBranch = 'fix/sweep/main_patched--gate-fix-main_patched-deadbeef';
    repo.git('push', 'origin', `${fixHead}:refs/heads/${fixBranch}`);
    return { fixBranch, fixHead };
  }
  /** An open PR on that ref whose machine block records the failures named. */
  /**
   * A diagnosis PR as `publish` actually writes one: the agent's prose, then the
   * failures INSIDE the delimited machine block. `inProse` puts them above it
   * instead — the forged shape, which is prose and decides nothing.
   */
  function diagnosisPr(
    failures: Array<{ cmd: string; cwd?: string }>,
    opts: { inProse?: boolean } = {},
  ): { status: number; body: unknown } {
    const lines = failures.map((f) =>
      renderSweepFailure({ cmd: f.cmd, cwd: f.cwd ?? '.', subtree: 'a'.repeat(40), filesDigest: 'b'.repeat(8) }),
    );
    return {
      status: 200,
      body: [
        {
          html_url: 'https://github.com/k-fls/fixture/pull/12',
          number: 12,
          state: 'open',
          body: [
            'The check below fails and the fix does not belong in the files it names.',
            '',
            ...(opts.inProse ? lines : []),
            MACHINE_BLOCK_BEGIN,
            ...(opts.inProse ? [] : lines),
            MACHINE_BLOCK_END,
          ].join('\n'),
        },
      ],
    };
  }

  it('a gate-fix DIAGNOSIS is HELD on the red it was opened to document, never deleted', async () => {
    // The pull request IS the report of a failure nobody could fix in scope, so
    // its checks are red for as long as the defect stands. Deleting it for that
    // closes the review thread and buys the owner a new PR number for the same
    // finding every pass — the case derives again, the agent reaches the same
    // conclusion, and a second diagnosis is published.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushDriverDiagnosis(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const alwaysRed: ChecksRunner = async (commands) => ({
      ok: false,
      failedNames: commands.map((c) => c.cmd),
      output: 'boom\n',
    });
    const gh = fakeGithub({ 'GET /pulls?': diagnosisPr([{ cmd: 'tsc --noEmit' }]) });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: answerChecks(ws) }), gh.factory, alwaysRed),
    ).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.some((e) => e.action === 'proposal-dropped')).toBe(false);
    // The ref stands and the branch stays blocked on its open proposal.
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(true);
  });

  it('a diagnosis failing a check its own body does NOT record is deleted like any stale answer', async () => {
    // The exemption is bounded by what the pull request says it is about. A head
    // that documents one failure and now fails a different one is answering a
    // question nobody asked, which is the ordinary stale-answer row.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushDriverDiagnosis(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const alwaysRed: ChecksRunner = async (commands) => ({
      ok: false,
      failedNames: commands.map((c) => c.cmd),
      output: 'boom\n',
    });
    // The body records a check in another directory; the red is at the root.
    const gh = fakeGithub({ 'GET /pulls?': diagnosisPr([{ cmd: 'tsc --noEmit', cwd: 'container/agent-runner' }]) });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: answerChecks(ws) }), gh.factory, alwaysRed),
    ).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.find((e) => e.action === 'proposal-dropped')!.reason).toContain('does not pass');
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
  });

  it('a diagnosis whose failure line is only in the PROSE is deleted — the block decides', async () => {
    // The exemption is read from inside the delimited block, comment form only.
    // The general body reader accepts a bare `sweep-…:` line so a body a human
    // tidied still DISPLAYS — which is exactly why a disposition may not be read
    // through it: the agent writes the prose above the block, and a PR that
    // could never be deleted for red is a PR that writes its own verdict.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushDriverDiagnosis(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const alwaysRed: ChecksRunner = async (commands) => ({
      ok: false,
      failedNames: commands.map((c) => c.cmd),
      output: 'boom\n',
    });
    // The SAME failure the held test records — above the block, not in it.
    const gh = fakeGithub({ 'GET /pulls?': diagnosisPr([{ cmd: 'tsc --noEmit' }], { inProse: true }) });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: answerChecks(ws) }), gh.factory, alwaysRed),
    ).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.find((e) => e.action === 'proposal-dropped')!.reason).toContain('does not pass');
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
  });

  it('the merged-tree probe runs the TESTS too, not the typecheck alone', async () => {
    // "Checks green" is the driver's OWN gate — the one `report-case` runs — and
    // that gate is typecheck THEN test. A probe that measured half of it calls a
    // tree green that the driver's own gate refuses, and then acts on the word:
    // an owner's PR left alone as passing, a driver answer landed on approval.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushDriverAnswer(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const checks = join(ws, 'both-checks.json');
    writeFileSync(
      checks,
      JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [{ cmd: 'vitest run', cwd: '.' }] }),
    );
    const ran: string[][] = [];
    const testsRed: ChecksRunner = async (commands) => {
      const names = commands.map((c) => c.cmd);
      ran.push(names);
      const failedNames = names.filter((n) => n === 'vitest run');
      return { ok: failedNames.length === 0, failedNames, output: failedNames.length ? 'boom\n' : '' };
    };
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: checks }), gh.factory, testsRed),
    ).toBe(0);
    // Typecheck first (green, so the walk continues), then the tests, then the
    // determinism re-run of the one that failed.
    expect(ran).toEqual([['tsc --noEmit'], ['vitest run'], ['vitest run']]);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.find((e) => e.action === 'proposal-dropped')!.reason).toContain('does not pass');
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
  });

  it('a FLAKY red never deletes: red then green on the same tree is non-determinism, reported and left alone', async () => {
    // Deleting is the one row the next pass cannot walk back — it closes the
    // review thread and discards the resolution. Under a flaky check the driver
    // would delete and re-create the same PR on alternating passes, with a new
    // number each time.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushDriverAnswer(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    let call = 0;
    const flaky: ChecksRunner = async (commands) => {
      call += 1;
      const failedNames = call === 1 ? commands.map((c) => c.cmd) : [];
      return { ok: failedNames.length === 0, failedNames, output: failedNames.length ? 'boom\n' : '' };
    };
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: answerChecks(ws) }), gh.factory, flaky),
    ).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.some((e) => e.action === 'proposal-dropped')).toBe(false);
    const undecided = journal.find((e) => e.action === 'proposal-check-undecided')!;
    expect(undecided.id).toBe('WARN17_VERIFY_FLAKY');
    expect(undecided.prNumber).toBe(12);
    expect(undecided.detail as string).toContain('PASSED on a re-run');
    // The ref is untouched and the branch stays blocked on its open proposal.
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(true);
  });

  it('a SPAWN fault never deletes: a check that could not run is an environment fault, not a red', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushDriverAnswer(repo);
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    // What `defaultChecksRunner` books when spawnSync returns status null.
    const spawnFault: ChecksRunner = async (commands) => ({
      ok: false,
      failedNames: commands.map((c) => c.cmd),
      output: '',
      environmentFault: { cmd: commands[0].cmd, detail: `'${commands[0].cmd}' did not run: spawn ENOENT` },
    });
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(
      await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile, checksFile: answerChecks(ws) }), gh.factory, spawnFault),
    ).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    expect(journal.some((e) => e.action === 'proposal-dropped')).toBe(false);
    expect(journal.find((e) => e.action === 'proposal-check-undecided')!.id).toBe('WARN14_ENVIRONMENT_FAULT');
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(fixHead);
  });

  it('a dropped proposal is NAMED in the finish result — a closed PR is never silent', async () => {
    // The drop closes somebody's pull request and takes the resolution on it
    // with it, and the next `start` wipes the journal that recorded it. If the
    // result does not carry it, nothing ever does.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    pushDriverExhibit(repo);
    repo.checkout('main_patched');
    repo.git('merge', '--no-ff', '--no-edit', '-X', 'ours', '-m', 'owner resolves U1 by hand', repo.sha('main'));
    repo.git('push', 'origin', 'main_patched');
    repo.checkout('main');
    repo.commit('U2: clean', { 'src/z.ts': 'z\n' }); // the pass has ordinary work to do
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge); // clean merge -> finalize

    const out = join(ws, 'finish.json');
    const cmds = join(ws, 'cmds-true.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    await cmdSweepFinish(
      baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmds, out }),
      gh.factory,
    );
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      droppedProposals: Array<{ branch: string; ref: string; number: number; url: string; reason: string }>;
      instruction: string;
    };
    expect(res.droppedProposals.length).toBe(1);
    expect(res.droppedProposals[0].branch).toBe('main_patched');
    expect(res.droppedProposals[0].number).toBe(12);
    expect(res.droppedProposals[0].url).toBe('https://github.com/k-fls/fixture/pull/12');
    expect(res.droppedProposals[0].reason).toContain('healed');
    expect(res.instruction).toContain('CLOSED 1 pull request');
  });

  it('a rebuild reuses the journaled fix ref — one ref, one PR', async () => {
    // Deriving a new name from a changed conflict would mint a second ref and a
    // second pull request for one case.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch, fixHead } = pushDriverExhibit(repo);
    // The branch moves and its own side of the conflict changes, so the exhibit
    // now poses a different question.
    repo.checkout('main_patched');
    repo.commit('mp: x = fork-revised', { 'src/x.ts': 'fork-revised\n' });
    repo.git('push', 'origin', 'main_patched');
    repo.checkout('main');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({ 'GET /pulls?': openPr });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    const rebuilt = journal.find((e) => e.action === 'proposal-rebuilt' || e.action === 'proposal-rebased')!;
    expect(rebuilt.ref).toBe(fixBranch);
    expect(rebuilt.from).toBe(fixHead);
    // ONE ref on origin, under the journaled name, moved in place.
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe(
      `refs/heads/${fixBranch}`,
    );
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(rebuilt.to);
    // Still blocked, and the row names the head that is on origin NOW.
    const blockedRow = journal.find((e) => e.action === 'origin-blocked')!;
    expect(blockedRow.headSha).toBe(rebuilt.to);
    // No second PR was created.
    expect(gh.calls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.path)).length).toBe(0);
  });

  it('an OWNER head that no longer merges is drafted and reported — the ref is never touched', async () => {
    // Force-pushing over commits somebody else put there is the one destructive
    // operation available here, so an owner-shaped head is neither rebuilt nor
    // deleted however unusable it is. The report is what carries it.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    // An owner commit on the fix ref, carrying an edit that collides with the
    // branch's own content on origin.
    repo.checkout('owner-work', { create: true, at: 'main' });
    repo.commit('owner: x = mine', { 'src/x.ts': 'mine\n' });
    const ownerHead = repo.sha('owner-work');
    const fixBranch = `fix/sweep/main_patched--main-h1-${repo.sha('main').slice(0, 8)}`;
    repo.git('push', 'origin', `${ownerHead}:refs/heads/${fixBranch}`);
    repo.checkout('main');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = fakeGithub({
      'GET /pulls?': {
        status: 200,
        body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12, state: 'open' }],
      },
    });
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { tokenFile }), gh.factory)).toBe(0);
    const journal = readJournal(dirOf(repo, ws));
    const degraded = journal.find((e) => e.action === 'owner-pr-degraded')!;
    expect(degraded.prNumber).toBe(12);
    expect(degraded.mergeable).toBe(false);
    expect(degraded.drafted).toBe(true);
    // Converted once, through GraphQL, and commented once.
    expect(gh.calls.filter((c) => c.path === '/graphql').length).toBe(1);
    expect(gh.calls.filter((c) => c.method === 'POST' && /\/issues\/12\/comments$/.test(c.path)).length).toBe(1);
    // The ref is EXACTLY where the owner left it, and the branch stays blocked.
    expect(repo.git('-C', bare, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(ownerHead);
    expect(journal.some((e) => e.action === 'proposal-dropped' || e.action === 'proposal-rebuilt')).toBe(false);
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(true);
  });

  it('merged ref -> RESOLVED: not blocked, the origin ref is deleted (cleanup)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

  it('unmerged ref with NO PR at all (crashed publish) -> the PR is (RE)CREATED from the ref; branch blocked; ref NEVER deleted', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // no marker comment (nothing addressed yet), and the orphan ref is never deleted.
    const created = journal.find((e) => e.action === 'origin-pr-created')!;
    expect(created.ref).toBe(fixBranch);
    expect(created.prNumber).toBe(7);
    expect(created.draft).toBe(false);
    const prPost = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect((prPost.body as { head: string }).head).toBe(fixBranch);
    expect((prPost.body as { base: string }).base).toBe('main_patched');
    expect((prPost.body as { draft: boolean }).draft).toBe(false);
    // NO marker comment: the recreated PR has no reviews, so there is nothing
    // for the driver to record. `classifyComments` reads an absent marker as 0.
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.includes('/issues/7/comments'))).toBe(false);
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

  it('ref present + PR CLOSED (not merged) -> the case is WITHDRAWN: ref deleted, branch NOT gated, no reopen', async () => {
    // The driver never closes a PR, so a closed one was closed by a person, and
    // that is the owner saying "drop this". Reopening it would override the
    // decision — and were the gate keyed on the REF, closing by hand
    // would not lift it either: the owner would have to close a PR AND delete a ref.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { fixBranch } = pushFixRef(repo);
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

    const withdrawn = journal.find((e) => e.action === 'origin-ref-withdrawn')!;
    expect(withdrawn.ref).toBe(fixBranch);
    expect(withdrawn.prNumber).toBe(12);
    expect(withdrawn.via).toBe('pr-closed-by-owner');
    // The decision is honoured: no reopen attempted at all.
    expect(journal.some((e) => e.action === 'origin-pr-reopened')).toBe(false);
    expect(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/12'))).toBe(false);
    // The gate is withdrawn — ref gone, branch not blocked.
    expect(repo.git('-C', bare, 'for-each-ref', `refs/heads/${fixBranch}`)).toBe('');
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'main_patched')).toBe(false);
  });


  it('REVIEW-only trigger: a NEW loose comment (and bot reviews, and a quote-reply embedding the marker) do NOT reissue; only a review above the marker would', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  it('ERR41 names $GH_TOKEN / $GITHUB_TOKEN when the token came from the environment', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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


  it('ref ABSENT (crashed in flight, resolution lost) -> fresh re-derive: ordinary case, no origin rows, no token needed', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    expect(served.materials).toContain('EDIT: the pending files below, nothing else.');
    const caseId = currentCaseId(dir);
    expect(readFileSync(join(dir, caseId, 'worktree', 'src/x.ts'), 'utf8')).toContain('<<<<<<<');
  });

  it('open PR + NEW review (CHANGES_REQUESTED) -> REISSUE: revision case from the PRIOR resolution, time-ordered DIALOG in materials, forced HELD; finish live-rechecks + force-updates the SAME PR + posts the review-id marker', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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
    // The ref was pushed by an earlier pass and is parsed, not generated: parent,
    // height and conflict-head sha8 all come off its name, and the id the
    // revision wears is that name under `fix/sweep/` — one identity, so the
    // revision cannot be mistaken for a second case on the same conflict.
    expect(caseId).toBe(fixBranch.slice('fix/sweep/'.length));
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

describe('sweep finish — owner-facing PR + stats summary on the success SWEEP-RESULT', () => {
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
    // main_patched froze THIS pass, so it is still in the integration recipe
    // and the gate really runs: give it a command list this fixture can pass.
    const finCmds = join(ws, 'fin-cmds.json');
    writeFileSync(finCmds, JSON.stringify([{ cmd: 'true' }]));
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, out: finOut, commandsFile: finCmds }),
        ghFin.factory,
      ),
    ).toBe(0);
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as {
      ok: boolean;
      pullRequests: Array<{ number: number; url: string; title: string | null; status: string; kind: string }>;
      ownerPullRequests?: Array<{ branch: string; number: number; mergeable: boolean; reason: string }>;
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
    // The owner pushed the head on feat/other's fix ref and it no longer merges.
    // The driver will not rewrite it, so the RESULT is the notification — and it
    // says so again on every pass, not only on the one that drafted it.
    expect(fin.ownerPullRequests).toEqual([
      expect.objectContaining({ branch: 'feat/other', number: 12, mergeable: false }),
    ]);
    expect(fin.instruction).toContain('fix or close');
  });
});

describe('sweep finish — push resilience: per-branch, categorized, resumable', () => {
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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

  it('a judged PR whose head LANDED is closed by git, whatever GitHub has flagged yet', async () => {
    // GitHub marks a pull request merged asynchronously once its head becomes
    // reachable from the base, and the closure check runs SECONDS after the push
    // that made it so. Read once, the flag answers "has GitHub noticed", which
    // is not the question — and on 2026-09-03 that raced in production: PR #130
    // was flagged open 1s after the push and MERGED moments later, so the pass
    // reported a blocking ERR16 telling the owner to investigate an already
    // merged PR. A head contained in the pushed target is closed as a fact of
    // git, and that is what the driver judges by.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
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

    // A judged PR whose head is the branch tip this pass is about to push —
    // exactly the shape the real closure has the instant after the push lands.
    const head = repo.git('rev-parse', 'main_patched');
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'pr-published',
        caseId: 'landed',
        branch: 'main_patched',
        mode: 'judged',
        number: 22,
        head,
      }) + '\n',
    );
    // GitHub has NOT flipped it yet.
    const gh = fakeGithub({
      'GET /pulls/22': { status: 200, body: { number: 22, merged: false, state: 'open', body: 'x' } },
    });
    const cmdsFile = join(ws, 'cmds-true.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'true' }]));
    const out = join(ws, 'f.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmdsFile, out }),
        gh.factory,
      ),
    ).toBe(0);
    // A COMPLETE payload carries no blockingIssues field at all — the pass is
    // not partial, which is itself the point: the false ERR16 made it partial.
    const f = JSON.parse(readFileSync(out, 'utf8')) as { status: string; blockingIssues?: Array<{ id: string }> };
    expect(f.status).toBe('complete');
    expect((f.blockingIssues ?? []).some((i) => i.id === 'ERR16_CLOSURE_FAILED')).toBe(false);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'push-issue' && e.id === 'ERR16_CLOSURE_FAILED')).toBe(false);
    // The gap is RECORDED, not silently swallowed: the flip is owed.
    expect(journal.find((e) => e.action === 'closure-pending' && e.number === 22)?.branch).toBe('main_patched');
    void bare;
  });
});

describe('sweep start — canonical pass location + clean-slate boundary', () => {
  it('clears a COMPLETE/STALE prior pass at the canonical dir — no inherited journal/machine-state', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const wm = repo.sha('main');

    // Plant a STALE prior pass at the canonical location: a leftover journal with
    // a stale HELD + a machine-state marked complete (a finished/aborted run at
    // the same watermark) — the contamination shape the clean slate must clear.
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
    const out = join(ws, 'refuse.json');
    // workspace === the clone toplevel -> refused, no pass created.
    expect(await cmdSweepStart(baseCli(repo, ws, inv, { workspace: repo.dir, out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR37_WORKSPACE_IN_CLONE')).toBe(true);
    expect(existsSync(join(repo.dir, 'propagation'))).toBe(false); // nothing landed in the clone
  });

  it('C-1: start REFUSES a --workspace that is a SUBDIRECTORY of the --repo clone', async () => {
    const repo = conflictFixture();
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
    const inv = branchlessInventory();
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
// GATE-FIX. An unattributable verify red must not dead-end in an
// ERR18/ERR40 asking a HUMAN to fix something the agent may not deliver (it
// cannot push or open a PR). It becomes a case.
// ---------------------------------------------------------------------------

/**
 * PRE-MERGE BRANCH CHECK (owner decision). Detection runs FORWARD,
 * with the sweep, at the one place merging actually happens — `next-case`, which
 * calls cmdRun. A branch already red must not be merged into or propagated from:
 * either way every descendant inherits a defect it cannot fix inside its own
 * conflict scope — a livelock.
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
    // would strand the case: the next call re-runs the check, hits the mint
    // dedup, and can never hand it over.
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
    const inv = branchlessInventory();
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
   * REGRESSION GUARD: the check can silently do nothing in production
   * while every fixture passes. `applyPassConfig` RETURNS the pass's checks file
   * rather than assigning it onto `cli`, so reading `cli.checksFile` in
   * `next-case` gets undefined, `loadChecksConfig` returns null, and the check
   * exits at its first line — indistinguishable from "no checks file".
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
   * PR. If the agent fixes the red trunk, the case is held for an
   * unrelated hunk, and `next-case` then says "the pass stopped, report to the
   * owner" — the agent reports and never runs `finish`: pr-intent journaled,
   * zero refs pushed, zero PRs, the fix existing only in the pass directory.
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

  /** main_patched conflicts with upstream; module/cq hangs off it and goes red. */
  function parentConflictChildRedRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('module/cq', { create: true, at: 'main_patched' });
    repo.commit('cq: queue', { 'src/queue.ts': 'green\n' });
    repo.checkout('main_patched');
    repo.commit('mp: helper', { 'src/helper.ts': 'h\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }
  /** Red exactly where `src/queue.ts` says so — a per-tree fact, like a real suite. */
  const queueRunner: ChecksRunner = async (commands, cwd) => {
    const f = join(cwd, 'src/queue.ts');
    const red = existsSync(f) && readFileSync(f, 'utf8').includes('BROKEN');
    return {
      ok: !red,
      failedNames: red ? commands.map((c) => c.cmd) : [],
      output: red ? 'src/queue.ts(1,1): error TS2345: the queue is broken.\n' : '',
    };
  };

  /**
   * P has an open conflict case; X, a branch beneath it, has a gate fix minted
   * on it and not yet served. Resolving P's case reopens P and everything under
   * it, X included — and the gate fix is then the only case left to serve.
   */
  it('a resolve above does not void the gate-fix case minted below it', async () => {
    const repo = parentConflictChildRedRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cq', branch: 'module/cq', parents: ['main_patched'], owned: ['src/queue.ts'] }]);
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));
    const cli = (o: Partial<Cli> = {}): Cli => baseCli(repo, ws, inv, { checksFile: checks, ...o });
    const out = join(ws, 'nc.json');

    expect(await cmdSweepStart(cli())).toBe(0);
    expect(await cmdSweepNextCase(cli({ out }), queueRunner)).toBe(0);
    const conflictCaseId = currentCaseId(dir);

    // module/cq goes red under the open pass. The next call mints its gate fix
    // and goes on serving the conflict case first — DAG order, which is right.
    repo.checkout('module/cq');
    repo.commit('cq: goes red', { 'src/queue.ts': 'BROKEN\n' });
    repo.checkout('main');
    expect(await cmdSweepNextCase(cli({ out }), queueRunner)).toBe(0);
    const gateFixId = readJournal(dir).find((e) => e.action === 'gate-fix' && e.branch === 'module/cq')!
      .caseId as string;
    expect(currentCaseId(dir)).toBe(conflictCaseId);

    // The conflict resolves, and its reopen covers main_patched AND module/cq.
    resolveWorktree(dir, conflictCaseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm, queueRunner),
    ).toBe(0);
    const afterResolve = readJournal(dir);
    expect(afterResolve.some((e) => e.action === 'reopened' && e.branch === 'module/cq')).toBe(true);
    expect(supersededCaseIds(afterResolve).has(gateFixId)).toBe(false);
    // The gate fix is still the branch's OPEN case, which is what keeps module/cq
    // out of the publishable set (`openCaseBranches` reads exactly this).
    expect(openCases(afterResolve).map((c) => [c.caseId, c.branch])).toEqual([[gateFixId, 'module/cq']]);

    // And `next-case` SERVES it. Voided instead, it is gone before anyone sees
    // it: the red is re-detected, the mint hits its per-pass anti-loop key, and
    // the pass stops with a fix nobody was given.
    expect(await cmdSweepNextCase(cli({ out }), queueRunner)).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; caseId?: string };
    expect(res.status).toBe('case-ready');
    expect(res.caseId).toBe(gateFixId);
    expect(readJournal(dir).some((e) => e.action === 'case-served' && e.caseId === gateFixId)).toBe(true);
  });

  /** module/cq is red at its own tip before anything merges. */
  function childRedRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: helper', { 'src/helper.ts': 'h\n' });
    repo.checkout('module/cq', { create: true, at: 'main_patched' });
    repo.commit('cq: queue', { 'src/queue.ts': 'BROKEN\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * The anti-loop guard the exemption leaves standing: one mint per
   * (branch, file-set) per pass. A CONCLUDED attempt whose files are red again
   * is the loop it stops — `next-case` says so and halts rather than minting a
   * second case over the same key.
   */
  it('a CONCLUDED gate fix whose files go red again stops the pass, never a second mint', async () => {
    const repo = childRedRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cq', branch: 'module/cq', parents: ['main_patched'], owned: ['src/queue.ts'] }]);
    const dir = dirOf(repo, ws);
    const checks = join(ws, 'checks.json');
    writeFileSync(checks, JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [] }));
    const cli = (o: Partial<Cli> = {}): Cli => baseCli(repo, ws, inv, { checksFile: checks, ...o });
    const out = join(ws, 'nc.json');

    expect(await cmdSweepStart(cli())).toBe(0);
    expect(await cmdSweepNextCase(cli({ out }), queueRunner)).toBe(0);
    const gateFixId = (JSON.parse(readFileSync(out, 'utf8')) as { caseId: string }).caseId;

    // The fix is written, judged and landed on the branch.
    resolveWorktree(dir, gateFixId, { 'src/queue.ts': 'green\n' });
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', execute: true }), confirm, queueRunner),
    ).toBe(0);
    writePr(dir, gateFixId, 'fix: the queue', 'Decision needed: the build was red on src/queue.ts.');
    expect(await cmdSweepReportPr(cli({ cmd: 'report-pr', execute: true, out }), confirm)).toBe(0);

    // And the same files are red again.
    repo.checkout('module/cq');
    repo.commit('cq: red again', { 'src/queue.ts': 'BROKEN\n' });
    repo.checkout('main');
    expect(await cmdSweepNextCase(cli({ out }), queueRunner)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; instruction: string };
    expect(res.status).toBe('stopped');
    expect(res.instruction).toContain('a gate fix was already attempted for module/cq over these files');
    expect(readJournal(dir).filter((e) => e.action === 'gate-fix').length).toBe(1);
  });
});

/**
 * THE LANDING GATE. Checks used to run in exactly three places — the
 * `report-case` gate on a case's tree, the proposal probe at `start`, and
 * finish's integration verify — and a clean merge triggered none of them. So a
 * branch that merged cleanly handed its content to every descendant on no
 * evidence, and a CUT branch, which is pushed at its cut point and then left OUT
 * of the verify recipe, shipped a prefix to origin that nothing in the pass had
 * measured. Naming that in the result is not measuring it.
 *
 * The rule these pin: content that propagates arrives green, or it does not
 * arrive.
 */
describe('run — a fork-side parent line is taken commit by commit', () => {
  /**
   * ONE HEIGHT, TWO CASES, IN ONE PASS. The parent's advance is entirely
   * fork-side, so its nine commits share a height and the walk stops at each
   * conflicting commit in turn: resolving the first reopens the branch, and the
   * re-derivation stops at the NEXT — same branch, same parent, same height.
   * The two cases are told apart by their conflict head, which is why the id
   * carries it: a second case wearing the first's id inherits its `resolved`
   * disposition, drops out of `openCases`, and can never be served.
   */
  it('resolving the first stop reopens the branch and the next commit is served as a second case at the same height', async () => {
    const { repo, base, conflicting } = makeForkRunFixture();
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'child', branch: 'feat/child', parents: ['main_patched'] }]);
    const dir = dirOf(repo, ws);
    const cli = (o: Partial<Cli> = {}): Cli => baseCli(repo, ws, inv, { base, ...o });

    expect(await cmdSweepStart(cli())).toBe(0);
    expect(await cmdSweepNextCase(cli(), greenPreMerge)).toBe(0);
    const first = currentCaseId(dir);
    expect(first).toBe(`feat__child--main_patched-h0-${conflicting[0].slice(0, 8)}`); // the stop = p2

    resolveWorktree(dir, first, { 'src/a.ts': 'RESOLVED-a\n', 'src/b.ts': 'RESOLVED-b\n' });
    expect(await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm)).toBe(0);
    const afterResolve = readJournal(dir);
    expect(afterResolve.some((e) => e.action === 'resolved' && e.caseId === first)).toBe(true);
    expect(afterResolve.some((e) => e.action === 'reopened' && e.branch === 'feat/child')).toBe(true);

    expect(await cmdSweepNextCase(cli(), greenPreMerge)).toBe(0);
    const second = currentCaseId(dir);
    // Same branch, same parent, same HEIGHT — a different conflict head.
    expect(second).toBe(`feat__child--main_patched-h0-${conflicting[1].slice(0, 8)}`); // the next stop = p3
    expect(second).not.toBe(first);
    const journal = readJournal(dir);
    const secondRow = journal.find((e) => e.action === 'case' && e.caseId === second)!;
    expect(secondRow.head as { sha: string; height: number }).toMatchObject({ sha: conflicting[1], height: 0 });
    // Served, not swallowed: the first case's disposition is its own.
    expect(openCases(journal).map((c) => c.caseId)).toContain(second);
    expect(openCases(journal).map((c) => c.caseId)).not.toContain(first);
  });

  /**
   * THE LANDING GATE MEASURES A BRANCH THAT GATED ON A CASE IN THE SAME CALL.
   *
   * The clean prefix moved the tree, so it is owed a verdict whatever else the
   * branch did — and when that verdict is red, the reopen supersedes the case
   * just emitted. Serving a conflict case on a tree whose checks fail is asking
   * the agent to judge a merge against a defect the gate fix already describes.
   */
  it('a clean prefix that lands RED supersedes the case emitted above it and serves the fix instead', async () => {
    const { repo, base, cleanHead, conflicting } = makeForkRunFixture();
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'child', branch: 'feat/child', parents: ['main_patched'], owned: ['src/a.ts'] }]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    repo.git('push', 'origin', 'feat/child');
    // Red on the CHILD'S LANDED TREE only: it is the one tree carrying both the
    // trunk util the prefix brought down and the child's own src/a.ts.
    const landedChild = (cwd: string): boolean =>
      existsSync(join(cwd, 'src/u.ts')) && readFileSync(join(cwd, 'src/a.ts'), 'utf8').includes('child');
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      const red = cmds.includes('vitest run') && landedChild(cwd);
      return {
        ok: !red,
        failedNames: red ? cmds : [],
        output: red ? `$ ${cmds[0]}\nsrc/a.ts(1,1): error TS2345: the landed tree is broken.\n` : '',
      };
    };
    const checks = join(ws, 'checks.json');
    writeFileSync(
      checks,
      JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [{ cmd: 'vitest run', cwd: '.' }] }),
    );

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { base, checksFile: checks }))).toBe(0);
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { base, out }), fn)).toBe(0);

    const journal = readJournal(dir);
    // The prefix merged, the case above it was emitted, and the landing measured red.
    expect((journal.find((e) => e.action === 'merge' && e.branch === 'feat/child')!.head as { sha: string }).sha).toBe(cleanHead);
    const conflictCase = journal.find((e) => e.action === 'case' && e.branch === 'feat/child')!;
    expect((conflictCase.head as { sha: string }).sha).toBe(conflicting[0]);
    expect(journal.find((e) => e.action === 'landing-check' && e.branch === 'feat/child')!.ok).toBe(false);
    // The gate ran for a branch that had already gated, and its reopen won.
    expect(supersededCaseIds(journal)).toContain(conflictCase.caseId as string);
    expect(openCases(journal).map((c) => c.caseId)).not.toContain(conflictCase.caseId as string);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; caseId?: string };
    expect(res.status).toBe('case-ready');
    expect(res.caseId).toContain('gate-fix-feat__child');
    expect(openCases(journal).map((c) => c.caseId)).toContain(res.caseId);
  });
});

describe('run — the landing gate', () => {
  /** Every command list handed over, plus a red-when predicate on the tree. */
  function tracingRunner(redWhen?: (cwd: string) => boolean): {
    fn: ChecksRunner;
    ran: Array<{ cmds: string[]; cwd: string }>;
  } {
    const ran: Array<{ cmds: string[]; cwd: string }> = [];
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      ran.push({ cmds, cwd });
      const red = redWhen ? redWhen(cwd) : false;
      return {
        ok: !red,
        failedNames: red ? cmds : [],
        output: red ? `$ ${cmds[0]}\nsrc/x.ts(1,1): error TS2345: the landed tree is broken.\n` : '',
      };
    };
    return { fn, ran };
  }
  /** Typecheck AND tests, so a landing run is told apart from the typecheck-only pre-merge one. */
  function checksJson(ws: string): string {
    const f = join(ws, 'checks.json');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }],
        test: [{ cmd: 'vitest run', cwd: '.' }],
      }),
    );
    return f;
  }
  const landingRuns = (ran: Array<{ cmds: string[] }>): number =>
    ran.filter((r) => r.cmds.includes('vitest run')).length;

  it('a clean merge that lands GREEN carries its evidence: branch, tree, verdict', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'mp\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = tracingRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'main_patched')).toBe(true);
    const row = journal.find((e) => e.action === 'landing-check' && e.branch === 'main_patched');
    expect(row).toBeTruthy();
    expect(row!.ok).toBe(true);
    // WHICH TREE, not just which branch: "is this red inherited" is answered by
    // comparing trees in the journal, with nothing re-probed.
    expect(row!.sha).toBe(repo.sha('main_patched'));
    expect(row!.tree).toBe(repo.git('rev-parse', 'main_patched^{tree}'));
    // One notion of green: the same typecheck-THEN-test ordering report-case runs.
    expect(landingRuns(t.ran)).toBe(1);
  });

  /**
   * A runner whose TEST list is red on a tree the first time it is asked and,
   * unless `stable()` says otherwise, green on the confirming re-run — the
   * order-dependent shape the landing gate must not found a case on.
   */
  function unstableRunner(
    redTree: (cwd: string) => boolean,
    stable: () => boolean = () => false,
  ): { fn: ChecksRunner; ran: Array<{ cmds: string[]; cwd: string }> } {
    const ran: Array<{ cmds: string[]; cwd: string }> = [];
    const seen = new Map<string, number>();
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      ran.push({ cmds, cwd });
      if (!cmds.includes('vitest run') || !redTree(cwd)) return { ok: true, failedNames: [], output: '' };
      // KEYED ON THE COMMIT, NOT THE PATH. The confirming re-run is taken in a
      // worktree checked out afresh, so a path-keyed harness would call it a
      // first run and hand the driver two independent reds it never observed.
      const at = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      const nth = (seen.get(at) ?? 0) + 1;
      seen.set(at, nth);
      if (nth > 1 && !stable()) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['vitest run'],
        output: '$ vitest run\nsrc/mp.ts(1,1): error TS2345: the landed tree is broken.\n',
      };
    };
    return { fn, ran };
  }

  /** main_patched merges an upstream commit that only breaks in combination with its own. */
  function flakyLandingRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'mp\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg work', { 'src/cg.ts': 'cg\n' });
    repo.checkout('main');
    repo.commit('U0: upstream breaks the build', { 'BROKEN.marker': 'x\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }
  const landedRed = (cwd: string): boolean =>
    existsSync(join(cwd, 'BROKEN.marker')) && existsSync(join(cwd, 'src/mp.ts'));

  it('a landing whose red does NOT reproduce on the same tree mints nothing and blames nobody', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const cgBefore = repo.sha('module/cg');
    const t = unstableRunner(landedRed);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn)).toBe(1);

    const journal = readJournal(dir);
    // THE POINT: one red observation founded nothing.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'case')).toBe(false);
    // The re-run happened, on the same tree, over the failing command alone.
    const confirm = journal.find((e) => e.action === 'red-confirm');
    expect(confirm!.reproduced).toBe(false);
    expect(confirm!.commands).toEqual(['vitest run']);
    expect(confirm!.flaky).toEqual(['vitest run']);
    const row = journal.find((e) => e.action === 'landing-check' && e.unstable === true);
    expect(row!.branch).toBe('main_patched');
    expect(row!.ok).toBe(false);
    expect(row!.id).toBe('WARN21_CHECKS_FLAKY');
    // ...and the content did not travel: no child merged it, the branch never
    // arrived, and the pass cannot seal on a tree nothing saw green.
    expect(repo.sha('module/cg')).toBe(cgBefore);
    expect(journal.some((e) => e.action === 'arrived' && e.branch === 'main_patched')).toBe(false);
    expect(journal.some((e) => e.action === 'pass-complete')).toBe(false);
    // The agent is told what happened and given a legal move — never `finalize`.
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      resumable?: boolean;
      issues?: Array<{ id: string; detail: string }>;
    };
    expect(res.status).toBe('stopped');
    expect(res.issues![0].id).toBe('WARN21_CHECKS_FLAKY');
    expect(res.resumable).toBe(true);
  });

  it('an unstable tree is still OWED a verdict: the next call re-measures it, and a red that repeats mints', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    let stable = false;
    const t = unstableRunner(landedRed, () => stable);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(1);
    expect(readJournal(dir).some((e) => e.action === 'gate-fix')).toBe(false);

    // Nothing new merges on the second call — the merge already landed — so the
    // no-op skip would pass the tree over as if it had been checked.
    stable = true;
    const out = join(ws, 'nc2.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn)).toBe(0);

    const journal = readJournal(dir);
    expect(journal.filter((e) => e.action === 'landing-check' && e.ran === false && e.reason === 'no-op').map((e) => `${e.branch}@${e.tree}`)).toEqual([]);
    expect(journal.some((e) => e.action === 'gate-fix' && e.branch === 'main_patched')).toBe(true);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; branch?: string };
    expect(res.status).toBe('case-ready');
    expect(res.branch).toBe('main_patched');
  });

  /**
   * THE ORDINARY ORDER-DEPENDENT FAILURE: the test command fails only where the
   * typecheck has already run in the SAME worktree. A re-run of the accused
   * command ALONE can never see it — a pristine tree has nothing before it — so
   * repeating the whole experiment is the only probe that can tell this apart
   * from a check that answers at random.
   */
  function orderDependentRunner(redTree: (cwd: string) => boolean): {
    fn: ChecksRunner;
    ran: Array<{ cmds: string[]; cwd: string }>;
  } {
    const ran: Array<{ cmds: string[]; cwd: string }> = [];
    /** Worktrees a typecheck has already run in — the state the failure needs. */
    const typechecked = new Set<string>();
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      ran.push({ cmds, cwd });
      const after = typechecked.has(cwd) || cmds.includes('tsc --noEmit');
      if (cmds.includes('tsc --noEmit')) typechecked.add(cwd);
      if (!cmds.includes('vitest run') || !redTree(cwd) || !after) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['vitest run'],
        output: '$ vitest run\nsrc/mp.ts(1,1): error TS2345: the landed tree is broken.\n',
      };
    };
    return { fn, ran };
  }

  it('a red that NEEDS the commands before it is confirmed by replaying the sequence, not stamped flaky', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const t = orderDependentRunner(landedRed);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn)).toBe(0);

    const journal = readJournal(dir);
    // THE POINT: the accusation alone was green, and that did not end the probe.
    const landed = journal.find((e) => e.action === 'landing-check' && e.branch === 'main_patched' && e.ok === false)!;
    expect(landed.confirmed).toBe(true);
    expect(landed.unstable).toBeUndefined();
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.cmd === 'vitest run')!;
    expect(confirm.reproduced).toBe(true);
    expect(confirm.aloneGreen).toBe(true);
    expect(confirm.context).toBe('sequence');
    // THE GREEN LIVES ON THAT ROW AND NOWHERE ELSE. A `landing-check` or
    // `branch-check` green for this command on this tree would be inherited by
    // every branch carrying the subtree, and a genuinely red one would go
    // unmeasured.
    const rowChecks = (e: JournalEntry): Array<{ cmd: string; ok: boolean; subtree: string }> =>
      (Array.isArray(e.checks) ? e.checks : []) as Array<{ cmd: string; ok: boolean; subtree: string }>;
    expect(
      journal
        .filter((e) => e.action === 'landing-check' || e.action === 'branch-check')
        .some((e) => rowChecks(e).some((c) => c.cmd === 'vitest run' && c.ok && c.subtree === landed.tree)),
    ).toBe(false);
    // The case is minted, and it is labelled for what the two runs showed.
    const gate = journal.find((e) => e.action === 'gate-fix')!;
    expect(gate.branch).toBe('main_patched');
    expect(journal.find((e) => e.action === 'case' && e.caseId === gate.caseId)!.reproduction).toBe(
      'environment-conditional',
    );
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; branch?: string };
    expect(res.status).toBe('case-ready');
    expect(res.branch).toBe('main_patched');
  });

  it('a red that goes green ALONE and green under the REPLAY is the instability WARN21 names', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const t = unstableRunner(landedRed);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn)).toBe(1);

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.cmd === 'vitest run')!;
    expect(confirm.reproduced).toBe(false);
    expect(confirm.aloneGreen).toBe(true);
    expect(confirm.replayGreen).toBe(true);
    expect(confirm.flaky).toEqual(['vitest run']);
    // THE FINDING IS ONLY TRUE BECAUSE THE SEQUENCE WAS REPLAYED, so it says so:
    // "it passed on its own" would be a statement about a different experiment.
    expect(String(confirm.detail)).toContain('replayed command sequence');
    const row = journal.find((e) => e.action === 'landing-check' && e.unstable === true)!;
    expect(row.id).toBe('WARN21_CHECKS_FLAKY');
    expect(String(row.detail)).toContain('replayed command sequence');
    // Three runs of the failing command: the gate's, the accusation alone, and
    // the replayed sequence.
    expect(landingRuns(t.ran)).toBe(3);
  });

  it('a red that reproduces ALONE spawns ONE re-run worktree, and the row says which experiment answered', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    // Red on every ask. The accusation alone reproduces, so the sequence replay
    // could add nothing and is not paid for.
    const t = unstableRunner(landedRed, () => true);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const confirm = readJournal(dir).find((e) => e.action === 'red-confirm' && e.cmd === 'vitest run')!;
    expect(confirm.reproduced).toBe(true);
    expect(confirm.rerunMode).toBe('alone');
    expect(confirm.aloneGreen).toBeUndefined();
    // TWO runs of the failing command, in TWO worktrees, and the second was
    // handed the accusation alone — a `['tsc --noEmit', 'vitest run']` list here
    // would be a replay bought for a question already answered.
    const vitest = t.ran.filter((r) => r.cmds.includes('vitest run'));
    expect(vitest.map((r) => r.cmds)).toEqual([['vitest run'], ['vitest run']]);
    expect(new Set(vitest.map((r) => r.cwd)).size).toBe(2);
  });

  /**
   * AN UNSTABLE RED MINTS NOTHING, so nothing else writes down what it was. The
   * row names the COMMANDS and a reader coming back to it cannot tell a wrong
   * assertion from an environment gap from an instability — which is the one
   * question this row exists to raise.
   */
  it('an unstable landing keeps its evidence: the row carries the tail, the file carries every run', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const t = unstableRunner(landedRed);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(1);

    const row = readJournal(dir).find((e) => e.action === 'landing-check' && e.unstable === true)!;
    expect(row.files).toEqual(['src/mp.ts']);
    expect(row.fingerprints).toEqual(['ts src/mp.ts TS2345 the landed tree is broken.']);
    expect(String(row.outputTail)).toContain('src/mp.ts(1,1): error TS2345');
    expect(row.outputFile).toBe(join('landing', 'main_patched-test-1.txt'));
    // EVERY RUN, in the order they were taken and each under a `$ ` header, so a
    // reader of a checks log is never handed a re-run's diagnostics as the first
    // run's.
    const log = readFileSync(join(dir, String(row.outputFile)), 'utf8');
    expect(log).toContain('src/mp.ts(1,1): error TS2345');
    expect(log).toContain('$ --- alone re-run ---');
    expect(log).toContain('$ --- sequence replay ---');
  });

  it('a landing red that prints 100k characters keeps a bounded tail and the whole log', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    // The diagnostics come LAST, which is why the row keeps a tail rather than a
    // head: a suite prints its passing output first.
    const noise = 'x'.repeat(100_000);
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      if (!cmds.includes('vitest run') || !landedRed(cwd)) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['vitest run'],
        output: `$ vitest run\n${noise}\nsrc/mp.ts(1,1): error TS2345: the landed tree is broken.\n`,
      };
    };

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), fn)).toBe(0);

    const row = readJournal(dir).find((e) => e.action === 'landing-check' && e.confirmed === true)!;
    expect(String(row.outputTail).length).toBeLessThanOrEqual(4000);
    expect(String(row.outputTail)).toContain('src/mp.ts(1,1): error TS2345');
    // The journal is bounded; the LOG is not. The whole run is on disk.
    const log = readFileSync(join(dir, String(row.outputFile)), 'utf8');
    expect(log.length).toBeGreaterThan(100_000);
    expect(log).toContain('src/mp.ts(1,1): error TS2345');
  });

  it('a red-confirm row carries the RE-RUN it was decided by, not the run it was confirming', async () => {
    const repo = flakyLandingRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    // Two observations of one defect, told apart by what they print.
    let asked = 0;
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      if (!cmds.includes('vitest run') || !landedRed(cwd)) return { ok: true, failedNames: [], output: '' };
      const which = ++asked === 1 ? 'the standing worktree' : 'the confirming re-run';
      return { ok: false, failedNames: ['vitest run'], output: `$ vitest run\nsrc/mp.ts(1,1): error TS2345: ${which}.\n` };
    };

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), fn)).toBe(0);

    const journal = readJournal(dir);
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.cmd === 'vitest run')!;
    expect(confirm.reproduced).toBe(true);
    expect(confirm.fingerprints).toEqual(['ts src/mp.ts TS2345 the confirming re-run.']);
    expect(String(confirm.outputTail)).toContain('the confirming re-run');
    // And the landing row keeps the run IT judged: two observations, two records.
    const row = journal.find((e) => e.action === 'landing-check' && e.confirmed === true)!;
    expect(String(row.outputTail)).toContain('the standing worktree');
    expect(readFileSync(join(dir, String(row.outputFile)), 'utf8')).toContain('$ --- alone re-run ---');
  });

  it('a landing whose tree is RED reaches no child, and the journal names the failing commands', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'mp\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg work', { 'src/cg.ts': 'cg\n' });
    repo.checkout('main');
    repo.commit('U0: upstream breaks the build', { 'BROKEN.marker': 'x\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const cgBefore = repo.sha('module/cg');
    // The red is created BY THE MERGE: neither side carries it alone, so
    // upstream is green, both branches are green before the merge, and
    // main_patched is red the moment the two trees meet.
    const t = tracingRunner(
      (cwd) => existsSync(join(cwd, 'BROKEN.marker')) && existsSync(join(cwd, 'src/mp.ts')),
    );

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn)).toBe(0);

    const journal = readJournal(dir);
    // THE POINT, asserted first: the child never took it.
    expect(repo.sha('module/cg')).toBe(cgBefore);
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'module/cg')).toBe(false);
    const row = journal.find((e) => e.action === 'landing-check' && e.branch === 'main_patched');
    expect(row!.ok).toBe(false);
    expect(row!.failed).toEqual(['tsc --noEmit']);
    expect(row!.phase).toBe('typecheck');
    // The red was CONFIRMED on the identical tree before it was acted on: the
    // re-run covers the failing command only, and it reproduced.
    const confirm = journal.find((e) => e.action === 'red-confirm' && e.branch === 'main_patched');
    expect(confirm!.reproduced).toBe(true);
    expect(confirm!.commands).toEqual(['tsc --noEmit']);
    expect(row!.confirmed).toBe(true);
    // PAID ONCE. Every confirming re-run journals a row, so one row for the whole
    // pass is the claim: the landing gate paid for it and blame — which minted
    // the case off the same observation — read it rather than re-running it.
    expect(journal.filter((e) => e.action === 'red-confirm')).toHaveLength(1);
    // And the red is served as what it is — a fix on the branch now carrying it.
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; caseId?: string; branch?: string };
    expect(res.status).toBe('case-ready');
    expect(res.caseId).toContain('gate-fix-main_patched');
    expect(res.branch).toBe('main_patched');
  });

  /**
   * THE LANDING GATE ASKS THE SAME QUESTION THE MINT DOES, before it reopens.
   *
   * The failing command runs in `container/agent-runner`, a subtree the upstream
   * merge does not touch — so the landed tree carries the identical subtree the
   * red was confirmed on, on ANOTHER branch. The verdict holds and names nobody:
   * no case may be minted, so no reopen may be journaled for one. But the content
   * is red and unverified, so the branch must NOT arrive — on this call or the
   * next, where the merge has already landed and the tree has not moved.
   */
  it('a red landing no branch may be handed does not reopen, does not arrive, and stays owed', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: the runner subtree', {
      'src/mp.ts': 'mp\n',
      'container/agent-runner/poll-loop.test.ts': 'red\n',
    });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg work', { 'src/cg.ts': 'cg\n' });
    repo.checkout('main');
    repo.commit('U0: upstream moves src only', { 'src/u.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    repo.git('push', 'origin', 'module/cg');
    const dir = dirOf(repo, ws);
    const cgBefore = repo.sha('module/cg');
    const checks = join(ws, 'checks.json');
    writeFileSync(
      checks,
      // Commands that are GREEN when actually spawned: the landing gate's runner
      // is injected below, but finish's integration verify runs them for real.
      JSON.stringify({
        typecheck: [{ cmd: 'true', cwd: '.' }],
        test: [{ cmd: 'echo runner', cwd: 'container/agent-runner' }],
      }),
    );
    // Only the subtree-scoped test command is red; the typecheck is green, so the
    // pre-merge branch check passes and a pass opens.
    let runs = 0;
    const fn: ChecksRunner = async (commands) => {
      const cmds = commands.map((c) => c.cmd);
      if (!cmds.includes('echo runner')) return { ok: true, failedNames: [], output: '' };
      runs++;
      return {
        ok: false,
        failedNames: ['echo runner'],
        output: '$ echo runner\ncontainer/agent-runner/poll-loop.test.ts(1,1): error TS2345: boom\n',
      };
    };

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checks }))).toBe(0);
    // The red for THESE BYTES was confirmed on another branch. The upstream merge
    // leaves the subtree untouched, so the landed tree carries the same object.
    const runnerSubtree = repo.git('rev-parse', 'main_patched:container/agent-runner');
    appendJournal(dir, {
      action: 'red-confirm',
      branch: 'module/elsewhere',
      sha: repo.sha('main_patched'),
      phase: 'test',
      cmd: 'echo runner',
      cwd: 'container/agent-runner',
      subtree: runnerSubtree,
      commands: ['echo runner'],
      ran: true,
      reproduced: true,
    });

    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), fn)).toBe(0);
    const first = readJournal(dir);
    // NOTHING WAS MINTED AND NOTHING WAS REOPENED: a reopen with no case behind it
    // supersedes this branch's work for nothing.
    expect(first.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(first.some((e) => e.action === 'reopened')).toBe(false);
    const refusal = first.find((e) => e.action === 'gate-fix-refused')!;
    expect(refusal.id).toBe('WARN22_RED_UNCONFIRMED');
    expect(refusal.branch).toBe('main_patched');
    expect(refusal.reason).toContain('module/elsewhere');
    expect((refusal.subtrees as Array<{ subtree: string }>)[0].subtree).toBe(runnerSubtree);
    // ...and the content did not travel.
    expect(repo.sha('module/cg')).toBe(cgBefore);
    expect(first.some((e) => e.action === 'arrived' && e.branch === 'main_patched')).toBe(false);
    expect(first.some((e) => e.action === 'pass-complete')).toBe(false);

    // THE NEXT CALL LANDS NOTHING NEW — the merge already happened — so the no-op
    // skip would pass the tree over as though it had been checked, and the branch
    // would arrive on a verdict nobody ever gave it.
    const before = runs;
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), fn)).toBe(0);
    const second = readJournal(dir);
    expect(runs).toBeGreaterThan(before);
    expect(
      second
        .filter((e) => e.action === 'landing-check' && e.ran === false && e.reason === 'no-op')
        .map((e) => e.branch),
    ).not.toContain('main_patched');
    expect(second.some((e) => e.action === 'arrived' && e.branch === 'main_patched')).toBe(false);
    expect(second.filter((e) => e.action === 'gate-fix-refused')).toHaveLength(2);
    expect(repo.sha('module/cg')).toBe(cgBefore);

    // AND THE OWNER HEARS ABOUT IT. The pass's report is assembled from the
    // finish result alone, so a red with no case, no PR and no branch to name is
    // the one finding that disappears without this.
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const finOut = join(ws, 'fin.json');
    await cmdSweepFinish(
      baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, tokenFile, commandsFile: cmds, out: finOut }),
      fakeGithub().factory,
    );
    const fin = JSON.parse(readFileSync(finOut, 'utf8')) as {
      needsOwner?: Array<{ branch: string; category: string; id?: string; detail: string }>;
      unmintableReds?: Array<{ branch: string; files: string[]; id: string }>;
      instruction: string;
    };
    // ONE entry, not one per measurement: the same branch and the same files were
    // refused on both calls.
    expect(fin.unmintableReds).toEqual([
      { branch: 'main_patched', files: [], id: 'WARN22_RED_UNCONFIRMED', detail: expect.any(String) },
    ]);
    expect((fin.needsOwner ?? []).map((n) => `${n.branch}:${n.category}`)).toContain('main_patched:unmintable-red');
    expect(fin.instruction).toContain('RED, NO BRANCH TO FIX IT');
    expect(fin.instruction).toContain('WARN22_RED_UNCONFIRMED');
  });

  it('a merge that lands no new tree is not measured', async () => {
    // The leaf un-skip forces EMPTY merges up the cheapest parent chain: the
    // tips move, the trees do not, so there is nothing new to measure.
    const repo = initFixtureRepo();
    repo.commit('base: f', { 'src/f.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: f = fork', { 'src/f.ts': 'fork\n' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('feat/a: own', { 'src/a.ts': 'a\n' });
    repo.checkout('feat/b', { create: true, at: 'feat/a' });
    repo.commit('feat/b: own', { 'src/b.ts': 'b\n' });
    repo.checkout('main');
    repo.commit('U0: f = up1', { 'src/f.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['feat/a'] },
    ]);
    const dir = dirOf(repo, ws);
    const t = tracingRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    expect(
      journal
        .filter((e) => e.action === 'merge' && e.forced === true)
        .map((e) => e.branch)
        .sort(),
    ).toEqual(['feat/a', 'feat/b']);
    for (const b of ['feat/a', 'feat/b']) {
      const row = journal.find((e) => e.action === 'landing-check' && e.branch === b);
      expect(row!.ran).toBe(false);
      expect(row!.reason).toBe('no-op');
      expect(row!.ok).toBeUndefined();
    }
    expect(landingRuns(t.ran)).toBe(0);
  });

  it('a landed tree already measured this pass is not measured a second time', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'mp\n' });
    // No own commits: whatever main_patched lands, this branch lands the SAME tree.
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const t = tracingRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    const mp = journal.find((e) => e.action === 'landing-check' && e.branch === 'main_patched');
    const cg = journal.find((e) => e.action === 'landing-check' && e.branch === 'module/cg');
    expect(mp!.ok).toBe(true);
    expect(cg!.ok).toBe(true);
    expect(cg!.tree).toBe(mp!.tree);
    // The verdict is COPIED, and the journal says where it was measured — a
    // checks run is a function of the tree, so a second run buys nothing.
    expect(cg!.measuredOn).toBe('main_patched');
    expect(landingRuns(t.ran)).toBe(1);
  });

  it("a cut branch's clean prefix is measured, though the verify recipe leaves it out", async () => {
    // feat/c = feat/a + feat/b. feat/a is blocked at h1, so feat/c takes the h0
    // prefix through feat/b and DEFERS the rest: no case, no PR, and excluded
    // from the recipe — but pushed at that cut point.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
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
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      { id: 'c', branch: 'feat/c', parents: ['feat/a', 'feat/b'] },
    ]);
    const dir = dirOf(repo, ws);
    const t = tracingRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksJson(ws) }))).toBe(0);
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'feat/a',
      caseId: 'origin:fix/sweep/feat__a--main_patched-h1-deadbeef',
      fixBranch: 'fix/sweep/feat__a--main_patched-h1-deadbeef',
      headSha: u1,
      prNumber: 12,
    });
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'defer' && e.branch === 'feat/c')).toBe(true);
    expect(journal.some((e) => e.action === 'case' && e.branch === 'feat/c')).toBe(false);
    const row = journal.find((e) => e.action === 'landing-check' && e.branch === 'feat/c');
    expect(row!.ok).toBe(true);
    expect(row!.tree).toBe(repo.git('rev-parse', 'feat/c^{tree}'));
  });
});

/**
 * A red that says a DECLARATION IS MISSING is answered by the walk, not by a
 * case (DRIVER.md §7.7). The checks runner reads the tree it is pointed at, so
 * every verdict below is a fact about a real merge the driver performed.
 */
describe('run — the missing-declaration advance', () => {
  /** `request.ts` with an independently editable top and bottom, so two sides merge clean. */
  const requestFile = (top: string[], bottom: string[]): string =>
    [...top, '', '// ---', '// ---', '// ---', '// ---', '// ---', '', ...bottom, ''].join('\n');
  const BASE_REQUEST = requestFile(['export const alpha = 1;'], ['export const omega = 26;']);
  /** Upstream's half-done split: one part of the pair exists, the other does not yet. */
  const SPLIT_REQUEST = requestFile(
    ['export const alpha = 1;', 'export const escapeInvisibles = 2;'],
    ['export const omega = 26;'],
  );
  /** Upstream reconciled the two lines: both parts present. */
  const RECONCILED_REQUEST = requestFile(
    ['export const alpha = 1;', 'export const escapeInvisibles = 2;'],
    ['export const handleAddMcpServer = 3;', 'export const omega = 26;'],
  );

  const MISSING_DECL_RE = 'error TS(2305|2307|2724):';
  function checksWithPattern(ws: string, pattern: string | null = MISSING_DECL_RE): string {
    const f = join(ws, 'checks.json');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: [{ cmd: 'tsc --noEmit', cwd: '.', ...(pattern ? { missingDeclRe: pattern } : {}) }],
        test: [{ cmd: 'vitest run', cwd: '.' }],
      }),
    );
    return f;
  }

  /**
   * The half-split state IN COMBINATION with the branch's own file. Upstream
   * alone must stay green: `next-case` probes the upstream tip before it merges
   * anything, and a red there stops the pass before any of this is reached.
   */
  const request = (cwd: string): string => {
    const p = join(cwd, 'src/request.ts');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  const onABranch = (cwd: string): boolean => existsSync(join(cwd, 'src/mp.ts'));
  const halfSplit = (cwd: string): boolean =>
    onABranch(cwd) && request(cwd).includes('escapeInvisibles') && !request(cwd).includes('handleAddMcpServer');

  /**
   * Red with a MISSING-DECLARATION diagnostic exactly while the tree is
   * half-split; `whenReconciled` decides what a reconciled tree says.
   */
  function declRunner(whenReconciled: 'green' | 'other-red' = 'green'): { fn: ChecksRunner; ran: string[] } {
    const ran: string[] = [];
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      ran.push(cmds.join('+'));
      if (!cmds.includes('tsc --noEmit')) return { ok: true, failedNames: [], output: '' };
      if (halfSplit(cwd)) {
        return {
          ok: false,
          failedNames: ['tsc --noEmit'],
          output:
            `$ tsc --noEmit\nsrc/request.ts(2,14): error TS2305: ` +
            `Module '"./split.js"' has no exported member 'handleAddMcpServer'.\n`,
        };
      }
      if (whenReconciled === 'other-red' && onABranch(cwd) && request(cwd).includes('handleAddMcpServer')) {
        return {
          ok: false,
          failedNames: ['tsc --noEmit'],
          output: `$ tsc --noEmit\nsrc/request.ts(9,14): error TS2322: Type 'number' is not assignable to type 'string'.\n`,
        };
      }
      return { ok: true, failedNames: [], output: '' };
    };
    return { fn, ran };
  }

  /**
   * THE RECONCILIATION TOUCHES ONLY THE SOURCE MODULE. `TS2305` reports at the
   * IMPORT, so the failing path is `src/request.ts` and a commit that adds the
   * export to `src/split.ts` touches none of it.
   */
  const IMPORTER = ["import { handleAddMcpServer } from './split.js';", 'export const use = handleAddMcpServer;', ''].join('\n');
  const SPLIT_PARTIAL = ['export const escapeInvisibles = 2;', ''].join('\n');
  const SPLIT_RECONCILED = ['export const escapeInvisibles = 2;', 'export const handleAddMcpServer = 3;', ''].join('\n');
  const splitModule = (cwd: string): string => {
    const p = join(cwd, 'src/split.ts');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  /** Red exactly while the source module is present and does not export the symbol. */
  function sourceOnlyRunner(): ChecksRunner {
    return async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      if (!cmds.includes('tsc --noEmit')) return { ok: true, failedNames: [], output: '' };
      if (!onABranch(cwd) || splitModule(cwd) === '' || splitModule(cwd).includes('handleAddMcpServer')) {
        return { ok: true, failedNames: [], output: '' };
      }
      return {
        ok: false,
        failedNames: ['tsc --noEmit'],
        output:
          `$ tsc --noEmit\nsrc/request.ts(1,10): error TS2305: ` +
          `Module '"./split.js"' has no exported member 'handleAddMcpServer'.\n`,
      };
    };
  }

  /**
   * Upstream splits a module and reconciles it one commit later, in the SOURCE
   * file only. The walk stops below the reconciliation because a sibling
   * upstream commit conflicts with the fork's own edit.
   */
  function sourceOnlyReconciliationRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file + own edit', { 'src/mp.ts': 'fork\n', 'src/shared.ts': 'fork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: upstream splits the module', {
      'src/split.ts': SPLIT_PARTIAL,
      'src/request.ts': IMPORTER,
    });
    repo.checkout('upside', { create: true, at: u0 });
    // ONLY the source module — the importing file is untouched.
    repo.commit('U2: upstream adds the missing export', { 'src/split.ts': SPLIT_RECONCILED });
    repo.checkout('main');
    repo.commit('U1: upstream edits the shared file', { 'src/shared.ts': 'up\n' });
    repo.merge('upside', 'U3: upstream merges the reconciliation');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * A branch RED AT ITS OWN TIP whose declaration IS reachable one commit up
   * its parent line — the pre-merge red the advance can actually repair, and
   * the only path on which a landed advance is the branch's ONLY mutation.
   */
  function preMergeRepairableRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'fork\n' });
    repo.commit('mp: takes upstream half-split', { 'src/split.ts': SPLIT_PARTIAL, 'src/request.ts': IMPORTER });
    repo.checkout('module/dep', { create: true, at: 'main_patched' });
    repo.commit('dep: its own edit', { 'src/dep.ts': 'dep\n' });
    repo.checkout('main_patched');
    repo.commit('mp: the missing export arrives', { 'src/split.ts': SPLIT_RECONCILED });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /** main_patched takes upstream's half-split; nothing above it reconciles the pair. */
  function unreachedRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/request.ts': BASE_REQUEST, 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file + own edit', { 'src/mp.ts': 'fork\n', 'src/shared.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U0: upstream splits the function', { 'src/request.ts': SPLIT_REQUEST });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * The reconciliation sits BEHIND a conflicting commit on the same line, so
   * merging it would drag the conflict in.
   */
  function reconciliationBehindConflictRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/request.ts': BASE_REQUEST, 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file + own edit', { 'src/mp.ts': 'fork\n', 'src/shared.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U0: upstream splits the function', { 'src/request.ts': SPLIT_REQUEST });
    repo.commit('U1: upstream edits the shared file', { 'src/shared.ts': 'up\n' });
    repo.commit('U2: upstream reconciles the pair', { 'src/request.ts': RECONCILED_REQUEST });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * A branch that is RED AT ITS OWN TIP, before this pass merges anything into
   * it — the shape a branch parked inside an unmerged upstream feature branch
   * has on EVERY pass, and the one the pre-merge check meets first.
   */
  function redBeforeAnyMergeRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/request.ts': BASE_REQUEST, 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file + own edit', { 'src/mp.ts': 'fork\n', 'src/shared.ts': 'fork\n' });
    repo.checkout('module/dep', { create: true, at: 'main_patched' });
    repo.commit('dep came to rest on the half-split state', { 'src/request.ts': SPLIT_REQUEST });
    repo.checkout('main_patched');
    // Something pending, so the branch PARTICIPATES and is checked at all.
    repo.commit('mp: unrelated work', { 'src/mp2.ts': 'more\n' });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * The reconciliation is a DAG SIBLING of the conflicting commit, so the walk
   * stops below both and the advance can still reach one of them.
   */
  function reconciliationBesideConflictRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/request.ts': BASE_REQUEST, 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file + own edit', { 'src/mp.ts': 'fork\n', 'src/shared.ts': 'fork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: upstream splits the function', { 'src/request.ts': SPLIT_REQUEST });
    repo.checkout('upside', { create: true, at: u0 });
    repo.commit('U2: upstream reconciles the pair', { 'src/request.ts': RECONCILED_REQUEST });
    repo.checkout('main');
    repo.commit('U1: upstream edits the shared file', { 'src/shared.ts': 'up\n' });
    repo.merge('upside', 'U3: upstream merges the reconciliation');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * UPSTREAM SPLIT THE CHANGE ACROSS SEVERAL COMMITS, so clearing the first
   * missing declaration uncovers the second. The source module gains one export
   * per commit; the importing file names both from the start.
   */
  const CHAIN_IMPORTER = [
    "import { handleAddMcpServer, escapeInvisibles } from './split.js';",
    'export const use = [handleAddMcpServer, escapeInvisibles];',
    '',
  ].join('\n');
  const CHAIN_NONE = ['export const zeta = 0;', ''].join('\n');
  const CHAIN_ONE = ['export const zeta = 0;', 'export const handleAddMcpServer = 3;', ''].join('\n');
  const CHAIN_BOTH = [
    'export const zeta = 0;',
    'export const handleAddMcpServer = 3;',
    'export const escapeInvisibles = 2;',
    '',
  ].join('\n');

  /** Red on the FIRST of the two symbols the source module still does not export. */
  function chainRunner(): ChecksRunner {
    return async (commands, cwd) => {
      if (!commands.some((c) => c.cmd === 'tsc --noEmit')) return { ok: true, failedNames: [], output: '' };
      const split = splitModule(cwd);
      if (!onABranch(cwd) || split === '') return { ok: true, failedNames: [], output: '' };
      const missing = ['handleAddMcpServer', 'escapeInvisibles'].find((sym) => !split.includes(sym));
      if (!missing) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['tsc --noEmit'],
        output:
          `$ tsc --noEmit\nsrc/request.ts(1,10): error TS2305: ` +
          `Module '\"./split.js\"' has no exported member '${missing}'.\n`,
      };
    };
  }

  /** The chained reconciliation, reached through a LANDING gate after a merge lands. */
  function chainedLandingRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file + own edit', { 'src/mp.ts': 'fork\n', 'src/shared.ts': 'fork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: upstream splits the module', {
      'src/split.ts': CHAIN_NONE,
      'src/request.ts': CHAIN_IMPORTER,
    });
    repo.checkout('upside', { create: true, at: u0 });
    repo.commit('U2: upstream adds the first export', { 'src/split.ts': CHAIN_ONE });
    repo.commit('U2b: upstream adds the second export', { 'src/split.ts': CHAIN_BOTH });
    repo.checkout('main');
    repo.commit('U1: upstream edits the shared file', { 'src/shared.ts': 'up\n' });
    repo.merge('upside', 'U3: upstream merges the reconciliation');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /** The same chain, on a branch that is RED AT ITS OWN TIP before any merge. */
  function chainedPreMergeRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'fork\n' });
    repo.commit('mp: takes upstream half-split', { 'src/split.ts': CHAIN_NONE, 'src/request.ts': CHAIN_IMPORTER });
    repo.checkout('module/dep', { create: true, at: 'main_patched' });
    repo.commit('dep: its own edit', { 'src/dep.ts': 'dep\n' });
    repo.checkout('main_patched');
    repo.commit('mp: the first export arrives', { 'src/split.ts': CHAIN_ONE });
    repo.commit('mp: the second export arrives', { 'src/split.ts': CHAIN_BOTH });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * A conflict stop reached on the PRE-MERGE check, on the first call of a
   * pass — so the branch has no conflict case of its own and cannot be pointed
   * at one.
   */
  function conflictStopWithNoCaseRepo(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/request.ts': BASE_REQUEST, 'src/shared.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'fork\n' });
    repo.checkout('module/dep', { create: true, at: 'main_patched' });
    repo.commit('dep rests on the half-split state and edits the shared file', {
      'src/request.ts': SPLIT_REQUEST,
      'src/shared.ts': 'dep\n',
    });
    repo.checkout('main_patched');
    repo.commit('mp: edits the shared file too', { 'src/shared.ts': 'mp\n' });
    repo.commit('mp: reconciles the pair', { 'src/request.ts': RECONCILED_REQUEST });
    repo.checkout('main');
    cleanups.push(() => repo.destroy());
    return repo;
  }

  it('advances past the half-split state, lands GREEN, and mints nothing', async () => {
    const repo = reconciliationBesideConflictRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    const cls = journal.find((e) => e.action === 'deps-missing-classified')!;
    expect(cls.depsMissing).toBe(true);
    expect(cls.files).toEqual(['src/request.ts']);
    const done = journal.find((e) => e.action === 'deps-missing-repaired')!;
    expect(done).toBeTruthy();
    expect(done.branch).toBe('main_patched');
    expect((done.steps as string[]).at(-1)).toMatch(/original-cleared$/);
    // THE POINT: the propagation repaired it. Nobody was handed anything.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'held')).toBe(false);
    // And the branch really carries the reconciliation now.
    expect(repo.git('show', 'main_patched:src/request.ts')).toContain('handleAddMcpServer');
    expect(journal.some((e) => e.action === 'landing-check' && e.branch === 'main_patched' && e.ok === true)).toBe(true);
  });

  it('an emptied original set with a NEW red is an ordinary red: the agent gets a gate fix', async () => {
    const repo = reconciliationBesideConflictRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner('other-red');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'deps-missing-changed')).toBeTruthy();
    expect(journal.some((e) => e.action === 'deps-missing-exhausted')).toBe(false);
    // The ordinary path took it from there — a case for the agent, not a hold.
    const gate = journal.find((e) => e.action === 'gate-fix')!;
    expect(gate.branch).toBe('main_patched');
    expect(journal.some((e) => e.action === 'held')).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toContain(String(gate.caseId));
  });

  it('a walk with nowhere to go publishes a DRAFT hold headed at the first errored commit, and serves nobody', async () => {
    const repo = unreachedRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();
    const out = join(ws, 'nc.json');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    // `run` DIRECTLY: `next-case` suppresses an internal stage's issues (§11), so
    // this id is only observable on the stage that raises it.
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true, out }), t.fn)).toBe(0);

    const journal = readJournal(dir);
    const walked = journal.find((e) => e.action === 'deps-missing-exhausted')!;
    expect(walked.stop).toBe('source-exhausted');
    expect(walked.candidates).toEqual([]);
    const landing = journal.find((e) => e.action === 'landing-check' && e.confirmed === true)!;
    expect(walked.firstErrored).toBe(landing.sha);
    // The branch stands where the errors first appeared, and the PR is headed there.
    expect(repo.sha('main_patched')).toBe(landing.sha);
    const held = journal.find((e) => e.action === 'held')!;
    expect(held.headSha).toBe(landing.sha);
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: missing declaration not reached]');
    // NO AGENT. The case exists to carry the report; it is never offered.
    expect(openCases(journal).map((c) => c.caseId)).not.toContain(String(held.caseId));
    // The driver wrote the PR text itself — there is no agent to write it.
    const body = readFileSync(join(dir, String(held.caseId), 'pr', 'body.md'), 'utf8');
    expect(readFileSync(join(dir, String(held.caseId), 'pr', 'title.txt'), 'utf8').trim()).not.toBe('');
    expect(body).toContain('handleAddMcpServer');
    expect(body).toContain('src/request.ts');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues?: Array<{ id: string }> };
    expect((res.issues ?? []).map((i) => i.id)).toContain('WARN23_DEPS_MISSING_HELD');
  });

  it('a step that would conflict ENDS the walk — a resolution cannot be validated on a red tree', async () => {
    const repo = reconciliationBehindConflictRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    const step = journal.filter((e) => e.action === 'deps-missing-step').at(-1)!;
    expect(step.verdict).toBe('conflict');
    expect(step.conflictedPaths).toEqual(['src/shared.ts']);
    const walked = journal.find((e) => e.action === 'deps-missing-exhausted')!;
    expect(walked.stop).toBe('conflict');
    expect(journal.find((e) => e.action === 'held')).toBeTruthy();
    // THE ROUTE TO THE DECLARATION SURVIVES. The walk stopped because the
    // reconciliation is behind a conflict, and the branch's own conflict case
    // is the way through it — superseding that case would take away the one
    // move that reaches the symbol.
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(false);
    expect(openCases(journal).map((c) => c.branch)).toEqual(['main_patched']);
  });

  it('the conflict stop tells the owner the declaration is REACHABLE, behind a conflict', async () => {
    const repo = reconciliationBehindConflictRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    const held = journal.find((e) => e.action === 'held')!;
    const body = readFileSync(join(dir, String(held.caseId), 'pr', 'body.md'), 'utf8');
    // The reconciliation IS in this repository — saying otherwise sends the
    // owner looking upstream for something that is one conflict away.
    expect(body).not.toContain('Nothing in this repository can supply the declaration');
    expect(body).toContain('behind a MERGE CONFLICT');
    expect(body).toContain('src/shared.ts');
    expect(body).toContain('IS in this repository');
  });

  it('a command with NO missingDeclRe never takes the advance — the same red mints an ordinary gate fix', async () => {
    const repo = unreachedRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws, null) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'deps-missing-classified')!.depsMissing).toBe(false);
    expect(journal.some((e) => e.action === 'deps-missing-exhausted')).toBe(false);
    const gate = journal.find((e) => e.action === 'gate-fix')!;
    expect(gate.branch).toBe('main_patched');
    expect(journal.some((e) => e.action === 'held')).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toContain(String(gate.caseId));
  });

  it('an ordinary red under the SAME pattern still mints a gate fix for the agent', async () => {
    const repo = unreachedRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    // Same tree, same config — only the diagnostic class differs.
    const fn: ChecksRunner = async (commands, cwd) => {
      const cmds = commands.map((c) => c.cmd);
      if (!cmds.includes('tsc --noEmit') || !halfSplit(cwd)) return { ok: true, failedNames: [], output: '' };
      return {
        ok: false,
        failedNames: ['tsc --noEmit'],
        output: `$ tsc --noEmit\nsrc/request.ts(2,14): error TS2345: Argument of type 'number' is not assignable.\n`,
      };
    };

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), fn);

    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'deps-missing-classified')!.depsMissing).toBe(false);
    expect(journal.some((e) => e.action === 'deps-missing-step')).toBe(false);
    const gate = journal.find((e) => e.action === 'gate-fix')!;
    expect(gate.branch).toBe('main_patched');
    expect(openCases(journal).map((c) => c.caseId)).toContain(String(gate.caseId));
  });

  it('a branch RED BEFORE ANY MERGE takes the walk too — the pre-merge check never mints for this red', async () => {
    const repo = redBeforeAnyMergeRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'dep', branch: 'module/dep', parents: ['main_patched'] }]);
    const dir = dirOf(repo, ws);
    const t = declRunner();
    const out = join(ws, 'nc.json');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn);

    const journal = readJournal(dir);
    // The red was CLASSIFIED before anything was attributed or minted.
    expect(journal.some((e) => e.action === 'deps-missing-classified')).toBe(true);
    const cls = journal.find((e) => e.action === 'deps-missing-classified')!;
    expect(cls.branch).toBe('module/dep');
    expect(cls.depsMissing).toBe(true);
    const walked = journal.find((e) => e.action === 'deps-missing-exhausted')!;
    expect(walked.branch).toBe('module/dep');
    expect(walked.stop).toBe('source-exhausted');
    // NOBODY WAS SERVED. The one thing an agent could do here is author the
    // symbol, and this whole rule exists to stop that.
    const held = journal.find((e) => e.action === 'held')!;
    expect(held.branch).toBe('module/dep');
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: missing declaration not reached]');
    expect(openCases(journal)).toHaveLength(0);
    expect(readFileSync(join(dir, String(held.caseId), 'pr', 'body.md'), 'utf8')).toContain('handleAddMcpServer');
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues?: Array<{ id: string }> };
    expect((res.issues ?? []).map((i) => i.id)).toContain('WARN23_DEPS_MISSING_HELD');
    // ORDERING: the classification is asked BEFORE anything attributes or mints
    // — ceiling attribution is the first step of handing a red to somebody.
    expect(journal.findIndex((e) => e.action === 'deps-missing-classified')).toBeLessThan(
      journal.findIndex((e) => e.action === 'gate-fix'),
    );
    // And no merge was made anywhere: a red branch merges nothing.
    expect(journal.some((e) => e.action === 'merge')).toBe(false);
  });

  it('the candidate set finds a reconciliation that touches ONLY the source module', async () => {
    const repo = sourceOnlyReconciliationRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), sourceOnlyRunner())).toBe(0);

    const journal = readJournal(dir);
    // The diagnostic names src/request.ts; the fix is in src/split.ts. A
    // pathspec over the failing files alone comes back empty here.
    expect(journal.find((e) => e.action === 'deps-missing-classified')!.files).toEqual(['src/request.ts']);
    const done = journal.find((e) => e.action === 'deps-missing-repaired')!;
    expect(done).toBeTruthy();
    expect(done.candidates).toHaveLength(1);
    expect(repo.git('show', 'main_patched:src/split.ts')).toContain('handleAddMcpServer');
    expect(journal.some((e) => e.action === 'held')).toBe(false);
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
  });

  it('an advance that lands with NO merge of its own is still rollable and still pushed', async () => {
    const repo = preMergeRepairableRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'dep', branch: 'module/dep', parents: ['main_patched'] }]);
    const dir = dirOf(repo, ws);
    const before = repo.sha('module/dep');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), sourceOnlyRunner());

    const journal = readJournal(dir);
    // The advance repaired a red the pass never merged into, so there is no
    // `merge` row for this branch to hide behind.
    expect(journal.some((e) => e.action === 'deps-missing-repaired')).toBe(true);
    expect(journal.find((e) => e.action === 'deps-missing-repaired')!.branch).toBe('module/dep');
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'module/dep')).toBe(false);
    expect(repo.git('show', 'module/dep:src/split.ts')).toContain('handleAddMcpServer');
    // THE ROLLBACK TARGET `abort` and `verify` read.
    const preRefs = journal.filter((e) => e.action === 'pre-ref' && e.branch === 'module/dep');
    expect(preRefs).toHaveLength(1);
    expect(preRefs[0].ref).toBe(before);
    // AND THE PUSH SET, which is otherwise derived from `merge`/`resolved` rows
    // alone and would ship this branch's advance nowhere.
    expect(journal.some((e) => e.action === 'deps-missing-step' && e.branch === 'module/dep' && e.landed === true)).toBe(
      true,
    );
    expect(mutatedBranches(journal).has('module/dep')).toBe(true);
  });

  it('a CHANGED red that is ANOTHER missing declaration re-enters the walk — the landing gate mints nothing', async () => {
    const repo = chainedLandingRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), chainRunner())).toBe(0);

    const journal = readJournal(dir);
    // The first walk cleared its own error set and left a DIFFERENT missing
    // declaration standing. That red is not the agent's to write either.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'held')).toBe(false);
    expect(journal.find((e) => e.action === 'deps-missing-changed')).toBeTruthy();
    expect(journal.find((e) => e.action === 'deps-missing-repaired')).toBeTruthy();
    expect(repo.git('show', 'main_patched:src/split.ts')).toContain('escapeInvisibles');
    // THE BUDGET IS THE BRANCH'S, NOT THE WALK'S — a bound that reset on every
    // re-entry would bound nothing.
    expect(journal.filter((e) => e.action === 'deps-missing-changed' || e.action === 'deps-missing-repaired').map((e) => e.limit)).toEqual([
      10, 9,
    ]);
  });

  it('a CHANGED red that is ANOTHER missing declaration re-enters the walk on the PRE-MERGE path too', async () => {
    const repo = chainedPreMergeRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'dep', branch: 'module/dep', parents: ['main_patched'] }]);
    const dir = dirOf(repo, ws);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), chainRunner());

    const journal = readJournal(dir);
    // Nobody was handed a missing symbol to author, on either red.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'held')).toBe(false);
    expect(journal.find((e) => e.action === 'deps-missing-changed')!.branch).toBe('module/dep');
    expect(journal.find((e) => e.action === 'deps-missing-repaired')!.branch).toBe('module/dep');
    expect(repo.git('show', 'module/dep:src/split.ts')).toContain('escapeInvisibles');
  });

  it('a conflict stop with NO conflict case on the branch does not point the owner at one', async () => {
    const repo = conflictStopWithNoCaseRepo();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'dep', branch: 'module/dep', parents: ['main_patched'] }]);
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    expect(journal.find((e) => e.action === 'deps-missing-exhausted')!.stop).toBe('conflict');
    // The pre-merge check catches this red before `run` mints anything, and
    // cases do not survive a pass — so there is no case to resolve.
    expect(openCases(journal).filter((c) => c.branch === 'module/dep')).toHaveLength(0);
    const held = journal.find((e) => e.action === 'held')!;
    const body = readFileSync(join(dir, String(held.caseId), 'pr', 'body.md'), 'utf8');
    expect(body).toContain('behind a MERGE CONFLICT');
    expect(body).toContain('this pass has no open conflict case on this branch');
    expect(body).not.toContain("this branch's own conflict case");
  });

  it('a conflict stop WITH a conflict case names it, so the owner can find the route', async () => {
    const repo = reconciliationBehindConflictRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    const conflictCase = openCases(journal).find((c) => c.branch === 'main_patched')!;
    const held = journal.find((e) => e.action === 'held')!;
    const body = readFileSync(join(dir, String(held.caseId), 'pr', 'body.md'), 'utf8');
    expect(body).toContain(conflictCase.caseId);
  });

  it('a case served on the same call as a hold is TOLD which red is not its to fix', async () => {
    const repo = reconciliationBehindConflictRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();
    const out = join(ws, 'nc.json');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn);

    // THE CONFLICT STOP DELIBERATELY DOES NOT REOPEN, so the branch's own
    // conflict case is still open and is served on this very call — on a branch
    // that is red with a missing declaration outside that case's scope.
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      status: string;
      materials?: string;
      issues?: Array<{ id: string }>;
    };
    expect(res.status).toBe('case-ready');
    expect((res.issues ?? []).map((i) => i.id)).toContain('WARN23_DEPS_MISSING_HELD');
    expect(res.materials).toContain('WARN23_DEPS_MISSING_HELD');
    expect(res.materials).toContain('do NOT write the');
  });

  it('a SPENT walk is held, not minted — the ordinary path never attributes that red', async () => {
    const repo = unreachedRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();
    const out = join(ws, 'nc2.json');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), t.fn);

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'deps-missing-walk-spent')).toBe(true);
    // THE SIDE DOOR (§7.7): the same-branch anti-loop stops a same-key mint, but
    // a lift onto an in-pass ancestor mints under a FRESH key. Nothing attributes
    // this red at all, so there is no lift to mint behind.
    expect(journal.filter((e) => e.action === 'gate-fix-ceiling')).toHaveLength(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues?: Array<{ id: string }> };
    expect((res.issues ?? []).map((i) => i.id)).toContain('WARN23_DEPS_MISSING_HELD');
  });

  it('the walk is taken ONCE per branch per pass — a second call re-walks nothing and mints nothing more', async () => {
    const repo = unreachedRepo();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const t = declRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: checksWithPattern(ws) }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);
    await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn);

    const journal = readJournal(dir);
    expect(journal.filter((e) => e.action === 'deps-missing-exhausted')).toHaveLength(1);
    expect(journal.filter((e) => e.action === 'deps-missing-step')).toHaveLength(0);
    expect(journal.filter((e) => e.action === 'gate-fix')).toHaveLength(1);
    expect(journal.filter((e) => e.action === 'held')).toHaveLength(1);
  });
});


/**
 * A check's verdict is a fact about the SUBTREE its `cwd` names, so branches
 * carrying the identical subtree share one verdict and branches that do not are
 * each measured — and a confirming re-run is taken somewhere else.
 */
describe('run — a verdict belongs to the subtree the check ran in', () => {
  /** A runner that records the commands AND the worktree each run was taken in. */
  function subtreeRunner(redWhen?: (cmd: string, wt: string) => boolean): {
    fn: ChecksRunner;
    ran: Array<{ cmds: string[]; cwd: string }>;
  } {
    const ran: Array<{ cmds: string[]; cwd: string }> = [];
    const fn: ChecksRunner = async (commands, cwd) => {
      ran.push({ cmds: commands.map((c) => c.cmd), cwd });
      const failedNames = commands.filter((c) => redWhen?.(c.cmd, cwd)).map((c) => c.cmd);
      return {
        ok: failedNames.length === 0,
        failedNames,
        output: failedNames.length ? `$ ${failedNames[0]}\nsrc/x.ts(1,1): error TS2345: broken.\n` : '',
      };
    };
    return { fn, ran };
  }
  /** The shipped shape: a root typecheck and a test command rooted in a SUBDIRECTORY. */
  function cwdChecks(ws: string): string {
    const f = join(ws, 'checks.json');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }],
        test: [{ cmd: 'bun test', cwd: 'container/agent-runner', filter: 'bun test {files}' }],
      }),
    );
    return f;
  }
  const runsOf = (ran: Array<{ cmds: string[] }>, cmd: string): number => ran.filter((r) => r.cmds.includes(cmd)).length;
  /** A fork whose descendant may or may not touch the agent runner. */
  function runnerRepo(childTouchesRunner: boolean): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base', {
      'src/x.ts': 'orig\n',
      'container/agent-runner/src/poll.test.ts': 'ok\n',
    });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'mp\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit(
      'cg work',
      childTouchesRunner
        ? { 'src/cg.ts': 'cg\n', 'container/agent-runner/src/cg.test.ts': 'cg\n' }
        : { 'src/cg.ts': 'cg\n' },
    );
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  it('two branches carrying the identical subtree share its verdict — the suite runs once, not once per branch', async () => {
    const repo = runnerRepo(false);
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const t = subtreeRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: cwdChecks(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    const mp = journal.find((e) => e.action === 'landing-check' && e.branch === 'main_patched')!;
    const cg = journal.find((e) => e.action === 'landing-check' && e.branch === 'module/cg')!;
    expect(mp.ok).toBe(true);
    expect(cg.ok).toBe(true);
    // Both branches LANDED different trees, so neither inherits the other's
    // whole-tree verdict...
    expect(cg.tree).not.toBe(mp.tree);
    // ...but `bun test` runs in `container/agent-runner`, and that subtree is the
    // same object on both. One measurement answers for both, and the journal says
    // where it was taken.
    const bunOf = (row: JournalEntry): { subtree: string; ok: boolean; measuredOn?: string } =>
      (row.checks as Array<{ cmd: string; subtree: string; ok: boolean; measuredOn?: string }>).find(
        (c) => c.cmd === 'bun test',
      )!;
    expect(bunOf(cg).subtree).toBe(bunOf(mp).subtree);
    expect(bunOf(cg).subtree).toBe(repo.git('rev-parse', 'module/cg:container/agent-runner'));
    expect(bunOf(cg).measuredOn).toBe('main_patched');
    expect(runsOf(t.ran, 'bun test')).toBe(1);
    // The root typecheck measures the WHOLE tree, which the two do not share, so
    // it is not inherited: sharing follows the bytes, never the branch.
    const tscOf = (row: JournalEntry): { measuredOn?: string } =>
      (row.checks as Array<{ cmd: string; measuredOn?: string }>).find((c) => c.cmd === 'tsc --noEmit')!;
    expect(tscOf(cg).measuredOn).toBeUndefined();
    expect(journal.filter((e) => e.action === 'arrived').map((e) => e.branch)).toContain('module/cg');
  });

  it('a branch whose relevant subtree DIFFERS is measured on its own', async () => {
    const repo = runnerRepo(true);
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'], owned: ['src/cg.ts'] }]);
    const dir = dirOf(repo, ws);
    const t = subtreeRunner();

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: cwdChecks(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const journal = readJournal(dir);
    const cg = journal.find((e) => e.action === 'landing-check' && e.branch === 'module/cg')!;
    const bun = (cg.checks as Array<{ cmd: string; subtree: string; measuredOn?: string }>).find((c) => c.cmd === 'bun test')!;
    // The child added a file under the runner, so its subtree is a different
    // object and nothing about it has been measured. It pays for its own run.
    expect(bun.subtree).toBe(repo.git('rev-parse', 'module/cg:container/agent-runner'));
    expect(bun.subtree).not.toBe(repo.git('rev-parse', 'main_patched:container/agent-runner'));
    expect(bun.measuredOn).toBeUndefined();
    expect(runsOf(t.ran, 'bun test')).toBe(2);
  });

  it('a red confirmed for another command, or on another subtree, authorises nothing here', async () => {
    // Both commands run at the ROOT here, so the only thing separating their
    // verdicts is the command itself — and the seeded confirmations differ from
    // the failing one in exactly one coordinate each.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n', 'container/agent-runner/src/poll.test.ts': 'ok\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: own file', { 'src/mp.ts': 'mp\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const f = join(ws, 'checks.json');
    writeFileSync(
      f,
      JSON.stringify({ typecheck: [{ cmd: 'tsc --noEmit', cwd: '.' }], test: [{ cmd: 'vitest run', cwd: '.' }] }),
    );
    // `vitest run` is red on the FIRST ask of a call and green on every re-run of
    // it — alone AND under the replayed command sequence — so each call's
    // observation is contradicted by its own confirming probe: the load window
    // opens, is measured, and has closed by the time either second run is
    // prepared. It never earns a confirmation.
    let asked = 0;
    const t = subtreeRunner((cmd) => cmd === 'vitest run' && ++asked === 1);

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: f }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(1);
    const landed = readJournal(dir).find((e) => e.action === 'landing-check' && e.unstable === true)!;
    expect(landed.branch).toBe('main_patched');

    // Two confirmed reds the pass could mistake for this one: the SAME subtree
    // under a different command, and the SAME command on a different subtree.
    appendJournal(dir, {
      action: 'red-confirm',
      branch: 'main_patched',
      sha: repo.sha('main_patched'),
      cmd: 'tsc --noEmit',
      subtree: landed.tree,
      commands: ['tsc --noEmit'],
      ran: true,
      reproduced: true,
    });
    appendJournal(dir, {
      action: 'red-confirm',
      branch: 'main_patched',
      sha: repo.sha('main_patched'),
      cmd: 'vitest run',
      cwd: 'container/agent-runner',
      subtree: repo.git('rev-parse', 'main_patched:container/agent-runner'),
      commands: ['vitest run'],
      ran: true,
      reproduced: true,
    });

    // The tree is still owed a verdict, so this call measures it again — and
    // neither seeded row answers for `vitest run` on the landed tree.
    asked = 0; // the load window opens again for the second call's first ask
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(1);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'case')).toBe(false);
    const fresh = journal.filter((e) => e.action === 'red-confirm' && e.cmd === 'vitest run' && e.subtree === landed.tree);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((e) => e.reproduced === false)).toBe(true);
  });

  it('the confirming re-run is prepared afresh, and the journal states what was varied', async () => {
    const repo = runnerRepo(false);
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    // Deterministically red: the question here is HOW the second observation was
    // taken, not what it said.
    const t = subtreeRunner((cmd) => cmd === 'bun test');

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: cwdChecks(ws) }))).toBe(0);
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv), t.fn)).toBe(0);

    const bunRuns = t.ran.filter((r) => r.cmds.includes('bun test'));
    expect(bunRuns).toHaveLength(2);
    // THE POINT: not the same worktree twice. The first run's environment is the
    // one the red was seen in; the second is checked out and installed again.
    expect(bunRuns[1].cwd).not.toBe(bunRuns[0].cwd);

    const confirm = readJournal(dir).find((e) => e.action === 'red-confirm')!;
    expect(confirm.reproduced).toBe(true);
    const variation = confirm.variation as {
      freshWorktree: string;
      freshInstall: boolean;
      separatedMs: number;
      loadIsolated: boolean;
    };
    expect(variation.freshWorktree).toBe(bunRuns[1].cwd);
    expect(variation.freshInstall).toBe(true);
    expect(typeof variation.separatedMs).toBe('number');
    // WHAT IT DOES NOT CLAIM. The container is shared, so the driver cannot say
    // the second run was quiet — only that it was prepared separately.
    expect(variation.loadIsolated).toBe(false);
  });

  it('a red whose re-run cannot be PREPARED founds no case: there is no second observation', async () => {
    const repo = runnerRepo(false);
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    // The environment goes away between the two observations: the fresh worktree
    // for the confirming run cannot be installed.
    let broken = false;
    const install: InstallRunner = async (wt) => {
      if (broken) return { ok: false, failure: { command: 'pnpm install', cwd: '.', output: 'no network' } };
      mkdirSync(join(wt, 'node_modules'), { recursive: true });
      return { ok: true };
    };
    const t = subtreeRunner((cmd) => {
      if (cmd !== 'bun test') return false;
      broken = true;
      return true;
    });

    expect(await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: cwdChecks(ws), installRunner: install }))).toBe(0);
    await cmdSweepNextCase(baseCli(repo, ws, inv, { installRunner: install }), t.fn);

    const journal = readJournal(dir);
    // No second observation, so the first one stands alone — and one observation
    // may not found a case. The branch is not green either: it did not arrive.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    const confirm = journal.find((e) => e.action === 'red-confirm')!;
    expect(confirm.ran).toBe(false);
    expect(confirm.unmeasurable).toBe(true);
    expect(confirm.reproduced).toBe(false);
    // The landing carries no verdict at all — an unmeasured tree, said out loud,
    // rather than a red one attributed to the branch that happened to be under it.
    const row = journal.find((e) => e.action === 'landing-check' && e.reason === 'environment-fault')!;
    expect(row.branch).toBe('main_patched');
    expect(row.id).toBe('WARN14_ENVIRONMENT_FAULT');
    expect(row.ok).toBeUndefined();
  });
});

describe('sweep finish — gate-fix on an unattributable red', () => {
  // Serving hazard: `crashHeal` must not journal `resolved` for every
  // gate-fix case on the next command. Its heuristic is "the ref already
  // contains the case head, so it was resolved before a crash" — but a gate-fix
  // case's head IS the branch tip, and a commit is its own ancestor, so it
  // matches instantly. `openCases` would then drop it and `next-case` answer
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

  it('NOT minted beneath an ancestor that already took a gate fix this pass', async () => {
    // When the trunk freezes with a gate fix, the driver must not mint a
    // SECOND gate fix on its descendant — that is
    // work downstream of a trunk the pass has already stopped
    // on. The cross-pass skip reads ORIGIN refs, which do not exist until finish
    // publishes, so within a pass it blocks nothing on its own.
    const repo = gateFixRepo();
    // Something for the build to actually cover: a gate-held branch and
    // everything under it are out of the recipe, so without an unrelated member
    // the rebuild is vacuous and no red is produced to blame anyone for.
    repo.checkout('module/ind', { create: true, at: 'main_patched' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', owned: ['src/x.ts'], parents: ['main_patched'] },
      { id: 'ind', branch: 'module/ind' },
    ]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    // The trunk took a gate fix earlier in THIS pass and is red. This is the
    // AGENT-HELD shape — a held gate-FIX case, which carries no `reason` at all
    // (only the §9 rollback hold does). A guard matching on `reason: 'gate'`
    // would never fire on this shape — the one that actually occurs.
    appendJournal(dir, { action: 'gate-fix', branch: 'main_patched', caseId: 'gate-fix-main_patched-dead' });
    appendJournal(dir, { action: 'held', branch: 'main_patched', caseId: 'gate-fix-main_patched-dead' });

    const out = join(ws, 'f1.json');
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out }));

    const journal = readJournal(dir);
    // No second gate fix on the descendant...
    expect(journal.some((e) => e.action === 'gate-fix' && e.branch === 'module/cg')).toBe(false);
    // ...and the reason is on the record, naming the ancestor.
    const skipped = journal.find((e) => e.action === 'gate-fix-skipped' && e.id === 'WARN20_ANCESTOR_GATED');
    expect(skipped).toBeTruthy();
    // The two branches sit in fields that say which is which. This row is the
    // only one carrying the failing FILES, so a `branch` field on it reads as
    // "the branch that owns them" — which is the branch it is NOT.
    expect(skipped!.skipped).toBe('module/cg');
    expect(skipped!.owner).toBe('main_patched');
    expect(skipped!.branch).toBeUndefined();
    // The owner leads the sentence for the same reason.
    expect(skipped!.detail as string).toMatch(/^'main_patched' took a gate fix/);
  });

  it('a LOCATED owner (--not-my-bug) is minted even beneath a gate-held ancestor', async () => {
    // The ancestor gate is for the FINISH path, where blame is by elimination
    // and therefore unreliable beneath a red ancestor. `--not-my-bug` proves the
    // failure pre-existing and LOCATES the owner by probing, so refusing it
    // discards evidence — round after round naming
    // the same owner from different case branches, recording nothing.
    const repo = gateFixRepo();
    // An unrelated recipe member, so the rebuild covers something: the gate-held
    // trunk and everything under it are out of it.
    repo.checkout('module/ind', { create: true, at: 'main_patched' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', owned: ['src/x.ts'], parents: ['main_patched'] },
      { id: 'ind', branch: 'module/ind' },
    ]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const { cmds } = redUntilCleared(ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    // The trunk is gate-held this pass — the condition that refused the mint.
    appendJournal(dir, { action: 'gate-fix', branch: 'main_patched', caseId: 'gate-fix-main_patched-dead' });
    appendJournal(dir, { action: 'held', branch: 'main_patched', caseId: 'gate-fix-main_patched-dead' });

    const before = readJournal(dir).filter((e) => e.action === 'gate-fix').length;
    await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds }));
    const j = readJournal(dir);
    // The FINISH path still defers to the ancestor gate…
    expect(j.some((e) => e.action === 'gate-fix-skipped' && e.id === 'WARN20_ANCESTOR_GATED')).toBe(true);
    expect(j.filter((e) => e.action === 'gate-fix').length).toBe(before);
  });

  /**
   * FINISH BLAMES BY ELIMINATION, SO FINISH MEASURES.
   *
   * The integration verify reds on a build of many branches and attribution reads
   * the log, which names the file that REPORTED the failure — not necessarily the
   * one that caused it. That is an upper bound on where blame may go, never
   * evidence that the branch it names is red. So the mint measures each blamed
   * branch at the commit the case would be rooted on, and a branch that is GREEN
   * there is not handed a case: the red exists only in the integration, which is
   * the leave-one-out rollback's shape, not an agent's.
   */
  it('a blamed branch that is GREEN at its own tip is not handed a finish gate fix', async () => {
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
    const asked: Array<{ branch: string; sha: string }> = [];
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out }),
        undefined,
        async (branch, sha) => {
          asked.push({ branch, sha });
          return 'green';
        },
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    // NO CASE ON A BRANCH THAT PASSES. Blame named it; the measurement did not.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    expect(journal.some((e) => e.action === 'case' && e.gateFix === true)).toBe(false);
    // And it was asked about the branch it was about to accuse, at that branch's tip.
    expect(asked.map((a) => a.branch)).toEqual(['module/cg']);
    expect(asked[0].sha).toBe(repo.sha('module/cg'));
    // The drop is a row, with the coordinate a reader can check.
    const skipped = journal.find((e) => e.action === 'gate-fix-skipped' && e.skipped === 'module/cg')!;
    expect(skipped.detail).toContain('green at its own tip');
    expect(skipped.at).toBe(repo.sha('module/cg'));
    expect((skipped.subtrees as Array<{ subtree: string }>).length).toBeGreaterThan(0);
    // AND IT LEAVES BY A DOOR THAT ALREADY EXISTS: no case was served, so this is
    // the ordinary "nothing to mint" ending, carrying the reason.
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status?: string; instruction: string; issues?: Array<{ id: string }> };
    expect(res.status).not.toBe('gate-fix-required');
    expect(res.instruction).toContain('integration-only');
    expect(res.instruction).toContain('leave-one-out rollback');
    // Nothing landed: the red still gates the pass.
    expect(journal.some((e) => e.action === 'pr-published')).toBe(false);
    expect(journal.some((e) => e.action === 'push')).toBe(false);
  });

  /**
   * AND WHEN IT MEASURES RED, IT SAYS SO IN THE JOURNAL. The default confirmer
   * takes the observation for real — a fresh worktree at the branch tip, its own
   * install, the failing commands, and the varied re-run every other accusation
   * pays for — so the case rests on a measurement of THAT branch rather than on a
   * log that merely named one of its files.
   */
  it('a blamed branch measured RED at its own tip is served, and the measurement is journaled', async () => {
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
    // No confirmer injected: the production one runs, in real worktrees.
    expect(
      await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
    ).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { status: string; gateFix: { branch: string } };
    expect(res.status).toBe('gate-fix-required');
    expect(res.gateFix.branch).toBe('module/cg');
    const journal = readJournal(dir);
    // THE POINT: the case rests on rows this path wrote, naming the branch it
    // accuses and the gate that took the measurement.
    const confirms = journal.filter((e) => e.action === 'red-confirm' && e.phase === 'finish');
    expect(confirms.length).toBeGreaterThan(0);
    expect(confirms.every((e) => e.branch === 'module/cg')).toBe(true);
    expect(confirms.every((e) => e.sha === repo.sha('module/cg'))).toBe(true);
    expect(confirms.some((e) => e.reproduced === true)).toBe(true);
  });

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
   * BATCHING (owner-approved). A red build routinely names files that
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
   * THE ID STATES THE TRUTH. A gate fix has no merge and therefore no
   * height, so `--case` must not validate it against the CONFLICT id shape
   * (`…-h<n>`): refusing a bare `gate-fix-<branch>` with ERR25_BAD_CASE_ID
   * would keep every HELD gate fix from publishing however green the rest of
   * the pipeline is, and a FAKE `-h-1` height would
   * flow into the fix-ref name, into the origin ref reader, and into every
   * height reader downstream. The id states the case's real identity
   * (branch + failing-file digest) and the N5 guard accepts that shape AS
   * ITSELF; the head carries its real height.
   */
  it('the gate-fix case file states the truth: identity id, real height, tip tree', async () => {
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
      automergeTree: string;
      deferredCheck: { firstConflictHeight: number };
    };
    // The head IS the branch tip; its height is that tip's real coverage on the
    // pass chain (`deriveCoverage`), so every height reader computes from a
    // fact — see the machine-block test below for what a -1 would cost.
    expect(cf.head.sha).toBe(repo.sha('module/cg'));
    // The branch absorbed the trunk during this pass's run, so its coverage is a
    // real chain index — never a -1 placeholder.
    expect(Number(repo.git('rev-list', '--count', 'module/cg..main').trim())).toBe(0);
    expect(cf.head.height).toBeGreaterThanOrEqual(0);
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
   * WHAT A FAKE HEIGHT WOULD COST. The machine block on a held PR reports
   * `pendingAbove = chain.heads.length - 1 - head.height`. With `head.height =
   * -1` that is `heads.length` — MORE pending commits than the pass's chain
   * even holds — on every held gate-fix PR, for a branch that has in fact
   * absorbed the whole trunk this pass. The head's height is the tip's
   * coverage, so the count is the truth.
   *
   * The fix REF NAME is the same hazard in the other direction: a lie spells
   * `--<slug('(gate-fix)')>-h-1-<sha8>`, putting a parent label that is not a
   * branch and a height that does not exist into a name the NEXT pass's origin
   * reader parses a real scope branch and a real trunk height out of.
   */
  it('a held gate fix publishes with a truthful pending-commits count and an honest fix-ref name', async () => {
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
    expect(journal.some((e) => e.action === 'gate-fix-skipped' && e.skipped === 'module/cg')).toBe(true);
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
  /**
   * Red on the full recipe, red again on the identical re-run, GREEN once a
   * branch is removed, red on the re-verify.
   *
   * Run 2 is the determinism probe: verify re-runs the SAME tree before
   * attributing, because attribution is meaningless under a flaky test. A
   * DETERMINISTIC failure — which is what this fixture models — must fail twice
   * before anything else happens.
   *
   * Run 3 is the base probe: the base alone must come back GREEN here,
   * because this fixture models a failure a BRANCH introduced. Run 4 is the
   * leave-one-out build that isolates it, also green. The stub sequences by call
   * count, so both of those are green and everything else is red.
   */
  function redRedGreenGreenRed(ws: string): string {
    const f = join(ws, 'cmds.json');
    const counter = join(ws, 'verify-runs');
    writeFileSync(
      f,
      JSON.stringify([
        {
          cmd:
            `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > ${counter}; ` +
            `if [ "$n" -ge 3 ] && [ "$n" -le 4 ]; then exit 0; fi; echo boom; exit 1`,
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
    const cmds = redRedGreenGreenRed(ws);
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

  /**
   * A CONFLICT in the integration rebuild is reported as a conflict.
   *
   * The rollback is right — a branch that cannot integrate must not publish —
   * but it left `finish` narrating the freeze in the checks-red wording, and the
   * agent relayed that: a branch accused with no evidence, and a reader sent to
   * hunt for a red test that never ran. The result the report is built from now
   * says which kind of failure it was and where the collision is.
   */
  describe('finish — a rebuild MERGE CONFLICT is not reported as a failing check', () => {
    /** Two siblings under main_patched editing the SAME line: they merge one at
     * a time cleanly, and collide only in the everything-rebuild. */
    function siblingCollisionFixture(): FixtureRepo {
      const repo = initFixtureRepo();
      repo.commit('base: s', { 'src/s.ts': 'orig\n' });
      repo.checkout('main_patched', { create: true, at: 'main' });
      repo.commit('mp: y', { 'src/y.ts': 'fork\n' });
      repo.checkout('feat/a', { create: true, at: 'main_patched' });
      repo.commit('a: s = AAA', { 'src/s.ts': 'AAA\n' });
      repo.checkout('feat/b', { create: true, at: 'main_patched' });
      repo.commit('b: s = BBB', { 'src/s.ts': 'BBB\n' });
      repo.checkout('main');
      repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // upstream advances -> the pass has work
      cleanups.push(() => repo.destroy());
      return repo;
    }

    it('names the conflict and its paths, and carries them in the result', async () => {
      const repo = siblingCollisionFixture();
      const ws = mkWorkspace();
      const inv = writeInventory([
        { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
        { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      ]);
      const dir = dirOf(repo, ws);
      repo.attachBareOrigin();
      repo.git('push', 'origin', 'main_patched', 'feat/a', 'feat/b');
      const cmds = join(ws, 'cmds.json');
      writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }])); // every check is GREEN: only the merge fails
      await cmdSweepStart(baseCli(repo, ws, inv));
      await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
      const out = join(ws, 'f1.json');
      expect(
        await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
      ).toBe(1);
      const journal = readJournal(dir);
      const gateHold = journal.find((e) => e.action === 'held' && e.reason === 'gate')!;
      expect(gateHold.failureKind).toBe('merge-conflict');
      const res = JSON.parse(readFileSync(out, 'utf8')) as {
        failureKind?: string;
        offender?: string;
        unresolved?: string[];
        reverify?: { ok: boolean };
        issues: Array<{ id: string; detail: string }>;
      };
      expect(res.failureKind).toBe('merge-conflict');
      expect(res.offender).toBe(gateHold.branch);
      expect(res.unresolved).toEqual(['src/s.ts']);
      const detail = res.issues.find((i) => i.id === 'ERR18_VERIFY_PENDING')!.detail;
      expect(detail).toContain('could not be merged into the integration rebuild');
      expect(detail).toContain('src/s.ts');
      // …and it does not send the reader after a red suite that never ran.
      expect(detail).not.toContain('no clean attribution');
      expect(detail).toContain('no command ran on the conflicting build');
      // The re-verify without the offender was green, and the result says so.
      expect(res.reverify).toMatchObject({ ok: true });
    });

    /**
     * A conflict does not make the rest of the recipe green.
     *
     * The rollback removes the branch that would not merge; the branches that
     * remain can still fail a check for reasons of their own. Reporting only the
     * conflict there states "nothing else failed" over a red build and promises a
     * re-run that clears it — the second failure would reach the owner in no
     * message at all.
     */
    it('a SECOND failure surviving the rollback is reported alongside the conflict', async () => {
      const repo = siblingCollisionFixture();
      const ws = mkWorkspace();
      const inv = writeInventory([
        { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
        { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      ]);
      const dir = dirOf(repo, ws);
      repo.attachBareOrigin();
      repo.git('push', 'origin', 'main_patched', 'feat/a', 'feat/b');
      // Red on EVERY run: the conflict stops build 1, and the re-verify without
      // the offender then fails this check — a failure the conflict did not cause.
      const cmds = join(ws, 'cmds.json');
      writeFileSync(cmds, JSON.stringify([{ cmd: 'echo boom; exit 1' }]));
      await cmdSweepStart(baseCli(repo, ws, inv));
      await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
      const out = join(ws, 'f1.json');
      expect(
        await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
      ).toBe(1);
      const res = JSON.parse(readFileSync(out, 'utf8')) as {
        failureKind?: string;
        reverify?: { ok: boolean; failedCommands?: string[] };
        issues: Array<{ id: string; detail: string }>;
      };
      expect(res.failureKind).toBe('merge-conflict');
      expect(res.reverify?.ok).toBe(false);
      expect(res.reverify?.failedCommands).toEqual(['echo boom; exit 1']);
      const detail = res.issues.find((i) => i.id === 'ERR18_VERIFY_PENDING')!.detail;
      expect(detail).toContain('could not be merged into the integration rebuild'); // still says the conflict
      expect(detail).toContain('SECOND, separate failure'); // …and does not stop there
      expect(detail).not.toContain('Nothing else failed');
      // The re-verify's own red is on the record, not just in the message.
      const rolled = readJournal(dir).find((e) => e.action === 'verify' && e.rolledBackFor === 'merge-conflict')!;
      expect(rolled.ok).toBe(false);
      expect(rolled.reverifyFailedCommands).toEqual(['echo boom; exit 1']);
      expect(rolled.failureKind).toBeUndefined(); // the row's verdict is the re-verify's, not the conflict's
    });
  });

  // --- finish must not verify a base that is under repair ---------------------
  describe('finish — a gated BASE is not re-verified', () => {
    it('skips verify, rolls nothing back, and says the owner must merge the base gate fix', async () => {
      const repo = rollbackFixture();
      const ws = mkWorkspace();
      const inv = writeInventory([{ id: 'other', branch: 'feat/other', parents: ['main_patched'] }]);
      const dir = dirOf(repo, ws);
      const bare = repo.attachBareOrigin();
      repo.git('push', 'origin', 'main_patched', 'feat/other');
      await cmdSweepStart(baseCli(repo, ws, inv));
      await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
      // An OPEN gate fix on the base: exactly what `next-case` already honours.
      repo.git('push', 'origin', 'main_patched:refs/heads/fix/sweep/main_patched--gate-fix-main_patched-deadbeef');
      repo.git('fetch', 'origin', '--prune', '+refs/heads/fix/sweep/*:refs/remotes/origin/fix/sweep/*');

      // A command list that would be RED if it ever ran — it must not.
      const cmds = join(ws, 'never.json');
      writeFileSync(cmds, JSON.stringify([{ cmd: 'echo should-not-run; exit 1' }]));
      const out = join(ws, 'f.json');
      const before = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate').length;
      expect(
        await cmdSweepFinish(baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: cmds, out })),
      ).toBe(1);

      const journal = readJournal(dir);
      const skipped = journal.find((e) => e.action === 'verify-skipped' && e.id === 'WARN18_BASE_GATED');
      expect(skipped).toBeTruthy();
      expect(skipped!.branch).toBe('main_patched');
      // No verify ran, and NO branch was accused or frozen.
      expect(journal.some((e) => e.action === 'verify')).toBe(false);
      expect(journal.filter((e) => e.action === 'held' && e.reason === 'gate').length).toBe(before);
      const res = JSON.parse(readFileSync(out, 'utf8')) as { stoppedAt?: string; instruction?: string };
      expect(res.stoppedAt).toBe('base-gated');
      expect(res.instruction).toMatch(/merge/i);
      expect(bare).toBeTruthy();
    });
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
    const inv = branchlessInventory();
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
describe('report-case — a green that follows a red is confirmed', () => {
  /** Checks that fail, then pass, then fail again — a flaky suite. */
  function redGreenRedChecks(ws: string): string {
    const f = join(ws, 'checks.json');
    const counter = join(ws, 'gate-runs');
    writeFileSync(
      f,
      JSON.stringify({
        typecheck: [],
        test: [
          {
            cmd:
              `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > ${counter}; ` +
              `if [ "$n" -eq 2 ]; then exit 0; fi; echo boom; exit 1`,
          },
        ],
      }),
    );
    return f;
  }

  it('a pass that does not reproduce is WARN21, not a resolved case', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const checksFile = redGreenRedChecks(ws);
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile }));
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile }), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });

    // Run 1: red — the ordinary failure path.
    const o1 = join(ws, 'r1.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, checksFile, out: o1 }),
        neverInvoked,
      ),
    ).toBe(1);
    expect(readJournal(dir).some((e) => e.action === 'checks-fail' && e.caseId === caseId)).toBe(true);

    // Run 2: the gate passes (run 2 of the stub) — but the CONFIRM run is run 3,
    // which is red again. Without the confirm this case would have resolved on a
    // coincidence and the flaky check would have gone unreported.
    const o2 = join(ws, 'r2.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, checksFile, out: o2 }),
        neverInvoked,
      ),
    ).toBe(1);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'checks-nondeterministic' && e.id === 'WARN21_CHECKS_FLAKY')).toBe(true);
    expect(journal.some((e) => e.action === 'checks-pass' && e.caseId === caseId)).toBe(false);
    expect(journal.some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    const res = JSON.parse(readFileSync(o2, 'utf8')) as { instruction: string };
    expect(res.instruction).toContain('NON-DETERMINISTIC');
    expect(res.instruction).toContain('--tier held');
  });

  it('a FIRST-attempt green is believed as-is — no confirm run, no extra cost', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const counter = join(ws, 'gate-runs2');
    const checksFile = join(ws, 'checks2.json');
    writeFileSync(
      checksFile,
      JSON.stringify({
        typecheck: [],
        test: [{ cmd: `n=$(cat ${counter} 2>/dev/null || echo 0); printf %s "$((n+1))" > ${counter}; exit 0` }],
      }),
    );
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile }));
    await cmdSweepNextCase(baseCli(repo, ws, inv, { checksFile }), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, checksFile }),
      confirm,
    );
    expect(readJournal(dir).some((e) => e.action === 'checks-pass' && e.caseId === caseId)).toBe(true);
    expect(readFileSync(counter, 'utf8')).toBe('1'); // ran ONCE — no confirm
  });
});

describe('gate-fix — failing locations are rooted at the REPO, not the command cwd', () => {
  it("a bun failure under cwd 'container/agent-runner' is emitted with the full repo path", async () => {
    // `bun test` runs with `cwd: container/agent-runner` (checks.json), so it
    // prints `src/poll-loop.test.ts` for a file at
    // `container/agent-runner/src/poll-loop.test.ts`. Unrooted, the agent
    // hits `ls: cannot access` on that path — in the very section whose purpose
    // is "do not hunt". `rootChecksOutput` solves this for blame; this
    // section must use it too.
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    const checksFile = join(ws, 'checks.json');
    writeFileSync(
      checksFile,
      JSON.stringify({ typecheck: [], test: [{ cmd: 'bun test', cwd: 'container/agent-runner' }] }),
    );
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile }));
    const caseId = 'gate-fix-main_patched-root';
    const tip = repo.sha('main_patched');
    mkdirSync(join(dir, caseId), { recursive: true });
    writeFileSync(
      join(dir, caseId, 'gate-fix-output.txt'),
      ['src/poll-loop.test.ts:', '(fail) nudges a second task run [5000.54ms]'].join('\n'),
    );
    appendJournal(dir, { action: 'gate-fix', caseId, branch: 'main_patched', files: ['container/agent-runner/src/poll-loop.test.ts'], failedCommands: ['bun test'] });
    appendJournal(dir, {
      action: 'case', caseId, branch: 'main_patched', parent: 'gate-fix', gateFix: true,
      head: { sha: tip, height: 0 }, conflictedPaths: ['container/agent-runner/src/poll-loop.test.ts'],
    });
    const journal = readJournal(dir);
    const m = gateFixCaseMaterialsForTest(dir, journaledCases(journal).get(caseId)!, journal.find((e) => e.action === 'case' && e.caseId === caseId)!);
    expect(m).toContain('container/agent-runner/src/poll-loop.test.ts — "nudges a second task run"');
  });
});

describe('gate-fix — the briefing prices the exit and names the repro class', () => {
  it('a full-suite-only failure says so at the TOP, and points at held', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    // The shape `--not-my-bug` mints when the bisect had to use the FULL command.
    const caseId = 'gate-fix-main_patched-cafe';
    const tip = repo.sha('main_patched');
    appendJournal(dir, { action: 'gate-fix', caseId, branch: 'main_patched', files: ['src/x.test.ts'], failedCommands: ['bun test'] });
    appendJournal(dir, {
      action: 'case',
      caseId,
      branch: 'main_patched',
      parent: 'gate-fix',
      gateFix: true,
      head: { sha: tip, height: 0 },
      conflictedPaths: ['src/x.test.ts'],
      reproduction: 'full-suite-only',
    });
    const journal = readJournal(dir);
    const jc = journaledCases(journal).get(caseId)!;
    const caseRow = journal.find((e) => e.action === 'case' && e.caseId === caseId)!;
    const m = gateFixCaseMaterialsForTest(dir, jc, caseRow);
    expect(m).toContain('REPRODUCTION: FULL SUITE ONLY');
    expect(m).toContain('--tier held');
    // The rule that separates "make it deterministic" from "make it ask for less"
    // travels with every instability case, whichever shape it takes.
    expect(m).toContain('An instability case is resolved by making the check deterministic');
    expect(m).toContain('stops the question being asked');
    // …and it appears BEFORE the file list, not in a footer: an agent must not
    // have to read deep into the materials before it can say "now
    // I can see the full picture".
    expect(m.indexOf('REPRODUCTION: FULL SUITE ONLY')).toBeLessThan(m.indexOf('## SCOPE'));
  });

  it('an ordinary gate fix carries no repro banner', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    const caseId = 'gate-fix-main_patched-beef';
    const tip = repo.sha('main_patched');
    appendJournal(dir, { action: 'gate-fix', caseId, branch: 'main_patched', files: ['src/x.ts'], failedCommands: ['tsc'] });
    appendJournal(dir, {
      action: 'case',
      caseId,
      branch: 'main_patched',
      parent: 'gate-fix',
      gateFix: true,
      head: { sha: tip, height: 0 },
      conflictedPaths: ['src/x.ts'],
    });
    const journal = readJournal(dir);
    const m = gateFixCaseMaterialsForTest(dir, journaledCases(journal).get(caseId)!, journal.find((e) => e.action === 'case' && e.caseId === caseId)!);
    expect(m).not.toContain('REPRODUCTION: FULL SUITE ONLY');
  });
});

describe('next-case — the materials say WHERE the markers are', () => {
  it('lists each pending file with its hunk line ranges', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));
    const out = join(ws, 'nc.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), greenPreMerge)).toBe(0);
    const materials = (JSON.parse(readFileSync(out, 'utf8')) as { materials: string }).materials;
    // The driver computed the merge, so it knows the hunk positions. Handing over
    // only file NAMES is what made the agent page a 2000-line file to find them:
    // 99 of 136 reads carried offset/limit, 87 of 136 re-read a path already read.
    expect(materials).toMatch(/hunk\(s\) at lines \d+-\d+/);
    expect(materials).toContain('read those windows, not the file');
  });
});

describe('next-case — the serve bound (a case handed out and never concluded)', () => {
  it('warns on the 3rd serve, refuses the 5th, and journals every one', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));

    // Serves 1-2: the agent is just working. Nothing said.
    for (const n of [1, 2]) {
      const out = join(ws, `n${n}.json`);
      expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), greenPreMerge)).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8')).warning).toBeUndefined();
    }
    // Serve 3: WARN — name the loop, ask for the diagnosis, do not refuse yet.
    const out3 = join(ws, 'n3.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: out3 }), greenPreMerge)).toBe(0);
    const r3 = JSON.parse(readFileSync(out3, 'utf8')) as { warning?: string; serves?: number; materials?: string };
    expect(r3.serves).toBe(3);
    expect(r3.warning).toMatch(/served 3 times/);
    expect(r3.warning).toMatch(/--tier held/);
    expect(r3.materials).toContain('LOOP WARNING'); // the agent reads materials, not just the result
    // Serve 4: still allowed (the warning gets one chance to work).
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n4.json') }), greenPreMerge)).toBe(0);
    // Serve 5: refused.
    const out5 = join(ws, 'n5.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: out5 }), greenPreMerge)).toBe(1);
    const r5 = JSON.parse(readFileSync(out5, 'utf8')) as { issues?: Array<{ id: string }> };
    expect(r5.issues!.map((i) => i.id)).toContain('ERR44_CASE_LOOPING');

    // Every serve that HAPPENED is on the record — `case` rows never showed this
    // — and only those. The refused fifth call handed nothing out, so counting it
    // would make the journal over-report how many times the case was worked.
    const journal = readJournal(dir);
    expect(journal.filter((e) => e.action === 'case-served').length).toBe(4);
    expect(journal.some((e) => e.action === 'case-serve-limit')).toBe(true);
  });

  it('a REFUSED serve does not count as a serve', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    for (const n of [1, 2, 3, 4]) {
      expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, `n${n}.json`) }), greenPreMerge)).toBe(0);
    }
    const caseId = currentCaseId(dir);
    // Two refusals. Each is a hand-out that did NOT happen, so neither may join
    // the count the limit is computed from: journaling above the check makes the
    // refusal count itself and the recorded serve total climb without the case
    // ever being worked again.
    for (const n of [5, 6]) {
      expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, `n${n}.json`) }), greenPreMerge)).toBe(1);
    }
    const served = readJournal(dir).filter((e) => e.action === 'case-served' && e.caseId === caseId);
    expect(served.length).toBe(4);
    expect(served.map((e) => e.serves)).toEqual([1, 2, 3, 4]);
    // …and the refusal keeps reporting the same next-serve number rather than a
    // total that grew because it was refused.
    const r6 = JSON.parse(readFileSync(join(ws, 'n6.json'), 'utf8')) as { serves: number };
    expect(r6.serves).toBe(5);
  });

  it('a refusal leaves the case CONCLUDABLE — the phase permits the `--tier held` it asks for', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    for (const n of [1, 2, 3, 4]) {
      expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, `n${n}.json`) }), greenPreMerge)).toBe(0);
    }
    const caseId = currentCaseId(dir);
    // `next-case` is entered at `open` whenever the previous command returned the
    // machine there while leaving this case undispositioned: `report-pr`'s judged,
    // held and gate-fix arms all reopen and drop to `open`, as does `report-case`'s
    // held-duplicate consolidation and the `--not-my-bug` arm that mints nothing.
    // The refused serve must be servable from THERE, not only from the phase the
    // previous serve happened to leave behind.
    const stFile = join(dir, 'machine-state.json');
    writeFileSync(stFile, JSON.stringify({ ...JSON.parse(readFileSync(stFile, 'utf8')), phase: 'open', currentCase: null }));
    const out5 = join(ws, 'n5.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: out5 }), greenPreMerge)).toBe(1);
    const r5 = JSON.parse(readFileSync(out5, 'utf8')) as { issues: Array<{ detail: string }> };
    expect(r5.issues[0].detail).toContain('--tier held');
    // The refusal withdraws INVESTIGATION, not the ability to conclude, so it
    // leaves the phase `report-case` hard-requires — with the refused case as the
    // current one.
    expect(machineState(dir).phase).toBe('case-ready');
    expect(machineState(dir).currentCase!.caseId).toBe(caseId);
    // The instructed command is therefore ACCEPTED: `2` here is "no case is ready
    // — run next-case first", and next-case is exactly what was just refused.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out: join(ws, 'rc.json') }),
        neverInvoked,
      ),
    ).toBe(0);
    // Concluded: the case is out of `openCases`, so `finish` is not stuck on
    // ERR34_CASES_REMAIN over a case the driver itself refused to serve.
    expect(openCases(readJournal(dir)).map((c) => c.caseId)).not.toContain(caseId);
  });

  it('an ordinary first serve carries no warning and no loop block', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    await cmdSweepStart(baseCli(repo, ws, inv));
    const out = join(ws, 'a.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), greenPreMerge)).toBe(0);
    const r = JSON.parse(readFileSync(out, 'utf8')) as { warning?: string; materials?: string };
    expect(r.warning).toBeUndefined();
    expect(r.materials).not.toContain('LOOP WARNING');
  });
});

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

// ---------------------------------------------------------------------------
// Twins — one commit, published at two levels (DRIVER.md §9.6).
// ---------------------------------------------------------------------------

describe('gate-fix twins — the same commit, offered at the ceiling', () => {
  /**
   * `module/cg` carries an open fix on origin for a file the TRUNK wrote;
   * `module/other` conflicts with what the trunk brings down, so its
   * adjudication is where the ceiling is asked about the same defect.
   */
  function twinFixture(): FixtureRepo {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: shared', { 'src/shared.ts': 'broken\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.checkout('module/other', { create: true, at: 'main_patched' });
    repo.commit('other: x = other', { 'src/x.ts': 'other\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return repo;
  }

  /**
   * The driver's own fix commit, as origin already carries it: the SAME identity
   * `driverShaped` recognises, rooted at a commit the trunk contains — which is
   * where the mint's root floor puts a gate fix in the first place.
   */
  function pushDriverFix(repo: FixtureRepo, ref: string, at: string, files: Record<string, string>): string {
    repo.checkout('tmp/fix', { create: true, at });
    repo.commit('fix(sweep): the shared defect', files);
    const tree = repo.git('rev-parse', 'HEAD^{tree}');
    repo.checkout('main');
    repo.git('branch', '-D', 'tmp/fix');
    const sha = execFileSync('git', ['-C', repo.dir, 'commit-tree', tree, '-p', at, '-m', 'fix(sweep): the shared defect'], {
      encoding: 'utf8',
      env: { ...process.env, ...DRIVER_COMMIT_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
    repo.git('push', 'origin', `${sha}:refs/heads/${ref}`);
    return sha;
  }

  /** A GitHub that REMEMBERS: PRs by head, their draft flag, their body, their comments. */
  function twinGithub(existing: Array<{ head: string; base: string; body?: string; draft?: boolean }>): {
    prs: Map<number, { number: number; head: string; base: string; draft: boolean; body: string }>;
    comments: Map<number, string[]>;
    created: Array<{ head: string; base: string; body: string; title: string }>;
    draftFlips: number[];
    factory: (token: string) => GithubTransport;
  } {
    const prs = new Map<number, { number: number; head: string; base: string; draft: boolean; body: string }>();
    const comments = new Map<number, string[]>();
    const created: Array<{ head: string; base: string; body: string; title: string }> = [];
    const draftFlips: number[] = [];
    let next = 100;
    for (const e of existing) {
      const n = next++;
      prs.set(n, { number: n, head: e.head, base: e.base, draft: e.draft ?? false, body: e.body ?? 'agent prose' });
      comments.set(n, []);
    }
    const byHead = (path: string): { number: number; head: string; base: string; draft: boolean; body: string } | null => {
      const m = /head=([^&]+)/.exec(path);
      const head = m ? decodeURIComponent(m[1]).replace(/^[^:]*:/, '') : '';
      return [...prs.values()].find((p) => p.head === head) ?? null;
    };
    const asApi = (p: { number: number; draft: boolean; body: string }): Record<string, unknown> => ({
      number: p.number,
      html_url: `https://github.com/k-fls/fixture/pull/${p.number}`,
      node_id: `PR_${p.number}`,
      state: 'open',
      merged: false,
      draft: p.draft,
      title: 't',
      body: p.body,
    });
    const factory = (_t: string): GithubTransport => ({
      async request(method, path, body) {
        if (method === 'GET' && path.includes('/pulls?head=')) {
          const pr = byHead(path);
          return { status: 200, body: pr ? [asApi(pr)] : [] };
        }
        if (method === 'POST' && path.endsWith('/pulls')) {
          const b = body as { head: string; base: string; body: string; title: string; draft?: boolean };
          const n = next++;
          prs.set(n, { number: n, head: b.head, base: b.base, draft: b.draft === true, body: b.body });
          comments.set(n, []);
          created.push({ head: b.head, base: b.base, body: b.body, title: b.title });
          return { status: 201, body: asApi(prs.get(n)!) };
        }
        const num = Number(/\/(?:pulls|issues)\/(\d+)/.exec(path)?.[1] ?? 0);
        if (method === 'GET' && /\/pulls\/\d+\/reviews/.test(path)) return { status: 200, body: [] };
        if (method === 'GET' && /\/pulls\/\d+\/comments/.test(path)) return { status: 200, body: [] };
        if (method === 'GET' && /\/issues\/\d+\/comments/.test(path)) {
          return { status: 200, body: (comments.get(num) ?? []).map((c, i) => ({ id: i + 1, body: c, user: { login: 'sweep' } })) };
        }
        if (method === 'POST' && /\/issues\/\d+\/comments/.test(path)) {
          comments.set(num, [...(comments.get(num) ?? []), String((body as { body: string }).body)]);
          return { status: 201, body: {} };
        }
        if (method === 'GET' && /\/pulls\/\d+$/.test(path)) {
          const pr = prs.get(num);
          return pr ? { status: 200, body: asApi(pr) } : { status: 404, body: null };
        }
        if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) {
          const pr = prs.get(num);
          if (pr && typeof (body as { body?: string }).body === 'string') pr.body = (body as { body: string }).body;
          return { status: 200, body: {} };
        }
        if (method === 'POST' && path === '/graphql') {
          const q = String((body as { query?: string }).query ?? '');
          const id = String(((body as { variables?: { pullRequestId?: string } }).variables ?? {}).pullRequestId ?? '');
          const n = Number(id.replace('PR_', ''));
          if (q.includes('convertPullRequestToDraft')) {
            const pr = prs.get(n);
            if (pr) pr.draft = true;
            draftFlips.push(n);
          }
          return { status: 200, body: { data: { node: { id } } } };
        }
        return { status: 404, body: null };
      },
    });
    return { prs, comments, created, draftFlips, factory };
  }

  /** Verify commands that always pass — finish reaches its publish phase. */
  function greenCommands(ws: string): string {
    const f = join(ws, 'cmds.json');
    writeFileSync(f, JSON.stringify([{ cmd: 'true' }]));
    return f;
  }

  async function twinPass(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    gh: ReturnType<typeof twinGithub>,
    tokenFile: string,
    /** The command finish's OWN verify runs for real — `false` makes that pass red. */
    verifyCmd = 'true',
  ): Promise<{ dir: string }> {
    const cli = (over: Partial<Cli> = {}): Cli => baseCli(repo, ws, inv, { tokenFile, ...over });
    await cmdSweepStart(cli({ checksFile: checksFileFor(ws, verifyCmd) }), gh.factory, greenPreMerge);
    const dir = dirOf(repo, ws);
    await cmdSweepNextCase(cli(), greenPreMerge);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'checks-fail', caseId, kind: 'typecheck', failed: [verifyCmd] }) + '\n',
    );
    const r: ChecksRunner = async (commands) => {
      const names = commands.map((c) => c.cmd);
      return {
        ok: false,
        failedNames: names,
        output: names.map((n) => `$ ${n}\nsrc/shared.ts(1,1): error TS2345: boom\n`).join(''),
      };
    };
    await cmdSweepReportCase(
      cli({ cmd: 'report-case', tier: 'judged', notMyBug: true, execute: true, out: join(ws, 'rc.json') }),
      neverInvoked,
      r,
      fakeInstall,
    );
    // The adjudication aborted the merge, so the conflict is still there: work it
    // the ordinary way, or the integration rebuild is a conflict and finish never
    // reaches its publish phase.
    if (readJournal(dir).some((e) => e.action === 'reopened')) {
      await cmdSweepNextCase(cli(), greenPreMerge);
      const again = machineState(dir).currentCase?.caseId;
      if (again) {
        resolveWorktree(dir, again, { 'src/x.ts': 'RESOLVED\n' });
        await cmdSweepReportCase(
          cli({ cmd: 'report-case', tier: 'mechanical', execute: true }),
          confirm,
          greenPreMerge,
          fakeInstall,
        );
      }
    }
    await cmdSweepFinish(
      cli({ cmd: 'sweep-finish', execute: true, commandsFile: greenCommands(ws), out: join(ws, 'f.json') }),
      gh.factory,
    );
    repo.git('fetch', 'origin');
    return { dir };
  }

  /**
   * The pass's pinned checks contract. The command is a real program that PASSES,
   * so the only red in the pass is the one the injected runner reports at the case
   * gate — finish's own verify then runs for real and is green, which is what
   * carries the pass into its publish phase.
   */
  function checksFileFor(ws: string, cmd = 'true'): string {
    const f = join(ws, 'checks.json');
    writeFileSync(f, JSON.stringify({ typecheck: [{ cmd, cwd: '.' }], test: [] }));
    return f;
  }

  it('a fix that already exists is TWINNED to the ceiling instead of derived again', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', parents: ['main_patched'] },
      { id: 'other', branch: 'module/other', parents: ['main_patched'] },
    ]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg', 'module/other']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const twinRef = gateFixRefName('main_patched', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/cg' }]);
    const { dir } = await twinPass(repo, ws, inv, gh, tokenFile);

    const journal = readJournal(dir);
    // NO CASE for a fix that is already written — and the row says where it went.
    const twin = journal.find((e) => e.action === 'gate-fix-twin')!;
    expect(twin.originalRef).toBe(originalRef);
    expect(twin.twinRef).toBe(twinRef);
    expect(twin.sha).toBe(H);
    expect(twin.ceiling).toBe('main_patched');
    expect(journal.some((e) => e.action === 'gate-fix' && e.branch === 'main_patched')).toBe(false);
    // The agent is told, in the words the mint used.
    const rc = JSON.parse(readFileSync(join(ws, 'rc.json'), 'utf8')) as { instruction: string };
    expect(rc.instruction).toContain(`twinned to ${twinRef}`);

    // ORIGIN CARRIES THE SAME COMMIT UNDER BOTH NAMES — nothing was rebased.
    expect(repo.git('rev-parse', `refs/remotes/origin/${twinRef}`)).toBe(H);
    expect(repo.git('rev-parse', `refs/remotes/origin/${originalRef}`)).toBe(H);
    // The twin PR is based on the CEILING and points back at the original.
    const twinPr = gh.created.find((c) => c.head === twinRef)!;
    expect(twinPr.base).toBe('main_patched');
    expect(twinPr.body).toContain(`<!-- sweep-twin-of: ${originalRef} -->`);
    // ACTIVE, NOT DRAFT: this is the pull request the owner is meant to merge, so
    // it belongs in an "awaiting review" view. Drafting both sides would hide the
    // defect entirely and charge an un-draft to land the fix.
    expect([...gh.prs.values()].find((p) => p.head === twinRef)!.draft).toBe(false);
    // The original is drafted once, told once, and carries the pointer forward.
    const original = [...gh.prs.values()].find((p) => p.head === originalRef)!;
    expect(original.draft).toBe(true);
    expect(gh.draftFlips).toEqual([original.number]);
    const marker = `<!-- sweep-twin: ${twinRef} -->`;
    expect((gh.comments.get(original.number) ?? []).filter((c) => c.includes(marker))).toHaveLength(1);
    expect(original.body).toContain(marker);
    expect(journal.some((e) => e.action === 'gate-fix-twin-published' && e.twinRef === twinRef)).toBe(true);
  });

  /**
   * A TWIN IS PLANNED PRECISELY WHEN FINISH IS RED. It exists because the ceiling
   * is red on a real command and its fix is unmerged — which is the state every
   * red exit reports — so a publish phase reachable only on a green verify would
   * never run in any pass that plans one. The red exits publish it too: same
   * class as the held escalations they already publish on red, a `fix/sweep` ref
   * and a review PR, never a target push.
   */
  it('a twin is published out of a RED finish, where every pass that plans one ends', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', parents: ['main_patched'] },
      { id: 'other', branch: 'module/other', parents: ['main_patched'] },
    ]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg', 'module/other']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const twinRef = gateFixRefName('main_patched', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/cg' }]);
    // `false` fails and names nothing, so the verify is RED and blames nobody —
    // the arm that publishes the held escalations and stops.
    const { dir } = await twinPass(repo, ws, inv, gh, tokenFile, 'false');

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'gate-fix-twin')).toBe(true);
    expect(journal.some((e) => e.action === 'finish-tests-failed')).toBe(true);
    // THE POINT: the twin is ON ORIGIN, and its PR exists, out of a red finish.
    expect(repo.git('for-each-ref', '--format=%(objectname)', `refs/remotes/origin/${twinRef}`)).toBe(H);
    expect(gh.created.filter((c) => c.head === twinRef)).toHaveLength(1);
    expect(journal.some((e) => e.action === 'gate-fix-twin-published' && e.twinRef === twinRef)).toBe(true);
    // And the report says so, rather than leaving the owner to find it.
    const res = JSON.parse(readFileSync(join(ws, 'f.json'), 'utf8')) as {
      twins?: { published: number; failed: number };
      instruction: string;
    };
    expect(res.twins).toEqual({ published: 1, failed: 0 });
    expect(res.instruction).toContain('twin PR(s) were published');
  });

  /**
   * THE ORIGINAL STILL HAS TO CARRY THE COMMIT. An owner who amends the ref the
   * fix came from between the plan and the publish leaves the twin offering a
   * commit its own original no longer has — a review that happened, presented as
   * a review of something else.
   */
  it('a twin whose original moved under it is not published', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const twinRef = gateFixRefName('main_patched', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    // The plan is made against `H`; the owner then AMENDS the original — a
    // rewrite, which is why it needs a force-push to land.
    repo.checkout('tmp/amend', { create: true, at: 'main_patched' });
    repo.commit('their own fix', { 'src/shared.ts': 'their own fix\n' });
    const amended = repo.sha('HEAD');
    repo.checkout('main');
    repo.git('branch', '-D', 'tmp/amend');
    repo.git('push', '--force', 'origin', `${amended}:refs/heads/${originalRef}`);
    expect(amended).not.toBe(H);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/cg' }]);
    const dir = join(ws, 'twin-plan');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'gate-fix-twin',
        originalRef,
        twinRef,
        sha: H,
        ceiling: 'main_patched',
        files: ['src/shared.ts'],
        digest: 'x',
        detail: 'planned',
      }) + '\n',
    );
    repo.git('fetch', 'origin', '--force');
    const out = await publishGateFixTwins(baseCli(repo, ws, inv, { tokenFile }), dir, gh.factory);
    expect(out).toEqual({ published: 0, failed: 1, failedRefs: [twinRef] });
    expect(gh.created).toHaveLength(0);
    expect(repo.git('for-each-ref', '--format=%(objectname)', `refs/remotes/origin/${twinRef}`)).toBe('');
    const row = readJournal(dir).find((e) => e.action === 'gate-fix-twin-failed')!;
    expect(row.reason).toContain('is not the one that ref carries');
    expect(row.at).toBe(amended);
  });

  /**
   * A REF THAT MOVED IS SOMEBODY'S WORK. A lease does not help — it is satisfied
   * by whatever is there, including an amended head an owner pushed — so the head
   * is left exactly where it is and the failure is reported instead.
   */
  it('a twin ref whose head somebody moved is never overwritten', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const twinRef = gateFixRefName('main_patched', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    // The owner amended the twin's head: a different commit sits on the ref.
    const theirs = pushDriverFix(repo, twinRef, repo.sha('main_patched'), { 'src/shared.ts': 'their edit\n' });
    expect(theirs).not.toBe(H);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/cg' }]);
    const dir = join(ws, 'twin-plan');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'gate-fix-twin',
        originalRef,
        twinRef,
        sha: H,
        ceiling: 'main_patched',
        files: ['src/shared.ts'],
        digest: 'x',
        detail: 'planned',
      }) + '\n',
    );
    repo.git('fetch', 'origin');
    const out = await publishGateFixTwins(baseCli(repo, ws, inv, { tokenFile }), dir, gh.factory);
    expect(out).toEqual({ published: 0, failed: 1, failedRefs: [twinRef] });
    // Their commit is untouched, nothing was created, and the refusal is a row.
    repo.git('fetch', 'origin');
    expect(repo.git('rev-parse', `refs/remotes/origin/${twinRef}`)).toBe(theirs);
    expect(gh.created).toHaveLength(0);
    const row = readJournal(dir).find((e) => e.action === 'gate-fix-twin-failed')!;
    expect(row.reason).toContain("not the driver's to overwrite");
    expect(row.at).toBe(theirs);
  });

  /**
   * TWO REFS AT ONE SHA ARE ONE PIECE OF WORK. Seen from a THIRD branch — the
   * only place both are visible, since a branch's own ref is skipped — they are
   * named as twins and kept out of the duplicate count: asking the owner to
   * reconcile a pull request with itself is worse than saying nothing.
   */
  it('a sibling sees two refs at one sha as twins, not as duplicates', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'cg', branch: 'module/cg', parents: ['main_patched'] }]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const twinRef = gateFixRefName('main_patched', ['src/shared.ts']);
    const other = gateFixRefName('module/other', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    repo.git('push', 'origin', `${H}:refs/heads/${twinRef}`);
    const elsewhere = pushDriverFix(repo, other, repo.sha('main_patched'), { 'src/shared.ts': 'a different fix\n' });
    expect(elsewhere).not.toBe(H);
    repo.git('fetch', 'origin');
    const dir = join(ws, 'dup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'journal.jsonl'), '');
    const seen = await duplicateGateFixes(baseCli(repo, ws, inv), dir, 'module/third', ['src/shared.ts']);
    // The pair at one sha is labelled and uncounted; a genuinely separate fix on
    // a third ref is still the duplicate it is.
    expect(seen.twins.sort()).toEqual([`${originalRef} (twin of ${twinRef})`, `${twinRef} (twin of ${originalRef})`].sort());
    expect(seen.duplicates).toEqual([`${other} (open on origin)`]);
  });

  /**
   * THE FINISH MINT IS A CEILING MINT TOO. Attribution IS the ceiling on that
   * path, and the twin's two conditions are facts about the commit — so a red
   * first seen at finish, whose fix an earlier pass already wrote at a commit
   * this branch contains, is answered the same way: the commit is offered here,
   * and no agent is asked to derive it again.
   */
  it('the finish mint twins to an existing fix instead of serving a case', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: y', { 'src/y.ts': 'fork\n' });
    repo.checkout('module/cg', { create: true, at: 'main_patched' });
    repo.commit('cg: own x', { 'src/x.ts': 'cg\n' });
    repo.checkout('module/sib', { create: true, at: 'main_patched' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', owned: ['src/x.ts'] },
      { id: 'sib', branch: 'module/sib' },
    ]);
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg', 'module/sib']) repo.git('push', 'origin', b);
    // An earlier pass's fix for the same failing set, on a SIBLING — its own
    // branch is gated by it, `module/cg` is not — rooted at a commit `module/cg`
    // contains, so its diff here is the fix and nothing else.
    const originalRef = gateFixRefName('module/sib', ['src/x.ts']);
    const twinRef = gateFixRefName('module/cg', ['src/x.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/x.ts': 'fixed\n' });
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/sib' }]);
    // A verify that fails naming `src/x.ts` — the shape finish blames by
    // elimination and would otherwise mint a case on `module/cg` for.
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'sh -c \'echo "src/x.ts(3,4): error TS2345: boom"; exit 1\'' }]));
    const cli = (over: Partial<Cli> = {}): Cli => baseCli(repo, ws, inv, { tokenFile, ...over });
    expect(await cmdSweepStart(cli(), gh.factory, greenPreMerge)).toBe(0);
    await cmdSweepNextCase(cli(), greenPreMerge);
    const out = join(ws, 'f.json');
    expect(
      await cmdSweepFinish(cli({ cmd: 'sweep-finish', execute: true, commandsFile: cmds, out }), gh.factory),
    ).toBe(1);

    const journal = readJournal(dir);
    // NO CASE for a fix that is already written.
    expect(journal.some((e) => e.action === 'gate-fix')).toBe(false);
    const twin = journal.find((e) => e.action === 'gate-fix-twin')!;
    expect(twin.originalRef).toBe(originalRef);
    expect(twin.twinRef).toBe(twinRef);
    expect(twin.ceiling).toBe('module/cg');
    // It leaves through the failing-tests stop — the arm that publishes what is
    // written and reports the red — and the twin goes out with it.
    const res = JSON.parse(readFileSync(out, 'utf8')) as {
      stoppedAt: string;
      issues: Array<{ id: string }>;
      twins?: { published: number; failed: number };
      instruction: string;
    };
    expect(res.stoppedAt).toBe('finish-tests');
    expect(res.issues.map((i) => i.id)).toContain('ERR40_TESTS_FAILED');
    expect(res.twins).toEqual({ published: 1, failed: 0 });
    repo.git('fetch', 'origin');
    expect(repo.git('for-each-ref', '--format=%(objectname)', `refs/remotes/origin/${twinRef}`)).toBe(H);
    expect(gh.created.filter((c) => c.head === twinRef)).toHaveLength(1);
  });

  /**
   * A finish that crashed between the mint and the publish leaves the plan in the
   * pass and NOTHING on origin's side half-done — so the whole phase re-runs, and
   * every step of it has to find its own "already done" record on GitHub. The
   * journal cannot answer that: the pass dir is disposable.
   */
  it('a re-run publish phase writes exactly one of everything', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', parents: ['main_patched'] },
      { id: 'other', branch: 'module/other', parents: ['main_patched'] },
    ]);
    repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg', 'module/other']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const twinRef = gateFixRefName('main_patched', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/cg' }]);
    const { dir } = await twinPass(repo, ws, inv, gh, tokenFile);

    // THE PHASE, AGAIN, with its plan still in the pass — a finish that died
    // between the mint and the publish re-runs exactly this. Nothing in the
    // journal may answer "already done": the pass dir is disposable, so every
    // guard reads origin and GitHub.
    const again = await publishGateFixTwins(baseCli(repo, ws, inv, { tokenFile }), dir, gh.factory);
    expect(again.failed).toBe(0);
    repo.git('fetch', 'origin');

    // ONE ref, ONE twin PR, ONE draft flip, ONE comment — every "already done"
    // record read back off GitHub, because the pass dir does not cross passes.
    expect(repo.git('rev-parse', `refs/remotes/origin/${twinRef}`)).toBe(H);
    expect(gh.created.filter((c) => c.head === twinRef)).toHaveLength(1);
    const original = [...gh.prs.values()].find((p) => p.head === originalRef)!;
    expect(gh.draftFlips).toEqual([original.number]);
    const marker = `<!-- sweep-twin: ${twinRef} -->`;
    expect((gh.comments.get(original.number) ?? []).filter((c) => c.includes(marker))).toHaveLength(1);
    expect(original.body.split(marker)).toHaveLength(2);
  });

  it('the original ref is deleted, and its branch unblocked, once the twin lands and propagates', async () => {
    const repo = twinFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'cg', branch: 'module/cg', parents: ['main_patched'] },
      { id: 'other', branch: 'module/other', parents: ['main_patched'] },
    ]);
    const bare = repo.attachBareOrigin();
    for (const b of ['main', 'main_patched', 'module/cg', 'module/other']) repo.git('push', 'origin', b);
    const originalRef = gateFixRefName('module/cg', ['src/shared.ts']);
    const H = pushDriverFix(repo, originalRef, repo.sha('main_patched'), { 'src/shared.ts': 'ok\n' });
    expect(bare).toBeTruthy();
    // The twin merges at the ceiling and propagates down — the ordinary sweep.
    repo.checkout('main_patched');
    repo.git('merge', '--no-ff', '-m', 'Merge the twin into main_patched', H);
    repo.checkout('module/cg');
    repo.git('merge', '--no-ff', '-m', 'Merge main_patched into module/cg (propagation)', 'main_patched');
    repo.checkout('main');
    repo.git('push', 'origin', 'main_patched');
    repo.git('push', 'origin', 'module/cg');
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const gh = twinGithub([{ head: originalRef, base: 'module/cg' }]);
    expect(
      await cmdSweepStart(
        baseCli(repo, ws, inv, { tokenFile, out: join(ws, 'start.json') }),
        gh.factory,
        greenPreMerge,
      ),
    ).toBe(0);
    const dir = dirOf(repo, ws);
    const journal = readJournal(dir);
    // THE COMMIT IS IN THE BRANCH, so the ref has nothing left to propose: it is
    // deleted, GitHub closes its PR, and the branch derives freely again.
    const resolved = journal.find((e) => e.action === 'origin-ref-resolved' && e.ref === originalRef)!;
    expect(resolved).toBeTruthy();
    expect(resolved.deleteFailed).toBeUndefined();
    expect(journal.some((e) => e.action === 'origin-blocked' && e.branch === 'module/cg')).toBe(false);
  });
});

describe('run — a swept branch that MOVED under the open pass (the stale-case heal)', () => {
  /** A fast-forward commit onto `branch` — git moving under the pass. */
  const advance = (repo: FixtureRepo, branch: string, files: Record<string, string>, msg: string): string => {
    repo.checkout(branch);
    const sha = repo.commit(msg, files);
    repo.checkout('main');
    return sha;
  };
  /** A NON-fast-forward rewrite of `branch` (plumbing: no checkout, no extra ref). */
  const rewrite = (repo: FixtureRepo, branch: string, msg: string): string => {
    const base = repo.sha(`${branch}~1`);
    const sha = repo.git('commit-tree', repo.git('rev-parse', `${base}^{tree}`), '-p', base, '-m', msg);
    repo.git('update-ref', `refs/heads/${branch}`, sha);
    return sha;
  };
  const passCmds = (ws: string): string => {
    const f = join(ws, 'cmds-true.json');
    writeFileSync(f, JSON.stringify([{ cmd: 'true' }]));
    return f;
  };

  it('breaks the deadlock: the stale case is dropped, re-derived from git and served — and CONCLUDABLE', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n1.json') }), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);

    // GIT MOVES UNDER THE PASS — the driver is redeployed onto a branch that is
    // both its own source and swept content. The conflict on src/x.ts is
    // untouched, so the case is still live; only its automerge tree is now a
    // statement about a tip that no longer exists.
    advance(repo, 'main_patched', { 'src/z.ts': 'owner work\n' }, 'owner: unrelated commit');

    const out = join(ws, 'n2.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), greenPreMerge)).toBe(0);
    const journal = readJournal(dir);
    const stale = journal.find((e) => e.action === 'case-stale' && e.caseId === caseId)!;
    expect(stale).toBeTruthy();
    expect(stale.drift).toBe('branch-tip');
    expect(stale.branch).toBe('main_patched');
    expect(stale.liveTip).toBe(repo.sha('main_patched'));
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(true);
    // The case is RE-DERIVED, not disposed: a synthetic `resolved` would be
    // terminal for this id whatever its order, and the re-emission wears the
    // SAME id (its sha8 is the conflict head's, which the branch never moved).
    expect(journal.some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    const emissions = journal.filter((e) => e.action === 'case' && e.caseId === caseId);
    expect(emissions.length).toBe(2);
    const served = JSON.parse(readFileSync(out, 'utf8')) as { caseId?: string; status?: string };
    expect(served.caseId).toBe(caseId);
    expect(openCases(readJournal(dir)).map((c) => c.caseId)).toEqual([caseId]);

    // AND THE CONCLUSION IS ACCEPTED. This is the whole point: before the heal,
    // `report-case` answered ERR02_CASE_STALE on the automerge drift and
    // `next-case` answered ERR44_CASE_LOOPING, so the pass had no legal move.
    const rc = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out: rc }),
        neverInvoked,
      ),
    ).toBe(0);
    expect(openCases(readJournal(dir)).map((c) => c.caseId)).not.toContain(caseId);
  });

  it('the serve count restarts at the re-emission — a healed case is not born at the serve limit', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    for (const n of [1, 2, 3, 4]) {
      expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, `n${n}.json`) }), greenPreMerge)).toBe(0);
    }
    const caseId = currentCaseId(dir);
    advance(repo, 'main_patched', { 'src/z.ts': 'owner work\n' }, 'owner: unrelated commit');

    // Serve 5 would be REFUSED on the old count. The case being served is a
    // different derivation of the same conflict, so it is served as its first.
    const out = join(ws, 'n5.json');
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out }), greenPreMerge)).toBe(0);
    const r = JSON.parse(readFileSync(out, 'utf8')) as { status?: string; warning?: string; caseId?: string };
    expect(r.caseId).toBe(caseId);
    expect(r.status).toBe('case-ready');
    expect(r.warning).toBeUndefined(); // not a 5th serve, so no loop warning either
    const served = readJournal(dir).filter((e) => e.action === 'case-served' && e.caseId === caseId);
    expect(served.map((e) => e.serves)).toEqual([1, 2, 3, 4, 1]);
    expect(readJournal(dir).some((e) => e.action === 'case-serve-limit')).toBe(false);
  });

  it('a tip movement that DISSOLVES the conflict lands the merge and clears the pass', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const upstreamTop = repo.sha('main');
    await cmdSweepStart(baseCli(repo, ws, inv));
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n1.json') }), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);

    // The owner drops the fork line on the conflicted file themselves: the branch
    // moves FORWARD and the conflict dissolves with it, leaving a merge that
    // simply lands.
    advance(repo, 'main_patched', { 'src/x.ts': 'orig\n' }, 'owner: drop the fork line');
    repo.git('push', 'origin', 'main_patched');

    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n2.json') }), greenPreMerge)).toBe(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'case-stale' && e.caseId === caseId)).toBe(true);
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(true);
    // Nothing left to serve, because there is nothing left to resolve: the
    // re-derivation merges the upstream head the case was minted over.
    const stale = journal.findIndex((e) => e.action === 'case-stale');
    expect(journal.findIndex((e, i) => i > stale && e.action === 'merge' && e.branch === 'main_patched')).toBeGreaterThan(stale);
    expect(await isAncestor(repo.dir, upstreamTop, repo.sha('main_patched'))).toBe(true);
    expect(openCases(journal).length).toBe(0);
    // …so `finish` is no longer wedged on ERR34_CASES_REMAIN.
    const out = join(ws, 'finish.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: passCmds(ws), out }),
      ),
    ).toBe(0);
    const fin = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; issues?: Array<{ id: string }> };
    expect((fin.issues ?? []).map((i) => i.id)).not.toContain('ERR34_CASES_REMAIN');
    expect(fin.ok).toBe(true);
  });

  it('REWRITTEN history is recorded and NOT adapted to — the owner decides, the driver does not', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n1.json') }), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);
    const recordedTip = repo.sha('main_patched');
    const rewritten = rewrite(repo, 'main_patched', 'owner: rebased history');

    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n2.json') }), greenPreMerge)).toBe(0);
    const journal = readJournal(dir);
    const stale = journal.find((e) => e.action === 'case-stale' && e.caseId === caseId)!;
    expect(stale).toBeTruthy();
    expect(stale.drift).toBe('divergent');
    expect(stale.recordedTip).toBe(recordedTip);
    expect(stale.liveTip).toBe(rewritten);
    // Silently re-deriving around a rewrite would erase the evidence, so the
    // row is written and nothing else happens: no reopen, and the case STANDS.
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toEqual([caseId]);
  });

  it('GUARD: mid-flight, `report-case` still answers ERR02 and heals nothing — the agent is told to stop', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n1.json') }), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);
    advance(repo, 'main_patched', { 'src/z.ts': 'owner work\n' }, 'owner: unrelated commit');

    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out }),
        neverInvoked,
      ),
    ).toBe(1);
    const r = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string; detail: string }> };
    expect(r.issues.map((i) => i.id)).toContain('ERR02_CASE_STALE');
    expect(r.issues.some((i) => /automerge-tree drift/.test(i.detail))).toBe(true);
    // The heal is `run`'s, and `report-case` runs none of it: the case is
    // untouched and still open, waiting for the `next-case` the refusal asks for.
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'case-stale')).toBe(false);
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(false);
    expect(openCases(journal).map((c) => c.caseId)).toEqual([caseId]);
  });

  it('GUARD: a HELD case is not healed when its branch moves — a disposition is not staleness', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n1.json') }), greenPreMerge)).toBe(0);
    const caseId = currentCaseId(dir);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'held', execute: true, out: join(ws, 'rc.json') }),
        neverInvoked,
      ),
    ).toBe(0);
    writePr(dir, caseId, 'held x', 'Decision needed: the fork line in src/x.ts.');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm)).toBe(0);
    advance(repo, 'main_patched', { 'src/z.ts': 'owner work\n' }, 'owner: unrelated commit');

    expect(await cmdSweepNextCase(baseCli(repo, ws, inv, { out: join(ws, 'n2.json') }), greenPreMerge)).toBe(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'case-stale')).toBe(false);
    expect(journal.filter((e) => e.action === 'case' && e.caseId === caseId).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TEST FILES ARE IN SCOPE, and the cold read is the only thing that judges them.
// The predicate comes from the repo (`checks.json`'s `testPaths`); the guard
// admits the path, the tier floors at judged, and the fourth question asks
// whether the edit is this resolution's and still asks its question.
// ---------------------------------------------------------------------------

describe('sweep report-case — a resolution that brings its test along', () => {
  /** A checks file that names test paths and configures NO commands: the gate
   * is skipped, so these fixtures exercise the scope/tier/cold-read path alone. */
  function testPathsChecks(ws: string, testPaths: string[] = ['**/*.test.ts']): string {
    const f = join(ws, 'checks.json');
    writeFileSync(f, JSON.stringify({ typecheck: [], test: [], testPaths }));
    return f;
  }

  async function caseWithTestEdit(
    repo: FixtureRepo,
    ws: string,
    inv: string,
    testPaths?: string[],
  ): Promise<{ dir: string; caseId: string }> {
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: testPathsChecks(ws, testPaths) }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    // The agent resolves the conflict AND moves the test that asserted the
    // pre-merge behaviour — in one pass, so no red run ever names the test.
    resolveWorktree(dir, caseId, {
      'src/x.ts': 'RESOLVED\n',
      'src/x.test.ts': 'expect(x).toBe("RESOLVED")\n',
    });
    return { dir, caseId };
  }

  it('a test edit is IN SCOPE, journaled, and floors a mechanical claim at judged', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const { dir, caseId } = await caseWithTestEdit(repo, ws, inv);
    const beforeTip = repo.sha('main_patched');
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { tier: string };
    // Not a scope violation…
    expect(readJournal(dir).some((e) => e.action === 'scope-violation' && e.caseId === caseId)).toBe(false);
    expect(readJournal(dir).find((e) => e.action === 'test-edit' && e.caseId === caseId)!.files).toEqual([
      'src/x.test.ts',
    ]);
    // …and not mechanical either: the edit reaches a file no conflict named, on
    // the agent's reading of what the merge now asserts. That is a judgement.
    expect(res.tier).toBe('judged');
    expect(machineState(dir).currentCase?.tier).toBe('judged');
    expect(repo.sha('main_patched')).toBe(beforeTip); // judged lands at report-pr, not here
  });

  it('with no testPaths configured the same edit is an ordinary scope violation', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const { dir, caseId } = await caseWithTestEdit(repo, ws, inv, []);
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        confirm,
      ),
    ).toBe(0);
    const violation = readJournal(dir).find((e) => e.action === 'scope-violation' && e.caseId === caseId)!;
    expect(violation.extraPaths).toEqual(['src/x.test.ts']);
    expect(readJournal(dir).some((e) => e.action === 'test-edit')).toBe(false);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: scope exceeded]');
  });

  it('the cold-read request names the edited tests, carries the record, and asks the fourth question', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const { dir, caseId } = await caseWithTestEdit(repo, ws, inv);
    let prompt = '';
    const capture: ColdReadInvoker = async (p) => {
      prompt = p;
      return { verdict: 'confirm', answers: { q1: 'ok', q2: 'ok', q3: 'ok', q4: 'ok' }, notes: '' };
    };
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
        capture,
      ),
    ).toBe(0);
    expect(prompt).toContain('TEST FILES EDITED BY THIS RESOLUTION: src/x.test.ts');
    expect(prompt).toContain('Judge them under question 4, not as a scope violation.');
    expect(prompt).toContain('RECORD: a test edit is justified only by this resolution');
    expect(prompt).toContain('a skipped, deleted or weakened assertion — contradicts this record');
    expect(prompt).toContain('4. For each edited test file');
    expect(prompt).toContain('"q4":"..."');
    expect(prompt).toContain('`reject` if any of Q1-Q4 fails');
    expect(caseId).toBeTruthy();
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.rejected === false)).toBe(true);
  });

  /** No block, no question — an ordinary resolution's reader is asked three. */
  it('a resolution that edits no test file is asked three questions and no more', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    await cmdSweepStart(baseCli(repo, ws, inv, { checksFile: testPathsChecks(ws) }));
    await cmdSweepNextCase(baseCli(repo, ws, inv), greenPreMerge);
    const dir = dirOf(repo, ws);
    resolveWorktree(dir, currentCaseId(dir), { 'src/x.ts': 'RESOLVED\n' });
    let prompt = '';
    const capture: ColdReadInvoker = async (p) => {
      prompt = p;
      return { verdict: 'confirm', answers: { q1: 'ok', q2: 'ok', q3: 'ok' }, notes: '' };
    };
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
        capture,
      ),
    ).toBe(0);
    expect(prompt).not.toContain('TEST FILES EDITED BY THIS RESOLUTION');
    expect(prompt).not.toContain('4. For each edited test file');
    expect(prompt).toContain('`reject` if any of Q1-Q3 fails');
  });

  /**
   * AN UNRELATED OR WEAKENED TEST EDIT IS A CONTENT REJECT, on the ordinary
   * two-strike path — NOT a scope escalation. The file was in scope; what was
   * refused is what the edit did to it, and the agent gets one revision.
   */
  it('a q4 rejection revises once, then holds with the two-strike escalation — never a scope tag', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const { dir, caseId } = await caseWithTestEdit(repo, ws, inv);
    const rejectQ4: ColdReadInvoker = async () => ({
      verdict: 'reject',
      answers: { q1: 'ok', q2: 'ok', q3: 'ok', q4: 'src/x.test.ts drops the assertion entirely — unrelated to this merge' },
      notes: 'the test edit stops the question being asked',
      feedback: 'src/x.test.ts no longer asserts anything — restore the assertion against the merged behaviour',
    });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        rejectQ4,
      ),
    ).toBe(1);
    const first = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string };
    expect(first.instruction).toContain('revise the resolution');
    expect(first.instruction).toContain('no longer asserts anything');
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(machineState(dir).phase).toBe('case-ready');
    // SECOND: the retrying stops. The file was IN SCOPE, so the tag is the
    // two-strike one and not `scope exceeded`.
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true, out }),
        rejectQ4,
      ),
    ).toBe(0);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect((held.escalation as { tag: string }).tag).toBe('[AUTO-ESCALATED: cold read rejected 2x]');
    expect(readJournal(dir).some((e) => e.action === 'scope-violation' && e.caseId === caseId)).toBe(false);
  });

  /** Fail-closed on the fourth question too: a reader that cannot judge the
   * test edit from the request has not cleared it. */
  it('UNVERIFIABLE-FROM-REQUEST on q4 is a rejection under an overall confirm', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = branchlessInventory();
    const { dir, caseId } = await caseWithTestEdit(repo, ws, inv);
    const blind: ColdReadInvoker = async () => ({
      verdict: 'confirm',
      answers: { q1: 'ok', q2: 'ok', q3: 'ok', q4: 'UNVERIFIABLE-FROM-REQUEST' },
      notes: 'I cannot tell what the test asserted before',
    });
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }),
        blind,
      ),
    ).toBe(1);
    const row = readJournal(dir).find((e) => e.action === 'coldread' && e.caseId === caseId)!;
    expect(row.rejected).toBe(true);
    expect(row.unverifiable).toEqual(['q4']);
  });
});
