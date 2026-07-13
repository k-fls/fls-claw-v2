import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';

const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const SWEEP = fileURLToPath(new URL('./sweep.ts', import.meta.url));
const CLI_TIMEOUT = 30_000;

const scratch = mkdtempSync(join(tmpdir(), 'sweep-cli-'));
const workspace = join(scratch, 'ws');
const emptyInventory = join(scratch, 'inventory-empty');
mkdirSync(workspace, { recursive: true });
mkdirSync(emptyInventory, { recursive: true });

const { repo, chain } = makeSweepFixture();
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  repo.destroy();
});

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(TSX, [SWEEP, ...args], { encoding: 'utf8', timeout: CLI_TIMEOUT });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// Empty inventory => namespace fallback picks up the fixture's feat/* branches.
const COMMON = [
  '--repo',
  repo.dir,
  '--upstream',
  'upstream-main',
  '--base',
  'main',
  '--workspace',
  workspace,
  '--inventory',
  emptyInventory,
];

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
    'scan emits a sweep report without mutating anything (namespace fallback scope)',
    () => {
      const before = repo.git('for-each-ref', '--format=%(refname) %(objectname)');
      const res = cli('scan', ...COMMON);
      expect(res.code).toBe(0);
      const report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
      expect(Object.keys(report.branches).sort()).toEqual(['feat/one', 'feat/two']);
      expect(report.branches['feat/one'].conflictFiles).toEqual(['src/app.ts']);
      expect(report.branches['feat/one'].stopPoint).toBe(chain[1]);
      expect(report.branches['feat/two'].stopPoint).toBe(chain[3]);
      expect(repo.git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(before);
    },
    CLI_TIMEOUT,
  );

  it(
    'scope partition: non-inventory branches are ignored unless their tip is in an edition composition',
    () => {
      repo.git('branch', 'fix/extra', chain[0]);
      repo.git('branch', 'design/flsclaw', chain[0]); // namespace-excluded, never appears anywhere
      repo.checkout('docs/notes', { create: true, at: chain[0] });
      repo.commit('docs-only commit not in any edition', { 'docs/drift.md': 'x\n' });
      repo.checkout('main');
      // edition/ed carries fix/extra's tip -> fix/extra passes the ancestry test.
      repo.checkout('edition/ed', { create: true, at: 'feat/one' });
      repo.git('merge', '--no-edit', 'fix/extra');
      repo.checkout('main');

      const res = cli('scan', ...COMMON, '--out', join(scratch, 'report.json'));
      expect(res.code).toBe(0);
      const report = JSON.parse(readFileSync(join(scratch, 'report.json'), 'utf8'));
      const names = Object.keys(report.branches).sort();
      expect(names).toEqual(['edition/ed', 'feat/one', 'feat/two', 'fix/extra']);
      // in edition composition, no inventory entry: swept, upstream-chain (main-only) source
      expect(report.branches['fix/extra'].kind).toBe('edition-ancestor');
      expect(report.branches['fix/extra'].mergeModel).toBe('upstream-chain');
      expect(report.branches['fix/extra'].clean).toBe(true);
      // not in any edition composition: ignored, one drift line
      expect(report.ignoredBranches).toContain('docs/notes');
      // namespace-excluded: neither scanned nor ignored-listed
      expect(names).not.toContain('design/flsclaw');
      expect(report.ignoredBranches).not.toContain('design/flsclaw');
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
    'merge --execute advances branches to their stop points and journals to the workspace',
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
      expect(repo.git('merge-base', '--is-ancestor', chain[1], 'feat/one')).toBe('');
      expect(() => repo.git('merge-base', '--is-ancestor', chain[2], 'feat/one')).toThrow();
      expect(repo.git('merge-base', '--is-ancestor', chain[3], 'feat/two')).toBe('');
      // Journal row landed in the workspace log (plain file, no git).
      expect(readFileSync(join(workspace, 'sweep-log.jsonl'), 'utf8')).toContain('"action":"merge"');
    },
    CLI_TIMEOUT,
  );

  it(
    'status --report distinguishes clean-ready, gated, and up-to-date; mergeBase is derived',
    () => {
      const res = cli('status', ...COMMON, '--report', join(scratch, 'report.json'));
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`workspace:    ${workspace}`);
      // fix/extra never merged anything: clean and ready.
      expect(res.stdout).toMatch(/fix\/extra .*clean, ready to merge/);
      // feat/one was merged to its stop point; the report (pre-merge) says gated at stop point.
      expect(res.stdout).toMatch(/feat\/one .*gated at stop point/);
      // derived merge-base for feat/one is its merged stop point (U2).
      expect(res.stdout).toContain(`feat/one  mergeBase=${chain[1].slice(0, 12)}`);
      // the digest drift line lists ignored non-inventory branches
      expect(res.stdout).toMatch(/ignored \(no inventory entry.*docs\/notes/);
      // design/flsclaw stays out of scope entirely.
      expect(res.stdout).not.toContain('design/flsclaw');
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
    'seed-rerere is dry-run by default and lists the pinned resolution cases',
    () => {
      // Default cases dir = the committed registry cases (t2a/t2b carry resolution_ref).
      const res = cli('seed-rerere', ...COMMON);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('DRY-RUN');
      expect(res.stdout).toContain('t2a-dedup-propagation');
      expect(res.stdout).toContain('t2b-dupsend-propagation');
    },
    CLI_TIMEOUT,
  );
});
