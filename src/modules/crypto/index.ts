/**
 * Crypto barrel — initialization, backend access, convenience wrappers.
 *
 * Caller responsibilities:
 *   - Choose where the AES key file lives (pass `keyPath` to initEncryption).
 *   - Choose where the GPG homedir base lives (pass `baseDir` to initGpg
 *     or to the per-function APIs in gpg.ts).
 *
 * This module owns no default paths.
 */
import fs from 'fs';
import path from 'path';

import { AesSecretBackend } from './aes.js';
import { log } from '../../log.js';

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { SecretBackend } from './types.js';
export { ENC_PREFIX } from './types.js';
export { AesSecretBackend } from './aes.js';
export type { GpgKeyMeta } from './gpg.js';
export {
  isGpgAvailable,
  ensureGpgKey,
  exportPublicKey,
  exportPublicKeyBinary,
  gpgDecrypt,
  gpgDecryptAt,
  isPgpMessage,
  gpgHome,
  isKeyExpired,
  getKeyMeta,
  initGpg,
  gpg,
  DEFAULT_KEY_MAX_AGE_DAYS,
  normalizeArmoredBlock,
} from './gpg.js';

// ── Singleton ───────────────────────────────────────────────────────────────

let backend: AesSecretBackend | null = null;

/**
 * Initialize encryption. Generates the key file if missing, then loads
 * the AES-256-GCM backend. Must be called once at startup before any
 * encrypt/decrypt calls.
 */
export function initEncryption(keyPath: string): void {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  backend = AesSecretBackend.fromKeyFile(keyPath);
  log.info('Encryption initialized');
}

/** Get the initialized secret backend. Throws if not initialized. */
export function getSecretBackend(): AesSecretBackend {
  if (!backend) {
    throw new Error('Encryption not initialized — call initEncryption() first');
  }
  return backend;
}

// ── Convenience wrappers ────────────────────────────────────────────────────

/** Encrypt plaintext with the file-based AES backend. */
export function encrypt(plaintext: string): string {
  return getSecretBackend().encrypt(plaintext);
}

/** Decrypt value with the file-based AES backend. Passes through plaintext. */
export function decrypt(value: string): string {
  return getSecretBackend().decrypt(value);
}

// ── Key rotation helpers ────────────────────────────────────────────────────

/**
 * Re-encrypt a value with the current key. Decrypts then re-encrypts.
 * If the value is plaintext, just encrypts it.
 */
export function reEncrypt(value: string): string {
  return encrypt(decrypt(value));
}
