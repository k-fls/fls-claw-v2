import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Keep path short to stay under Unix socket limit (107 chars for S.gpg-agent.browser)
const tmpDir = path.join(os.tmpdir(), `nc-gpg-${process.pid}`);
vi.stubEnv('HOME', tmpDir);

const baseDir = path.join(tmpDir, '.config', 'nanoclaw', 'credentials');

beforeEach(() => {
  fs.mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const {
  isGpgAvailable,
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  isPgpMessage,
  gpgHome,
  isKeyExpired,
  getKeyMeta,
  initGpg,
  gpg,
  DEFAULT_KEY_MAX_AGE_DAYS,
} = await import('./gpg.js');

// ---------------------------------------------------------------------------
// isPgpMessage (no GPG needed)
// ---------------------------------------------------------------------------

describe('isPgpMessage', () => {
  it('detects PGP message header', () => {
    expect(isPgpMessage('-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----')).toBe(true);
  });

  it('detects PGP header with surrounding text', () => {
    expect(isPgpMessage('here is the encrypted key:\n-----BEGIN PGP MESSAGE-----\nabc')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isPgpMessage('sk-ant-api03-test')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPgpMessage('')).toBe(false);
  });

  it('returns false for other PGP blocks', () => {
    expect(isPgpMessage('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gpgHome
// ---------------------------------------------------------------------------

describe('gpgHome', () => {
  it('returns correct path', () => {
    expect(gpgHome('/base', 'my-scope')).toBe('/base/my-scope/.gnupg');
  });
});

// ---------------------------------------------------------------------------
// Key metadata (no GPG needed)
// ---------------------------------------------------------------------------

describe('key metadata', () => {
  it('getKeyMeta returns null when no meta file exists', () => {
    expect(getKeyMeta(baseDir, 'no-such-scope')).toBeNull();
  });

  it('isKeyExpired returns false when no meta file exists (legacy)', () => {
    expect(isKeyExpired(baseDir, 'no-such-scope')).toBe(false);
  });

  it('DEFAULT_KEY_MAX_AGE_DAYS is 90', () => {
    expect(DEFAULT_KEY_MAX_AGE_DAYS).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// GPG integration tests — only run if gpg is available
// ---------------------------------------------------------------------------

const gpgAvailable = isGpgAvailable();

describe.skipIf(!gpgAvailable)('GPG integration', () => {
  it('isGpgAvailable returns true', () => {
    expect(isGpgAvailable()).toBe(true);
  });

  it('ensureGpgKey creates a keypair', () => {
    ensureGpgKey(baseDir, 'gpg-test-scope');
    const gnupgDir = gpgHome(baseDir, 'gpg-test-scope');
    expect(fs.existsSync(gnupgDir)).toBe(true);
  });

  it('ensureGpgKey is idempotent', () => {
    ensureGpgKey(baseDir, 'gpg-idem-scope');
    ensureGpgKey(baseDir, 'gpg-idem-scope');
    // No error on second call
  });

  it('ensureGpgKey writes key-meta.json', () => {
    ensureGpgKey(baseDir, 'gpg-meta-scope');
    const meta = getKeyMeta(baseDir, 'gpg-meta-scope');
    expect(meta).not.toBeNull();
    expect(meta!.maxAgeDays).toBe(DEFAULT_KEY_MAX_AGE_DAYS);
    expect(new Date(meta!.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('ensureGpgKey respects custom maxAgeDays', () => {
    ensureGpgKey(baseDir, 'gpg-custom-age', 30);
    const meta = getKeyMeta(baseDir, 'gpg-custom-age');
    expect(meta!.maxAgeDays).toBe(30);
  });

  it('isKeyExpired returns false for fresh key', () => {
    ensureGpgKey(baseDir, 'gpg-fresh-scope');
    expect(isKeyExpired(baseDir, 'gpg-fresh-scope')).toBe(false);
  });

  it('isKeyExpired returns true for backdated key', () => {
    ensureGpgKey(baseDir, 'gpg-old-scope');
    // Backdate the meta to 100 days ago
    const metaFile = path.join(gpgHome(baseDir, 'gpg-old-scope'), 'key-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    meta.createdAt = new Date(Date.now() - 100 * 86_400_000).toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    expect(isKeyExpired(baseDir, 'gpg-old-scope')).toBe(true);
  });

  it('exportPublicKey returns ASCII-armored key', () => {
    ensureGpgKey(baseDir, 'gpg-export-scope');
    const pubKey = exportPublicKey(baseDir, 'gpg-export-scope');
    expect(pubKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(pubKey).toContain('-----END PGP PUBLIC KEY BLOCK-----');
  });

  it('exportPublicKey regenerates expired key', () => {
    const scope = 'gpg-expire-export';
    ensureGpgKey(baseDir, scope);
    const oldKey = exportPublicKey(baseDir, scope);

    // Backdate the meta
    const metaFile = path.join(gpgHome(baseDir, scope), 'key-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    meta.createdAt = new Date(Date.now() - 100 * 86_400_000).toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta));

    // Export should regenerate
    const newKey = exportPublicKey(baseDir, scope);
    expect(newKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(newKey).not.toBe(oldKey); // different keypair

    // Meta should be refreshed
    const freshMeta = getKeyMeta(baseDir, scope);
    expect(isKeyExpired(baseDir, scope)).toBe(false);
    expect(new Date(freshMeta!.createdAt).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('encrypt and decrypt round-trip', () => {
    const scope = 'gpg-roundtrip';
    ensureGpgKey(baseDir, scope);
    const pubKey = exportPublicKey(baseDir, scope);

    // Import the public key into a separate temp gpg homedir to simulate user side
    const userGpgHome = path.join(tmpDir, 'user-gpg');
    fs.mkdirSync(userGpgHome, { mode: 0o700, recursive: true });

    execFileSync('gpg', ['--homedir', userGpgHome, '--batch', '--import'], {
      input: pubKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Encrypt as the user would
    const plaintext = 'sk-ant-api03-my-secret-key';
    const encrypted = execFileSync(
      'gpg',
      [
        '--homedir',
        userGpgHome,
        '--batch',
        '--trust-model',
        'always',
        '--encrypt',
        '--armor',
        '--recipient',
        'nanoclaw',
      ],
      { input: plaintext, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf-8');

    expect(encrypted).toContain('-----BEGIN PGP MESSAGE-----');

    // Decrypt on the server side
    const decrypted = gpgDecrypt(baseDir, scope, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('gpgDecrypt works regardless of key expiry', () => {
    const scope = 'gpg-expired-decrypt';
    ensureGpgKey(baseDir, scope);
    const pubKey = exportPublicKey(baseDir, scope);

    // Encrypt something
    const userGpgHome = path.join(tmpDir, 'user-gpg-exp');
    fs.mkdirSync(userGpgHome, { mode: 0o700, recursive: true });
    execFileSync('gpg', ['--homedir', userGpgHome, '--batch', '--import'], {
      input: pubKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const encrypted = execFileSync(
      'gpg',
      [
        '--homedir',
        userGpgHome,
        '--batch',
        '--trust-model',
        'always',
        '--encrypt',
        '--armor',
        '--recipient',
        'nanoclaw',
      ],
      { input: 'secret-data', stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf-8');

    // Backdate the meta to make the key "expired"
    const metaFile = path.join(gpgHome(baseDir, scope), 'key-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    meta.createdAt = new Date(Date.now() - 100 * 86_400_000).toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta));

    // Decrypt should still work (expiry not checked)
    const decrypted = gpgDecrypt(baseDir, scope, encrypted);
    expect(decrypted).toBe('secret-data');
  });

  it('gpgDecrypt throws on invalid ciphertext', () => {
    const scope = 'gpg-bad-decrypt';
    ensureGpgKey(baseDir, scope);

    expect(() =>
      gpgDecrypt(baseDir, scope, '-----BEGIN PGP MESSAGE-----\ninvalid\n-----END PGP MESSAGE-----'),
    ).toThrow();
  });

  it('different scopes have independent keys', () => {
    ensureGpgKey(baseDir, 'scope-a');
    ensureGpgKey(baseDir, 'scope-b');

    const keyA = exportPublicKey(baseDir, 'scope-a');
    const keyB = exportPublicKey(baseDir, 'scope-b');

    expect(keyA).not.toBe(keyB);
  });
});

// ---------------------------------------------------------------------------
// initGpg + gpg.* convenience wrappers
// ---------------------------------------------------------------------------

describe.skipIf(!gpgAvailable)('gpg convenience (initGpg + gpg.*)', () => {
  beforeEach(() => {
    initGpg(baseDir);
  });

  it('gpg.ensure creates a keypair', () => {
    gpg.ensure('conv-scope');
    expect(fs.existsSync(gpgHome(baseDir, 'conv-scope'))).toBe(true);
  });

  it('gpg.export returns public key', () => {
    gpg.ensure('conv-export');
    const pubKey = gpg.export('conv-export');
    expect(pubKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  });

  it('gpg.decrypt round-trips', () => {
    const scope = 'conv-rt';
    gpg.ensure(scope);
    const pubKey = gpg.export(scope);

    const userHome = path.join(tmpDir, 'user-gpg-conv');
    fs.mkdirSync(userHome, { mode: 0o700, recursive: true });
    execFileSync('gpg', ['--homedir', userHome, '--batch', '--import'], {
      input: pubKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const encrypted = execFileSync(
      'gpg',
      ['--homedir', userHome, '--batch', '--trust-model', 'always', '--encrypt', '--armor', '--recipient', 'nanoclaw'],
      { input: 'conv-secret', stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf-8');

    expect(gpg.decrypt(scope, encrypted)).toBe('conv-secret');
  });

  it('gpg.expired returns false for fresh key', () => {
    gpg.ensure('conv-fresh');
    expect(gpg.expired('conv-fresh')).toBe(false);
  });

  it('gpg.meta returns metadata', () => {
    gpg.ensure('conv-meta');
    const meta = gpg.meta('conv-meta');
    expect(meta).not.toBeNull();
    expect(meta!.maxAgeDays).toBe(DEFAULT_KEY_MAX_AGE_DAYS);
  });

  it('gpg.home returns correct path', () => {
    expect(gpg.home('my-scope')).toBe(gpgHome(baseDir, 'my-scope'));
  });

  it('initGpg respects custom maxAgeDays', () => {
    initGpg(baseDir, 45);
    gpg.ensure('conv-custom-age');
    const meta = gpg.meta('conv-custom-age');
    expect(meta!.maxAgeDays).toBe(45);
  });
});
