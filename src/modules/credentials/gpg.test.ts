/**
 * C6 — per-scope GPG wrapper tests.
 *
 * Covers:
 *   - Path resolution honors XDG_CONFIG_HOME, falls back to ~/.config.
 *   - Importing the credentials barrel (including the new gpg surface)
 *     performs no filesystem I/O.
 *   - ensureGpgKey / exportPublicKey / isKeyExpired work end-to-end
 *     when gpg is available (mirrors the gating in crypto/gpg.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { asCredentialScope } from './types.js';

// Keep paths short — gpg-agent sockets must stay under the 107-char Unix
// socket length limit.
const tmpDir = path.join(os.tmpdir(), `nc-creds-gpg-${process.pid}`);

let gpgAvailable = false;
try {
  execFileSync('gpg', ['--version'], { stdio: 'ignore' });
  gpgAvailable = true;
} catch {
  gpgAvailable = false;
}

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('gpgHomeForScope', () => {
  it('honors XDG_CONFIG_HOME when set', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);
    const { gpgHomeForScope } = await import('./gpg.js');
    expect(gpgHomeForScope(asCredentialScope('group-a'))).toBe(
      path.join(tmpDir, 'nanoclaw', 'gpg-home', 'group-a', '.gnupg'),
    );
  });

  it('falls back to $HOME/.config when XDG_CONFIG_HOME is unset', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('HOME', tmpDir);
    const { gpgHomeForScope } = await import('./gpg.js');
    expect(gpgHomeForScope(asCredentialScope('group-b'))).toBe(
      path.join(tmpDir, '.config', 'nanoclaw', 'gpg-home', 'group-b', '.gnupg'),
    );
  });
});

// ---------------------------------------------------------------------------
// Side-effect safety at import time
// ---------------------------------------------------------------------------

describe('module load', () => {
  it('importing the credentials barrel performs no filesystem I/O', async () => {
    const nonexistent = path.join(tmpDir, 'nope-does-not-exist');
    vi.stubEnv('HOME', nonexistent);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    // Re-import a fresh copy of the barrel under the stubbed env.
    vi.resetModules();
    await import('./index.js');
    expect(fs.existsSync(path.join(nonexistent, '.config', 'nanoclaw'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end key lifecycle (gpg binary required)
// ---------------------------------------------------------------------------

describe.skipIf(!gpgAvailable)('GPG key lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);
  });

  it('ensureGpgKey creates the homedir and a keypair', async () => {
    const { ensureGpgKey, gpgHomeForScope, getKeyMeta, isKeyExpired } = await import('./gpg.js');
    const scope = asCredentialScope('lifecycle-a');

    ensureGpgKey(scope);
    expect(fs.existsSync(gpgHomeForScope(scope))).toBe(true);

    const meta = getKeyMeta(scope);
    expect(meta).not.toBeNull();
    expect(typeof meta!.createdAt).toBe('string');
    expect(meta!.maxAgeDays).toBeGreaterThan(0);
    expect(isKeyExpired(scope)).toBe(false);
  });

  it('exportPublicKey returns an armored public-key block', async () => {
    const { ensureGpgKey, exportPublicKey } = await import('./gpg.js');
    const scope = asCredentialScope('lifecycle-b');

    ensureGpgKey(scope);
    const armored = exportPublicKey(scope);
    expect(armored.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toBe(true);
    expect(armored.endsWith('-----END PGP PUBLIC KEY BLOCK-----')).toBe(true);
  });

  it('ensureGpgKey is idempotent on the second call', async () => {
    const { ensureGpgKey, exportPublicKey } = await import('./gpg.js');
    const scope = asCredentialScope('lifecycle-c');

    ensureGpgKey(scope);
    const first = exportPublicKey(scope);
    ensureGpgKey(scope);
    const second = exportPublicKey(scope);
    expect(second).toBe(first);
  });

  it('exportPublicKeyBinary returns a non-empty Buffer with no armor headers', async () => {
    const { ensureGpgKey, exportPublicKeyBinary } = await import('./gpg.js');
    const scope = asCredentialScope('lifecycle-d');

    ensureGpgKey(scope);
    const bin = exportPublicKeyBinary(scope);
    expect(Buffer.isBuffer(bin)).toBe(true);
    expect(bin.length).toBeGreaterThan(0);
    // Binary export must not contain ASCII armor markers.
    expect(bin.toString('utf-8')).not.toContain('-----BEGIN PGP');
  });

  it('buildPgpEncryptUrl embeds base64url key and matching sha256 hash', async () => {
    const cryptoMod = await import('crypto');
    const { ensureGpgKey, exportPublicKeyBinary, buildPgpEncryptUrl, PGP_ENCRYPT_BASE_URL } = await import('./gpg.js');
    const scope = asCredentialScope('lifecycle-e');

    ensureGpgKey(scope);
    const url = buildPgpEncryptUrl(scope);
    expect(url.startsWith(PGP_ENCRYPT_BASE_URL + '?key=')).toBe(true);

    const parsed = new URL(url);
    const keyParam = parsed.searchParams.get('key');
    const hashParam = parsed.searchParams.get('hash');
    expect(keyParam).not.toBeNull();
    expect(hashParam).not.toBeNull();

    const expectedKey = exportPublicKeyBinary(scope).toString('base64url');
    const expectedHash = cryptoMod.createHash('sha256').update(Buffer.from(keyParam!, 'base64url')).digest('hex');
    expect(keyParam).toBe(expectedKey);
    expect(hashParam).toBe(expectedHash);
  });
});
