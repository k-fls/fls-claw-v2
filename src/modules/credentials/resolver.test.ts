/**
 * Resolver tests (C7r).
 *
 * Two halves:
 *
 *   1. v1 parity — every resolver case from v1's
 *      `token-substitute.test.ts` (PersistentCredentialResolver) ports
 *      against `_createResolverForTests`. The assertions hold unchanged;
 *      only the construction switches from a global singleton to a
 *      per-owner instance.
 *
 *   2. Per-container properties — six cases v1 could not express:
 *      concurrent resolvers, dispose isolation, scope-invalidator
 *      eviction, mid-session access revoke, borrow-from-inactive
 *      grantor, write-through invalidation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_ROOT = path.join(os.tmpdir(), `nc-creds-c7r-${process.pid}`);
const TMP_GROUPS = path.join(TMP_ROOT, 'groups');
const TMP_XDG = path.join(TMP_ROOT, 'xdg');

vi.mock('../../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../config.js')>();
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    ...orig,
    GROUPS_DIR: nodePath.join(nodeOs.tmpdir(), `nc-creds-c7r-${process.pid}`, 'groups'),
  };
});

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../command-gate.js', () => ({
  registerHostCommand: vi.fn(),
}));

import { asCredentialScope, type Credential, type CredentialScope } from './types.js';
import { readKeysFile, writeKeysFile, keysFilePath, scopeDir } from './store.js';
import { _resetScopeInvalidatorsForTests, invalidateScope } from './scope-invalidator.js';
import { addGrantee, setBorrowSource } from './grants.js';
import {
  _createResolverForTests,
  _resetResolversForTests,
  getOrCreateResolverForAgentGroup,
  getResolverForAgentGroup,
  disposeResolverForAgentGroup,
  type CredentialResolver,
} from './resolver.js';

function freshGroupDir(folder: string): void {
  fs.mkdirSync(path.join(TMP_GROUPS, folder, 'credentials'), { recursive: true });
}

function makeCred(value: string, opts: Partial<Credential> = {}): Credential {
  return {
    value,
    updated_ts: 1000,
    ...opts,
  };
}

function ownResolver(folder: string): CredentialResolver {
  return _createResolverForTests({
    ownFolder: folder,
    accessCheck: (scope) => (scope as unknown as string) === folder,
  });
}

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  fs.mkdirSync(TMP_GROUPS, { recursive: true });
  fs.mkdirSync(TMP_XDG, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', TMP_XDG);
  vi.stubEnv('HOME', TMP_ROOT);
  _resetScopeInvalidatorsForTests();
  _resetResolversForTests();
});

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Half 1 — v1 parity
// ---------------------------------------------------------------------------

describe('resolver — v1 parity', () => {
  it('store + resolve round-trips value-only credentials', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'oauth', 'github.com', makeCred('token-abc'));
    const out = r.resolve(scope, 'oauth', 'github.com');
    expect(out).not.toBeNull();
    expect(out!.value).toBe('token-abc');
    expect(out!.updated_ts).toBe(1000);
    r.dispose();
  });

  it('store + resolve round-trips refresh sub-tokens', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(
      scope,
      'oauth',
      'github.com',
      makeCred('access-1', {
        expires_ts: 9999,
        refresh: { value: 'refresh-1', updated_ts: 1000, expires_ts: 8888 },
      }),
    );

    const out = r.resolve(scope, 'oauth', 'github.com');
    expect(out!.value).toBe('access-1');
    expect(out!.expires_ts).toBe(9999);
    expect(out!.refresh?.value).toBe('refresh-1');
    expect(out!.refresh?.expires_ts).toBe(8888);
    r.dispose();
  });

  it('store + resolve round-trips authFields', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'ssh', 'host-a', makeCred('private-key-pem', { authFields: { host: 'h', port: '22' } }));
    const out = r.resolve(scope, 'ssh', 'host-a');
    expect(out!.value).toBe('private-key-pem');
    expect(out!.authFields).toEqual({ host: 'h', port: '22' });
    r.dispose();
  });

  it('resolve returns null for absent (scope, provider, id)', () => {
    const r = ownResolver('group-a');
    expect(r.resolve(asCredentialScope('group-a'), 'oauth', 'missing')).toBeNull();
    r.dispose();
  });

  it('delete(scope, providerId) removes the keys file and cached entry', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'oauth', 'a', makeCred('v'));
    expect(fs.existsSync(keysFilePath(scope, 'oauth'))).toBe(true);

    r.delete(scope, 'oauth');
    expect(fs.existsSync(keysFilePath(scope, 'oauth'))).toBe(false);
    expect(r.resolve(scope, 'oauth', 'a')).toBeNull();
    r.dispose();
  });

  it('delete(scope) removes every providerId AND the scope dir itself (v1 parity)', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'oauth', 'a', makeCred('v1'));
    r.store(scope, 'pem', 'b', makeCred('v2'));

    r.delete(scope);
    expect(fs.existsSync(keysFilePath(scope, 'oauth'))).toBe(false);
    expect(fs.existsSync(keysFilePath(scope, 'pem'))).toBe(false);
    // v1 alignment: single rmSync of the scope dir leaves no empty
    // directory behind. The C7r-before-fix version iterated
    // listProviderIds + deleteKeysFile per-pid, which removed files
    // but left the empty parent dir.
    expect(fs.existsSync(scopeDir(scope))).toBe(false);
    r.dispose();
  });

  it('unloadCache drops cached entries without touching disk', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'oauth', 'a', makeCred('plain'));

    r.unloadCache(scope);
    // Disk still has it
    expect(fs.existsSync(keysFilePath(scope, 'oauth'))).toBe(true);
    // Resolve repopulates from disk
    expect(r.resolve(scope, 'oauth', 'a')?.value).toBe('plain');
    r.dispose();
  });

  it('cross-resolver reload: write via r1, read via r2 (same owner) returns same value', () => {
    const A = 'group-a';
    const r1 = ownResolver(A);
    const r2 = ownResolver(A);
    const scope = asCredentialScope(A);

    r1.store(scope, 'oauth', 'k', makeCred('disk-source-of-truth'));
    expect(r2.resolve(scope, 'oauth', 'k')?.value).toBe('disk-source-of-truth');

    r1.dispose();
    r2.dispose();
  });

  it('store preserves sibling entries under the same providerId', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'oauth', 'a', makeCred('val-a'));
    r.store(scope, 'oauth', 'b', makeCred('val-b'));
    expect(r.resolve(scope, 'oauth', 'a')?.value).toBe('val-a');
    expect(r.resolve(scope, 'oauth', 'b')?.value).toBe('val-b');
    r.dispose();
  });

  it('on-disk value field is ciphertext (`enc:` prefix), not plaintext', () => {
    const A = 'group-a';
    const r = ownResolver(A);
    const scope = asCredentialScope(A);
    r.store(scope, 'oauth', 'k', makeCred('plaintext-secret'));

    const raw = readKeysFile(scope, 'oauth');
    const entry = raw['k'] as Record<string, string>;
    expect(entry.value).toMatch(/^enc:/);
    expect(entry.value).not.toContain('plaintext-secret');
    r.dispose();
  });

  it('refusing to store under a foreign scope', () => {
    const r = ownResolver('group-a');
    expect(() => r.store(asCredentialScope('group-other'), 'oauth', 'x', makeCred('v'))).toThrow(/cannot write/);
    r.dispose();
  });

  it('resolve after dispose throws', () => {
    const r = ownResolver('group-a');
    r.dispose();
    expect(() => r.resolve(asCredentialScope('group-a'), 'oauth', 'x')).toThrow(/after dispose/);
  });
});

// ---------------------------------------------------------------------------
// Half 2 — per-container properties
// ---------------------------------------------------------------------------

describe('resolver — per-container properties', () => {
  it('concurrent resolvers keep independent caches', () => {
    const A = 'group-a';
    const B = 'group-b';
    const rB = _createResolverForTests({ ownFolder: B, accessCheck: () => true });
    const rC = _createResolverForTests({ ownFolder: 'group-c', accessCheck: () => true });
    const scope = asCredentialScope(A);

    // Seed A's keys file via a third "owner" resolver that disposes immediately.
    const seeder = _createResolverForTests({ ownFolder: A, accessCheck: () => true });
    seeder.store(scope, 'oauth', 'k', makeCred('shared-secret'));
    seeder.dispose();

    // Both rB and rC start with empty caches; resolve populates each independently.
    expect(rB.resolve(scope, 'oauth', 'k')?.value).toBe('shared-secret');
    expect(rC.resolve(scope, 'oauth', 'k')?.value).toBe('shared-secret');

    // Drop the on-disk file. Both caches still serve from memory.
    fs.unlinkSync(keysFilePath(scope, 'oauth'));
    expect(rB.resolve(scope, 'oauth', 'k')?.value).toBe('shared-secret');
    expect(rC.resolve(scope, 'oauth', 'k')?.value).toBe('shared-secret');

    rB.dispose();
    rC.dispose();
  });

  it('dispose of one resolver does not affect a sibling', () => {
    const rB = _createResolverForTests({ ownFolder: 'group-b', accessCheck: () => true });
    const rC = _createResolverForTests({ ownFolder: 'group-c', accessCheck: () => true });
    const scope = asCredentialScope('group-a');

    const seeder = _createResolverForTests({ ownFolder: 'group-a', accessCheck: () => true });
    seeder.store(scope, 'oauth', 'k', makeCred('val'));
    seeder.dispose();

    // Both populate their caches.
    rB.resolve(scope, 'oauth', 'k');
    rC.resolve(scope, 'oauth', 'k');

    rB.dispose();
    // rC still works.
    expect(rC.resolve(scope, 'oauth', 'k')?.value).toBe('val');
    // rB throws.
    expect(() => rB.resolve(scope, 'oauth', 'k')).toThrow(/after dispose/);

    rC.dispose();
  });

  it('invalidateScope evicts the scope from every live resolver', () => {
    const rB = _createResolverForTests({ ownFolder: 'group-b', accessCheck: () => true });
    const rC = _createResolverForTests({ ownFolder: 'group-c', accessCheck: () => true });
    const A = asCredentialScope('group-a');

    const seeder = _createResolverForTests({ ownFolder: 'group-a', accessCheck: () => true });
    seeder.store(A, 'oauth', 'k', makeCred('orig'));
    seeder.dispose();

    // Warm caches.
    expect(rB.resolve(A, 'oauth', 'k')?.value).toBe('orig');
    expect(rC.resolve(A, 'oauth', 'k')?.value).toBe('orig');

    // Mutate the file directly so cache and disk diverge, then invalidate.
    const raw = readKeysFile(A, 'oauth');
    raw['k'] = { value: 'enc:not-a-real-cipher', updated_ts: 2000 };
    // Write back without going through writeKeysFile so we control invalidation timing.
    fs.writeFileSync(keysFilePath(A, 'oauth'), JSON.stringify({ ...raw, v: 1 }));

    // Caches still hold the original.
    expect(rB.resolve(A, 'oauth', 'k')?.value).toBe('orig');

    // Invalidate the scope — both caches drop.
    invalidateScope(A);

    // Next read forces a disk re-read; bogus ciphertext should now surface as an error.
    expect(() => rB.resolve(A, 'oauth', 'k')).toThrow();
    expect(() => rC.resolve(A, 'oauth', 'k')).toThrow();

    rB.dispose();
    rC.dispose();
  });

  it('grant revoked mid-session: subsequent resolve returns null', () => {
    let granted = true;
    const r = _createResolverForTests({
      ownFolder: 'group-b',
      accessCheck: () => granted,
    });
    const A = asCredentialScope('group-a');

    const seeder = _createResolverForTests({ ownFolder: 'group-a', accessCheck: () => true });
    seeder.store(A, 'oauth', 'k', makeCred('val'));
    seeder.dispose();

    // While granted, resolve succeeds.
    expect(r.resolve(A, 'oauth', 'k')?.value).toBe('val');

    // Revoke.
    granted = false;
    expect(r.resolve(A, 'oauth', 'k')).toBeNull();

    r.dispose();
  });

  it('borrow from inactive grantor: no grantor resolver exists, read still works', () => {
    // A has no resolver — purely on-disk. B borrows from A.
    const A = asCredentialScope('group-a');
    const seeder = _createResolverForTests({ ownFolder: 'group-a', accessCheck: () => true });
    seeder.store(A, 'oauth', 'k', makeCred('grantor-secret'));
    seeder.dispose();
    // No A resolver exists now.

    // B's resolver is allowed to read A.
    const rB = _createResolverForTests({
      ownFolder: 'group-b',
      accessCheck: (scope) => {
        const s = scope as unknown as string;
        return s === 'group-b' || s === 'group-a';
      },
    });

    expect(rB.resolve(A, 'oauth', 'k')?.value).toBe('grantor-secret');
    rB.dispose();
  });

  it('write-through invalidation: B writes, C sees fresh value on next read', () => {
    // Both B and C have the same own folder so both can write — emulates two
    // logical readers, but only B writes. C borrows from B with full access.
    const B = 'group-b';
    const scopeB = asCredentialScope(B);

    const rB = _createResolverForTests({ ownFolder: B, accessCheck: () => true });
    const rC = _createResolverForTests({
      ownFolder: 'group-c',
      accessCheck: () => true,
    });

    rB.store(scopeB, 'oauth', 'k', makeCred('v1'));
    // C warms its cache reading B's scope.
    expect(rC.resolve(scopeB, 'oauth', 'k')?.value).toBe('v1');

    // B updates the credential. write fires invalidateScope which evicts C's cache.
    rB.store(scopeB, 'oauth', 'k', makeCred('v2'));

    // C's next read goes through to disk and sees the fresh value.
    expect(rC.resolve(scopeB, 'oauth', 'k')?.value).toBe('v2');

    rB.dispose();
    rC.dispose();
  });
});

// ---------------------------------------------------------------------------
// Factory + registry
// ---------------------------------------------------------------------------

describe('resolver — per-agent-group factory', () => {
  it('getOrCreateResolverForAgentGroup is idempotent', () => {
    const r1 = getOrCreateResolverForAgentGroup('group-a');
    const r2 = getOrCreateResolverForAgentGroup('group-a');
    expect(r1).toBe(r2);
  });

  it('different folders get distinct resolvers', () => {
    const r1 = getOrCreateResolverForAgentGroup('group-a');
    const r2 = getOrCreateResolverForAgentGroup('group-b');
    expect(r1).not.toBe(r2);
  });

  it('dispose unregisters and a fresh getOrCreate returns a new instance', () => {
    const r1 = getOrCreateResolverForAgentGroup('group-a');
    disposeResolverForAgentGroup('group-a');
    expect(getResolverForAgentGroup('group-a')).toBeNull();
    const r2 = getOrCreateResolverForAgentGroup('group-a');
    expect(r2).not.toBe(r1);
  });

  it('factory resolver consults grants.canAccess (own scope succeeds, foreign fails by default)', () => {
    // Seed grantor's keys.
    const A = asCredentialScope('group-a');
    freshGroupDir('group-a');
    const seeder = _createResolverForTests({ ownFolder: 'group-a', accessCheck: () => true });
    seeder.store(A, 'oauth', 'k', makeCred('s'));
    seeder.dispose();

    // Default factory: no grant wired, so B can't read A.
    freshGroupDir('group-b');
    const rB = getOrCreateResolverForAgentGroup('group-b');
    expect(rB.resolve(A, 'oauth', 'k')).toBeNull();

    // Wire bilateral grant: B borrows from A, A grants to B.
    setBorrowSource('group-b', 'group-a');
    addGrantee('group-a', 'group-b');

    // Now B reads A successfully — no resolver reconstruction needed.
    expect(rB.resolve(A, 'oauth', 'k')?.value).toBe('s');
  });
});

// ---------------------------------------------------------------------------
// Direct writeKeysFile auto-invalidation hook
// ---------------------------------------------------------------------------

describe('resolver — store auto-invalidation', () => {
  it('writeKeysFile fires invalidateScope which evicts the resolver cache', () => {
    const r = ownResolver('group-a');
    const scope = asCredentialScope('group-a');
    r.store(scope, 'oauth', 'k', makeCred('v1'));

    // External writer: bypass the resolver, write via store directly.
    const enc = readKeysFile(scope, 'oauth');
    enc['k'] = { value: 'enc:not-a-real-cipher', updated_ts: 9999 };
    writeKeysFile(scope, 'oauth', enc);

    // Next resolve hits disk (cache was evicted by invalidateScope). The bogus
    // ciphertext should surface as a decrypt error.
    expect(() => r.resolve(scope, 'oauth', 'k')).toThrow();

    r.dispose();
  });
});
