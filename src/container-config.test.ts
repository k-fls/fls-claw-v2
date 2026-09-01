/**
 * `configFromDb` is the first thing on the spawn path to read the stored
 * `mcp_servers` and `skills` columns — before the composer's own read. A throw
 * here rides `wakeContainer`'s transient-retry contract, so host-sweep re-wakes
 * the session every 60s forever and the group goes silently dark.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { configFromDb, sanitizeStoredMcpServers, validateMcpServerName } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

beforeEach(() => {
  vi.clearAllMocks();
});

const group = { id: 'ag-1', name: 'grp', folder: 'grp' } as AgentGroup;

function row(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('configFromDb corrupt column tolerance', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['a JSON string', '"nonsense"'],
    ['a list', '[1,2]'],
    ['null', 'null'],
  ])('degrades to no MCP servers when mcp_servers is %s', (_label, stored) => {
    expect(configFromDb(row({ mcp_servers: stored }), group).mcpServers).toEqual({});
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a number', '7'],
    ['an object', '{"welcome":true}'],
    ['null', 'null'],
  ])('widens to every skill when skills is %s', (_label, stored) => {
    expect(configFromDb(row({ skills: stored }), group).skills).toBe('all');
  });

  it('still reads a well-formed row unchanged', () => {
    const config = configFromDb(
      row({ skills: '["welcome"]', mcp_servers: '{"tooling":{"command":"x","args":["--y"]}}' }),
      group,
    );

    expect(config.skills).toEqual(['welcome']);
    expect(config.mcpServers).toEqual({ tooling: { command: 'x', args: ['--y'] } });
  });

  // Assigning servers["__proto__"] sets the record's prototype rather than an
  // own key, so the entry vanishes instead of being stored.
  it('drops a stored server named __proto__', () => {
    const config = configFromDb(row({ mcp_servers: '{"__proto__":{"command":"x"}}' }), group);

    expect(Object.keys(config.mcpServers)).toEqual([]);
  });
});

describe('sanitizeStoredMcpServers input shapes', () => {
  // A group with no container_configs row is ordinary, not corrupt, so it must
  // not log a warning.
  it('is silent for an absent column', () => {
    expect(sanitizeStoredMcpServers({}, 'grp')).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns once for a genuinely corrupt column', () => {
    expect(sanitizeStoredMcpServers('{not json', 'grp')).toEqual({});
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'), { group: 'grp' });
  });
});

describe('validateMcpServerName', () => {
  it('accepts an ordinary name', () => {
    expect(() => validateMcpServerName('tooling-1_x')).not.toThrow();
  });

  it.each(['__proto__', 'has space', 'has/slash', '', 'x'.repeat(65)])('rejects %j', (name) => {
    expect(() => validateMcpServerName(name)).toThrow();
  });
});
