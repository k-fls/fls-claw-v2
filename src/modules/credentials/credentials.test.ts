/**
 * Credentials module tests.
 *
 * Covers:
 *   - Branded scope types are not interchangeable (C1).
 *   - Provider registry behavior (C1 + C1a reshape).
 *   - Default helpers wired against the real store (C7s).
 *   - Store: plaintext JSON envelope round-trip, listings, atomic write
 *     (C7s). Secrets-at-rest lives in the resolver layer (C7r), not the
 *     store — the store's bytes are plaintext JSON by design.
 *   - Grants: filesystem-only grant/borrow state via grantees.json and
 *     the `borrowed` symlink (C7s).
 *   - Manifest pipeline: build + write + lifecycle hook + grantee
 *     distribution + scope-wide delete + regenerate (C7s).
 *   - Scope invalidator registry (C7s).
 *   - `/creds` host command happy + error paths (C7s).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_ROOT = path.join(os.tmpdir(), `nc-creds-c7s-${process.pid}`);
const TMP_GROUPS = path.join(TMP_ROOT, 'groups');
const TMP_XDG = path.join(TMP_ROOT, 'xdg');

// Mock config so GROUPS_DIR (frozen at module load via process.cwd()) points
// at our tmp tree. group-folder.ts imports GROUPS_DIR from here.
// NB: vi.mock factories are hoisted ABOVE top-level consts, so we recompute
// the tmp path inside the factory instead of capturing TMP_GROUPS.
vi.mock('../../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../config.js')>();
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    ...orig,
    GROUPS_DIR: nodePath.join(nodeOs.tmpdir(), `nc-creds-c7s-${process.pid}`, 'groups'),
  };
});

// Silence log noise.
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Mock agent-groups DB so /creds tests don't need a real SQLite migration.
const fakeAgentGroups = new Map<string, { id: string; folder: string }>();
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => fakeAgentGroups.get(id),
  getAgentGroupByFolder: (folder: string) => {
    for (const g of fakeAgentGroups.values()) if (g.folder === folder) return g;
    return undefined;
  },
}));

// Command-gate import happens transitively from the credentials barrel —
// we don't exercise the gate itself here, just the command body. Replace
// registerHostCommand with a no-op so importing the barrel doesn't try to
// touch DB-backed gate state.
vi.mock('../../command-gate.js', () => ({
  registerHostCommand: vi.fn(),
}));

import { asCredentialScope, asGroupScope, type CredentialScope, type GroupScope } from './types.js';
import {
  registerCredentialProvider,
  getCredentialProvider,
  getAllCredentialProviders,
  _resetProviderRegistryForTests,
  type CredentialProvider,
} from './providers/registry.js';
import { defaultManifestBuilder, noManifestSideEffect } from './providers/defaults.js';
import {
  writeKeysFile,
  readKeysFile,
  deleteKeysFile,
  listEntries,
  listProviderIds,
  listScopes,
  keysFilePath,
  credentialsDir,
  ENTRY_VERSION_KEY,
} from './store.js';
import {
  addGrantee,
  clearBorrowSource,
  getBorrowSource,
  grantedDir,
  isGrantee,
  listGrantees,
  removeGrantee,
  setBorrowSource,
} from './grants.js';
import {
  _resetRegenForTests,
  distributeAllManifests,
  onKeysFileDeleted,
  onKeysFileWritten,
  regenerateAllManifests,
  revokeGranteeManifests,
} from './manifest.js';
import { _resetScopeInvalidatorsForTests, invalidateScope, registerScopeInvalidator } from './scope-invalidator.js';
import { handleCredsCommand } from './commands/creds.js';

// Provider that uses the default builder so the manifest pipeline reads
// straight from the store.
function makeProvider(id: string, overrides: Partial<CredentialProvider> = {}): CredentialProvider {
  return {
    id,
    buildManifest: defaultManifestBuilder(id),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  fs.mkdirSync(TMP_GROUPS, { recursive: true });
  fs.mkdirSync(TMP_XDG, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', TMP_XDG);
  vi.stubEnv('HOME', TMP_ROOT);
  _resetProviderRegistryForTests();
  _resetScopeInvalidatorsForTests();
  _resetRegenForTests();
  fakeAgentGroups.clear();
});

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Scope type branding (C1)
// ---------------------------------------------------------------------------

describe('scope types', () => {
  it('CredentialScope and GroupScope are not interchangeable at the type level', () => {
    const cs: CredentialScope = asCredentialScope('group-a');
    const gs: GroupScope = asGroupScope('group-a');

    // @ts-expect-error — CredentialScope is not assignable to GroupScope
    const _bad1: GroupScope = cs;

    // @ts-expect-error — GroupScope is not assignable to CredentialScope
    const _bad2: CredentialScope = gs;

    expect(cs as unknown as string).toBe('group-a');
    expect(gs as unknown as string).toBe('group-a');
  });

  it('asCredentialScope / asGroupScope are pure passthroughs', () => {
    expect(asCredentialScope('foo') as unknown as string).toBe('foo');
    expect(asGroupScope('bar') as unknown as string).toBe('bar');
  });
});

// ---------------------------------------------------------------------------
// Provider registry (C1 + C1a)
// ---------------------------------------------------------------------------

describe('provider registry', () => {
  it('registers and retrieves providers', () => {
    registerCredentialProvider(makeProvider('claude'));
    const p = getCredentialProvider('claude');
    expect(p?.id).toBe('claude');
    expect(getAllCredentialProviders()).toHaveLength(1);
  });

  it('throws on duplicate id', () => {
    registerCredentialProvider(makeProvider('claude'));
    expect(() => registerCredentialProvider(makeProvider('claude'))).toThrow(/already registered/);
  });

  it('returns providers in registration order', () => {
    registerCredentialProvider(makeProvider('a'));
    registerCredentialProvider(makeProvider('b'));
    registerCredentialProvider(makeProvider('c'));
    expect(getAllCredentialProviders().map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves provider-specific manifest behavior', () => {
    const scope = asCredentialScope('s');
    const ssh = makeProvider('ssh', { buildManifest: () => ['{"provider":"ssh","name":"host-a"}'] });
    const pem = makeProvider('pem-passwords', { buildManifest: () => [] });
    registerCredentialProvider(ssh);
    registerCredentialProvider(pem);

    expect(getCredentialProvider('ssh')?.buildManifest(scope)).toEqual(['{"provider":"ssh","name":"host-a"}']);
    expect(getCredentialProvider('pem-passwords')?.buildManifest(scope)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Default helpers (C7s — real body)
// ---------------------------------------------------------------------------

describe('default helpers', () => {
  it('defaultManifestBuilder emits one JSONL line per stored entry, skipping `v`', () => {
    const scope = asCredentialScope('group-d');
    writeKeysFile(scope, 'oauth', { 'github.com': { value: 'tok-1' }, 'gitlab.com': { value: 'tok-2' } });
    expect(defaultManifestBuilder('oauth')(scope).sort()).toEqual(
      [
        JSON.stringify({ provider: 'oauth', name: 'github.com' }),
        JSON.stringify({ provider: 'oauth', name: 'gitlab.com' }),
      ].sort(),
    );
  });

  it('defaultManifestBuilder returns [] when the keys file is absent', () => {
    expect(defaultManifestBuilder('nope')(asCredentialScope('nobody'))).toEqual([]);
  });

  it('defaultManifestBuilder skips non-object entries (defensive — matches fork)', () => {
    const scope = asCredentialScope('defs');
    writeKeysFile(scope, 'oauth', {
      'github.com': { value: 't' },
      'broken-primitive': 'not-an-object' as unknown as Record<string, unknown>,
      'broken-null': null as unknown as Record<string, unknown>,
    });
    expect(defaultManifestBuilder('oauth')(scope)).toEqual([JSON.stringify({ provider: 'oauth', name: 'github.com' })]);
  });

  it('noManifestSideEffect does not throw', () => {
    expect(() => noManifestSideEffect(asCredentialScope('s'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Store (C7s)
// ---------------------------------------------------------------------------

describe('store', () => {
  it('writeKeysFile + readKeysFile round-trip; on-disk bytes are plaintext JSON', () => {
    // The store does not encrypt — it's a plaintext JSON envelope.
    // Per-field encryption of secret strings (e.g. `.value`) is the
    // resolver's job; callers writing real secrets through the store
    // must pre-encrypt those fields. The test uses a non-secret marker
    // value to assert the envelope shape.
    const scope = asCredentialScope('group-s');
    writeKeysFile(scope, 'oauth', { 'github.com': { value: 'enc:aes-256-gcm:CIPHERTEXT' } });

    const round = readKeysFile(scope, 'oauth');
    expect(round['github.com']).toEqual({ value: 'enc:aes-256-gcm:CIPHERTEXT' });
    expect(round[ENTRY_VERSION_KEY]).toBe(1);

    const onDisk = fs.readFileSync(keysFilePath(scope, 'oauth'), 'utf-8');
    const parsed = JSON.parse(onDisk) as Record<string, unknown>;
    expect(parsed).toEqual({
      'github.com': { value: 'enc:aes-256-gcm:CIPHERTEXT' },
      [ENTRY_VERSION_KEY]: 1,
    });
  });

  it('readKeysFile returns {} for an absent file and creates no directories', () => {
    expect(readKeysFile(asCredentialScope('never'), 'oauth')).toEqual({});
    expect(fs.existsSync(path.join(credentialsDir(), 'never'))).toBe(false);
  });

  it('listEntries skips the `v` marker; listProviderIds and listScopes report what is on disk', () => {
    const a = asCredentialScope('group-a');
    const b = asCredentialScope('group-b');
    writeKeysFile(a, 'oauth', { 'x.example': { value: 't' } });
    writeKeysFile(a, 'ssh', { 'host-1': {} });
    writeKeysFile(b, 'oauth', {});

    expect(listEntries(a, 'oauth')).toEqual(['x.example']);
    expect(listProviderIds(a).sort()).toEqual(['oauth', 'ssh']);
    expect(
      listScopes()
        .map((s) => s as unknown as string)
        .sort(),
    ).toEqual(['group-a', 'group-b']);
  });

  it('deleteKeysFile removes the file; is a no-op when absent', () => {
    const scope = asCredentialScope('group-del');
    writeKeysFile(scope, 'oauth', { e: 1 });
    deleteKeysFile(scope, 'oauth');
    expect(fs.existsSync(keysFilePath(scope, 'oauth'))).toBe(false);
    expect(() => deleteKeysFile(scope, 'oauth')).not.toThrow();
  });

  it('keys file is named `<providerId>.keys.json` (v1 scheme, refs-file counterpart)', () => {
    const scope = asCredentialScope('group-name');
    writeKeysFile(scope, 'claude', { api_key: { value: 'enc:x' } });
    const file = keysFilePath(scope, 'claude');
    expect(path.basename(file)).toBe('claude.keys.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('reads a credential store migrated in under the v1 `<prov>.keys.json` name', () => {
    // A v1 store copied in as-is has `claude.keys.json` (not `claude.json`).
    // The store must read it directly — no rename/migration step.
    const scope = asCredentialScope('group-v1');
    const dir = path.join(credentialsDir(), scope as unknown as string);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude.keys.json'), JSON.stringify({ api_key: { value: 'enc:x' }, v: 1 }));

    expect(readKeysFile(scope, 'claude')).toEqual({ api_key: { value: 'enc:x' }, v: 1 });
    expect(listProviderIds(scope)).toEqual(['claude']);
  });

  it('listProviderIds counts keys files only, ignoring the `<prov>.refs.json` sidecar', () => {
    const scope = asCredentialScope('group-refs');
    const dir = path.join(credentialsDir(), scope as unknown as string);
    fs.mkdirSync(dir, { recursive: true });
    // A refs sidecar present without a keys file must NOT register a provider.
    fs.writeFileSync(path.join(dir, 'github.refs.json'), JSON.stringify({ subs: {} }));
    writeKeysFile(scope, 'github', { oauth: { value: 'enc:x' } });

    expect(listProviderIds(scope)).toEqual(['github']);
  });
});

// ---------------------------------------------------------------------------
// Grants (C7s)
// ---------------------------------------------------------------------------

describe('grants', () => {
  it('addGrantee / removeGrantee / listGrantees / isGrantee round-trip via grantees.json', () => {
    addGrantee('grantor', 'grantee-a');
    addGrantee('grantor', 'grantee-b');
    addGrantee('grantor', 'grantee-a'); // dup → no-op

    expect(listGrantees('grantor').sort()).toEqual(['grantee-a', 'grantee-b']);
    expect(isGrantee('grantor', 'grantee-a')).toBe(true);
    expect(isGrantee('grantor', 'never')).toBe(false);

    removeGrantee('grantor', 'grantee-a');
    expect(listGrantees('grantor')).toEqual(['grantee-b']);
  });

  it('setBorrowSource creates a relative symlink under groups/{grantee}/credentials/borrowed', () => {
    setBorrowSource('grantee-x', 'grantor-y');
    const link = path.join(TMP_GROUPS, 'grantee-x', 'credentials', 'borrowed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('granted/grantor-y');
    // Symlink target is pre-created so it never dangles.
    expect(fs.statSync(grantedDir('grantee-x', 'grantor-y')).isDirectory()).toBe(true);
  });

  it('getBorrowSource reads the symlink target; clearBorrowSource removes it', () => {
    setBorrowSource('grantee-x', 'grantor-y');
    expect(getBorrowSource('grantee-x')).toBe('grantor-y');
    clearBorrowSource('grantee-x');
    expect(getBorrowSource('grantee-x')).toBeNull();
  });

  it('getBorrowSource returns null when the path is not a symlink', () => {
    const base = path.join(TMP_GROUPS, 'grantee-x', 'credentials');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'borrowed'), 'not a symlink');
    expect(getBorrowSource('grantee-x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manifest pipeline (C7s)
// ---------------------------------------------------------------------------

describe('manifest pipeline', () => {
  it('writeKeysFile auto-fires the pipeline: manifest + lifecycle hook + grantee distribution', async () => {
    const onWritten = vi.fn();
    registerCredentialProvider(makeProvider('oauth', { onManifestWritten: onWritten }));

    // Grantee added BEFORE the write so auto-fired distribution sees it.
    addGrantee('grantor', 'grantee-a');
    const scope = asCredentialScope('grantor');
    writeKeysFile(scope, 'oauth', { 'github.com': { value: 't' } });

    const srcPath = path.join(credentialsDir(), 'grantor', 'manifests', 'oauth.jsonl');
    expect(fs.readFileSync(srcPath, 'utf-8').trim()).toBe(JSON.stringify({ provider: 'oauth', name: 'github.com' }));
    expect(onWritten).toHaveBeenCalledWith(scope);

    // Grantee distribution is fire-and-forget; flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    const granteePath = path.join(TMP_GROUPS, 'grantee-a', 'credentials', 'granted', 'grantor', 'oauth.jsonl');
    expect(fs.readFileSync(granteePath, 'utf-8').trim()).toBe(
      JSON.stringify({ provider: 'oauth', name: 'github.com' }),
    );
  });

  it('deleteKeysFile auto-fires onKeysFileDeleted: removes the source manifest and grantee copies', async () => {
    registerCredentialProvider(makeProvider('oauth'));
    addGrantee('grantor', 'grantee-a');
    writeKeysFile(asCredentialScope('grantor'), 'oauth', { x: 1 });
    await new Promise((r) => setImmediate(r));

    deleteKeysFile(asCredentialScope('grantor'), 'oauth');
    await new Promise((r) => setImmediate(r));

    expect(fs.existsSync(path.join(credentialsDir(), 'grantor', 'manifests', 'oauth.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(TMP_GROUPS, 'grantee-a', 'credentials', 'granted', 'grantor', 'oauth.jsonl'))).toBe(
      false,
    );
  });

  it('onKeysFileDeleted without providerId removes the whole manifests dir and grantee dirs', async () => {
    registerCredentialProvider(makeProvider('oauth'));
    registerCredentialProvider(makeProvider('ssh'));
    addGrantee('grantor', 'grantee-a');
    writeKeysFile(asCredentialScope('grantor'), 'oauth', { x: 1 });
    writeKeysFile(asCredentialScope('grantor'), 'ssh', { y: 1 });
    await new Promise((r) => setImmediate(r));

    // Whole-scope delete is a host-level operation; deleteKeysFile only
    // covers single-provider cleanup. Call the pipeline directly.
    onKeysFileDeleted(asCredentialScope('grantor'));
    await new Promise((r) => setImmediate(r));

    expect(fs.existsSync(path.join(credentialsDir(), 'grantor', 'manifests'))).toBe(false);
    expect(fs.existsSync(path.join(TMP_GROUPS, 'grantee-a', 'credentials', 'granted', 'grantor'))).toBe(false);
  });

  it('mirrors the source manifest into the scope OWN group folder (container visibility)', async () => {
    registerCredentialProvider(makeProvider('github'));
    const scope = asCredentialScope('grantor');
    // The own group folder must exist for the mirror to fire (else it is a
    // no-op — non-group scopes like 'default' must not spawn a group dir).
    fs.mkdirSync(path.join(TMP_GROUPS, 'grantor'), { recursive: true });

    writeKeysFile(scope, 'github', { api: { value: 't' } });

    const ownPath = path.join(TMP_GROUPS, 'grantor', 'credentials', 'manifests', 'github.jsonl');
    expect(fs.readFileSync(ownPath, 'utf-8').trim()).toBe(JSON.stringify({ provider: 'github', name: 'api' }));

    // Deleting the keys file removes the own mirror too.
    deleteKeysFile(scope, 'github');
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(ownPath)).toBe(false);
  });

  it('does not create a group folder when mirroring a scope that has none', () => {
    registerCredentialProvider(makeProvider('github'));
    // No groups/no-group-scope dir created beforehand.
    writeKeysFile(asCredentialScope('no-group-scope'), 'github', { api: { value: 't' } });
    expect(fs.existsSync(path.join(TMP_GROUPS, 'no-group-scope'))).toBe(false);
  });

  it('distributeAllManifests copies every existing manifest to a new grantee', async () => {
    registerCredentialProvider(makeProvider('oauth'));
    writeKeysFile(asCredentialScope('grantor'), 'oauth', { x: 1 });
    await new Promise((r) => setImmediate(r));

    distributeAllManifests('grantor', 'grantee-new');
    const granteePath = path.join(TMP_GROUPS, 'grantee-new', 'credentials', 'granted', 'grantor', 'oauth.jsonl');
    expect(fs.existsSync(granteePath)).toBe(true);
  });

  it('revokeGranteeManifests removes the per-grantor distribution dir for one grantee', () => {
    // Seed a fake distribution dir.
    fs.mkdirSync(grantedDir('grantee-a', 'grantor'), { recursive: true });
    fs.writeFileSync(path.join(grantedDir('grantee-a', 'grantor'), 'oauth.jsonl'), 'x');
    revokeGranteeManifests('grantor', 'grantee-a');
    expect(fs.existsSync(grantedDir('grantee-a', 'grantor'))).toBe(false);
  });

  it('regenerateAllManifests rewrites manifests for every keys file on disk', () => {
    registerCredentialProvider(makeProvider('oauth'));
    writeKeysFile(asCredentialScope('a'), 'oauth', { 'x.example': { value: 'v' } });
    writeKeysFile(asCredentialScope('b'), 'oauth', { 'y.example': { value: 'v' } });
    regenerateAllManifests();
    expect(fs.existsSync(path.join(credentialsDir(), 'a', 'manifests', 'oauth.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir(), 'b', 'manifests', 'oauth.jsonl'))).toBe(true);
  });

  it('first call to onKeysFileWritten lazily regenerates manifests for pre-existing keys files', async () => {
    registerCredentialProvider(makeProvider('oauth'));
    // Two keys files exist on disk before the pipeline has ever been called.
    writeKeysFile(asCredentialScope('preexist-a'), 'oauth', { 'x.example': { value: 'v' } });
    writeKeysFile(asCredentialScope('preexist-b'), 'oauth', { 'y.example': { value: 'v' } });

    // Trigger the pipeline for a third scope — the once-flag fires and
    // sweeps the existing two as a side effect.
    writeKeysFile(asCredentialScope('trigger'), 'oauth', { 'z.example': { value: 'v' } });
    onKeysFileWritten(asCredentialScope('trigger'), 'oauth');

    expect(fs.existsSync(path.join(credentialsDir(), 'preexist-a', 'manifests', 'oauth.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir(), 'preexist-b', 'manifests', 'oauth.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir(), 'trigger', 'manifests', 'oauth.jsonl'))).toBe(true);
  });

  it('onKeysFileWritten skips silently when no provider is registered', () => {
    expect(() => onKeysFileWritten(asCredentialScope('orphan'), 'never')).not.toThrow();
    expect(fs.existsSync(path.join(credentialsDir(), 'orphan', 'manifests'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scope invalidator (C7s)
// ---------------------------------------------------------------------------

describe('scope invalidator', () => {
  it('fires every registered callback on invalidateScope', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerScopeInvalidator(a);
    registerScopeInvalidator(b);
    invalidateScope(asCredentialScope('group-x'));
    expect(a).toHaveBeenCalledWith(asCredentialScope('group-x'));
    expect(b).toHaveBeenCalledWith(asCredentialScope('group-x'));
  });

  it('one callback throwing does not block the rest', () => {
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    registerScopeInvalidator(a);
    registerScopeInvalidator(b);
    invalidateScope(asCredentialScope('group-x'));
    expect(b).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /creds host command (C7s)
// ---------------------------------------------------------------------------

interface FakeCtx {
  agentGroupId: string | null;
  args: string[];
  replies: string[];
}

function makeCtx(
  agentGroupId: string | null,
  args: string[],
): FakeCtx & {
  replyText: (s: string) => void;
  command: string;
  argsRaw: string;
  userId: string | null;
  messagingGroupId: string;
  scope: 'agent';
  reply: { channelType: string; platformId: string; threadId: string };
  beginInteraction: () => void;
} {
  const replies: string[] = [];
  return {
    agentGroupId,
    args,
    replies,
    command: '/creds',
    argsRaw: args.join(' '),
    userId: 'user:1',
    messagingGroupId: 'mg:1',
    scope: 'agent' as const,
    reply: { channelType: 'tg', platformId: 'p', threadId: 't' },
    replyText: (s: string) => replies.push(s),
    beginInteraction: () => {},
  };
}

function seedAgentGroup(id: string, folder: string): void {
  fakeAgentGroups.set(id, { id, folder });
}

describe('/creds command', () => {
  it('rejects when agentGroupId is null', () => {
    const ctx = makeCtx(null, []);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/must be invoked against an agent group/);
  });

  it('shows status with no grant/borrow', () => {
    seedAgentGroup('ag:1', 'alpha');
    const ctx = makeCtx('ag:1', []);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/\*Credentials for alpha\*/);
    expect(ctx.replies[0]).toMatch(/Borrowing from: \(none\)/);
    expect(ctx.replies[0]).toMatch(/Sharing with: \(none\)/);
  });

  it('share + borrow happy path: grantee sees "Active immediately" after grantor shares', () => {
    seedAgentGroup('ag:grantor', 'grantor');
    seedAgentGroup('ag:grantee', 'grantee');
    registerCredentialProvider(makeProvider('oauth'));

    const share = makeCtx('ag:grantor', ['share', 'grantee']);
    handleCredsCommand(share as never);
    expect(share.replies[0]).toMatch(/Granted \*grantee\*/);
    expect(listGrantees('grantor')).toEqual(['grantee']);

    const borrow = makeCtx('ag:grantee', ['borrow', 'grantor']);
    handleCredsCommand(borrow as never);
    expect(borrow.replies[0]).toMatch(/Active immediately/);
    expect(getBorrowSource('grantee')).toBe('grantor');
  });

  it('borrow before share replies *pending*', () => {
    seedAgentGroup('ag:grantor', 'grantor');
    seedAgentGroup('ag:grantee', 'grantee');

    const ctx = makeCtx('ag:grantee', ['borrow', 'grantor']);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/\*pending\*/);
    expect(getBorrowSource('grantee')).toBe('grantor');
  });

  it('borrow rejects when already borrowing from a different source', () => {
    seedAgentGroup('ag:grantee', 'grantee');
    seedAgentGroup('ag:src1', 'src1');
    seedAgentGroup('ag:src2', 'src2');

    handleCredsCommand(makeCtx('ag:grantee', ['borrow', 'src1']) as never);
    const ctx = makeCtx('ag:grantee', ['borrow', 'src2']);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/Already borrowing from \*src1\*/);
  });

  it("revoke clears the grantee's active borrow link when target was borrowing from us", () => {
    seedAgentGroup('ag:grantor', 'grantor');
    seedAgentGroup('ag:grantee', 'grantee');

    handleCredsCommand(makeCtx('ag:grantor', ['share', 'grantee']) as never);
    handleCredsCommand(makeCtx('ag:grantee', ['borrow', 'grantor']) as never);
    expect(getBorrowSource('grantee')).toBe('grantor');

    handleCredsCommand(makeCtx('ag:grantor', ['revoke', 'grantee']) as never);
    expect(listGrantees('grantor')).toEqual([]);
    expect(getBorrowSource('grantee')).toBeNull();
  });

  it('stop-borrowing clears the link and fires the scope invalidator', () => {
    seedAgentGroup('ag:grantee', 'grantee');
    seedAgentGroup('ag:grantor', 'grantor');
    handleCredsCommand(makeCtx('ag:grantee', ['borrow', 'grantor']) as never);

    const invalidator = vi.fn();
    registerScopeInvalidator(invalidator);

    const ctx = makeCtx('ag:grantee', ['stop-borrowing']);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/Stopped borrowing from \*grantor\*/);
    expect(getBorrowSource('grantee')).toBeNull();
    expect(invalidator).toHaveBeenCalledWith(asGroupScope('grantee'));
  });

  it('borrow against the same source still fires the scope invalidator', () => {
    seedAgentGroup('ag:grantee', 'grantee');
    seedAgentGroup('ag:grantor', 'grantor');
    handleCredsCommand(makeCtx('ag:grantee', ['borrow', 'grantor']) as never);

    const invalidator = vi.fn();
    registerScopeInvalidator(invalidator);
    handleCredsCommand(makeCtx('ag:grantee', ['borrow', 'grantor']) as never);
    expect(invalidator).toHaveBeenCalledWith(asGroupScope('grantee'));
  });

  it('share rejects unknown target folder', () => {
    seedAgentGroup('ag:grantor', 'grantor');
    const ctx = makeCtx('ag:grantor', ['share', 'nobody']);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/Unknown group folder: nobody/);
  });

  it('share rejects self-share', () => {
    seedAgentGroup('ag:grantor', 'grantor');
    const ctx = makeCtx('ag:grantor', ['share', 'grantor']);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/Cannot share with yourself/);
  });

  it('unknown subcommand replies with usage', () => {
    seedAgentGroup('ag:grantor', 'grantor');
    const ctx = makeCtx('ag:grantor', ['nope']);
    handleCredsCommand(ctx as never);
    expect(ctx.replies[0]).toMatch(/Unknown subcommand\. Usage:/);
  });
});
