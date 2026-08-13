/**
 * scripts/sweep/attribute.test.ts — blame attribution for a failing check.
 *
 * The reference case throughout: verify accuses `feat/mitm-credential-proxy`,
 * but the type error is in `src/command-gate.ts` — a file FOUR registry
 * entries declare in their paths and NONE of them has ever modified. Blame is
 * therefore decided by GIT HISTORY, not by declarations; these tests build
 * real repos and assert against real commits.
 *
 * Counting a branch's own work as a SET DIFFERENCE (`^<inventory parents>`)
 * credits the fork trunk with commits over `src/command-gate.ts` — merges plus
 * edits AUTHORED on `module/command-gate` and absorbed by a propagation merge
 * — while the branch that actually wrote the file scores 0, because
 * `^main_patched` subtracts its own work back out of it. So that rule is not
 * the one in force. Authorship is the FIRST-PARENT LINE:
 * `--first-parent --no-merges <branch> ^main`. So the fixture below carries a
 * REAL propagation merge (receiver first parent, donor second): a linear fixture
 * cannot tell the two rules apart, which is the whole point.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  attributeFailure,
  blameCandidates,
  describeFingerprint,
  fingerprintKeys,
  parseFailingFiles,
  parseFailureFingerprints,
} from './attribute.js';
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
    ...over,
  } as FeatureEntry;
}

/** A tsc bracket diagnostic for each file, which is what blame parses. */
function tsc(...files: string[]): string {
  return files.map((f, i) => `${f}(${i + 10},4): error TS2345: Argument of type 'string | null' is not assignable.`).join('\n');
}

describe('parseFailingFiles', () => {
  it('parses the real tsc bracket form', () => {
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

/**
 * The fingerprint is what makes "the same failure again" a claim the driver can
 * PROVE. Every case below is a pair: two runs that must compare equal, or two
 * that must not. The bun blocks are the real shape — the message and the frame
 * arrive BEFORE the `(fail)` line that names the test.
 */
describe('parseFailureFingerprints', () => {
  /** A bun failure block: header, message, frame in the TEST file, verdict. */
  function bun(over: { file?: string; message: string; line: number; test: string; verdict?: string; ms?: string }): string {
    return [
      `${over.file ?? 'src/a.test.ts'}:`,
      over.message,
      `      at <anonymous> (/w/propagation/pass-abc/case/worktree/${over.file ?? 'src/a.test.ts'}:${over.line}:20)`,
      `(${over.verdict ?? 'fail'}) ${over.test} [${over.ms ?? '155.42'}ms]`,
    ].join('\n');
  }

  it('the same test timing out at two DIFFERENT durations is ONE fingerprint — the clock is not the defect', () => {
    const slow = bun({ message: 'error: Test "waits for the queue" timed out after 8004ms', line: 42, test: 'queue > waits for the queue', ms: '8004.12' });
    const slower = bun({ message: 'error: Test "waits for the queue" timed out after 10001ms', line: 42, test: 'queue > waits for the queue', ms: '10001.43' });
    expect(fingerprintKeys(parseFailureFingerprints(slow))).toEqual(fingerprintKeys(parseFailureFingerprints(slower)));
    expect(fingerprintKeys(parseFailureFingerprints(slow))).toEqual(['test src/a.test.ts:42 timeout queue > waits for the queue']);
  });

  it('an ASSERTION and a TIMEOUT of the same test at the same line are DIFFERENT — the failure mode changed', () => {
    const assertion = bun({ message: 'error: expect(received).toHaveLength(expected)', line: 42, test: 'queue > waits for the queue' });
    const timeout = bun({ message: 'error: Test "waits for the queue" timed out after 5000ms', line: 42, test: 'queue > waits for the queue' });
    expect(fingerprintKeys(parseFailureFingerprints(assertion))).not.toEqual(fingerprintKeys(parseFailureFingerprints(timeout)));
  });

  it('editing the TEST FILE moves the line and therefore the fingerprint — the comparison resets', () => {
    const before = bun({ message: 'error: expect(received).toBe(expected)', line: 42, test: 'queue > waits' });
    const after = bun({ message: 'error: expect(received).toBe(expected)', line: 47, test: 'queue > waits' });
    expect(fingerprintKeys(parseFailureFingerprints(before))).toEqual(['test src/a.test.ts:42 assertion queue > waits']);
    expect(fingerprintKeys(parseFailureFingerprints(after))).toEqual(['test src/a.test.ts:47 assertion queue > waits']);
  });

  it('output that names nothing yields an EMPTY set — the caller must read that as "cannot compare"', () => {
    expect(parseFailureFingerprints('ELIFECYCLE Command failed.\nsh: 1: tsc: not found')).toEqual([]);
    expect(parseFailureFingerprints('')).toEqual([]);
    // A verdict with no file header above it names nothing either.
    expect(parseFailureFingerprints('(fail) an orphaned verdict [1.00ms]')).toEqual([]);
  });

  it('the REAL bun capture: file from the header, line from the absolute frame, class from the message', () => {
    // Verbatim from a gate-fix case's test-output.full.txt: the failure sits
    // under dozens of the suite's own log lines, and the frame is an absolute
    // worktree path belonging to a pass that no longer exists.
    const out = [
      'src/poll-loop.test.ts:',
      '[poll-loop] Query error: API rate limit exceeded',
      '[task-script] [t-err] error: Command failed: bash /tmp/task-script-t-err.sh',
      '649 |     expect(nudges).toHaveLength(2);',
      '                         ^',
      'error: expect(received).toHaveLength(expected)',
      '',
      'Expected length: 2',
      'Received length: 1',
      '',
      '      at <anonymous> (/workspace/agent/propagation/pass-639577c30456/gate-fix-main_patched-65026160/worktree/container/agent-runner/src/poll-loop.test.ts:649:20)',
      '(fail) task-run turn wiring (real processQuery) > logs a second task run [155.42ms]',
      ' 144 pass',
      ' 1 fail',
    ].join('\n');
    expect(fingerprintKeys(parseFailureFingerprints(out))).toEqual([
      'test src/poll-loop.test.ts:649 assertion task-run turn wiring (real processQuery) > logs a second task run',
    ]);
    // The suite's own `error:` logging is bracketed, so it never becomes the class.
    expect(parseFailureFingerprints(out)[0].cls).toBe('assertion');
  });

  it('a TYPECHECK diagnostic carries NO line — the diagnostic points into the source being edited', () => {
    const at343 = "src/command-gate.ts(343,45): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.";
    const at351 = "src/command-gate.ts(351,45): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.";
    expect(fingerprintKeys(parseFailureFingerprints(at343))).toEqual(fingerprintKeys(parseFailureFingerprints(at351)));
    expect(fingerprintKeys(parseFailureFingerprints(at343))).toEqual([
      "ts src/command-gate.ts TS2345 Argument of type 'string | null' is not assignable to parameter of type 'string'.",
    ]);
  });

  it('a diagnostic message keeps the NAMES and drops the numbers, in either tsc spelling', () => {
    const bracket = 'src/x.ts(12,3): error TS2554: Expected 2 arguments, but got 3.';
    const colon = 'src/x.ts:99:1 - error TS2554: Expected 4 arguments, but got 1.';
    expect(fingerprintKeys(parseFailureFingerprints(bracket))).toEqual(fingerprintKeys(parseFailureFingerprints(colon)));
    expect(fingerprintKeys(parseFailureFingerprints(bracket))).toEqual(['ts src/x.ts TS2554 Expected # arguments, but got #.']);
    // A DIFFERENT code in the same file is a different failure.
    expect(fingerprintKeys(parseFailureFingerprints('src/x.ts(12,3): error TS2322: Type X is not assignable'))).toEqual([
      'ts src/x.ts TS2322 Type X is not assignable',
    ]);
  });

  it('vitest names the test FIRST and fills in the class and line from the lines under it', () => {
    const out = [
      ' FAIL  src/cli/groups.create.test.ts > groups > errors when required fields are missing',
      'AssertionError: expected true to be false',
      ' ❯ src/cli/groups.create.test.ts:85:21',
      ' ❯ node_modules/vitest/dist/chunk.js:99:1',
    ].join('\n');
    expect(fingerprintKeys(parseFailureFingerprints(out))).toEqual([
      'test src/cli/groups.create.test.ts:85 assertion groups > errors when required fields are missing',
    ]);
  });

  it('a file that fails to LOAD is a suite-error, never the same failure as a test that ran and failed', () => {
    const collect = ' FAIL  src/guard/conformance.test.ts [ src/guard/conformance.test.ts ]\nError: Cannot find module ./missing';
    expect(fingerprintKeys(parseFailureFingerprints(collect))).toEqual(['test src/guard/conformance.test.ts:? suite-error ']);
    const ran = bun({ file: 'src/guard/conformance.test.ts', message: 'error: expect(received).toBe(expected)', line: 9, test: 'conforms' });
    expect(fingerprintKeys(parseFailureFingerprints(collect))).not.toEqual(fingerprintKeys(parseFailureFingerprints(ran)));
  });

  it('bun `(error)` — a hook or module-scope throw — is a suite-error, not the test`s own failure', () => {
    const out = bun({ message: 'error: boom in beforeAll', line: 3, test: 'queue', verdict: 'error' });
    expect(parseFailureFingerprints(out)[0].cls).toBe('suite-error');
  });

  it('a header does not stay armed across a `$ <cmd>` boundary, and each command keeps its own file', () => {
    const out = [
      '$ bun test',
      'src/a.test.ts:',
      'error: expect(received).toBe(expected)',
      '      at <anonymous> (/w/worktree/src/a.test.ts:5:1)',
      '(fail) a > one',
      '$ pnpm test',
      '(fail) belongs to the NEXT command',
    ].join('\n');
    expect(fingerprintKeys(parseFailureFingerprints(out))).toEqual(['test src/a.test.ts:5 assertion a > one']);
  });

  it('the keys are SORTED and de-duplicated, so two runs compare as strings', () => {
    const out = [
      bun({ file: 'src/z.test.ts', message: 'error: expect(received).toBe(expected)', line: 2, test: 'z' }),
      bun({ file: 'src/a.test.ts', message: 'error: expect(received).toBe(expected)', line: 1, test: 'a' }),
      // The same failure printed twice (a retry, or a reporter that lists it again).
      bun({ file: 'src/a.test.ts', message: 'error: expect(received).toBe(expected)', line: 1, test: 'a' }),
    ].join('\n');
    expect(fingerprintKeys(parseFailureFingerprints(out))).toEqual([
      'test src/a.test.ts:1 assertion a',
      'test src/z.test.ts:2 assertion z',
    ]);
  });

  it('describeFingerprint turns a key back into a clause, and never throws on one it cannot read', () => {
    expect(describeFingerprint('test src/a.test.ts:42 assertion queue > waits')).toBe(
      '"queue > waits" still fails at the same line in the same way (src/a.test.ts:42)',
    );
    expect(describeFingerprint('test src/a.test.ts:? timeout queue > waits')).toBe(
      '"queue > waits" still fails in the same way (src/a.test.ts, timeout)',
    );
    expect(describeFingerprint('test src/a.test.ts:? suite-error ')).toBe('src/a.test.ts still fails to load in the same way (suite-error)');
    expect(describeFingerprint('ts src/x.ts TS2345 not assignable')).toBe('src/x.ts still reports the same TS2345: not assignable');
    expect(describeFingerprint('something else entirely')).toBe('something else entirely');
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
 * THE LIVE SHAPE, in miniature — WITH THE PROPAGATION MERGE:
 *
 *   main                     src/shared.ts              (upstream — nobody's fork work)
 *   main_patched             src/base.ts
 *   module/command-gate        src/command-gate.ts x2   <- the real AUTHOR, depth 2
 *                              src/host-commands.ts
 *   main_patched  <--M-- module/command-gate            <- PROPAGATION MERGE (trunk = FIRST parent)
 *   main_patched             src/trunk.ts               <- the trunk's own authored file, depth 1
 *   feat/leaf                src/leaf.ts                (cut from module/command-gate)
 *   feat/maintenance-sweep   scripts/sweep/propagate.ts (cut from main_patched AFTER M)
 *
 * That merge is what makes the fixture discriminating. After it, the trunk
 * CONTAINS both `src/command-gate.ts` commits, so the old `^parents` set
 * difference blames `main_patched` and zeroes out `module/command-gate` —
 * precisely the live 6-vs-0 inversion. On the first-parent line the trunk
 * authored NOTHING over that file and the module keeps its two edits.
 */
function blameRepo(): FixtureRepo {
  const repo = initFixtureRepo();
  repo.commit('upstream: shared', { 'src/shared.ts': 'up\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: fork base', { 'src/base.ts': 'base\n' });
  repo.checkout('module/command-gate', { create: true, at: 'main_patched' });
  repo.commit('cg: command gate', { 'src/command-gate.ts': 'cg1\n' });
  repo.commit('cg: command gate again', { 'src/command-gate.ts': 'cg2\n' });
  repo.commit('cg: host commands', { 'src/host-commands.ts': 'cg\n' });
  // The sweep's own propagation merge: the trunk RECEIVES, so the trunk is the
  // first parent and module/command-gate the second.
  repo.checkout('main_patched');
  repo.merge('module/command-gate', 'verify: merge module/command-gate');
  repo.commit('mp: trunk-only edit', { 'src/trunk.ts': 'trunk\n' });
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
    owned_paths: ['src/command-gate.ts'],
  }),
  feat({
    id: 'leaf',
    branch: 'feat/leaf',
    parents: ['module/command-gate'],
    // A declaration that lies: the trunk wrote src/trunk.ts, the leaf never has.
    owned_paths: ['src/trunk.ts'],
  }),
  feat({
    id: 'sweep',
    branch: 'feat/maintenance-sweep',
    parents: ['main_patched'],
    // …and another: four live entries claim src/command-gate.ts, none wrote it.
    owned_paths: ['scripts/sweep/**', 'src/command-gate.ts'],
  }),
];

/**
 * REPLACES the `branchCandidates — the OWNER RULE` suite, which built candidates
 * by matching `owned_paths`/`touch_paths` and asserted `owned` beats `touched`.
 * Both signals are gone: a declaration is not evidence, and the owned/touched
 * distinction it produced was a tie-break over aspirations. What survives is the
 * OWNER RULE itself (shallowest hierarchy depth first), now over git commits.
 */
describe('blameCandidates — authored commits, not declarations', () => {
  /**
   * THE DISCRIMINATOR. Rewritten from `a branch is a candidate iff it has OWN
   * commits touching the file`, which asserted `['main_patched']` with 2 commits
   * — the exact inversion the set difference produced live. This test FAILS
   * under `^parents` (the trunk owns the file, the module scores 0) and PASSES
   * under `--first-parent --no-merges ^main`.
   */
  it('the AUTHOR is credited, not the branch that ABSORBED the work by merge', async () => {
    const repo = blameRepo();
    // What the old rule saw: the trunk "owns" both commits, having absorbed them.
    expect(repo.git('rev-list', '--count', 'main_patched', '^main', '--', 'src/command-gate.ts')).toBe('2');
    expect(repo.git('rev-list', '--count', 'module/command-gate', '^main_patched', '--', 'src/command-gate.ts')).toBe('0');
    // What the first-parent line says: the merge is the trunk's only appearance,
    // and --no-merges drops it (live: 3 -> 0 for exactly this reason).
    expect(repo.git('rev-list', '--count', '--first-parent', 'main_patched', '^main', '--', 'src/command-gate.ts')).toBe('1');
    expect(
      repo.git('rev-list', '--count', '--first-parent', '--no-merges', 'main_patched', '^main', '--', 'src/command-gate.ts'),
    ).toBe('0');

    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    const cands = byFile.get('src/command-gate.ts')!;
    expect(cands[0].branch).toBe('module/command-gate');
    expect(cands[0].depth).toBe(2);
    expect(cands[0].commits).toBe(2);
    expect(cands.map((c) => c.branch)).not.toContain('main_patched');
  });

  it('the TRUNK is still a candidate for what it really authored, at depth 1', async () => {
    const repo = blameRepo();
    const byFile = await blameCandidates(repo.dir, ['src/trunk.ts'], liveShape);
    const cands = byFile.get('src/trunk.ts')!;
    expect(cands[0]).toMatchObject({ branch: 'main_patched', depth: 1, commits: 1 });
  });

  it('DECLARING the path is not evidence: the declarers are not candidates', async () => {
    const repo = blameRepo();
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts', 'src/trunk.ts'], liveShape);
    // touch_paths claims src/command-gate.ts; git says it never wrote a line of it.
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).not.toContain('feat/maintenance-sweep');
    // owned_paths claims src/trunk.ts; the trunk wrote it after the leaf was cut.
    expect(byFile.get('src/trunk.ts')!.map((c) => c.branch)).not.toContain('feat/leaf');
  });

  /**
   * REPLACES `INHERITED commits are not own commits — a descendant does not
   * answer for its parent`, which asserted the exclusion set removed a parent's
   * commits from a child. First-parent authorship draws the line differently and
   * more honestly: it removes what a branch ABSORBED (the case that broke live),
   * and NOT what a branch was CUT from. The two halves are asserted here and in
   * the test below, because the second one is a real consequence of the rule and
   * must be visible rather than discovered on production data.
   */
  it('ABSORBED work is not authored work — the receiver of a merge does not answer for the donor', async () => {
    const repo = blameRepo();
    // The trunk fully contains both commits by descent through the merge…
    expect(repo.git('rev-list', '--count', 'main_patched', '--', 'src/command-gate.ts')).toBe('2');
    // …and it is off its first-parent line, so the donor answers for them.
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).not.toContain('main_patched');
    // A branch CUT from the receiver inherits nothing across that merge either.
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).not.toContain('feat/maintenance-sweep');
  });

  it('a branch CUT from its author DOES inherit it — the OWNER RULE, not the count, resolves that', async () => {
    const repo = blameRepo();
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], liveShape);
    const cands = byFile.get('src/command-gate.ts')!;
    // feat/leaf was cut from module/command-gate, so the two edits sit on its own
    // first-parent line too. It is a candidate — and it loses, because the true
    // author is by construction an ancestor and therefore shallower.
    expect(cands.map((c) => c.branch)).toEqual(['module/command-gate', 'feat/leaf']);
    expect(cands.map((c) => c.depth)).toEqual([2, 3]);
  });

  it('candidates are ordered SHALLOWEST FIRST, over every branch including the trunk', async () => {
    const repo = blameRepo();
    // The trunk authored src/trunk.ts; feat/maintenance-sweep was cut from the
    // trunk afterwards and carries it on its own line at depth 2.
    const byFile = await blameCandidates(repo.dir, ['src/trunk.ts'], liveShape);
    const cands = byFile.get('src/trunk.ts')!;
    expect(cands.map((c) => c.branch)).toEqual(['main_patched', 'feat/maintenance-sweep']);
    expect(cands.map((c) => c.depth)).toEqual([1, 2]); // main=0; the trunk is 1
  });

  it('a branch with no ref anywhere is silently not a candidate (a planned entry has no history)', async () => {
    const repo = blameRepo();
    const withPlanned = [...liveShape, feat({ id: 'planned', branch: 'feat/never-created', parents: ['main_patched'] })];
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], withPlanned);
    expect(byFile.get('src/command-gate.ts')!.map((c) => c.branch)).toEqual(['module/command-gate', 'feat/leaf']);
  });

  it('an ORIGIN-ONLY branch still counts (§13: no local ref is not no history)', async () => {
    const repo = blameRepo();
    repo.checkout('feat/remote-only', { create: true, at: 'main_patched' });
    repo.commit('remote: author the file', { 'src/remote.ts': 'r\n' });
    repo.checkout('main');
    repo.setOrigin('feat/remote-only');
    repo.deleteLocalBranch('feat/remote-only');
    const features = [...liveShape, feat({ id: 'ro', branch: 'feat/remote-only', parents: ['main_patched'] })];
    const byFile = await blameCandidates(repo.dir, ['src/remote.ts'], features);
    expect(byFile.get('src/remote.ts')!.map((c) => c.branch)).toEqual(['feat/remote-only']);
  });

  /**
   * Evidence comes from the first-parent line, not from any per-branch
   * exclusion set. `parents` decides DEPTH only, so a broken edge costs the
   * branch its rank (UNRESOLVED sorts last) but never its evidence.
   */
  it('a broken `parents` edge keeps the branch in blame — it only costs it its depth', async () => {
    const repo = blameRepo();
    const broken = [
      feat({ id: 'leaf', branch: 'feat/leaf', parents: ['module/ghost'] }),
      feat({ id: 'cg', branch: 'module/command-gate', parents: ['main_patched'] }),
    ];
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts'], broken);
    const cands = byFile.get('src/command-gate.ts')!;
    expect(cands.map((c) => c.branch)).toEqual(['module/command-gate', 'feat/leaf']);
    expect(cands.map((c) => c.depth)).toEqual([2, null]); // UNRESOLVED sorts LAST, never as 0
  });

  it('an unresolvable `main` blames NOTHING rather than counting all of upstream', async () => {
    const repo = blameRepo();
    repo.checkout('main_patched');
    repo.deleteLocalBranch('main'); // no local ref, no origin/main either
    const byFile = await blameCandidates(repo.dir, ['src/command-gate.ts', 'src/trunk.ts'], liveShape);
    expect(byFile.get('src/command-gate.ts')).toEqual([]);
    expect(byFile.get('src/trunk.ts')).toEqual([]);
  });
});

describe('attributeFailure — the reference case, blamed by git history', () => {
  it('roots the fix on the branch that AUTHORED the defect, not the absorber, the declarer or the accused', async () => {
    const repo = blameRepo();
    const a = await attributeFailure(repo.dir, tsc('src/command-gate.ts'), liveShape, 'feat/mitm-credential-proxy');
    // NOT the accused, NOT feat/maintenance-sweep (which declares the path), and
    // NOT main_patched — the absorber a `^parents` set difference would answer,
    // having taken in the module's work by propagation merge.
    expect(a.branch).toBe('module/command-gate');
    expect(a.files).toEqual(['src/command-gate.ts']);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0]).toMatchObject({ branch: 'module/command-gate', depth: 2, files: ['src/command-gate.ts'] });
    expect(a.reason).toContain('module/command-gate');
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
    expect(a.perFile[0].reason).toContain('no branch authored commits');
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
 * The registry-glob matcher takes no part in blame; `globMatchAny` is
 * exercised by routing.test.ts / globs.test.ts, which own it. What matters
 * here is that blame reaches a real answer instead of falling back to the
 * accused branch, and that is what these assert, over git.
 */
describe('attributeFailure — BATCHING: one group per branch, shallowest first', () => {
  it('failing files spread over branches produce one group each, shallowest branch first', async () => {
    const repo = blameRepo();
    const a = await attributeFailure(
      repo.dir,
      // Deliberately out of hierarchy order in the output.
      tsc('src/leaf.ts', 'scripts/sweep/propagate.ts', 'src/command-gate.ts', 'src/trunk.ts'),
      liveShape,
      'feat/accused',
    );
    expect(a.groups.map((g) => g.branch)).toEqual([
      'main_patched',
      'feat/maintenance-sweep',
      'module/command-gate',
      'feat/leaf',
    ]);
    expect(a.groups.map((g) => g.depth)).toEqual([1, 2, 2, 3]);
    expect(a.groups.map((g) => g.files)).toEqual([
      ['src/trunk.ts'],
      ['scripts/sweep/propagate.ts'],
      ['src/command-gate.ts'],
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
    expect(a.groups.map((g) => g.branch)).toEqual(['module/command-gate']);
    expect(a.groups[0].files).toEqual(['src/command-gate.ts']); // the tied file is NOT smuggled in
    expect(a.unattributable.map((u) => u.file)).toEqual(['src/tie.ts']);
    expect(a.reason).toContain('cannot attribute');
  });
});
