/**
 * Tests for the snapshot copy.
 *
 * Runs against a temp DATA_DIR via vi.mock — the real config.DATA_DIR
 * resolves to repo/data which we don't want to clobber.
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

import { __resetSnapshotForTests, initSnapshot, snapshotPath } from './snapshot.js';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  originalCwd = process.cwd();
  // Build a fake container/ tree under a sandbox cwd
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-cwd-'));
  fs.mkdirSync(path.join(sandboxRoot, 'container'), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, 'container', 'entrypoint.sh'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(sandboxRoot, 'container', 'agent-runner', 'src'), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, 'container', 'agent-runner', 'src', 'index.ts'), 'export {};\n');
  fs.mkdirSync(path.join(sandboxRoot, 'container', 'agent-runner', 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, 'container', 'agent-runner', 'node_modules', 'junk', 'big'), 'x');
  process.chdir(sandboxRoot);
  __resetSnapshotForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  __resetSnapshotForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initSnapshot', () => {
  it('creates the snapshot tree and excludes node_modules', () => {
    initSnapshot();
    const snapRoot = snapshotPath();
    expect(fs.existsSync(path.join(snapRoot, 'entrypoint.sh'))).toBe(true);
    expect(fs.existsSync(path.join(snapRoot, 'agent-runner', 'src', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(snapRoot, 'agent-runner', 'node_modules'))).toBe(false);
  });

  it('is idempotent — second init refreshes the contents', () => {
    initSnapshot();
    // Mutate source between inits
    fs.writeFileSync(path.join(process.cwd(), 'container', 'new-file.txt'), 'hi');
    initSnapshot();
    expect(fs.existsSync(snapshotPath('new-file.txt'))).toBe(true);
  });

  it('snapshotPath resolves relatives against the snapshot root', () => {
    initSnapshot();
    expect(snapshotPath('entrypoint.sh')).toBe(path.join(tmpDir, 'snapshot', 'container', 'entrypoint.sh'));
  });

  it('throws when a required path is missing from the source (catches partial trees)', () => {
    // Simulate a corrupted source: entrypoint.sh exists but agent-runner/src
    // is gone. Without this assertion the snapshot would silently succeed and
    // the failure would only surface much later as an opaque container exit.
    fs.rmSync(path.join(process.cwd(), 'container', 'agent-runner', 'src'), { recursive: true });
    expect(() => initSnapshot()).toThrow(/missing required path "agent-runner/);
  });

  it('throws when entrypoint.sh is missing from the source', () => {
    fs.unlinkSync(path.join(process.cwd(), 'container', 'entrypoint.sh'));
    expect(() => initSnapshot()).toThrow(/missing required path "entrypoint\.sh"/);
  });
});

describe('snapshotPath', () => {
  it('throws if init was not run', () => {
    expect(() => snapshotPath('x')).toThrow(/not initialized/);
  });
});
