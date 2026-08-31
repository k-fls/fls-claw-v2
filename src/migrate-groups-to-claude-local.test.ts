/**
 * The startup cutover promotes a group's pre-cutover `CLAUDE.md` to
 * `CLAUDE.local.md`. Since the composer now regenerates `CLAUDE.md` on every
 * spawn, that rename must never catch a generated document.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-migrate-claude-local-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-migrate-claude-local-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { migrateGroupsToClaudeLocal } from './migrate-groups-to-claude-local.js';
import { COMPOSED_DOC_PREFIX } from './project-doc-compose.js';

const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

function group(folder: string, claudeMd: string): string {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
  return dir;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('migrateGroupsToClaudeLocal', () => {
  it('promotes a pre-cutover CLAUDE.md to per-group memory', () => {
    const dir = group('legacy', 'hand-written group instructions');

    migrateGroupsToClaudeLocal();

    expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf-8')).toBe('hand-written group instructions');
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
  });

  // Without this the entire runtime contract becomes the group's memory, and
  // every later spawn appends to a document the agent then reads back as its
  // own notes.
  it('leaves a spawn-composed document alone', () => {
    const composed = `${COMPOSED_DOC_PREFIX} - do not edit. -->\n\n# NanoClaw Runtime Contract\n\nbody\n`;
    const dir = group('composed', composed);

    migrateGroupsToClaudeLocal();

    expect(fs.existsSync(path.join(dir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(composed);
  });
});
