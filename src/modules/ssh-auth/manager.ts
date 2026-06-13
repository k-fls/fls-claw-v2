/**
 * SSH ControlMaster manager.
 *
 * Manages SSH ControlMaster connections on the host. Containers never see
 * credentials — they use pre-authenticated sockets via bind-mounted dirs.
 *
 * Security model: a random temporary password (tp) is the only secret in
 * the SSH process environment. tp alone is useless — it only has value
 * combined with temp files that are deleted immediately after the socket
 * appears. See ssh-credential-isolation.md "Password & Key Auth at Connect Time".
 */
import { createHash, randomBytes } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../log.js';
import type { Credential, CredentialScope, GroupScope } from '../credentials/index.js';
import { asCredentialScope } from '../credentials/index.js';

// Local resolver shape used by SSHManager. The v2 substrate exposes a
// CredentialResolver whose `store` is `(scope, providerId, id, cred)`; the
// fork's SSH code uses `(providerId, scope, id, cred)`. init.ts adapts the
// v2 resolver into this shape so the SSHManager body and the manager.test.ts
// fake resolver both keep the fork's call order.
export type ScopeAccessCheck = (borrower: GroupScope, grantor: CredentialScope) => boolean;

export interface CredentialResolver {
  resolve(scope: CredentialScope, providerId: string, id: string): Credential | null;
  store(providerId: string, scope: CredentialScope, id: string, cred: Credential): void;
  unloadCache?(scope?: CredentialScope, providerId?: string): void;
  delete?(scope: CredentialScope, providerId?: string): void;
}
import type { SSHCredentialMeta, ControlMasterConnection, HostKeyVerifyResult } from './types.js';
import { sshFromCredential, sshToCredential, isFingerprint, fingerprintEqual, SSH_PROVIDER_ID } from './types.js';

// ── Constants ─────────────────────────────────────────────────────

const SSH_SOCKET_BASE = '/tmp/nanoclaw/ssh';

const DEFAULT_CONNECT_TIMEOUT = 5;
const SOCKET_POLL_INTERVAL_MS = 100;
const SOCKET_POLL_MARGIN_MS = 2000;

/** Whitespace field separator for SSH key lines. */
const WS = /\s+/;

/** Extract the key-type field (e.g. "ssh-ed25519") from a key line. */
function keyTypeOf(keyLine: string): string {
  return keyLine.split(WS)[1] ?? '';
}

/**
 * Extract the identity portion (keytype + keydata) from a key line.
 * The host field is stripped so two lines from different hostnames can be compared.
 */
function keyIdentity(keyLine: string): string {
  return keyLine.split(WS).slice(-2).join(' ');
}

// ── Socket path helpers ───────────────────────────────────────────

export function scopeHash(scope: GroupScope): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

export function socketDir(scope: GroupScope): string {
  return path.join(SSH_SOCKET_BASE, scopeHash(scope));
}

export function socketPath(scope: GroupScope, alias: string): string {
  return path.join(socketDir(scope), `${alias}.sock`);
}

/** Container-side socket path (decoupled from host path via bind mount). */
export function containerSocketPath(alias: string): string {
  return `/ssh-sockets/${alias}.sock`;
}

// ── SSH Manager ───────────────────────────────────────────────────

export type SSHGroupResolver = (scope: GroupScope) => { containerConfig?: { credentialSource?: string } } | undefined;

export class SSHManager {
  private connections = new Map<GroupScope, Map<string, ControlMasterConnection>>();
  private inflight = new Map<string, Promise<ControlMasterConnection>>();
  private resolver: CredentialResolver;
  private accessCheck: ScopeAccessCheck | null = null;
  private groupResolver: SSHGroupResolver | null = null;

  constructor(resolver: CredentialResolver) {
    this.resolver = resolver;
  }

  setAccessCheck(check: ScopeAccessCheck): void {
    this.accessCheck = check;
  }

  setGroupResolver(resolver: SSHGroupResolver): void {
    this.groupResolver = resolver;
  }

  // ── Scope resolution (per-alias) ─────────────────────────────

  /**
   * Resolve credential scope for an alias. Checks own scope first,
   * then falls back to credentialSource if bilateral grant passes.
   * Returns null if not found anywhere.
   */
  private resolveCredentialScope(
    groupScope: GroupScope,
    alias: string,
  ): {
    credScope: CredentialScope;
    meta: SSHCredentialMeta;
    secret: string;
  } | null {
    // Own scope first
    const ownCredScope = asCredentialScope(groupScope as string);
    const ownCred = this.resolver.resolve(ownCredScope, SSH_PROVIDER_ID, alias);
    if (ownCred) {
      const parsed = sshFromCredential(ownCred);
      if (parsed) return { credScope: ownCredScope, ...parsed };
    }

    // Fallback to source scope
    const group = this.groupResolver?.(groupScope);
    const source = group?.containerConfig?.credentialSource;
    if (!source) return null;

    const sourceCredScope = asCredentialScope(source);

    // Bilateral access check
    if (this.accessCheck && !this.accessCheck(groupScope, sourceCredScope)) return null;

    const sourceCred = this.resolver.resolve(sourceCredScope, SSH_PROVIDER_ID, alias);
    if (!sourceCred) return null;
    const parsed = sshFromCredential(sourceCred);
    if (!parsed) return null;
    return { credScope: sourceCredScope, ...parsed };
  }

  // ── Host key verification ────────────────────────────────────

  /**
   * Scan remote host keys via ssh-keyscan.
   * Returns all key lines (one per key type), preferring ed25519 first.
   */
  private scanHostKeys(host: string, port: number): string[] {
    try {
      const result = execFileSync('ssh-keyscan', ['-p', String(port), '-t', 'ed25519,rsa', host], {
        timeout: 10000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const keys: string[] = [];
      for (const line of result.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) keys.push(trimmed);
      }
      // Prefer ed25519 first for consistent TOFU pinning.
      keys.sort((a, b) => {
        const aEd = keyTypeOf(a) === 'ssh-ed25519' ? 0 : 1;
        const bEd = keyTypeOf(b) === 'ssh-ed25519' ? 0 : 1;
        return aEd - bEd;
      });
      return keys;
    } catch (err) {
      log.warn('ssh.host_keyscan_failed', {
        host,
        port,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Compute SSH fingerprint from a host key line.
   */
  private fingerprint(keyLine: string): string {
    try {
      const tmpFile = path.join(os.tmpdir(), `nanoclaw-hk-${Date.now()}`);
      fs.writeFileSync(tmpFile, keyLine + '\n', { mode: 0o600 });
      try {
        const result = execFileSync('ssh-keygen', ['-lf', tmpFile], {
          encoding: 'utf-8',
          timeout: 5000,
        });
        return result.trim().split(WS)[1] || keyLine;
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {}
      }
    } catch {
      return '(unknown)';
    }
  }

  /**
   * Verify host key. Returns the key line to use for known_hosts,
   * or throws on mismatch.
   *
   * @param pinAllowed — if true, TOFU pinning is performed on first connect.
   *   Default false (read-only). connect() passes true; /ssh test passes
   *   the user's pin flag.
   */
  verifyHostKey(
    alias: string,
    meta: SSHCredentialMeta,
    credScope: CredentialScope,
    pinAllowed: boolean,
  ): {
    keyLine: string | null;
    action: HostKeyVerifyResult;
    fingerprint?: string;
  } {
    // Accept-any: skip verification
    if (meta.hostKey === '*') {
      return { keyLine: null, action: 'ignored' };
    }

    const scannedKeys = this.scanHostKeys(meta.host, meta.port);

    // Pinned: compare stored value against scanned key(s)
    if (meta.hostKey) {
      if (isFingerprint(meta.hostKey)) {
        // Stored as fingerprint (SHA256:...) — check all scanned keys
        if (scannedKeys.length === 0) {
          throw new SSHError(
            'connection_refused',
            `Host key verification failed for '${alias}': stored fingerprint ${meta.hostKey} but ssh-keyscan returned no key from ${meta.host}:${meta.port}`,
          );
        }
        for (const key of scannedKeys) {
          const fp = this.fingerprint(key);
          if (fingerprintEqual(meta.hostKey, fp)) {
            return {
              keyLine: key,
              action: 'matched',
              fingerprint: meta.hostKey,
            };
          }
        }
        // No key matched — report the first scanned fingerprint in the error
        const scannedFp = this.fingerprint(scannedKeys[0]);
        throw new SSHHostKeyMismatchError(alias, meta.host, meta.port, meta.hostKey, scannedFp);
      }

      // Stored as raw key line — find matching key type among scanned keys
      const storedFp = this.fingerprint(meta.hostKey);
      if (scannedKeys.length === 0) {
        return {
          keyLine: meta.hostKey,
          action: 'matched',
          fingerprint: storedFp,
        };
      }
      const storedId = keyIdentity(meta.hostKey);
      for (const key of scannedKeys) {
        if (keyIdentity(key) === storedId) {
          return {
            keyLine: meta.hostKey,
            action: 'matched',
            fingerprint: storedFp,
          };
        }
      }
      const scannedFp = this.fingerprint(scannedKeys[0]);
      throw new SSHHostKeyMismatchError(alias, meta.host, meta.port, storedFp, scannedFp);
    }

    // TOFU: no stored key
    if (scannedKeys.length === 0) {
      // Fail-closed: cannot verify host identity, refuse rather than letting
      // OpenSSH's accept-new mode trust whatever appears on the wire.
      // An attacker who can suppress ssh-keyscan probes (or induce a timeout)
      // could otherwise present an attacker-controlled key on first connect.
      throw new SSHError(
        'connection_refused',
        `Cannot verify host key for '${alias}': ssh-keyscan returned no keys from ${meta.host}:${meta.port}. ` +
          `Check network reachability, or set hostKey: '*' to bypass verification.`,
      );
    }

    // Prefer ed25519 (already sorted first)
    const preferred = scannedKeys[0];
    const fp = this.fingerprint(preferred);

    if (!pinAllowed) {
      return { keyLine: preferred, action: 'unverified', fingerprint: fp };
    }

    this.pinHostKey(credScope, alias, preferred);
    log.info('ssh.host_key_pinned', {
      alias,
      host: meta.host,
      port: meta.port,
      fingerprint: fp,
    });

    return { keyLine: preferred, action: 'pinned', fingerprint: fp };
  }

  /**
   * Pin a host key in the credential store.
   */
  private pinHostKey(credScope: CredentialScope, alias: string, keyLine: string): void {
    const cred = this.resolver.resolve(credScope, SSH_PROVIDER_ID, alias);
    if (!cred) return;
    const parsed = sshFromCredential(cred);
    if (!parsed) return;

    // First-writer-wins: re-check after async yield
    if (parsed.meta.hostKey) return;

    parsed.meta.hostKey = keyLine;
    this.resolver.store(SSH_PROVIDER_ID, credScope, alias, sshToCredential(parsed.secret, parsed.meta));
  }

  // ── ControlMaster lifecycle ──────────────────────────────────

  /**
   * Establish a ControlMaster connection.
   * Uses connect serialization — concurrent requests for the same alias
   * await the in-flight promise.
   */
  async connect(
    scope: GroupScope,
    alias: string,
    opts: { timeout?: number; pinAllowed: boolean },
  ): Promise<ControlMasterConnection> {
    const key = `${scope}:${alias}`;

    // Check existing connection
    const existing = this.connections.get(scope)?.get(alias);
    if (existing) {
      if (this.isSocketAlive(existing.socketPath, existing)) return existing;
      // Dead socket — clean up and reconnect
      this.removeConnection(scope, alias);
    }

    // Connect serialization
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = this.doConnect(scope, alias, opts.timeout ?? DEFAULT_CONNECT_TIMEOUT, opts.pinAllowed);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async doConnect(
    scope: GroupScope,
    alias: string,
    timeout: number,
    pinAllowed: boolean,
  ): Promise<ControlMasterConnection> {
    const resolved = this.resolveCredentialScope(scope, alias);
    if (!resolved) {
      throw new SSHError('credential_not_found', `No SSH credential stored for alias '${alias}'`);
    }

    const { credScope, meta, secret } = resolved;

    // Host key verification
    const hkResult = this.verifyHostKey(alias, meta, credScope, pinAllowed);
    const { keyLine } = hkResult;

    // Create socket directory
    const sockDir = socketDir(scope);
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });

    const sockPath = socketPath(scope, alias);

    // Prepare temp files and spawn ControlMaster
    const tp = randomBytes(20).toString('hex');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ssh-'));

    try {
      // Write known_hosts if we have a key
      let knownHostsPath: string | undefined;
      if (keyLine) {
        knownHostsPath = path.join(tmpDir, 'known_hosts');
        fs.writeFileSync(knownHostsPath, keyLine + '\n', { mode: 0o600 });
      }

      let askpassPath: string;
      let identityArgs: string[] = [];

      if (meta.authType === 'password') {
        // Password auth: askpass script with openssl-encrypted password
        const encrypted = execFileSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-a', '-pass', `pass:${tp}`], {
          input: secret,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();

        askpassPath = path.join(tmpDir, 'askpass.sh');
        fs.writeFileSync(
          askpassPath,
          `#!/bin/sh\necho '${encrypted}' | openssl enc -d -aes-256-cbc -pbkdf2 -a -pass env:TP\n`,
          { mode: 0o700 },
        );
      } else {
        // Key auth: re-encrypt PEM with tp as passphrase
        const pemPath = path.join(tmpDir, 'key.pem');
        fs.writeFileSync(pemPath, secret, { mode: 0o600 });

        // Re-encrypt with tp
        execFileSync('ssh-keygen', ['-p', '-f', pemPath, '-P', '', '-N', tp], {
          timeout: 5000,
        });

        askpassPath = path.join(tmpDir, 'askpass.sh');
        fs.writeFileSync(askpassPath, '#!/bin/sh\necho "$TP"\n', {
          mode: 0o700,
        });
        identityArgs = ['-i', pemPath];
      }

      // Spawn ControlMaster
      const sshArgs = [
        '-F',
        '/dev/null',
        '-o',
        `ControlMaster=yes`,
        '-o',
        `ControlPath=${sockPath}`,
        '-o',
        `ControlPersist=1800`,
        '-o',
        `ConnectTimeout=${timeout}`,
        '-o',
        'ForwardAgent=no',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StrictHostKeyChecking=' + (keyLine ? 'yes' : meta.hostKey === '*' ? 'no' : 'accept-new'),
        '-o',
        'BatchMode=no',
        ...(knownHostsPath ? ['-o', `UserKnownHostsFile=${knownHostsPath}`] : ['-o', 'UserKnownHostsFile=/dev/null']),
        ...identityArgs,
        '-p',
        String(meta.port),
        '-N',
        `${meta.username}@${meta.host}`,
      ];

      const env = {
        ...process.env,
        TP: tp,
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: ':99',
      };

      const sshProc = spawn('ssh', sshArgs, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
      sshProc.unref();

      let sshStderr = '';
      sshProc.stderr?.on('data', (d: Buffer) => {
        sshStderr += d.toString();
      });

      // Poll for socket file
      const maxWait = timeout * 1000 + SOCKET_POLL_MARGIN_MS;
      const startTime = Date.now();
      let socketReady = false;

      while (Date.now() - startTime < maxWait) {
        if (fs.existsSync(sockPath)) {
          socketReady = true;
          break;
        }
        // Check if SSH exited early (auth failure, etc.)
        if (sshProc.exitCode !== null) break;
        await sleep(SOCKET_POLL_INTERVAL_MS);
      }

      // Cleanup temp files immediately
      this.cleanupTempDir(tmpDir);

      if (!socketReady) {
        // Kill SSH process if still running
        try {
          sshProc.kill('SIGTERM');
        } catch {}
        const errMsg = sshStderr.trim();
        if (errMsg.includes('Permission denied') || errMsg.includes('Authentication failed')) {
          throw new SSHError('auth_rejected', `Authentication rejected for '${alias}': ${errMsg}`);
        }
        if (errMsg.includes('Connection refused')) {
          throw new SSHError('connection_refused', `Connection refused for '${alias}': ${errMsg}`);
        }
        throw new SSHError('timeout', `SSH connection timed out for '${alias}' (${timeout}s): ${errMsg}`);
      }

      const conn: ControlMasterConnection = {
        alias,
        host: meta.host,
        port: meta.port,
        username: meta.username,
        socketPath: sockPath,
        scope,
        hostKeyAction: hkResult.action,
        hostKeyFingerprint: hkResult.fingerprint,
      };

      this.addConnection(scope, alias, conn);

      log.info('ssh.connect', { alias, scope, host: meta.host, port: meta.port });

      return conn;
    } catch (err) {
      this.cleanupTempDir(tmpDir);
      throw err;
    }
  }

  /**
   * Disconnect a ControlMaster connection.
   */
  async disconnect(scope: GroupScope, alias: string): Promise<void> {
    const conn = this.connections.get(scope)?.get(alias);
    if (!conn) return;

    try {
      execFileSync(
        'ssh',
        [
          '-O',
          'exit',
          '-o',
          `ControlPath=${conn.socketPath}`,
          '-o',
          'ConnectTimeout=5',
          `${conn.username}@${conn.host}`,
        ],
        { timeout: 10000, stdio: 'ignore' },
      );
    } catch {
      // ControlMaster may already be dead
    }

    // Clean up socket file
    try {
      fs.unlinkSync(conn.socketPath);
    } catch {}

    this.removeConnection(scope, alias);
    log.info('ssh.disconnect', { alias, scope });
  }

  /**
   * Disconnect all ControlMaster connections for a scope.
   */
  async disconnectAll(scope: GroupScope): Promise<void> {
    const scopeConns = this.connections.get(scope);
    if (!scopeConns) return;

    const aliases = [...scopeConns.keys()];
    for (const alias of aliases) {
      await this.disconnect(scope, alias);
    }

    // Remove socket directory
    try {
      fs.rmSync(socketDir(scope), { recursive: true, force: true });
    } catch {}

    this.connections.delete(scope);
  }

  /**
   * List active connections for a scope.
   */
  listConnections(scope: GroupScope): ControlMasterConnection[] {
    const scopeConns = this.connections.get(scope);
    if (!scopeConns) return [];
    return [...scopeConns.values()];
  }

  // ── Connection tracking ──────────────────────────────────────

  private addConnection(scope: GroupScope, alias: string, conn: ControlMasterConnection): void {
    let scopeMap = this.connections.get(scope);
    if (!scopeMap) {
      scopeMap = new Map();
      this.connections.set(scope, scopeMap);
    }
    scopeMap.set(alias, conn);
  }

  private removeConnection(scope: GroupScope, alias: string): void {
    this.connections.get(scope)?.delete(alias);
  }

  private isSocketAlive(sockPath: string, conn: ControlMasterConnection): boolean {
    if (!fs.existsSync(sockPath)) return false;
    try {
      execFileSync('ssh', ['-O', 'check', '-o', `ControlPath=${sockPath}`, `${conn.username}@${conn.host}`], {
        timeout: 5000,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────

  private cleanupTempDir(tmpDir: string): void {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  /**
   * Startup sweep: remove stale socket directories from /tmp/nanoclaw/ssh/.
   */
  static startupSweep(): void {
    try {
      if (!fs.existsSync(SSH_SOCKET_BASE)) return;
      fs.rmSync(SSH_SOCKET_BASE, { recursive: true, force: true });
      log.info('SSH startup sweep: cleaned stale sockets');
    } catch (err) {
      log.warn('SSH startup sweep failed', { err });
    }
  }
}

// ── Error types ───────────────────────────────────────────────────

export class SSHError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SSHError';
  }
}

export class SSHHostKeyMismatchError extends SSHError {
  constructor(
    public alias: string,
    public host: string,
    public port: number,
    public storedFingerprint: string,
    public scannedFingerprint: string,
  ) {
    super(
      'host_key_mismatch',
      `Host key mismatch for '${alias}' (${host}:${port}). ` +
        `Stored: ${storedFingerprint}, Scanned: ${scannedFingerprint}`,
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
