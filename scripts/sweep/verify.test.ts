import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { initFixtureRepo } from './fixtures.js';
import { revParse } from './git.js';
import { verifyEverything } from './verify.js';

const repo = initFixtureRepo();
afterAll(() => repo.destroy());

// Recipe branches: good adds a file, bad plants a tripwire file the injected
// "test matrix" rejects, conflicted collides with good on the same line.
repo.checkout('module/good', { create: true, at: 'main' });
repo.commit('good', { 'src/good.ts': 'export const good = 1;\n' });
repo.checkout('main');
repo.checkout('module/bad', { create: true, at: 'main' });
repo.commit('bad: plant tripwire', { 'BROKEN.marker': 'boom\n' });
repo.checkout('main');
repo.checkout('module/conflicting', { create: true, at: 'main' });
repo.commit('conflicts with good', { 'src/good.ts': 'export const good = 2;\n' });
repo.checkout('main');

const PASS = [{ cmd: 'true' }];
const TRIPWIRE = [{ cmd: 'test ! -f BROKEN.marker' }];

describe('verifyEverything', () => {
  it('green recipe + green matrix -> ok', async () => {
    const res = await verifyEverything(repo.dir, { recipe: ['module/good', 'module/bad'], commands: PASS });
    expect(res.ok).toBe(true);
    expect(res.build.merged).toEqual(['module/good', 'module/bad']);
    expect(res.commands.every((c) => c.code === 0)).toBe(true);
  });

  it('injected command list is honored and failures are attributed to the offending branch', async () => {
    const res = await verifyEverything(repo.dir, { recipe: ['module/good', 'module/bad'], commands: TRIPWIRE });
    expect(res.ok).toBe(false);
    expect(res.commands[res.commands.length - 1].code).not.toBe(0);
    expect(res.offender).toBe('module/bad'); // removing module/bad turns the matrix green
  });

  it('reports attribution failure when no single branch is to blame', async () => {
    // TWO branches each plant a tripwire and the base is clean, so removing
    // either one leaves the other and nothing isolates an offender. (A plain
    // `cmd: 'false'` would fail on the BASE as well — reported as baseRed, a
    // sharper verdict — and would not exercise attribution at all.)
    repo.checkout('module/bad2', { create: true, at: 'main' });
    repo.commit('bad2: plant second tripwire', { 'BROKEN2.marker': 'boom\n' });
    repo.checkout('main');
    const res = await verifyEverything(repo.dir, {
      recipe: ['module/bad', 'module/bad2'],
      commands: [{ cmd: 'test ! -f BROKEN.marker -a ! -f BROKEN2.marker' }],
    });
    expect(res.ok).toBe(false);
    expect(res.baseRed).toBeUndefined(); // base is clean
    expect(res.offender).toBeUndefined();
    expect(res.attributionFailed).toBe(true);
  });

  it('an unresolved recipe merge conflict is attributed to the conflicting branch', async () => {
    const res = await verifyEverything(repo.dir, {
      recipe: ['module/good', 'module/conflicting'],
      commands: PASS,
    });
    expect(res.ok).toBe(false);
    expect(res.build.conflictBranch).toBe('module/conflicting');
    expect(res.build.unresolved).toEqual(['src/good.ts']);
    expect(res.offender).toBe('module/conflicting');
  });

  it('never moves any real branch ref (temp worktree only)', async () => {
    const before = {
      main: await revParse(repo.dir, 'main'),
      good: await revParse(repo.dir, 'module/good'),
      bad: await revParse(repo.dir, 'module/bad'),
    };
    await verifyEverything(repo.dir, { recipe: ['module/good', 'module/bad'], commands: PASS });
    expect(await revParse(repo.dir, 'main')).toBe(before.main);
    expect(await revParse(repo.dir, 'module/good')).toBe(before.good);
    expect(await revParse(repo.dir, 'module/bad')).toBe(before.bad);
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});

describe('verifyEverything — worktree preparation (dependency install hook)', () => {
  /**
   * A `git worktree add` checkout holds TRACKED FILES ONLY, so `node_modules`
   * is absent. The verify worktree needs the same dependency preparation the
   * case and gate-fix worktrees get; without it, `finish`'s verify runs `tsc`
   * with no `@types/node` and no `vitest` and is red on EVERY pass regardless
   * of content — pnpm says so outright: "Local package.json exists, but
   * node_modules missing".
   */
  it('prepares the temp worktree, and the deps SURVIVE runRecipe\'s clean', async () => {
    const seen: string[] = [];
    const res = await verifyEverything(repo.dir, {
      recipe: ['module/good'],
      // Asserted INSIDE the worktree after the recipe build, so this passes only
      // if preparation ran first AND its output survived. That survival is not
      // incidental: `runRecipe` does `git clean -fdx --exclude=node_modules`
      // between preparation and the commands, which deletes every untracked
      // path EXCEPT node_modules — which is exactly what the dep install
      // creates. A marker under any other name would be wiped.
      commands: [{ cmd: 'test -f node_modules/DEPS_READY' }],
      prepareWorktree: async (wtPath) => {
        seen.push(wtPath);
        mkdirSync(join(wtPath, 'node_modules'), { recursive: true });
        writeFileSync(join(wtPath, 'node_modules', 'DEPS_READY'), 'ok\n');
      },
    });
    expect(seen.length).toBe(1);
    expect(res.ok).toBe(true);
  });

  it('without preparation the same command fails — the gap this closes', async () => {
    const res = await verifyEverything(repo.dir, {
      recipe: ['module/good'],
      commands: [{ cmd: 'test -f node_modules/DEPS_READY' }],
    });
    expect(res.ok).toBe(false);
  });

  it('captures the FULL command output, not a tail', async () => {
    // 5000 chars of stdout: a 4000-char tail would drop the head marker.
    const res = await verifyEverything(repo.dir, {
      recipe: ['module/good'],
      commands: [{ cmd: 'echo HEAD_MARKER; printf \'x%.0s\' $(seq 1 5000); echo; exit 1' }],
    });
    expect(res.ok).toBe(false);
    const out = res.commands[res.commands.length - 1].output;
    expect(out.length).toBeGreaterThan(4000);
    expect(out).toContain('HEAD_MARKER'); // survives only because nothing is cropped
  });
});

// --- determinism probe ------------------------------------------------------
//
// A flaky test makes leave-one-out blame whichever branch was removed when it
// happened to pass — an innocent branch rolled back and a gate fix minted
// against a defect that is not there. So a red that does not repeat on the
// same tree is reported flaky, never attributed.
describe('verifyEverything — a non-deterministic red is not attributed to a branch', () => {
  it('re-runs the same tree; a failure that does not repeat is reported flaky, not blamed', async () => {
    const counter = join(repo.dir, 'flaky-runs');
    // Fails the first time, passes the second — on the SAME tree.
    const cmd =
      `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > ${counter}; ` +
      `if [ "$n" -eq 1 ]; then echo boom; exit 1; fi; exit 0`;
    const res = await verifyEverything(repo.dir, { recipe: ['module/good'], commands: [{ cmd }] });
    expect(res.ok).toBe(false);
    expect(res.nonDeterministic).toBe(true);
    expect(res.flakyCommands).toEqual([cmd]);
    // Crucially: NO branch was blamed, and no attribution sweep was run.
    expect(res.offender).toBeUndefined();
    expect(res.attributionFailed).toBeUndefined();
  });

  it('a failure that repeats on the same tree is still attributed normally', async () => {
    const res = await verifyEverything(repo.dir, { recipe: ['module/good', 'module/bad'], commands: TRIPWIRE });
    expect(res.ok).toBe(false);
    expect(res.nonDeterministic).toBeUndefined(); // consistently red -> a real defect
    expect(res.offender).toBe('module/bad');
  });
});

// --- base probe -------------------------------------------------------------
//
// Leave-one-out cannot see a defect that is already in the base: removing a
// branch never fixes it, so attribution blames whoever happens to flip the
// matrix, or gives up — peeling innocent branches one by one to reach a base
// defect it could have probed for from the first second. The base probe runs
// the commands on the bare base first.
describe('verifyEverything — a failure already in the BASE blames no branch', () => {
  it('reports baseRed and rolls nothing back', async () => {
    // The defect is planted on the BASE, not on a recipe branch, and the stub
    // names the failing file the way vitest does.
    repo.checkout('main_patched', { create: true, at: 'main' });
    repo.commit('base defect', { 'BROKEN.marker': 'boom\n' });
    const NAMED_TRIP = [{ cmd: 'if [ -f BROKEN.marker ]; then echo " FAIL  src/x.test.ts"; exit 1; fi; exit 0' }];
    try {
      const res = await verifyEverything(repo.dir, {
        baseRef: 'main_patched',
        recipe: ['module/good'],
        commands: NAMED_TRIP,
      });
      expect(res.ok).toBe(false);
      expect(res.baseRed).toBe(true);
      // No branch named, no attribution sweep run.
      expect(res.offender).toBeUndefined();
      expect(res.attributionFailed).toBeUndefined();
      expect((res.baseCommands ?? []).some((c) => c.code !== 0)).toBe(true);
    } finally {
      repo.checkout('main');
    }
  });

  it('a base failure the recipe FIXES does not mask a real offender', async () => {
    // The base is red on file A. A branch introduces a DIFFERENT failure, on
    // file B. The merged red therefore brings a file the base does not have, so
    // it is branch-caused and must still be attributed — the subset rule is by
    // FILE, not by command (`pnpm test` fails on both sides either way).
    //
    // The stub prints vitest-shaped FAIL lines so the same parser production
    // uses can read them.
    const NAMED = [
      {
        cmd:
          'rc=0; if [ -f A.broken ]; then echo " FAIL  src/a.test.ts"; rc=1; fi; ' +
          'if [ -f B.broken ]; then echo " FAIL  src/b.test.ts"; rc=1; fi; exit $rc',
      },
    ];
    repo.checkout('main_patched');
    repo.commit('base: A is broken', { 'A.broken': 'x\n' });
    repo.checkout('module/heals-a', { create: true, at: 'main_patched' });
    repo.git('rm', '-q', 'A.broken');
    repo.git('commit', '-q', '-m', 'heal A (remove A.broken)');
    repo.checkout('module/breaks-b', { create: true, at: 'main_patched' });
    repo.commit('break B', { 'B.broken': 'x\n' });
    repo.checkout('main');
    const res = await verifyEverything(repo.dir, {
      baseRef: 'main_patched',
      recipe: ['module/heals-a', 'module/breaks-b'],
      commands: NAMED,
    });
    expect(res.ok).toBe(false);
    // src/b.test.ts is NOT among the base's failing files, so this is a real
    // offender and not a base defect.
    expect(res.baseRed).toBeUndefined();
    expect(res.offender).toBe('module/breaks-b');
  });
});
