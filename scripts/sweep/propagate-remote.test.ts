/**
 * D-045 Feature A (PROPAGATION.md §13) — remote-branch materialization + sync,
 * end-to-end at the cmdRun level. Fixtures fake `origin` via
 * refs/remotes/origin/* (FixtureRepo.setOrigin); the driver never operates on
 * refs/remotes directly — it materializes/syncs LOCAL branches from origin at
 * `run --execute` and merges the local refs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { isAncestor, localBranchExists } from './git.js';
import { cmdPlan, cmdRun, passDir, readJournal, type Cli } from './propagate.js';
import type { PropagationPlan } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'prop-remote-ws-'));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

function writeInventory(entries: Array<{ id: string; branch: string; parents?: string[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'prop-remote-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      'kind: feat',
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
    scopeFile: join(inv, 'no-scope.yaml'),
    upstream: 'main',
    execute: false,
    ...over,
  };
}

function readPlan(dir: string): PropagationPlan {
  return JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as PropagationPlan;
}

describe('propagate — §13 remote-only inventory branch (materialize)', () => {
  it('is planned from origin (flagged materialize), dry-run writes no refs, run --execute materializes + merges', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/r', { create: true, at: 'main_patched' });
    repo.commit('r1: own', { 'src/r.ts': 'r\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    const originTip = repo.setOrigin('feat/r');
    repo.deleteLocalBranch('feat/r'); // exists ONLY as origin/feat/r now
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'r', branch: 'feat/r', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);

    // Plan: in scope, planned normally, row flagged materialize.
    expect(await cmdPlan(cli({ cmd: 'plan' }))).toBe(0);
    const plan = readPlan(dir);
    const row = plan.branches.find((b) => b.branch === 'feat/r');
    expect(row).toBeTruthy();
    expect(row!.materialize).toBe(true);
    expect(plan.branches.find((b) => b.branch === 'main_patched')!.materialize ?? false).toBe(false);
    expect(await localBranchExists(repo.dir, 'feat/r')).toBe(false); // plan never writes refs

    // Dry-run run: zero ref writes.
    const refsBefore = repo.git('for-each-ref', 'refs/heads');
    expect(await cmdRun(cli({ cmd: 'run', execute: false }))).toBe(0);
    expect(repo.git('for-each-ref', 'refs/heads')).toBe(refsBefore);
    expect(await localBranchExists(repo.dir, 'feat/r')).toBe(false);
    expect(readJournal(dir).some((e) => e.action === 'branch-materialized')).toBe(false);

    // Execute: local branch created at the origin tip BEFORE its first merge,
    // journaled, then the pass merges land on the local ref.
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(await localBranchExists(repo.dir, 'feat/r')).toBe(true);
    const journal = readJournal(dir);
    const mat = journal.find((e) => e.action === 'branch-materialized');
    expect(mat).toBeTruthy();
    expect(mat!.branch).toBe('feat/r');
    expect(mat!.tip).toBe(originTip);
    expect(await isAncestor(repo.dir, originTip, 'feat/r')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/r')).toBe(true); // U0 arrived via main_patched
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'feat/r')).toBe(true);
  });
});

describe('propagate — §13 sync states: behind / ahead / diverged in one pass', () => {
  it('fast-forwards behind, ignores ahead, halts+skips diverged while siblings proceed', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });

    // feat/s — local strictly BEHIND origin.
    repo.checkout('feat/s', { create: true, at: 'main_patched' });
    const s1 = repo.commit('s1', { 'src/s.ts': '1\n' });
    const s2 = repo.commit('s2', { 'src/s2.ts': '2\n' });
    repo.checkout('main');
    repo.setOrigin('feat/s'); // origin = s2
    repo.git('update-ref', 'refs/heads/feat/s', s1); // local back at s1

    // feat/t — local AHEAD of origin (unpushed driver work).
    repo.checkout('feat/t', { create: true, at: 'main_patched' });
    const t1 = repo.commit('t1', { 'src/t.ts': '1\n' });
    repo.setOrigin('feat/t'); // origin = t1
    repo.commit('t2: local-only', { 'src/t2.ts': '2\n' });
    repo.checkout('main');

    // feat/d — DIVERGED: local d1+d3, origin d1+d2.
    repo.checkout('feat/d', { create: true, at: 'main_patched' });
    const d1 = repo.commit('d1', { 'src/d.ts': '1\n' });
    repo.commit('d2: origin-only', { 'src/d.ts': 'origin\n' });
    repo.checkout('main');
    repo.setOrigin('feat/d'); // origin = d1+d2
    repo.git('update-ref', 'refs/heads/feat/d', d1);
    repo.checkout('feat/d'); // worktree follows the reset ref
    repo.commit('d3: local-only', { 'src/d.ts': 'local\n' });
    const dTip = repo.sha('feat/d');
    repo.checkout('main');

    // feat/ok — plain local sibling; must proceed despite feat/d's halt.
    repo.checkout('feat/ok', { create: true, at: 'main_patched' });
    repo.commit('ok1', { 'src/ok.ts': 'ok\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'd', branch: 'feat/d', parents: ['main_patched'] },
      { id: 'ok', branch: 'feat/ok', parents: ['main_patched'] },
      { id: 's', branch: 'feat/s', parents: ['main_patched'] },
      { id: 't', branch: 'feat/t', parents: ['main_patched'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    const outFile = join(ws, 'run-out.json');

    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true, out: outFile }))).toBe(0);
    const journal = readJournal(dir);

    // BEHIND: one branch-synced entry, local now contains the origin tip AND the pass merge.
    const synced = journal.find((e) => e.action === 'branch-synced');
    expect(synced).toBeTruthy();
    expect(synced!.branch).toBe('feat/s');
    expect(synced!.from).toBe(s1);
    expect(synced!.to).toBe(s2);
    expect(await isAncestor(repo.dir, s2, 'feat/s')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/s')).toBe(true);

    // AHEAD: no action, no noise — no sync/halt entries for feat/t; merges proceed.
    expect(
      journal.some(
        (e) => (e.action === 'branch-synced' || e.action === 'branch-materialized' || e.action === 'halt') && e.branch === 'feat/t',
      ),
    ).toBe(false);
    expect(await isAncestor(repo.dir, t1, 'feat/t')).toBe(true);
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/t')).toBe(true);

    // DIVERGED: journaled hard halt for the branch, no mutation, skipped this pass.
    const halt = journal.find((e) => e.action === 'halt' && e.reason === 'sync-diverged');
    expect(halt).toBeTruthy();
    expect(halt!.branch).toBe('feat/d');
    expect(repo.sha('feat/d')).toBe(dTip); // untouched
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'feat/d')).toBe(false);
    expect(journal.some((e) => e.action === 'skip' && e.branch === 'feat/d' && e.reason === 'diverged')).toBe(true);
    expect(journal.some((e) => e.action === 'arrived' && e.branch === 'feat/d')).toBe(true); // barrier satisfied

    // ...and the OTHER branches still proceeded.
    expect(await isAncestor(repo.dir, repo.sha('main'), 'feat/ok')).toBe(true);
    const out = JSON.parse(readFileSync(outFile, 'utf8')) as { diverged: string[] };
    expect(out.diverged).toEqual(['feat/d']);

    // Idempotent resume: a second run does not re-halt or re-sync anything.
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    const journal2 = readJournal(dir);
    expect(journal2.filter((e) => e.action === 'halt' && e.reason === 'sync-diverged').length).toBe(1);
    expect(journal2.filter((e) => e.action === 'branch-synced').length).toBe(1);
  });
});
