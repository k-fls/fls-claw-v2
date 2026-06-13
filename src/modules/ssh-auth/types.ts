/**
 * SSH credential types and conversion helpers.
 *
 * SSHCredentialMeta provides typed access at the application layer.
 * Conversion functions handle the boundary between SSH-specific types
 * and the generic Credential format used by PersistentCredentialResolver.
 *
 * authType is stored INSIDE the encrypted value as a prefix ('password:'
 * or 'key:') — not in plaintext authFields. Anyone with file access but
 * no encryption key cannot determine the auth method.
 */
import type { Credential, GroupScope } from '../credentials/index.js';

// ── Provider IDs ──────────────────────────────────────────────────

export const SSH_PROVIDER_ID = 'ssh';
export const PEM_PASSWORDS_PROVIDER_ID = 'pem-passwords';

// ── Types ─────────────────────────────────────────────────────────

export interface SSHCredentialMeta {
  host: string;
  port: number;
  username: string;
  /** Derived from encrypted value prefix, NOT stored in authFields. */
  authType: 'password' | 'key';
  /** Derived at registration for all key-type creds. */
  publicKey?: string;
  /** null=unverified, "*"=accept-any, raw key line=pinned. */
  hostKey: string | null;
}

export type HostKeyVerifyResult = 'pinned' | 'matched' | 'ignored' | 'unverified';

export interface ControlMasterConnection {
  alias: string;
  host: string;
  port: number;
  username: string;
  socketPath: string;
  scope: GroupScope;
  /** Result of host key verification during connect. */
  hostKeyAction: HostKeyVerifyResult;
  /** Host key fingerprint (if available). */
  hostKeyFingerprint?: string;
}

// ── Alias validation ──────────────────────────────────────────────

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ALIAS_MAX_LEN = 60;

export function isValidAlias(alias: string): boolean {
  return alias.length > 0 && alias.length <= ALIAS_MAX_LEN && ALIAS_PATTERN.test(alias);
}

/**
 * Validate that a hostKey value is a well-formed fingerprint.
 * SHA256: base64 of 32 bytes (43 chars, no padding).
 * MD5: 16 colon-separated hex pairs (47 chars).
 */
export function isFingerprint(value: string): boolean {
  return (
    /^(SHA256|sha256):[A-Za-z0-9+/]{43}$/.test(value) || /^(MD5|md5):([0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2}$/.test(value)
  );
}

/** Compare two fingerprints. Case-insensitive for prefix and MD5 hex; case-sensitive for SHA256 base64. */
export function fingerprintEqual(a: string, b: string): boolean {
  const prefixA = a.substring(0, 7).toLowerCase();
  if (prefixA.startsWith('md5:')) {
    return a.toLowerCase() === b.toLowerCase();
  }

  // SHA256: prefix is case-insensitive, base64 payload is case-sensitive
  if (prefixA === 'sha256:' && b.substring(0, 7).toLowerCase() === 'sha256:') {
    return a.slice(7) === b.slice(7);
  }
  return false;
}

// ── Connection string parsing ─────────────────────────────────────

export interface ParsedConnectionString {
  username: string;
  host: string;
  port: number;
}

/**
 * Parse user@host[:port]. Supports IPv6 (user@[::1]:22).
 * Returns null on invalid input.
 */
export function parseConnectionString(s: string): ParsedConnectionString | null {
  const atIdx = s.indexOf('@');
  if (atIdx < 1) return null;

  const username = s.slice(0, atIdx);
  let rest = s.slice(atIdx + 1);

  let host: string;
  let port = 22;

  if (rest.startsWith('[')) {
    // IPv6: [::1]:port or [::1]
    const closeBracket = rest.indexOf(']');
    if (closeBracket < 0) return null;
    host = rest.slice(1, closeBracket);
    const afterBracket = rest.slice(closeBracket + 1);
    if (afterBracket.startsWith(':')) {
      port = parseInt(afterBracket.slice(1), 10);
    } else if (afterBracket.length > 0) {
      return null;
    }
  } else {
    // IPv4 or hostname: host[:port]
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx > 0) {
      const portStr = rest.slice(colonIdx + 1);
      const parsed = parseInt(portStr, 10);
      if (!isNaN(parsed)) {
        host = rest.slice(0, colonIdx);
        port = parsed;
      } else {
        host = rest;
      }
    } else {
      host = rest;
    }
  }

  if (!host! || !username) return null;
  if (port < 1 || port > 65535) return null;

  return { username, host: host!, port };
}

// ── Credential conversion ─────────────────────────────────────────

/**
 * Convert SSH metadata + secret to a generic Credential for storage
 * via PersistentCredentialResolver.
 */
export function sshToCredential(secret: string, meta: SSHCredentialMeta): Credential {
  const prefixed = `${meta.authType}:${secret}`;
  return {
    value: prefixed,
    expires_ts: 0,
    updated_ts: Date.now(),
    authFields: {
      host: meta.host,
      port: String(meta.port),
      username: meta.username,
      ...(meta.publicKey && { publicKey: meta.publicKey }),
      ...(meta.hostKey != null && { hostKey: meta.hostKey }),
    },
  };
}

/**
 * Convert a resolved (decrypted) Credential back to SSH metadata + secret.
 * Returns null if the credential isn't a valid SSH credential.
 */
export function sshFromCredential(cred: Credential): { meta: SSHCredentialMeta; secret: string } | null {
  const af = cred.authFields;
  if (!af?.host) return null;
  const colonIdx = cred.value.indexOf(':');
  if (colonIdx < 0) return null;
  const authType = cred.value.slice(0, colonIdx);
  if (authType !== 'password' && authType !== 'key') return null;
  const secret = cred.value.slice(colonIdx + 1);
  return {
    secret,
    meta: {
      host: af.host,
      port: parseInt(af.port, 10) || 22,
      username: af.username,
      authType,
      publicKey: af.publicKey,
      hostKey: af.hostKey ?? null,
    },
  };
}
