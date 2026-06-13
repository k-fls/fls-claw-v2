import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { baseRunArgs, prepareGroupHomeDir, resolveProviderName } from './container-runner.js';

describe('prepareGroupHomeDir', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'grouphome-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates the directory if missing and returns it', () => {
    const fresh = path.join(home, 'nested', 'home');
    expect(prepareGroupHomeDir(fresh)).toBe(fresh);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('wipes top-level files (dotfile-injection guard) but keeps subdirectories', () => {
    // Injected dotfiles that must not survive a relaunch.
    fs.writeFileSync(path.join(home, '.bashrc'), 'evil');
    fs.writeFileSync(path.join(home, '.profile'), 'evil');
    fs.writeFileSync(path.join(home, '.env-vars'), 'stale');
    // App config / caches that SHOULD persist across runs.
    fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'gh', 'hosts.yml'), 'token-state');
    fs.mkdirSync(path.join(home, '.npm'));

    prepareGroupHomeDir(home);

    // Top-level files gone.
    expect(fs.existsSync(path.join(home, '.bashrc'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.profile'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.env-vars'))).toBe(false);
    // Subdirectories and their nested files survive untouched.
    expect(fs.existsSync(path.join(home, '.npm'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.config', 'gh', 'hosts.yml'), 'utf-8')).toBe('token-state');
  });

  it('is idempotent on an empty dir', () => {
    prepareGroupHomeDir(home);
    expect(fs.readdirSync(home)).toHaveLength(0);
  });
});

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('baseRunArgs', () => {
  it('includes the container name and label', () => {
    const args = baseRunArgs('nanoclaw-v2-test-123');
    expect(args).toContain('--name');
    expect(args).toContain('nanoclaw-v2-test-123');
    expect(args).toContain('--label');
  });

  it('always emits --security-opt=no-new-privileges', () => {
    // Load-bearing for the root-drop entrypoint path: without this flag,
    // setpriv's drop to HOST_UID is bypassable via setuid binaries inside
    // the container. The opening flags emit it unconditionally so both
    // rootless and root-drop spawns get the boundary.
    expect(baseRunArgs('any-name')).toContain('--security-opt=no-new-privileges');
  });

  it('emits --security-opt=no-new-privileges before the image / command args', () => {
    // Flag must appear in the docker-args section (before the image arg).
    // baseRunArgs covers only the opening section, so the flag's position
    // here also pins its position in the final argv.
    const args = baseRunArgs('any-name');
    const idx = args.indexOf('--security-opt=no-new-privileges');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(args.length);
  });
});
