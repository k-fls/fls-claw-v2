/**
 * scripts/sweep/publish.test.ts — `propagate publish` (PROPAGATION.md §14,
 * D-048/D-049/D-050): the pre-PR height check + D-004 machine block, the
 * blocking/advisory check battery (text checks MECHANICAL only — the PR-text
 * cold read is retired, D-050), and the networked execute path — real
 * `git push` into a bare fixture origin, PR creation against an injected fake
 * transport (dry-run must make ZERO network calls and ZERO pushes).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
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
  duplicateCaseIssue,
  journaledCases,
  passDir,
  readJournal,
  type Cli,
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
});
