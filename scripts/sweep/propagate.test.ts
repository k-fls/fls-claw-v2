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
import { addTempWorktree, commitInfo, isAncestor } from './git.js';
import { readLedger } from './ledger.js';
import { exportRrCache, writeRrCacheDir } from './merge.js';
import { DriverHalt, guardRef } from './propagate.js';
import {
  appendJournal,
  cmdPlan,
  cmdPush,
  cmdRun,
  cmdVerify,
  coldReadWithRetry,
  conflictHunks,
  openCases,
  relevantExcerpt,
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

// --- D-047/B11: multi-parent TOCTOU — execution re-probe + demotion ----------
describe('propagate run — D-047/B11: stale clean verdict re-probed at execution', () => {
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
  it('relevantExcerpt returns only the path-relevant window; null when no path is mentioned', () => {
    const ctx = ['intro line', 'blah blah', 'decision about src/x.ts here', 'more', 'unrelated tail', 'final'].join(
      '\n',
    );
    const ex = relevantExcerpt(ctx, ['src/x.ts'], 1);
    expect(ex).toContain('src/x.ts');
    expect(ex).toContain('blah blah'); // -1 context
    expect(ex).toContain('more'); // +1 context
    expect(ex).not.toContain('final'); // far away → excluded
    expect(relevantExcerpt('nothing relevant\nat all here', ['src/x.ts'])).toBeNull();
  });

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
