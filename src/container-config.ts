/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  /**
   * Selected agent-runtime CLI version, parsed from the `provider` identity
   * string's `:version` suffix (e.g. `claude:2.1.154` → `2.1.154`). Undefined
   * for a bare provider. The runtime-updater resolves it to a host-installed
   * CLI mount at spawn. Shared config field (the resolver builds the
   * ContributionInput from it); updater reads it.
   */
  providerVersion?: string;
  /**
   * Per-group agent-runtime configuration — an opaque-to-the-framework config
   * dict (hence `unknown` values). The runtime's `AGENT_RUNTIME` extension
   * validates it via `parseRuntimeConfig`; the framework only stores/forwards.
   */
  runtimeConfig?: Record<string, unknown>;
}

const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws unless `name` is a safe MCP server name (1-64 chars of [A-Za-z0-9_-]). */
export function validateMcpServerName(name: string): void {
  // "__proto__" passes the regex but assigning servers["__proto__"] sets the
  // record's prototype instead of an own key — the server would be silently
  // dropped (or worse) on every intake path, so reject it by name.
  if (!MCP_SERVER_NAME_RE.test(name) || name === '__proto__') {
    throw new Error('server name must be 1-64 characters of letters, digits, "_" or "-"');
  }
}

function parseStoredMcpServer(input: Record<string, unknown>): McpServerConfig {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  if (!command) throw new Error('server must declare a non-empty "command"');

  const server: McpServerConfig = { command };

  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === 'string')) {
      throw new Error('"args" must be a list of strings');
    }
    server.args = input.args as string[];
  }

  if (input.env !== undefined) {
    const env = input.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new Error('"env" must be an object');
    if (!Object.values(env).every((v) => typeof v === 'string')) throw new Error('"env" values must be strings');
    server.env = env as Record<string, string>;
  }

  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string') throw new Error('"instructions" must be a string');
    server.instructions = input.instructions;
  }

  return server;
}

/**
 * The single reading of the stored `mcp_servers` column: parse and re-validate.
 * Invalid entries are dropped and logged rather than shipped to the container,
 * and malformed JSON degrades to no servers. A bare parse here would throw on
 * every spawn instead, and `wakeContainer`'s retry contract turns that into a
 * silently dark group.
 *
 * Accepts the raw column string, or an already-parsed value.
 */
export function sanitizeStoredMcpServers(raw: unknown, groupName: string): Record<string, McpServerConfig> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      log.warn('Stored mcp_servers is not valid JSON; ignoring all entries', { group: groupName });
      return {};
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('Stored mcp_servers is not an object; ignoring all entries', { group: groupName });
    return {};
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      log.warn('Dropping invalid stored MCP server', { group: groupName, server: name, reason: 'not an object' });
      continue;
    }
    try {
      validateMcpServerName(name);
      servers[name] = parseStoredMcpServer(entry as Record<string, unknown>);
      // eslint-disable-next-line no-catch-all/no-catch-all -- validation failures are data errors, not bugs
    } catch (err) {
      log.warn('Dropping invalid stored MCP server', {
        group: groupName,
        server: name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return servers;
}

/**
 * `'all'`, or the names the group selected. Anything else is treated as `'all'`:
 * a bare string would otherwise turn an `includes` filter into a substring
 * match and silently drop skills.
 *
 * The single reading of this column. A bare cast throws on a corrupt row before
 * the composer's tolerance can apply: every spawn fails, and `wakeContainer`'s
 * retry contract darkens the group.
 */
export function parseSkillSelection(raw: string | undefined, groupName: string): string[] | 'all' {
  if (raw === undefined) return 'all';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === 'all') return 'all';
  if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'string')) return parsed;
  log.warn('Stored skill selection is not "all" or a string list; inlining every skill', { group: groupName });
  return 'all';
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: sanitizeStoredMcpServers(row.mcp_servers, group.name),
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: parseSkillSelection(row.skills, group.name),
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}

/**
 * Resolve the effective provider name (lowercased), session override winning
 * over the group config, default `claude`. Lives here (not container-runner) so
 * credential-layer consumers can use it without importing the spawner.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}
