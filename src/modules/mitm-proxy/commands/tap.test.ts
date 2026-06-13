import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { HostCommandContext } from '../../../command-gate.js';

// ── Hoisted shared mock state (available when mock factories run) ─────────────
const h = vi.hoisted(() => ({
  AGENT_RUNTIME: Symbol('agentRuntime') as unknown,
  GROUPS_DIR: '',
  // groups returned by getAllAgentGroups()
  groups: [] as Array<{ folder: string; agent_provider: string | null }>,
}));

// ── Mocks ────────────────────────────────────────────────────────────────────
// Admin gating is no longer handler-side: /tap registers with
// access: 'global-admin' and the command gate denies before dispatch
// (covered in command-gate.test.ts).
vi.mock('../../../config.js', () => ({
  get GROUPS_DIR() {
    return h.GROUPS_DIR;
  },
}));
vi.mock('../../../db/agent-groups.js', () => ({ getAllAgentGroups: () => h.groups }));
vi.mock('../../credentials/providers/types.js', () => ({ AGENT_RUNTIME: h.AGENT_RUNTIME }));

// A fake "claude"-like runtime: derives its exclude host from the configured
// endpoint exactly like the real provider (env → runtimeConfig → default).
vi.mock('../../credentials/providers/registry.js', () => ({
  getCredentialProvider: (id: string) =>
    id === 'claude'
      ? {
          id,
          getExtension: (t: unknown) =>
            t === h.AGENT_RUNTIME
              ? {
                  defaultTapExcludeHosts: (cfg: {
                    env?: Record<string, string>;
                    runtimeConfig?: { baseUrl?: string };
                  }) => {
                    const base =
                      cfg.env?.ANTHROPIC_BASE_URL ?? cfg.runtimeConfig?.baseUrl ?? 'https://api.anthropic.com';
                    try {
                      const u = new URL(/^[a-z]+:\/\//i.test(base) ? base : `https://${base}`);
                      return [u.hostname];
                    } catch {
                      return [];
                    }
                  },
                }
              : undefined,
        }
      : undefined,
}));

const setTapFilter = vi.fn();
const parseTapExclude = (raw: string | undefined) => {
  const known = new Set(['claude', 'github']);
  if (raw === undefined || raw === '') return { excluded: new Set<string>(), unknown: [] };
  const ids = raw.split(',').filter(Boolean);
  return {
    excluded: new Set(ids.filter((i) => known.has(i))),
    unknown: ids.filter((i) => !known.has(i)),
  };
};
vi.mock('../credential-proxy.js', () => ({
  getProxy: () => ({ setTapFilter, parseTapExclude }),
}));

const TAP_FILTER = Symbol('tap-filter');
let activeTap: { domain: string; path: string } | null = null;
const createTapFilter = vi.fn((..._a: unknown[]) => TAP_FILTER as never);
const clearActiveTap = vi.fn();
const readTapLog = vi.fn((..._a: unknown[]) => 'LOG-OUTPUT');
vi.mock('../proxy-tap-logger.js', () => ({
  LOG_FILE: '/data/proxy-tap.jsonl',
  createTapFilter: (...a: unknown[]) => createTapFilter(...a),
  getActiveTap: () => activeTap,
  clearActiveTap: () => clearActiveTap(),
  readTapLog: (...a: unknown[]) => readTapLog(...a),
}));

import { handleTapCommand } from './tap.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-test-'));
h.GROUPS_DIR = tmpRoot;

/** Register a group with an optional materialized container.json. */
function group(folder: string, opts: { provider?: string | null; containerJson?: object } = {}): void {
  h.groups.push({ folder, agent_provider: opts.provider ?? 'claude' });
  if (opts.containerJson) {
    fs.mkdirSync(path.join(tmpRoot, folder), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, folder, 'container.json'), JSON.stringify(opts.containerJson));
  }
}

function run(argsRaw: string): string[] {
  const replies: string[] = [];
  const ctx = {
    command: '/tap',
    argsRaw,
    args: argsRaw.trim().split(/\s+/).filter(Boolean),
    userId: 'discord:op',
    replyText: (t: string) => replies.push(t),
  } as unknown as HostCommandContext;
  handleTapCommand(ctx);
  return replies;
}

/** excludeHosts (5th arg) of the most recent createTapFilter call, as sources. */
function excludeHostSources(): string[] {
  const hosts = createTapFilter.mock.calls[0][4] as RegExp[];
  return hosts.map((re) => re.source);
}

beforeEach(() => {
  h.groups = [];
  activeTap = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  setTapFilter.mockClear();
  createTapFilter.mockClear();
  clearActiveTap.mockClear();
  readTapLog.mockClear();
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ── Tests ────────────────────────────────────────────────────────────────────
describe('/tap command', () => {
  it('reports inactive state with no args', () => {
    expect(run('')[0]).toBe('Tap is not active.');
  });

  it('reports active state with no args', () => {
    activeTap = { domain: 'anthropic', path: '/v1' };
    expect(run('')[0]).toContain('domain: anthropic, path: /v1');
  });

  it('stop disables the tap', () => {
    const r = run('stop');
    expect(setTapFilter).toHaveBeenCalledWith(null);
    expect(clearActiveTap).toHaveBeenCalled();
    expect(r[0]).toBe('Tap stopped.');
  });

  it('list delegates to readTapLog with parsed args', () => {
    run('list head 3 body');
    expect(readTapLog).toHaveBeenCalledWith('head', 3, true);
  });

  it('list defaults to tail/5/no-body', () => {
    run('list');
    expect(readTapLog).toHaveBeenCalledWith('tail', 5, false);
  });

  it('all defaults to excluding each group runtime’s endpoint host', () => {
    group('main'); // no container.json → claude default endpoint
    const r = run('all');
    expect(setTapFilter).toHaveBeenCalledWith(TAP_FILTER);
    expect(excludeHostSources()).toEqual(['^api\\.anthropic\\.com$']);
    // host exclusion goes through the 5th arg; provider-id set (4th) stays empty
    expect([...(createTapFilter.mock.calls[0][3] as Set<string>)]).toEqual([]);
    expect(r[0]).toContain('Excluding hosts: api.anthropic.com');
  });

  it('all excludes a group’s configured Ollama host (env override)', () => {
    group('ollama-grp', {
      containerJson: { env: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' } },
    });
    run('all');
    expect(excludeHostSources()).toEqual(['^host\\.docker\\.internal$']);
  });

  it('all unions endpoint hosts across all groups', () => {
    group('default-grp'); // api.anthropic.com
    group('ollama-grp', {
      containerJson: { env: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' } },
    });
    run('all');
    expect(excludeHostSources().sort()).toEqual(['^api\\.anthropic\\.com$', '^host\\.docker\\.internal$']);
  });

  it('all reads baseUrl from runtimeConfig when no env override', () => {
    group('rc-grp', { containerJson: { runtimeConfig: { baseUrl: 'https://llm.internal.acme' } } });
    run('all');
    expect(excludeHostSources()).toEqual(['^llm\\.internal\\.acme$']);
  });

  it('explicit exclude= uses provider-id exclusion, not host exclusion', () => {
    group('main', { containerJson: { env: { ANTHROPIC_BASE_URL: 'http://ollama:11434' } } });
    run('all exclude=github');
    // 4th arg = provider-id set; 5th arg = host list (empty for explicit form)
    expect([...(createTapFilter.mock.calls[0][3] as Set<string>)]).toEqual(['github']);
    expect(createTapFilter.mock.calls[0][4]).toEqual([]);
  });

  it('all rejects unknown exclude providers', () => {
    const r = run('all exclude=bogus');
    expect(r[0]).toMatch(/Unknown provider\(s\): bogus/);
    expect(setTapFilter).not.toHaveBeenCalled();
  });

  it('all rejects malformed args', () => {
    expect(run('all wat')[0]).toMatch(/Usage:/);
    expect(setTapFilter).not.toHaveBeenCalled();
  });

  it('targeted tap builds a domain/path filter', () => {
    const r = run('anthropic\\.com /v1/messages');
    const [domainRe, pathRe] = createTapFilter.mock.calls[0] as [RegExp, RegExp];
    expect(domainRe.source).toBe('anthropic\\.com');
    expect(pathRe.source).toBe('\\/v1\\/messages');
    expect(setTapFilter).toHaveBeenCalledWith(TAP_FILTER);
    expect(r[0]).toContain('domain: anthropic\\.com');
  });

  it('targeted tap reports invalid regex', () => {
    const r = run('good (unclosed');
    expect(r[0]).toMatch(/Invalid regex/);
    expect(setTapFilter).not.toHaveBeenCalled();
  });

  it('single token shows usage', () => {
    expect(run('onlyone')[0]).toMatch(/Usage:/);
  });
});
