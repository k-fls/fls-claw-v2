/**
 * Secret backend interface and shared constants.
 *
 * Abstracts encryption/decryption behind a pluggable interface.
 * The file-based AES-256-GCM implementation is the default; future
 * backends (HashiCorp Vault transit, AWS KMS envelope) can replace it
 * without changing callers.
 */

/** Prefix that marks an encrypted string. */
export const ENC_PREFIX = 'enc:';

/**
 * Pluggable secret backend.
 *
 * All methods are sync. If a future vault backend needs async,
 * the interface can be extended then — that change is trivial
 * compared to the vault integration itself.
 */
export interface SecretBackend {
  /** Encrypt plaintext into a self-describing encrypted string. */
  encrypt(plaintext: string): string;

  /**
   * Decrypt an encrypted string. Returns plaintext as-is if the
   * value does not start with the `enc:` prefix (backward compat).
   */
  decrypt(value: string): string;

  /**
   * Check whether a value was encrypted with this backend's current key.
   * Returns false for plaintext (no enc: prefix).
   * Returns false for ciphertext encrypted with a different key.
   */
  isCurrentKey(value: string): boolean;
}
