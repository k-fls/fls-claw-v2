import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { executeMerges, planMerges } from './merge.js';
import { emptyLedger } from './ledger.js';
import { loadReplayCases } from './registry.js';
import { replayCase, replayCases, seedRerereFromCases, seedableCases } from './replay.js';

const scratch = mkdtempSync(join(tmpdir(), 'sweep-replay-'));
const repo = initFixtureRepo();
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  repo.destroy();
});

// Fork with a same-line edit; upstream: U1 docs, U2 new skill, U3 the conflict.
repo.checkout('feat/one', { create: true, at: 'main' });
repo.commit('fork edit', { 'src/app.ts': 'export const app = () => 1;\nexport const shared = "fork";\n' });
repo.checkout('main');
repo.checkout('upstream-main', { create: true, at: 'main' });
const u1 = repo.commit('U1: docs', { 'docs/notes.md': 'notes\n' });
const u2 = repo.commit('U2: ship demo skill', { '.claude/skills/demo/SKILL.md': '# demo\n' });
repo.commit('U3: conflicting edit', {
  'src/app.ts': 'export const app = () => 1;\nexport const shared = "upstream";\n',
});
repo.checkout('main');
const forkBase = repo.sha('feat/one');

const CASE_YAML = `id: case-001-conflict-with-skill
taxonomy: upstream-conflict-plus-new-skill
fork_branch: feat/one
fork_base_commit: ${forkBase}
upstream_range: main..upstream-main
expected:
  classification: conflict
  conflicts:
    - src/app.ts
  stop_point: ${u2}
  pois:
    - type: new-skill
      paths: [.claude/skills/demo/SKILL.md]
    - type: new-top-level-dir
`;

describe('replay harness (cases from the local tree)', () => {
  const casesDir = join(scratch, 'cases');
  mkdirSync(casesDir, { recursive: true });
  writeFileSync(join(casesDir, 'case-001.yaml'), CASE_YAML);

  it('loads cases from a local directory and passes the synthetic case', async () => {
    const { cases, warnings } = loadReplayCases(casesDir);
    expect(warnings).toEqual([]);
    expect(cases).toHaveLength(1);

    const results = await replayCases(repo.dir, cases);
    expect(results[0].pass).toBe(true);
    expect(results[0].failures).toEqual([]);
    expect(results[0].actual).toMatchObject({
      classification: 'conflict',
      conflicts: ['src/app.ts'],
      stopPoint: u2,
    });
    expect(results[0].actual.poiTypes).toContain('new-skill');
  });

  it('reports precise diffs when expectations do not hold', async () => {
    const result = await replayCase(repo.dir, {
      id: 'case-bad',
      taxonomy: 't',
      fork_branch: 'feat/one',
      fork_base_commit: forkBase,
      upstream_range: 'main..upstream-main',
      expected: {
        classification: 'clean',
        conflicts: [],
        stop_point: u1,
        pois: [{ type: 'dep-change' }],
      },
    });
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([
      'classification: expected clean (clean), got conflict',
      'conflicts: expected [], got [src/app.ts]',
      `stop_point: expected ${u1}, got ${u2}`,
      'poi: expected dep-change, not found',
    ]);
  });

  it('accepts the live registry schema: {from,to} range, semantic alias, prose poi notes', async () => {
    const result = await replayCase(repo.dir, {
      id: 'case-live-schema',
      taxonomy: 'T4',
      fork_branch: 'feat/one (historical tip, see tag)',
      fork_base_commit: forkBase,
      upstream_range: { from: repo.sha('main'), to: repo.sha('upstream-main') },
      expected: {
        classification: 'semantic', // registry taxonomy for a conflict needing semantic work
        conflicts: ['src/app.ts (content)'], // annotation must be stripped
        pois: ['prose note about range-level PoIs — must be ignored', { type: 'new-skill' }],
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('replays fork-internal propagation cases via merge_source', async () => {
    const conflicting = await replayCase(repo.dir, {
      id: 'case-propagation',
      taxonomy: 'T2',
      fork_branch: 'feat/one',
      fork_base_commit: forkBase,
      merge_source: 'upstream-main',
      expected: { classification: 'known-recurring', conflicts: ['src/app.ts'] },
    });
    expect(conflicting.failures).toEqual([]);

    const clean = await replayCase(repo.dir, {
      id: 'case-propagation-clean',
      taxonomy: 'T1',
      fork_branch: 'feat/one',
      fork_base_commit: forkBase,
      merge_source: u2, // before the conflicting upstream commit
      expected: { classification: 'clean', conflicts: [] },
    });
    expect(clean.pass).toBe(true);
  });

  it("skips 'excluded' cases and fails closed on unknown labels", async () => {
    const base = {
      taxonomy: 'T10',
      fork_branch: 'feat/one',
      fork_base_commit: forkBase,
      upstream_range: 'main..upstream-main',
    };
    const skipped = await replayCase(repo.dir, {
      ...base,
      id: 'case-excluded',
      expected: { classification: 'excluded' },
    });
    expect(skipped).toMatchObject({ pass: true, skipped: true });

    const unknown = await replayCase(repo.dir, { ...base, id: 'case-unknown', expected: { classification: 'wat' } });
    expect(unknown.pass).toBe(false);
    expect(unknown.failures[0]).toMatch(/not a known label/);
  });

  it('fails cleanly on an unresolvable ref', async () => {
    const result = await replayCase(repo.dir, {
      id: 'case-missing-ref',
      taxonomy: 't',
      fork_branch: 'feat/one',
      fork_base_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      upstream_range: 'main..upstream-main',
      expected: { classification: 'conflict' },
    });
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatch(/not found in repo/);
  });
});

describe('seed-rerere from pinned resolution cases', () => {
  const RESOLUTION = 'export const app = () => 1;\nexport const shared = "merged-both";\n';
  const rrDir = join(scratch, 'rr-cache');

  it('rebuilds the workspace rr-cache and enables auto-resolution of the recurring conflict', async () => {
    // A second fork branch with the byte-identical conflicting edit.
    repo.checkout('feat/sibling', { create: true, at: forkBase });
    repo.checkout('main');

    // Record the canonical resolution as a plain merge commit (no rerere).
    repo.checkout('recorded-merge', { create: true, at: forkBase });
    try {
      repo.git('merge', '--no-edit', 'upstream-main');
    } catch {
      // conflict expected
    }
    writeFileSync(join(repo.dir, 'src/app.ts'), RESOLUTION);
    repo.git('add', 'src/app.ts');
    repo.git('commit', '--no-edit', '--no-verify');
    const resolutionRef = repo.sha('recorded-merge');
    repo.checkout('main');
    rmSync(join(repo.dir, '.git/rr-cache'), { recursive: true, force: true });

    const seedCase = {
      id: 'seed-t2',
      taxonomy: 'T2',
      fork_branch: 'feat/one',
      fork_base_commit: forkBase,
      merge_source: repo.sha('upstream-main'),
      resolution_ref: resolutionRef,
      expected: { classification: 'known-recurring' as const },
    };
    expect(seedableCases([seedCase]).map((c) => c.id)).toEqual(['seed-t2']);

    const results = await seedRerereFromCases(repo.dir, [seedCase], rrDir);
    expect(results).toEqual([{ caseId: 'seed-t2', status: 'seeded', conflictFiles: ['src/app.ts'] }]);
    expect(existsSync(rrDir)).toBe(true);
    expect(readdirSync(rrDir).length).toBeGreaterThan(0);
    // No branch moved: recorded-merge still at the resolution commit, feat/one untouched.
    expect(repo.sha('feat/one')).toBe(forkBase);
    expect(repo.sha('recorded-merge')).toBe(resolutionRef);

    // Fresh-clone simulation, then the sweep auto-resolves the sibling via the seeded cache.
    rmSync(join(repo.dir, '.git/rr-cache'), { recursive: true, force: true });
    const plan = await planMerges(
      repo.dir,
      [
        {
          branch: 'feat/sibling',
          mergeModel: 'upstream-chain' as const,
          stopPoint: repo.sha('upstream-main'),
          parents: [],
          upToDate: false,
        },
      ],
      emptyLedger(),
    );
    expect(plan[0].method).toBe('worktree');
    const { outcomes } = await executeMerges(repo.dir, plan, rrDir);
    expect(outcomes[0].result).toBe('merged');
    expect(outcomes[0].rerereResolved).toEqual(['src/app.ts']);
    expect(repo.git('show', 'feat/sibling:src/app.ts')).toBe(RESOLUTION.trim());
  });

  it('reports no-conflict and missing-ref cases without seeding', async () => {
    const results = await seedRerereFromCases(
      repo.dir,
      [
        {
          id: 'seed-clean',
          taxonomy: 'T1',
          fork_branch: 'feat/one',
          fork_base_commit: forkBase,
          merge_source: u2,
          resolution_ref: forkBase,
          expected: { classification: 'clean' as const },
        },
        {
          id: 'seed-missing',
          taxonomy: 'T2',
          fork_branch: 'feat/one',
          fork_base_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          merge_source: u2,
          resolution_ref: forkBase,
          expected: { classification: 'known-recurring' as const },
        },
      ],
      rrDir,
    );
    expect(results.map((r) => r.status)).toEqual(['no-conflict', 'missing-ref']);
  });
});
