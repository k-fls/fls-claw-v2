import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  persisted: new Map<string, string>(),
  configs: [] as Array<{ provider: string | null }>,
}));

vi.mock('../credentials/index.js', () => ({
  getAllCredentialProviders: () => [],
  RUNTIME_UPDATER: { id: 'runtimeUpdater' },
}));
vi.mock('../../db/runtime-auto-update.js', () => ({
  getRuntimeAutoUpdate: (p: string) => h.persisted.get(p) ?? null,
  setRuntimeAutoUpdate: (p: string, s: string) => h.persisted.set(p, s),
}));
vi.mock('../../db/container-configs.js', () => ({ getAllContainerConfigs: () => h.configs }));
vi.mock('../../container-config.js', () => ({
  parseProviderSpec: (raw: string) => {
    const i = raw.indexOf(':');
    return i === -1
      ? { id: raw.toLowerCase() }
      : { id: raw.slice(0, i).toLowerCase(), version: raw.slice(i + 1) || undefined };
  },
}));
vi.mock('../../log.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));

import {
  RuntimeUpdateManager,
  parseRuntimeUpdate,
  resolveSelectedVersion,
  markCliVersionInUse,
  releaseCliVersionInUse,
  cliVersionsInUse,
  canRemoveVersion,
  _resetRuntimeUpdatersForTests,
} from './manager.js';

function stubUpdater() {
  return {
    label: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    latestVersion: vi.fn((): string | null => '2.1.200'),
    installedVersions: vi.fn(() => []),
    installedDir: vi.fn(() => null),
    fetch: vi.fn(async () => '/tmp/runtime-cli/claude/2.1.200'),
    remove: vi.fn(),
  };
}

beforeEach(() => {
  h.persisted = new Map();
  h.configs = [];
  _resetRuntimeUpdatersForTests();
});

const updaterWith = (versions: string[]) => ({ installedVersions: () => versions }) as never;

describe('resolveSelectedVersion', () => {
  it('returns null for a bare provider (no selection)', () => {
    expect(resolveSelectedVersion(updaterWith(['2.1.1']), undefined)).toBeNull();
  });
  it("resolves 'latest' to the newest fetched version", () => {
    expect(resolveSelectedVersion(updaterWith(['2.1.1', '2.1.10']), 'latest')).toBe('2.1.10');
  });
  it("returns null for 'latest' when nothing is fetched (→ baked)", () => {
    expect(resolveSelectedVersion(updaterWith([]), 'latest')).toBeNull();
  });
  it('resolves an exact version only when fetched', () => {
    expect(resolveSelectedVersion(updaterWith(['2.1.1']), '2.1.1')).toBe('2.1.1');
    expect(resolveSelectedVersion(updaterWith(['2.1.1']), '9.9.9')).toBeNull();
  });
});

describe('in-use registry + canRemoveVersion', () => {
  it('tracks and releases concrete versions per session', () => {
    markCliVersionInUse('s1', 'claude', '2.1.1');
    markCliVersionInUse('s2', 'claude', '2.1.10');
    expect(cliVersionsInUse('claude')).toEqual(new Set(['2.1.1', '2.1.10']));
    releaseCliVersionInUse('s1');
    expect(cliVersionsInUse('claude')).toEqual(new Set(['2.1.10']));
  });

  it('allows removal when unreferenced and not in use', () => {
    expect(canRemoveVersion('claude', '2.1.1')).toEqual({ ok: true });
  });

  it('refuses removal of a version selected by a group', () => {
    h.configs = [{ provider: 'claude:2.1.1' }];
    expect(canRemoveVersion('claude', '2.1.1').ok).toBe(false);
  });

  it('refuses removal of a version mounted in a running container', () => {
    markCliVersionInUse('s1', 'claude', '2.1.1');
    expect(canRemoveVersion('claude', '2.1.1').ok).toBe(false);
  });

  it('does not confuse providers', () => {
    h.configs = [{ provider: 'opencode:2.1.1' }];
    markCliVersionInUse('s1', 'opencode', '2.1.1');
    expect(canRemoveVersion('claude', '2.1.1')).toEqual({ ok: true });
  });
});

describe('parseRuntimeUpdate', () => {
  it('parses durations as latest mode', () => {
    expect(parseRuntimeUpdate('24h')).toEqual({ mode: 'latest', intervalMs: 24 * 3600000, version: '' });
    expect(parseRuntimeUpdate('30m')).toEqual({ mode: 'latest', intervalMs: 30 * 60000, version: '' });
    expect(parseRuntimeUpdate('2d')).toEqual({ mode: 'latest', intervalMs: 2 * 86400000, version: '' });
  });
  it('parses a semver as pinned mode', () => {
    expect(parseRuntimeUpdate('2.1.154')).toEqual({ mode: 'pinned', intervalMs: 0, version: '2.1.154' });
  });
  it('treats empty / garbage as off', () => {
    expect(parseRuntimeUpdate('').mode).toBe('off');
    expect(parseRuntimeUpdate('nonsense').mode).toBe('off');
  });
});

describe('RuntimeUpdateManager', () => {
  it('off setting does no fetch', async () => {
    const u = stubUpdater();
    const m = new RuntimeUpdateManager('claude', u as never, '');
    await m.start();
    expect(u.fetch).not.toHaveBeenCalled();
  });

  it('pinned setting fetches that exact version', async () => {
    const u = stubUpdater();
    const m = new RuntimeUpdateManager('claude', u as never, '2.1.154');
    await m.start();
    expect(u.fetch).toHaveBeenCalledWith('2.1.154');
  });

  it('latest setting fetches the resolved latest version', async () => {
    const u = stubUpdater();
    const m = new RuntimeUpdateManager('claude', u as never, '24h');
    await m.start();
    expect(u.latestVersion).toHaveBeenCalled();
    expect(u.fetch).toHaveBeenCalledWith('2.1.200');
    m.stop();
  });

  it('reconfigure persists the setting to the DB', async () => {
    const u = stubUpdater();
    const m = new RuntimeUpdateManager('claude', u as never, '');
    await m.reconfigure('48h');
    expect(h.persisted.get('claude')).toBe('48h');
    expect(m.getSetting()).toBe('48h');
    m.stop();
  });

  it('fetchVersion returns false when the install throws', async () => {
    const u = stubUpdater();
    u.fetch.mockRejectedValueOnce(new Error('boom'));
    const m = new RuntimeUpdateManager('claude', u as never, '');
    expect(await m.fetchVersion('2.1.154')).toBe(false);
  });

  it('fetchLatest returns the version on success and null on failed lookup', async () => {
    const u = stubUpdater();
    const m = new RuntimeUpdateManager('claude', u as never, '');
    expect(await m.fetchLatest()).toBe('2.1.200');
    u.latestVersion.mockReturnValueOnce(null);
    expect(await m.fetchLatest()).toBeNull();
  });
});
