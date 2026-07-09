import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';

const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const SWEEP = fileURLToPath(new URL('./sweep.ts', import.meta.url));
const CLI_TIMEOUT = 30_000;

const { repo, chain } = makeSweepFixture();
afterAll(() => repo.destroy());

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(TSX, [SWEEP, ...args], { encoding: 'utf8', timeout: CLI_TIMEOUT });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const COMMON = ['--repo', repo.dir, '--upstream', 'upstream-main', '--base', 'main'];

describe('sweep CLI', () => {
  it('prints usage and exits 2 on misuse', () => {
    expect(cli().code).toBe(2);
    expect(cli().stderr).toContain('Usage:');
    expect(cli('no-such-command').code).toBe(2);
    expect(cli('scan', '--bogus-flag').code).toBe(2);
  });

  it(
    'fetch is dry-run by default',
    () => {
      const res = cli('fetch', ...COMMON);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('DRY-RUN');
    },
    CLI_TIMEOUT,
  );

  it(
    'scan emits a sweep report without mutating anything',
    () => {
      const before = repo.git('for-each-ref', '--format=%(refname) %(objectname)');
      const res = cli('scan', ...COMMON);
      expect(res.code).toBe(0);
      const report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
      // Registry fallback enumerates feat/* branches.
      expect(Object.keys(report.branches).sort()).toEqual(['feat/one', 'feat/two']);
      expect(report.branches['feat/one'].conflictFiles).toEqual(['src/app.ts']);
      expect(report.branches['feat/one'].stopPoint).toBe(chain[1]);
      expect(report.branches['feat/two'].stopPoint).toBe(chain[3]);
      expect(repo.git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(before);
    },
    CLI_TIMEOUT,
  );

  it(
    'merge without --execute prints the plan and moves nothing',
    () => {
      const before = repo.git('for-each-ref', '--format=%(refname) %(objectname)');
      const res = cli('merge', ...COMMON);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('DRY-RUN');
      expect(repo.git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(before);
    },
    CLI_TIMEOUT,
  );

  it(
    'merge --execute advances branches to their stop points and journals to the state branch',
    () => {
      const res = cli('merge', ...COMMON, '--execute');
      expect(res.code).toBe(0);
      const outcomes = JSON.parse(res.stdout.slice(res.stdout.indexOf('['))) as Array<{
        branch: string;
        result: string;
        stopPoint: string;
      }>;
      const byBranch = Object.fromEntries(outcomes.map((o) => [o.branch, o]));
      expect(byBranch['feat/two'].result).toBe('merged');
      expect(byBranch['feat/two'].stopPoint).toBe(chain[3]);
      expect(byBranch['feat/one'].result).toBe('merged');
      expect(byBranch['feat/one'].stopPoint).toBe(chain[1]); // stops before the conflict
      // feat/one now contains U2 but not U3's edit; feat/two has upstream tip.
      expect(repo.git('merge-base', '--is-ancestor', chain[1], 'feat/one')).toBe('');
      expect(() => repo.git('merge-base', '--is-ancestor', chain[2], 'feat/one')).toThrow();
      expect(repo.git('merge-base', '--is-ancestor', chain[3], 'feat/two')).toBe('');
      // Journal row landed on the state branch.
      expect(repo.git('show', 'maint/fork-registry:sweep-state/sweep-log.jsonl')).toContain('"action":"merge"');
    },
    CLI_TIMEOUT,
  );

  it(
    'ff-main dry-runs, then fast-forwards with --execute',
    () => {
      const mainBefore = repo.sha('main');
      const dry = cli('ff-main', ...COMMON);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('DRY-RUN');
      expect(repo.sha('main')).toBe(mainBefore);

      const wet = cli('ff-main', ...COMMON, '--execute');
      expect(wet.code).toBe(0);
      expect(repo.sha('main')).toBe(repo.sha('upstream-main'));
    },
    CLI_TIMEOUT,
  );

  it(
    'ff-main fails loudly when main has diverged (mirror invariant)',
    () => {
      repo.checkout('main');
      repo.commit('illegal fork commit on main', { 'oops.txt': 'x\n' });
      const res = cli('ff-main', ...COMMON, '--execute');
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('mirror invariant violated');
    },
    CLI_TIMEOUT,
  );

  it(
    'status renders the recorded state',
    () => {
      const res = cli('status', ...COMMON);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('state branch: maint/fork-registry');
    },
    CLI_TIMEOUT,
  );
});
