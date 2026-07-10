import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';
import {
  appendSweepLog,
  defaultLedgerBranch,
  derivedLastMerged,
  emptyLedger,
  readLedger,
  readSweepLog,
  reportArchivePath,
  writeLedger,
} from './ledger.js';

const workspace = mkdtempSync(join(tmpdir(), 'sweep-ws-'));
const { repo, chain } = makeSweepFixture();
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  repo.destroy();
});

describe('ledger round-trip (plain files, no git)', () => {
  const ledgerPath = join(workspace, 'sweep-ledger.json');

  it('returns the empty ledger when the file is missing', () => {
    expect(readLedger(ledgerPath)).toEqual(emptyLedger());
  });

  it('writes and re-reads the ledger', () => {
    const ledger = emptyLedger();
    ledger.branches['fix/channels/telegram-markdown-nesting'] = {
      ...defaultLedgerBranch(),
      status: 'excluded',
      notes: '750 behind, needs rebase',
    };
    ledger.lastSweep = { id: '2026-07-10T00:00Z', upstreamTip: 'def456', result: 'partial' };
    writeLedger(ledgerPath, ledger);
    expect(readLedger(ledgerPath)).toEqual(ledger);
    expect(existsSync(ledgerPath)).toBe(true);
  });

  it('rejects an unknown schema version', () => {
    const bad = join(workspace, 'bad-ledger.json');
    writeLedger(bad, { ...emptyLedger(), schemaVersion: 99 as unknown as 1 });
    expect(() => readLedger(bad)).toThrow(/schemaVersion 99/);
  });

  it('appends journal rows to sweep-log.jsonl', () => {
    appendSweepLog(workspace, { action: 'test-1' });
    appendSweepLog(workspace, { action: 'test-2', extra: 42 });
    const log = readSweepLog(workspace);
    expect(log.map((l) => l.action)).toEqual(['test-1', 'test-2']);
    expect(log[1].extra).toBe(42);
    expect(log.every((l) => typeof l.ts === 'string')).toBe(true);
  });

  it('report archive paths strip colons', () => {
    expect(reportArchivePath('/ws', '2026-07-10T12:00:00.000Z')).toBe('/ws/reports/2026-07-10T120000.000Z.json');
  });
});

describe('derivedLastMerged (merge-base, replaces stored lastMergedUpstream)', () => {
  it('is the fork point before any merge, and the merged stop point after', async () => {
    const base = repo.sha('main');
    expect(await derivedLastMerged(repo.dir, 'feat/two', 'upstream-main')).toBe(base);
    // Merge U2 into feat/two -> merge-base moves to U2.
    repo.checkout('feat/two');
    repo.git('merge', '--no-edit', chain[1]);
    repo.checkout('main');
    expect(await derivedLastMerged(repo.dir, 'feat/two', 'upstream-main')).toBe(chain[1]);
  });

  it('returns null for a missing branch', async () => {
    expect(await derivedLastMerged(repo.dir, 'no/such-branch', 'upstream-main')).toBeNull();
  });
});
