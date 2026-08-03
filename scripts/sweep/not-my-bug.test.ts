/**
 * scripts/sweep/not-my-bug.test.ts — adjudicating `report-case --not-my-bug`.
 *
 * The reference case throughout is the live 2026-08-01 deadlock: a case that
 * resolved `src/cli/resources/groups.ts` was blocked by
 * `container/agent-runner/src/poll-loop.test.ts`, a bun test it never touched and
 * could not edit, whose internal 5000 ms deadline sits under bun's 5000 ms
 * timeout — so it fails or passes by luck under load. Every rule below exists
 * because that case would otherwise be decided wrongly:
 *
 *  - a bun failure names no file in the OLD parser, so nothing could be compared;
 *  - a single probe of a coin-flip test decides nothing, in either direction;
 *  - "the bug reproduces" is not the same claim as "you introduced nothing new";
 *  - a green-because-unbuildable commit is the classic bad bisect anchor.
 */
import { describe, expect, it } from 'vitest';

import { countFailingFiles, parseFailingFiles } from './attribute.js';
import {
  classifyFailure,
  findIntroducingCommit,
  locateOwner,
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
  it('roots on the BRANCH when its own tip is already red', async () => {
    const { probe } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('branch');
    expect(o.ref).toBe('branchtip0000');
  });

  it('roots on the PARENT when the branch is green and the incoming head is red', async () => {
    // Green must be seen TWICE per side before ownership moves on (rule 2).
    const { probe } = scriptedProbe([{ failing: {} }, { failing: {} }, { failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('parent');
    expect(o.ref).toBe('parenthead000');
  });

  it('a single flaky green at the branch tip does NOT move ownership onward', async () => {
    const { probe } = scriptedProbe([{ failing: {} }, { failing: { [POLL_LOOP]: 1 } }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('branch');
  });

  it('calls it an INTERACTION when both sides are green in isolation', async () => {
    const { probe } = scriptedProbe([{ failing: {} }]);
    const o = await locateOwner([POLL_LOOP], 'branchtip0000', 'parenthead000', probe);
    expect(o.owner).toBe('interaction');
    expect(o.ref).toBeNull();
  });

  it('does not probe a tip that does not CONTAIN the files — absence is the answer', async () => {
    const { probe, calls } = scriptedProbe([{ failing: { [POLL_LOOP]: 1 } }]);
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
