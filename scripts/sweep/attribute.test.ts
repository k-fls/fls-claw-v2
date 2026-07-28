/**
 * scripts/sweep/attribute.test.ts — D-061 (B) blame.
 *
 * The live 2026-07-28 failure is the reference case throughout: verify accused
 * `feat/mitm-credential-proxy`, but the type error was in `src/command-gate.ts`
 * — a file FOUR registry entries declare in their paths and NONE of them has
 * ever modified. The branch that actually carries the defect is the fork trunk
 * `main_patched` (6 own commits, hierarchy depth 1), which no inventory entry
 * claims at all. Blame is therefore decided by GIT HISTORY, not by declarations;
 * these tests build real repos and assert against real commits.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { attributeFailure, blameCandidates, parseFailingFiles } from './attribute.js';
import { type FixtureRepo, initFixtureRepo } from './fixtures.js';
import { assertNoParentInversion, branchHierarchy, depthOf, minPathOf } from './hierarchy.js';
import type { FeatureEntry } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function feat(over: Partial<FeatureEntry> & { id: string }): FeatureEntry {
  return {
    name: over.id,
    kind: 'module',
    status: 'shipped',
    ...over,
  } as FeatureEntry;
}

/** A tsc bracket diagnostic for each file, which is what blame parses. */
function tsc(...files: string[]): string {
  return files.map((f, i) => `${f}(${i + 10},4): error TS2345: Argument of type 'string | null' is not assignable.`).join('\n');
}

describe('parseFailingFiles', () => {
  it('parses the real tsc bracket form (the 2026-07-28 diagnostic)', () => {
    const out = [
      'src/command-gate.ts(343,45): error TS2345: Argument of type \'string | null | undefined\' is not',
      "  assignable to parameter of type 'string'.",
    ].join('\n');
    expect(parseFailingFiles(out)).toEqual(['src/command-gate.ts']);
  });

  it('parses the tsc colon/pretty form and vitest FAIL lines, de-duped, first-seen order', () => {
    const out = [
      'src/b.ts:12:3 - error TS2322: Type X is not assignable',
      ' FAIL  src/guard/conformance.test.ts [ src/guard/conformance.test.ts ]',
      'src/b.ts(99,1): error TS1005: expected',
    ].join('\n');
    expect(parseFailingFiles(out)).toEqual(['src/b.ts', 'src/guard/conformance.test.ts']);
  });

  it('returns nothing for output with no recognizable diagnostics (=> caller must fall back)', () => {
    expect(parseFailingFiles('ELIFECYCLE Command failed.\nsh: 1: tsc: not found')).toEqual([]);
  });
});

describe('hierarchy — the ONE depth/minPath implementation', () => {
  // Parents are BRANCH names, never entry ids. Keying the DAG by id silently
  // dropped every edge, collapsed all depths to 0, and let a depth-6 edition
  // outrank three depth-2 modules.
  const features = [
    feat({ id: 'cq', branch: 'module/container-queue', parents: ['main_patched'] }),
    feat({ id: 'agc', branch: 'module/agent-group-contributions', parents: ['main_patched'] }),
    feat({ id: 'ih', branch: 'module/interactions-helpers', parents: ['module/agent-group-contributions'] }),
    feat({ id: 'creds', branch: 'module/credentials', parents: ['module/interactions-helpers'] }),
    feat({
      id: 'mitm',
      branch: 'feat/mitm-credential-proxy',
      parents: ['module/container-queue', 'module/credentials', 'module/agent-group-contributions'],
    }),
    feat({ id: 'edition', branch: 'edition/fls-ai-bot', parents: ['feat/mitm-credential-proxy'] }),
  ];
  const h = branchHierarchy(features);

  it('main=0, main_patched=1, and depth is 1 + MAX(parents) — never MIN', () => {
    expect(depthOf(h, 'main')).toBe(0);
    expect(depthOf(h, 'main_patched')).toBe(1);
    expect(depthOf(h, 'module/agent-group-contributions')).toBe(2);
    expect(depthOf(h, 'module/interactions-helpers')).toBe(3);
    expect(depthOf(h, 'module/credentials')).toBe(4);
    // mitm's shallowest parent is at 2, its DEEPEST is credentials at 4.
    // MIN would say 3 — level with its own parent module/credentials. MAX says 5.
    expect(depthOf(h, 'feat/mitm-credential-proxy')).toBe(5);
    expect(depthOf(h, 'edition/fls-ai-bot')).toBe(6);
  });

  it('INVARIANT: no branch sits at or above the depth of any parent', () => {
    expect(assertNoParentInversion(h)).toEqual([]);
  });

  it('minPath is the SHORTEST chain to main, excluding main — distinct from depth', () => {
    expect(minPathOf(h, 'main_patched')).toEqual([]);
    expect(minPathOf(h, 'module/agent-group-contributions')).toEqual(['main_patched']);
    expect(minPathOf(h, 'module/credentials')).toEqual([
      'module/interactions-helpers',
      'module/agent-group-contributions',
      'main_patched',
    ]);
    // depth 5 (via the deepest parent) but only 2 hops on the shortest route.
    expect(depthOf(h, 'feat/mitm-credential-proxy')).toBe(5);
    expect(minPathOf(h, 'feat/mitm-credential-proxy')).toEqual(['module/container-queue', 'main_patched']);
  });

  it('a branch with no route to a root is UNRESOLVED (null), never depth 0', () => {
    const orphaned = branchHierarchy([feat({ id: 'o', branch: 'feat/orphan', parents: ['feat/ghost'] })]);
    expect(depthOf(orphaned, 'feat/orphan')).toBeNull();
    expect(minPathOf(orphaned, 'feat/orphan')).toBeNull();
    expect(orphaned.unresolved).toEqual(['feat/orphan']);
  });

  it('a parents CYCLE terminates instead of hanging the driver', () => {
    const cyclic = branchHierarchy([
      feat({ id: 'a', branch: 'feat/a', parents: ['feat/b'] }),
      feat({ id: 'b', branch: 'feat/b', parents: ['feat/a'] }),
    ]);
    expect(depthOf(cyclic, 'feat/a')).toBeNull();
  });
});

/**
 * THE LIVE SHAPE, in miniature:
 *
 *   main                    src/shared.ts        (upstream — nobody's fork work)
 *   main_patched            src/command-gate.ts  x2   <- the real defect, depth 1
 *   module/command-gate     src/host-commands.ts      <- DECLARES command-gate.ts, never touched it
 *   feat/leaf               src/leaf.ts               <- also declares it; inherits the trunk's commits
 *   feat/maintenance-sweep  scripts/sweep/propagate.ts (a `**`-glob-owned path)
 */
function blameRepo(): FixtureRepo {
  const repo = initFixtureRepo();
  repo.commit('upstream: shared', { 'src/shared.ts': 'up\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: command gate', { 'src/command-gate.ts': 'trunk\n' });
  repo.commit('mp: command gate again', { 'src/command-gate.ts': 'trunk2\n' });
  repo.checkout('module/command-gate', { create: true, at: 'main_patched' });
  repo.commit('cg: host commands', { 'src/host-commands.ts': 'cg\n' });
  repo.checkout('feat/leaf', { create: true, at: 'module/command-gate' });
  repo.commit('leaf: work', { 'src/leaf.ts': 'leaf\n' });
  repo.checkout('feat/maintenance-sweep', { create: true, at: 'main_patched' });
  repo.commit('sweep: driver', { 'scripts/sweep/propagate.ts': 'driver\n' });
  repo.checkout('main');
  cleanups.push(() => repo.destroy());
  return repo;
}

/** The inventory for `blameRepo`, declarations and all — the trunk is NOT an entry. */
const liveShape: FeatureEntry[] = [
  feat({
    id: 'cg',
    branch: 'module/command-gate',
    parents: ['main_patched'],
    // The declaration that lied: four live entries claim this path, none wrote it.
    touch_paths: ['src/command-gate.ts'],
  }),
  feat({
    id: 'leaf',
    branch: 'feat/leaf',
    parents: ['module/command-gate'],
    owned_paths: ['src/command-gate.ts'],
  }),
  feat({
    id: 'sweep',
    branch: 'feat/maintenance-sweep',
    parents: ['main_patched'],
    owned_paths: ['scripts/sweep/**'],
  }),
];

/**
 * REPLACES the `branchCandidates — the OWNER RULE` suite, which built candidates
 * by matching `owned_paths`/`touch_paths` and asserted `owned` beats `touched`.
 * Both signals are gone: a declaration is not evidence, and the owned/touched
 * distinction it produced was a tie-break over aspirations. What survives is the
 * OWNER RULE itself (shallowest hierarchy depth first), now over git commits.
 */
describe('blameCandidates — own commits, not declarations', () => {
  it('a branch is a candidate iff it has OWN commits touching the file', async () => {
    const repo = blameRepo();
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    const cands = byFile.get('src/command-gate.ts')!;
    // The trunk wrote it — twice — and is a candidate although nothing declares it.
    expect(cands.map((c) => c.branch)).toEqual(['main_patched']);
    expect(cands[0].depth).toBe(1);
    expect(cands[0].commits).toBe(2);
  });

  it('DECLARING the path is not evidence: the two declarers are not candidates', async () => {
    const repo = blameRepo();
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    const named = byFile.get('src/command-gate.ts')!.map((c) => c.branch);
    expect(named).not.toContain('module/command-gate'); // touch_paths says yes, git says never
    expect(named).not.toContain('feat/leaf'); // owned_paths says yes, git says never
  });

  it('INHERITED commits are not own commits — a descendant does not answer for its parent', async () => {
    const repo = blameRepo();
    // feat/leaf contains both trunk commits over src/command-gate.ts by descent.
    expect(repo.git('rev-list', '--count', 'feat/leaf', '--', 'src/command-gate.ts')).toBe('2');
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    // …but none of them is its own (`^module/command-gate` removes them).
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).toEqual(['main_patched']);
  });

  it('candidates are ordered SHALLOWEST FIRST, over every branch including the trunk', async () => {
    const repo = blameRepo();
    // Both the trunk and a depth-3 leaf write the same file.
    repo.checkout('feat/leaf');
    repo.commit('leaf: also command gate', { 'src/command-gate.ts': 'leaf\n' });
    repo.checkout('main');
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    const cands = byFile.get('src/command-gate.ts')!;
    expect(cands.map((c) => c.branch)).toEqual(['main_patched', 'feat/leaf']);
    expect(cands.map((c) => c.depth)).toEqual([1, 3]); // main=0; the trunk is 1
  });

  it('a branch with no ref anywhere is silently not a candidate (a planned entry has no history)', async () => {
    const repo = blameRepo();
    const withPlanned = [...liveShape, feat({ id: 'planned', branch: 'feat/never-created', parents: ['main_patched'] })];
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], withPlanned);
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).toEqual(['main_patched']);
  });

  it('an ORIGIN-ONLY branch still counts (D-045 §13: no local ref is not no history)', async () => {
    const repo = blameRepo();
    repo.checkout('feat/remote-only', { create: true, at: 'main_patched' });
    repo.commit('remote: own the file', { 'src/remote.ts': 'r\n' });
    repo.checkout('main');
    repo.setOrigin('feat/remote-only');
    repo.deleteLocalBranch('feat/remote-only');
    const features = [...liveShape, feat({ id: 'ro', branch: 'feat/remote-only', parents: ['main_patched'] })];
    const byFile = await blameCandidates(repo.dir, ['src/remote.ts'], features);
    expect(byFile.get('src/remote.ts')!.map((c) => c.branch)).toEqual(['feat/remote-only']);
  });

  it('an UNRESOLVABLE parent skips the branch — never counts inherited commits as own', async () => {
    const repo = blameRepo();
    // Its declared parent does not exist, so `^parent` cannot be subtracted; with
    // the exclusion silently dropped, feat/leaf would be credited with the
    // trunk's two commits over src/command-gate.ts.
    const broken = [
      feat({ id: 'leaf', branch: 'feat/leaf', parents: ['module/ghost'] }),
      feat({ id: 'cg', branch: 'module/command-gate', parents: ['main_patched'] }),
    ];
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], broken);
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).toEqual(['main_patched']);
  });
});

describe('attributeFailure — the 2026-07-28 reference case, blamed by git history', () => {
  it('roots the fix on the branch whose COMMITS carry the defect, not the declarer and not the accused', async () => {
    const repo = blameRepo();
    const a = await attributeFailure(repo.dir, tsc('src/command-gate.ts'), liveShape, 'feat/leaf');
    expect(a.branch).toBe('main_patched'); // NOT the accused leaf, NOT the declarer
    expect(a.files).toEqual(['src/command-gate.ts']);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0]).toMatchObject({ branch: 'main_patched', depth: 1, files: ['src/command-gate.ts'] });
    expect(a.reason).toContain('main_patched');
  });

  it('a file under a `**`-glob-owned path attributes to the branch that wrote it', async () => {
    const repo = blameRepo();
    const a = await attributeFailure(repo.dir, tsc('scripts/sweep/propagate.ts'), liveShape, 'feat/leaf');
    expect(a.branch).toBe('feat/maintenance-sweep');
    expect(a.candidates.map((c) => c.branch)).toEqual(['feat/maintenance-sweep']);
  });

  it('a file NOBODY has own commits over falls to the TRUNK, never to the accused', async () => {
    const repo = blameRepo();
    // src/shared.ts only ever changed on `main`: inherited from upstream, so the
    // trunk is the one place a fix reaches every branch.
    const a = await attributeFailure(repo.dir, tsc('src/shared.ts'), liveShape, 'feat/leaf');
    expect(a.branch).toBe('main_patched');
    expect(a.perFile[0].candidates).toEqual([]);
    expect(a.perFile[0].reason).toContain('no branch has own commits');
  });

  it('unparseable output -> falls back to the accused branch and SAYS so', async () => {
    const repo = blameRepo();
    const a = await attributeFailure(repo.dir, 'sh: 1: tsc: not found', liveShape, 'feat/leaf');
    expect(a.branch).toBe('feat/leaf');
    expect(a.reason).toContain('no file paths');
    expect(a.groups).toEqual([]);
  });

  it('no accused branch and nothing parseable -> null, never a guess', async () => {
    const repo = blameRepo();
    expect((await attributeFailure(repo.dir, 'garbage', liveShape, null)).branch).toBeNull();
  });

  it('a TIE at the shallowest depth is REFUSED for that file, naming the tied branches', async () => {
    const repo = blameRepo();
    for (const b of ['feat/a', 'feat/b']) {
      repo.checkout(b, { create: true, at: 'main_patched' });
      repo.commit(`${b}: tie`, { 'src/tie.ts': `${b}\n` });
    }
    repo.checkout('main');
    const features = [
      feat({ id: 'a', branch: 'feat/a', parents: ['main_patched'] }),
      feat({ id: 'b', branch: 'feat/b', parents: ['main_patched'] }),
    ];
    const a = await attributeFailure(repo.dir, tsc('src/tie.ts'), features, 'feat/accused');
    expect(a.perFile[0].branch).toBeNull(); // no localeCompare-as-decision
    expect(a.perFile[0].reason).toContain('tie on hierarchy depth 2');
    expect(a.perFile[0].reason).toContain('feat/a, feat/b');
    expect(a.unattributable.map((u) => u.file)).toEqual(['src/tie.ts']);
    // Nothing was blamed, so there is no group to hand an agent.
    expect(a.groups).toEqual([]);
    expect(a.branch).toBeNull();
    expect(a.reason).toContain('no branch could be blamed');
  });
});

/**
 * REPLACES the `owned_paths are GLOBS, not literal prefixes (defect 5)` suite.
 * That defect — and its fix — lived entirely inside the registry-glob matcher
 * that no longer takes part in blame; `globMatchAny` is still exercised by
 * routing.test.ts / globs.test.ts, which own it. What that suite was really
 * protecting is that blame reaches a real answer instead of falling back to the
 * accused branch, and that is what these assert, over git.
 */
describe('attributeFailure — BATCHING: one group per branch, shallowest first', () => {
  it('failing files spread over branches produce one group each, shallowest branch first', async () => {
    const repo = blameRepo();
    const a = await attributeFailure(
      repo.dir,
      // Deliberately out of hierarchy order in the output.
      tsc('src/leaf.ts', 'scripts/sweep/propagate.ts', 'src/command-gate.ts'),
      liveShape,
      'feat/accused',
    );
    expect(a.groups.map((g) => g.branch)).toEqual(['main_patched', 'feat/maintenance-sweep', 'feat/leaf']);
    expect(a.groups.map((g) => g.depth)).toEqual([1, 2, 3]);
    expect(a.groups.map((g) => g.files)).toEqual([
      ['src/command-gate.ts'],
      ['scripts/sweep/propagate.ts'],
      ['src/leaf.ts'],
    ]);
    // The shallowest is what a single-case reader gets: a judged fix there plus
    // the reopen it triggers can moot the descendants' cases.
    expect(a.branch).toBe('main_patched');
  });

  it('several files on ONE branch are carried by ONE group, in first-seen order', async () => {
    const repo = blameRepo();
    repo.checkout('feat/leaf');
    repo.commit('leaf: second file', { 'src/leaf2.ts': 'l2\n' });
    repo.checkout('main');
    const a = await attributeFailure(repo.dir, tsc('src/leaf2.ts', 'src/leaf.ts'), liveShape, 'feat/accused');
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0].branch).toBe('feat/leaf');
    expect(a.groups[0].files).toEqual(['src/leaf2.ts', 'src/leaf.ts']);
  });

  it('a refused (tied) file drops out of the groups; the blameable files still batch', async () => {
    const repo = blameRepo();
    for (const b of ['feat/a', 'feat/b']) {
      repo.checkout(b, { create: true, at: 'main_patched' });
      repo.commit(`${b}: tie`, { 'src/tie.ts': `${b}\n` });
    }
    repo.checkout('main');
    const features = [
      ...liveShape,
      feat({ id: 'a', branch: 'feat/a', parents: ['main_patched'] }),
      feat({ id: 'b', branch: 'feat/b', parents: ['main_patched'] }),
    ];
    const a = await attributeFailure(repo.dir, tsc('src/tie.ts', 'src/command-gate.ts'), features, 'feat/accused');
    expect(a.groups.map((g) => g.branch)).toEqual(['main_patched']);
    expect(a.groups[0].files).toEqual(['src/command-gate.ts']); // the tied file is NOT smuggled in
    expect(a.unattributable.map((u) => u.file)).toEqual(['src/tie.ts']);
    expect(a.reason).toContain('cannot attribute');
  });
});
