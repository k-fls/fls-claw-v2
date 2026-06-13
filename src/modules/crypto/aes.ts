/**
 * AES-256-GCM file-based secret backend.
 *
 * Key: 32-byte random, stored as hex at a caller-provided path, mode 0600.
 *
 * Encrypted format: enc:aes-256-gcm:{keyHash16}:{iv_b64}:{tag_b64}:{ct_b64}
 *   keyHash16 — first 16 chars of SHA256(key), for key mismatch detection
 *   iv        — random 12-byte IV per encryption (AES-GCM requirement)
 *   tag       — 16-byte authentication tag
 *   ct        — ciphertext
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { SecretBackend } from './types.js';
import { ENC_PREFIX } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class AesSecretBackend implements SecretBackend {
  private readonly key: Buffer;
  private readonly hash16: string;

  /** Construct from a raw 32-byte key buffer (useful for testing). */
  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    this.key = key;
    this.hash16 = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /**
   * Load or generate the key file and return an initialized backend.
   * Creates the key file (mode 0600) with 32 random bytes if it does
   * not exist. Throws if the file contains an invalid key.
   */
  static fromKeyFile(keyPath: string): AesSecretBackend {
    if (!fs.existsSync(keyPath)) {
      const hex = crypto.randomBytes(KEY_BYTES).toString('hex');
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, hex, { mode: 0o600 });
    }

    const hex = fs.readFileSync(keyPath, 'utf-8').trim();
    const buf = Buffer.from(hex, 'hex');
    return new AesSecretBackend(buf);
  }

  /** Encrypt plaintext → enc:aes-256-gcm:{keyHash16}:{iv}:{tag}:{ciphertext} */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'enc',
      ALGORITHM,
      this.hash16,
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  /** Decrypt enc: prefixed string, or return plaintext as-is. */
  decrypt(value: string): string {
    if (!value.startsWith(ENC_PREFIX)) return value;

    const parts = value.split(':');
    // enc : algorithm : keyHash : iv : tag : ciphertext
    if (parts.length !== 6) throw new Error('Malformed encrypted value');

    const storedHash = parts[2];
    if (storedHash && storedHash !== this.hash16) {
      throw new Error('Encryption key mismatch — value was encrypted with a different key');
    }

    const iv = Buffer.from(parts[3], 'base64');
    const tag = Buffer.from(parts[4], 'base64');
    const ciphertext = Buffer.from(parts[5], 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf-8');
  }

  isCurrentKey(value: string): boolean {
    if (!value.startsWith(ENC_PREFIX)) return false;
    const parts = value.split(':');
    if (parts.length !== 6) return false;
    return parts[2] === this.hash16;
  }

  /** First 16 characters of SHA256(key) — for external key mismatch checks. */
  get keyHash(): string {
    return this.hash16;
  }
}
