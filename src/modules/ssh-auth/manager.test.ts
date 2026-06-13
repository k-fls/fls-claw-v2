import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Mock child_process — all external commands go through here
const mockExecFileSync = vi.fn();
const mockSpawn = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

import {
  SSHManager,
  SSHError,
  SSHHostKeyMismatchError,
  scopeHash,
  socketDir,
  socketPath,
  containerSocketPath,
} from './manager.js';
import { sshToCredential } from './types.js';
import type { SSHCredentialMeta, HostKeyVerifyResult } from './types.js';
import type { Credential, CredentialScope, GroupScope } from '../credentials/index.js';
import type { CredentialResolver } from './manager.js';
import { asCredentialScope, asGroupScope } from '../credentials/index.js';

// ── Helpers ──────────────────────────────────────────────────────

const scope = asGroupScope('test-group');
const credScope = asCredentialScope('test-group');
const sourceScope = asCredentialScope('source-group');

function makeMeta(overrides: Partial<SSHCredentialMeta> = {}): SSHCredentialMeta {
  return {
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    hostKey: null,
    ...overrides,
  };
}

function makeResolver(store: Record<string, Record<string, Credential>> = {}): CredentialResolver {
  return {
    store: vi.fn((providerId, scope, id, cred) => {
      const key = `${scope as string}/${providerId}`;
      if (!store[key]) store[key] = {};
      store[key][id] = cred;
    }),
    resolve: vi.fn((scope, providerId, id) => {
      return store[`${scope as string}/${providerId}`]?.[id] ?? null;
    }),

    delete: vi.fn(),
  };
}

function seedResolver(
  resolver: CredentialResolver,
  credScope: CredentialScope,
  alias: string,
  secret: string,
  meta: SSHCredentialMeta,
): void {
  resolver.store('ssh', credScope, alias, sshToCredential(secret, meta));
}

// ── Socket path helpers ──────────────────────────────────────────

describe('socket path helpers', () => {
  it('scopeHash returns 16-char hex', () => {
    const h = scopeHash(scope);
    expect(h).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(h)).toBe(true);
  });

  it('scopeHash is deterministic', () => {
    expect(scopeHash(scope)).toBe(scopeHash(scope));
  });

  it('different scopes produce different hashes', () => {
    expect(scopeHash(asGroupScope('a'))).not.toBe(scopeHash(asGroupScope('b')));
  });

  it('socketDir builds correct path', () => {
    expect(socketDir(scope)).toBe(path.join('/tmp/nanoclaw/ssh', scopeHash(scope)));
  });

  it('socketPath appends alias.sock', () => {
    expect(socketPath(scope, 'db')).toBe(path.join('/tmp/nanoclaw/ssh', scopeHash(scope), 'db.sock'));
  });

  it('max alias (60 chars) stays under 108 byte limit', () => {
    const longAlias = 'a'.repeat(60);
    expect(socketPath(scope, longAlias).length).toBeLessThanOrEqual(108);
  });

  it('containerSocketPath is decoupled from host path', () => {
    expect(containerSocketPath('db')).toBe('/ssh-sockets/db.sock');
  });
});

// ── Host key verification ────────────────────────────────────────

describe('verifyHostKey', () => {
  let manager: SSHManager;
  let resolver: CredentialResolver;
  let store: Record<string, Record<string, Credential>>;

  beforeEach(() => {
    store = {};
    resolver = makeResolver(store);
    manager = new SSHManager(resolver);
    mockExecFileSync.mockReset();
  });

  it('returns ignored for accept-any hostKey', () => {
    const meta = makeMeta({ hostKey: '*' });
    const result = manager.verifyHostKey('db', meta, credScope, false);
    expect(result.action).toBe('ignored');
    expect(result.keyLine).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns matched when pinned fingerprint matches scanned', () => {
    const fp = 'SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
    const meta = makeMeta({ hostKey: fp });
    const keyLine = 'prod.example.com ssh-ed25519 AAAA...';

    // ssh-keyscan returns key line
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return keyLine + '\n';
      if (cmd === 'ssh-keygen') return `256 ${fp} (ED25519)\n`;
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, false);
    expect(result.action).toBe('matched');
    expect(result.fingerprint).toBe(fp);
  });

  it('throws SSHHostKeyMismatchError on fingerprint mismatch', () => {
    const storedFp = 'SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
    const scannedFp = 'SHA256:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const meta = makeMeta({ hostKey: storedFp });

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return 'prod.example.com ssh-ed25519 BBBB...\n';
      if (cmd === 'ssh-keygen') return `256 ${scannedFp} (ED25519)\n`;
      return '';
    });

    expect(() => manager.verifyHostKey('db', meta, credScope, false)).toThrowError(SSHHostKeyMismatchError);
  });

  it('returns matched when raw key line matches scanned', () => {
    const stored = 'prod.example.com ssh-ed25519 AAAA1234 base64data';
    const meta = makeMeta({ hostKey: stored });

    // ssh-keyscan returns same key type + data
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return 'prod.example.com ssh-ed25519 AAAA1234 base64data\n';
      if (cmd === 'ssh-keygen') return '256 SHA256:xxxx (ED25519)\n';
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, false);
    expect(result.action).toBe('matched');
  });

  it('TOFU pins key when pinAllowed=true and hostKey absent', () => {
    const meta = makeMeta({ hostKey: null });
    const keyLine = 'prod.example.com ssh-ed25519 AAAA...';

    // Seed a credential so pinHostKey can re-resolve
    seedResolver(resolver, credScope, 'db', 'secret', meta);

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return keyLine + '\n';
      if (cmd === 'ssh-keygen') return '256 SHA256:pinnedfp (ED25519)\n';
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, true);
    expect(result.action).toBe('pinned');
    expect(result.fingerprint).toBeTruthy();
    // Verify resolver.store was called to pin the key
    expect(resolver.store).toHaveBeenCalledWith(
      'ssh',
      credScope,
      'db',
      expect.objectContaining({
        authFields: expect.objectContaining({
          hostKey: keyLine,
        }),
      }),
    );
  });

  it('TOFU returns unverified when pinAllowed=false', () => {
    const meta = makeMeta({ hostKey: null });
    const keyLine = 'prod.example.com ssh-ed25519 AAAA...';

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return keyLine + '\n';
      if (cmd === 'ssh-keygen') return '256 SHA256:readonlyfp (ED25519)\n';
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, false);
    expect(result.action).toBe('unverified');
    expect(result.fingerprint).toBeTruthy();
    // Should NOT have stored anything
    expect(resolver.store).not.toHaveBeenCalled();
  });

  it('TOFU fails closed when ssh-keyscan throws (pinAllowed=true)', () => {
    const meta = makeMeta({ hostKey: null });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('keyscan fail');
    });

    expect(() => manager.verifyHostKey('db', meta, credScope, true)).toThrowError(SSHError);
    expect(resolver.store).not.toHaveBeenCalled();
  });

  it('TOFU fails closed when ssh-keyscan returns no keys (pinAllowed=false)', () => {
    const meta = makeMeta({ hostKey: null });
    // Empty stdout — keyscan ran but returned nothing (host filtered, etc).
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return '';
      return '';
    });

    expect(() => manager.verifyHostKey('db', meta, credScope, false)).toThrowError(SSHError);
    expect(resolver.store).not.toHaveBeenCalled();
  });

  // ── Multi-key scanning (ed25519 + RSA oscillation fix) ──────────

  it('matches pinned fingerprint against second scanned key type', () => {
    // Server returns RSA first, but the pinned fingerprint is for ed25519
    const ed25519Fp = 'SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
    const rsaFp = 'SHA256:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const meta = makeMeta({ hostKey: ed25519Fp });

    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'ssh-keyscan') {
        // Return both key types — RSA first (simulates non-deterministic order)
        return ['prod.example.com ssh-rsa AAAARSA...', 'prod.example.com ssh-ed25519 AAAAEd...'].join('\n') + '\n';
      }
      if (cmd === 'ssh-keygen') {
        // Read the temp file to determine which key we're fingerprinting
        const filePath = args?.[1];
        if (filePath) {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.includes('ssh-rsa')) return `2048 ${rsaFp} (RSA)\n`;
          if (content.includes('ssh-ed25519')) return `256 ${ed25519Fp} (ED25519)\n`;
        }
        return `256 ${rsaFp} (UNKNOWN)\n`;
      }
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, false);
    expect(result.action).toBe('matched');
    expect(result.fingerprint).toBe(ed25519Fp);
  });

  it('matches pinned raw key line when other key type is scanned first', () => {
    const stored = 'prod.example.com ssh-ed25519 AAAAEd base64ed';
    const meta = makeMeta({ hostKey: stored });

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') {
        return (
          ['prod.example.com ssh-rsa AAAARSA base64rsa', 'prod.example.com ssh-ed25519 AAAAEd base64ed'].join('\n') +
          '\n'
        );
      }
      if (cmd === 'ssh-keygen') return '256 SHA256:xxxx (ED25519)\n';
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, false);
    expect(result.action).toBe('matched');
  });

  it('TOFU pins ed25519 even when RSA is returned first', () => {
    const meta = makeMeta({ hostKey: null });
    seedResolver(resolver, credScope, 'db', 'secret', meta);

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') {
        return ['prod.example.com ssh-rsa AAAARSA...', 'prod.example.com ssh-ed25519 AAAAEd...'].join('\n') + '\n';
      }
      if (cmd === 'ssh-keygen') return '256 SHA256:pinnedfp (ED25519)\n';
      return '';
    });

    const result = manager.verifyHostKey('db', meta, credScope, true);
    expect(result.action).toBe('pinned');
    // The pinned key should be the ed25519 one, not RSA
    expect(resolver.store).toHaveBeenCalledWith(
      'ssh',
      credScope,
      'db',
      expect.objectContaining({
        authFields: expect.objectContaining({
          hostKey: 'prod.example.com ssh-ed25519 AAAAEd...',
        }),
      }),
    );
  });

  it('throws mismatch when no scanned key matches pinned fingerprint', () => {
    const storedFp = 'SHA256:7+gvK8gKLrIIbMHaE0DRYN1VIoXMjMJhag0bWIpwbZs';
    const meta = makeMeta({ hostKey: storedFp });

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') {
        return ['prod.example.com ssh-rsa AAAARSA...', 'prod.example.com ssh-ed25519 AAAAEd...'].join('\n') + '\n';
      }
      if (cmd === 'ssh-keygen') return '256 SHA256:nope_doesnt_match_anything_at_all (KEY)\n';
      return '';
    });

    expect(() => manager.verifyHostKey('db', meta, credScope, false)).toThrowError(SSHHostKeyMismatchError);
  });

  it('first-writer-wins: does not overwrite existing hostKey', () => {
    const meta = makeMeta({ hostKey: null });
    // Seed credential that already has hostKey pinned
    seedResolver(resolver, credScope, 'db', 'secret', {
      ...meta,
      hostKey: 'already-pinned ssh-ed25519 EXISTING',
    });

    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ssh-keyscan') return 'prod.example.com ssh-ed25519 NEW...\n';
      if (cmd === 'ssh-keygen') return '256 SHA256:newfp (ED25519)\n';
      return '';
    });

    manager.verifyHostKey('db', meta, credScope, true);
    // store should have been called only once (the initial seed), not by pinHostKey
    expect(resolver.store).toHaveBeenCalledTimes(1);
  });
});

// ── Scope resolution ─────────────────────────────────────────────

describe('scope resolution (via connect)', () => {
  let manager: SSHManager;
  let resolver: CredentialResolver;
  let store: Record<string, Record<string, Credential>>;

  beforeEach(() => {
    store = {};
    resolver = makeResolver(store);
    manager = new SSHManager(resolver);
    mockExecFileSync.mockReset();
    mockSpawn.mockReset();
  });

  it('rejects with credential_not_found when alias not found', async () => {
    await expect(manager.connect(scope, 'missing', { timeout: 1, pinAllowed: false })).rejects.toThrow(SSHError);

    try {
      await manager.connect(scope, 'missing', { timeout: 1, pinAllowed: false });
    } catch (err) {
      expect((err as SSHError).code).toBe('credential_not_found');
    }
  });

  it('resolves from own scope first', async () => {
    const meta = makeMeta();
    seedResolver(resolver, credScope, 'db', 'mypass', meta);

    // Also seed in source scope
    seedResolver(resolver, sourceScope, 'db', 'sourcepass', meta);

    manager.setGroupResolver(() => ({
      containerConfig: { credentialSource: 'source-group' },
    }));
    manager.setAccessCheck(() => true);

    // Attempt connect — will fail at ssh spawn, but we can check which scope was used
    // by verifying the resolver.resolve call order
    const resolveCalls: string[] = [];
    const origResolve = resolver.resolve;
    (resolver as any).resolve = vi.fn((...args: any[]) => {
      resolveCalls.push(args[0] as string);
      return (origResolve as any)(...args);
    });

    // connect will fail (no real ssh), but we care about which scope was checked
    try {
      await manager.connect(scope, 'db', { timeout: 1, pinAllowed: false });
    } catch {
      // expected — ssh spawn won't work
    }

    // Own scope should be checked first and found
    expect(resolveCalls[0]).toBe(credScope as string);
  });

  it('falls back to source scope when bilateral check passes', async () => {
    const meta = makeMeta();
    // NOT in own scope, only in source scope
    seedResolver(resolver, sourceScope, 'db', 'sourcepass', meta);

    manager.setGroupResolver(() => ({
      containerConfig: { credentialSource: 'source-group' },
    }));
    manager.setAccessCheck(() => true);

    const resolveCalls: string[] = [];
    const origResolve = resolver.resolve;
    (resolver as any).resolve = vi.fn((...args: any[]) => {
      resolveCalls.push(args[0] as string);
      return (origResolve as any)(...args);
    });

    try {
      await manager.connect(scope, 'db', { timeout: 1, pinAllowed: false });
    } catch {
      // expected
    }

    // Should check own scope first (miss), then source scope
    expect(resolveCalls).toContain(credScope as string);
    expect(resolveCalls).toContain(sourceScope as string);
  });

  it('blocks fallback when bilateral access check fails', async () => {
    const meta = makeMeta();
    seedResolver(resolver, sourceScope, 'db', 'sourcepass', meta);

    manager.setGroupResolver(() => ({
      containerConfig: { credentialSource: 'source-group' },
    }));
    manager.setAccessCheck(() => false); // deny

    await expect(manager.connect(scope, 'db', { timeout: 1, pinAllowed: false })).rejects.toThrow(
      /credential_not_found|No SSH credential/,
    );
  });

  it('does not fall back when no credentialSource configured', async () => {
    const meta = makeMeta();
    seedResolver(resolver, sourceScope, 'db', 'sourcepass', meta);

    manager.setGroupResolver(() => ({ containerConfig: {} }));
    manager.setAccessCheck(() => true);

    await expect(manager.connect(scope, 'db', { timeout: 1, pinAllowed: false })).rejects.toThrow(/No SSH credential/);
  });
});

// ── Connection tracking ──────────────────────────────────────────

describe('connection tracking', () => {
  let manager: SSHManager;
  let resolver: CredentialResolver;

  beforeEach(() => {
    resolver = makeResolver();
    manager = new SSHManager(resolver);
    mockExecFileSync.mockReset();
  });

  it('listConnections returns empty initially', () => {
    expect(manager.listConnections(scope)).toEqual([]);
  });

  it('disconnect is a no-op for unknown alias', async () => {
    await expect(manager.disconnect(scope, 'nope')).resolves.toBeUndefined();
  });

  it('disconnectAll is a no-op for unknown scope', async () => {
    await expect(manager.disconnectAll(scope)).resolves.toBeUndefined();
  });
});

// ── Connect serialization ────────────────────────────────────────

describe('connect serialization', () => {
  let manager: SSHManager;
  let resolver: CredentialResolver;

  beforeEach(() => {
    resolver = makeResolver();
    manager = new SSHManager(resolver);
    // hostKey: '*' bypasses verification so the test exercises serialization,
    // not TOFU/keyscan behavior.
    seedResolver(resolver, credScope, 'db', 'pw', makeMeta({ hostKey: '*' }));
    mockExecFileSync.mockReset();
    mockSpawn.mockReset();
  });

  it('concurrent connects for same alias share a single promise', async () => {
    let spawnCount = 0;
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'openssl') return 'encrypted-base64\n';
      throw new Error(`unexpected: ${cmd}`);
    });

    mockSpawn.mockImplementation(() => {
      spawnCount++;
      const proc = new EventEmitter() as any;
      proc.exitCode = null;
      proc.unref = vi.fn();
      proc.kill = vi.fn();
      const stderr = new EventEmitter();
      proc.stderr = stderr;
      // Simulate SSH failing after a short delay
      setTimeout(() => {
        proc.exitCode = 1;
      }, 50);
      return proc;
    });

    const p1 = manager.connect(scope, 'db', { timeout: 1, pinAllowed: false });
    const p2 = manager.connect(scope, 'db', { timeout: 1, pinAllowed: false });

    // Both should resolve/reject from the same underlying attempt
    await Promise.allSettled([p1, p2]);
    expect(spawnCount).toBe(1);
  });
});

// ── Startup sweep ────────────────────────────────────────────────

describe('startupSweep', () => {
  const sweepDir = '/tmp/nanoclaw/ssh';

  it('removes stale socket directory', () => {
    fs.mkdirSync(path.join(sweepDir, 'stale-hash'), { recursive: true });
    fs.writeFileSync(path.join(sweepDir, 'stale-hash', 'old.sock'), '');

    SSHManager.startupSweep();
    expect(fs.existsSync(sweepDir)).toBe(false);
  });

  it('is a no-op when directory does not exist', () => {
    if (fs.existsSync(sweepDir)) {
      fs.rmSync(sweepDir, { recursive: true, force: true });
    }
    expect(() => SSHManager.startupSweep()).not.toThrow();
  });
});

// ── Error types ──────────────────────────────────────────────────

describe('SSHError', () => {
  it('stores code and message', () => {
    const err = new SSHError('timeout', 'timed out');
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('timed out');
    expect(err.name).toBe('SSHError');
  });
});

describe('SSHHostKeyMismatchError', () => {
  it('stores all fields', () => {
    const err = new SSHHostKeyMismatchError('db', 'prod.example.com', 22, 'SHA256:stored', 'SHA256:scanned');
    expect(err.code).toBe('host_key_mismatch');
    expect(err.alias).toBe('db');
    expect(err.host).toBe('prod.example.com');
    expect(err.port).toBe(22);
    expect(err.storedFingerprint).toBe('SHA256:stored');
    expect(err.scannedFingerprint).toBe('SHA256:scanned');
    expect(err.message).toContain('prod.example.com:22');
  });
});
