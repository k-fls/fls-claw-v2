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

describe('buildContainerArgs ordering invariant (structural)', () => {
  // C3 (onecli-broker): the OneCLI gateway is no longer wired in container-runner
  // at all — the always-on MITM credential proxy owns egress and OneCLI is a
  // broker behind it. The upstream "gateway must apply after the mounts loop"
  // ordering invariant is therefore moot here; instead pin that no gateway apply
  // leaks back into the spawn path (it would re-collide with the proxy on
  // HTTPS_PROXY). The mounts loop itself still exists.
  it('does not wire the OneCLI gateway in the spawn path (broker model)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(src).not.toContain('onecli.applyContainerConfig');
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain("CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || ''");
    expect(cfg).toContain("CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || ''");
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});
