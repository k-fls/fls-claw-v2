/**
 * scripts/sweep/deps-missing.test.ts — the missing-declaration classifier and
 * the bounded advance (DRIVER.md §7.7). The advance's git and checks work is
 * injected, so every walk here is exact: the tests state what each step lands
 * and what the tree says afterwards, and read the outcome off that.
 */
import { describe, expect, it } from 'vitest';

import {
  DEPS_MISSING_ADVANCE_LIMIT,
  advanceThroughDepsMissing,
  classifyDepsMissing,
  missingDeclPattern,
  namedSymbols,
  splitChecksOutput,
  survivingKeys,
  type AdvanceOps,
  type AdvanceStep,
} from './deps-missing.js';

const TS_RE = 'error TS(2305|2307|2724):';
const typecheck = { cmd: 'pnpm run typecheck', cwd: '.', missingDeclRe: TS_RE };
const tests = { cmd: 'pnpm test', cwd: '.' };

/** One tsc diagnostic line, in the shape `parseFailureFingerprints` reads. */
function tsLine(file: string, line: number, code: string, message: string): string {
  return `${file}(${line},7): error ${code}: ${message}`;
}
const MISSING = tsLine('src/request.ts', 12, 'TS2305', `Module '"./split.js"' has no exported member 'handleAddMcpServer'.`);

describe('classifyDepsMissing', () => {
  it('classifies a red whose every failing command reports a missing declaration', () => {
    const v = classifyDepsMissing([typecheck], `$ ${typecheck.cmd}\n${MISSING}\n`);
    expect(v.depsMissing).toBe(true);
    expect(v.files).toEqual(['src/request.ts']);
    expect(v.errorKeys).toEqual([
      `ts src/request.ts TS2305 Module '"./split.js"' has no exported member 'handleAddMcpServer'.`,
    ]);
    expect(v.lines).toEqual([MISSING]);
  });

  it('does NOT classify a failure whose diagnostics are ordinary type errors', () => {
    const out = `$ ${typecheck.cmd}\n${tsLine('src/request.ts', 12, 'TS2322', 'Type X is not assignable to type Y.')}\n`;
    const v = classifyDepsMissing([typecheck], out);
    expect(v.depsMissing).toBe(false);
    expect(v.errorKeys).toEqual([]);
    expect(v.reason).toContain('not missing declarations');
  });

  it('a command with NO missingDeclRe never classifies, whatever its output says', () => {
    const v = classifyDepsMissing([tests], `$ ${tests.cmd}\n${MISSING}\n`);
    expect(v.depsMissing).toBe(false);
    expect(v.reason).toContain('declares no missingDeclRe');
  });

  it('ONE ordinary failure alongside the missing declarations sinks the whole classification', () => {
    const other = { cmd: 'bun test', cwd: 'container/agent-runner', missingDeclRe: TS_RE };
    const out = [`$ ${typecheck.cmd}`, MISSING, `$ ${other.cmd}`, '(fail) queue > drains [1.00ms]', ''].join('\n');
    expect(classifyDepsMissing([typecheck, other], out).depsMissing).toBe(false);
  });

  it('an ordinary error BELOW the missing declaration in the SAME block sinks it too', () => {
    const ordinary = tsLine('src/request.ts', 40, 'TS2322', 'Type X is not assignable to type Y.');
    const v = classifyDepsMissing([typecheck], [`$ ${typecheck.cmd}`, MISSING, ordinary, ''].join('\n'));
    expect(v.depsMissing).toBe(false);
    expect(v.errorKeys).toEqual([]);
    expect(v.reason).toContain('not missing declarations');
    // The offender is NAMED, so the journal says which error refused the walk.
    expect(v.reason).toContain('TS2322');
  });

  it('an ordinary error ABOVE the missing declaration in the SAME block sinks it too', () => {
    const ordinary = tsLine('src/other.ts', 3, 'TS2322', 'Type X is not assignable to type Y.');
    const v = classifyDepsMissing([typecheck], [`$ ${typecheck.cmd}`, ordinary, MISSING, ''].join('\n'));
    expect(v.depsMissing).toBe(false);
    expect(v.reason).toContain('not missing declarations');
  });

  it('TWO missing declarations in one block still classify — the rule is per ERROR, not per line count', () => {
    const second = tsLine('src/other.ts', 8, 'TS2307', `Cannot find module './split.js' or its corresponding type declarations.`);
    const v = classifyDepsMissing([typecheck], [`$ ${typecheck.cmd}`, MISSING, second, ''].join('\n'));
    expect(v.depsMissing).toBe(true);
    expect(v.files).toEqual(['src/other.ts', 'src/request.ts']);
    expect(v.errorKeys).toHaveLength(2);
  });

  it('a BROKEN pattern is journaled as broken, not as absent', () => {
    const broken = { cmd: 'pnpm run typecheck', cwd: '.', missingDeclRe: 'error TS(2305' };
    expect(classifyDepsMissing([broken], `$ ${broken.cmd}\n${MISSING}\n`).reason).toContain('does not compile');
  });

  it('the error set carries NO line or column, so an edit above the import is the same error', () => {
    const before = classifyDepsMissing([typecheck], `$ ${typecheck.cmd}\n${MISSING}\n`);
    const moved = tsLine('src/request.ts', 40, 'TS2305', `Module '"./split.js"' has no exported member 'handleAddMcpServer'.`);
    const after = classifyDepsMissing([typecheck], `$ ${typecheck.cmd}\n${moved}\n`);
    expect(after.errorKeys).toEqual(before.errorKeys);
  });

  it('an UNCOMPILABLE pattern classifies nothing rather than matching everything', () => {
    const broken = { cmd: 'pnpm run typecheck', cwd: '.', missingDeclRe: 'error TS(2305' };
    expect(missingDeclPattern(broken)).toBeNull();
    expect(classifyDepsMissing([broken], `$ ${broken.cmd}\n${MISSING}\n`).depsMissing).toBe(false);
  });

  it('matched lines that name no file yield no signature to walk toward', () => {
    const out = `$ ${typecheck.cmd}\nerror TS2307: Cannot find module 'left-pad'.\n`;
    const v = classifyDepsMissing([typecheck], out);
    expect(v.depsMissing).toBe(false);
    expect(v.reason).toContain('no comparable error signature');
  });

  it('no failing command at all classifies nothing', () => {
    expect(classifyDepsMissing([], MISSING).depsMissing).toBe(false);
  });
});

describe('splitChecksOutput', () => {
  it('attributes each block to the command whose header opened it', () => {
    const out = [`$ ${typecheck.cmd}`, 'a', `$ ${tests.cmd}`, 'b', ''].join('\n');
    const blocks = splitChecksOutput(out, [typecheck, tests]);
    expect(blocks.get(typecheck.cmd)).toBe('a');
    expect(blocks.get(tests.cmd)).toBe('b\n');
  });

  it('unheaded output belongs to the single failing command, and to no one when there are two', () => {
    expect(splitChecksOutput('a\nb', [typecheck]).get(typecheck.cmd)).toBe('a\nb');
    expect(splitChecksOutput('a\nb', [typecheck, tests]).size).toBe(0);
  });
});

describe('survivingKeys', () => {
  it('reads the ORIGINAL keys against the WHOLE later output, not its matched lines', () => {
    const keys = classifyDepsMissing([typecheck], `$ ${typecheck.cmd}\n${MISSING}\n`).errorKeys;
    // Still there, now reported as an ordinary error alongside an unrelated one.
    const later = [MISSING, tsLine('src/other.ts', 3, 'TS2322', 'Type X is not assignable to type Y.')].join('\n');
    expect(survivingKeys(keys, later)).toEqual(keys);
    expect(survivingKeys(keys, tsLine('src/other.ts', 3, 'TS2322', 'Type X is not assignable to type Y.'))).toEqual([]);
  });
});

describe('namedSymbols', () => {
  it('takes the quoted identifiers and leaves module specifiers alone', () => {
    expect(namedSymbols([MISSING])).toEqual(['handleAddMcpServer']);
    expect(namedSymbols([`src/a.ts(1,1): error TS2307: Cannot find module './split.js'.`])).toEqual([]);
  });

  it('takes the MISSING symbol and NOT the one the checker offers instead', () => {
    // A suggestion is by definition a symbol that already exists and was never
    // missing: searching for it names every file and commit that ever used it,
    // spends the advance's bound on commits that cannot carry the declaration,
    // and puts a false claim in the owner's draft.
    const suggested = tsLine(
      'src/a.ts',
      3,
      'TS2724',
      `'"../../container-config.js"' has no exported member named 'parseMcpServerConfig'. Did you mean 'McpServerConfig'?`,
    );
    expect(namedSymbols([suggested])).toEqual(['parseMcpServerConfig']);
  });

  it('a diagnostic with no second sentence is unaffected', () => {
    expect(namedSymbols([tsLine('src/a.ts', 1, 'TS2304', `Cannot find name 'handleAddMcpServer'.`)])).toEqual([
      'handleAddMcpServer',
    ]);
  });
});

/** An ops stub: a fixed candidate list, a conflict set, and a per-tip verdict. */
function stubOps(opts: {
  candidates: string[];
  conflictsAt?: string[];
  contained?: string[];
  /** What the re-run says at the tip produced by each step (keyed by candidate sha). */
  after: Record<string, { ok: boolean; output: string } | null>;
}): { ops: AdvanceOps; landed: string[]; checked: string[]; asked: Array<{ files: string[]; symbols: string[] }> } {
  const landed: string[] = [];
  const checked: string[] = [];
  const asked: Array<{ files: string[]; symbols: string[] }> = [];
  const ops: AdvanceOps = {
    candidates: async (files, symbols) => {
      asked.push({ files: [...files], symbols: [...symbols] });
      return opts.candidates;
    },
    alreadyContained: async (sha) => (opts.contained ?? []).includes(sha),
    step: async (sha) => {
      if ((opts.conflictsAt ?? []).includes(sha)) return { conflictedPaths: ['src/x.ts'] };
      landed.push(sha);
      return { tip: `tip-${sha}` };
    },
    recheck: async (tip) => {
      checked.push(tip);
      return opts.after[tip.replace(/^tip-/, '')] ?? null;
    },
  };
  return { ops, landed, checked, asked };
}

const ORIGINAL = [`ts src/request.ts TS2305 Module '"./split.js"' has no exported member 'handleAddMcpServer'.`];
const stillRed = { ok: false, output: MISSING };
const green = { ok: true, output: '' };
const differentRed = { ok: false, output: tsLine('src/other.ts', 3, 'TS2322', 'Type X is not assignable to type Y.') };

describe('advanceThroughDepsMissing', () => {
  const run = (ops: AdvanceOps, limit?: number) =>
    advanceThroughDepsMissing({ startTip: 'RED', originalKeys: ORIGINAL, files: ['src/request.ts'], ops, limit });

  it('stops the moment the original set is empty and the tree is green — the propagation repaired it', async () => {
    const { ops, landed } = stubOps({ candidates: ['c1', 'c2', 'c3'], after: { c1: stillRed, c2: green, c3: green } });
    const out = await run(ops);
    expect(out.kind).toBe('repaired');
    expect(landed).toEqual(['c1', 'c2']); // c3 was never taken
    expect(out.steps.map((s) => s.verdict)).toEqual(['original-persists', 'original-cleared']);
    if (out.kind === 'repaired') expect(out.tip).toBe('tip-c2');
  });

  it('an emptied original set with NEW errors is a CHANGED red, not a repair', async () => {
    const { ops } = stubOps({ candidates: ['c1'], after: { c1: differentRed } });
    const out = await run(ops);
    expect(out.kind).toBe('changed');
    if (out.kind === 'changed') expect(out.tip).toBe('tip-c1');
  });

  it('stops at the BOUND with the original errors still present, headed at the first errored commit', async () => {
    const candidates = Array.from({ length: 14 }, (_, i) => `c${i}`);
    const after = Object.fromEntries(candidates.map((c) => [c, stillRed]));
    const { ops, landed } = stubOps({ candidates, after });
    const out = await run(ops);
    expect(out.kind).toBe('exhausted');
    if (out.kind !== 'exhausted') return;
    expect(out.stop).toBe('bound-reached');
    expect(out.bounded).toBe(true);
    expect(out.candidates).toHaveLength(DEPS_MISSING_ADVANCE_LIMIT);
    expect(landed).toHaveLength(DEPS_MISSING_ADVANCE_LIMIT);
    // THE PR'S HEAD: where the errors first appeared, not the advanced tip.
    expect(out.firstErrored).toBe('RED');
  });

  it('a conflicting step ENDS the advance — a resolution cannot be validated on a red tree', async () => {
    const { ops, landed } = stubOps({ candidates: ['c1', 'c2', 'c3'], conflictsAt: ['c2'], after: { c1: stillRed } });
    const out = await run(ops);
    expect(out.kind).toBe('exhausted');
    if (out.kind !== 'exhausted') return;
    expect(out.stop).toBe('conflict');
    expect(landed).toEqual(['c1']); // c3 is never reached
    expect(out.steps.at(-1)).toMatchObject({ sha: 'c2', verdict: 'conflict', conflictedPaths: ['src/x.ts'] });
    expect(out.firstErrored).toBe('RED');
  });

  it('a rev-list with nothing in it is a walk that ended, not a walk that was bounded', async () => {
    const out = await run(stubOps({ candidates: [], after: {} }).ops);
    expect(out.kind).toBe('exhausted');
    if (out.kind === 'exhausted') expect(out.stop).toBe('source-exhausted');
    expect(out.bounded).toBe(false);
  });

  it('a candidate an earlier step already dragged in costs no check run', async () => {
    const { ops, checked } = stubOps({ candidates: ['c1', 'c2'], contained: ['c1'], after: { c2: green } });
    const out = await run(ops);
    expect(checked).toEqual(['tip-c2']);
    expect(out.steps[0]).toMatchObject({ sha: 'c1', verdict: 'already-contained' });
    expect(out.kind).toBe('repaired');
  });

  it('a step that cannot be MEASURED ends the walk — no verdict is never green', async () => {
    const { ops } = stubOps({ candidates: ['c1', 'c2'], after: { c1: null } });
    const out = await run(ops);
    expect(out.kind).toBe('exhausted');
    if (out.kind === 'exhausted') expect(out.stop).toBe('unmeasured');
  });

  it('every step is reported as it happens, so the journal can be written from the walk', async () => {
    const seen: AdvanceStep[] = [];
    const { ops } = stubOps({ candidates: ['c1', 'c2'], after: { c1: stillRed, c2: green } });
    await advanceThroughDepsMissing({
      startTip: 'RED',
      originalKeys: ORIGINAL,
      files: ['src/request.ts'],
      ops,
      onStep: (s) => seen.push(s),
    });
    expect(seen.map((s) => `${s.sha} ${s.verdict}`)).toEqual(['c1 original-persists', 'c2 original-cleared']);
    expect(seen[0].surviving).toEqual(ORIGINAL);
  });

  it('the bound is a named constant, not a number spelled into the walk', () => {
    expect(DEPS_MISSING_ADVANCE_LIMIT).toBe(10);
  });

  it('a SPENT budget takes no candidate at all and ends the walk on the bound', async () => {
    // The advance is re-entered while the red it leaves behind is another
    // missing declaration, and the step budget it subtracts from is the
    // BRANCH'S, not the walk's — so a re-entry with nothing left walks nowhere
    // and the caller gets the owner's draft, never a mint.
    const { ops, landed } = stubOps({ candidates: ['c1', 'c2'], after: { c1: green, c2: green } });
    const out = await run(ops, 0);
    expect(out.kind).toBe('exhausted');
    if (out.kind === 'exhausted') expect(out.stop).toBe('bound-reached');
    expect(landed).toEqual([]);
  });

  it('the candidate query is asked for the SYMBOLS as well as the paths', async () => {
    const { ops, asked } = stubOps({ candidates: ['c1'], after: { c1: green } });
    await advanceThroughDepsMissing({
      startTip: 'RED',
      originalKeys: ORIGINAL,
      files: ['src/request.ts'],
      symbols: ['handleAddMcpServer'],
      ops,
    });
    // The diagnostic reports at the USE site, so the paths alone cannot find a
    // reconciliation that only touches the SOURCE module.
    expect(asked).toEqual([{ files: ['src/request.ts'], symbols: ['handleAddMcpServer'] }]);
  });

  it('a step that MOVED THE REF says so, and one that moved nothing does not', async () => {
    const { ops } = stubOps({
      candidates: ['c0', 'c1', 'c2', 'c3'],
      contained: ['c0'],
      conflictsAt: ['c2'],
      after: { c1: stillRed },
    });
    const out = await run(ops);
    // `landed` is what the pass's rollback target and its push set are derived
    // from — the advance writes no `merge` row for either to read.
    expect(out.steps.map((s) => `${s.sha}:${s.landed === true}`)).toEqual([
      'c0:false',
      'c1:true',
      'c2:false',
    ]);
  });

  it('a step that landed but could not be MEASURED still moved the ref', async () => {
    const { ops } = stubOps({ candidates: ['c1'], after: { c1: null } });
    const out = await run(ops);
    expect(out.steps.at(-1)).toMatchObject({ verdict: 'unmeasured', landed: true });
  });
});
