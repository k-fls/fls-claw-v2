/**
 * `onecli` agent-identifier credential + resolveAgentIdentifier (C3 §5a).
 *
 * Covers the resolution order: own-scope → granted borrow source (canAccess
 * gated) → default. The default preserves today's `agentGroup.id` behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_ROOT = path.join(os.tmpdir(), `nc-onecli-cred-${process.pid}`);
const TMP_GROUPS = path.join(TMP_ROOT, 'groups');
const TMP_XDG = path.join(TMP_ROOT, 'xdg');

vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>();
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    ...orig,
    GROUPS_DIR: nodePath.join(nodeOs.tmpdir(), `nc-onecli-cred-${process.pid}`, 'groups'),
  };
});
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { addGrantee, setBorrowSource } from '../modules/credentials/grants.js';
import { _resetResolversForTests } from '../modules/credentials/resolver.js';
import { _resetScopeInvalidatorsForTests } from '../modules/credentials/scope-invalidator.js';
import { writeKeysFile } from '../modules/credentials/store.js';
import { asCredentialScope } from '../modules/credentials/types.js';

import { ONECLI_IDENTIFIER_PATH, ONECLI_PROVIDER_ID, resolveAgentIdentifier } from './onecli-credential.js';

function freshGroupDir(folder: string): void {
  fs.mkdirSync(path.join(TMP_GROUPS, folder, 'credentials'), { recursive: true });
}

function storeIdentifier(folder: string, value: string): void {
  writeKeysFile(asCredentialScope(folder), ONECLI_PROVIDER_ID, {
    [ONECLI_IDENTIFIER_PATH]: { value, updated_ts: 1 },
  });
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = TMP_XDG;
  fs.mkdirSync(TMP_GROUPS, { recursive: true });
  fs.mkdirSync(TMP_XDG, { recursive: true });
  _resetResolversForTests();
  _resetScopeInvalidatorsForTests();
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('resolveAgentIdentifier', () => {
  it('returns the default when no credential is stored', () => {
    freshGroupDir('grp');
    expect(resolveAgentIdentifier('grp', 'default-id')).toBe('default-id');
  });

  it('returns the own-scope credential value over the default', () => {
    freshGroupDir('grp');
    storeIdentifier('grp', 'my-agent');
    expect(resolveAgentIdentifier('grp', 'default-id')).toBe('my-agent');
  });

  it('resolves a granted borrow source — forwards as the grantor agent', () => {
    freshGroupDir('grantor');
    freshGroupDir('borrower');
    storeIdentifier('grantor', 'grantor-agent');
    addGrantee('grantor', 'borrower'); // grantor side
    setBorrowSource('borrower', 'grantor'); // borrower side
    expect(resolveAgentIdentifier('borrower', 'default-borrower')).toBe('grantor-agent');
  });

  it('falls to default when the borrow is not granted (canAccess fails)', () => {
    freshGroupDir('grantor');
    freshGroupDir('borrower');
    storeIdentifier('grantor', 'grantor-agent');
    // borrower claims the source but grantor never listed it → canAccess false
    setBorrowSource('borrower', 'grantor');
    expect(resolveAgentIdentifier('borrower', 'default-borrower')).toBe('default-borrower');
  });

  it('own credential wins even when a borrow source is also set', () => {
    freshGroupDir('grantor');
    freshGroupDir('borrower');
    storeIdentifier('grantor', 'grantor-agent');
    storeIdentifier('borrower', 'own-agent');
    addGrantee('grantor', 'borrower');
    setBorrowSource('borrower', 'grantor');
    expect(resolveAgentIdentifier('borrower', 'default-borrower')).toBe('own-agent');
  });
});
