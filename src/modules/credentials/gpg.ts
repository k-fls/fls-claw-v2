/**
 * Per-scope GPG keypair management for the credentials module (C6).
 *
 * Thin scope-bound wrappers over `src/modules/crypto/gpg.ts`. Binds the
 * GPG base directory to `${XDG_CONFIG_HOME:-~/.config}/nanoclaw/gpg-home/`
 * and accepts `CredentialScope` (branded) instead of raw strings so the
 * storage/runtime axis distinction is preserved at the call site.
 *
 * Used by `/auth import` (C7o) and `/pem add` / `/ssh add` (CS3) to
 * resolve the GNUPGHOME directory passed to A1a's `pastePgp` helper for
 * PGP-encrypted credential pastes.
 *
 * Layout (filesystem):
 *   ${XDG_CONFIG_HOME:-~/.config}/nanoclaw/gpg-home/{credentialScope}/.gnupg/
 *
 * Side-effect-safety: importing this file performs no filesystem I/O.
 * The base directory is resolved lazily at first call so consumers that
 * import the credentials barrel for type re-exports never incur a
 * homedir lookup.
 */
import crypto from 'crypto';
import os from 'os';
import path from 'path';

import {
  ensureGpgKey as ensureGpgKeyAt,
  exportPublicKey as exportPublicKeyAt,
  exportPublicKeyBinary as exportPublicKeyBinaryAt,
  getKeyMeta as getKeyMetaAt,
  gpgDecryptAt,
  gpgHome as gpgHomeAt,
  isKeyExpired as isKeyExpiredAt,
  type GpgKeyMeta,
} from '../crypto/gpg.js';

import type { CredentialScope } from './types.js';

export { isGpgAvailable, isPgpMessage, normalizeArmoredBlock } from '../crypto/gpg.js';
export type { GpgKeyMeta } from '../crypto/gpg.js';

/**
 * Resolve the GPG base directory: `${XDG_CONFIG_HOME:-~/.config}/nanoclaw/gpg-home/`.
 * Evaluated on every call so test harnesses that override `HOME` or
 * `XDG_CONFIG_HOME` at runtime see the override.
 */
function gpgBaseDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg && xdg.length > 0 ? xdg : path.join(process.env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'nanoclaw', 'gpg-home');
}

/**
 * Absolute path to the per-scope GNUPGHOME directory. Pass this to
 * `pastePgp({ gpgHome })` from `src/modules/interactions/`.
 *
 * Pure path computation — does not create the directory or touch disk.
 * Call `ensureGpgKey(scope)` before relying on the homedir existing.
 */
export function gpgHomeForScope(scope: CredentialScope): string {
  return gpgHomeAt(gpgBaseDir(), scope);
}

/**
 * Ensure a GPG keypair exists for `scope`. Creates the homedir and
 * generates a keypair if missing; no-op if a key already lives there.
 * Records creation timestamp + max age in `key-meta.json` so expiry can
 * be checked later.
 */
export function ensureGpgKey(scope: CredentialScope, maxAgeDays?: number): void {
  ensureGpgKeyAt(gpgBaseDir(), scope, maxAgeDays);
}

/**
 * Export the ASCII-armored public key for `scope`. If the key has
 * expired (per `key-meta.json`), it is regenerated first and the new
 * public key is returned. Decryption (`pastePgp` → `gpgDecryptAt`) is
 * never affected by expiry — existing ciphertext stays decryptable.
 */
export function exportPublicKey(scope: CredentialScope): string {
  return exportPublicKeyAt(gpgBaseDir(), scope);
}

/**
 * Export the raw binary public key for `scope`. Used to embed the key
 * in a pgp-encrypt URL (see `buildPgpEncryptUrl`). Expiry behavior
 * matches `exportPublicKey` — the keypair regenerates if past max age.
 */
export function exportPublicKeyBinary(scope: CredentialScope): Buffer {
  return exportPublicKeyBinaryAt(gpgBaseDir(), scope);
}

/** Base URL of the pgp-encrypt helper page consumed by `buildPgpEncryptUrl`. */
export const PGP_ENCRYPT_BASE_URL = 'https://k-fls.github.io/pgp-encrypt/';

/**
 * Build a pgp-encrypt URL with the scope's binary public key embedded.
 * Format: `?key=<base64url-binary-key>&hash=<sha256-hex>`.
 *
 * The hash lets the helper page verify the key wasn't tampered with in
 * transit (the user can paste the link into chat, the page checks the
 * hash before using the key for encryption).
 */
export function buildPgpEncryptUrl(scope: CredentialScope): string {
  const binaryKey = exportPublicKeyBinary(scope);
  const keyParam = binaryKey.toString('base64url');
  const hashParam = crypto.createHash('sha256').update(binaryKey).digest('hex');
  return `${PGP_ENCRYPT_BASE_URL}?key=${keyParam}&hash=${hashParam}`;
}

/** Read key metadata for `scope`. Returns null if the key has not been generated yet. */
export function getKeyMeta(scope: CredentialScope): GpgKeyMeta | null {
  return getKeyMetaAt(gpgBaseDir(), scope);
}

/** Check whether the GPG key for `scope` has passed its configured max age. */
export function isKeyExpired(scope: CredentialScope): boolean {
  return isKeyExpiredAt(gpgBaseDir(), scope);
}

/** Decrypt a PGP ciphertext using the per-scope GNUPGHOME. */
export function gpgDecrypt(scope: CredentialScope, ciphertext: string): string {
  return gpgDecryptAt(gpgHomeForScope(scope), ciphertext);
}
