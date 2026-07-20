import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { addTempWorktree, commitInfo, isAncestor, listTreePaths } from './git.js';
import { readLedger } from './ledger.js';
import {
  cmdPlan,
  cmdResolve,
  cmdRun,
  cmdStatus,
  cmdUnfreeze,
  cmdVerify,
  heldRegistry,
  passDir,
  readJournal,
  type Cli,
} from './propagate.js';

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
  entries: Array<{ id: string; branch: string; kind?: string; parents?: string[]; scope_guard?: string }>,
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
      ...(e.scope_guard ? [`scope_guard: ${e.scope_guard}`] : []),
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
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
): void {
  writeFileSync(
    join(dir, caseId, 'coldread-verdict.json'),
    JSON.stringify({ verdict, notes: 'cold read ok', resolvedTree: treeOfRef(repo, resolvedRef) }),
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

// --- CHANGE 2: urging + unfreeze paths ------------------------------------
describe('propagate — frozen-branch urging (§8, CHANGE 2)', () => {
  it('urges once per NEW pending head: prepared once, suppressed on identical re-run, re-urged on a new head', async () => {
    const { repo } = conflictFixture(); // U0 util, U1 x conflict
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    // Freeze main_patched (direct held) — records fixBranch + heldHead.
    await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }));

    // Next run urges once; a second identical run suppresses.
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const urges1 = readJournal(dir).filter((e) => e.action === 'urge').length;
    expect(urges1).toBe(1);
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(1); // suppressed

    // A NEW pass with new upstream content re-urges.
    repo.commit('U2: more util', { 'src/util2.ts': 'u2\n' });
    const dir2 = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    const urgesNew = readJournal(dir2).filter((e) => e.action === 'urge');
    expect(urgesNew.length).toBe(1);
    expect(urgesNew[0].head).toBe(repo.sha('main')); // newest head (U2)
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
