import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = path.join(os.tmpdir(), `ssh-pending-test-${process.pid}`);

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../credentials/index.js', async () => {
  const _os = await import('os');
  const _path = await import('path');
  const root = _path.default.join(_os.default.tmpdir(), `ssh-pending-test-${process.pid}`, 'credentials');
  return {
    scopeDir: (scope: string) => _path.default.join(root, scope),
  };
});

import {
  addPendingRequest,
  hasPendingRequest,
  takePendingForAlias,
  prunePendingForSession,
  clearAllPending,
  type PendingEntry,
} from './pending.js';
import type { GroupScope } from '../credentials/index.js';

const scope = 'test-group' as unknown as GroupScope;
const SID = 'sid-1';

function add(alias: string, sessionId = SID) {
  return addPendingRequest(scope, alias, sessionId);
}

function pendingFilePath(): string {
  return path.join(tmpDir, 'credentials', scope as string, 'ssh.pending.json');
}

function readPending(): Record<string, PendingEntry[]> {
  try {
    return JSON.parse(fs.readFileSync(pendingFilePath(), 'utf-8'));
  } catch {
    return {};
  }
}

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, 'credentials', scope as string), {
    recursive: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addPendingRequest', () => {
  it('creates a new pending entry', () => {
    const result = add('prod-db');
    expect(result.accepted).toBe(true);
    expect(result.capReached).toBe(false);
    const data = readPending();
    expect(data['prod-db']).toHaveLength(1);
    expect(data['prod-db'][0].sessionId).toBe(SID);
    expect(data['prod-db'][0].ts).toBeTypeOf('number');
  });

  it('refreshes ts for same (alias, sessionId)', () => {
    add('staging');
    const before = readPending()['staging'][0].ts;
    const result = add('staging');
    expect(result.accepted).toBe(true);
    const after = readPending()['staging'];
    expect(after).toHaveLength(1);
    expect(after[0].ts).toBeGreaterThanOrEqual(before);
  });

  it('appends a separate entry for the same alias from a different session', () => {
    add('shared', 'sid-A');
    add('shared', 'sid-B');
    const list = readPending()['shared'];
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.sessionId).sort()).toEqual(['sid-A', 'sid-B']);
  });

  it('counts total entries across aliases against the cap', () => {
    for (let i = 0; i < 9; i++) {
      const r = add(`alias-${i}`);
      expect(r.accepted).toBe(true);
      expect(r.capReached).toBe(false);
    }
    const r10 = add('alias-9');
    expect(r10.accepted).toBe(true);
    expect(r10.capReached).toBe(true);
  });

  it('suppresses requests beyond the cap', () => {
    for (let i = 0; i < 10; i++) add(`alias-${i}`);
    const over = add('alias-overflow');
    expect(over.accepted).toBe(false);
    expect(readPending()['alias-overflow']).toBeUndefined();
  });

  it('prunes stale entries before counting', () => {
    const filePath = pendingFilePath();
    const oldTs = Date.now() - 2 * 60 * 60 * 1000;
    const stale: Record<string, PendingEntry[]> = {};
    for (let i = 0; i < 10; i++) {
      stale[`stale-${i}`] = [{ sessionId: `old-${i}`, ts: oldTs }];
    }
    fs.writeFileSync(filePath, JSON.stringify(stale));

    const result = add('fresh');
    expect(result.accepted).toBe(true);
    const data = readPending();
    expect(Object.keys(data)).toEqual(['fresh']);
  });
});

describe('hasPendingRequest', () => {
  it('returns true when entries exist for alias', () => {
    add('db');
    expect(hasPendingRequest(scope, 'db')).toBe(true);
  });

  it('returns false when alias is absent', () => {
    expect(hasPendingRequest(scope, 'nope')).toBe(false);
  });

  it('returns false when all entries are stale', () => {
    const filePath = pendingFilePath();
    const oldTs = Date.now() - 2 * 60 * 60 * 1000;
    fs.writeFileSync(filePath, JSON.stringify({ old: [{ sessionId: SID, ts: oldTs }] }));
    expect(hasPendingRequest(scope, 'old')).toBe(false);
  });
});

describe('takePendingForAlias', () => {
  it('drains and returns all entries for an alias', () => {
    add('target', 'sid-A');
    add('target', 'sid-B');
    const drained = takePendingForAlias(scope, 'target');
    expect(drained.map((e) => e.sessionId).sort()).toEqual(['sid-A', 'sid-B']);
    expect(readPending()['target']).toBeUndefined();
  });

  it('returns empty list when nothing pending', () => {
    expect(takePendingForAlias(scope, 'ghost')).toEqual([]);
  });
});

describe('prunePendingForSession', () => {
  it('removes only entries matching sessionId', () => {
    add('a', 'sid-A');
    add('a', 'sid-B');
    add('b', 'sid-A');

    prunePendingForSession(scope, 'sid-A');

    const data = readPending();
    expect(data['a']).toHaveLength(1);
    expect(data['a'][0].sessionId).toBe('sid-B');
    expect(data['b']).toBeUndefined();
  });
});

describe('clearAllPending', () => {
  it('clears all entries and returns total count', () => {
    add('a');
    add('b', 'sid-X');
    add('b', 'sid-Y');
    const count = clearAllPending(scope);
    expect(count).toBe(3);
    expect(readPending()).toEqual({});
  });

  it('returns 0 when empty', () => {
    expect(clearAllPending(scope)).toBe(0);
  });
});
