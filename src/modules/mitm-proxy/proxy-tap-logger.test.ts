import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock registry — claude is always known
vi.mock('./registry.js', () => ({
  parseTapExclude: (raw: string | undefined) => {
    const known = new Set(['claude', 'github']);
    if (raw === undefined) return { excluded: new Set(['claude']), unknown: [] };
    const ids = raw.split(',').filter(Boolean);
    const excluded = new Set<string>();
    const unknown: string[] = [];
    for (const id of ids) {
      if (known.has(id)) excluded.add(id);
      else unknown.push(id);
    }
    return { excluded, unknown };
  },
}));

import { createTapFilter, readTapLog, LOG_FILE } from './proxy-tap-logger.js';
import type { TapExclusionCheck } from './proxy-tap-logger.js';
import type { ProxyTapEvent } from './credential-proxy.js';

/** Build a minimal HTTP request as raw bytes. */
function httpRequest(method: string, urlPath: string, host: string): Buffer {
  return Buffer.from(`${method} ${urlPath} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\n\r\n`);
}

/** Build a minimal HTTP response as raw bytes. */
function httpResponse(status: number): Buffer {
  return Buffer.from(`HTTP/1.1 ${status} OK\r\nContent-Length: 0\r\n\r\n`);
}

describe('tap callback deferred emission', () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-test-'));
    logFile = path.join(tmpDir, 'tap.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLog(): Record<string, unknown>[] {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  function createFilter(exclude?: ReadonlySet<string>) {
    return createTapFilter(new RegExp(''), new RegExp(''), logFile, exclude);
  }

  function resolveConnection(filter: ReturnType<typeof createTapFilter>, host: string, scope = 'test') {
    const resolver = filter(host, scope as any);
    if (!resolver) throw new Error('Filter returned null');
    const result = resolver(host, scope as any);
    if (!result) throw new Error('Resolver returned null');
    return result;
  }

  it('defers emission until flush is called', () => {
    const filter = createFilter(new Set());
    const { callback, checkExclusion } = resolveConnection(filter, 'example.com');

    // Send request — should NOT emit yet (checkExclusion not called)
    callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/test', 'example.com'),
      targetHost: 'example.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    expect(readLog()).toHaveLength(0);

    // Dispatcher resolves — no provider matched
    checkExclusion(null);

    // Now head should be emitted
    const entries = readLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].method).toBe('GET');
    expect(entries[0].url).toBe('/test');
  });

  it('excludes traffic from excluded provider', () => {
    const filter = createFilter(new Set(['claude']));
    const { callback, checkExclusion } = resolveConnection(filter, 'api.anthropic.com');

    callback({
      direction: 'inbound',
      chunk: httpRequest('POST', '/v1/messages', 'api.anthropic.com'),
      targetHost: 'api.anthropic.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    // Dispatcher matched claude
    checkExclusion('claude');

    // Nothing should be logged
    expect(readLog()).toHaveLength(0);

    // Even subsequent outbound should be suppressed
    callback({
      direction: 'outbound',
      chunk: httpResponse(200),
      targetHost: 'api.anthropic.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    expect(readLog()).toHaveLength(0);
  });

  it('captures non-excluded provider traffic', () => {
    const filter = createFilter(new Set(['claude']));
    const { callback, checkExclusion } = resolveConnection(filter, 'api.github.com');

    callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/user', 'api.github.com'),
      targetHost: 'api.github.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    // github is not excluded
    checkExclusion('github');

    const entries = readLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].method).toBe('GET');
  });

  it('captures unmanaged host (null provider)', () => {
    const filter = createFilter(new Set(['claude']));
    const { callback, checkExclusion } = resolveConnection(filter, 'random-api.com');

    callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/data', 'random-api.com'),
      targetHost: 'random-api.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    checkExclusion(null);

    const entries = readLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].host).toBe('random-api.com');
  });

  it('emits connection-only for non-HTTP traffic', () => {
    const filter = createFilter(new Set());
    const { callback } = resolveConnection(filter, 'binary-host.com');

    // Send 9KB of binary garbage (exceeds NON_HTTP_THRESHOLD)
    const garbage = Buffer.alloc(9 * 1024, 0x42);
    callback({
      direction: 'inbound',
      chunk: garbage,
      targetHost: 'binary-host.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('connection');
    expect(entries[0].host).toBe('binary-host.com');
    // No method, url, headers, or body
    expect(entries[0].method).toBeUndefined();
  });

  it('flushes buffered data on close when dispatcher never resolved', () => {
    const filter = createFilter(new Set());
    const { callback, checkExclusion } = resolveConnection(filter, 'slow-host.com');

    callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/slow', 'slow-host.com'),
      targetHost: 'slow-host.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    // Dispatcher never calls flush — connection closes

    callback({
      direction: 'close',
      chunk: Buffer.alloc(0),
      targetHost: 'slow-host.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    // Should still emit (default to capture)
    const entries = readLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].method).toBe('GET');
  });

  it('emits connection-only on close when no headers parsed', () => {
    const filter = createFilter(new Set());
    const { callback } = resolveConnection(filter, 'partial.com');

    // Send partial data that doesn't complete headers
    callback({
      direction: 'inbound',
      chunk: Buffer.from('GET /par'),
      targetHost: 'partial.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    // Connection closes before headers complete
    callback({
      direction: 'close',
      chunk: Buffer.alloc(0),
      targetHost: 'partial.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('connection');
  });

  it('includes connId in all emitted entries', () => {
    const filter = createFilter(new Set());
    const { callback, checkExclusion } = resolveConnection(filter, 'id-test.com');

    callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/', 'id-test.com'),
      targetHost: 'id-test.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);

    checkExclusion(null);

    const entries = readLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // All entries from same connection share the same connId
    const connId = entries[0].connId as string;
    expect(connId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (const e of entries) {
      expect(e.connId).toBe(connId);
    }
  });

  it('different connections get different connIds', () => {
    const filter = createFilter(new Set());
    const c1 = resolveConnection(filter, 'host1.com');
    const c2 = resolveConnection(filter, 'host2.com');

    c1.callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/1', 'host1.com'),
      targetHost: 'host1.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);
    c1.checkExclusion(null);

    c2.callback({
      direction: 'inbound',
      chunk: httpRequest('GET', '/2', 'host2.com'),
      targetHost: 'host2.com',
      targetPort: 443,
      scope: 'test',
    } as ProxyTapEvent);
    c2.checkExclusion(null);

    const entries = readLog();
    const ids = new Set(entries.map((e) => e.connId));
    expect(ids.size).toBe(2);
  });
});

describe('readTapLog', () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-read-'));
    logFile = path.join(tmpDir, 'proxy-tap.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEntries(entries: Record<string, unknown>[]) {
    fs.writeFileSync(logFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  function makeHead(i: number) {
    return {
      ts: `2026-04-02T10:00:0${i}Z`,
      connId: `conn-${i}`,
      scope: 'test',
      host: `host${i}.com`,
      direction: 'inbound',
      method: 'GET',
      url: `/${i}`,
      headers: {},
    };
  }

  function makeBody(i: number) {
    return {
      ts: `2026-04-02T10:00:0${i}Z`,
      connId: `conn-${i}`,
      scope: 'test',
      host: `host${i}.com`,
      direction: 'inbound',
      type: 'body',
      method: 'GET',
      url: `/${i}`,
      body: Buffer.from('hello').toString('base64'),
    };
  }

  it('defaults to last 5 entries', () => {
    writeEntries(Array.from({ length: 10 }, (_, i) => makeHead(i)));
    const output = readTapLog('tail', 5, false, logFile);
    expect(output).toContain('Last 5 of 10');
  });

  it('filters out body entries by default', () => {
    writeEntries([makeHead(0), makeBody(0), makeHead(1), makeBody(1)]);
    const output = readTapLog('tail', 10, false, logFile);
    expect(output).not.toContain('BODY');
    expect(output).toContain('Last 2 of 2');
  });

  it('includes body entries when showBody is true', () => {
    writeEntries([makeHead(0), makeBody(0)]);
    const output = readTapLog('tail', 10, true, logFile);
    expect(output).toContain('BODY');
    expect(output).toContain('Last 2 of 2');
  });

  it('shows connId prefix in formatted output', () => {
    writeEntries([{ ...makeHead(0), connId: 'abcdef01-2345-6789-abcd-ef0123456789' }]);
    const output = readTapLog('tail', 5, false, logFile);
    expect(output).toContain('abcdef01');
  });
});
