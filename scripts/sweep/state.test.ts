import { afterAll, describe, expect, it } from 'vitest';

import { STATE_FILE } from './config.js';
import { initFixtureRepo } from './fixtures.js';
import { refExists } from './git.js';
import { emptyState, readSweepLog, readSweepState, reportArchivePath, writeSweepState } from './state.js';

const repo = initFixtureRepo();
const STATE_BRANCH = 'maint/fork-registry';
afterAll(() => repo.destroy());

describe('sweep state round-trip (no checkout)', () => {
  it('returns the empty state when the branch/file is missing', async () => {
    expect(await readSweepState(repo.dir, STATE_BRANCH)).toEqual(emptyState());
  });

  it('writes and re-reads state, appending the journal, without touching the worktree', async () => {
    const s1 = emptyState();
    s1.branches['feat/one'] = {
      status: 'active',
      lastMergedUpstream: 'abc123',
      frozenBy: null,
      pendingBehindFreeze: 0,
      notes: '',
    };
    await writeSweepState(repo.dir, STATE_BRANCH, s1, { action: 'test-1' });

    const s2 = await readSweepState(repo.dir, STATE_BRANCH);
    expect(s2).toEqual(s1);
    s2.lastSweep = { id: '2026-07-10T00:00Z', upstreamTip: 'def456', result: 'clean' };
    await writeSweepState(
      repo.dir,
      STATE_BRANCH,
      s2,
      { action: 'test-2', extra: 42 },
      {
        [reportArchivePath('2026-07-10T00:00Z')]: '{"fake":"report"}\n',
      },
    );

    const s3 = await readSweepState(repo.dir, STATE_BRANCH);
    expect(s3.lastSweep?.upstreamTip).toBe('def456');
    expect(s3.branches['feat/one'].lastMergedUpstream).toBe('abc123');

    const log = await readSweepLog(repo.dir, STATE_BRANCH);
    expect(log.map((l) => l.action)).toEqual(['test-1', 'test-2']);
    expect(log[1].extra).toBe(42);
    expect(log.every((l) => typeof l.ts === 'string')).toBe(true);

    // State branch exists but was never checked out; worktree stays clean on main.
    expect(await refExists(repo.dir, STATE_BRANCH)).toBe(true);
    expect(repo.git('branch', '--show-current')).toBe('main');
    expect(repo.git('status', '--porcelain')).toBe('');
    // Both state file and archived report live on the branch.
    expect(repo.git('ls-tree', '-r', '--name-only', STATE_BRANCH)).toContain(STATE_FILE);
    expect(repo.git('ls-tree', '-r', '--name-only', STATE_BRANCH)).toContain(
      'sweep-state/reports/2026-07-10T0000Z.json',
    );
  });

  it('rejects an unknown schema version', async () => {
    await writeSweepState(
      repo.dir,
      'bad-schema',
      { ...emptyState(), schemaVersion: 99 as unknown as 1 },
      { action: 'bad' },
    );
    await expect(readSweepState(repo.dir, 'bad-schema')).rejects.toThrow(/schemaVersion 99/);
  });
});
