import os from 'os';
import path from 'path';


import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────
//
// Retargeted from the fork's `src/mount-security.test.ts` (535 LOC) onto
// v2's `src/modules/mount-security/index.ts`. Two fork concepts are gone
// in v2 and so are their tests: the `nonMainReadOnly` allowlist field is
// tolerated (warn-and-ignore) and the `isMain` second arg to validateMount /
// validateAdditionalMounts is gone — v2 derives readonly purely from the
// mount request + the allowed root.
//
// RESOLUTION NOTE (mount-security conflict):
// THEIRS' test used vi.mock('fs') with existsSync + readFileSync.
// OURS' index.ts (merged without conflict) switched to statSync for
// mtime-keyed caching — see index.ts lines 103 and 115. The mock here
// follows the implementation: statSync replaces existsSync and a
// missing-file is signalled by statSync throwing (ENOENT), not by
// existsSync returning false. The caching test was updated accordingly:
// parse errors reset the cache to null but a fixed file is picked up on
// the next call when its mtime changes (index.ts line 160: cache = null).

const { mockStatSync, mockReadFileSync, mockRealpathSync } = vi.hoisted(() => ({
  mockStatSync: vi.fn() as ReturnType<typeof vi.fn>,
  mockReadFileSync: vi.fn() as ReturnType<typeof vi.fn>,
  mockRealpathSync: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('fs', () => ({
  default: {
    statSync: mockStatSync,
    readFileSync: mockReadFileSync,
    realpathSync: mockRealpathSync,
  },
}));

vi.mock('../../config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/mock/mount-allowlist.json',
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// ── Test data ─────────────────────────────────────────────────────────

const ALLOWLIST_PATH = '/mock/mount-allowlist.json';
const STAT_HIT = { mtimeMs: 1000 };

const VALID_ALLOWLIST = {
  allowedRoots: [
    {
      path: '/allowed/rw',
      allowReadWrite: true,
      description: 'Read-write root',
    },
    {
      path: '/allowed/ro',
      allowReadWrite: false,
      description: 'Read-only root',
    },
  ],
  blockedPatterns: ['custom-blocked'],
};

/** Set up mocks so loadMountAllowlist returns a valid allowlist. */
function setupValidAllowlist(overrides?: Record<string, unknown>) {
  const allowlist = { ...VALID_ALLOWLIST, ...overrides };
  mockStatSync.mockImplementation((p: string) => {
    if (p === ALLOWLIST_PATH) return { mtimeMs: 1 };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  mockReadFileSync.mockImplementation((p: string) => {
    if (p === ALLOWLIST_PATH) return JSON.stringify(allowlist);
    throw new Error(`Unexpected readFileSync: ${p}`);
  });
  mockRealpathSync.mockImplementation((p: string) => p);
}

// ── loadMountAllowlist ────────────────────────────────────────────────

describe('loadMountAllowlist', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockRealpathSync.mockReset();
  });

  it('returns null when file does not exist', async () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { loadMountAllowlist } = await import('./index.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when JSON is invalid', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue('not json {{{');
    const { loadMountAllowlist } = await import('./index.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when allowedRoots is not an array', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: 'not-array',
        blockedPatterns: [],
      }),
    );
    const { loadMountAllowlist } = await import('./index.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-array',
      }),
    );
    const { loadMountAllowlist } = await import('./index.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('merges default blocked patterns with user patterns', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: ['my-custom'],
      }),
    );
    const { loadMountAllowlist } = await import('./index.js');
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    // Default patterns
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.gnupg');
    expect(result!.blockedPatterns).toContain('.aws');
    expect(result!.blockedPatterns).toContain('.kube');
    expect(result!.blockedPatterns).toContain('.docker');
    expect(result!.blockedPatterns).toContain('id_rsa');
    expect(result!.blockedPatterns).toContain('id_ed25519');
    expect(result!.blockedPatterns).toContain('.env');
    // User pattern
    expect(result!.blockedPatterns).toContain('my-custom');
  });

  it('deduplicates when user pattern overlaps with defaults', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: ['.ssh', '.ssh', 'extra'],
      }),
    );
    const { loadMountAllowlist } = await import('./index.js');
    const result = loadMountAllowlist()!;
    const sshCount = result.blockedPatterns.filter((p) => p === '.ssh').length;
    expect(sshCount).toBe(1);
  });

  it('caches result — second call does not re-read file', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
      }),
    );
    const { loadMountAllowlist } = await import('./index.js');
    const first = loadMountAllowlist();
    const second = loadMountAllowlist();
    expect(first).toBe(second);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('re-checks when file not found — not cached as error', async () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { loadMountAllowlist } = await import('./index.js');
    loadMountAllowlist();
    loadMountAllowlist();
    // statSync called twice because file-not-found is not cached
    expect(mockStatSync).toHaveBeenCalledTimes(2);
  });

  it('re-reads after a fixed parse error (parse errors are not permanently cached)', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue('not json {{{');
    const { loadMountAllowlist } = await import('./index.js');
    expect(loadMountAllowlist()).toBeNull();
    // parse error does NOT poison the cache — re-reads on next call
    expect(loadMountAllowlist()).toBeNull();
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('translates per-root readOnly:false into a read-write grant', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/allowed/rw', readOnly: false }],
        blockedPatterns: [],
      }),
    );
    mockRealpathSync.mockImplementation((p: string) => p);
    const { loadMountAllowlist, validateMount } = await import('./index.js');
    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(true);
    const result = validateMount({ hostPath: '/allowed/rw/project', readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('keeps readOnly:true as a read-only grant', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/allowed/rw', readOnly: true }],
        blockedPatterns: [],
      }),
    );
    mockRealpathSync.mockImplementation((p: string) => p);
    const { loadMountAllowlist, validateMount } = await import('./index.js');
    const allowlist = loadMountAllowlist();
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(false);
    const result = validateMount({ hostPath: '/allowed/rw/project', readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('tolerates the nonMainReadOnly top-level key without rejecting', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 1 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/allowed/rw', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );
    const { loadMountAllowlist } = await import('./index.js');
    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots).toHaveLength(1);
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(true);
  });
});

// ── validateMount ───────────────────────────────────────────────

describe('validateMount', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockRealpathSync.mockReset();
  });

  it('rejects when no allowlist is configured', async () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/some/path' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });

  // -- containerPath validation --

  it('rejects containerPath containing ".."', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo', containerPath: '../escape' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects absolute containerPath', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo', containerPath: '/absolute' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('relative');
  });

  it('rejects containerPath containing a colon (Docker -v option injection)', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo', containerPath: 'repo:rw' });
    expect(result.allowed).toBe(false);
  });

  it('falls back to basename when containerPath is empty string', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    // Empty string is falsy, so || falls through to path.basename
    const result = validateMount({ hostPath: '/allowed/rw/foo', containerPath: '' });
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('foo');
  });

  it('rejects whitespace-only containerPath', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo', containerPath: '   ' });
    expect(result.allowed).toBe(false);
  });

  // -- hostPath validation --

  it('rejects non-existent hostPath', async () => {
    setupValidAllowlist();
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/nonexistent') throw new Error('ENOENT');
      return p;
    });
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/nonexistent' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  // -- blocked pattern checks --

  it('rejects path matching default blocked pattern .ssh', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/.ssh' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('rejects path matching default blocked pattern .aws', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/.aws' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.aws');
  });

  it('rejects path matching custom blocked pattern', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/custom-blocked' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('custom-blocked');
  });

  it('rejects path with blocked pattern as substring in component', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    // "credentials" is a default blocked pattern; "my-credentials-backup" contains it
    const result = validateMount({ hostPath: '/allowed/rw/my-credentials-backup' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('credentials');
  });

  it('rejects deeply nested blocked path', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/project/.env/config' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });

  // -- allowed root checks --

  it('rejects path not under any allowed root', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/not-allowed/foo' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('skips allowed root that does not exist on disk', async () => {
    setupValidAllowlist();
    mockRealpathSync.mockImplementation((p: string) => {
      // The first allowed root (/allowed/rw) doesn't exist
      if (p === '/allowed/rw') throw new Error('ENOENT');
      return p;
    });
    const { validateMount } = await import('./index.js');
    // Mount under first root fails (root doesn't exist), but second root also doesn't match
    const result = validateMount({ hostPath: '/allowed/rw/proj' });
    expect(result.allowed).toBe(false);
  });

  // -- happy paths --

  it('allows valid mount under read-write root', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/myproject' });
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/allowed/rw/myproject');
    expect(result.resolvedContainerPath).toBe('myproject');
    expect(result.reason).toContain('/allowed/rw');
  });

  it('allows valid mount under read-only root', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/ro/docs' });
    expect(result.allowed).toBe(true);
  });

  it('defaults containerPath to basename of hostPath', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/deep/nested/proj' });
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('proj');
  });

  it('uses explicit containerPath when provided', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo', containerPath: 'custom-name' });
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('custom-name');
  });

  it('resolves symlinks on hostPath before validation', async () => {
    setupValidAllowlist();
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/symlink/to/project') return '/allowed/rw/real-project';
      return p;
    });
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/symlink/to/project' });
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/allowed/rw/real-project');
  });

  it('expands ~ in hostPath', async () => {
    const home = process.env.HOME || os.homedir();
    const stuffDir = path.join(home, 'stuff');
    setupValidAllowlist({
      allowedRoots: [...VALID_ALLOWLIST.allowedRoots, { path: stuffDir, allowReadWrite: true }],
    });
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '~/stuff/proj' });
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(path.join(stuffDir, 'proj'));
  });

  // -- readonly enforcement --

  it('defaults to readonly when mount does not request write', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo' });
    expect(result.effectiveReadonly).toBe(true);
  });

  it('grants read-write when requested under an rw root', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/rw/foo', readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly when root disallows read-write', async () => {
    setupValidAllowlist();
    const { validateMount } = await import('./index.js');
    const result = validateMount({ hostPath: '/allowed/ro/docs', readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});

// ── validateAdditionalMounts ────────────────────────────────────

describe('validateAdditionalMounts', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockRealpathSync.mockReset();
  });

  it('returns only valid mounts, filtering rejected ones', async () => {
    setupValidAllowlist();
    const { validateAdditionalMounts } = await import('./index.js');
    const result = validateAdditionalMounts(
      [{ hostPath: '/allowed/rw/good1' }, { hostPath: '/not-allowed/bad' }, { hostPath: '/allowed/rw/good2' }],
      'test-group',
    );
    expect(result).toHaveLength(2);
    expect(result[0].hostPath).toBe('/allowed/rw/good1');
    expect(result[1].hostPath).toBe('/allowed/rw/good2');
  });

  it('prepends /workspace/extra/ to container paths', async () => {
    setupValidAllowlist();
    const { validateAdditionalMounts } = await import('./index.js');
    const result = validateAdditionalMounts([{ hostPath: '/allowed/rw/proj' }], 'test-group');
    expect(result[0].containerPath).toBe('/workspace/extra/proj');
  });

  it('returns empty array when all mounts are rejected', async () => {
    setupValidAllowlist();
    const { validateAdditionalMounts } = await import('./index.js');
    const result = validateAdditionalMounts(
      [{ hostPath: '/not-allowed/a' }, { hostPath: '/not-allowed/b' }],
      'test-group',
    );
    expect(result).toHaveLength(0);
  });

  it('passes effective readonly to output', async () => {
    setupValidAllowlist();
    const { validateAdditionalMounts } = await import('./index.js');
    const result = validateAdditionalMounts([{ hostPath: '/allowed/rw/proj', readonly: false }], 'test-group');
    expect(result[0].readonly).toBe(false);
  });

  it('handles empty mount array', async () => {
    setupValidAllowlist();
    const { validateAdditionalMounts } = await import('./index.js');
    const result = validateAdditionalMounts([], 'test-group');
    expect(result).toHaveLength(0);
  });
});

// ── generateAllowlistTemplate ───────────────────────────────────

describe('generateAllowlistTemplate', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockRealpathSync.mockReset();
  });

  it('returns valid JSON with expected structure', async () => {
    const { generateAllowlistTemplate } = await import('./index.js');
    const template = JSON.parse(generateAllowlistTemplate());
    expect(Array.isArray(template.allowedRoots)).toBe(true);
    expect(Array.isArray(template.blockedPatterns)).toBe(true);
    expect(template.allowedRoots.length).toBeGreaterThan(0);
  });
});
