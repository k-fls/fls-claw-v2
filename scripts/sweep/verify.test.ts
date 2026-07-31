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
    const res = await verifyEverything(repo.dir, { recipe: ['module/good'], commands: [{ cmd: 'false' }] });
    expect(res.ok).toBe(false);
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

describe('verifyEverything — worktree preparation (D-060 gap)', () => {
  /**
   * ROOT CAUSE, live 2026-07-31: a `git worktree add` checkout holds TRACKED
   * FILES ONLY, so `node_modules` is absent. The case and gate-fix worktrees
   * have symlinked the clone's dependency trees in since D-060; this one never
   * did, so `finish`'s verify ran `tsc` with no `@types/node` and no `vitest`
   * and was red on EVERY pass regardless of content. pnpm said so outright:
   * "Local package.json exists, but node_modules missing".
   */
  it('prepares the temp worktree, and the deps SURVIVE runRecipe\'s clean', async () => {
    const seen: string[] = [];
    const res = await verifyEverything(repo.dir, {
      recipe: ['module/good'],
      // Asserted INSIDE the worktree after the recipe build, so this passes only
      // if preparation ran first AND its output survived. That survival is not
      // incidental: `runRecipe` does `git clean -fdx --exclude=node_modules`
      // between preparation and the commands, which deletes every untracked
      // path EXCEPT node_modules — which is exactly what linkNodeModules
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
