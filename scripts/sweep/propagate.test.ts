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
  appendJournal,
  cmdPlan,
  cmdPush,
  cmdReport,
  cmdResolve,
  cmdRun,
  cmdStatus,
  cmdUnfreeze,
  cmdVerify,
  coldReadWithRetry,
  openCases,
  passDir,
  publishableRecipe,
  readJournal,
  supersededCaseIds,
  type Cli,
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
    inventory: inv ?? undefined,
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
  feedback?: string,
): void {
  writeFileSync(
    join(dir, caseId, 'coldread-verdict.json'),
    JSON.stringify({
      verdict,
      ...(answers ? { answers } : {}),
      notes: 'cold read ok',
      ...(feedback ? { feedback } : {}),
      resolvedTree: treeOfRef(repo, resolvedRef),
    }),
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
    // Blocked ⇔ the journaled held disposition (D-058: no ledger merge_status).
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();
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

// --- D-052: bounded resolve cycle (stale-verdict clear + anti-thrash cap) ---
describe('propagate resolve — stale-verdict auto-clear + convergence cap (D-052)', () => {
  /** Plan+run a conflict case; return the open caseId and its case file. */
  async function openCase(repo: FixtureRepo, ws: string, inv: string, dir: string) {
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    return { caseId, caseFile: readCase(dir, caseId) };
  }

  it('(a) a verdict attesting an OLD tree is auto-cleared; the next resolve asks for a fresh one, then merges', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId, caseFile } = await openCase(repo, ws, inv, dir);

    // The CURRENT resolution (tree B) with a verdict on disk that attests to a
    // DIFFERENT resolution (tree A) — the classic re-resolve staleness.
    const refA = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RES-A\n' });
    const refB = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RES-B\n' });
    writeVerdict(dir, caseId, repo, refA); // stale: attests tree A, we resolve B

    // First resolve of B: the stale verdict is retired (NOT "stale" dead-end),
    // and the missing-verdict path fires -> exit 2, naming the right artifact.
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef: refB })),
    ).toBe(2);
    expect(existsSync(join(dir, caseId, 'coldread-verdict.stale.json'))).toBe(true);
    expect(existsSync(join(dir, caseId, 'coldread-verdict.json'))).toBe(false);
    const j1 = readJournal(dir);
    expect(j1.some((e) => e.action === 'stale-verdict-cleared' && e.id === 'WARN05_STALE_VERDICT_CLEARED')).toBe(true);
    expect(j1.some((e) => e.action === 'resolved')).toBe(false);

    // Agent writes a FRESH verdict attesting tree B; resolve now merges in one shot.
    writeVerdict(dir, caseId, repo, refB);
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef: refB })),
    ).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(true);
    expect(repo.git('show', 'main_patched:src/x.ts')).toBe('RES-B');
  });

  it('(b) an idempotent re-run with a MATCHING verdict still merges in one shot (verdict untouched)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId, caseFile } = await openCase(repo, ws, inv, dir);

    const ref = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, ref); // MATCHING (attests this tree)
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef: ref })),
    ).toBe(0);
    // The matching verdict was kept (never retired), and no WARN05 fired.
    expect(existsSync(join(dir, caseId, 'coldread-verdict.stale.json'))).toBe(false);
    const j = readJournal(dir);
    expect(j.some((e) => e.action === 'stale-verdict-cleared')).toBe(false);
    expect(j.filter((e) => e.action === 'resolved' && e.caseId === caseId).length).toBe(1);
  });

  it('(c) a case cycling through >N distinct resolution trees is force-HELD, not looped', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId, caseFile } = await openCase(repo, ws, inv, dir);
    const postRun = repo.sha('main_patched');

    // Three distinct resolution trees, each WITHOUT a matching verdict: every
    // attempt is journaled (`coldread-attempt`) but returns exit 2 (no merge),
    // so the case stays open — exactly the thrash the cap must break.
    for (const body of ['A\n', 'B\n', 'C\n']) {
      const ref = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': body });
      expect(
        await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef: ref })),
      ).toBe(2);
    }
    expect(readJournal(dir).filter((e) => e.action === 'coldread-attempt' && e.caseId === caseId).length).toBe(3);

    // The 4th DISTINCT tree exceeds the cap -> force-HELD (exit 0), no merge,
    // branch ledger-frozen; the loop is broken.
    const ref4 = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'D\n' });
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef: ref4 })),
    ).toBe(0);
    const j = readJournal(dir);
    expect(j.some((e) => e.action === 'resolve-not-converged' && e.id === 'ERR26_RESOLVE_NOT_CONVERGED')).toBe(true);
    expect(j.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(j.some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    expect(repo.sha('main_patched')).toBe(postRun); // NO merge landed
    // The held disposition IS the block (D-058) — nothing written to the ledger.
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();
  });

  it('(d) `propagate report` prints a journal-derived summary incl. open/unresolved cases', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId } = await openCase(repo, ws, inv, dir);

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
    expect(await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }))).toBe(0);
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

// --- D-055: a cold-read INFRA failure at `resolve` must HALT (ERR35), never HELD -
describe('propagate resolve — cold-read infra failure ≠ content reject (D-055, ERR35)', () => {
  async function openCase(repo: FixtureRepo, ws: string, inv: string, dir: string) {
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    return { caseId, caseFile: readCase(dir, caseId) };
  }

  it("an 'error' verdict file -> HARD HALT (ERR35), NOT held, machine state left retryable, no merge", async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId, caseFile } = await openCase(repo, ws, inv, dir);
    const postRun = repo.sha('main_patched');
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });

    // A verdict file whose shape is `error` (D-054 invoker form): infra, not content.
    writeFileSync(
      join(dir, caseId, 'coldread-verdict.json'),
      JSON.stringify({ verdict: 'error', notes: '', reason: 'claude -p failed (status 1: Not logged in)', resolvedTree: treeOfRef(repo, resolvedRef) }),
    );
    const out = join(ws, 'resolve-err.json');
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out })),
    ).toBe(1); // hard halt (NOT the return-2 "invalid verdict" ambiguity, NOT 0-with-HELD)
    const res = JSON.parse(readFileSync(out, 'utf8')) as { issues?: Array<{ id: string }> };
    expect(res.issues?.some((i) => i.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
    const j = readJournal(dir);
    expect(j.some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
    expect(j.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(j.some((e) => e.action === 'resolved' && e.caseId === caseId)).toBe(false);
    expect(repo.sha('main_patched')).toBe(postRun); // nothing merged; retryable
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();
  });

  it("a STALE reject verdict whose notes read as a `claude -p` failure -> HALT (ERR35), NOT consumed as a fresh HELD", async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId, caseFile } = await openCase(repo, ws, inv, dir);
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });

    // The exact 2026-07-22 leftover: a `reject` verdict attesting THIS tree, whose
    // notes are actually the infra failure fail-closed to reject (pre-D-054).
    writeFileSync(
      join(dir, caseId, 'coldread-verdict.json'),
      JSON.stringify({ verdict: 'reject', notes: 'claude -p failed (status 1) — fail-closed (D-053)', resolvedTree: treeOfRef(repo, resolvedRef) }),
    );
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef })),
    ).toBe(1); // HALT, not a HELD-producing reject
    const j = readJournal(dir);
    expect(j.some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(true);
    expect(j.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
  });

  it('a GENUINE content reject (ran fine, real notes) is a content decision: retry once, HELD on the 2nd (never ERR35)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const { caseId, caseFile } = await openCase(repo, ws, inv, dir);
    const postRun = repo.sha('main_patched');
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    writeVerdict(dir, caseId, repo, resolvedRef, 'reject'); // a real judged reject
    // FIRST rejection (D-057 #4): no freeze, no halt — the agent revises and retries.
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef })),
    ).toBe(1);
    let j = readJournal(dir);
    expect(j.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(j.some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(false);
    expect(j.some((e) => e.action === 'coldread' && e.caseId === caseId && e.rejected === true)).toBe(true);
    // SECOND rejection: stop retrying → HELD (escalated), still never an ERR35 halt.
    writeVerdict(dir, caseId, repo, resolvedRef, 'reject');
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef })),
    ).toBe(0);
    j = readJournal(dir);
    expect(j.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    expect(j.some((e) => e.action === 'halt' && e.id === 'ERR35_COLDREAD_UNAVAILABLE')).toBe(false);
    expect(repo.sha('main_patched')).toBe(postRun); // no merge; blocked
    // Blocked ⇔ the journaled held disposition (D-058) — the ledger stays clean.
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();
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
    // The journaled held disposition IS the blocked marker (D-058): its head
    // sha anchors the live height re-derivation; the ledger is never written.
    const heldRow = journal.find((e) => e.action === 'held' && e.caseId === caseId)!;
    const caseHead = readJournal(dir).find((e) => e.action === 'case' && e.caseId === caseId)!.head as { sha: string };
    expect(heldRow.headSha).toBe(caseHead.sha);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();
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

  it('an origin-blocked branch is skipped (empty interval); a fresh pass without the row derives unblocked (D-058)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));

    // Block main_patched via the journal row `sweep start` would derive from an
    // unmerged origin fix/sweep ref with an open PR (D-058) — appended BEFORE
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

    // The block is PASS-LOCAL derived state (D-058): a fresh pass whose journal
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
    // Gate hold (D-058): the journaled held row IS the block — no head, no PR,
    // nothing written to the ledger.
    const gateRow = journal.find((e) => e.action === 'held' && e.branch === 'feat/off')!;
    expect(gateRow.reason).toBe('gate');
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['feat/off']?.merge_status ?? null).toBeNull();
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
        { action: 'case', branch: 'module/c', parent: 'main_patched', caseId: 'C1' },
      ] as Array<Record<string, unknown>>
    ).map((e) => ({ ts: '', ...e }) as JournalEntry);
    const order = ['main_patched', 'module/a', 'module/b', 'module/c'];
    // held = the PR_ID-blocked set (origin/journal-derived, D-058): module/b
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
    // Heldness = the journaled `held` disposition above (D-058) — the derived
    // blocked view reads the journal; the ledger plays no part.
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
    // Heldness = the journaled `held` disposition above (D-058).
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
    // The held offender was not gate-frozen by verify (it is already held —
    // no NEW gate `held` row was journaled for it).
    const heldRows = readJournal(passDir(ws, wm12)).filter(
      (e) => e.action === 'held' && e.branch === 'module/held',
    );
    expect(heldRows.length).toBe(1); // only the seeded row; no verify gate hold added
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
    // The journaled gate hold blocks the branch for the rest of the pass (D-058).
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['feat/off']?.merge_status ?? null).toBeNull();
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

describe('propagate — blocked-branch urging is POSTED by push, once per NEW pending head (§8, D-049/D-058)', () => {
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

  it('run only detects; push posts the urge (comment + D-004 refresh + lastUrgedHead), suppresses, re-urges on a new head', async () => {
    const { repo } = conflictFixture(); // U0 util, U1 x conflict
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'tok\n');
    const wm12 = repo.sha('main').slice(0, 12);
    // Blocked from pass start (origin-derived, D-058): prNumber unknown — push
    // locates the PR by head branch.
    appendJournal(dir, originBlockedRow(FIX));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));

    // `run` never posts or journals urges (posting is push's job); the blocked
    // branch is skipped with an empty interval. Nothing merges, so the run
    // seals the pass — push attaches to it explicitly via --pass.
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(readJournal(dir).filter((e) => e.action === 'urge').length).toBe(0);

    // push POSTS the urge: PR located by head branch, body PATCHed (D-004
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
    const ledger = readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']!;
    expect(ledger.lastUrgedHead).toBe(repo.sha('main'));
    // D-058: merge_status is never written — lastUrgedHead is the one cache.
    expect(ledger.merge_status ?? null).toBeNull();

    // A second push suppresses (no new pending head).
    const gh2 = fakePushGithub();
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
    const inv = emptyInventory();
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
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.lastUrgedHead ?? null).toBeNull();
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

  it('a failing target push is ERR15 PER BRANCH (categorized `push-failed`, D-059 FINAL) — reported, journaled, NO hard-halt row; the branch retries next run', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
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
    expect(issue!.detail).toContain('D-046 case 2');
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
    const inv = emptyInventory();
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

describe('propagate — unfreeze paths (§8, D-058 journal-derived)', () => {
  // PR_ID COMPLETION is origin's job now (D-058): a fix/sweep ref merged by
  // the owner is detected at `sweep start` (resolved + ref deleted) — see the
  // D-058 start tests in sweep-machine.test.ts. Locally there is nothing to
  // flip: the block simply never re-derives.

  it('MANUAL unfreeze journals `unfrozen` and clears the block for THIS pass (run then processes the branch)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    // Blocked from pass start (origin-derived row, D-058).
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

    expect(await cmdUnfreeze(baseCli(repo, ws, inv, { cmd: 'unfreeze', execute: true, branch: 'main_patched' }))).toBe(
      0,
    );
    expect(readJournal(dir).some((e) => e.action === 'unfrozen' && e.reason === 'manual')).toBe(true);
    // The ledger is untouched (D-058: no merge_status writes anywhere).
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();

    // The cleared branch processes normally in the SAME pass: clean prefix
    // merges, the persistent conflict emits a case.
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    expect(repo.sha('main_patched')).not.toBe(before);
    expect(readJournal(dir).some((e) => e.action === 'case' && e.branch === 'main_patched')).toBe(true);
  });

  it('unfreeze refuses a branch that is not blocked in the derived view', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    expect(await cmdUnfreeze(baseCli(repo, ws, inv, { cmd: 'unfreeze', execute: true, branch: 'main_patched' }))).toBe(
      2,
    );
  });

  it('unfreeze of a DEFERRED branch takes effect: defer rows older than the unfrozen row drop from the derived view (finding #2a)', async () => {
    // feat/x (parents feat/a + feat/b) journaled a defer; the sibling parent
    // feat/b is PR_ID-blocked, so the fixpoint view keeps X DEFERRED. A manual
    // unfreeze of X must CLEAR that — before the fix the `unfrozen` row only
    // cleared PR_ID rows and X stayed sticky-deferred forever.
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('a: own file', { 'src/a.ts': 'a\n' }); // X has a REAL pending merge from feat/a
    repo.checkout('feat/b', { create: true, at: 'main_patched' });
    repo.checkout('feat/x', { create: true, at: 'main_patched' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
      { id: 'x', branch: 'feat/x', parents: ['feat/a', 'feat/b'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
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

    expect(await cmdUnfreeze(baseCli(repo, ws, inv, { cmd: 'unfreeze', execute: true, branch: 'feat/x' }))).toBe(0);
    expect(readJournal(dir).some((e) => e.action === 'unfrozen' && e.branch === 'feat/x')).toBe(true);

    // Next derivation: X is no longer DEFERRED — it processes normally (merges
    // its parents' fresh tips) instead of the sticky deferred skip.
    expect(await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }))).toBe(0);
    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'skip' && e.branch === 'feat/x' && e.reason === 'deferred')).toBe(false);
    expect(journal.some((e) => e.action === 'merge' && e.branch === 'feat/x')).toBe(true);
  });

  it('unfreeze AFTER the branch already arrived reopens it + its inventory descendants for re-processing (finding #2b)', async () => {
    const { repo } = conflictFixture();
    repo.checkout('feat/k', { create: true, at: 'main_patched' });
    repo.checkout('main');
    const ws = mkWorkspace();
    const inv = writeInventory([{ id: 'k', branch: 'feat/k', parents: ['main_patched'] }]);
    const wm12 = repo.sha('main').slice(0, 12);
    const dir = passDir(ws, wm12);
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'main_patched',
      caseId: 'origin:fix/sweep/main_patched--main-h1-deadbeef',
      fixBranch: 'fix/sweep/main_patched--main-h1-deadbeef',
      headSha: null,
      prNumber: 12,
    });
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    // The blocked branch takes nothing, so this run seals the pass — the
    // unfreeze + re-run attach explicitly via --pass (like push does).
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const journal1 = readJournal(dir);
    expect(journal1.some((e) => e.action === 'skip' && e.branch === 'main_patched' && e.reason === 'held')).toBe(true);
    expect(journal1.some((e) => e.action === 'arrived' && e.branch === 'main_patched')).toBe(true);
    const before = repo.sha('main_patched');

    expect(
      await cmdUnfreeze(baseCli(repo, ws, inv, { cmd: 'unfreeze', execute: true, branch: 'main_patched', pass: wm12 })),
    ).toBe(0);
    // The unfreeze REOPENED the branch and its transitive inventory descendant
    // — without this the already-`arrived` branch stays skipped all pass.
    const reopened = readJournal(dir)
      .filter((e) => e.action === 'reopened')
      .map((e) => e.branch as string);
    expect(reopened).toContain('main_patched');
    expect(reopened).toContain('feat/k');

    // The SAME pass re-processes the branch: the clean prefix lands and the
    // persistent conflict emits a case.
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true, pass: wm12 }));
    expect(repo.sha('main_patched')).not.toBe(before);
    expect(readJournal(dir).some((e) => e.action === 'case' && e.branch === 'main_patched')).toBe(true);
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

  it('re-emitting a case recreates the worktree idempotently (D-057 — no "already registered" failure)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const wtPath = join(dir, caseId, 'worktree');
    expect(existsSync(wtPath)).toBe(true);

    // The worktree + its git registration persist; force the branch to be
    // re-processed (as a reopen/re-emit would) by dropping its `arrived` marker.
    // createCaseWorktree is then called AGAIN on the already-registered path —
    // which pre-D-057 failed with "missing but already registered"/"already exists".
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
    // Seed a HELD ancestor (main_patched blocked at h0) via the origin-blocked
    // journal row `sweep start` derives (D-058): the row's headSha is a side
    // commit at chain height 0 (like a fix/sweep ref head containing the
    // conflict head), so the block height re-derives to 0 live.
    repo.checkout('held-marker', { create: true, at: 'main' });
    repo.commit('marker: not in main_patched', { 'src/marker.ts': 'm\n' });
    const markerSha = repo.sha('held-marker');
    repo.checkout('main');
    appendJournal(dir, {
      action: 'origin-blocked',
      branch: 'main_patched',
      caseId: 'origin:fix/sweep/main_patched--main-h0-deadbeef',
      fixBranch: 'fix/sweep/main_patched--main-h0-deadbeef',
      headSha: markerSha,
      prNumber: 12,
    });
    await cmdPlan(cli({ cmd: 'plan' }));
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

describe('propagate resolve — cold-read rejections: retry once, HELD (escalated) on the 2nd (D-057 #4)', () => {
  it('1st reject: feedback surfaced, case stays open; 2nd reject: HELD with escalation + resolution recorded, descendants reopened', async () => {
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
    writeVerdict(dir, caseId, repo, resolvedRef, 'reject', undefined, 'the fork guard was dropped — needs a second look');
    const outFile = join(ws, 'reject-out.json');
    // FIRST rejection: no freeze — the reviewer's feedback is surfaced to the agent.
    expect(
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out: outFile })),
    ).toBe(1);
    const first = JSON.parse(readFileSync(outFile, 'utf8')) as {
      rejected?: boolean;
      instruction?: string;
      feedback?: string | null;
    };
    expect(first.rejected).toBe(true);
    expect(first.instruction).toContain('revise the resolution');
    expect(first.instruction).toContain('needs a second look'); // the reviewer's feedback, verbatim
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(repo.sha('main_patched')).toBe(postRun); // NOT merged

    // SECOND rejection: stop retrying — HELD via the unified publish, escalated.
    writeVerdict(dir, caseId, repo, resolvedRef, 'reject', undefined, 'the fork guard was dropped — needs a second look');
    expect(
      await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef, out: outFile })),
    ).toBe(0);
    expect((JSON.parse(readFileSync(outFile, 'utf8')) as { tier: string }).tier).toBe('held');

    expect(repo.sha('main_patched')).toBe(postRun); // branch NOT merged
    const journal = readJournal(dir);
    const held = journal.find((e) => e.action === 'held' && e.caseId === caseId);
    expect(held).toBeTruthy();
    expect((held!.notes as string[]).join(' ')).toContain('rejected 2x, escalated');
    // The escalation prefix + reviewer feedback ride the held record to publish.
    expect(held!.escalation).toMatchObject({ tag: '[AUTO-ESCALATED: cold read rejected 2x]' });
    expect((held!.escalation as { feedback: string }).feedback).toContain('needs a second look');
    // The (marker-clean) resolution is recorded — the unified publish ships it
    // as an ACTIVE PR for owner review, not the raw conflict.
    expect(held!.resolution).toMatchObject({ markerClean: true });
    expect((held!.resolution as { tree: string }).tree).toBe(treeOfRef(repo, resolvedRef));
    // Blocked ⇔ the journaled held disposition (D-058): its head sha anchors
    // the live height re-derivation; no path set is stored (the DEFER rule is
    // pure height-MIN) and the ledger is never written.
    expect(held!.headSha).toBe(caseFile.head.sha);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();
    // D-048/D-049: PR MATERIALS prepared (driver facts only — the agent writes
    // title/body itself and `publish` pushes the real head); no local
    // fix/sweep ref and no driver-generated prose/gh commands exist anymore.
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
  it('journals BOTH the merge and the defer pointer behind a blocked DIRECT parent (D-057)', async () => {
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
    // Cross-pass block (D-058): feat/a carries an origin-blocked journal row
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

  it('an UNVERIFIABLE-FROM-REQUEST answer on Q1-Q3 fails closed as a REJECTION even under an overall confirm (2nd strike → HELD)', async () => {
    const { repo } = conflictFixture();
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const caseFile = readCase(dir, caseId);
    const postRun = repo.sha('main_patched');
    const resolvedRef = await buildResolution(repo, caseFile.automergeTree, { 'src/x.ts': 'RESOLVED\n' });
    const unverifiableAnswers = { q1: 'ok', q2: 'UNVERIFIABLE-FROM-REQUEST', q3: 'ok' };
    writeVerdict(dir, caseId, repo, resolvedRef, 'confirm', unverifiableAnswers);
    // FIRST strike: treated as a rejection (fail-closed) — no merge, no freeze.
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef })),
    ).toBe(1);
    expect(repo.sha('main_patched')).toBe(postRun); // NOT merged despite the overall confirm
    expect(readJournal(dir).some((e) => e.action === 'held' && e.caseId === caseId)).toBe(false);
    expect(
      readJournal(dir).some((e) => e.action === 'coldread' && e.caseId === caseId && e.rejected === true),
    ).toBe(true);
    // SECOND strike: HELD (fail-closed, escalated).
    writeVerdict(dir, caseId, repo, resolvedRef, 'confirm', unverifiableAnswers);
    expect(
      await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'mechanical', resolvedRef })),
    ).toBe(0);
    const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId);
    expect(held).toBeTruthy();
    expect((held!.notes as string[]).join(' ')).toContain('UNVERIFIABLE-FROM-REQUEST');
    expect(repo.sha('main_patched')).toBe(postRun);
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

// --- D-058: derived merge_status — BECOME re-runs / release cascade E2E ------
describe('derived merge_status (D-058) — blocked view from origin rows + journal', () => {
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
    const ledgerPath = join(ws, 'sweep-ledger.json');
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
    // -> DEFER (journal row = the state; the ledger is NEVER written, D-058).
    const dir1 = passDir(ws, repo.sha('main').slice(0, 12));
    appendJournal(dir1, blockRow);
    await cmdPlan(cli({ cmd: 'plan' }));
    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(readJournal(dir1).some((e) => e.action === 'defer' && e.branch === 'feat/c')).toBe(true);
    expect(readLedger(ledgerPath).branches['feat/c']?.merge_status ?? null).toBeNull();
    expect(readLedger(ledgerPath).branches['feat/a']?.merge_status ?? null).toBeNull();
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
    // the OPEN CASE gates the pass; the ledger stays untouched throughout.
    expect(readLedger(ledgerPath).branches['feat/c']?.merge_status ?? null).toBeNull();
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

// --- D-057 STAY rule over ALL direct parents (D-058 fixpoint view) -----------
describe('derived DEFERRED — stays while ANY direct parent is blocked (D-057 STAY as a journal fixpoint)', () => {
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

// --- §6 un-skip vs blocked branches on the LIVE run path (D-057) -------------
describe('propagate run — un-skip never force-merges into/through a blocked branch (D-057)', () => {
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
    // D-058 journal-derived blocks: main_patched PR_ID (origin row, gate-like —
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

// --- §6 un-skip conflict pre-probe on the LIVE run path (2026-07-23 halt) ----
describe('propagate run — un-skip aborts when a chain hop genuinely conflicts (no ERR21)', () => {
  it('a conflicting intermediate hop aborts the un-skip; the hop branch keeps its OWN case; rc 0', async () => {
    // leaf feat/l -> feat/m -> entry main_patched. The entry merges U0 cleanly
    // at its own step (tip MOVES), feat/m then genuinely conflicts with the
    // moved tip (its own case, NOT a blocked merge_status), while feat/l is
    // up-to-date with feat/m — the leaf un-skip fires and its ONLY chain runs
    // THROUGH the conflicting hop. Unguarded, the forced feat/m <- main_patched
    // merge reaches clean-only commitTreeMerge -> ERR21 hard-halt (the live
    // 2026-07-23 module/credentials <- module/crypto halt).
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

// --- freeze publishes NOTHING (D-058 invariant) ------------------------------
describe('propagate freeze — a hold publishes nothing and leaves no state outside the pass dir (D-058)', () => {
  it('resolve --tier held: journal held row only — no origin ref, no PR journal, ledger byte-identical', async () => {
    const { repo } = conflictFixture();
    const bare = repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    await cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }));
    await cmdRun(baseCli(repo, ws, inv, { cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
    const ledgerPath = join(ws, 'sweep-ledger.json');
    const ledgerBefore = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : null;

    expect(await cmdResolve(baseCli(repo, ws, inv, { cmd: 'resolve', execute: true, caseId, tier: 'held' }))).toBe(0);

    const journal = readJournal(dir);
    expect(journal.some((e) => e.action === 'held' && e.caseId === caseId)).toBe(true);
    // NOTHING published at freeze time (all PRs are created at finish, D-058):
    // no pr-published row, no pushed pr-head, no fix/sweep ref on origin.
    expect(journal.some((e) => e.action === 'pr-published')).toBe(false);
    expect(journal.some((e) => e.action === 'push' && e.kind === 'pr-head')).toBe(false);
    expect(repo.git('-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/sweep')).toBe('');
    // No durable local state either: the ledger is byte-identical.
    const ledgerAfter = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : null;
    expect(ledgerAfter).toBe(ledgerBefore);
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
