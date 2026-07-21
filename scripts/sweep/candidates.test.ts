/**
 * D-045 Feature B (PROPAGATION.md §13) — candidate discovery with inheritance
 * derivation: fixture DAGs for the evidence kinds, the confidence rule, the
 * urging-style report throttle, and the "inventory only with valid
 * inheritance" plan-time hard halt.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { candidateYamlPath, deriveCandidates, type CandidateRecord } from './candidates.js';
import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { enumerateChain } from './heights.js';
import { cmdPlan, cmdRun, passDir, readJournal, type Cli } from './propagate.js';
import type { FeatureEntry, PropagationPlan } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixtureRepo(): FixtureRepo {
  const repo = initFixtureRepo();
  cleanups.push(() => repo.destroy());
  return repo;
}

function mkWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'cand-ws-'));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

function entry(id: string, branch: string, parents?: string[]): FeatureEntry {
  return { id, name: id, kind: 'feat', status: 'shipped', branch, parents } as FeatureEntry;
}

async function derive(repo: FixtureRepo, base: string, features: FeatureEntry[]): Promise<CandidateRecord[]> {
  const chain = await enumerateChain(repo.dir, 'main', base);
  return deriveCandidates({ repo: repo.dir, chain, features, scope: {} });
}

describe('deriveCandidates — inheritance derivation (D-045)', () => {
  it('(i) clear: a candidate cut from an inventory branch derives that parent (cut-from evidence)', async () => {
    const repo = fixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main');
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp1: patch', { 'patch.txt': 'p\n' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('a1', { 'src/a.ts': 'a\n' });
    const a2 = repo.commit('a2', { 'src/a2.ts': 'a2\n' });
    repo.checkout('feat/cand', { create: true, at: 'feat/a' });
    repo.commit('c1: candidate work', { 'src/c.ts': 'c\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/u.ts': 'u\n' });

    const records = await derive(repo, base, [entry('a', 'feat/a', ['main_patched'])]);
    expect(records.map((r) => r.branch)).toEqual(['feat/cand']);
    const r = records[0];
    expect(r.confidence).toBe('clear');
    expect(r.openQuestions).toEqual([]);
    expect(r.forkPoint?.sha).toBe(a2);
    expect(r.proposedParents.map((p) => p.branch)).toEqual(['feat/a']);
    expect(r.proposedParents[0].evidence[0].kind).toBe('cut-from');
    expect(r.proposedParents[0].evidence[0].sha).toBe(a2);
    expect(r.proposedDescendants).toEqual([]);
    expect(r.changedFilesVs).toBe('feat/a');
    expect(r.changedFiles).toEqual(['src/c.ts']);
    expect(r.changedFilesTotal).toBe(1);
    expect(r.remoteOnly).toBe(false);
  });

  it('(i-b) a remote-only candidate is discovered from origin/*', async () => {
    const repo = fixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main');
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp1: patch', { 'patch.txt': 'p\n' });
    repo.checkout('feat/remote', { create: true, at: 'main_patched' });
    repo.commit('r1', { 'src/r.ts': 'r\n' });
    repo.checkout('main');
    repo.setOrigin('feat/remote');
    repo.deleteLocalBranch('feat/remote');

    const records = await derive(repo, base, []);
    expect(records.map((r) => r.branch)).toEqual(['feat/remote']);
    expect(records[0].remoteOnly).toBe(true);
    expect(records[0].proposedParents.map((p) => p.branch)).toEqual(['main_patched']);
    expect(records[0].confidence).toBe('clear');
  });

  it('(ii) a candidate merged INTO an existing branch is detected as its descendant (requiresEntryEdit)', async () => {
    const repo = fixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main');
    repo.checkout('main_patched', { create: true, at: 'main' });
    const mp1 = repo.commit('mp1: patch', { 'patch.txt': 'p\n' });
    repo.checkout('feat/lib', { create: true, at: 'main_patched' });
    const l1 = repo.commit('l1: lib work', { 'src/lib.ts': 'l\n' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('a1', { 'src/a.ts': 'a\n' });
    repo.git('merge', '--no-edit', 'feat/lib'); // candidate merged into the inventory branch
    repo.checkout('main');
    repo.commit('U0: util', { 'src/u.ts': 'u\n' });

    const records = await derive(repo, base, [entry('a', 'feat/a', ['main_patched'])]);
    expect(records.map((r) => r.branch)).toEqual(['feat/lib']);
    const r = records[0];
    expect(r.confidence).toBe('clear');
    expect(r.forkPoint?.sha).toBe(mp1);
    expect(r.proposedParents.map((p) => p.branch)).toEqual(['main_patched']);
    const desc = r.proposedDescendants.find((d) => d.branch === 'feat/a');
    expect(desc).toBeTruthy();
    expect(desc!.requiresEntryEdit).toBe(true);
    expect(desc!.evidence[0].kind).toBe('merged-into');
    expect(desc!.evidence[0].sha).toBe(l1);
  });

  it('(iii) ambiguous cut point (two branches own the fork-point commit) → unclear + the specific question', async () => {
    const repo = fixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    const base = repo.sha('main');
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('mp1: patch', { 'patch.txt': 'p\n' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    const a1 = repo.commit('a1: shared segment', { 'src/a.ts': 'a\n' });
    // feat/b DECLARES main_patched as parent but was actually cut from feat/a@a1
    // — the undeclared sharing makes a1 owned by BOTH entries.
    repo.checkout('feat/b', { create: true, at: 'feat/a' });
    repo.commit('b1', { 'src/b.ts': 'b\n' });
    repo.checkout('feat/amb', { create: true, at: a1 });
    repo.commit('m1', { 'src/m.ts': 'm\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/u.ts': 'u\n' });

    const records = await derive(repo, base, [
      entry('a', 'feat/a', ['main_patched']),
      entry('b', 'feat/b', ['main_patched']),
    ]);
    expect(records.map((r) => r.branch)).toEqual(['feat/amb']);
    const r = records[0];
    expect(r.confidence).toBe('unclear');
    expect(r.openQuestions.length).toBeGreaterThan(0);
    const q = r.openQuestions.find((x) => x.includes('cut point ambiguous'));
    expect(q).toBeTruthy();
    expect(q).toContain(`'feat/a'@${a1.slice(0, 12)}`);
    expect(q).toContain(`'feat/b'@${a1.slice(0, 12)}`);
    expect(q).toContain('which parent?');
    // Every piece of evidence recorded with SHAs — both contenders present.
    expect(r.proposedParents.map((p) => p.branch).sort()).toEqual(['feat/a', 'feat/b']);
    for (const p of r.proposedParents) expect(p.evidence[0].sha).toBe(a1);
  });

  it('(iv) pre-fork branch (no fork-era ancestry) → unclear with the pre-fork question', async () => {
    const repo = fixtureRepo();
    const preForkCut = repo.commit('old upstream commit', { 'src/old.ts': 'old\n' });
    repo.checkout('feat/old', { create: true, at: 'main' });
    repo.commit('o1: ancient work', { 'src/o.ts': 'o\n' });
    repo.checkout('main');
    repo.commit('later upstream', { 'src/later.ts': 'l\n' });
    const base = repo.sha('main'); // fork point ABOVE the candidate's divergence
    repo.commit('U0: util', { 'src/u.ts': 'u\n' });

    const records = await derive(repo, base, []);
    expect(records.map((r) => r.branch)).toEqual(['feat/old']);
    const r = records[0];
    expect(r.confidence).toBe('unclear');
    expect(r.openQuestions.some((q) => q.includes('no fork-era ancestry'))).toBe(true);
    expect(r.forkPoint?.sha).toBe(preForkCut);
    expect(r.forkPoint?.height).toBe(-1); // below the pass chain
    expect(r.proposedParents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// e2e through the driver: reporting, throttle, plan exclusion, validator.
// ---------------------------------------------------------------------------

function writeInventoryDir(entries: Array<{ id: string; branch: string; parents?: string[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cand-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const e of entries) addInventoryEntry(dir, e);
  return dir;
}

function addInventoryEntry(dir: string, e: { id: string; branch: string; parents?: string[] }): void {
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

/** main_patched + feat/a (entry) + feat/cand (candidate cut from feat/a). */
function candidateFixture(): { repo: FixtureRepo } {
  const repo = fixtureRepo();
  repo.commit('base: x', { 'src/x.ts': 'orig\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp1: patch', { 'patch.txt': 'p\n' });
  repo.checkout('feat/a', { create: true, at: 'main_patched' });
  repo.commit('a1', { 'src/a.ts': 'a\n' });
  repo.checkout('feat/cand', { create: true, at: 'feat/a' });
  repo.commit('c1', { 'src/c.ts': 'c\n' });
  repo.checkout('main');
  repo.commit('U0: util', { 'src/util.ts': 'u\n' });
  return { repo };
}

function candidateEvents(dir: string): Array<{ event: string; branch: string }> {
  return readJournal(dir)
    .filter((e) => e.action === 'candidate')
    .map((e) => ({ event: e.event as string, branch: e.branch as string }));
}

describe('propagate plan — candidate reporting + throttle (§13)', () => {
  it('(v) reports on discovery, stays quiet on an unmoved tip, re-reports on movement, resolves once on entry gain', async () => {
    const { repo } = candidateFixture();
    const ws = mkWorkspace();
    const inv = writeInventoryDir([{ id: 'a', branch: 'feat/a', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);

    // Discovery: journaled, YAML written, candidates.json lists it as newly reported.
    expect(await cmdPlan(cli({ cmd: 'plan' }))).toBe(0);
    expect(candidateEvents(dir)).toEqual([{ event: 'discovered', branch: 'feat/cand' }]);
    const yamlPath = candidateYamlPath(ws, 'feat/cand');
    expect(existsSync(yamlPath)).toBe(true);
    const stored = parse(readFileSync(yamlPath, 'utf8')) as CandidateRecord;
    expect(stored.lastReportedTip).toBe(repo.sha('feat/cand'));
    expect(stored.confidence).toBe('clear');
    const summary = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8')) as {
      newlyReported: string[];
      standingInstruction: string;
    };
    expect(summary.newlyReported).toEqual(['feat/cand']);
    expect(summary.standingInstruction).toContain('inventory may only contain branches with proper/valid inheritance');

    // Unmoved tip: quiet pass — no new candidate journal entries.
    expect(await cmdPlan(cli({ cmd: 'plan' }))).toBe(0);
    expect(candidateEvents(dir).length).toBe(1);

    // Moved tip: re-reported, YAML throttle field updated.
    repo.checkout('feat/cand');
    const c2 = repo.commit('c2: more work', { 'src/c2.ts': 'c2\n' });
    repo.checkout('main');
    expect(await cmdPlan(cli({ cmd: 'plan' }))).toBe(0);
    expect(candidateEvents(dir)).toEqual([
      { event: 'discovered', branch: 'feat/cand' },
      { event: 'moved', branch: 'feat/cand' },
    ]);
    expect((parse(readFileSync(yamlPath, 'utf8')) as CandidateRecord).lastReportedTip).toBe(c2);

    // Entry gained: stops being a candidate — marked resolved, reported once.
    addInventoryEntry(inv, { id: 'cand', branch: 'feat/cand', parents: ['feat/a'] });
    expect(await cmdPlan(cli({ cmd: 'plan' }))).toBe(0);
    const events3 = candidateEvents(dir);
    expect(events3[events3.length - 1]).toEqual({ event: 'resolved', branch: 'feat/cand' });
    const resolvedYaml = parse(readFileSync(yamlPath, 'utf8')) as CandidateRecord;
    expect(resolvedYaml.resolved).toBe(true);
    expect(resolvedYaml.resolvedReason).toBe('inventory-entry-added');
    // ...and only once: a further plan stays quiet.
    expect(await cmdPlan(cli({ cmd: 'plan' }))).toBe(0);
    expect(candidateEvents(dir).length).toBe(events3.length);
  });

  it('(vii) a candidate never appears in the merge plan and is never merged by run', async () => {
    const { repo } = candidateFixture();
    const ws = mkWorkspace();
    const inv = writeInventoryDir([{ id: 'a', branch: 'feat/a', parents: ['main_patched'] }]);
    const dir = passDir(ws, repo.sha('main').slice(0, 12));
    const candTip = repo.sha('feat/cand');
    const cli = (o: Partial<Cli>): Cli => baseCli(repo, ws, inv, o);

    await cmdPlan(cli({ cmd: 'plan' }));
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as PropagationPlan;
    expect(plan.order).not.toContain('feat/cand');
    expect(plan.branches.some((b) => b.branch === 'feat/cand')).toBe(false);

    expect(await cmdRun(cli({ cmd: 'run', execute: true }))).toBe(0);
    expect(repo.sha('feat/cand')).toBe(candTip); // untouched
    const touched = readJournal(dir).filter(
      (e) => e.branch === 'feat/cand' && e.action !== 'candidate', // discovery-only
    );
    expect(touched).toEqual([]);
    // The inventory branches DID propagate.
    expect(readJournal(dir).some((e) => e.action === 'merge' && e.branch === 'feat/a')).toBe(true);
  });
});

describe('propagate plan — inventory-inheritance hard halt (§13, D-045)', () => {
  it('(vi) an inventory entry whose parent is missing from the inventory/structural set halts, naming the entry', async () => {
    const repo = fixtureRepo();
    repo.commit('base: x', { 'src/x.ts': 'orig\n' });
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.checkout('feat/a', { create: true, at: 'main_patched' });
    repo.commit('a1', { 'src/a.ts': 'a\n' });
    repo.checkout('main');
    repo.commit('U0: util', { 'src/util.ts': 'u\n' });

    const ws = mkWorkspace();
    const inv = writeInventoryDir([{ id: 'a', branch: 'feat/a', parents: ['feat/ghost'] }]);
    await expect(cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }))).rejects.toThrow(
      /entry 'a' \(branch 'feat\/a'\) declares parent 'feat\/ghost'/,
    );
    await expect(cmdPlan(baseCli(repo, ws, inv, { cmd: 'plan' }))).rejects.toThrow(/D-045/);
  });
});
