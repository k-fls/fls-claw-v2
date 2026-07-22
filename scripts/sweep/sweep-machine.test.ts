/**
 * scripts/sweep/sweep-machine.test.ts — the D-053 state machine
 * (SWEEP-STATE-MACHINE.md). Every mutating stage runs against throwaway git
 * fixtures; the cold read (`claude -p`) and the GitHub transport are injected so
 * nothing spawns a real subprocess or touches the network.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { isAncestor } from './git.js';
import { readLedger } from './ledger.js';
import {
  cmdSweepAbort,
  cmdSweepFinish,
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdSweepReportPr,
  cmdSweepStart,
  passDir,
  readJournal,
  type Cli,
  type ColdReadInvoker,
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
function baseCli(repo: FixtureRepo, ws: string, inv: string, over: Partial<Cli> = {}): Cli {
  return {
    cmd: 'plan',
    repo: repo.dir,
    workspace: ws,
    inventory: inv,
    scopeFile: join(inv, 'no-scope.yaml'), // non-existent -> empty scope (structural only)
    upstream: 'main',
    execute: false,
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

const confirm: ColdReadInvoker = async () => ({
  verdict: 'confirm',
  notes: 'behaviour preserved; every hunk explained',
});
const rejectCode: ColdReadInvoker = async () => ({
  verdict: 'reject',
  notes: 'silently drops the fork behaviour',
  defect: 'code',
});
const rejectDesc: ColdReadInvoker = async () => ({
  verdict: 'reject',
  notes: 'description misrepresents the resolution',
  defect: 'description',
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
        if (method === 'GET' && /\/pulls\/\d+$/.test(path))
          return { status: 200, body: { number: 7, merged: true, body: 'x' } };
        if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) return { status: 200, body: {} };
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
    await cmdSweepNextCase(baseCli(repo, ws, inv));
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

  it('judged: defers the cold read -> provide PR description, no merge, no cold read', async () => {
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
    expect(res.instruction).toBe('provide PR description');
    expect(res.tier).toBe('judged');
    expect(repo.sha('main_patched')).toBe(beforeTip); // NOT merged yet
    expect(readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId)).toBe(false); // deferred
    const st = machineState(dir);
    expect(st.phase).toBe('awaiting-pr');
    expect(st.currentCase?.tier).toBe('judged');
    expect(existsSync(join(dir, caseId, 'pr', 'materials.md'))).toBe(true);
  });

  it('scope-guard violation -> HELD, frozen, no merge', async () => {
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
    expect(res.instruction).toBe('provide PR description');
    expect(repo.sha('main_patched')).toBe(postRun); // no merge
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('frozen');
  });

  it('mechanical cold-read reject -> HELD (fail-closed)', async () => {
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
        rejectCode,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(machineState(dir).currentCase?.tier).toBe('held');
  });

  it('per-case attempt cap force-HELD after RESOLVE_COLDREAD_CAP distinct non-converging trees (D-052)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const caseId = await toCase(repo, ws, inv);
    // Three distinct never-resolved (marker-laden) trees -> ERR32 each.
    for (let n = 1; n <= 3; n++) {
      resolveWorktree(dir, caseId, { 'src/x.ts': `<<<<<<< a\nattempt ${n}\n=======\nb\n>>>>>>> c\n` });
      expect(
        await cmdSweepReportCase(
          baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
          confirm,
        ),
      ).toBe(1);
    }
    // Fourth distinct tree trips the cap -> force HELD.
    resolveWorktree(dir, caseId, { 'src/x.ts': `<<<<<<< a\nattempt 4\n=======\nb\n>>>>>>> c\n` });
    const out = join(ws, 'rc.json');
    expect(
      await cmdSweepReportCase(
        baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true, out }),
        confirm,
      ),
    ).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { tier: string }).tier).toBe('held');
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
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
    await cmdSweepNextCase(baseCli(repo, ws, inv));
    const dir = dirOf(repo, ws);
    const caseId = currentCaseId(dir);
    if (tier === 'judged') resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier, execute: true }), confirm);
    writePr(dir, caseId, `${tier} case ${caseId}`, `Decision needed: resolution of src/x.ts — study before merge.`);
    return { dir, caseId };
  }

  it('held: single cold read over code+desc -> publishes the draft PR now (before any target push)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched'); // origin BEHIND local (prefix not pushed)
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const { dir, caseId } = await toAwaiting(repo, ws, inv, 'held');
    const gh = fakeGithub();
    const out = join(ws, 'pr.json');
    expect(
      await cmdSweepReportPr(
        baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, tokenFile, out }),
        confirm,
        gh.factory,
      ),
    ).toBe(0);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; published: boolean };
    expect(res.instruction).toBe('take next case');
    expect(res.published).toBe(true);
    const pub = readJournal(dir).find((e) => e.action === 'pr-published' && e.caseId === caseId)!;
    expect(pub.mode).toBe('held');
    expect(pub.draft).toBe(true);
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(true);
    expect(machineState(dir).phase).toBe('open');
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

  it('judged cold-read reject -> HELD (fail-closed), not merged', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const { dir, caseId } = await toAwaiting(repo, ws, inv, 'judged');
    const beforeTip = repo.sha('main_patched');
    const out = join(ws, 'pr.json');
    expect(await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, out }), rejectCode)).toBe(
      1,
    );
    const res = JSON.parse(readFileSync(out, 'utf8')) as { instruction: string; tier: string };
    expect(res.tier).toBe('held');
    expect(res.instruction).toContain('held:');
    expect(repo.sha('main_patched')).toBe(beforeTip); // NOT merged
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(machineState(dir).currentCase?.tier).toBe('held');
  });

  it('description-only defect -> rewrite (no freeze, no publish)', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'tok.txt');
    writeFileSync(tokenFile, 'tok\n');
    const { dir, caseId } = await toAwaiting(repo, ws, inv, 'held');
    const gh = fakeGithub();
    const out = join(ws, 'pr.json');
    expect(
      await cmdSweepReportPr(
        baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true, tokenFile, out }),
        rejectDesc,
        gh.factory,
      ),
    ).toBe(1);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { instruction: string }).instruction).toContain('rewrite:');
    expect(readJournal(dir).some((e) => e.action === 'pr-published' && e.caseId === caseId)).toBe(false);
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(false);
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
    await cmdSweepNextCase(baseCli(repo, ws, inv));
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'judged', execute: true }), confirm);
    writePr(dir, caseId, 'judged x', 'Decision needed: keep the fork line in src/x.ts.');
    await cmdSweepReportPr(baseCli(repo, ws, inv, { cmd: 'report-pr', execute: true }), confirm);
    expect((await cmdSweepNextCase(baseCli(repo, ws, inv))) === 0).toBe(true); // finalize

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

  it('red verify -> halt (resumable); a re-run with a green gate completes', async () => {
    const repo = cleanFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv)); // clean, finalize
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: failCmds(ws), out: out1 }),
      ),
    ).toBe(1);
    expect((JSON.parse(readFileSync(out1, 'utf8')) as { halted: string }).halted).toBe('verify');
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

  it('a failed target push (ERR15) halts finish; re-running after the fix completes without re-pushing', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv));
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    await cmdSweepReportCase(
      baseCli(repo, ws, inv, { cmd: 'report-case', tier: 'mechanical', execute: true }),
      confirm,
    );
    await cmdSweepNextCase(baseCli(repo, ws, inv)); // finalize

    // Break the transport (credential-proxy failure mode), then finish.
    repo.git('config', '--unset', `url.${bare}.insteadOf`);
    const out1 = join(ws, 'f1.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: passCmds(ws), out: out1 }),
      ),
    ).toBe(1);
    expect((JSON.parse(readFileSync(out1, 'utf8')) as { halted: string }).halted).toBe('push');
    expect(readJournal(dir).some((e) => e.action === 'push' && e.kind === 'target')).toBe(false); // nothing pushed

    // Fix the transport, re-run: verify still green, push now lands, complete.
    repo.git('config', `url.${bare}.insteadOf`, 'https://github.com/k-fls/fixture.git');
    const out2 = join(ws, 'f2.json');
    expect(
      await cmdSweepFinish(
        baseCli(repo, ws, inv, { cmd: 'sweep-finish', execute: true, commandsFile: passCmds(ws), out: out2 }),
      ),
    ).toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'push' && e.kind === 'target').length).toBe(1);
    expect(repo.git('-C', bare, 'rev-parse', 'refs/heads/main_patched')).toBe(repo.sha('main_patched'));
  });
});

describe('sweep — crash resume (machine-state drives re-entry, D-053 §5)', () => {
  it('a re-invoked next-case re-serves the same open case idempotently', async () => {
    const repo = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = dirOf(repo, ws);
    await cmdSweepStart(baseCli(repo, ws, inv));
    await cmdSweepNextCase(baseCli(repo, ws, inv));
    const caseId1 = currentCaseId(dir);
    // "dead container resumes": a fresh next-case reads the machine state + journal.
    await cmdSweepNextCase(baseCli(repo, ws, inv));
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
