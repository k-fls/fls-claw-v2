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
   * string's `:version` suffix (e.g. `claude:2.1.154` → `2.1.154`,
   * `claude:latest` → `latest`). Undefined for a bare provider (→ default =
   * latest). The runtime resolves it to a host-installed CLI mount at spawn;
   * a group admin sets it via `/agent-runtime select`. See F2.
   */
  providerVersion?: string;
  /**
   * Per-group agent-runtime configuration — a config dict whose
   * per-runtime *shape* is opaque to the framework (hence `unknown` values).
   * Authored like the other per-group settings (provider/model/packages) and,
   * once wired, persisted in `container_configs` + materialized here. The
   * runtime's `AGENT_RUNTIME` extension validates it via `parseRuntimeConfig`;
   * the framework only stores and forwards it. `{}`/`undefined` for `claude`
   * and other runtimes with no per-group choice; e.g. OpenCode would carry
   * `{ providers: ["anthropic", "deepseek"], ... }`. DB persistence lands with
   * the first runtime that needs it; until then this is unset.
   */
  runtimeConfig?: Record<string, unknown>;
}

/** A parsed agent-runtime identity string: provider id + optional CLI version. */
export interface ProviderSpec {
  /** Provider id, lowercased (e.g. 'claude'). */
  id: string;
  /** Selected CLI version (`2.1.154` | `latest`), or undefined for the default. */
  version?: string;
}

/**
 * Parse an agent-runtime identity string `id[:version]` (e.g. `claude:2.1.154`,
 * `claude:latest`, `claude`) into its parts. The id is lowercased; an empty or
 * missing version is dropped (→ default = latest).
 */
export function parseProviderSpec(raw: string): ProviderSpec {
  const idx = raw.indexOf(':');
  if (idx === -1) return { id: raw.toLowerCase() };
  const version = raw.slice(idx + 1).trim();
  const id = raw.slice(0, idx).toLowerCase();
  return version ? { id, version } : { id };
}

/**
 * Resolve the provider id + version for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * The winning identity string defines BOTH id and `:version` (a session
 * override replaces the group's selection wholesale). Pure so the precedence
 * can be unit-tested without a DB or filesystem.
 */
export function resolveProviderSpec(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): ProviderSpec {
  return parseProviderSpec(sessionProvider || containerConfigProvider || 'claude');
}

/**
 * Resolve just the provider id (version suffix stripped). Lives here (not in
 * container-runner) so callers that only need the name — e.g. the wake-time
 * credential gate — don't pull in the container-spawn module.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return resolveProviderSpec(sessionProvider, containerConfigProvider).id;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  // `provider` may carry a `:version` suffix (e.g. `claude:2.1.154`). Split it:
  // the bare id stays in `provider` (container.json / container-side / id
  // lookups expect the id), the version surfaces separately.
  const spec = row.provider ? parseProviderSpec(row.provider) : undefined;
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: spec?.id,
    providerVersion: spec?.version,
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
