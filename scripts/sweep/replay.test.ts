import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { commitFilesOnBranch } from './git.js';
import { loadReplayCases } from './registry.js';
import { replayCase, replayCases } from './replay.js';

const STATE_BRANCH = 'maint/fork-registry';
const repo = initFixtureRepo();
afterAll(() => repo.destroy());

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

describe('replay harness', () => {
  it('loads cases from the state branch and passes the synthetic case', async () => {
    await commitFilesOnBranch(
      repo.dir,
      STATE_BRANCH,
      { 'fork-registry/test-cases/case-001.yaml': CASE_YAML },
      'add replay case',
    );
    const { cases, warnings } = await loadReplayCases(repo.dir, STATE_BRANCH);
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

  it('replays fork-internal propagation cases via merge_source', async () => {
    const conflicting = await replayCase(repo.dir, {
      id: 'case-propagation',
      taxonomy: 'T2',
      fork_branch: 'feat/one',
      fork_base_commit: forkBase,
      merge_source: 'upstream-main',
      expected: {
        classification: 'known-recurring', // alias -> conflict
        conflicts: ['src/app.ts (content)'], // annotation must be stripped
      },
    });
    expect(conflicting.failures).toEqual([]);
    expect(conflicting.pass).toBe(true);

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

  it('accepts the live registry schema: {from,to} range, semantic alias, prose poi notes', async () => {
    const result = await replayCase(repo.dir, {
      id: 'case-live-schema',
      taxonomy: 'T4',
      fork_branch: 'feat/one (historical tip, see tag)',
      fork_base_commit: forkBase,
      upstream_range: { from: repo.sha('main'), to: repo.sha('upstream-main') },
      expected: {
        classification: 'semantic', // registry taxonomy for a conflict needing semantic work
        conflicts: ['src/app.ts'],
        pois: ['prose note about range-level PoIs — must be ignored', { type: 'new-skill' }],
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
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

  it('replays against the pinned base commit, not the live branch tip', async () => {
    // Branch moves on (conflict resolved on the fork side)...
    repo.checkout('feat/one');
    repo.commit('resolve upstream side', {
      'src/app.ts': 'export const app = () => 1;\nexport const shared = "upstream";\n',
    });
    repo.checkout('main');
    // ...but the pinned case still sees the historical conflict.
    const { cases } = await loadReplayCases(repo.dir, STATE_BRANCH);
    const results = await replayCases(repo.dir, cases, 'case-001-conflict-with-skill');
    expect(results).toHaveLength(1);
    expect(results[0].pass).toBe(true);
  });
});
