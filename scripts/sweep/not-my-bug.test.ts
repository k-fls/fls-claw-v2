/**
 * scripts/sweep/not-my-bug.test.ts — adjudicating `report-case --not-my-bug`.
 *
 * The reference case throughout is a deadlock shape: a case that
 * resolves `src/cli/resources/groups.ts` is blocked by
 * `container/agent-runner/src/poll-loop.test.ts`, a bun test it never touched and
 * cannot edit, whose internal 5000 ms deadline sits under bun's 5000 ms
 * timeout — so it fails or passes by luck under load. Every rule below exists
 * because that case would otherwise be decided wrongly:
 *
 *  - a bun failure names no file unless the parser reads the header, so nothing could be compared;
 *  - a single probe of a coin-flip test decides nothing, in either direction;
 *  - "the bug reproduces" is not the same claim as "you introduced nothing new";
 *  - a green-because-unbuildable commit is the classic bad bisect anchor.
 */
import { describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countFailingFiles, failingLocations, parseFailingFiles } from './attribute.js';
import { makeEnvAwareRunners } from './fixtures.js';
import {
  classifyEnvironmentFault,
  classifyFailure,
  findIntroducingCommit,
  locateOwner,
  partitionOwners,
  type History,
  type ProbeResult,
  type ProbeTarget,
  type SubsetProbe,
} from './not-my-bug.js';
import { subsetCommands } from './propagate.js';

const POLL_LOOP = 'container/agent-runner/src/poll-loop.test.ts';
const GROUPS = 'src/cli/resources/groups.ts';

/** A probe that replays scripted outcomes, in order, per target kind. */
function scriptedProbe(script: Array<Partial<ProbeResult> & { failing?: Record<string, number> }>): {
  probe: SubsetProbe;
  calls: Array<{ target: string; files: string[] }>;
} {
  const calls: Array<{ target: string; files: string[] }> = [];
  let i = 0;
  const probe: SubsetProbe = async (target: ProbeTarget, files: string[]) => {
    calls.push({ target: target.kind === 'worktree' ? 'worktree' : target.sha, files });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return {
      usable: step.usable ?? true,
      counts: new Map(Object.entries(step.failing ?? {})),
      output: step.output ?? '',
    };
  };
  return { probe, calls };
}

describe('countFailingFiles — bun output', () => {
  it('attributes `(fail)` lines to the file header above them', () => {
    const out = [
      'src/upload-trace.test.ts:',
      '[poll-loop] noise',
      'src/poll-loop.test.ts:',
      '[poll-loop] noise',
      '(fail) task-run turn wiring > logs and conditionally nudges a second task run [5000.64ms]',
      '  ^ this test timed out after 5000ms.',
      'src/mcp-tools/core.test.ts:',
      ' 154 pass',
      ' 1 fail',
    ].join('\n');
    expect(parseFailingFiles(out)).toEqual(['src/poll-loop.test.ts']);
  });

  it('counts each failing test, so a second failure in the same file is visible', () => {
    const out = ['src/a.test.ts:', '(fail) one', '(fail) two', 'src/b.test.ts:', '(fail) three'].join('\n');
    expect([...countFailingFiles(out)]).toEqual([
      ['src/a.test.ts', 2],
      ['src/b.test.ts', 1],
    ]);
  });

  it('a file header alone is not a failure — every file bun runs gets one', () => {
    expect(parseFailingFiles(['src/a.test.ts:', '[log] fine', 'src/b.test.ts:'].join('\n'))).toEqual([]);
  });

  it('still parses tsc diagnostics', () => {
    expect(parseFailingFiles('src/command-gate.ts(343,36): error TS2345: nope')).toEqual(['src/command-gate.ts']);
  });
});

describe('subsetCommands', () => {
  const CHECKS = [
    { cmd: 'pnpm test', cwd: '.', filter: 'pnpm test {files}' },
    { cmd: 'bun test', cwd: 'container/agent-runner', filter: 'bun test {files}' },
  ];

  it('routes a file to the command with the LONGEST matching cwd, not every match', () => {
    // The root command's cwd is a prefix of the bun one; without longest-match
    // both would run and the whole point (cheap probes) is lost.
    expect(subsetCommands(CHECKS, [POLL_LOOP])).toEqual([
      { cmd: `bun test 'src/poll-loop.test.ts'`, cwd: 'container/agent-runner' },
    ]);
  });

  it('makes paths relative to the command cwd and drops commands with no failing file', () => {
    expect(subsetCommands(CHECKS, [GROUPS])).toEqual([{ cmd: `pnpm test '${GROUPS}'`, cwd: '.' }]);
  });

  it('runs a filterless command WHOLE — a project typecheck cannot be narrowed to files', () => {
    const tsc = [{ cmd: 'pnpm run typecheck', cwd: '.' }];
    expect(subsetCommands(tsc, ['src/command-gate.ts'])).toEqual([{ cmd: 'pnpm run typecheck', cwd: '.' }]);
  });

  it('returns nothing when no command owns any failing file', () => {
    expect(subsetCommands([{ cmd: 'bun test', cwd: 'container/agent-runner' }], [GROUPS])).toEqual([]);
  });
});

describe('classifyFailure', () => {
  const resolved = new Map([[POLL_LOOP, 1]]);

  it('CONFIRMS on a single red probe — a tree without the edits cannot have been broken by them', async () => {
    const { probe, calls } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('pre-existing');
    expect(v.probes).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('prefixsha0000');
  });

  it('never REFUSES on a single green probe — the flake that re-deadlocked 08-01', async () => {
    // First baseline run comes back green by luck; the retry catches the truth.
    const { probe } = scriptedProbe([{ failing: {} }, { failing: { [POLL_LOOP]: 1 } }]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('pre-existing');
    expect(v.probes).toBe(2);
    expect(v.detail).toContain('second run');
  });

  it('REFUSES when the failure really is new, and names the files that are the agent’s', async () => {
    const { probe } = scriptedProbe([
      { failing: {} }, // baseline green
      { failing: {} }, // still green on retry
      { failing: { [GROUPS]: 1 } }, // and it reproduces on the resolved tree
    ]);
    const v = await classifyFailure(new Map([[GROUPS, 1]]), 'prefixsha0000', probe);
    expect(v.verdict).toBe('caused-by-case');
    expect(v.files).toEqual([GROUPS]);
  });

  it('calls it FLAKY when the "new" failure does not reproduce on the resolved tree either', async () => {
    const { probe } = scriptedProbe([{ failing: {} }, { failing: {} }, { failing: {} }]);
    const v = await classifyFailure(new Map([[GROUPS, 1]]), 'prefixsha0000', probe);
    expect(v.verdict).toBe('flaky');
  });

  it('COUNTS per file: a pre-existing failure must not absorb a newly introduced one', async () => {
    // Baseline fails once in the file; the resolution makes it fail twice. The
    // file SET is identical — only the count exposes the regression.
    const { probe } = scriptedProbe([
      { failing: { [POLL_LOOP]: 1 } },
      { failing: { [POLL_LOOP]: 1 } },
      { failing: { [POLL_LOOP]: 2 } },
    ]);
    const v = await classifyFailure(new Map([[POLL_LOOP, 2]]), 'prefixsha0000', probe);
    expect(v.verdict).toBe('caused-by-case');
  });

  it('is UNDECIDABLE, not confirmed, when the pre-conflict tree will not build', async () => {
    const { probe } = scriptedProbe([{ usable: false }]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('undecidable');
  });

  it('is UNDECIDABLE when the failing output named no file at all', async () => {
    const { probe } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
    const v = await classifyFailure(new Map(), 'prefixsha0000', probe);
    expect(v.verdict).toBe('undecidable');
    expect(v.probes).toBe(0);
  });
});

describe('locateOwner', () => {
  it('roots on the BRANCH when its own tip is red TWICE', async () => {
    const { probe, calls } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('branch');
    expect(o.ref).toBe('branchtip0000');
    // A red here ACCUSES — it roots a gate fix on the branch and opens a PR
    // against it — so it is re-run on the identical tree before it is believed.
    expect(calls).toHaveLength(2);
  });

  it('a red that does not reproduce at the branch tip blames NOBODY', async () => {
    const { probe } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }, { failing: {} }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('flaky');
    expect(o.ref).toBeNull();
    expect(o.detail).toContain('unstable');
  });

  it('skips the confirming probe when the pass already confirmed that tree', async () => {
    const { probe, calls } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe, {
      confirmedRed: async (sha) => sha === 'branchtip0000',
    });
    expect(o.owner).toBe('branch');
    // Paid once per (tree, commands) — the landing gate already re-ran these.
    expect(calls).toHaveLength(1);
  });

  it('roots on the PARENT when the branch is green twice and the incoming head is red twice', async () => {
    // Neither answer is believed on one run: two greens to move ownership on,
    // two reds to accuse the side it lands on.
    const { probe } = scriptedProbe([
      { failing: {} },
      { failing: {} },
      { failing: { [POLL_LOOP]: 1 } },
      { failing: { [POLL_LOOP]: 1 } },
    ]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('parent');
    expect(o.ref).toBe('parenthead000');
  });

  it('a single flaky green at the branch tip does NOT move ownership onward', async () => {
    const { probe } = scriptedProbe([{ failing: {} }, { failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    // Ownership stays put — and the branch is not accused either: one green and
    // one red on the same tree is a disagreement, not a verdict about a side.
    expect(o.owner).toBe('flaky');
  });

  it('calls it an INTERACTION when both sides are green in isolation', async () => {
    const { probe } = scriptedProbe([{ failing: {} }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('interaction');
    expect(o.ref).toBeNull();
  });

  it('says PER SIDE which kind of green it was, and against which ref', async () => {
    // A probed green and a vacuous one are different facts. Undifferentiated,
    // the sentence reads as a claim about both tips — the file exists at
    // neither — and a reader relaying it states something nothing measured.
    const { probe } = scriptedProbe([{ failing: {} }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe, {
      hasAnyFile: async (sha) => sha !== 'parenthead000',
    });
    expect(o.owner).toBe('interaction');
    expect(o.detail).toContain('probed green twice at the branch tip branchtip000');
    expect(o.detail).toContain('absent at the parent head parenthead00 (cannot fail there)');
  });

  it('a side that WAS probed is never described as absent', async () => {
    const { probe } = scriptedProbe([{ failing: {} }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.detail).toContain('probed green twice at the branch tip branchtip000');
    expect(o.detail).toContain('probed green twice at the parent head parenthead00');
    expect(o.detail).not.toContain('absent');
  });

  it('does not probe a tip that does not CONTAIN the files — absence is the answer', async () => {
    const { probe, calls } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }, { failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe, {
      hasAnyFile: async (sha) => sha !== 'branchtip0000',
    });
    // The branch tip predates the file (the usual case — the test arrived with
    // the merge), so it is green by absence and never run; the parent decides.
    expect(calls.every((c) => c.target !== 'branchtip0000')).toBe(true);
    expect(o.owner).toBe('parent');
  });

  it('is UNKNOWN rather than interaction when a side would not build', async () => {
    const { probe } = scriptedProbe([{ usable: false }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('unknown');
  });
});

describe('partitionOwners', () => {
  /** A probe keyed on the TREE it is asked about, intersected with the ask. */
  function treeProbe(byTree: Record<string, string[]>): {
    probe: SubsetProbe;
    calls: Array<{ target: string; files: string[] }>;
  } {
    const calls: Array<{ target: string; files: string[] }> = [];
    const probe: SubsetProbe = async (target: ProbeTarget, files: string[]) => {
      const sha = target.kind === 'worktree' ? 'worktree' : target.sha;
      calls.push({ target: sha, files });
      const red = byTree[sha] ?? [];
      return { usable: true, counts: new Map(files.filter((f) => red.includes(f)).map((f) => [f, 1])), output: '' };
    };
    return { probe, calls };
  }

  it('a SINGLE owner costs exactly one locate round', async () => {
    const { probe, calls } = treeProbe({ tip: ['a.ts', 'b.ts'] });
    const p = await partitionOwners(['a.ts', 'b.ts'], 'tip', 'parent', probe);
    expect(p.rounds).toBe(1);
    expect(p.groups).toEqual([{ owner: 'branch', ref: 'tip', files: ['a.ts', 'b.ts'], detail: expect.any(String) }]);
    expect(p.remainder).toBeNull();
    // One VERDICT at the tip settles the WHOLE set, so nothing is left to re-ask
    // about: the ordinary single-owner failure pays nothing for partitioning.
    // The two calls are the one accusation and its confirming re-run.
    expect(calls).toHaveLength(2);
  });

  it('splits a failure across BOTH sides and names what neither side owns', async () => {
    const { probe } = treeProbe({ tip: ['a.ts'], parent: ['a.ts', 'b.ts'] });
    const p = await partitionOwners(['a.ts', 'b.ts', 'c.ts'], 'tip', 'parent', probe);
    // One verdict describes a SUBSET. Taken as the whole story, `b.ts` is either
    // charged to the branch — which is green in it — or dropped, and `c.ts` with it.
    expect(p.groups).toEqual([
      { owner: 'branch', ref: 'tip', files: ['a.ts'], detail: expect.any(String) },
      { owner: 'parent', ref: 'parent', files: ['b.ts'], detail: expect.any(String) },
    ]);
    expect(p.remainder!.kind).toBe('interaction');
    expect(p.remainder!.files).toEqual(['c.ts']);
    expect(p.rounds).toBe(3);
  });

  it('merges a same-owner re-hit instead of grouping one ref twice', async () => {
    // The tip reports `a.ts` first and `b.ts` on the re-ask. Two groups on one ref
    // become two competing gate fixes on one branch for one defect.
    // Each answer is given TWICE, since a red is only believed when it repeats.
    let seen = 0;
    const probe: SubsetProbe = async (target: ProbeTarget, files: string[]) => {
      const sha = target.kind === 'worktree' ? 'worktree' : target.sha;
      const red = sha === 'tip' ? (seen++ < 2 ? ['a.ts'] : ['b.ts']) : [];
      return { usable: true, counts: new Map(files.filter((f) => red.includes(f)).map((f) => [f, 1])), output: '' };
    };
    const p = await partitionOwners(['a.ts', 'b.ts'], 'tip', 'parent', probe);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].files).toEqual(['a.ts', 'b.ts']);
    expect(p.rounds).toBe(2);
  });

  it('an unbuildable side leaves the rest UNKNOWN rather than unaccounted for', async () => {
    const { probe } = treeProbe({ tip: ['a.ts'] });
    const unusable: SubsetProbe = async (target, files) => {
      if (target.kind === 'commit' && target.sha === 'tip' && files.includes('a.ts')) return probe(target, files);
      return { usable: false, counts: new Map(), output: '' };
    };
    const p = await partitionOwners(['a.ts', 'b.ts'], 'tip', 'parent', unusable);
    expect(p.groups.map((g) => g.files)).toEqual([['a.ts']]);
    expect(p.remainder).toEqual({ kind: 'unknown', files: ['b.ts'], ref: null, detail: expect.any(String) });
  });
});

describe('findIntroducingCommit', () => {
  /** A linear history c0..c9 where the failure appears at `firstRed`. */
  function linearHistory(opts: { unbuildable?: Set<string>; missingFile?: Set<string> } = {}): History {
    const commits = Array.from({ length: 10 }, (_, i) => `c${i}`); // c9 = tip
    return {
      ancestor: async (_ref, back) => commits[commits.length - 1 - back] ?? null,
      listFirstParent: async (from, to) =>
        commits.slice(commits.indexOf(from) + 1, commits.indexOf(to) + 1),
      hasAnyFile: async (sha) => !(opts.missingFile?.has(sha) ?? false),
    };
  }
  const redFrom = (firstRed: number, unbuildable = new Set<string>()): SubsetProbe => async (target) => {
    const sha = target.kind === 'commit' ? target.sha : 'worktree';
    if (unbuildable.has(sha)) return { usable: false, counts: new Map(), output: '' };
    const n = Number(sha.slice(1));
    return { usable: true, counts: n >= firstRed ? new Map([[POLL_LOOP, 1]]) : new Map(), output: '' };
  };

  it('finds the first commit where the failure appears', async () => {
    const r = await findIntroducingCommit('c9', [POLL_LOOP], redFrom(6), linearHistory());
    expect(r.status).toBe('found');
    expect(r.sha).toBe('c6');
  });

  it('refuses to bisect a coin flip — a random commit presented as the cause is worse than none', async () => {
    let n = 0;
    const flapping: SubsetProbe = async () => ({
      usable: true,
      counts: n++ % 2 === 0 ? new Map([[POLL_LOOP, 1]]) : new Map(),
      output: '',
    });
    const r = await findIntroducingCommit('c9', [POLL_LOOP], flapping, linearHistory());
    expect(r.status).toBe('flaky');
  });

  it('reports NO-ANCHOR when the failure predates the whole search window', async () => {
    const r = await findIntroducingCommit('c9', [POLL_LOOP], redFrom(0), linearHistory());
    expect(r.status).toBe('no-anchor');
  });

  it('treats a commit that PREDATES the file as a green boundary — absence beats any run', async () => {
    const history = linearHistory({ missingFile: new Set(['c5']) });
    const r = await findIntroducingCommit('c9', [POLL_LOOP], redFrom(7), history);
    expect(r.status).toBe('found');
    expect(r.sha).toBe('c7');
  });

  it('names the commit that ADDED a failing test, instead of reporting no-anchor', async () => {
    // The file arrives at c6 and fails from then on: every earlier commit lacks
    // it. Skipping those (the first cut) left nothing to anchor on and the answer
    // was `no-anchor` — for a history where the introducer is exactly identifiable.
    const history = linearHistory({ missingFile: new Set(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) });
    const r = await findIntroducingCommit('c9', [POLL_LOOP], redFrom(6), history);
    expect(r.status).toBe('found');
    expect(r.sha).toBe('c6');
  });

  it('SKIPS an unbuildable candidate rather than counting it as a pass', async () => {
    const r = await findIntroducingCommit('c9', [POLL_LOOP], redFrom(6, new Set(['c7'])), linearHistory());
    expect(r.status).toBe('found');
    expect(r.sha).toBe('c6');
  });
});

describe('classifyEnvironmentFault', () => {
  // The real shape: an install run with --ignore-scripts, so the
  // native addon never compiles and every DB-touching suite dies at require time.
  const BINDINGS = [
    ' FAIL  src/modules/scheduling/recurrence.test.ts > handleRecurrence',
    'Error: Could not locate the bindings file. Tried:',
    ' → /workspace/agent/deps-pool/5ab85288ee4a/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ' ❯ new Database ../../../../deps-pool/5ab85288ee4a/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/database.js:48:64',
  ].join('\n');

  it('recognises a missing native binding as an ENVIRONMENT fault', () => {
    const v = classifyEnvironmentFault(BINDINGS);
    expect(v.isEnvironment).toBe(true);
    expect(v.detail).toContain('ENVIRONMENT fault');
    expect(v.detail).toContain('node_modules/deps-pool');
  });

  it('does NOT claim environment when a real assertion is present', () => {
    // A resolution that breaks code AND happens to log a resolution error must
    // stay a code defect — otherwise a real regression is written off as infra.
    expect(classifyEnvironmentFault(`${BINDINGS}\nAssertionError: expected 3 to be 4`).isEnvironment).toBe(false);
    expect(classifyEnvironmentFault(`${BINDINGS}\nsrc/x.ts(3,1): error TS2345: nope`).isEnvironment).toBe(false);
  });

  it('leaves an ordinary test failure alone', () => {
    const out = ['src/a.test.ts:', '(fail) does the thing', 'AssertionError: expected true to be false'].join('\n');
    expect(classifyEnvironmentFault(out).isEnvironment).toBe(false);
  });

  it('recognises an unresolvable module and a missing binary', () => {
    expect(classifyEnvironmentFault("Error: Cannot find module 'node-forge'").isEnvironment).toBe(true);
    expect(classifyEnvironmentFault('sh: 1: vitest: command not found').isEnvironment).toBe(true);
  });
});

describe('findIntroducingCommit — full-command fallback and last-failed rooting', () => {
  function linear(): History {
    const commits = Array.from({ length: 10 }, (_, i) => `c${i}`);
    return {
      ancestor: async (_r, back) => commits[commits.length - 1 - back] ?? null,
      listFirstParent: async (from, to) => commits.slice(commits.indexOf(from) + 1, commits.indexOf(to) + 1),
      hasAnyFile: async () => true,
    };
  }
  const never: SubsetProbe = async () => ({ usable: true, counts: new Map(), output: '' });
  const redFrom = (n: number): SubsetProbe => async (t) => ({
    usable: true,
    counts: t.kind === 'commit' && Number(t.sha.slice(1)) >= n ? new Map([[POLL_LOOP, 1]]) : new Map(),
    output: '',
  });

  it('falls back to the FULL command when the narrowed form does not reproduce', async () => {
    // A load-dependent failure: narrowed it passes (no load), whole it fails.
    const r = await findIntroducingCommit('c9', [POLL_LOOP], never, linear(), redFrom(6));
    expect(r.status).toBe('found');
    expect(r.sha).toBe('c6');
    expect(r.usedFullCommand).toBe(true);
  });

  it('is flaky only when NEITHER form reproduces — and still names the tip as a root', async () => {
    const r = await findIntroducingCommit('c9', [POLL_LOOP], never, linear(), never);
    expect(r.status).toBe('flaky');
    // The tip is a confirmed failure (the checks gate just reported it), so the
    // gate fix has somewhere to land even with no commit named.
    expect(r.lastFailed).toBe('c9');
  });

  it('never searches BELOW the floor — a failure older than the trunk head is not this branch’s to root', async () => {
    // Unfloored, a bisect can name a commit hundreds of commits behind the
    // branch tip: the case worktree becomes a weeks-old tree and the checks gate
    // demands THAT suite green — red in a second, unrelated file whose fix has
    // not been written yet. One test in scope, a whole pre-history demanded green.
    const commits = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const probed: string[] = [];
    const alwaysRed: SubsetProbe = async (t) => {
      if (t.kind === 'commit') probed.push(t.sha);
      return { usable: true, counts: new Map([[POLL_LOOP, 1]]), output: '' };
    };
    const history: History = {
      ancestor: async (_r, back) => commits[commits.length - 1 - back] ?? null,
      listFirstParent: async (from, to) => commits.slice(commits.indexOf(from) + 1, commits.indexOf(to) + 1),
      hasAnyFile: async () => true,
      // The floor is c7: c8/c9 contain it, c6 and older do not.
      contains: async (sha, anc) => Number(sha.slice(1)) >= Number(anc.slice(1)),
    };
    const r = await findIntroducingCommit('c9', [POLL_LOOP], alwaysRed, history, undefined, 'c7');
    expect(r.status).toBe('no-anchor');
    // Nothing below the floor was ever probed — bounding the SEARCH, not
    // clamping its answer, is what makes the probes cheap.
    expect(probed.every((c) => Number(c.slice(1)) >= 7)).toBe(true);
    // ...and the report says the failure predates this branch's own history.
    expect(r.detail).toContain('trunk head');
  });

  it('reports the OLDEST OBSERVED red as lastFailed when the search cannot converge', async () => {
    // Red everywhere, so no green anchor exists. The walk-back probes c8, c7, c5
    // and c1 (steps 1,2,4,8) and then runs out of history — c0 is never probed.
    // `lastFailed` is c1, NOT c0: it is what the search SAW, never what it could
    // infer. That distinction is the whole point of rooting there — the PR says
    // "oldest point the failure was observed", which is a claim we can defend.
    const r = await findIntroducingCommit('c9', [POLL_LOOP], redFrom(0), linear());
    expect(r.status).toBe('no-anchor');
    expect(r.lastFailed).toBe('c1');
  });
});

describe('environment faults never become code blame', () => {
  const { install, checks } = makeEnvAwareRunners({ native: ['better-sqlite3'], skipScripts: true });

  it('a native package installed WITHOUT its addon reads as an environment fault', async () => {
    // `--ignore-scripts`, exactly: the package is present, the compiled addon is
    // not, and every suite that opens a database dies at require time.
    const wt = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '11' } }));
    expect(await install(wt)).toBe(true);
    const r = await checks([{ cmd: 'pnpm test' }], wt);
    expect(r.ok).toBe(false);
    const v = classifyEnvironmentFault(r.output);
    expect(v.isEnvironment).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  it('a DECLARED dependency that was never installed reads as an environment fault (TS2307)', async () => {
    // Upstream declares `yaml`; the environment predates the merge that brings
    // it. A wholesale `error TS…` veto here would make the classifier dead code
    // for the entire typecheck kind.
    const wt = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ dependencies: { yaml: '2' } }));
    mkdirSync(join(wt, 'node_modules'), { recursive: true }); // installed, but not `yaml`
    const r = await checks([{ cmd: 'pnpm run typecheck' }], wt);
    expect(r.output).toContain('TS2307');
    expect(classifyEnvironmentFault(r.output).isEnvironment).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });

  it('an ORDINARY compile error is still a code defect, not an environment fault', async () => {
    expect(classifyEnvironmentFault('src/x.ts(3,1): error TS2345: wrong type').isEnvironment).toBe(false);
    // ...and a resolution error sitting next to a real one stays code.
    expect(
      classifyEnvironmentFault(
        ["src/a.ts(1,1): error TS2307: Cannot find module 'yaml'", 'src/b.ts(2,2): error TS2345: wrong type'].join('\n'),
      ).isEnvironment,
    ).toBe(false);
  });

  it('ONE environment answers for TWO different trees — the reuse that made it six pools', async () => {
    // Not one bad install: one bad environment gets reused for
    // every tree that shares its manifests. Two trees, one broken environment,
    // both must report the fault rather than blaming their own code.
    const a = mkdtempSync(join(tmpdir(), 'env-a-'));
    const b = mkdtempSync(join(tmpdir(), 'env-b-'));
    for (const wt of [a, b]) {
      writeFileSync(join(wt, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '11' } }));
      await install(wt);
    }
    for (const wt of [a, b]) {
      expect(classifyEnvironmentFault((await checks([{ cmd: 'bun test' }], wt)).output).isEnvironment).toBe(true);
    }
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});

describe('breadth backstop — an experiment that distinguished nothing', () => {
  it('identical failures with the runner reporting ZERO passes is UNDECIDABLE, not pre-existing', async () => {
    // An environment fault is anomalous not for the file COUNT but because not
    // one test passes anywhere — which is what a broken toolchain looks like.
    // The fixture SAYS that outright rather than leaving a breadth threshold
    // to stand in for it.
    const files = Array.from({ length: 44 }, (_, i) => `src/f${i}.test.ts`);
    const resolved = new Map(files.map((f) => [f, 1]));
    const { probe } = scriptedProbe([
      { failing: Object.fromEntries(files.map((f) => [f, 1])), output: ' 0 pass  44 fail\n' },
    ]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('undecidable');
    expect(v.detail).toContain('ZERO passing tests');
  });

  it('a BROAD defect with the suite otherwise green is confirmed — breadth is not the signal', async () => {
    // 12 files failing identically on both trees, but the runner reports plenty
    // of passes: the toolchain works, so this is a real pre-existing defect and
    // must be routed to its owner. Under the old `IMPLAUSIBLE_BREADTH = 10` this
    // was `undecidable` FOREVER — identical counts mean `hasControl` is false,
    // so no number of probes could ever confirm it.
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.test.ts`);
    const resolved = new Map(files.map((f) => [f, 1]));
    const { probe } = scriptedProbe([
      { failing: Object.fromEntries(files.map((f) => [f, 1])), output: ' 1163 pass  12 fail\n' },
    ]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('pre-existing');
  });

  it('NO reported counts is not evidence of a dead toolchain (a clean tsc prints nothing)', async () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const resolved = new Map(files.map((f) => [f, 1]));
    const { probe } = scriptedProbe([
      { failing: Object.fromEntries(files.map((f) => [f, 1])), output: 'src/f0.ts(1,1): error TS2345: nope\n' },
    ]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('pre-existing');
  });

  it('the ordinary one-file case is UNAFFECTED — identity is the normal confirming shape', async () => {
    const { probe } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
    const v = await classifyFailure(new Map([[POLL_LOOP, 1]]), 'prefixsha0000', probe);
    expect(v.verdict).toBe('pre-existing');
  });

  it('a discriminating observation confirms even with zero reported passes', async () => {
    // The baseline fails MORE than the case somewhere: the checks demonstrably
    // still distinguish trees, so breadth alone is not suspicious.
    const files = Array.from({ length: 44 }, (_, i) => `src/f${i}.test.ts`);
    const resolved = new Map(files.map((f) => [f, 1]));
    const baseline = Object.fromEntries(files.map((f) => [f, 1]));
    baseline['src/f0.test.ts'] = 3;
    const { probe } = scriptedProbe([{ failing: baseline, output: ' 0 pass  44 fail\n' }]);
    const v = await classifyFailure(resolved, 'prefixsha0000', probe);
    expect(v.verdict).toBe('pre-existing');
  });
});


// --- an unresolved RELATIVE import is the agent's own defect ----------------
//
// The veto ("nothing that looks like an assertion") cannot catch this: typecheck
// short-circuits before the tests, so the only output this function ever sees is
// a typecheck log, which can never contain an assertion. A lone TS2307 also
// carries no other TS error to veto with. So the doc comment's own
// counterexample — "a resolution that deleted an import" — was classified as an
// ENVIRONMENT fault, halting the sweep to tell the agent not to fix a broken
// import it had just written.
describe('classifyEnvironmentFault — which dependency tree the diagnostic is about', () => {
  it("a relative specifier is the repo's own tree: code defect, the agent fixes it", () => {
    const v = classifyEnvironmentFault(
      "src/router.ts(12,24): error TS2307: Cannot find module './command-gate' or its corresponding type declarations.\n",
    );
    expect(v.isEnvironment).toBe(false);
  });

  it('a bare specifier is the dependency tree: still an environment fault', () => {
    const v = classifyEnvironmentFault(
      "src/config.ts(3,18): error TS2307: Cannot find module 'yaml' or its corresponding type declarations.\n",
    );
    expect(v.isEnvironment).toBe(true);
    expect(v.signature).toContain('TS');
  });

  it('a MIX still reads as environment — one unresolvable package is enough to break the run', () => {
    const v = classifyEnvironmentFault(
      "src/a.ts(1,1): error TS2307: Cannot find module './local'.\n" +
        "src/b.ts(2,1): error TS2307: Cannot find module 'yaml'.\n",
    );
    expect(v.isEnvironment).toBe(true);
  });

  it('the non-TS signatures are unaffected (no module specifier to read)', () => {
    expect(classifyEnvironmentFault('Error: Could not locate the bindings file').isEnvironment).toBe(true);
  });
});

// --- failing locations in the gate-fix briefing ----------------------------
describe('failingLocations — the coordinates the output already carries', () => {
  it('BUN: carries the file down from the header and names the failing TEST (there is no line number)', () => {
    // Bun names the file ONCE as a header and the `(fail)` line
    // carries neither a file nor a line — only a test name. `checks.test` is a
    // bun command, so this is THE shape that matters: missing it would silently
    // omit the section from every gate-fix briefing.
    const out = [
      '[poll-loop] Duplicate result event — skipping',
      'src/poll-loop.test.ts:',
      '(fail) task-run turn wiring (real processQuery) > nudges a second task run [5000.54ms]',
      '  ^ this test timed out after 5000ms.',
      '',
      'src/mcp-tools/core.test.ts:',
      '(fail) core > rejects a bad tool name [12.00ms]',
    ].join('\n');
    const locs = failingLocations(out);
    expect(locs[0]).toBe('src/poll-loop.test.ts — "task-run turn wiring (real processQuery) > nudges a second task run"');
    expect(locs[1]).toBe('src/mcp-tools/core.test.ts — "core > rejects a bad tool name"');
  });

  it('a bun header does not stay armed across a `$ <cmd>` boundary', () => {
    const out = ['src/a.test.ts:', '$ pnpm test', '(fail) belongs to the NEXT command'].join('\n');
    expect(failingLocations(out)).toEqual([]);
  });

  it('pulls file:line out of vitest frames, tsc diagnostics and stack traces', () => {
    const out = [
      ' FAIL  src/cli/resources/groups.create.test.ts > errors when required fields are missing',
      'AssertionError: expected true to be false',
      ' ❯ src/cli/resources/groups.create.test.ts:85:21',
      'container/agent-runner/src/poll-loop.ts(412,7): error TS2345: nope',
      '    at drainSession (/repo/container/agent-runner/src/delivery.ts:204:37)',
      '    at node_modules/vitest/dist/chunk.js:99:1',
    ].join('\n');
    const locs = failingLocations(out);
    expect(locs).toContain('src/cli/resources/groups.create.test.ts:85');
    expect(locs).toContain('container/agent-runner/src/poll-loop.ts:412');
    expect(locs.some((l) => l.includes('delivery.ts:204'))).toBe(true);
    // The runner's own frames are not the defect.
    expect(locs.some((l) => l.includes('node_modules'))).toBe(false);
  });

  it('an absolute worktree frame is REPO-ROOTED — the agent must be able to open it', () => {
    // An absolute worktree frame like
    //   /workspace/agent/propagation/pass-743e32df4e6c/<case>/worktree/src/x.ts:153
    // is unopenable twice over — it names a DIFFERENT pass (checks output is
    // captured before the case is minted, carrying the tree it ran in) and that
    // directory is gone after a clean-slate.
    const out = [
      '    at Object.<anonymous> (/workspace/agent/propagation/pass-743e/c/worktree/src/modules/a/route.ts:153:7)',
      ' ❯ src/delivery.test.ts:88:3',
      '/repo/node_modules/vitest/dist/chunk.js:99:1',
      '    at /etc/somewhere/else.ts:12:1',
    ].join('\n');
    expect(failingLocations(out)).toEqual(['src/modules/a/route.ts:153', 'src/delivery.test.ts:88']);
  });

  it('dedupes repeated frames and caps the list — a trace is not a to-do list', () => {
    const frame = ' ❯ src/a.test.ts:10:2\n';
    expect(failingLocations(frame.repeat(30))).toEqual(['src/a.test.ts:10']);
    const many = Array.from({ length: 40 }, (_, i) => ` ❯ src/f${i}.test.ts:${i + 1}:1`).join('\n');
    expect(failingLocations(many).length).toBe(12);
  });

  it('returns nothing when the output names no file (the caller then omits the section)', () => {
    expect(failingLocations('boom\nexit status 1')).toEqual([]);
  });
});
