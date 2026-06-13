/**
 * Per-agent-group cached credential resolver (C7r).
 *
 * The boundary between encrypted-at-rest and plaintext-in-use:
 *
 *   - On disk and inside this resolver's cache, secret string fields
 *     (`Credential.value`, `Credential.refresh.value`) carry their
 *     `enc:aes-256-gcm:...` ciphertext.
 *   - `resolve()` decrypts those fields *on the stack* and returns a
 *     plaintext-bearing Credential to the caller. The plaintext exists
 *     only as long as the caller keeps a reference.
 *   - `store()` encrypts secret fields before handing them to the
 *     plaintext store layer.
 *
 * One resolver per agent group, not per session. Multiple concurrent
 * sessions of the same agent group share the cache.
 *
 * Eviction happens via the scope-invalidator registry — any write
 * through `store.writeKeysFile` or grant mutation through `/creds`
 * fires `invalidateScope(scope)`, which this resolver subscribes to
 * and drops the matching scope from its cache. Borrowing from an
 * inactive grantor works because the cache is owned by the reader
 * and the on-disk store is always available.
 */
import os from 'os';
import path from 'path';

import { decrypt, encrypt, getSecretBackend, initEncryption } from '../crypto/index.js';

import { canAccess } from './grants.js';
import { registerScopeInvalidator } from './scope-invalidator.js';
import { ScopedCache } from './scoped-cache.js';
import { deleteKeysFile, deleteScope, readKeysFile, updateKeysFile } from './store.js';
import type { Credential, CredentialScope } from './types.js';
import { asCredentialScope } from './types.js';

// ── Encryption key bootstrap ────────────────────────────────────────────────

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return path.join(process.env.HOME || os.homedir(), '.config');
}

function encryptionKeyPath(): string {
  return path.join(configHome(), 'nanoclaw', 'encryption-key');
}

let encryptionInitialized = false;

function ensureEncryptionInitialized(): void {
  if (encryptionInitialized) return;
  try {
    getSecretBackend();
    encryptionInitialized = true;
    return;
  } catch {
    /* not initialized */
  }
  initEncryption(encryptionKeyPath());
  encryptionInitialized = true;
}

// ── Public resolver interface ───────────────────────────────────────────────

export interface CredentialResolver {
  /**
   * Look up a credential by (scope, providerId, credentialId). Returns
   * a Credential with decrypted secret fields, or `null` if the entry
   * does not exist or this resolver is not allowed to read `scope`.
   */
  resolve(scope: CredentialScope, providerId: string, credentialId: string): Credential | null;

  /**
   * Store a credential under (scope, providerId, credentialId). Encrypts
   * secret fields before writing. Throws if `scope` is not this
   * resolver's own scope — borrowing is read-only.
   */
  store(scope: CredentialScope, providerId: string, credentialId: string, credential: Credential): void;

  /**
   * Delete a single keys file (`providerId` given) or the whole scope's
   * keys files (`providerId` omitted). Evicts the corresponding cache
   * entries first.
   */
  delete(scope: CredentialScope, providerId?: string): void;

  /**
   * Drop cached entries without touching disk. With no args, clears the
   * whole cache. With (scope[, providerId]), evicts the matching subset.
   */
  unloadCache(scope?: CredentialScope, providerId?: string): void;

  /**
   * Release the scope-invalidator subscription and drop the cache.
   * After dispose, the resolver may not be used.
   */
  dispose(): void;
}

// ── Cached implementation ───────────────────────────────────────────────────

interface CachedResolverOptions {
  /** This resolver's own agent-group folder. */
  ownFolder: string;
  /**
   * Per-read access check. Default: `grants.canAccess(ownFolder, scope)`.
   * Override is for tests that exercise mid-session revocation without
   * touching the filesystem grant state.
   */
  accessCheck?: (scope: CredentialScope) => boolean;
}

class CachedCredentialResolver implements CredentialResolver {
  private readonly cache = new ScopedCache<Credential>();
  private readonly unregister: () => void;
  private disposed = false;

  constructor(private readonly opts: CachedResolverOptions) {
    this.unregister = registerScopeInvalidator((scope) => {
      this.cache.evict(scope);
    });
  }

  private checkAccess(scope: CredentialScope): boolean {
    if (this.opts.accessCheck) return this.opts.accessCheck(scope);
    return canAccess(this.opts.ownFolder, scope);
  }

  resolve(scope: CredentialScope, providerId: string, credentialId: string): Credential | null {
    this.assertLive();
    if (!this.checkAccess(scope)) return null;

    let entry = this.cache.get(scope, providerId, credentialId);
    if (!entry) {
      const keys = readKeysFile(scope, providerId);
      const raw = keys[credentialId];
      if (!raw || typeof raw !== 'object') return null;
      entry = raw as Credential;
      this.cache.set(scope, providerId, credentialId, entry);
    }

    return decryptCredential(entry);
  }

  store(scope: CredentialScope, providerId: string, credentialId: string, credential: Credential): void {
    this.assertLive();
    if (scope !== this.opts.ownFolder) {
      throw new Error(
        `resolver.store: cannot write under scope '${scope}' from resolver owning '${this.opts.ownFolder}'`,
      );
    }

    const encrypted = encryptCredential(credential);

    // Atomic merge through the store. updateKeysFile holds the fd open
    // between read and write so two concurrent stores in the same Node
    // process cannot lose each other's edits. Sibling entries under the
    // same providerId are preserved by construction.
    updateKeysFile(scope, providerId, (keys) => {
      keys[credentialId] = encrypted;
    });
    // updateKeysFile fires invalidateScope, which evicts our cache for
    // this scope. Re-populate the freshly-written entry so the next
    // resolve from this resolver hits cache.
    this.cache.set(scope, providerId, credentialId, encrypted);
  }

  delete(scope: CredentialScope, providerId?: string): void {
    this.assertLive();
    if (providerId !== undefined) {
      this.cache.evict(scope, providerId);
      deleteKeysFile(scope, providerId);
      return;
    }
    // Whole-scope delete: one rmSync + one manifest-pipeline fire + one
    // invalidateScope, matching v1. Iterating listProviderIds + N
    // deleteKeysFile calls would leave an empty scope dir behind and
    // thrash both manifest grantee-distribution and invalidator
    // subscribers N times for no benefit.
    this.cache.evict(scope);
    deleteScope(scope);
  }

  unloadCache(scope?: CredentialScope, providerId?: string): void {
    if (scope === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.evict(scope, providerId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    this.cache.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('CredentialResolver: used after dispose()');
  }
}

// ── Credential <-> encrypted-Credential ─────────────────────────────────────

function encryptCredential(c: Credential): Credential {
  ensureEncryptionInitialized();
  const out: Credential = {
    value: encrypt(c.value),
    updated_ts: c.updated_ts,
    ...(c.expires_ts !== undefined && { expires_ts: c.expires_ts }),
    ...(c.authFields && { authFields: c.authFields }),
    ...(c.boundDomain !== undefined && { boundDomain: c.boundDomain }),
  };
  if (c.refresh) {
    out.refresh = {
      value: encrypt(c.refresh.value),
      updated_ts: c.refresh.updated_ts,
      ...(c.refresh.expires_ts !== undefined && { expires_ts: c.refresh.expires_ts }),
    };
  }
  return out;
}

function decryptCredential(c: Credential): Credential {
  ensureEncryptionInitialized();
  const out: Credential = {
    value: c.value ? decrypt(c.value) : '',
    updated_ts: c.updated_ts,
    ...(c.expires_ts !== undefined && { expires_ts: c.expires_ts }),
    ...(c.authFields && { authFields: c.authFields }),
    ...(c.boundDomain !== undefined && { boundDomain: c.boundDomain }),
  };
  if (c.refresh) {
    out.refresh = {
      value: c.refresh.value ? decrypt(c.refresh.value) : '',
      updated_ts: c.refresh.updated_ts,
      ...(c.refresh.expires_ts !== undefined && { expires_ts: c.refresh.expires_ts }),
    };
  }
  return out;
}

// ── Factory and per-agent-group registry ────────────────────────────────────

const resolvers = new Map<string, CachedCredentialResolver>();

/**
 * Get or create the resolver for `ownFolder`. Idempotent: the second
 * call with the same folder returns the existing resolver. The folder
 * string is the agent-group's storage scope; pass a fresh string for
 * each distinct agent group.
 */
export function getOrCreateResolverForAgentGroup(ownFolder: string): CredentialResolver {
  let r = resolvers.get(ownFolder);
  if (!r) {
    r = new CachedCredentialResolver({ ownFolder });
    resolvers.set(ownFolder, r);
  }
  return r;
}

/**
 * Dispose the resolver registered for `ownFolder`. No-op if absent.
 * Called from the session-manager teardown path when the last session
 * for an agent group closes.
 */
export function disposeResolverForAgentGroup(ownFolder: string): void {
  const r = resolvers.get(ownFolder);
  if (!r) return;
  r.dispose();
  resolvers.delete(ownFolder);
}

/** Look up the resolver for `ownFolder` without creating one. */
export function getResolverForAgentGroup(ownFolder: string): CredentialResolver | null {
  return resolvers.get(ownFolder) ?? null;
}

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Test-only: construct a resolver with an explicit access-check override,
 * bypassing the singleton registry. Used to assert per-container
 * isolation and mid-session revoke without touching grant filesystem state.
 */
export function _createResolverForTests(opts: CachedResolverOptions): CredentialResolver {
  return new CachedCredentialResolver(opts);
}

/** Test-only: clear the resolver registry between tests. */
export function _resetResolversForTests(): void {
  for (const r of resolvers.values()) r.dispose();
  resolvers.clear();
}

/** Test-only: assert the registered scope as CredentialScope for the resolver layer. */
export function _asScope(s: string): CredentialScope {
  return asCredentialScope(s);
}
