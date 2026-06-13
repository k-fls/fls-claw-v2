import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return h.dataDir;
  },
  CONTAINER_IMAGE: 'nanoclaw-agent:test',
}));
vi.mock('../../container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker', hostGatewayArgs: () => [] }));
vi.mock('../../log.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));

import { RuntimeCliUpdater, maxSemver } from './updater.js';

const PKG = '@anthropic-ai/claude-code';

/** Simulate a successful `npm install` by writing the package's package.json. */
function simulateInstall(targetDir: string, spec: string): boolean {
  const version = spec.slice(spec.lastIndexOf('@') + 1);
  const pkgDir = path.join(targetDir, 'node_modules', PKG);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }));
  return true;
}

function makeUpdater(opts: { installRunner?: (d: string, s: string) => boolean; latest?: string } = {}) {
  return new RuntimeCliUpdater({
    providerId: 'claude',
    label: 'Claude Code',
    packageName: PKG,
    installRunner: opts.installRunner ?? simulateInstall,
    latestVersionLookup: () => opts.latest ?? '2.1.200',
  });
}

beforeEach(() => {
  h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcu-'));
});
afterEach(() => {
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

describe('maxSemver', () => {
  it('returns the highest numeric version', () => {
    expect(maxSemver(['2.1.9', '2.1.10', '2.0.99'])).toBe('2.1.10');
    expect(maxSemver(['2.1.154'])).toBe('2.1.154');
  });
  it('returns null for an empty list', () => {
    expect(maxSemver([])).toBeNull();
  });
});

describe('RuntimeCliUpdater', () => {
  it('fetches a version into its own dir and returns the host path', async () => {
    const u = makeUpdater();
    const dir = await u.fetch('2.1.154');
    expect(dir).toBe(path.join(h.dataDir, 'runtime-cli', 'claude', '2.1.154'));
    expect(u.installedDir('2.1.154')).toBe(dir);
    expect(u.installedVersions()).toEqual(['2.1.154']);
  });

  it('is idempotent — a second fetch of an installed version does not reinstall', async () => {
    const runner = vi.fn(simulateInstall);
    const u = makeUpdater({ installRunner: runner });
    await u.fetch('2.1.154');
    await u.fetch('2.1.154');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('installedDir returns null for a version that is not installed', async () => {
    const u = makeUpdater();
    expect(u.installedDir('9.9.9')).toBeNull();
    await u.fetch('2.1.154');
    expect(u.installedDir('2.1.154')).not.toBeNull();
  });

  it('keeps versions in separate dirs', async () => {
    const u = makeUpdater();
    await u.fetch('2.1.100');
    await u.fetch('2.1.154');
    expect(u.installedVersions().sort()).toEqual(['2.1.100', '2.1.154']);
  });

  it('remove drops a version dir', async () => {
    const u = makeUpdater();
    await u.fetch('2.1.154');
    u.remove('2.1.154');
    expect(u.installedVersions()).toEqual([]);
    expect(u.installedDir('2.1.154')).toBeNull();
  });

  it('throws and cleans up the partial dir on install failure', async () => {
    const u = makeUpdater({ installRunner: () => false });
    await expect(u.fetch('2.1.154')).rejects.toThrow(/Failed to install/);
    expect(u.installedVersions()).toEqual([]);
    expect(fs.existsSync(path.join(h.dataDir, 'runtime-cli', 'claude', '2.1.154'))).toBe(false);
  });

  it('installedVersions is empty when nothing has been fetched', () => {
    expect(makeUpdater().installedVersions()).toEqual([]);
  });
});
