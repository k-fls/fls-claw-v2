import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { buildReport, extractPois, scanBranch } from './scan.js';
import type { Poi } from './types.js';

const repo = initFixtureRepo();
afterAll(() => repo.destroy());

// Fork branch conflicting with upstream (same-line edit).
repo.checkout('feat/conflicting', { create: true, at: 'main' });
repo.commit('fork edit', { 'src/app.ts': 'export const app = () => 1;\nexport const shared = "fork";\n' });
repo.checkout('main');

// Upstream range with one PoI of every annotate class.
repo.checkout('upstream-main', { create: true, at: 'main' });
repo.commit('feat: add newtool subsystem', { 'newtool/main.ts': 'export {};\n' });
repo.commit('feat: ship demo skill', { '.claude/skills/demo/SKILL.md': '# demo skill\n' });
repo.commit('feat: giant generated module', { 'src/big.ts': `// big\n${'x'.repeat(16 * 1024)}\n` });
repo.commit('chore: small helper', { 'src/small.ts': 'export const s = 1;\n' });
repo.commit('fix: harden container spawn', { 'container/Dockerfile': 'FROM scratch\n' });
repo.commit('chore(deps): bump sdk', { 'package.json': '{"name":"fixture","version":"1.0.1"}\n' });
repo.commit('conflicting change', { 'src/app.ts': 'export const app = () => 1;\nexport const shared = "up";\n' });
repo.checkout('main');

function ofType(pois: Poi[], type: string): Poi[] {
  return pois.filter((p) => p.type === type);
}

describe('extractPois', () => {
  it('detects every annotate-PoI class over the first-parent range', async () => {
    const pois = await extractPois(repo.dir, 'main', 'upstream-main');

    const newDir = ofType(pois, 'new-top-level-dir');
    expect(newDir.map((p) => p.paths[0])).toContain('newtool/main.ts');
    // .claude/skills is a new top-level dir too in this fixture; newtool must be its own PoI.
    expect(newDir.some((p) => p.detail?.includes('newtool/'))).toBe(true);

    const skills = ofType(pois, 'new-skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].paths).toEqual(['.claude/skills/demo/SKILL.md']);
    expect(skills[0].detail).toContain('.claude/skills/demo');

    const large = ofType(pois, 'large-new-file');
    expect(large.map((p) => p.paths[0])).toEqual(['src/big.ts']); // small.ts under threshold
    expect(large[0].detail).toMatch(/threshold 15360/);

    const sensitive = ofType(pois, 'sensitive-surface-touch');
    expect(sensitive.map((p) => p.paths[0])).toContain('container/Dockerfile');

    const dep = ofType(pois, 'dep-change');
    expect(dep.map((p) => p.paths[0])).toEqual(['package.json']);

    // PoIs carry commit shas + subjects for routing.
    const skill = skills[0];
    expect(skill.upstreamCommits).toHaveLength(1);
    expect(skill.commitSubjects).toEqual(['feat: ship demo skill']);
    expect(pois.every((p) => p.class === 'annotate')).toBe(true);
  });

  it('respects configurable thresholds', async () => {
    const pois = await extractPois(repo.dir, 'main', 'upstream-main', { largeSourceBytes: 1 });
    const large = ofType(pois, 'large-new-file').map((p) => p.paths[0]);
    expect(large).toContain('src/small.ts');
    expect(large).toContain('src/big.ts');
  });

  it('returns no PoIs on an empty range', async () => {
    expect(await extractPois(repo.dir, 'upstream-main', 'upstream-main')).toEqual([]);
  });
});

describe('scanBranch / buildReport', () => {
  it('classifies clean and conflicting branches', async () => {
    const conflicting = await scanBranch(repo.dir, 'feat/conflicting', 'upstream-main');
    expect(conflicting.clean).toBe(false);
    expect(conflicting.conflictFiles).toEqual(['src/app.ts']);
    expect(conflicting.stopPoint).not.toBeNull(); // clean prefix before the conflicting commit
  });

  it('emits a gate merge-conflict PoI per conflicted branch', async () => {
    const report = await buildReport(repo.dir, ['feat/conflicting'], 'upstream-main', 'main');
    expect(report.schemaVersion).toBe(1);
    expect(report.branches['feat/conflicting'].conflictFiles).toEqual(['src/app.ts']);
    const gates = report.pois.filter((p) => p.class === 'gate');
    expect(gates).toHaveLength(1);
    expect(gates[0].type).toBe('merge-conflict');
    expect(gates[0].branches).toEqual(['feat/conflicting']);
    expect(gates[0].paths).toEqual(['src/app.ts']);
  });
});
