/**
 * scripts/sweep/publish.test.ts — `propagate publish` (PROPAGATION.md §14,
 * D-048/D-049/D-050): the pre-PR height check + D-004 machine block, the
 * blocking/advisory check battery (text checks MECHANICAL only — the PR-text
 * cold read is retired, D-050), and the networked execute path — real
 * `git push` into a bare fixture origin, PR creation against an injected fake
 * transport (dry-run must make ZERO network calls and ZERO pushes).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { readLedger } from './ledger.js';
import {
  MACHINE_BLOCK_BEGIN,
  MACHINE_BLOCK_END,
  checkBaseHeight,
  classifyComments,
  classifyReviewTrigger,
  decidedAlready,
  extractSweepAddressed,
  ghPaginated,
  haltIdFor,
  isBlocking,
  maxRealReviewId,
  parseGithubSlug,
  renderMachineBlock,
  stripSweepAddressed,
  withMachineBlock,
  type GithubTransport,
  type Issue,
  type PrReview,
} from './publish.js';
import {
  cmdPlan,
  cmdPublish,
  cmdRun,
  cmdSweepNextCase,
  cmdSweepReportCase,
  cmdSweepReportPr,
  cmdSweepStart,
  duplicateCaseIssue,
  journaledCases,
  passDir,
  readJournal,
  type Cli,
  type ColdReadInvoker,
  type JournalEntry,
} from './propagate.js';
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
  head?: { commit: string; mode: string };
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
          if (path.endsWith('/pulls') && method === 'POST')
            return { status: 201, body: { html_url: 'https://github.com/k-fls/fixture/pull/58', number: 58 } };
          // D-059: held publishes post the sweep-addressed marker comment.
          if (method === 'POST' && path.includes('/comments')) return { status: 201, body: {} };
          return { status: 404, body: null };
        },
      };
    },
  };
  return state;
}

// --- Reaching a HELD case through the SURVIVING path (D-053) -----------------
// The flag-based `resolve` these fixtures used to call is gone (it was a second
// resolution implementation the state machine never invoked). The freeze now
// happens the only way it can: `report-case --tier held`. Everything downstream
// of the freeze — the journal rows publish reads, the pass heights, the case
// worktree lifecycle — is identical, so the batteries below still exercise
// `cmdPublish` exactly as before.

const confirm: ColdReadInvoker = async () => ({
  verdict: 'confirm',
  notes: 'behaviour preserved; every hunk explained',
});
/** A pristine HELD claim skips the cold read entirely — a call here is a bug. */
const neverInvoked: ColdReadInvoker = async () => {
  throw new Error('cold read invoked where the pristine HELD path forbids one');
};

function machineState(dir: string): { phase: string; currentCase: { caseId: string; tier?: string } | null } {
  return JSON.parse(readFileSync(join(dir, 'machine-state.json'), 'utf8')) as {
    phase: string;
    currentCase: { caseId: string; tier?: string } | null;
  };
}
function currentCaseId(dir: string): string {
  return machineState(dir).currentCase!.caseId;
}
/** The agent's edit: write files into the case worktree `next-case` handed over. */
function resolveWorktree(dir: string, caseId: string, files: Record<string, string>): void {
  const wt = join(dir, caseId, 'worktree');
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(wt, p, '..'), { recursive: true });
    writeFileSync(join(wt, p), content);
  }
}

/** main_patched (x=fork) + a trunk whose U0 is clean and U1 rewrites x. */
function heldCaseRepo(): FixtureRepo {
  const repo = initFixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' }); // height 0 (clean prefix)
  repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }); // height 1 (the conflict)
  cleanups.push(() => repo.destroy());
  return repo;
}

/**
 * `next-case` merges the U0 prefix and serves the conflict; `report-case --tier
 * held` on the UNTOUCHED worktree freezes the PRISTINE conflict (no resolution
 * recorded, so publish must build the pristine-conflict DRAFT head; the gate and
 * the cold read are skipped — nothing was resolved). A REAL pushable origin (bare
 * repo behind a github-shaped URL) is always attached: `start` fetches origin, and
 * `publish --execute` really pushes. The target push that HELD publishing requires
 * (D-049 §14.4 order: targets first, then HELD PRs) is simulated so ERR14 passes.
 *
 * `entries` is the inventory the RETURNED cli publishes against. The freeze itself
 * always runs on an EMPTY inventory: `report-case` has its own first-attempt ERR05
 * steer (D-060) which would block the freeze before publish's gate could be
 * reached, and the subject here is publish's gate.
 */
async function setupHeldCase(entries: InvEntry[] = []): Promise<{
  repo: FixtureRepo;
  ws: string;
  dir: string;
  caseId: string;
  prDir: string;
  bareDir: string;
  cli: (o: Partial<Cli>) => Cli;
}> {
  const repo = heldCaseRepo();
  const bareDir = repo.attachBareOrigin();
  repo.git('push', 'origin', 'main_patched'); // pre-pass tip on origin

  const ws = mkWorkspace();
  const passInv = emptyInventory();
  const publishInv = entries.length ? writeInventory(entries) : passInv;
  const dir = passDir(ws, repo.sha('main').slice(0, 12));
  const passCli = (o: Partial<Cli>): Cli => baseCli(repo, ws, passInv, o);
  expect(await cmdSweepStart(passCli({ cmd: 'sweep-start' }))).toBe(0);
  expect(await cmdSweepNextCase(passCli({ cmd: 'next-case' }))).toBe(0);
  const caseId = currentCaseId(dir);
  expect(
    await cmdSweepReportCase(passCli({ cmd: 'report-case', tier: 'held', execute: true }), neverInvoked),
  ).toBe(0);
  const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
  expect(held.resolution ?? null).toBeNull(); // pristine: publish must build the DRAFT head
  repo.git('push', 'origin', 'main_patched'); // simulated target push -> ERR14 passes
  const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, publishInv, o);
  return { repo, ws, dir, caseId, prDir: join(dir, caseId, 'pr'), bareDir, cli };
}

/**
 * The ESCALATED held case: a MARKER-CLEAN resolution that also edits a file
 * outside the conflict, with the cold read AGREEING — scope exceeded + confirm
 * (D-057 #3) freezes HELD carrying the resolution, so publish must build an
 * ACTIVE (non-draft) PR at the resolved merge commit with the escalation prefix.
 */
async function setupEscalatedHeldCase(): Promise<{
  repo: FixtureRepo;
  ws: string;
  dir: string;
  caseId: string;
  prDir: string;
  bareDir: string;
  resolvedTree: string;
  cli: (o: Partial<Cli>) => Cli;
}> {
  const repo = heldCaseRepo();
  const bareDir = repo.attachBareOrigin();
  repo.git('push', 'origin', 'main_patched');

  const ws = mkWorkspace();
  const inv = emptyInventory();
  const dir = passDir(ws, repo.sha('main').slice(0, 12));
  const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
  expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
  expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
  const caseId = currentCaseId(dir);
  const postRun = repo.sha('main_patched');
  resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n', 'src/extra.ts': 'sneaky\n' });
  expect(
    await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'mechanical', execute: true }), confirm),
  ).toBe(0);
  expect(repo.sha('main_patched')).toBe(postRun); // scope exceeded -> HELD, no merge
  const held = readJournal(dir).find((e) => e.action === 'held' && e.caseId === caseId)!;
  expect(held.escalation).toMatchObject({ tag: '[AUTO-ESCALATED: scope exceeded]' });
  const resolution = held.resolution as { tree: string; markerClean: boolean };
  expect(resolution).toMatchObject({ markerClean: true });
  repo.git('push', 'origin', 'main_patched');
  return { repo, ws, dir, caseId, prDir: join(dir, caseId, 'pr'), bareDir, resolvedTree: resolution.tree, cli };
}

// --- Pre-PR height check (D-049 §5) + D-004 machine block --------------------

describe('publish — pre-PR height check (ERR14, D-049 §5)', () => {
  function heightFixture(): { repo: FixtureRepo } {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    cleanups.push(() => repo.destroy());
    return { repo };
  }

  it('HELD: origin missing or behind the local tip is ERR14; at/above passes ("higher is fine")', async () => {
    const { repo } = heightFixture();
    const head = repo.sha('main');
    // No origin ref at all.
    expect((await checkBaseHeight(repo.dir, 'main_patched', 'held', head))?.id).toBe('ERR14_BASE_BEHIND');
    // Origin BEHIND the local tip (pre-pass tip while local advanced).
    const preTip = repo.sha('main_patched');
    repo.setOrigin('main_patched');
    repo.checkout('main_patched');
    repo.commit('mp: pass merge', { 'src/util.ts': 'u\n' });
    repo.checkout('main');
    const behind = await checkBaseHeight(repo.dir, 'main_patched', 'held', head);
    expect(behind?.id).toBe('ERR14_BASE_BEHIND');
    expect(behind?.detail).toContain('BEHIND');
    // Origin at the local tip (targets pushed) -> passes.
    repo.setOrigin('main_patched');
    expect(await checkBaseHeight(repo.dir, 'main_patched', 'held', head)).toBeNull();
    // Origin strictly AHEAD (someone else committed) -> higher is fine.
    const ahead = repo.git('commit-tree', 'main_patched^{tree}', '-p', repo.sha('main_patched'), '-m', 'owner commit');
    repo.git('update-ref', 'refs/remotes/origin/main_patched', ahead);
    expect(await checkBaseHeight(repo.dir, 'main_patched', 'held', head)).toBeNull();
    // DIVERGED -> ERR14 (owner escalation).
    repo.git('update-ref', 'refs/remotes/origin/main_patched', preTip);
    repo.checkout('main_patched');
    repo.commit('mp: local-only 2', { 'src/l2.ts': 'l\n' });
    repo.checkout('main');
    const forked = repo.git('commit-tree', `${preTip}^{tree}`, '-p', preTip, '-m', 'external');
    repo.git('update-ref', 'refs/remotes/origin/main_patched', forked);
    const diverged = await checkBaseHeight(repo.dir, 'main_patched', 'held', head);
    expect(diverged?.id).toBe('ERR14_BASE_BEHIND');
    expect(diverged?.detail).toContain('DIVERGED');
  });

  it('JUDGED: origin already containing the merge commit is ERR14 (order violation); behind-but-contained passes', async () => {
    const { repo } = heightFixture();
    repo.setOrigin('main_patched'); // origin at the pre-pass tip
    // The judged merge commit lands locally (origin now behind — expected for JUDGED).
    repo.checkout('main_patched');
    repo.commit('mp: judged resolution', { 'src/x.ts': 'resolved\n' });
    repo.checkout('main');
    const mergeCommit = repo.sha('main_patched');
    expect(await checkBaseHeight(repo.dir, 'main_patched', 'judged', mergeCommit)).toBeNull();
    // Target push already ran -> origin contains the merge commit -> ERR14.
    repo.setOrigin('main_patched');
    const late = await checkBaseHeight(repo.dir, 'main_patched', 'judged', mergeCommit);
    expect(late?.id).toBe('ERR14_BASE_BEHIND');
    expect(late?.detail).toContain('BEFORE the target push');
  });
});

describe('publish — D-004 machine block (D-049 decision 8)', () => {
  it('appends below the agent body, replaces idempotently, never touches the prose', () => {
    const block1 = renderMachineBlock(3, 'abcdef123456');
    const withBlock = withMachineBlock('Decision needed: keep fork?\n\nDetails.', block1);
    expect(withBlock).toContain('Decision needed: keep fork?');
    expect(withBlock).toContain(MACHINE_BLOCK_BEGIN);
    expect(withBlock).toContain('**3**');
    // Refresh replaces the delimited block only.
    const block2 = renderMachineBlock(7, 'abcdef123456');
    const refreshed = withMachineBlock(withBlock, block2);
    expect(refreshed).toContain('Decision needed: keep fork?');
    expect(refreshed).toContain('**7**');
    expect(refreshed).not.toContain('**3**');
    expect(refreshed.indexOf(MACHINE_BLOCK_BEGIN)).toBe(refreshed.lastIndexOf(MACHINE_BLOCK_BEGIN));
    expect(refreshed.indexOf(MACHINE_BLOCK_END)).toBe(refreshed.lastIndexOf(MACHINE_BLOCK_END));
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

describe('D-059 FINAL — review-loop primitives (hardened tag, review trigger, pagination)', () => {
  it('the sweep-addressed tag is recognized ONLY as its own marker line — a quote-reply/inline embedding stays human', () => {
    expect(extractSweepAddressed('<!-- sweep-addressed: 7 -->')).toBe(7);
    expect(extractSweepAddressed('   <!-- sweep-addressed: 7 -->  ')).toBe(7); // whitespace-tolerant
    expect(extractSweepAddressed('note above\n<!-- sweep-addressed: 7 -->')).toBe(7);
    expect(extractSweepAddressed('> <!-- sweep-addressed: 7 -->')).toBeNull(); // quote-reply stays human
    expect(extractSweepAddressed('inline <!-- sweep-addressed: 7 --> text')).toBeNull(); // embedded stays human
    expect(extractSweepAddressed('<!-- sweep-addressed: 3 -->\n<!-- sweep-addressed: 9 -->')).toBe(9); // MAX
    expect(stripSweepAddressed('reply text\n<!-- sweep-addressed: 3 -->')).toBe('reply text');
    expect(stripSweepAddressed('<!-- sweep-addressed: 3 -->')).toBe(''); // marker-only -> empty (dropped from the dialog)

    const { humans, driver, markerId } = classifyComments([
      { id: 1, body: 'first publish note\n<!-- sweep-addressed: 3 -->', author: 'shared-pat', createdAt: '' },
      { id: 2, body: 'looks wrong:\n> <!-- sweep-addressed: 9 -->\nplease fix', author: 'k-owner', createdAt: '' },
      { id: 3, body: '<!-- sweep-addressed: 5 -->', author: 'shared-pat', createdAt: '' },
    ]);
    expect(driver.map((c) => c.id)).toEqual([1, 3]);
    expect(humans.map((c) => c.id)).toEqual([2]); // the embedded 9 never counts as a marker
    expect(markerId).toBe(5);
  });

  it('classifyReviewTrigger: reviews ONLY trigger, *[bot]* reviews ignored, the marker watermark bounds the reissue', () => {
    const r = (id: number, state: string, author: string): PrReview => ({ id, state, body: '', author, submittedAt: '' });
    expect(classifyReviewTrigger([], null).reissueDue).toBe(false); // no review, no trigger — ever
    expect(classifyReviewTrigger([r(5, 'CHANGES_REQUESTED', 'lint[bot]')], null).reissueDue).toBe(false); // bots ignored
    const t = classifyReviewTrigger([r(5, 'COMMENTED', 'k-owner'), r(9, 'APPROVED', 'k-owner')], null);
    expect(t.reissueDue).toBe(true);
    expect(t.latest!.id).toBe(9); // the NEWEST review carries the action state
    expect(t.latest!.state).toBe('APPROVED');
    expect(t.maxReviewId).toBe(9);
    expect(classifyReviewTrigger([r(9, 'APPROVED', 'k-owner')], 9).reissueDue).toBe(false); // addressed
    expect(classifyReviewTrigger([r(9, 'APPROVED', 'k-owner')], 4).reissueDue).toBe(true); // beyond the marker
    expect(classifyReviewTrigger([r(9, 'PENDING', 'k-owner')], null).reissueDue).toBe(false); // unsubmitted never triggers
  });

  it('marker bound (finding 4): a pasted sweep-addressed id ABOVE the max real review id is ignored — never silences the loop, never mislabels the comment as an agent turn', () => {
    const r = (id: number, state: string, author: string): PrReview => ({ id, state, body: '', author, submittedAt: '' });
    // extractSweepAddressed: per-LINE bound — a bogus value is dropped, a real
    // one on another line still counts.
    expect(extractSweepAddressed('<!-- sweep-addressed: 999999999 -->', 300)).toBeNull();
    expect(extractSweepAddressed('<!-- sweep-addressed: 200 -->\n<!-- sweep-addressed: 999999999 -->', 300)).toBe(200);
    expect(extractSweepAddressed('<!-- sweep-addressed: 300 -->', 300)).toBe(300); // at the bound = real
    expect(extractSweepAddressed('<!-- sweep-addressed: 0 -->', 0)).toBe(0); // first-publish marker, no reviews yet
    expect(maxRealReviewId([])).toBe(0);
    expect(maxRealReviewId([r(300, 'CHANGES_REQUESTED', 'k-owner'), r(950, 'COMMENTED', 'lint[bot]')])).toBe(950);

    // classifyComments with the bound: the human paste stays HUMAN and does
    // not move the marker; the driver's real marker still reads.
    const reviews = [r(300, 'CHANGES_REQUESTED', 'k-owner'), r(400, 'CHANGES_REQUESTED', 'k-owner')];
    const { humans, driver, markerId } = classifyComments(
      [
        { id: 1, body: 'bookkeeping\n<!-- sweep-addressed: 300 -->', author: 'shared-pat', createdAt: '' },
        { id: 2, body: '<!-- sweep-addressed: 999999999 -->', author: 'k-owner', createdAt: '' }, // human paste
      ],
      maxRealReviewId(reviews),
    );
    expect(markerId).toBe(300);
    expect(driver.map((c) => c.id)).toEqual([1]);
    expect(humans.map((c) => c.id)).toEqual([2]); // NOT an agent turn
    // The real review above the real marker still triggers the reissue.
    expect(classifyReviewTrigger(reviews, markerId).reissueDue).toBe(true);
    // WITHOUT the bound (the old behavior) the paste silenced the loop.
    expect(classifyComments([{ id: 2, body: '<!-- sweep-addressed: 999999999 -->', author: 'k-owner', createdAt: '' }]).markerId).toBe(999999999);
  });

  it('DISMISSED reviews never trigger a reissue (nothing actionable); an earlier live review above the marker still does', () => {
    const r = (id: number, state: string, author: string): PrReview => ({ id, state, body: '', author, submittedAt: '' });
    // Only a dismissed review beyond the marker -> no trigger at all.
    const only = classifyReviewTrigger([r(5, 'DISMISSED', 'k-owner')], null);
    expect(only.reissueDue).toBe(false);
    expect(only.latest).toBeNull();
    // A live CHANGES_REQUESTED under a newer DISMISSED one still triggers, and
    // the ACTION state comes from the live review — not the dismissal.
    const t = classifyReviewTrigger([r(4, 'CHANGES_REQUESTED', 'k-owner'), r(5, 'DISMISSED', 'k-owner')], 3);
    expect(t.reissueDue).toBe(true);
    expect(t.latest!.id).toBe(4);
    expect(t.latest!.state).toBe('CHANGES_REQUESTED');
    // Everything addressed + a trailing dismissal -> quiet.
    expect(classifyReviewTrigger([r(4, 'CHANGES_REQUESTED', 'k-owner'), r(5, 'DISMISSED', 'k-owner')], 4).reissueDue).toBe(false);
  });

  it('ghPaginated exhausts pages (oldest-first API — the newest item lives on the LAST page) and fails CLOSED', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const page2 = [{ id: 999 }];
    const paths: string[] = [];
    const transport: GithubTransport = {
      async request(_m, path) {
        paths.push(path);
        if (path.endsWith('&page=1')) return { status: 200, body: page1 };
        if (path.endsWith('&page=2')) return { status: 200, body: page2 };
        return { status: 500, body: null };
      },
    };
    const items = (await ghPaginated(transport, '/repos/o/r/pulls/12/reviews')) as Array<{ id: number }>;
    expect(items.length).toBe(101);
    expect(items[items.length - 1].id).toBe(999); // the newest item WAS seen
    expect(paths).toEqual([
      '/repos/o/r/pulls/12/reviews?per_page=100&page=1',
      '/repos/o/r/pulls/12/reviews?per_page=100&page=2',
    ]);
    // Fail-closed: a non-200 mid-pagination THROWS (never reads as "no items").
    const flaky: GithubTransport = {
      async request(_m, path) {
        if (path.endsWith('&page=1')) return { status: 200, body: page1 };
        return { status: 502, body: null };
      },
    };
    await expect(ghPaginated(flaky, '/repos/o/r/pulls/12/reviews')).rejects.toThrow(/HTTP 502/);
  });
});

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

  it('ERR06 (#64): a subset sibling SUPERSEDED by a reopen is NOT a duplicate of the fresh superset case', async () => {
    // The live #64 shape: module/x emits a subset case (p1, "h169", topmost by
    // journal order), its parent resolves → x is reopened → a fresh SUPERSET
    // case (p1+p2, "h180") is emitted. The superset's conflict blob on the
    // SHARED path (p1) is byte-identical to the subset's, so absent supersession
    // duplicateCaseIssue fires ERR06 pointing at the (earlier) subset — a case
    // next-case will never serve → infinite loop. The subset is dead; skip it.
    const repo = initFixtureRepo();
    repo.commit('base', { 'src/p1.ts': 'orig\n', 'src/p2.ts': 'orig\n' });
    repo.checkout('module/x', { create: true, at: 'main' });
    repo.commit('x fork edit p1+p2', { 'src/p1.ts': 'fork1\n', 'src/p2.ts': 'fork2\n' });
    repo.checkout('main');
    // parent side: subHead rewrites p1 only; supHead = subHead + rewrite p2. Both
    // carry the SAME p1 content, so the p1 conflict blob matches across the two.
    repo.checkout('parent', { create: true, at: 'main' });
    repo.commit('sub: p1=up', { 'src/p1.ts': 'up1\n' });
    const subHead = repo.sha('parent');
    repo.commit('sup: +p2=up', { 'src/p2.ts': 'up2\n' });
    const supHead = repo.sha('parent');
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const cli = baseCli(repo, ws, writeInventory([{ id: 'x', branch: 'module/x', parents: ['parent'] }]));
    const mk = (rows: Array<Record<string, unknown>>): JournalEntry[] =>
      rows.map((e) => ({ ts: '', ...e }) as JournalEntry);
    // Subset case FIRST (earlier index = topmost), reopen, then the fresh superset.
    const journal = mk([
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-sub', head: { sha: subHead, height: 1 }, conflictedPaths: ['src/p1.ts'] },
      { action: 'reopened', branch: 'module/x' },
      { action: 'case', branch: 'module/x', parent: 'main_patched', caseId: 'x-sup', head: { sha: supHead, height: 2 }, conflictedPaths: ['src/p1.ts', 'src/p2.ts'] },
    ]);
    const self = journaledCases(journal).get('x-sup')!;
    // With the reopen: the subset is superseded → no ERR06 on the fresh superset.
    expect(await duplicateCaseIssue(cli, journal, journaledCases(journal), self)).toBeNull();
    // Control: WITHOUT the reopen the subset is a live sibling and the fixture
    // genuinely IS a signature match — proving the assertion above tests the
    // supersession, not a fixture that simply fails to match.
    const noReopen = journal.filter((e) => e.action !== 'reopened');
    const dup = await duplicateCaseIssue(cli, noReopen, journaledCases(noReopen), journaledCases(noReopen).get('x-sup')!);
    expect(dup?.id).toBe('ERR06_DUPLICATE_CASE');
    expect(dup!.detail).toContain('x-sub');
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
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const topmost = currentCaseId(dir); // served first = topmost by DAG order
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'held', execute: true }), neverInvoked),
    ).toBe(0);

    // The topmost case itself gets NO ERR06 (it is the one that publishes) — it
    // is blocked on its missing PR text only. Asserted BEFORE the text is written.
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId: topmost, out }))).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR06_DUPLICATE_CASE')).toBe(false);
    expect(readOut(out).issues.some((i) => i.id === 'ERR08_TEXT_MISSING')).toBe(true);

    // Clear awaiting-pr so the twin can be served, then serve it.
    writeText(join(dir, topmost, 'pr'), GOOD_TITLE, GOOD_BODY);
    expect(await cmdSweepReportPr(cli({ cmd: 'report-pr', execute: true }), neverInvoked)).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const duplicate = currentCaseId(dir);
    expect(duplicate).not.toBe(topmost);

    // The twin IS a duplicate, asserted on the very checker publish's battery
    // calls — same id, and it names the topmost case. (Publish can no longer
    // SURFACE this itself: report-case consolidates the twin before it can hold
    // a publishable disposition — see the assertions below.)
    const jnow = readJournal(dir);
    const cases = journaledCases(jnow);
    const dup = await duplicateCaseIssue(cli({ cmd: 'publish' }), jnow, cases, cases.get(duplicate)!);
    expect(dup?.id).toBe('ERR06_DUPLICATE_CASE');
    expect(dup!.detail).toContain(topmost); // names the topmost case
    // The topmost is NOT a duplicate of the twin (it is the one that publishes).
    expect(await duplicateCaseIssue(cli({ cmd: 'publish' }), jnow, cases, cases.get(topmost)!)).toBeNull();

    // …and the machine ACTS on it: the twin consolidates into the held topmost
    // and inherits its PR, so it never opens a second one.
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'held', execute: true }), neverInvoked),
    ).toBe(0);
    expect(readJournal(dir).find((e) => e.action === 'held-duplicate' && e.caseId === duplicate)!.duplicateOf).toBe(
      topmost,
    );
    expect(await cmdPublish(cli({ cmd: 'publish', caseId: duplicate, out }))).toBe(1); // no PR of its own
  });

  it('ERR06 subset (D-050): a 6-path case whose set is a subset of a 7-path sibling with matching blobs is a duplicate', async () => {
    // The missed #60 shape: feat/a carries the fork edit on SEVEN files,
    // feat/b the SAME edit on six of them — b's conflicted set is a strict
    // subset of a's and the shared conflict blobs are byte-identical.
    const paths = Array.from({ length: 7 }, (_, i) => `src/f${i + 1}.ts`);
    const files = (content: string, n: number): Record<string, string> =>
      Object.fromEntries(paths.slice(0, n).map((p) => [p, `${content}\n`]));
    const repo = initFixtureRepo();
    repo.commit('base', files('orig', 7));
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: rewrite all 7', files('mp', 7));
    repo.checkout('main');
    repo.checkout('feat/a', { create: true, at: 'main' });
    repo.commit('a: fork edit on 7', files('fork', 7));
    repo.checkout('main');
    repo.checkout('feat/b', { create: true, at: 'main' });
    repo.commit('b: same fork edit on 6', files('fork', 6));
    repo.checkout('main');
    cleanups.push(() => repo.destroy());

    const ws = mkWorkspace();
    const inv = writeInventory([
      { id: 'a', branch: 'feat/a', parents: ['main_patched'] },
      { id: 'b', branch: 'feat/b', parents: ['main_patched'] },
    ]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const topmost = currentCaseId(dir); // feat/a — the 7-path superset, served first
    const topRow = readJournal(dir).find((e) => e.action === 'case' && e.caseId === topmost)!;
    expect(topRow.branch).toBe('feat/a');
    expect((topRow.conflictedPaths as string[]).length).toBe(7);
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'held', execute: true }), neverInvoked),
    ).toBe(0);

    // The topmost (superset) case itself gets NO ERR06 — blocked on text only.
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId: topmost, out }))).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR06_DUPLICATE_CASE')).toBe(false);
    expect(readOut(out).issues.some((i) => i.id === 'ERR08_TEXT_MISSING')).toBe(true);

    writeText(join(dir, topmost, 'pr'), GOOD_TITLE, GOOD_BODY);
    expect(await cmdSweepReportPr(cli({ cmd: 'report-pr', execute: true }), neverInvoked)).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const subset = currentCaseId(dir);
    const subRow = readJournal(dir).find((e) => e.action === 'case' && e.caseId === subset)!;
    expect(subRow.branch).toBe('feat/b');
    expect((subRow.conflictedPaths as string[]).length).toBe(6); // strict subset

    // The 6-path subset is a duplicate of the 7-path superset — asserted on the
    // checker publish's battery calls (publish cannot surface it itself: the twin
    // consolidates at report-case before it can hold a publishable disposition).
    const jnow = readJournal(dir);
    const cases = journaledCases(jnow);
    const dup = await duplicateCaseIssue(cli({ cmd: 'publish' }), jnow, cases, cases.get(subset)!);
    expect(dup?.id).toBe('ERR06_DUPLICATE_CASE');
    expect(dup!.detail).toContain(topmost); // still names the topmost case
    // The topmost (superset) case itself is NOT a duplicate of the subset.
    expect(await duplicateCaseIssue(cli({ cmd: 'publish' }), jnow, cases, cases.get(topmost)!)).toBeNull();

    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'held', execute: true }), neverInvoked),
    ).toBe(0);
    expect(readJournal(dir).find((e) => e.action === 'held-duplicate' && e.caseId === subset)!.duplicateOf).toBe(
      topmost,
    );
    expect(await cmdPublish(cli({ cmd: 'publish', caseId: subset, out }))).toBe(1); // no PR of its own
  });

  it('ERR07: a journaled pr-published entry for the case blocks a second publish', async () => {
    const { ws, dir, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    appendFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        action: 'pr-published',
        caseId,
        url: 'https://github.com/k-fls/fixture/pull/7',
        number: 7,
      }) + '\n',
    );
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR07_PR_EXISTS');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('#7');
  });

  it('ERR08 (text missing); with text present the checks are MECHANICAL only — no reader loop, no prtext artifacts (D-050)', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR08_TEXT_MISSING')).toBe(true);

    // Text present -> straight to green (dry-run): the retired PR-text cold
    // read never fires and no prtext request/verdict artifact is written.
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.issues.every((i) => !i.id.includes('COLDREAD'))).toBe(true);
    expect(existsSync(join(prDir, 'prtext-review-request.md'))).toBe(false);
  });

  it('WARN01/WARN02 are advisory: a template-ish body still publishes (dry-run ok:true)', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    const title = 'sweep freeze h1';
    const body = 'This PR was prepared by the sweep.\n\nNo further detail.';
    writeText(prDir, title, body);
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.issues.some((i) => i.id === 'WARN01_TEMPLATE_TEXT')).toBe(true);
    expect(res.issues.some((i) => i.id === 'WARN02_NO_DECISION_LINE')).toBe(true);
    expect(res.issues.every((i) => !isBlocking(i.id))).toBe(true);
  });

  it("the WRONG template is named as such: the contribution guide's markers trip WARN01", async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    // Verbatim shape of the repo's contribution template — what PR #61 was
    // written from. It says nothing about a merge, so it must not pass silently.
    const body = [
      '<!-- contributing-guide: v1 -->',
      '## Type of Change',
      '',
      '- [ ] **Feature skill** - adds a channel or integration',
      '- [x] **Fix** - bug fix or security fix to source code',
      '',
      '## Description',
      '',
      'Resolves the conflict in src/x.ts.',
      '',
      '## For Skills',
      '',
      '- [ ] I tested this skill on a fresh clone',
    ].join('\n');
    writeText(prDir, 'sweep freeze h1', body);
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(0);
    const res = readOut(out);
    const warn = res.issues.find((i) => i.id === 'WARN01_TEMPLATE_TEXT');
    expect(warn).toBeDefined();
    // The detail must say WHICH mistake was made — "rewrite from the materials"
    // is the generic advice and would not tell the agent it used the wrong file.
    expect(warn!.detail).toContain('WRONG template');
    expect(warn!.detail).toContain('pr/TEMPLATE.md');
  });

  it('ERR11: --execute without a token file blocks before any network call', async () => {
    const { ws, caseId, prDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, out }), gh.factory)).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR11_TOKEN_MISSING')).toBe(true);
    expect(gh.factories).toBe(0);
    expect(gh.calls.length).toBe(0);
  });
});

// --- cmdPublish: dry-run purity + execute happy path -------------------------

describe('propagate publish — dry-run makes no pushes/network; execute pushes the ref + creates the PR (D-049)', () => {
  it('dry-run: full battery green, pristine-conflict draft head reported, transport never constructed, nothing pushed', async () => {
    const { repo, ws, dir, caseId, prDir, bareDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.issues).toEqual([]);
    // No marker-clean resolution exists (--tier held on an untouched worktree) →
    // the DRAFT head is the PRISTINE CONFLICT (D-057): clean-prefix commit on the
    // branch tip + a conflict commit whose tree is the automerge tree (markers, no
    // agent edits), parented on the case head so the owner's merge completes PR_ID.
    const caseHead = (readJournal(dir).find((e) => e.action === 'case')!.head as { sha: string }).sha;
    const head = res.head!.commit;
    expect(res.head!.mode).toBe('held');
    expect(repo.git('rev-parse', `${head}^2`)).toBe(caseHead); // 2nd parent = the conflict head
    expect(repo.git('rev-parse', `${head}^1^`)).toBe(repo.sha('main_patched')); // prefix sits on the tip
    expect(repo.git('show', `${head}:src/x.ts`)).toContain('<<<<<<<'); // markers re-materialized
    expect(res.wouldCreate!.fixBranch).toMatch(/^fix\/sweep\//);
    expect(res.wouldCreate!.draft).toBe(true);
    expect(gh.factories).toBe(0); // NO network calls of any kind on dry-run
    expect(gh.calls.length).toBe(0);
    // NO pushes on dry-run: the bare origin has no fix/sweep ref.
    expect(repo.git('-C', bareDir, 'for-each-ref', 'refs/heads/fix')).toBe('');
  });

  it('execute: git push of the fix/sweep ref at the pristine-conflict head, then POST /pulls (draft, machine block); journaled (no ledger writes, D-058)', async () => {
    const { repo, ws, dir, caseId, prDir, bareDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.pr).toEqual({ url: 'https://github.com/k-fls/fixture/pull/58', number: 58 });

    // API sequence: ERR07 probe + POST /pulls + the D-059 sweep-addressed
    // marker comment — no ref/commit fabrication (D-049 §5).
    const paths = gh.calls.map((c) => c.path);
    expect(paths[0]).toContain('/repos/k-fls/fixture/pulls?head=k-fls%3Afix%2Fsweep%2F'); // ERR07 API probe
    expect(paths.some((p) => p.includes('/git/'))).toBe(false);
    expect(gh.calls.length).toBe(3);
    const markerCall = gh.calls.find((c) => c.method === 'POST' && c.path.includes('/issues/58/comments'))!;
    expect(String((markerCall.body as { body: string }).body)).toContain('<!-- sweep-addressed: 0 -->');
    const prCall = gh.calls.find((c) => c.path.endsWith('/pulls') && c.method === 'POST')!;
    expect((prCall.body as { draft: boolean }).draft).toBe(true); // HELD = draft
    expect((prCall.body as { base: string }).base).toBe('main_patched');
    expect((prCall.body as { title: string }).title).toBe(GOOD_TITLE);
    // D-004 machine block appended below the agent's body.
    const sentBody = (prCall.body as { body: string }).body;
    expect(sentBody).toContain(GOOD_BODY.split('\n')[0]);
    expect(sentBody).toContain(MACHINE_BLOCK_BEGIN);
    expect(sentBody.indexOf(MACHINE_BLOCK_BEGIN)).toBeGreaterThan(sentBody.indexOf('Decision needed'));

    // The ref was REALLY pushed (git push into the bare origin) at the DRAFT
    // pristine-conflict head (D-057: clean prefix + re-materialized conflict,
    // 2nd parent = the case head so the owner's merge completes PR_ID).
    const published = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(published.caseId).toBe(caseId);
    expect(published.number).toBe(58);
    expect(published.draft).toBe(true);
    const fixBranch = published.fixBranch as string;
    expect(fixBranch).toMatch(/^fix\/sweep\//);
    const caseHead = (readJournal(dir).find((e) => e.action === 'case')!.head as { sha: string }).sha;
    const pushedHead = published.head as string;
    expect(repo.git('rev-parse', `${pushedHead}^2`)).toBe(caseHead);
    expect(repo.git('show', `${pushedHead}:src/x.ts`)).toContain('<<<<<<<'); // pristine markers, no agent edits
    expect(repo.git('-C', bareDir, 'rev-parse', `refs/heads/${fixBranch}`)).toBe(pushedHead);
    // Journaled driver push (rule 3 as amended: the only pushes).
    expect(readJournal(dir).some((e) => e.action === 'push' && e.branch === fixBranch && e.kind === 'pr-head')).toBe(
      true,
    );
    // Local anchor; the pr-published journal row (not the ledger, D-058)
    // carries the fix branch + PR number the pass's blocked view enriches
    // urge targets from — the ledger is never written.
    expect(repo.sha(fixBranch)).toBe(pushedHead);
    expect(readLedger(join(ws, 'sweep-ledger.json')).branches['main_patched']?.merge_status ?? null).toBeNull();

    // A second publish of the same case is ERR07 (journal side), no network needed.
    const gh2 = fakeGithub();
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh2.factory)).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR07_PR_EXISTS')).toBe(true);
    expect(gh2.factories).toBe(0);
  });

  it('execute: an open PR found via the API by head branch name RECONCILES (crash-window heal, finding #1) — journals pr-published, creates no second PR, pushes nothing', async () => {
    // The PR exists API-side but the journal has NO pr-published row: the
    // crash window between a prior run's PR create and its journal append.
    const { repo, ws, dir, caseId, prDir, bareDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub({
      '/pulls?': { status: 200, body: [{ html_url: 'https://github.com/k-fls/fixture/pull/9', number: 9 }] },
    });
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);
    expect(res.pr).toEqual({ url: 'https://github.com/k-fls/fixture/pull/9', number: 9 });
    // Probe + the D-059 marker re-assert only — no SECOND PR created.
    expect(gh.calls.length).toBe(2);
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls')).length).toBe(0);
    const markerCall = gh.calls.find((c) => c.method === 'POST' && c.path.includes('/issues/9/comments'))!;
    expect(String((markerCall.body as { body: string }).body)).toContain('<!-- sweep-addressed: 0 -->');
    expect(repo.git('-C', bareDir, 'for-each-ref', 'refs/heads/fix')).toBe(''); // …and nothing pushed
    // The reconciling journal row has the normal pr-published shape.
    const row = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(row.caseId).toBe(caseId);
    expect(row.number).toBe(9);
    expect(row.url).toBe('https://github.com/k-fls/fixture/pull/9');
    expect(row.mode).toBe('held');
    expect(typeof row.fixBranch).toBe('string');
    expect(typeof row.head).toBe('string');
    expect(row.reconciled).toBe(true);
    // A retried publish now stops at the journal-side ERR07 — no network.
    const gh2 = fakeGithub();
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh2.factory)).toBe(1);
    expect(readOut(out).issues.some((i) => i.id === 'ERR07_PR_EXISTS')).toBe(true);
    expect(gh2.factories).toBe(0);
  });

  it('execute: a failing git push is ERR15 (journaled halt, D-046 case-2 report) and no PR is created', async () => {
    const { repo, ws, dir, caseId, prDir, bareDir, cli } = await setupHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    // Break the transport path DETERMINISTICALLY: the insteadOf rewrite now
    // points at a dead local path — never the real github.com.
    repo.breakOriginTransport(bareDir);
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(1);
    const issue = readOut(out).issues.find((i) => i.id === 'ERR15_PUSH_FAILED');
    expect(issue).toBeTruthy();
    expect(issue!.detail).toContain('D-046 case 2');
    expect(readJournal(dir).some((e) => e.action === 'halt' && e.id === 'ERR15_PUSH_FAILED')).toBe(true);
    expect(gh.calls.filter((c) => c.method === 'POST').length).toBe(0); // no PR created
  });
});

// --- D-057: unified HELD publish — ACTIVE (non-draft) PR for a marker-clean
// resolution, with the escalation prefix + reviewer feedback in the body ------

describe('propagate publish — unified HELD publish (D-057): marker-clean resolution -> ACTIVE PR', () => {
  it('execute: pushes the RESOLVED MERGE COMMIT and opens a NON-draft PR with the escalation prefix + feedback', async () => {
    const { repo, ws, dir, caseId, prDir, bareDir, resolvedTree, cli } = await setupEscalatedHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const res = readOut(out);
    expect(res.ok).toBe(true);

    // ACTIVE (non-draft) PR at the resolved merge commit — owner reviews & merges.
    const prCall = gh.calls.find((c) => c.path.endsWith('/pulls') && c.method === 'POST')!;
    expect((prCall.body as { draft: boolean }).draft).toBe(false);
    const published = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(published.draft).toBe(false);
    const head = published.head as string;
    expect(repo.git('rev-parse', `${head}^{tree}`)).toBe(resolvedTree); // the agent's resolution, verbatim
    const caseHead = (readJournal(dir).find((e) => e.action === 'case')!.head as { sha: string }).sha;
    expect(repo.git('rev-parse', `${head}^2`)).toBe(caseHead); // merging the PR completes PR_ID
    expect(repo.git('rev-parse', `${head}^1`)).toBe(repo.sha('main_patched'));
    expect(repo.git('-C', bareDir, 'rev-parse', `refs/heads/${published.fixBranch as string}`)).toBe(head);

    // Escalation prefix + the cold reviewer's feedback ride ABOVE the agent prose;
    // the D-004 machine block still trails it.
    const sentBody = (prCall.body as { body: string }).body;
    expect(sentBody.startsWith('[AUTO-ESCALATED: scope exceeded]')).toBe(true);
    expect(sentBody).toContain('src/extra.ts');
    expect(sentBody.indexOf('[AUTO-ESCALATED')).toBeLessThan(sentBody.indexOf('Decision needed'));
    expect(sentBody).toContain(MACHINE_BLOCK_BEGIN);
  });

  it('re-running publishHead is deterministic: the rebuilt head sha is identical (retried push stays a no-op)', async () => {
    const { ws, caseId, prDir, cli } = await setupEscalatedHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }), fakeGithub().factory)).toBe(0);
    const head1 = readOut(out).head!.commit;
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }), fakeGithub().factory)).toBe(0);
    expect(readOut(out).head!.commit).toBe(head1);
  });

  it('MOVED TIP: a post-freeze commit on the branch is preserved — the frozen resolution is re-merged, never shipped stale', async () => {
    const { repo, ws, caseId, prDir, cli } = await setupEscalatedHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    // The branch tip advances AFTER the freeze (origin-sync-like commit
    // touching a NON-conflicted file) — building the ACTIVE PR from the
    // freeze-time resolution tree would silently revert it.
    repo.checkout('main_patched');
    repo.commit('sync: other file', { 'src/other.ts': 'synced\n' });
    repo.checkout('main');
    repo.git('push', 'origin', 'main_patched'); // origin current -> ERR14 passes
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }), fakeGithub().factory)).toBe(0);
    const res = readOut(out);
    expect(res.wouldCreate!.draft).toBe(false); // still the ACTIVE resolution PR
    const head = res.head!.commit;
    expect(repo.git('rev-parse', `${head}^1`)).toBe(repo.sha('main_patched')); // first parent = CURRENT tip
    expect(repo.git('show', `${head}:src/x.ts`)).toBe('RESOLVED');
    expect(repo.git('show', `${head}:src/extra.ts`)).toBe('sneaky');
    // The post-freeze commit SURVIVES in the shipped tree.
    expect(repo.git('show', `${head}:src/other.ts`)).toBe('synced');
  });

  it('MOVED TIP that conflicts with the frozen resolution degrades to the pristine-conflict DRAFT with a journaled warning', async () => {
    const { repo, ws, dir, caseId, prDir, cli } = await setupEscalatedHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    // The post-freeze commit rewrites the conflicted file itself -> the frozen
    // resolution no longer re-merges cleanly onto the moved tip.
    repo.checkout('main_patched');
    repo.commit('local: x moved again', { 'src/x.ts': 'fork2\n' });
    repo.checkout('main');
    repo.git('push', 'origin', 'main_patched');
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const published = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(published.draft).toBe(true); // NOT the stale ACTIVE tree
    expect(repo.git('show', `${published.head as string}:src/x.ts`)).toContain('<<<<<<<');
    const warn = readJournal(dir).find((e) => e.action === 'resolution-degraded' && e.caseId === caseId);
    expect(warn).toBeTruthy();
    expect(warn!.id).toBe('WARN07_RESOLUTION_TIP_MOVED');
  });

  it("a missing (GC'd) resolution tree degrades to the DRAFT with a journaled warning — never silently", async () => {
    const { ws, dir, caseId, prDir, cli } = await setupEscalatedHeldCase();
    writeText(prDir, GOOD_TITLE, GOOD_BODY);
    // Simulate the GC: point the recorded resolution tree at a nonexistent OID.
    const journalPath = join(dir, 'journal.jsonl');
    const rewritten = readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const e = JSON.parse(line) as { action?: string; caseId?: string; resolution?: { tree: string } };
        if (e.action === 'held' && e.caseId === caseId && e.resolution) {
          e.resolution.tree = '0123456789abcdef0123456789abcdef01234567';
        }
        return JSON.stringify(e);
      })
      .join('\n');
    writeFileSync(journalPath, rewritten + '\n');
    const tokenFile = join(ws, 'token.txt');
    writeFileSync(tokenFile, 'substitute-token\n');
    const gh = fakeGithub();
    const out = join(ws, 'out.json');
    expect(await cmdPublish(cli({ cmd: 'publish', caseId, execute: true, tokenFile, out }), gh.factory)).toBe(0);
    const published = readJournal(dir).find((e) => e.action === 'pr-published')!;
    expect(published.draft).toBe(true);
    const warn = readJournal(dir).find((e) => e.action === 'resolution-degraded' && e.caseId === caseId);
    expect(warn).toBeTruthy();
    expect(warn!.id).toBe('WARN06_RESOLUTION_TREE_MISSING');
  });
});

// --- D-057 review fix: deterministic fix-branch naming ------------------------

describe('propagate publish — fixBranchName is wall-clock independent', () => {
  it('a JUDGED publish retried days later computes the SAME fix branch (no orphan ref)', async () => {
    const repo = initFixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp: x = fork', { 'src/x.ts': 'fork\n' });
    repo.checkout('main');
    repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' });
    // Pre-pass tip on origin, and NEVER pushed again: JUDGED ERR14 requires that
    // origin does NOT yet contain the merge commit.
    repo.attachBareOrigin();
    repo.git('push', 'origin', 'main_patched');
    cleanups.push(() => repo.destroy());
    const ws = mkWorkspace();
    const inv = emptyInventory();
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);
    expect(await cmdSweepStart(cli({ cmd: 'sweep-start' }))).toBe(0);
    expect(await cmdSweepNextCase(cli({ cmd: 'next-case' }))).toBe(0);
    const caseId = currentCaseId(dir);
    resolveWorktree(dir, caseId, { 'src/x.ts': 'RESOLVED\n' });
    expect(
      await cmdSweepReportCase(cli({ cmd: 'report-case', tier: 'judged', execute: true }), confirm),
    ).toBe(0);
    // JUDGED merges at report-pr (D-060), which is where the merge commit publish
    // uses as the PR head comes from.
    writeText(join(dir, caseId, 'pr'), GOOD_TITLE, GOOD_BODY);
    expect(await cmdSweepReportPr(cli({ cmd: 'report-pr', execute: true }), neverInvoked)).toBe(0);
    const out = join(ws, 'out.json');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-23T12:00:00Z'));
      expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(0);
      const first = readOut(out).wouldCreate!.fixBranch;
      expect(first).toMatch(/^fix\/sweep\//);
      vi.setSystemTime(new Date('2026-07-25T12:00:00Z')); // the retry, two days later
      expect(await cmdPublish(cli({ cmd: 'publish', caseId, out }))).toBe(0);
      expect(readOut(out).wouldCreate!.fixBranch).toBe(first); // SAME name -> no orphan ref
    } finally {
      vi.useRealTimers();
    }
  });
});
