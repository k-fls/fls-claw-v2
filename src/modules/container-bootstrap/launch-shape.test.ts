/**
 * Tests for the default launch shape — mounts come from the snapshot, not
 * `process.cwd()/container`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let originalCwd: string;

vi.mock('../../config.js', async () => {
  const real = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...real,
    get DATA_DIR() {
      return tmpDir;
    },
  };
});

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { defaultLaunchShape } from './launch-shape.js';
import { __resetSnapshotForTests, initSnapshot, snapshotPath } from './snapshot.js';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-test-'));
  originalCwd = process.cwd();
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-cwd-'));
  const c = path.join(sandboxRoot, 'container');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'entrypoint.sh'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(c, 'agent-runner', 'src'), { recursive: true });
  fs.writeFileSync(path.join(c, 'agent-runner', 'src', 'index.ts'), 'export {};\n');
  fs.mkdirSync(path.join(c, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(c, 'CLAUDE.md'), '# claude\n');
  process.chdir(sandboxRoot);
  __resetSnapshotForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  __resetSnapshotForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('defaultLaunchShape', () => {
  it('mounts entrypoint, agent-runner src, skills, CLAUDE.md from the snapshot — all read-only', () => {
    initSnapshot();
    const { mounts } = defaultLaunchShape();
    const byContainer = new Map(mounts.map((m) => [m.containerPath, m]));
    expect(byContainer.get('/app/entrypoint.sh')).toMatchObject({
      hostPath: snapshotPath('entrypoint.sh'),
      readonly: true,
    });
    expect(byContainer.get('/app/src')).toMatchObject({
      hostPath: snapshotPath('agent-runner/src'),
      readonly: true,
    });
    expect(byContainer.get('/app/skills')?.readonly).toBe(true);
    expect(byContainer.get('/app/CLAUDE.md')?.readonly).toBe(true);
  });

  it('skips mounts whose source file is absent in the snapshot', () => {
    // Build a snapshot without CLAUDE.md / skills
    fs.rmSync(path.join(process.cwd(), 'container', 'CLAUDE.md'));
    fs.rmSync(path.join(process.cwd(), 'container', 'skills'), { recursive: true, force: true });
    initSnapshot();
    const containerPaths = defaultLaunchShape().mounts.map((m) => m.containerPath);
    expect(containerPaths).not.toContain('/app/CLAUDE.md');
    expect(containerPaths).not.toContain('/app/skills');
  });
});
