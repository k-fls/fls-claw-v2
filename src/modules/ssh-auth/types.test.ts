import { describe, it, expect } from 'vitest';

import {
  isValidAlias,
  isFingerprint,
  fingerprintEqual,
  parseConnectionString,
  sshToCredential,
  sshFromCredential,
} from './types.js';
import type { SSHCredentialMeta } from './types.js';

// ── isValidAlias ─────────────────────────────────────────────────

describe('isValidAlias', () => {
  it('accepts simple alphanumeric', () => {
    expect(isValidAlias('prod-db')).toBe(true);
    expect(isValidAlias('staging_01')).toBe(true);
    expect(isValidAlias('A')).toBe(true);
  });

  it('rejects empty', () => {
    expect(isValidAlias('')).toBe(false);
  });

  it('rejects leading hyphen/underscore', () => {
    expect(isValidAlias('-bad')).toBe(false);
    expect(isValidAlias('_bad')).toBe(false);
  });

  it('rejects special characters', () => {
    expect(isValidAlias('foo bar')).toBe(false);
    expect(isValidAlias('foo@bar')).toBe(false);
    expect(isValidAlias('foo.bar')).toBe(false);
  });

  it('rejects over 60 chars', () => {
    expect(isValidAlias('a'.repeat(60))).toBe(true);
    expect(isValidAlias('a'.repeat(61))).toBe(false);
  });
});

// ── isFingerprint ────────────────────────────────────────────────

describe('isFingerprint', () => {
  // Real-world SHA256 fingerprint (43 base64 chars)
  const sha256 = 'SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
  // Real-world MD5 fingerprint (16 colon-separated hex pairs)
  const md5 = 'MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48';

  it('accepts valid SHA256 fingerprint', () => {
    expect(isFingerprint(sha256)).toBe(true);
  });

  it('accepts lowercase sha256 prefix', () => {
    expect(isFingerprint('sha256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs')).toBe(true);
  });

  it('accepts valid MD5 fingerprint', () => {
    expect(isFingerprint(md5)).toBe(true);
  });

  it('accepts lowercase md5 prefix', () => {
    expect(isFingerprint('md5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48')).toBe(true);
  });

  it('accepts MD5 with uppercase hex', () => {
    expect(isFingerprint('MD5:16:27:AC:A5:76:28:2D:36:63:1B:56:4D:EB:DF:A6:48')).toBe(true);
  });

  it('rejects SHA256 with wrong length', () => {
    expect(isFingerprint('SHA256:tooshort')).toBe(false);
    expect(isFingerprint('SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZsX')).toBe(false); // 44 chars
  });

  it('rejects MD5 with wrong pair count', () => {
    expect(isFingerprint('MD5:16:27:ac')).toBe(false);
    expect(isFingerprint('MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48:ff')).toBe(false); // 17 pairs
  });

  it('rejects garbage strings', () => {
    expect(isFingerprint('foobar')).toBe(false);
    expect(isFingerprint('')).toBe(false);
    expect(isFingerprint('*')).toBe(false);
  });

  it('rejects raw key lines', () => {
    expect(isFingerprint('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA')).toBe(false);
    expect(isFingerprint('hostname ssh-rsa AAAAB3NzaC1yc2EAAAA')).toBe(false);
  });

  it('rejects mixed-case prefix like Sha256', () => {
    expect(isFingerprint('Sha256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs')).toBe(false);
  });
});

// ── fingerprintEqual ─────────────────────────────────────────────

describe('fingerprintEqual', () => {
  const sha256 = 'SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
  const md5 = 'MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48';

  it('matches identical SHA256', () => {
    expect(fingerprintEqual(sha256, sha256)).toBe(true);
  });

  it('matches SHA256 with different prefix case', () => {
    const lower = 'sha256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
    expect(fingerprintEqual(sha256, lower)).toBe(true);
    expect(fingerprintEqual(lower, sha256)).toBe(true);
  });

  it('rejects SHA256 with different payload', () => {
    const other = 'SHA256:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    expect(fingerprintEqual(sha256, other)).toBe(false);
  });

  it('SHA256 payload comparison is case-sensitive', () => {
    const upper = 'SHA256:7+GVK8GKLRIIBMHAE0DRYN1VIOXMJMJHAG0BWIPWBZS';
    expect(fingerprintEqual(sha256, upper)).toBe(false);
  });

  it('matches identical MD5', () => {
    expect(fingerprintEqual(md5, md5)).toBe(true);
  });

  it('matches MD5 case-insensitively', () => {
    const upper = 'MD5:16:27:AC:A5:76:28:2D:36:63:1B:56:4D:EB:DF:A6:48';
    expect(fingerprintEqual(md5, upper)).toBe(true);
    expect(fingerprintEqual(upper, md5)).toBe(true);
  });

  it('matches MD5 with lowercase prefix', () => {
    const lower = 'md5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48';
    expect(fingerprintEqual(md5, lower)).toBe(true);
  });

  it('rejects MD5 with different hex', () => {
    const other = 'MD5:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff';
    expect(fingerprintEqual(md5, other)).toBe(false);
  });

  it('returns false for mismatched types', () => {
    expect(fingerprintEqual(sha256, md5)).toBe(false);
    expect(fingerprintEqual(md5, sha256)).toBe(false);
  });

  it('returns false for non-fingerprint strings', () => {
    expect(fingerprintEqual('garbage', 'garbage')).toBe(false);
    expect(fingerprintEqual('*', '*')).toBe(false);
  });
});

// ── parseConnectionString ────────────────────────────────────────

describe('parseConnectionString', () => {
  it('parses user@host', () => {
    expect(parseConnectionString('deploy@prod.example.com')).toEqual({
      username: 'deploy',
      host: 'prod.example.com',
      port: 22,
    });
  });

  it('parses user@host:port', () => {
    expect(parseConnectionString('deploy@prod.example.com:2222')).toEqual({
      username: 'deploy',
      host: 'prod.example.com',
      port: 2222,
    });
  });

  it('parses IPv6 user@[::1]:port', () => {
    expect(parseConnectionString('root@[::1]:22')).toEqual({
      username: 'root',
      host: '::1',
      port: 22,
    });
  });

  it('parses IPv6 without port', () => {
    expect(parseConnectionString('root@[::1]')).toEqual({
      username: 'root',
      host: '::1',
      port: 22,
    });
  });

  it('rejects missing @', () => {
    expect(parseConnectionString('nope')).toBeNull();
  });

  it('rejects empty username', () => {
    expect(parseConnectionString('@host')).toBeNull();
  });

  it('rejects port out of range', () => {
    expect(parseConnectionString('u@h:0')).toBeNull();
    expect(parseConnectionString('u@h:65536')).toBeNull();
  });

  it('accepts boundary ports', () => {
    expect(parseConnectionString('u@h:1')?.port).toBe(1);
    expect(parseConnectionString('u@h:65535')?.port).toBe(65535);
  });
});

// ── sshToCredential / sshFromCredential round-trip ───────────────

describe('credential conversion', () => {
  const meta: SSHCredentialMeta = {
    host: 'prod.example.com',
    port: 2222,
    username: 'deploy',
    authType: 'password',
    hostKey: null,
  };

  it('round-trips password credential', () => {
    const cred = sshToCredential('s3cret', meta);
    const back = sshFromCredential(cred);
    expect(back).not.toBeNull();
    expect(back!.secret).toBe('s3cret');
    expect(back!.meta.authType).toBe('password');
    expect(back!.meta.host).toBe('prod.example.com');
    expect(back!.meta.port).toBe(2222);
    expect(back!.meta.username).toBe('deploy');
    expect(back!.meta.hostKey).toBeNull();
  });

  it('round-trips key credential with publicKey', () => {
    const keyMeta: SSHCredentialMeta = {
      ...meta,
      authType: 'key',
      publicKey: 'ssh-ed25519 AAAA...',
    };
    const cred = sshToCredential('PEM_CONTENT', keyMeta);
    const back = sshFromCredential(cred);
    expect(back!.secret).toBe('PEM_CONTENT');
    expect(back!.meta.authType).toBe('key');
    expect(back!.meta.publicKey).toBe('ssh-ed25519 AAAA...');
  });

  it('preserves hostKey when set', () => {
    const pinned: SSHCredentialMeta = { ...meta, hostKey: '*' };
    const cred = sshToCredential('pw', pinned);
    const back = sshFromCredential(cred);
    expect(back!.meta.hostKey).toBe('*');
  });

  it('coerces port between number and string', () => {
    const cred = sshToCredential('pw', meta);
    expect(cred.authFields!.port).toBe('2222');
    const back = sshFromCredential(cred);
    expect(back!.meta.port).toBe(2222);
  });

  it('returns null for missing authFields.host', () => {
    expect(sshFromCredential({ value: 'password:x', expires_ts: 0, updated_ts: 0 })).toBeNull();
    expect(sshFromCredential({ value: 'password:x', expires_ts: 0, updated_ts: 0, authFields: {} })).toBeNull();
  });

  it('returns null for missing colon in value', () => {
    expect(
      sshFromCredential({ value: 'noprefix', expires_ts: 0, updated_ts: 0, authFields: { host: 'h' } }),
    ).toBeNull();
  });

  it('returns null for invalid authType prefix', () => {
    expect(sshFromCredential({ value: 'other:x', expires_ts: 0, updated_ts: 0, authFields: { host: 'h' } })).toBeNull();
  });
});
