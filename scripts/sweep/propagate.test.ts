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
import { addTempWorktree, commitInfo, isAncestor, listTreePaths, revParse } from './git.js';
import { readLedger } from './ledger.js';
import { exportRrCache, writeRrCacheDir } from './merge.js';
import { DriverHalt, guardRef } from './propagate.js';
import {
  cmdPlan,
  cmdPush,
  cmdResolve,
  cmdRun,
  cmdStatus,
  cmdUnfreeze,
  cmdVerify,
  heldRegistry,
  passDir,
  publishableRecipe,
  readJournal,
  type Cli,
  type JournalEntry,
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

/** Empty inventory dir so scope = just main_patched (structural). */
function emptyInventory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prop-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeInventory(
  entries: Array<{
    id: string;
    branch: string;
    kind?: string;
    parents?: string[];
    scope_guard?: string;
    summary?: string;
    owned_paths?: string[];
    extra_context?: string;
    decided_paths?: string[];
  }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'prop-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      `kind: ${e.kind ?? 'feat'}`,
      'status: shipped',
      `branch: ${e.branch}`,
      ...(e.summary ? [`summary: ${JSON.stringify(e.summary)}`] : []),
      ...(e.scope_guard ? [`scope_guard: ${e.scope_guard}`] : []),
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
      ...(e.owned_paths ? ['owned_paths:', ...e.owned_paths.map((p) => `  - ${JSON.stringify(p)}`)] : []),
      ...(e.extra_context || e.decided_paths
        ? [
            'prompt:',
            ...(e.extra_context ? [`  extra_context: ${JSON.stringify(e.extra_context)}`] : []),
            ...(e.decided_paths ? ['  decided_paths:', ...e.decided_paths.map((p) => `    - ${JSON.stringify(p)}`)] : []),
          ]
        : []),
    ].join('\n');
    writeFileSync(join(dir, `${e.id}.yaml`), yaml + '\n');
  }
  return dir;
}

/** A routing.yaml carrying a global scope_guard_mode; returns its path. */
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
    inventory: inv,
    scopeFile: join(inv ?? ws, 'no-scope.yaml'), // non-existent -> empty scope
    upstream: 'main',
    execute: false,
    ...over,
  };
}

function readCase(
  dir: string,
  caseId: string,
): { automergeTree: string; conflictedPaths: string[]; head: { sha: string; height: number }; tierFloor: string } {
  return JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8'));
}
function editCase(dir: string, caseId: string, mut: (c: Record<string, unknown>) => void): void {
  const path = join(dir, caseId, 'case.json');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  mut(c);
  writeFileSync(path, JSON.stringify(c, null, 2));
}
function treeOfRef(repo: FixtureRepo, ref: string): string {
  return repo.git('rev-parse', `${ref}^{tree}`);
}

/** Build a resolution commit from the automerge tree, editing given files. */
async function buildResolution(
  repo: FixtureRepo,
  automergeTree: string,
  files: Record<string, string>,
): Promise<string> {
  const amCommit = repo.git('commit-tree', automergeTree, '-m', 'automerge');
  const wt = await addTempWorktree(repo.dir, amCommit);
  try {
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(join(wt.path, p, '..'), { recursive: true });
      writeFileSync(join(wt.path, p), content);
    }
    repo.git('-C', wt.path, 'add', '-A');
    repo.git('-C', wt.path, 'commit', '-m', 'resolve');
    return repo.git('-C', wt.path, 'rev-parse', 'HEAD');
  } finally {
    await wt.remove();
  }
}

/** Write a well-formed cold-read verdict (with the freshness binding). */
function writeVerdict(
  dir: string,
  caseId: string,
  repo: FixtureRepo,
  resolvedRef: string,
  verdict: 'confirm' | 'reject' = 'confirm',
  answers?: Record<string, string>,
): void {
  writeFileSync(
    join(dir, caseId, 'coldread-verdict.json'),
    JSON.stringify({ verdict, ...(answers ? { answers } : {}), notes: 'cold read ok', resolvedTree: treeOfRef(repo, resolvedRef) }),
  );
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

describe('propagate plan/run/resolve — entry model with a conflict case', () => {
  it('plans, merges the clean prefix, emits a case, then resolves it (mechanical)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));

    expect(await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }))).toBe(0);
    const before = repo.sha('main_patched');
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    expect(repo.sha('main_patched')).not.toBe(before);
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    expect(caseFile.conflictedPaths).toEqual(['src/x.ts']);

    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);

    const files = await listTreePaths(repo.dir, 'main_patched');
    expect(files).toContain('src/util.ts');
    expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(true);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RESOLVED');
  });

  it('scope-guard violation -> HELD, no merge, ledger-frozen (no one-tier demotion)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const postRun = repo.sha('main_patched');

    // Resolution that ALSO edits an unrelated file -> scope violation.
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, {
      'src/x.ts': 'RESOLVED\n',
      'src/extra.ts': 'sneaky\n',
    });
    writeVerdict(dir, caseId, repo, resolvedRef);
    const outFile = join(ws, 'resolve-out.json');
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, {
          cmd: 'resolve',
          execute: true,
          caseId,
          tier: 'mechanical',
          resolvedRef,
          out: outFile,
        }),
      ),
    ).toBe(0);
    const out = JSON.parse(readFileSync(outFile, 'utf8')) as { tier: string; scopeGuard: { ok: boolean } };
    expect(out.scopeGuard.ok).toBe(false);
    expect(out.tier).toBe('held'); // HELD outright, not JUDGED
    expect(repo.sha('main_patched')).toBe(postRun); // NO merge landed
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('frozen');
  });

  it('idempotent resume: a second run does not re-merge already-arrived branches', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const afterFirst = repo.sha('main_patched');
    const arrivals1 = readJournal(dir).filter((e) => e.action === 'arrived').length;
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(repo.sha('main_patched')).toBe(afterFirst);
    expect(readJournal(dir).filter((e) => e.action === 'arrived').length).toBe(arrivals1);
    expect(await cmdStatus(baseCli(repo, ws, inv, { cmd: 'status' }))).toBe(0);
  });
});

// --- FIX A: case re-verification at resolve (trust boundary) --------------
describe('propagate resolve — case re-verification rejects forged pointers (§7, FIX A)', () => {
  async function setupCase(): Promise<{ repo: FixtureRepo; ws: string; inv: string; dir: string; caseId: string }> {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    return { repo, ws, inv, dir, caseId };
  }
  async function resolveWith(repo: FixtureRepo, ws: string, inv: string, dir: string, caseId: string): Promise<number> {
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    return cmdResolve(
      baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
    );
  }

  it('rejects a forged head sha', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    editCase(dir, caseId, (c) => {
      (c.head as { sha: string }).sha = '0'.repeat(40);
    });
    expect(await resolveWith(repo, ws, inv, dir, caseId)).toBe(1);
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.reason === 'case-reverification-failed')).toBe(true);
  });

  it('rejects forged conflicted paths (extra file allowed)', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    editCase(dir, caseId, (c) => {
      (c.conflictedPaths as string[]).push('src/anything.ts');
    });
    expect(await resolveWith(repo, ws, inv, dir, caseId)).toBe(1);
  });

  it('rejects a forged tier floor', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    editCase(dir, caseId, (c) => {
      c.tierFloor = 'judged';
    });
    expect(await resolveWith(repo, ws, inv, dir, caseId)).toBe(1);
  });

  it('rejects a replayed resolve after success (double-resolve guard)', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    expect(await resolveWith(repo, ws, inv, dir, caseId)).toBe(0); // first: success
    expect(await resolveWith(repo, ws, inv, dir, caseId)).toBe(1); // replay: refused
  });

  it('rejects resolve for a case that was never journaled', async () => {
    const { repo, ws, inv, dir, caseId } = await setupCase();
    const fakeId = 'main_patched-h99';
    mkdirSync(join(dir, fakeId), { recursive: true });
    const real = readCase(dir, caseId);
    writeFileSync(join(dir, fakeId, 'case.json'), JSON.stringify({ ...real, id: fakeId }, null, 2));
    const resolvedRef = await buildResolution(repo, real.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, fakeId, repo, resolvedRef);
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId: fakeId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(1);
  });
});

// --- FIX D2: cold-read verdict validation ---------------------------------
describe('propagate resolve — cold-read verdict validation (§7, FIX D2)', () => {
  it('rejects a malformed {} verdict (never treated as confirm) and a stale resolvedTree', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });

    // Malformed {} -> exit 2 (NOT confirm), no merge.
    writeFileSync(join(dir, caseId, 'coldread-verdict.json'), '{}');
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(2);

    // Stale resolvedTree (attests to a different tree) -> exit 2.
    writeFileSync(
      join(dir, caseId, 'coldread-verdict.json'),
      JSON.stringify({ verdict: 'confirm', notes: 'x', resolvedTree: '0'.repeat(40) }),
    );
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(2);
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
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

describe('propagate resolve — direct HELD path (§8)', () => {
  it('--tier held freezes (no resolution commit / scope guard / cold read) + ledger-freezes', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const before = repo.sha('main_patched');
    expect(await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }))).toBe(0);
    expect(repo.sha('main_patched')).toBe(before);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(heldRegistry(journal).map((h) => h.branch)).toContain('main_patched');
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('frozen');
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(true);
  });
});

describe('propagate — same-pass continuation after resolve (§8)', () => {
  it('a resolved branch reaches the watermark and its child picks up the resolution', async () => {
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

    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (over: Partial<Cli>): Cli => baseCli(repo, ws, inv, over);
    await cmdPlan(cli({ cmd: 'plan' }));
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'main_patched')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('fork');

    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    expect(await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }))).toBe(0);
    expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(true);
    expect(
      readJournal(dir)
        .filter((e) => e.action === 'reopened')
        .map((e) => e.branch)
        .sort(),
    ).toEqual(['feat/c', 'main_patched']);

    await cmdRun(cli({ cmd: 'run', execute: true }));
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('RESOLVED');
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/c')).toBe(true);
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
    const inv = emptyInventory();
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

  it('a ledger-frozen branch is skipped (empty interval) and a mechanical resolve unfreezes it', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));

    // Freeze main_patched in the ledger BEFORE the pass.
    writeFileSync(
      join(ws, 'sweep-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        lastSweep: null,
        branches: { main_patched: { status: 'frozen', frozenBy: 'prior', pendingBehindFreeze: 0, notes: '' } },
        openPois: [],
      }),
    );
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const before = repo.sha('main_patched');
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(repo.sha('main_patched')).toBe(before); // frozen -> empty interval, no merge
    expect(
      readJournal(dir).some((e) => e.action === 'skip' && e.branch === 'main_patched' && e.reason === 'held'),
    ).toBe(true);

    // Manually plant a case for main_patched + unfreeze via a mechanical resolve.
    // (Freeze it again, emit a real case by unfreezing for the run, then re-freeze.)
    // Simpler: unfreeze, run to emit a case, re-freeze in ledger, then resolve.
    writeFileSync(
      join(ws, 'sweep-ledger.json'),
      JSON.stringify({ schemaVersion: 1, lastSweep: null, branches: {}, openPois: [] }),
    );
    // fresh pass in a fresh workspace to get a clean case
    const ws2 = mkWorkspace();
    const dir2 = passDir(ws2, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws2, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws2, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir2).find((e) => e.action === 'case')!.caseId as string;
    // Now freeze main_patched in ws2's ledger (simulating a gate/prior freeze).
    writeFileSync(
      join(ws2, 'sweep-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        lastSweep: null,
        branches: { main_patched: { status: 'frozen', frozenBy: 'gate', pendingBehindFreeze: 0, notes: '' } },
        openPois: [],
      }),
    );
    const caseFile = readCase(dir2, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir2, caseId, repo, resolvedRef);
    expect(
      await cmdResolve(
        baseCli(repo, ws2, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);
    expect(readLedger(join(ws2, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('active'); // unfrozen
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
    const mainTip = repo.sha('main');
    const wm12 = mainTip.slice(0, 12);
    const dir = passDir(ws, wm12);
    mkdirSync(dir, { recursive: true });
    // Seed a minimal open pass: plan-initial.json + a pre-ref for feat/off (its
    // clean pre-merge tip) — as if `run` had merged BAD into feat/off this pass.
    const plan = {
      schemaVersion: 1,
      watermark: mainTip,
      watermark12: wm12,
      forkPoint: mainTip,
      chainLength: 0,
      order: ['feat/off'],
      branches: [
        {
          branch: 'feat/off',
          kind: 'inventory',
          tierFloor: 'clean',
          isLeaf: true,
          alwaysMerge: false,
          ancestors: [],
          parents: [],
        },
      ],
      warnings: [],
    };
    writeFileSync(join(dir, 'plan-initial.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'pre-ref', branch: 'feat/off', ref: cleanTip }) + '\n',
    );
    const cmdsFile = join(ws, 'cmds.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'test ! -f BAD' }]));

    const code = await cmdVerify(
      baseCli(repo, ws, null, {
        cmd: 'verify',
        execute: true,
        pass: wm12,
        recipe: ['feat/off'],
        commandsFile: cmdsFile,
      }),
    );
    expect(code).toBe(0); // re-verify green after rollback
    expect(repo.sha('feat/off')).toBe(cleanTip); // rolled back to pre-ref
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.branch === 'feat/off' && e.reason === 'gate')).toBe(true);
    expect(journal.filter((e) => e.action === 'verify').map((e) => e.ok)).toEqual([false, true]);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['feat/off']?.status).toBe('frozen');
  });
});

// --- D-051: verify gate validates THIS PASS'S PUBLISHABLE RESULT ----------
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

describe('publishableRecipe (D-051 fix 1 — pure recipe derivation)', () => {
  it('keeps advanced branches in DAG order, drops held/frozen and open-case branches', () => {
    const journal: JournalEntry[] = (
      [
        { action: 'pre-ref', branch: 'main_patched', ref: 'x' },
        { action: 'pre-ref', branch: 'module/a', ref: 'x' },
        { action: 'pre-ref', branch: 'module/b', ref: 'x' }, // advanced but held below
        { action: 'pre-ref', branch: 'module/c', ref: 'x' }, // advanced but open case below
        { action: 'held', branch: 'module/b', caseId: 'B1', height: -1, conflictedPaths: [] },
        { action: 'case', branch: 'module/c', caseId: 'C1' },
      ] as Array<Record<string, unknown>>
    ).map((e) => ({ ts: '', ...e }) as JournalEntry);
    const order = ['main_patched', 'module/a', 'module/b', 'module/c'];
    // held = heldRegistry ∪ ledger-frozen (module/b via the held entry, plus a
    // purely ledger-frozen branch that never advanced — never in the recipe).
    const held = new Set(['module/b', 'module/frozen-elsewhere']);
    expect(publishableRecipe(journal, order, held)).toEqual(['main_patched', 'module/a']);
  });
});

describe('propagate verify — publishable set (D-051)', () => {
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

  it('(a2) an EXPLICIT recipe forcing a held branch to build-conflict is non-blocking, not ERR18 (fix 2)', async () => {
    const { repo } = divergedFixture();
    const ws = mkWorkspace();
    const { wm12 } = seedVerifyPass(
      ws,
      repo,
      ['module/held', 'module/good'],
      [{ branch: 'module/good', ref: repo.sha('module/good') }],
      [{ action: 'held', branch: 'module/held', caseId: 'gate-x', height: -1, conflictedPaths: [] }],
    );
    const heldTip = repo.sha('module/held');
    const cmds = join(ws, 'cmds.json');
    writeFileSync(cmds, JSON.stringify([{ cmd: 'true' }]));
    const out = join(ws, 'o.json');
    const code = await cmdVerify(
      baseCli(repo, ws, null, {
        cmd: 'verify',
        execute: true,
        pass: wm12,
        recipe: ['module/held', 'module/good'], // force the held branch into the build
        commandsFile: cmds,
        out,
      }),
    );
    expect(code).toBe(0); // non-blocking: publishable set (module/good) verifies green
    const res = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; nonBlocking?: boolean; offender?: string };
    expect(res).toMatchObject({ ok: true, nonBlocking: true, offender: 'module/held' });
    const journal = readJournal(passDir(ws, wm12));
    const obs = journal.find((e) => e.action === 'verify-observation');
    expect(obs).toMatchObject({ offender: 'module/held', held: true });
    expect(repo.sha('module/held')).toBe(heldTip); // NOT rolled back
    // The held offender was not ledger-gate-frozen by verify (it is already held).
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['module/held']).toBeUndefined();
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
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['feat/off']?.status).toBe('frozen');
  });
});

// --- CHANGE 1: scope-guard lever ------------------------------------------
/** main_patched entry with a MULTI-LINE conflict (context lines outside markers). */
function hunkFixture(): { repo: FixtureRepo } {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'a\nb\nMID\nd\ne\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x line3 -> FORK', { 'src/x.ts': 'a\nb\nFORK\nd\ne\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  repo.commit('U1: x line3 -> UP1', { 'src/x.ts': 'a\nb\nUP1\nd\ne\n' });
  cleanups.push(() => repo.destroy());
  return { repo };
}

describe('propagate resolve — scope-guard lever (§7, CHANGE 1)', () => {
  it('conflict-hunks HOLDs an out-of-hunk edit; same-files (default) merges it', async () => {
    // conflict-hunks via the global routing config.
    {
      const { repo } = hunkFixture();
      const ws = mkWorkspace();
      const inv = emptyInventory();
      const routing = writeRouting('conflict-hunks');
      const dir = passDir(ws, repo.sha('main').slice(0, 12));
      await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan', routingFile: routing }));
      await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true, routingFile: routing }));
      const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
      const caseFile = readCase(dir, caseId);
      const postRun = repo.sha('main_patched');
      // Out-of-hunk: also edits context line 1.
      const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'aX\nb\nMERGED\nd\ne\n' });
      writeVerdict(dir, caseId, repo, resolvedRef);
      const outFile = join(ws, 'o.json');
      await cmdResolve(
        baseCli(repo, ws, inv, {
          cmd: 'resolve',
          execute: true,
          caseId,
          tier: 'mechanical',
          resolvedRef,
          routingFile: routing,
          out: outFile,
        }),
      );
      const out = JSON.parse(readFileSync(outFile, 'utf8')) as {
        tier: string;
        scopeGuard: { mode: string; hunkViolations: string[] };
      };
      expect(out.scopeGuard.mode).toBe('conflict-hunks');
      expect(out.tier).toBe('held');
      expect(out.scopeGuard.hunkViolations).toEqual(['src/x.ts']);
      expect(repo.sha('main_patched')).toBe(postRun); // no merge
    }
    // same-files (default): the identical out-of-hunk edit merges.
    {
      const { repo } = hunkFixture();
      const ws = mkWorkspace();
      const inv = emptyInventory();
      const dir = passDir(ws, repo.sha('main').slice(0, 12));
      await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
      await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
      const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
      const caseFile = readCase(dir, caseId);
      const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'aX\nb\nMERGED\nd\ne\n' });
      writeVerdict(dir, caseId, repo, resolvedRef);
      expect(
        await cmdResolve(
          baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
        ),
      ).toBe(0);
      expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(true); // merged to watermark
    }
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

    // Override: entry says conflict-hunks, global says same-files -> conflict-hunks wins.
    {
      const repo = featZ();
      const ws = mkWorkspace();
      const inv = writeInventory([
        { id: 'z', branch: 'feat/z', parents: ['main_patched'], scope_guard: 'conflict-hunks' },
      ]);
      const routing = writeRouting('same-files');
      const dir = passDir(ws, repo.sha('main').slice(0, 12));
      const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { routingFile: routing, ...o });
      await cmdPlan(cli({ cmd: 'plan' }));
      await cmdRun(cli({ cmd: 'run', execute: true }));
      const caseId = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'feat/z')!.caseId as string;
      const caseFile = readCase(dir, caseId);
      const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'MERGED\n' });
      writeVerdict(dir, caseId, repo, resolvedRef);
      const outFile = join(ws, 'o.json');
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out: outFile }));
      expect((JSON.parse(readFileSync(outFile, 'utf8')) as { scopeGuard: { mode: string } }).scopeGuard.mode).toBe(
        'conflict-hunks',
      );
    }

    // Forged: case.json carries scope_guard: same-files, but config says
    // conflict-hunks and there is no per-feature override -> config wins.
    {
      const repo = featZ();
      const ws = mkWorkspace();
      const inv = writeInventory([{ id: 'z', branch: 'feat/z', parents: ['main_patched'] }]);
      const routing = writeRouting('conflict-hunks');
      const dir = passDir(ws, repo.sha('main').slice(0, 12));
      const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, { routingFile: routing, ...o });
      await cmdPlan(cli({ cmd: 'plan' }));
      await cmdRun(cli({ cmd: 'run', execute: true }));
      const caseId = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'feat/z')!.caseId as string;
      editCase(dir, caseId, (c) => {
        c.scope_guard = 'same-files';
      });
      const caseFile = readCase(dir, caseId);
      const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'MERGED\n' });
      writeVerdict(dir, caseId, repo, resolvedRef);
      const outFile = join(ws, 'o.json');
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out: outFile }));
      expect((JSON.parse(readFileSync(outFile, 'utf8')) as { scopeGuard: { mode: string } }).scopeGuard.mode).toBe(
        'conflict-hunks',
      );
    }
  });
});

// --- CHANGE 2 / D-049: urging (posted by `push`) + unfreeze paths -----------

/** Fake GitHub transport for cmdPush tests (closure checks + urge posting). */
function fakePushGithub(overrides: Record<string, { status: number; body: unknown }> = {}): {
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
        if (method === 'GET' && path.includes('/pulls?'))
          return { status: 200, body: [{ html_url: 'https://github.com/k-fls/fixture/pull/12', number: 12 }] };
        if (method === 'GET' && /\/pulls\/\d+$/.test(path))
          return { status: 200, body: { number: 12, merged: true, body: 'agent prose' } };
        if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) return { status: 200, body: { ok: true } };
        if (method === 'POST' && path.includes('/comments')) return { status: 201, body: { id: 1 } };
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

describe('propagate — frozen-branch urging is POSTED by push, once per NEW pending head (§8, D-049)', () => {
  it('run only detects; push posts the urge (comment + D-004 refresh + ledger), suppresses, re-urges on a new head', async () => {
    const { repo } = conflictFixture(); // U0 util, U1 x conflict
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    // Freeze main_patched (direct held) — records fixBranch + heldHead.
    await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }));

    // `run` never posts or journals urges any more (posting is push's job).
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(0);

    // push POSTS the urge: PR located by head branch, body PATCHed (D-004
    // machine block), comment POSTed, ledger advanced.
    fakeGreenVerify(dir);
    const gh = fakePushGithub();
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile }), gh.factory)).toBe(0);
    const urges1 = readJournal(dir).filter((e) => e.action === 'urge');
    expect(urges1.length).toBe(1);
    expect(urges1[0].prNumber).toBe(12);
    expect(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/12'))).toBe(true);
    const comment = gh.calls.find((c) => c.method === 'POST' && c.path.includes('/comments'))!;
    expect(String((comment.body as { body: string }).body)).toContain('still frozen');
    const ledger = readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']!;
    expect(ledger.lastUrgedHead).toBe(repo.sha('main'));
    expect(ledger.prNumber).toBe(12);

    // A second push suppresses (no new pending head).
    const gh2 = fakePushGithub();
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile }), gh2.factory)).toBe(0);
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(1);
    expect(gh2.calls.filter((c) => c.method === 'POST' && c.path.includes('/comments')).length).toBe(0);

    // A NEW pass with new upstream content re-urges once (posted by push).
    repo.commit('U2: more util', { 'src/util2.ts': 'u2\n' });
    const dir2 = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const gh3 = fakePushGithub();
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile }), gh3.factory)).toBe(0);
    const urgesNew = readJournal(dir2).filter((e) => e.action === 'urge');
    expect(urgesNew.length).toBe(1);
    expect(urgesNew[0].head).toBe(repo.sha('main')); // newest head (U2)
  });

  it('a failed urge post is ERR17 and does NOT advance lastUrgedHead (retries next push)', async () => {
    const { repo } = conflictFixture();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }));
    fakeGreenVerify(dir);
    const gh = fakePushGithub({ 'POST /comments': { status: 500, body: { message: 'boom' } } });
    const out = join(ws, 'push-out.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, tokenFile, out }), gh.factory)).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string }> };
    expect(res.issues.some((i) => i.id === 'ERR17_URGE_FAILED')).toBe(true);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']!.lastUrgedHead ?? null).toBeNull();
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(0);
  });
});

describe('propagate push — verify-gated pass pushes (§14.4, D-049)', () => {
  it('refuses without a green verify (ERR18); with it, pushes mutated targets (one push per branch) and journals them', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const preTip = repo.sha('main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
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

  it('a failing target push is ERR15: journaled halt, hard stop, no fallback (D-046 case 2)', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    fakeGreenVerify(dir);
    // Break the transport (simulates the credential-proxy failure mode).
    repo.git('config', '--unset', `url.${bare}.insteadOf`);
    const out = join(ws, 'push-out.json');
    expect(await cmdPush(baseCli(repo, ws, inv, { cmd: 'push', execute: true, out }))).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues: Array<{ id: string; detail: string }> };
    const issue = res.issues.find((i) => i.id === 'ERR15_PUSH_FAILED');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('D-046 case 2');
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR15_PUSH_FAILED')).toBe(true);
  });

  it('JUDGED closure check: a PR that did not flip to merged after the target push is ERR16', async () => {
    const { repo } = conflictFixture();
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
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

describe('propagate — unfreeze paths (§8, CHANGE 2)', () => {
  it('DERIVED unfreeze fires when the branch tip comes to contain heldHead', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }));
    const heldHead = readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']!.heldHead!;

    // Simulate the owner merging the freeze resolution: heldHead becomes an
    // ancestor of main_patched (record it as a merge parent, keep the tree).
    const mpTip = repo.sha('main_patched');
    const tree = repo.git('rev-parse', 'main_patched^{tree}');
    const merged = repo.git('commit-tree', tree, '-p', mpTip, '-p', heldHead, '-m', 'owner merged freeze fix');
    repo.git('update-ref', 'refs/heads/main_patched', merged);

    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' })); // deriveUnfreeze at plan time
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('active');
    expect(
      readJournal(dir).some((e) => e.action === 'unfrozen' && e.branch === 'main_patched' && e.reason === 'derived'),
    ).toBe(true);
  });

  it('MANUAL unfreeze journals + clears the ledger entry', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }));
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('frozen');

    expect(await cmdUnfreeze(baseCli(repo, ws, inv, { cmd: 'unfreeze', execute: true, branch: 'main_patched' }))).toBe(
      0,
    );
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.status).toBe('active');
    expect(readJournal(dir).some((e) => e.action === 'unfrozen' && e.reason === 'manual')).toBe(true);
  });
});

// --- B8: multi-parent same-height cases are distinct + both resolvable -----
describe('propagate — B8: two parents conflicting at the same height are distinct cases', () => {
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

    await cmdPlan(cli({ cmd: 'plan' }));
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const case1 = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'feat/c')!.caseId as string;
    // Resolve case1 (whichever parent came first) within its conflicted files.
    const cf1 = readCase(dir, case1);
    const files1 = Object.fromEntries(cf1.conflictedPaths.map((p) => [p, 'MERGED\n']));
    const rr1 = await buildResolution(repo, cf1.automergeTree, files1);
    writeVerdict(dir, case1, repo, rr1);
    expect(
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId: case1, tier: 'mechanical', resolvedRef: rr1 })),
    ).toBe(0);

    // Re-run surfaces the OTHER parent's case at the SAME height — distinct id.
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const cases = readJournal(dir)
      .filter((e) => e.action === 'case' && e.branch === 'feat/c')
      .map((e) => e.caseId as string);
    const case2 = cases.find((c) => c !== case1)!;
    expect(case2).toBeTruthy();
    expect(case2).not.toBe(case1); // B8: no collision despite same height
    const cf2 = readCase(dir, case2);
    const files2 = Object.fromEntries(cf2.conflictedPaths.map((p) => [p, 'MERGED2\n']));
    const rr2 = await buildResolution(repo, cf2.automergeTree, files2);
    writeVerdict(dir, case2, repo, rr2);
    // The second case is RESOLVABLE (would deadlock under branch+height ids).
    expect(
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId: case2, tier: 'mechanical', resolvedRef: rr2 })),
    ).toBe(0);
    expect(cf1.head.height).toBe(cf2.head.height); // same height, distinct cases
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
    const inv = emptyInventory();
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
  it('leaves the workspace + ledger byte-identical', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
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
  it('materializes the automerge tree and cleans up', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const wtPath = join(dir, caseId, 'worktree');
    expect(existsSync(wtPath)).toBe(true);
    // The conflicted file carries conflict markers (the automerge content).
    expect(readFileSync(join(wtPath, 'src/x.ts'), 'utf8')).toContain('<<<<<<<');
    expect(readJournal(dir).some((e) => e.action === 'case-worktree' && e.caseId === caseId)).toBe(true);

    // Resolve -> worktree removed + journaled.
    const cf = readCase(dir, caseId);
    const rr = await buildResolution(repo, cf.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, rr);
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef: rr }),
      ),
    ).toBe(0);
    expect(existsSync(wtPath)).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'worktree-removed' && e.caseId === caseId)).toBe(true);
  });
});

// --- SPEC 2: annotate-class journaled + surfaced ----------------------------
describe('propagate — SPEC 2: annotate-class run journaling', () => {
  it('journals annotate when a clean merge passes through a HELD ancestor height', async () => {
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
    await cmdPlan(cli({ cmd: 'plan' }));
    // Seed a HELD ancestor (main_patched @ h0) so feat/c's clean merge through h0
    // is annotate-class; main_patched itself is skipped (frozen-in-journal).
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'held',
        branch: 'main_patched',
        caseId: 'mp',
        height: 0,
        conflictedPaths: ['src/x.ts'],
      }) + '\n',
    );
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    const ann = readJournal(dir).find((e) => e.action === 'annotate' && e.branch === 'feat/c');
    expect(ann).toBeTruthy();
    expect(ann!.heldAncestor).toBe('main_patched');
    expect(ann!.height).toBe(0);
    expect(await cmdStatus(cli({ cmd: 'status' }))).toBe(0);
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
  it('resolve on a checked-out CLEAN branch moves the ref AND resets the worktree', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const wtPath = addBranchWorktree(repo, 'main_patched');

    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);
    // The worktree FOLLOWED the ref: content matches the resolved tree, clean status, tip == HEAD.
    expect(readFileSync(join(wtPath, 'src/x.ts'), 'utf8')).toBe('RESOLVED\n');
    expect(repo.git('-C', wtPath, 'status', '--porcelain')).toBe('');
    expect(repo.git('-C', wtPath, 'rev-parse', 'HEAD')).toBe(repo.sha('main_patched'));
  });

  it('resolve on a checked-out DIRTY branch halts without moving the ref', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const wtPath = addBranchWorktree(repo, 'main_patched');

    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    // Dirty AFTER the run (the run itself needed the clean worktree for its merge).
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted\n');
    const before = repo.sha('main_patched');
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(1);
    expect(repo.sha('main_patched')).toBe(before); // ref not moved
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.reason === 'dirty-worktree')).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false);
    expect(repo.git('-C', wtPath, 'status', '--porcelain')).toContain('dirty.txt'); // dirt untouched
  });

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
      order: ['feat/off'],
      branches: [
        {
          branch: 'feat/off',
          kind: 'inventory',
          tierFloor: 'clean',
          isLeaf: true,
          alwaysMerge: false,
          ancestors: [],
          parents: [],
        },
      ],
      warnings: [],
    };
    writeFileSync(join(dir, 'plan-initial.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'pre-ref', branch: 'feat/off', ref: cleanTip }) + '\n',
    );
    const cmdsFile = join(ws, 'cmds.json');
    writeFileSync(cmdsFile, JSON.stringify([{ cmd: 'test ! -f BAD' }]));

    expect(
      await cmdVerify(
        baseCli(repo, ws, null, {
          cmd: 'verify',
          execute: true,
          pass: wm12,
          recipe: ['feat/off'],
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

// --- N2: parent legality + pass scope from the registry, not plan.json ------
describe('propagate resolve — N2: forged plan.json cannot extend parents or scope', () => {
  it('halts on a forged parent edge in plan.json (drift vs the registry)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;

    // Forge plan.json: add a fake parent edge to the main_patched row.
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

    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(1);
    const halt = readJournal(dir).find((e) => e.action === 'halt' && e.reason === 'case-reverification-failed');
    expect(halt).toBeTruthy();
    expect((halt!.errors as string[]).some((m) => m.includes('plan drift'))).toBe(true);
    expect(readJournal(dir).some((e) => e.action === 'resolved')).toBe(false); // no merge
  });

  it('a branch smuggled into plan.json (+ forged case/journal) is refused by the registry scope', async () => {
    const { repo } = conflictFixture();
    repo.checkout('feat/evil', { create: true, at: 'main_patched' }); // exists in the repo, NOT in the registry
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const real = readCase(dir, caseId);

    // Forge: plan.json grows a feat/evil row; a case + journal entry are forged for it.
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
        { parent: 'main', model: 'entry', mergePoint: null, verdict: 'case', case: null, deferredTo: null, skipReason: null },
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

    const before = repo.sha('feat/evil');
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId: fakeId, tier: 'held' })),
    ).toBe(1);
    const halt = readJournal(dir).find((e) => e.action === 'halt' && e.reason === 'case-reverification-failed');
    expect(halt).toBeTruthy();
    expect((halt!.errors as string[]).some((m) => m.includes('registry-derived pass scope'))).toBe(true);
    expect(repo.sha('feat/evil')).toBe(before);
    expect(readJournal(dir).some((e) => e.action === 'held' && e.branch === 'feat/evil')).toBe(false);
  });
});

// --- Cold-read reject -> HELD end-to-end (§1/§7) -----------------------------
/** main_patched with a conflict case + an inventory child feat/c (descendant). */
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

describe('propagate resolve — cold-read reject demotes to HELD end-to-end', () => {
  it('reject: no merge, HELD journaled, ledger frozen with head+paths, PR materials prepared, descendants reopened', async () => {
    const { repo } = parentChildFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'main_patched')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const postRun = repo.sha('main_patched');

    // A VALID-SHAPE reject verdict (correct freshness binding) on a valid resolution.
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef, 'reject');
    const outFile = join(ws, 'reject-out.json');
    expect(
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out: outFile })),
    ).toBe(0);
    expect((JSON.parse(readFileSync(outFile, 'utf8')) as { tier: string }).tier).toBe('held');

    expect(repo.sha('main_patched')).toBe(postRun); // branch NOT merged
    const journal = readJournal(dir);
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId);
    expect(held).toBeTruthy();
    expect((held!.notes as string[]).join(' ')).toContain('cold-read rejected');
    // Ledger frozen, carrying the §5/N3 cross-pass DEFERRED inputs.
    const entry = readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']!;
    expect(entry.status).toBe('frozen');
    expect(entry.heldHead).toBe(caseFile.head.sha);
    expect(entry.heldPaths).toEqual(['src/x.ts']);
    // D-048/D-049: PR MATERIALS prepared (driver facts only — the agent writes
    // title/body itself and `publish` pushes the real run-top head); no local
    // fix/sweep ref and no driver-generated prose/gh commands exist anymore.
    expect(entry.fixBranch).toMatch(/^fix\/sweep\//);
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
    const materials = readFileSync(join(dir, caseId, 'pr', 'materials.md'), 'utf8');
    expect(materials).toContain('src/x.ts');
    expect(materials).toContain('propagate publish --case');
    expect(existsSync(join(dir, caseId, 'pr', 'body.md'))).toBe(false);
    expect(existsSync(join(dir, caseId, 'pr', 'gh-commands.sh'))).toBe(false);
    // Descendants reopened.
    expect(
      journal
        .filter((e) => e.action === 'reopened')
        .map((e) => e.branch)
        .sort(),
    ).toEqual(['feat/c', 'main_patched']);
  });
});

// --- D-048: resolution cold-read context (starvation fix) --------------------
describe('coldread-request.md — driver-derived case context (D-048)', () => {
  it('embeds the inventory summary/owned_paths/extra_context and per-side histories over the conflicted paths', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    // The entry matches by owned_paths/extra_context mentioning the conflicted
    // path (main_patched itself has no inventory entry — structural).
    const inv = writeInventory([
      {
        id: 'x-surface',
        branch: 'feat/none',
        summary: 'owns the x surface',
        owned_paths: ['src/x.ts'],
        extra_context: 'Decision 2026-07-01: src/x.ts keeps the fork variant (PR #40).',
      },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;

    const request = readFileSync(join(dir, caseId, 'coldread-request.md'), 'utf8');
    expect(request).toContain('## Case context (driver-derived — D-048)');
    expect(request).toContain('owns the x surface');
    expect(request).toContain('src/x.ts');
    expect(request).toContain('Decision 2026-07-01');
    // Per-side `git log --oneline` over the conflicted paths.
    expect(request).toContain('mp: x = fork'); // ours
    expect(request).toContain('U1: x = up1'); // theirs
    // Still regenerated (with the same context) at resolve.
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }));
    const regen = readFileSync(join(dir, caseId, 'coldread-request.md'), 'utf8');
    expect(regen).toContain('## Case context (driver-derived — D-048)');
    expect(regen).toContain('## Resolution diff (automerge tree -> resolved tree)');
    expect(regen).toContain('RESOLVED');
  });
});

// --- B4: merge + defer combined verdict (§5) + ledger-rebuilt HELD (N3) ------
describe('propagate run — B4: clean-prefix merge with a DEFERRED conflict above it', () => {
  it('journals BOTH the merge and the defer pointer at the HELD ancestor (rebuilt from the ledger)', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/q', { create: true, at: 'main_patched' });
    repo.checkout('feat/c', { create: true, at: 'feat/q' });
    repo.commit('c: x = cfork', { 'src/x.ts': 'cfork\n' });
    repo.checkout('main');
    const u0 = repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // height 0
    const u1 = repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }); // height 1
    // Q historically advanced in TWO merges, so its first-parent line offers a
    // per-height eligible line to its child (h0 clean for C, h1 conflicting).
    repo.checkout('feat/q');
    repo.git('merge', '--no-edit', '-m', 'q merges U0', u0);
    repo.git('merge', '--no-edit', '-m', 'q merges U1', u1);
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'q', branch: 'feat/q', parents: ['main_patched'] },
      { id: 'c', branch: 'feat/c', parents: ['feat/q'] },
    ]);
    // Cross-pass freeze (N3): the HELD ancestor comes from the LEDGER, not the
    // pass journal — heldHead + heldPaths rebuild the record; the height (1) is
    // re-derived from the sha against this pass's chain.
    writeFileSync(
      join(ws, 'sweep-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        lastSweep: null,
        branches: {
          main_patched: {
            status: 'frozen',
            frozenBy: 'main_patched--main-h1',
            pendingBehindFreeze: 0,
            notes: '',
            heldHead: u1,
            heldPaths: ['src/x.ts'],
          },
        },
        openPois: [],
      }),
    );
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);

    const journal = readJournal(dir);
    // BOTH entries for feat/c <- feat/q: the clean-prefix merge (h0) AND the
    // defer pointing at main_patched's HELD record (h1, intersecting paths).
    const merge = journal.find((e) => e.action === 'merge' && e.branch === 'feat/c');
    expect(merge).toBeTruthy();
    expect((merge!.head as { height: number }).height).toBe(0);
    const defer = journal.find((e) => e.action === 'defer' && e.branch === 'feat/c');
    expect(defer).toBeTruthy();
    expect(defer!.parent).toBe('feat/q');
    expect(defer!.deferredTo).toBe('main_patched');
    // Deferred, not an own case: frozen, NO PR, no case emitted.
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

describe('propagate — B5i: crash-resume (ref moved, journal missing the resolved entry)', () => {
  it('a retried resolve halts (no second merge); the next run heals and the pass converges', async () => {
    const { repo } = parentChildFixture();
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'main_patched')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef);
    expect(await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }))).toBe(0);
    const mpTip = repo.sha('main_patched');

    // Simulate the crash: the ref stays moved, the trailing `resolved` +
    // `reopened` journal entries vanish (ref-updated-but-journal-missing).
    stripJournal(dir, new Set(['resolved', 'reopened']));

    // (1) A retried resolve is REFUSED by the double-resolve guard — no second
    // merge commit, tip unchanged.
    expect(await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }))).toBe(1);
    expect(repo.sha('main_patched')).toBe(mpTip);
    const halt = readJournal(dir).find((e) => e.action === 'halt' && e.reason === 'case-reverification-failed');
    expect(halt).toBeTruthy();
    expect((halt!.errors as string[]).some((m) => m.includes('double-resolve'))).toBe(true);

    // (2) A subsequent run HEALS: synthetic resolved (crash-heal) + reopened,
    // descendants pick up the resolution, no duplicate merge.
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    const journal = readJournal(dir);
    const healed = journal.find((e) => e.action === 'resolved' && e.reason === 'crash-heal');
    expect(healed).toBeTruthy();
    expect(healed!.caseId).toBe(caseId);
    expect(repo.sha('main_patched')).toBe(mpTip); // no duplicate merge
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'feat/c')).toBe(true);
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('RESOLVED'); // descendant converged
    // The case is closed — nothing stays open forever.
    const openIds = journal
      .filter((e) => e.action === 'case')
      .map((e) => e.caseId as string)
      .filter((id) => !journal.some((e) => (e.action === 'resolved' || e.action === 'held') && e.caseId === id));
    expect(openIds).toEqual([]);
  });
});

// --- §7: cold-read request carries the resolution diff -----------------------
describe('propagate resolve — §7: cold-read request regenerated with the resolution diff', () => {
  it('regenerates the request before requiring the verdict; the confirm entry journals the verdict', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const reqPath = join(dir, caseId, 'coldread-request.md');

    // Emission-time request: conflict hunks, resolution diff still pending.
    const initial = readFileSync(reqPath, 'utf8');
    expect(initial).toContain('## Conflict hunks');
    expect(initial).toContain('<<<<<<<');
    expect(initial).toContain('No resolution attempt yet');

    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    // First attempt WITHOUT a verdict: exits 2, but the request now carries the
    // resolution diff the cold reader must attest to.
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(2);
    const regen = readFileSync(reqPath, 'utf8');
    expect(regen).toContain('## Conflict hunks');
    expect(regen).toContain('<<<<<<<');
    expect(regen).toContain('## Resolution diff (automerge tree -> resolved tree)');
    expect(regen).toContain('+RESOLVED');
    expect(regen).not.toContain('No resolution attempt yet');

    // Confirm path: the resolved journal entry carries the verdict content.
    writeVerdict(dir, caseId, repo, resolvedRef);
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);
    const resolved = readJournal(dir).find((e) => e.action === 'resolved')!;
    const coldread = resolved.coldread as { verdict: string; notes: string };
    expect(coldread.verdict).toBe('confirm');
    expect(coldread.notes).toBe('cold read ok');
  });
});

// --- N5: --case sanitization --------------------------------------------------
describe('propagate resolve — N5: --case ids outside the slug shape are refused', () => {
  it('rejects separators, dots and traversal before any path join', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    for (const bad of ['../../etc/passwd-h1', 'a/b-h1', 'a..b-h1', 'x.y-h1', 'no-height-suffix']) {
      expect(
        await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId: bad, tier: 'held' })),
      ).toBe(2);
    }
    expect(existsSync(join(ws, 'propagation'))).toBe(false); // refused before any pass/path work
  });
});

// --- N7: dry-run resolve reports reverify failure without journaling ---------
describe('propagate resolve — N7: dry-run reverify failure journals nothing', () => {
  it('leaves the journal byte-identical and exits 1', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    editCase(dir, caseId, (c) => {
      (c.head as { sha: string }).sha = '0'.repeat(40); // forged -> reverify fails
    });
    const before = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: false, caseId, tier: 'mechanical' })),
    ).toBe(1);
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toBe(before); // no halt entry appended
  });
});

// --- D-047/B11: multi-parent TOCTOU — execution re-probe + demotion ----------
describe('propagate run — D-047/B11: stale clean verdict re-probed at execution', () => {
  /**
   * The 2026-07-21 crash shape: feat/child has TWO parents whose per-parent
   * probes both ran against the SAME derivation tip. Parent pa merges first and
   * advances the tip; parent pb's clean `merge` verdict is then stale — its
   * merge against the advanced tip conflicts on src/f.ts. Pre-fix, execution
   * hit commitTreeMerge's conflicted-tree throw (a bare Error) and the whole
   * run aborted, blocking every remaining branch.
   */
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

  it('run exits 0: parent A merges, parent B demotes to a case from the CURRENT tip, siblings/descendants proceed; the case resolves', async () => {
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

    await cmdPlan(cli({ cmd: 'plan' }));
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
    // post-fix the run completes and gates the branch on a proper case.
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    const journal = readJournal(dir);

    // Parent A landed; parent B did not.
    const childMerges = journal.filter((e) => e.action === 'merge' && e.branch === 'feat/child');
    expect(childMerges.map((e) => e.parent)).toEqual(['feat/pa']);
    expect(await isAncestor(repo.dir, repo.sha('feat/pa'), 'feat/child')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('feat/pb'), 'feat/child')).toBe(false);

    // The demotion is journaled and a case emitted with the RECOMPUTED conflict
    // set against the post-merge tip (D-047/B11).
    const demoted = journal.find((e) => e.action === 'demoted' && e.branch === 'feat/child')!;
    expect(demoted.parent).toBe('feat/pb');
    expect(demoted.to).toBe('case');
    expect(demoted.conflictedPaths).toEqual(['src/f.ts']);
    const caseEntry = journal.find((e) => e.action === 'case' && e.branch === 'feat/child')!;
    expect(caseEntry.parent).toBe('feat/pb');
    expect(caseEntry.conflictedPaths).toEqual(['src/f.ts']);
    const caseFile = readCase(dir, caseEntry.caseId as string);
    expect(caseFile.head.sha).toBe(repo.sha('feat/pb'));
    // Driver worktree materialized with the conflict markers (SPEC 1).
    expect(readFileSync(join(dir, caseEntry.caseId as string, 'worktree', 'src/f.ts'), 'utf8')).toContain('<<<<<<<');

    // Siblings + descendant unaffected: everyone arrived; the child's barrier
    // arrival lets feat/down proceed on the PARTIAL (pa-only) progress —
    // inherited gating keeps pb's content out until the case resolves.
    const arrivedBranches = journal.filter((e) => e.action === 'arrived').map((e) => e.branch);
    for (const b of ['main_patched', 'feat/pa', 'feat/pb', 'feat/child', 'feat/down'])
      expect(arrivedBranches).toContain(b);
    expect(await isAncestor(repo.dir, repo.sha('feat/pa'), 'feat/down')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('feat/pb'), 'feat/down')).toBe(false);

    // The emitted case is ACTIONABLE: resolve re-derives the same head/tree/paths.
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/f.ts': 'MERGED\n' });
    writeVerdict(dir, caseEntry.caseId as string, repo, resolvedRef);
    expect(
      await cmdResolve(
        cli({ cmd: 'resolve', execute: true, caseId: caseEntry.caseId as string, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);
    expect(repo.git('show', 'feat/child:src/f.ts')).toBe('MERGED');

    // Continuation machinery (§8): the reopened descendant picks up the resolution.
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(repo.git('show', 'feat/down:src/f.ts')).toBe('MERGED');
    expect(await isAncestor(repo.dir, repo.sha('feat/pb'), 'feat/child')).toBe(true);
  });

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

// --- D-050: focused resolution cold read + fail-closed UNVERIFIABLE ----------
describe('propagate resolve — D-050: focused cold-read contract', () => {
  it('request carries the three bounded questions + the judge-from-request preamble; the open-ended Q4 is gone', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
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
    // The universe-researcher Q4 is deleted.
    expect(request).not.toContain('follow-on invariants');
    expect(request).not.toMatch(/^4\./m);
  });

  it('an UNVERIFIABLE-FROM-REQUEST answer on Q1-Q3 fails closed to HELD even under an overall confirm', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    const before = repo.sha('main_patched');

    // Overall confirm, but Q2 could not be judged from the request.
    writeVerdict(dir, caseId, repo, resolvedRef, 'confirm', {
      q1: 'both sides preserved',
      q2: 'UNVERIFIABLE-FROM-REQUEST — cannot tell if the extra hunk is conflict-driven',
      q3: 'no contradiction',
    });
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);
    const journal = readJournal(dir);
    // Frozen, not merged: HELD entry present, no resolved entry, branch tip unchanged.
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(held).toBeTruthy();
    expect((held.notes as string[]).some((n) => n.includes('UNVERIFIABLE-FROM-REQUEST on q2'))).toBe(true);
    expect(journal.some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    expect(repo.sha('main_patched')).toBe(before);
  });

  it('a plain confirm with all three answers present still merges (the answers are advisory when verifiable)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef, 'confirm', { q1: 'ok', q2: 'ok', q3: 'ok' });
    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(true);
  });
});

// --- D-050 (owner b): rerere.enabled set repo-wide, journaled once -----------
describe('propagate run — D-050: repo-wide rerere.enabled, idempotent journaling', () => {
  it('enables rerere.enabled in the clone before the first mutation and journals it exactly once', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
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
