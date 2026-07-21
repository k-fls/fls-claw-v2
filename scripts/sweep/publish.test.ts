/**
 * scripts/sweep/publish.test.ts — `propagate publish` (PROPAGATION.md §14,
 * D-048): exhibit-head construction, the blocking/advisory check battery, the
 * two-round PR-text cold read, and the networked execute path against an
 * injected fake transport (dry-run must make ZERO network calls).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { isAncestor, newStyleMergeTree } from './git.js';
import { readLedger } from './ledger.js';
import {
  buildExhibit,
  checkExhibitAncestry,
  checkExhibitDiff,
  decidedAlready,
  haltIdFor,
  isBlocking,
  parseGithubSlug,
  prTextGate,
  prTextHash,
  type Exhibit,
  type GithubTransport,
  type Issue,
} from './publish.js';
import { cmdPlan, cmdPublish, cmdResolve, cmdRun, passDir, readJournal, type Cli } from './propagate.js';
import type { FeatureEntry } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'pub-ws-'));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

interface InvEntry {
  id: string;
  branch: string;
  parents?: string[];
  extra_context?: string;
  decided_paths?: string[];
}

function writeInventory(entries: InvEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pub-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) {
    const yaml = [
      `id: ${e.id}`,
      `name: ${e.id}`,
      'kind: feat',
      'status: shipped',
      `branch: ${e.branch}`,
      ...(e.parents ? ['parents:', ...e.parents.map((p) => `  - ${p}`)] : []),
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

function emptyInventory(): string {
  return writeInventory([]);
}

function baseCli(repo: FixtureRepo, ws: string, inv: string, over: Partial<Cli> = {}): Cli {
  return {
    cmd: 'plan',
    repo: repo.dir,
    workspace: ws,
    inventory: inv,
    scopeFile: join(inv, 'no-scope.yaml'), // non-existent -> empty scope config
    upstream: 'main',
    execute: false,
    ...over,
  };
}

interface PublishOut {
  ok: boolean;
  dryRun?: boolean;
  issues: Issue[];
  pr?: { url: string; number: number };
  exhibit?: { commit: string; tree: string; parent: string; parentSource: string };
  wouldCreate?: { fixBranch: string; base: string; draft: boolean };
}

function readOut(file: string): PublishOut {
  return JSON.parse(readFileSync(file, 'utf8')) as PublishOut;
}

const GOOD_TITLE = 'freeze: main_patched keeps fork src/x.ts against upstream rewrite';
const GOOD_BODY = [
  'Decision needed: on src/x.ts, does the fork variant win over the upstream rewrite (yes = keep fork, no = take upstream)?',
  '',
  'The fork pinned src/x.ts to its own variant; the incoming upstream commit rewrites the same line.',
  'If yes, we resolve by keeping the fork line; if no, the fork patch is retired and upstream lands as-is.',
].join('\n');

function writeText(prDir: string, title: string, body: string): void {
  mkdirSync(prDir, { recursive: true });
  writeFileSync(join(prDir, 'title.txt'), title + '\n');
  writeFileSync(join(prDir, 'body.md'), body + '\n');
}

/** A shape-valid prtext verdict with a FRESH hash for the given text. */
function writePrVerdict(
  prDir: string,
  round: number,
  verdict: string,
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(prDir, 'prtext-verdict.json'),
    JSON.stringify({ round, verdict, notes: ['cold read note'], textHash: prTextHash(title.trim(), body.trim()), ...extra }),
  );
}

function fakeGithub(responses: Record<string, { status: number; body: unknown }> = {}): {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  factories: number;
  factory: (token: string) => GithubTransport;
} {
  const state = {
    calls: [] as Array<{ method: string; path: string; body?: unknown }>,
    factories: 0,
    factory: (_token: string): GithubTransport => {
      state.factories++;
      return {
        async request(method, path, body) {
          state.calls.push({ method, path, body });
          for (const [suffix, res] of Object.entries(responses)) {
            if (path.includes(suffix)) return res;
          }
          if (method === 'GET' && path.includes('/pulls?')) return { status: 200, body: [] };
          if (path.endsWith('/git/blobs')) return { status: 201, body: { sha: '0'.repeat(40) } };
          if (path.endsWith('/git/trees')) return { status: 201, body: { sha: '1'.repeat(40) } };
          if (path.endsWith('/git/commits')) return { status: 201, body: { sha: '2'.repeat(40) } };
          if (path.endsWith('/git/refs')) return { status: 201, body: { ref: 'ok' } };
          if (path.endsWith('/pulls')) return { status: 201, body: { html_url: 'https://github.com/k-fls/fixture/pull/58', number: 58 } };
          return { status: 404, body: null };
        },
      };
    },
  };
  return state;
}

/**
 * main_patched (x=fork, origin at its pre-pass tip) vs a trunk whose U1
 * rewrites x: run merges the U0 prefix, emits the case, and `resolve --tier
 * held` freezes it — the standard held-publish setup.
 */
async function setupHeldCase(entries: InvEntry[] = []): Promise<{
  repo: FixtureRepo;
  ws: string;
  dir: string;
  caseId: string;
  prDir: string;
  originTip: string;
  cli: (o: Partial<Cli>) => Cli;
}> {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // height 0 (clean prefix)
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }); // height 1 (the conflict)
  const originTip = repo.setOrigin('main_patched'); // exhibit parents HERE (§14)
  repo.git('remote', 'add', 'origin', 'https://github.com/k-fls/fixture.git');
  cleanups.push(() => repo.destroy());

  const ws = mkWorkspace();
  const inv = entries.length ? writeInventory(entries) : emptyInventory();
  const dir = passDir(ws, repo.sha('main').slice(0, 12));
  const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
  await cmdPlan(cli({ cmd: 'plan' }));
  await cmdRun(cli({ cmd: 'run', execute: true }));
  const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;
  expect(await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId, tier: 'held' }))).toBe(0);
  return { repo, ws, dir, caseId, prDir: join(dir, caseId, 'pr'), originTip, cli };
}

/** Approve the text through the round-1 gate (request, then a fresh publish verdict). */
async function approveRound1(
  cli: (o: Partial<Cli>) => Cli,
  ws: string,
  caseId: string,
  prDir: string,
): Promise<void> {
  const out = join(ws, 'gate-out.json');
  expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
  expect(readOut(out).issues.some((i) => i.id === 'ERR09_COLDREAD_PENDING')).toBe(true);
  writePrVerdict(prDir, 1, 'publish', GOOD_TITLE, GOOD_BODY);
}

// --- Exhibit head (§14): diff == conflict set, origin-parenting -------------

describe('publish — exhibit head construction (§14, D-048)', () => {
  function exhibitFixture(): { repo: FixtureRepo; originTip: string } {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    const originTip = repo.setOrigin('main_patched');
    cleanups.push(() => repo.destroy());
    return { repo, originTip };
  }

  it('HELD: origin-parented commit whose diff is exactly the conflict set, blobs = conflict markers', async () => {
    const { repo, originTip } = exhibitFixture();
    const probe = await newStyleMergeTree(repo.dir, 'main_patched', 'main');
    expect(probe.clean).toBe(false);
    const ex = await buildExhibit(repo.dir, 'main_patched', probe.treeOid, probe.conflictFiles, 'case-1');
    expect(ex.parentSource).toBe('origin');
    expect(ex.parent).toBe(originTip);
    expect(repo.git('diff', '--name-only', ex.parent, ex.commit)).toBe('src/x.ts');
    expect(repo.git('show', `${ex.commit}:src/x.ts`)).toContain('<<<<<<<'); // the markers ARE the exhibit
    expect(await checkExhibitDiff(repo.dir, ex, probe.conflictFiles)).toBeNull();
    expect(await checkExhibitAncestry(repo.dir, ex, 'main_patched')).toBeNull();
  });

  it('JUDGED: resolved blobs overlay; untouched base content stays out of the diff', async () => {
    const { repo, originTip } = exhibitFixture();
    // A "resolved" tree: src/x.ts = RESOLVED, plus an unrelated file that must NOT leak.
    repo.checkout('main_patched');
    repo.commit('resolution', { 'src/x.ts': 'RESOLVED\n', 'src/unrelated.ts': 'leak\n' });
    repo.checkout('main');
    const ex = await buildExhibit(repo.dir, 'main_patched', repo.sha('main_patched') + '^{tree}', ['src/x.ts'], 'case-2');
    expect(ex.parent).toBe(originTip);
    expect(repo.git('show', `${ex.commit}:src/x.ts`)).toBe('RESOLVED');
    expect(repo.git('diff', '--name-only', ex.parent, ex.commit)).toBe('src/x.ts'); // unrelated.ts excluded
    expect(await checkExhibitDiff(repo.dir, ex, ['src/x.ts'])).toBeNull();
  });

  it('#58 scenario: a local-only merge of a protected branch never enters the exhibit ancestry', async () => {
    const { repo } = exhibitFixture();
    // Child branch, pushed at C1; then a LOCAL-ONLY merge of protected
    // main_patched lands on it (the back-door that pushed unpushed protected
    // commits with the old D-030 heads).
    repo.checkout('feat/c', { create: true, at: 'main' });
    repo.commit('c1', { 'src/c.ts': 'c\n' });
    repo.checkout('main');
    const cOrigin = repo.setOrigin('feat/c');
    const localMerge = repo.git(
      'commit-tree',
      'main_patched^{tree}',
      '-p',
      repo.sha('feat/c'),
      '-p',
      repo.sha('main_patched'),
      '-m',
      'local-only merge of main_patched',
    );
    repo.git('update-ref', 'refs/heads/feat/c', localMerge);

    const probe = await newStyleMergeTree(repo.dir, 'feat/c', 'main');
    const source = probe.clean ? probe.treeOid : probe.treeOid;
    const ex = await buildExhibit(repo.dir, 'feat/c', source, ['src/x.ts'], 'case-58');
    expect(ex.parent).toBe(cOrigin); // NOT the local tip
    expect(await isAncestor(repo.dir, localMerge, ex.commit)).toBe(false);
    expect(await checkExhibitAncestry(repo.dir, ex, 'feat/c')).toBeNull();
  });

  it('ERR03 on overlay mismatch (a claimed path whose blob equals the base) and ERR04 on a forged parent', async () => {
    const { repo, originTip } = exhibitFixture();
    const probe = await newStyleMergeTree(repo.dir, 'main_patched', 'main');
    // README.md is identical in base and source -> diff misses it -> ERR03.
    const ex = await buildExhibit(repo.dir, 'main_patched', probe.treeOid, ['src/x.ts', 'README.md'], 'case-3');
    const err03 = await checkExhibitDiff(repo.dir, ex, ['src/x.ts', 'README.md']);
    expect(err03?.id).toBe('ERR03_DIFF_EXCEEDS_CONFLICT_SET');

    // JUDGED tier: the same dropped-out path is legitimate (non-empty subset)…
    expect(await checkExhibitDiff(repo.dir, ex, ['src/x.ts', 'README.md'], 'judged')).toBeNull();
    // …but an ALL-paths-resolved-to-base exhibit (empty diff) is still ERR03
    // (a no-op PR), and an extra path beyond the conflict set stays blocked.
    const emptyEx = await buildExhibit(repo.dir, 'main_patched', 'main_patched^{tree}', ['README.md'], 'case-3e');
    expect((await checkExhibitDiff(repo.dir, emptyEx, ['README.md'], 'judged'))?.id).toBe(
      'ERR03_DIFF_EXCEEDS_CONFLICT_SET',
    );
    expect((await checkExhibitDiff(repo.dir, ex, ['README.md'], 'judged'))?.id).toBe(
      'ERR03_DIFF_EXCEEDS_CONFLICT_SET',
    );

    // Forged parent = the local tip while origin exists -> ERR04 (structurally
    // prevented by buildExhibit; the assert catches a hand-built exhibit).
    // Advance the local branch past origin first so the tips differ.
    repo.checkout('main_patched');
    repo.commit('mp: local-only', { 'src/local.ts': 'l\n' });
    repo.checkout('main');
    const forged: Exhibit = { ...ex, parent: repo.sha('main_patched') };
    expect(forged.parent).not.toBe(originTip);
    const err04 = await checkExhibitAncestry(repo.dir, forged, 'main_patched');
    expect(err04?.id).toBe('ERR04_UNPUSHED_PARENT');
  });
});

// --- prTextGate: two-round cap + freshness (§14) -----------------------------

describe('publish — PR-text cold read gate (two-round HARD cap)', () => {
  function gateInput(prDir: string, title: string, body: string): Parameters<typeof prTextGate>[0] {
    return {
      prDir,
      caseId: 'case-x',
      title,
      body,
      conflictedPaths: ['src/x.ts'],
      materials: 'materials',
      inventoryContext: 'context',
    };
  }
  function mkPrDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pub-pr-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('no verdict -> ERR09 + a round-1 request stamped with the current textHash', () => {
    const prDir = mkPrDir();
    const res = prTextGate(gateInput(prDir, 't', 'b'));
    expect(res.issue?.id).toBe('ERR09_COLDREAD_PENDING');
    const req = readFileSync(join(prDir, 'prtext-review-request.md'), 'utf8');
    expect(req).toContain('round: 1');
    expect(req).toContain(`textHash: ${prTextHash('t', 'b')}`);
    expect(req).toContain('Q0');
  });

  it('textHash freshness rejects a stale verdict: round 1 is consumed, round 2 request issued', () => {
    const prDir = mkPrDir();
    prTextGate(gateInput(prDir, 't', 'b'));
    writeFileSync(
      join(prDir, 'prtext-verdict.json'),
      JSON.stringify({ round: 1, verdict: 'publish', notes: [], textHash: prTextHash('t', 'OLD') }),
    );
    const res = prTextGate(gateInput(prDir, 't', 'b'));
    expect(res.issue?.id).toBe('ERR09_COLDREAD_PENDING');
    expect(res.issue?.detail).toContain('stale');
    expect(readFileSync(join(prDir, 'prtext-review-request.md'), 'utf8')).toContain('round: 2');
  });

  it('round-1 rewrite -> ERR09; round-2 rewrite ships as publish + WARN04 caveats; round 3 is impossible (ERR10)', () => {
    const prDir = mkPrDir();
    prTextGate(gateInput(prDir, 't', 'b1'));
    writeFileSync(
      join(prDir, 'prtext-verdict.json'),
      JSON.stringify({ round: 1, verdict: 'rewrite', notes: ['unclear ask'], textHash: prTextHash('t', 'b1') }),
    );
    // Fresh round-1 rewrite: the agent must edit; no new request yet.
    const r1 = prTextGate(gateInput(prDir, 't', 'b1'));
    expect(r1.issue?.id).toBe('ERR09_COLDREAD_PENDING');
    expect(r1.issue?.detail).toContain('rewrite');
    expect(readFileSync(join(prDir, 'prtext-review-request.md'), 'utf8')).toContain('round: 1');

    // Text edited -> the round-1 verdict goes stale -> round-2 request.
    const r2req = prTextGate(gateInput(prDir, 't', 'b2'));
    expect(r2req.issue?.id).toBe('ERR09_COLDREAD_PENDING');
    expect(readFileSync(join(prDir, 'prtext-review-request.md'), 'utf8')).toContain('round: 2');

    // Round-2 REWRITE verdict is FINAL: treated as publish-with-caveats (WARN04).
    writeFileSync(
      join(prDir, 'prtext-verdict.json'),
      JSON.stringify({ round: 2, verdict: 'rewrite', notes: ['still thin'], textHash: prTextHash('t', 'b2') }),
    );
    const final = prTextGate(gateInput(prDir, 't', 'b2'));
    expect(final.issue).toBeNull();
    expect(final.caveats).toEqual(['still thin']);
    expect(final.warnings.some((w) => w.id === 'WARN04_COLDREAD_NOTES')).toBe(true);

    // Editing AFTER the final round: no round-3 request exists or is written — ERR10.
    const exhausted = prTextGate(gateInput(prDir, 't', 'b3'));
    expect(exhausted.issue?.id).toBe('ERR10_COLDREAD_EXHAUSTED');
    expect(readFileSync(join(prDir, 'prtext-review-request.md'), 'utf8')).toContain('round: 2');
  });

  it('round >2 or malformed verdicts are invalid shape; reject-derivable/consolidate block with ERR05/ERR06 semantics', () => {
    const prDir = mkPrDir();
    prTextGate(gateInput(prDir, 't', 'b'));
    writeFileSync(
      join(prDir, 'prtext-verdict.json'),
      JSON.stringify({ round: 3, verdict: 'publish', notes: [], textHash: prTextHash('t', 'b') }),
    );
    const bad = prTextGate(gateInput(prDir, 't', 'b'));
    expect(bad.issue?.id).toBe('ERR09_COLDREAD_PENDING');
    expect(bad.issue?.detail).toContain('round must be 1 or 2');

    writeFileSync(
      join(prDir, 'prtext-verdict.json'),
      JSON.stringify({
        round: 1,
        verdict: 'reject-derivable',
        derivedAnswer: 'decision already recorded: keep fork',
        notes: [],
        textHash: prTextHash('t', 'b'),
      }),
    );
    const rejected = prTextGate(gateInput(prDir, 't', 'b'));
    expect(rejected.issue?.id).toBe('ERR05_DECIDED_ALREADY');
    expect(rejected.issue?.detail).toContain('keep fork');

    writeFileSync(
      join(prDir, 'prtext-verdict.json'),
      JSON.stringify({ round: 1, verdict: 'consolidate', derivedAnswer: 'same as case-y', notes: [], textHash: prTextHash('t', 'b') }),
    );
    const consolidated = prTextGate(gateInput(prDir, 't', 'b'));
    expect(consolidated.issue?.id).toBe('ERR06_DUPLICATE_CASE');
  });
});

// --- Unit: decidedAlready, slug parsing, halt-id mapping ---------------------

describe('publish — decidedAlready (ERR05) + helpers', () => {
  it('fires on an extra_context record naming a conflicted path, quoting the record', () => {
    const features = [
      {
        id: 'creds',
        name: 'creds',
        kind: 'module',
        status: 'shipped',
        branch: 'module/credentials',
        prompt: { extra_context: 'Owner decision 2026-07-15: src/x.ts keeps the fork variant (PR #40).' },
      },
    ] as unknown as FeatureEntry[];
    const issue = decidedAlready(features, 'main_patched', ['src/x.ts']);
    expect(issue?.id).toBe('ERR05_DECIDED_ALREADY');
    expect(issue?.detail).toContain("entry 'creds'");
    expect(issue?.detail).toContain('keeps the fork variant');
    expect(issue?.detail).toContain('do not re-ask the owner');
    expect(decidedAlready(features, 'main_patched', ['src/other.ts'])).toBeNull();
  });

  it('fires on an explicit decided_paths hit even without extra_context text', () => {
    const features = [
      { id: 'e', name: 'e', kind: 'feat', status: 'shipped', prompt: { decided_paths: ['src/x.ts'] } },
    ] as unknown as FeatureEntry[];
    expect(decidedAlready(features, 'b', ['src/x.ts'])?.id).toBe('ERR05_DECIDED_ALREADY');
  });

  it('parses github slugs and maps DriverHalt reasons to ERR2x ids', () => {
    expect(parseGithubSlug('https://github.com/k-fls/fls-claw-v2.git')).toEqual({ owner: 'k-fls', repo: 'fls-claw-v2' });
    expect(parseGithubSlug('git@github.com:k-fls/fls-claw-v2.git')).toEqual({ owner: 'k-fls', repo: 'fls-claw-v2' });
    expect(parseGithubSlug('https://example.com/x/y')).toBeNull();
    expect(haltIdFor('sync-diverged')).toBe('ERR20_BRANCH_DIVERGED');
    expect(haltIdFor('merge-failed')).toBe('ERR21_MERGE_FAILED');
    expect(haltIdFor('dirty-worktree')).toBe('ERR22_DIRTY_WORKTREE');
    expect(haltIdFor('protected-ref')).toBe('ERR23_PROTECTED_REF');
    expect(haltIdFor('plan-drift')).toBe('ERR24_PLAN_DRIFT');
    expect(haltIdFor('bad-case-id')).toBe('ERR25_BAD_CASE_ID');
    expect(haltIdFor('something-else')).toBeNull();
    expect(isBlocking('ERR01_CASE_NOT_OPEN')).toBe(true);
    expect(isBlocking('WARN03_MANY_PRS')).toBe(false);
  });
});

// --- cmdPublish: blocking battery end-to-end ---------------------------------

describe('propagate publish — check battery (blocking ids reachable)', () => {
  it('ERR01: an unresolved case (or an unknown id) cannot publish', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const caseId = readJournal(dir).find((e) => e.action === 'case')!.caseId as string;

    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1); // no resolve/held yet
    expect(readOut(out).issues.some((i) => i.id === 'ERR01_CASE_NOT_OPEN')).toBe(true);

    expect(await cmdPublish(cli({ cmd: 'publish', caseId: 'no__such--case-h9', out }))).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR01_CASE_NOT_OPEN')).toBe(true);

    expect(await cmdPublish(cli({ cmd: 'publish', caseId: '../evil', out }))).toBe(2);
    expect(readOut(out).issues.some((i) => i.id === 'ERR25_BAD_CASE_ID')).toBe(true);
  });

  it('ERR02: a held case whose resolution landed externally is stale', async () => {
    const { repo, ws, dir, caseId, cli } = await setupHeldCase();
    const head = (readJournal(dir).find((e) => e.action === 'case')!.head as { sha: string }).sha;
    // External resolution: a merge commit containing the head lands on the branch.
    const tip = repo.sha('main_patched');
    const merged = repo.git('commit-tree', `${head}^{tree}`, '-p', tip, '-p', head, '-m', 'external resolution');
    repo.git('update-ref', 'refs/heads/main_patched', merged);
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR02_CASE_STALE');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('resolution landed');
  });

  it('ERR05: a recorded inventory decision naming a conflicted path blocks the publish', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase([
      {
        id: 'x-decision',
        branch: 'feat/none',
        extra_context: 'Owner decision 2026-07-15: src/x.ts keeps the fork variant; never re-raise.',
      },
    ]);
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR05_DECIDED_ALREADY');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('never re-raise');
  });

  it('ERR06: two cases sharing a conflict signature — only the topmost (DAG order) may publish', async () => {
    // feat/a and feat/b carry the SAME fork edit and conflict identically
    // against the same main_patched tip: same paths + same head sha.
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

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    await cmdPlan(cli({ cmd: 'plan' }));
    await cmdRun(cli({ cmd: 'run', execute: true }));
    const cases = readJournal(dir)
      .filter((e) => e.action === 'case')
      .map((e) => e.caseId as string);
    expect(cases.length).toBe(2);
    const [topmost, duplicate] = cases;
    for (const c of cases) expect(await cmdResolve(cli({ cmd: 'resolve', execute: true, caseId: c, tier: 'held' }))).toBe(0);

    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId: duplicate, out }))).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR06_DUPLICATE_CASE');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain(topmost); // names the topmost case

    // The topmost case itself gets NO ERR06 (it is the one that publishes).
    expect(await cmdPublish(cli({ cmd: 'publish', caseId: topmost, out }))).toBe(1); // still blocked (no text)
    expect(readOut(out).issues.some((i) => i.id === 'ERR06_DUPLICATE_CASE')).toBe(false);
    expect(readOut(out).issues.some((i) => i.id === 'ERR08_TEXT_MISSING')).toBe(true);
  });

  it('ERR07: a journaled pr-published entry for the case blocks a second publish', async () => {
    const { ws, dir, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), action: 'pr-published', caseId, url: 'https://github.com/k-fls/fixture/pull/7', number: 7 }) + '\n',
    );
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR07_PR_EXISTS');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('#7');
  });

  it('ERR08 (text missing) then ERR09 (cold read pending) with a driver-written round-1 request', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR08_TEXT_MISSING')).toBe(true);

    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR09_COLDREAD_PENDING')).toBe(true);
    const req = readFileSync(join(prDir, 'prtext-review-request.md'), 'utf8');
    expect(req).toContain('round: 1');
    expect(req).toContain(GOOD_TITLE);
    expect(req).toContain('src/x.ts');
    expect(req).toContain('## Case materials'); // driver facts embedded
  });

  it('WARN01/WARN02 are advisory: a template-ish body still publishes (dry-run ok:true)', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    const title = 'sweep freeze h1';
    const body = 'This PR was prepared by the sweep.\n\nNo further detail.';
    writeText(prDir, title, body);
    await cmdPublish(cli({ cmd: 'publish', caseId })); // issues round-1 request
    writePrVerdict(prDir, 1, 'publish', title, body);
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.issues.some((i) => i.id === 'WARN01_TEMPLATE_TEXT')).toBe(true);
    expect(res.issues.some((i) => i.id === 'WARN02_NO_DECISION_LINE')).toBe(true);
    expect(res.issues.every((i) => !isBlocking(i.id))).toBe(true);
  });

  it('ERR11: --execute without a token file blocks before any network call', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    await approveRound1(cli, ws, caseId, prDir);
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, out }), gh.factory)).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR11_TOKEN_MISSING')).toBe(true);
    expect(gh.factories).toBe(0);
    expect(gh.calls.length).toBe(0);
  });
});

// --- cmdPublish: dry-run purity + execute happy path -------------------------

describe('propagate publish — dry-run makes no network calls; execute creates ref + draft PR via the API', () => {
  it('dry-run: full battery green, exhibit reported, transport never constructed', async () => {
    const { repo, ws, caseId, prDir, originTip, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    await approveRound1(cli, ws, caseId, prDir);
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.exhibit!.parentSource).toBe('origin');
    expect(res.exhibit!.parent).toBe(originTip);
    expect(repo.git('diff', '--name-only', res.exhibit!.parent, res.exhibit!.commit)).toBe('src/x.ts');
    expect(res.wouldCreate!.fixBranch).toMatch(/^fix\/sweep\//);
    expect(res.wouldCreate!.draft).toBe(true);
    expect(gh.factories).toBe(0); // NO network calls of any kind on dry-run
    expect(gh.calls.length).toBe(0);
  });

  it('execute: blobs -> tree -> commit -> ref -> draft PR, journaled pr-published, ledger fixBranch, local ref', async () => {
    const { repo, ws, dir, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    await approveRound1(cli, ws, caseId, prDir);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.pr).toEqual({ url: 'https://github.com/k-fls/fixture/pull/58', number: 58 });

    // API sequence against the parsed origin slug.
    const paths = gh.calls.map((c) => c.path);
    expect(paths[0]).toContain('/repos/k-fls/fixture/pulls?head=k-fls%3Afix%2Fsweep%2F'); // ERR07 API probe
    expect(paths.some((p) => p.endsWith('/git/blobs'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/git/trees'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/git/commits'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/git/refs'))).toBe(true);
    const prCall = gh.calls.find((c) => c.path.endsWith('/pulls') && c.method === 'POST')!;
    expect((prCall.body as { draft: boolean }).draft).toBe(true);
    expect((prCall.body as { base: string }).base).toBe('main_patched');
    expect((prCall.body as { title: string }).title).toBe(GOOD_TITLE);

    // Journal + ledger + local anchor ref.
    const published = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(published.caseId).toBe(caseId);
    expect(published.number).toBe(58);
    const fixBranch = published.fixBranch as string;
    expect(fixBranch).toMatch(/^fix\/sweep\//);
    expect(repo.sha(fixBranch)).toBe(published.exhibit);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']!.fixBranch).toBe(fixBranch);

    // A second publish of the same case is ERR07 (journal side), no network needed.
    const gh2 = fakeGithub();
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh2.factory)).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR07_PR_EXISTS')).toBe(true);
    expect(gh2.factories).toBe(0);
  });

  it('execute: an open PR found via the API by head branch name is ERR07', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    await approveRound1(cli, ws, caseId, prDir);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub({
      '/pulls?': { status: 200, body: [{ html_url: 'https://github.com/k-fls/fixture/pull/9', number: 9 }] },
    });
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR07_PR_EXISTS');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('pull/9');
    expect(gh.calls.length).toBe(1); // stopped after the probe — nothing was created
  });

  it('execute: round-2 caveats ship on the PR body under "## Caveats (cold reader)" with WARN04', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    // Round 1: rewrite. Edit. Round 2: rewrite again -> FINAL, publish-with-caveats.
    await cmdPublish(cli({ cmd: 'publish', caseId }));
    writePrVerdict(prDir, 1, 'rewrite', GOOD_TITLE, GOOD_BODY);
    const body2 = GOOD_BODY + '\nClarified per round-1 notes.';
    writeText(prDir, GOOD_TITLE, body2);
    expect(await cmdPublish(cli({ cmd: 'publish', caseId }))).toBe(1); // issues the round-2 request
    writePrVerdict(prDir, 2, 'rewrite', GOOD_TITLE, body2, { notes: ['yes/no consequence still thin'] });

    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.issues.some((i) => i.id === 'WARN04_COLDREAD_NOTES')).toBe(true);
    const prCall = gh.calls.find((c) => c.path.endsWith('/pulls') && c.method === 'POST')!;
    const sent = (prCall.body as { body: string }).body;
    expect(sent).toContain('## Caveats (cold reader)');
    expect(sent).toContain('yes/no consequence still thin');

    // Round 3 is impossible: editing after the final round is ERR10.
    writeText(prDir, GOOD_TITLE, body2 + '\nPost-final edit.');
    // (new case state: PR already published, so ERR07 fires first — assert the
    // gate alone via a fresh attempt on the text level.)
  });
});
