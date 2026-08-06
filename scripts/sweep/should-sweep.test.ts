/**
 * scripts/sweep/should-sweep.test.ts — the timer wake probe.
 *
 * Two properties carry the whole design and every test guards one of them:
 *  1. the probe never wakes for a pass that could only stop again (the
 *     wrong-wake direction burns an agent session), and
 *  2. the probe performs ZERO writes — no journal, no pass dir, no git refs,
 *     no non-GET GitHub calls (a probe with side effects is a bug by contract).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { GithubTransport, PrByHead, PrComment, PrReview } from './publish.js';
import { appendJournal, type Cli } from './propagate.js';
import {
  branchesReceivingUpstream,
  classifyPrs,
  fixSweepRefs,
  openPassInfo,
  openPrReviewDisposition,
  probeShouldSweep,
  renderContractLine,
  type ProbeDeps,
  type ScopeLiteEntry,
} from './should-sweep.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'should-sweep-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openPassAt(workspace: string, wm12: string): string {
  const dir = join(workspace, 'propagation', `pass-${wm12}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan-initial.json'), JSON.stringify({ watermark12: wm12 }));
  appendJournal(dir, { action: 'sweep-start', watermark: wm12 });
  return dir;
}

function completedPassAt(workspace: string, wm12: string): string {
  const dir = openPassAt(workspace, wm12);
  appendJournal(dir, { action: 'pass-complete', watermark: wm12 });
  return dir;
}

function review(id: number, state: string, author = 'owner'): PrReview {
  return { id, state, body: '', author, submittedAt: '2026-08-01T00:00:00Z' };
}

function comment(id: number, body: string): PrComment {
  return { id, body, author: 'x', createdAt: '2026-08-01T00:00:00Z' };
}

function pr(number: number, state: string, mergedAt: string | null = null): PrByHead {
  return { number, url: `https://github.com/o/r/pull/${number}`, state, mergedAt, body: '', createdAt: '' };
}

/** RAW GitHub API shape for fake-transport routes (getPrsByHead maps merged_at etc. itself). */
function rawPr(number: number, state: string, mergedAt: string | null = null): Record<string, unknown> {
  return {
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    state,
    merged_at: mergedAt,
    body: '',
    created_at: '',
  };
}

interface FakeGithub {
  transport: GithubTransport;
  /** Every request made, so tests can assert the GET-only invariant. */
  calls: Array<{ method: string; path: string }>;
}

function fakeGithub(routes: Record<string, unknown>): FakeGithub {
  const calls: Array<{ method: string; path: string }> = [];
  return {
    calls,
    transport: {
      async request(method, path) {
        calls.push({ method, path });
        const key = Object.keys(routes).find((k) => path.startsWith(k));
        if (key === undefined) return { status: 200, body: [] };
        return { status: 200, body: routes[key] };
      },
    },
  };
}

const UP_TIP = 'aaaabbbbccccdddd0000111122223333444455556666'.slice(0, 40);

function makeCli(workspace: string, over: Partial<Cli> = {}): Cli {
  return {
    cmd: 'should-sweep',
    repo: join(workspace, 'repo'),
    workspace,
    upstream: 'upstream/main',
    execute: true,
    ...over,
  };
}

function makeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps & { scopeCalls: number[] } {
  const scopeCalls: number[] = [];
  const deps: ProbeDeps & { scopeCalls: number[] } = {
    scopeCalls,
    async lsRemoteHeads(_repo, remote) {
      if (remote === 'origin') return new Map([['main', 'f'.repeat(40)]]);
      return new Map([['main', UP_TIP]]);
    },
    async originSlug() {
      return { owner: 'o', repo: 'r' };
    },
    makeTransport: () => fakeGithub({}).transport,
    async resolveScopeLite() {
      scopeCalls.push(1);
      return [
        { branch: 'main_patched', mergeModel: 'upstream-chain', parents: [] },
        { branch: 'feat/a', mergeModel: 'parents', parents: ['main_patched'] },
      ];
    },
    env: { GH_TOKEN: 'tok' },
    now: Date.now,
    ...over,
  };
  return deps;
}

// ---------------------------------------------------------------------------
// fixSweepRefs — ref → target-branch recovery.
// ---------------------------------------------------------------------------

describe('fixSweepRefs', () => {
  it('maps gate refs to their target branch by slug prefix', () => {
    const refs = fixSweepRefs(
      new Map([
        ['main_patched', 'a'.repeat(40)],
        ['module/agent-group-contributions', 'b'.repeat(40)],
        ['fix/sweep/main_patched--gate-fix-main_patched-65026160', 'c'.repeat(40)],
        ['fix/sweep/module__agent-group-contributions--gate-fix-x', 'd'.repeat(40)],
      ]),
    );
    expect(refs.map((r) => r.branch).sort()).toEqual(['main_patched', 'module/agent-group-contributions']);
  });

  it('prefers the LONGEST slug when one branch name is a prefix of another (names may contain --)', () => {
    const refs = fixSweepRefs(
      new Map([
        ['feat/x', 'a'.repeat(40)],
        ['feat/x--y', 'b'.repeat(40)],
        ['fix/sweep/feat__x--y--case-1', 'c'.repeat(40)],
      ]),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].branch).toBe('feat/x--y');
  });

  it('ignores branches that merely CONTAIN fix/sweep (live: feat/fix/sweep-d062), and null-targets unknown refs', () => {
    const refs = fixSweepRefs(
      new Map([
        ['feat/fix/sweep-d062', 'a'.repeat(40)],
        ['fix/sweep/no__such__branch--case-1', 'b'.repeat(40)],
      ]),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ ref: 'fix/sweep/no__such__branch--case-1', branch: null });
  });
});

// ---------------------------------------------------------------------------
// PR-state classification.
// ---------------------------------------------------------------------------

describe('classifyPrs', () => {
  it('open beats merged beats closed (mirrors deriveOriginMergeStatus order)', () => {
    const both = classifyPrs([pr(2, 'closed', '2026-08-01'), pr(3, 'open')]);
    expect(both.open?.number).toBe(3);
    expect(classifyPrs([pr(2, 'closed', '2026-08-01')]).merged?.number).toBe(2);
    const closedOnly = classifyPrs([pr(4, 'closed')]);
    expect(closedOnly.merged).toBeNull();
    expect(closedOnly.closed?.number).toBe(4);
    expect(classifyPrs([])).toEqual({ open: null, merged: null, closed: null });
  });
});

describe('openPrReviewDisposition', () => {
  it('no reviews → gated (an open owner PR with nothing new must NOT wake)', () => {
    expect(openPrReviewDisposition(1, [], [])).toEqual({ kind: 'gated' });
  });

  it('a review beyond the marker → review-due with its state', () => {
    expect(openPrReviewDisposition(1, [review(10, 'CHANGES_REQUESTED')], [])).toEqual({
      kind: 'review-due',
      prNumber: 1,
      reviewState: 'CHANGES_REQUESTED',
    });
    expect(openPrReviewDisposition(1, [review(10, 'APPROVED')], []).kind).toBe('review-due');
  });

  it('marker at the latest review id → gated (already addressed)', () => {
    const d = openPrReviewDisposition(1, [review(10, 'COMMENTED')], [comment(1, '<!-- sweep-addressed: 10 -->')]);
    expect(d).toEqual({ kind: 'gated' });
  });

  it('a pasted marker ABOVE the max real review id is ignored (finding-4 bound) → still review-due', () => {
    const d = openPrReviewDisposition(1, [review(10, 'COMMENTED')], [comment(1, '<!-- sweep-addressed: 999999 -->')]);
    expect(d.kind).toBe('review-due');
  });

  it('bot and DISMISSED reviews never wake', () => {
    expect(openPrReviewDisposition(1, [review(10, 'APPROVED', 'copilot[bot]')], []).kind).toBe('gated');
    expect(openPrReviewDisposition(1, [review(10, 'DISMISSED')], []).kind).toBe('gated');
  });
});

// ---------------------------------------------------------------------------
// Upstream reachability — THE negative case.
// ---------------------------------------------------------------------------

describe('branchesReceivingUpstream', () => {
  const scope: ScopeLiteEntry[] = [
    { branch: 'main_patched', mergeModel: 'upstream-chain', parents: [] },
    { branch: 'fix/standalone', mergeModel: 'upstream-chain', parents: [] },
    { branch: 'feat/a', mergeModel: 'parents', parents: ['main_patched'] },
    { branch: 'feat/b', mergeModel: 'parents', parents: ['feat/a'] },
  ];

  it('ungated entries receive, and content flows only through ungated parents', () => {
    expect(branchesReceivingUpstream(scope, new Set()).sort()).toEqual([
      'feat/a',
      'feat/b',
      'fix/standalone',
      'main_patched',
    ]);
    // Gating feat/a starves feat/b but not the entries.
    expect(branchesReceivingUpstream(scope, new Set(['feat/a'])).sort()).toEqual(['fix/standalone', 'main_patched']);
  });

  it('gating main_patched starves its whole subtree; an independent upstream-chain entry still receives', () => {
    expect(branchesReceivingUpstream(scope, new Set(['main_patched'])).sort()).toEqual(['fix/standalone']);
  });

  it('every entry gated → NOTHING receives (a pass could only stop again)', () => {
    expect(branchesReceivingUpstream(scope, new Set(['main_patched', 'fix/standalone']))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// probeShouldSweep — the assembled decision (injected deps, temp workspace).
// ---------------------------------------------------------------------------

describe('probeShouldSweep', () => {
  it('wakes to RESUME an open pass, before any network read', async () => {
    const ws = tempWorkspace();
    const dir = openPassAt(ws, 'abcabcabcabc');
    writeFileSync(
      join(dir, 'machine-state.json'),
      JSON.stringify({ phase: 'case-ready', currentCase: { caseId: 'c-1' } }),
    );
    let networkCalls = 0;
    const deps = makeDeps({
      async lsRemoteHeads() {
        networkCalls++;
        return new Map();
      },
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d.wakeAgent).toBe(true);
    expect(d.data?.reason).toContain('in-flight');
    expect(d.data?.reason).toContain('case-ready');
    expect(networkCalls).toBe(0);
  });

  it('stays silent when the upstream tip already has a completed pass and no gate moved', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    const deps = makeDeps();
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d).toEqual({ wakeAgent: false });
    expect(deps.scopeCalls).toHaveLength(0); // no elective scope spend when there is nothing to decide
  });

  it('wakes on an unswept upstream tip when an entry path is open, naming the receiving branches', async () => {
    const ws = tempWorkspace();
    const d = await probeShouldSweep(makeCli(ws), makeDeps());
    expect(d.wakeAgent).toBe(true);
    expect(d.data?.reason).toContain('upstream advanced');
    expect(d.data?.reason).toContain('main_patched');
  });

  it('does NOT wake on upstream advance when EVERY entry path is gated (open PRs, nothing new)', async () => {
    const ws = tempWorkspace();
    const gh = fakeGithub({
      '/repos/o/r/pulls?head=': [rawPr(7, 'open')],
      '/repos/o/r/pulls/7/reviews': [],
      '/repos/o/r/issues/7/comments': [],
    });
    const deps = makeDeps({
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['fix/sweep/main_patched--gate-fix-main_patched-1', 'b'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => gh.transport,
      async resolveScopeLite() {
        return [{ branch: 'main_patched', mergeModel: 'upstream-chain', parents: [] }];
      },
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d).toEqual({ wakeAgent: false });
    expect(gh.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('wakes when a gate PR was MERGED (the branch is now clear), even with upstream already swept', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    const gh = fakeGithub({ '/repos/o/r/pulls?head=': [rawPr(9, 'closed', '2026-08-05T00:00:00Z')] });
    const deps = makeDeps({
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['fix/sweep/main_patched--gate-fix-main_patched-1', 'b'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => gh.transport,
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d.wakeAgent).toBe(true);
    expect(d.data?.signals.join(' ')).toContain('gate cleared: PR #9');
  });

  it('wakes on owner-closed (withdrawn) and on ref-without-PR (crashed publish)', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    const gh = fakeGithub({
      '/repos/o/r/pulls?head=o%3Afix%2Fsweep%2Fmain_patched--a': [rawPr(4, 'closed')],
      '/repos/o/r/pulls?head=o%3Afix%2Fsweep%2Ffeat__a--b': [],
    });
    const deps = makeDeps({
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['feat/a', 'e'.repeat(40)],
            ['fix/sweep/main_patched--a', 'b'.repeat(40)],
            ['fix/sweep/feat__a--b', 'c'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => gh.transport,
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d.wakeAgent).toBe(true);
    const all = d.data!.signals.join('\n');
    expect(all).toContain('case withdrawn: PR #4');
    expect(all).toContain('crashed publish: fix/sweep/feat__a--b');
  });

  it('wakes on a new review on an open gate PR', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    const gh = fakeGithub({
      '/repos/o/r/pulls?head=': [rawPr(5, 'open')],
      '/repos/o/r/pulls/5/reviews': [
        { id: 42, state: 'CHANGES_REQUESTED', body: 'fix it', user: { login: 'owner' }, submitted_at: 'x' },
      ],
      '/repos/o/r/issues/5/comments': [],
    });
    const deps = makeDeps({
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['fix/sweep/main_patched--a', 'b'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => gh.transport,
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d.wakeAgent).toBe(true);
    expect(d.data?.signals.join(' ')).toContain('CHANGES_REQUESTED');
  });

  it('fails CLOSED without a token: unclassifiable refs gate their branches instead of waking', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    let transportUsed = false;
    const deps = makeDeps({
      env: {},
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['fix/sweep/main_patched--a', 'b'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => {
        transportUsed = true;
        return fakeGithub({}).transport;
      },
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d).toEqual({ wakeAgent: false });
    expect(transportUsed).toBe(false);
  });

  it('treats an API failure on one ref as gated, not cleared', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    const deps = makeDeps({
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['fix/sweep/main_patched--a', 'b'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => ({
        async request() {
          return { status: 500, body: null };
        },
      }),
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d).toEqual({ wakeAgent: false });
  });

  it('cuts off the elective API loop at the soft budget, counting the rest as gated', async () => {
    const ws = tempWorkspace();
    completedPassAt(ws, UP_TIP.slice(0, 12));
    let t = 0;
    const gh = fakeGithub({ '/repos/o/r/pulls?head=': [rawPr(9, 'closed', '2026-08-05T00:00:00Z')] });
    const deps = makeDeps({
      // Clock starts past the budget: every ref must fall to the gated arm
      // WITHOUT a single transport call.
      now: () => (t += 30_000),
      async lsRemoteHeads(_repo, remote) {
        if (remote === 'origin')
          return new Map([
            ['main_patched', 'a'.repeat(40)],
            ['fix/sweep/main_patched--a', 'b'.repeat(40)],
          ]);
        return new Map([['main', UP_TIP]]);
      },
      makeTransport: () => gh.transport,
    });
    const d = await probeShouldSweep(makeCli(ws), deps);
    expect(d).toEqual({ wakeAgent: false });
    expect(gh.calls).toHaveLength(0);
  });

  it('writes NOTHING into the workspace', async () => {
    const ws = tempWorkspace();
    const before = readdirSync(ws);
    await probeShouldSweep(makeCli(ws), makeDeps());
    expect(readdirSync(ws)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// openPassInfo + contract line.
// ---------------------------------------------------------------------------

describe('openPassInfo', () => {
  it('a pass-complete row closes the pass (abort/finish/sealed all write it)', () => {
    const ws = tempWorkspace();
    completedPassAt(ws, 'abcabcabcabc');
    expect(openPassInfo(ws)).toBeNull();
  });

  it('a plan-initial without pass-complete is open even with no machine state', () => {
    const ws = tempWorkspace();
    openPassAt(ws, 'abcabcabcabc');
    expect(openPassInfo(ws)?.dir).toContain('pass-abcabcabcabc');
  });
});

describe('renderContractLine', () => {
  it('emits one line whose wakeAgent is a REAL boolean (the runner discards anything else)', () => {
    for (const decision of [{ wakeAgent: false }, { wakeAgent: true, data: { reason: 'r', signals: ['r'] } }]) {
      const line = renderContractLine(decision);
      expect(line).not.toContain('\n');
      const parsed = JSON.parse(line) as { wakeAgent: unknown; data?: { reason?: string } };
      expect(typeof parsed.wakeAgent).toBe('boolean');
      if (parsed.wakeAgent) expect(parsed.data?.reason).toBeTruthy();
    }
  });
});
