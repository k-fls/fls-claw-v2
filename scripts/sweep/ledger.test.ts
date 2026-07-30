import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { makeSweepFixture } from './fixtures.js';
import { defaultLedgerBranch, emptyLedger, readLedger, writeLedger } from './ledger.js';

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
});

describe('readLedger — legacy freeze-field up-convert (D-057)', () => {
  it("status:'frozen' + old fields become merge_status PR_ID; legacy fields are stripped", () => {
    const path = join(workspace, 'legacy-ledger.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        lastSweep: null,
        branches: {
          'feat/old': {
            status: 'frozen',
            frozenBy: 'feat__old--main-h3',
            pendingBehindFreeze: 2,
            notes: 'legacy',
            heldHead: 'abc123',
            heldPaths: ['src/x.ts'],
            fixBranch: 'fix/sweep/2026-01-01-old',
            prNumber: 9,
            lastUrgedHead: 'def456',
          },
        },
        openPois: [],
      }),
    );
    const b = readLedger(path).branches['feat/old']!;
    expect(b.status).toBe('active'); // 'frozen' is retired; blocked ⇔ merge_status != NONE
    expect(b.merge_status).toEqual({
      state: 'PR_ID',
      caseId: 'feat__old--main-h3',
      headSha: 'abc123',
      fixBranch: 'fix/sweep/2026-01-01-old',
      prNumber: 9,
    });
    expect(b.lastUrgedHead).toBe('def456'); // urge bookkeeping survives
    expect('heldPaths' in b).toBe(false); // DEFER is pure height-MIN — paths retired
    expect('frozenBy' in b).toBe(false);
    expect('pendingBehindFreeze' in b).toBe(false);
  });
});
