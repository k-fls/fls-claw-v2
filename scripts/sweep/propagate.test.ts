import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { addTempWorktree, commitInfo, isAncestor, listTreePaths, revParse } from './git.js';
import { cmdPlan, cmdResolve, cmdRun, cmdStatus, heldRegistry, passDir, readJournal, type Cli } from './propagate.js';

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

/** Inventory dir with one YAML per feature entry. */
function writeInventory(entries: Array<{ id: string; branch: string; kind?: string; parents?: string[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'prop-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      `kind: ${e.kind ?? 'feat'}`,
      'status: shipped',
      `branch: ${e.branch}`,
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
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
    scopeFile: join(inv, 'no-scope.yaml'), // non-existent -> empty scope
    upstream: 'main',
    execute: false,
    ...over,
  };
}

/** Build a resolution commit: the automerge tree with only `src/x.ts` fixed. */
async function buildResolution(repo: FixtureRepo, automergeTree: string, resolved: string): Promise<string> {
  const amCommit = repo.git('commit-tree', automergeTree, '-m', 'automerge');
  const wt = await addTempWorktree(repo.dir, amCommit);
  try {
    writeFileSync(join(wt.path, 'src/x.ts'), resolved);
    repo.git('-C', wt.path, 'add', '-A');
    repo.git('-C', wt.path, 'commit', '-m', 'resolve x.ts');
    return repo.git('-C', wt.path, 'rev-parse', 'HEAD');
  } finally {
    await wt.remove();
  }
}

/** Fixture: main_patched (x=fork) vs a non-monotonic trunk on `main`. */
function conflictFixture(): { repo: FixtureRepo } {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
  repo.commit('U2: x = fork', { 'src/x.ts': 'fork\n' });
  repo.commit('U3: x = up3', { 'src/x.ts': 'up3\n' });
  cleanups.push(() => repo.destroy());
  return { repo };
}

describe('propagate plan/run/resolve — entry model with a conflict case', () => {
  it('plans, merges the clean prefix, emits a case, then resolves it (mechanical)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const wm12 = repo.sha('main').slice(0, 12);
    const dir = passDir(ws, wm12);

    // plan
    expect(await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }))).toBe(0);

    // run --execute: merge to height 2, emit the height-3 case, gate.
    const before = repo.sha('main_patched');
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    expect(repo.sha('main_patched')).not.toBe(before); // clean prefix merged
    const journal = readJournal(dir);
    const caseEntry = journal.find((e) => e.action === 'case')!;
    expect(caseEntry).toBeTruthy();
    expect(caseEntry.height).toBe(3);
    const caseId = caseEntry.caseId as string;
    const caseFile = JSON.parse((await import('node:fs')).readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as {
      automergeTree: string;
      conflictedPaths: string[];
      head: { sha: string };
    };
    expect(caseFile.conflictedPaths).toEqual(['src/x.ts']);

    // The agent resolves x.ts inside the case worktree; cold-read confirms.
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, 'RESOLVED\n');
    writeFileSync(join(dir, caseId, 'coldread-verdict.json'), JSON.stringify({ verdict: 'confirm', notes: 'ok' }));

    expect(
      await cmdResolve(
        baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef }),
      ),
    ).toBe(0);

    // main_patched now carries the resolution + all upstream up to U3.
    const files = await listTreePaths(repo.dir, 'main_patched');
    expect(files).toContain('src/util.ts');
    expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(true); // U3 merged
    const xBlob = repo.git('show', 'main_patched:src/x.ts');
    expect(xBlob).toBe('RESOLVED');
    expect(heldRegistry(readJournal(dir))).toEqual([]);
  });

  it('scope-guard violation demotes a MECHANICAL claim to JUDGED', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = JSON.parse((await import('node:fs')).readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as {
      automergeTree: string;
    };
    // Resolution that ALSO edits an unrelated file -> scope-guard violation.
    const amCommit = repo.git('commit-tree', caseFile.automergeTree, '-m', 'am');
    const wt = await addTempWorktree(repo.dir, amCommit);
    let resolvedRef = '';
    try {
      writeFileSync(join(wt.path, 'src/x.ts'), 'RESOLVED\n');
      writeFileSync(join(wt.path, 'src/extra.ts'), 'sneaky\n');
      repo.git('-C', wt.path, 'add', '-A');
      repo.git('-C', wt.path, 'commit', '-m', 'resolve + sneak');
      resolvedRef = repo.git('-C', wt.path, 'rev-parse', 'HEAD');
    } finally {
      await wt.remove();
    }
    writeFileSync(join(dir, caseId, 'coldread-verdict.json'), JSON.stringify({ verdict: 'confirm', notes: 'ok' }));
    const outFile = join(ws, 'resolve-out.json');
    await cmdResolve(
      baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out: outFile }),
    );
    const out = JSON.parse((await import('node:fs')).readFileSync(outFile, 'utf8')) as {
      tier: string;
      scopeGuard: { ok: boolean };
    };
    expect(out.scopeGuard.ok).toBe(false);
    expect(out.tier).toBe('judged'); // mechanical demoted by the scope guard
  });

  it('idempotent resume: a second run does not re-merge already-arrived branches', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const afterFirst = repo.sha('main_patched');
    const arrivals1 = readJournal(dir).filter((e) => e.action === 'arrived').length;
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(repo.sha('main_patched')).toBe(afterFirst); // no double merge
    const arrivals2 = readJournal(dir).filter((e) => e.action === 'arrived').length;
    expect(arrivals2).toBe(arrivals1);
    expect(await cmdStatus(baseCli(repo, ws, inv, { cmd: 'status' }))).toBe(0);
  });
});

describe('propagate run — no-op skip + leaf un-skip chain (§6, D-039)', () => {
  it('un-skips the cheapest parent chain so the leaf lands a real (empty) merge', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: f', { 'src/f.ts': 'base\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    // feat/a independently sets f = X; feat/b is the leaf.
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('feat/a: f = X', { 'src/f.ts': 'X\n' });
    repo.checkout('feat/b', { create: true, at: 'feat/a' });
    repo.commit('feat/b: own', { 'src/b.ts': 'b\n' });
    repo.checkout('main');
    // Upstream sets f = X too -> merging into feat/a is a genuine no-op.
    repo.commit('U0: f = X', { 'src/f.ts': 'X\n' });
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['feat/a'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));

    const cli: Cli = {
      cmd: 'run',
      repo: repo.dir,
      workspace: ws,
      inventory: inv,
      scopeFile: join(inv, 'no-scope.yaml'),
      upstream: 'main',
      execute: true,
    };
    expect(await cmdRun(cli)).toBe(0);

    const journal = readJournal(dir);
    // feat/a's own parent merge was a no-op skip.
    expect(journal.some((e) => e.action === 'skip' && e.branch === 'feat/a')).toBe(true);
    // The leaf un-skip forced merges (feat/a<-main_patched and feat/b<-feat/a).
    const forced = journal.filter((e) => e.action === 'merge' && e.forced === true);
    expect(forced.map((e) => e.branch).sort()).toEqual(['feat/a', 'feat/b']);
    // feat/b ends the pass with a real (2-parent) merge commit.
    const info = await commitInfo(repo.dir, 'feat/b');
    expect(info.parents.length).toBe(2);
  });
});

describe('propagate resolve — direct HELD path (§8, FIX 4)', () => {
  it('--tier held freezes without a resolution commit, scope guard, or cold read', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;

    // No --resolved-ref, no coldread-verdict.json: the direct freeze path.
    const before = repo.sha('main_patched');
    expect(await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }))).toBe(0);
    expect(repo.sha('main_patched')).toBe(before); // HELD: no merge

    const journal = readJournal(dir);
    const heldEntry = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    expect(heldEntry).toBeTruthy();
    expect(heldEntry.branch).toBe('main_patched');
    expect(heldRegistry(journal).map((h) => h.branch)).toContain('main_patched');
    // D-030 draft PR mechanics prepared (branch ref + gh commands), never pushed.
    expect((await import('node:fs')).existsSync(join(dir, caseId, 'pr', 'gh-commands.sh'))).toBe(true);
    // The branch (and any descendants) are reopened for the next run.
    expect(journal.some((e) => e.action === 'reopened' && e.branch === 'main_patched')).toBe(true);
  });
});

describe('propagate — same-pass continuation after resolve (§8, FIX 3)', () => {
  it('a resolved branch reaches the watermark and its child picks up the resolution on re-run', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('feat/c', { create: true, at: 'main_patched' });
    repo.commit('feat/c: own', { 'src/c.ts': 'c\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // height 0 (clean into mp)
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }); // height 1 (conflicts mp on x)
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'c', branch: 'feat/c', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (over: Partial<Cli>): Cli => ({
      cmd: 'run',
      repo: repo.dir,
      workspace: ws,
      inventory: inv,
      scopeFile: join(inv, 'no-scope.yaml'),
      upstream: 'main',
      execute: true,
      ...over,
    });

    // Run 1: main_patched merges the clean prefix (h0) and gates at h1; feat/c
    // merges main_patched's h0 tip (clean, gets util but not the resolution).
    expect(await cmdRun(cli({ cmd: 'run' }))).toBe(0);
    const caseId = readJournal(dir).find((e) => e.action === 'case' && e.branch === 'main_patched')!.caseId as string;
    const caseFile = JSON.parse((await import('node:fs')).readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as {
      automergeTree: string;
    };
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('fork'); // child has NOT seen the resolution yet

    // Resolve the main_patched conflict (mechanical) — reaches the watermark.
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, 'RESOLVED\n');
    writeFileSync(join(dir, caseId, 'coldread-verdict.json'), JSON.stringify({ verdict: 'confirm', notes: 'ok' }));
    expect(await cmdResolve(cli({ cmd: 'resolve', caseId, tier: 'mechanical', resolvedRef }))).toBe(0);
    expect(await isAncestor(repo.dir, repo.sha('main'), 'main_patched')).toBe(true); // continued to watermark
    // resolve reopened main_patched AND its descendant feat/c.
    const j2 = readJournal(dir);
    expect(
      j2
        .filter((e) => e.action === 'reopened')
        .map((e) => e.branch)
        .sort(),
    ).toEqual(['feat/c', 'main_patched']);

    // Run 2 (same watermark): feat/c is re-processed and picks up the resolution.
    expect(await cmdRun(cli({ cmd: 'run' }))).toBe(0);
    expect(repo.git('show', 'feat/c:src/x.ts')).toBe('RESOLVED');
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/c')).toBe(true);
  });
});
