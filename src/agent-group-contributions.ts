/**
 * Per-agent-group dynamic container-config registry.
 *
 * Modules that need to inject `{ env, mounts }` into a container spawn at
 * agent-group granularity register a callback here. The container-runner
 * invokes every registered callback at spawn time and merges the results
 * into the spawn args alongside the static `container.json` mounts, the
 * channel-adapter contribution, and the provider contribution.
 *
 * Three existing hooks cover other granularities:
 *
 *   - `ChannelRegistration.containerConfig`            per-channel-adapter
 *   - `ProviderContainerContribution`                  per-provider-type
 *   - `readContainerConfig(folder)` (static file)      per-agent-group, static
 *
 * This registry fills the gap: per-agent-group, but resolved dynamically
 * at spawn time (e.g. a proxy URL only known after a host service starts,
 * a host path derived from `agentGroup.folder`).
 *
 * Callbacks are synchronous. They may read module-level state but must not
 * perform I/O. A callback that throws aborts the spawn — the registry
 * wraps the thrown value in `FatalSpawnError` annotated with the
 * contributing id and re-throws, so wakeContainer's catch path classifies
 * it as non-retryable and the router surfaces the error to the user.
 */

import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import { FatalSpawnError } from './spawn-failure.js';
import type { AgentGroup, Session } from './types.js';

export interface AgentGroupContributionContext {
  agentGroup: AgentGroup;
  session: Session;
  hostEnv: NodeJS.ProcessEnv;
}

export interface AgentGroupContribution {
  env?: Record<string, string>;
  mounts?: VolumeMount[];
}

export type AgentGroupContributionFn = (ctx: AgentGroupContributionContext) => AgentGroupContribution;

interface Entry {
  id: string;
  fn: AgentGroupContributionFn;
}

const registry: Entry[] = [];

/**
 * Register a contribution callback. Throws if `id` is already registered —
 * mirrors `registerProviderContainerConfig`. Registration order is
 * preserved and observable: callbacks run in the order they were
 * registered, and env-key collisions resolve last-write-wins.
 */
export function registerAgentGroupContribution(id: string, fn: AgentGroupContributionFn): void {
  if (registry.some((e) => e.id === id)) {
    throw new Error(`Agent-group contribution already registered: ${id}`);
  }
  registry.push({ id, fn });
}

/** Test-only: empty the registry. */
export function clearAgentGroupContributions(): void {
  registry.length = 0;
}

/**
 * Run all registered callbacks in registration order, concatenate their
 * mounts, and merge their env with last-write-wins (collisions logged
 * via `log.warn`). Throws `FatalSpawnError` annotated with the
 * contributing id when any callback throws.
 */
export function invokeAgentGroupContributions(ctx: AgentGroupContributionContext): AgentGroupContribution {
  const env: Record<string, string> = {};
  const mounts: VolumeMount[] = [];
  const envOrigin = new Map<string, string>();

  for (const entry of registry) {
    let contribution: AgentGroupContribution;
    try {
      contribution = entry.fn(ctx);
    } catch (err) {
      throw new FatalSpawnError(
        `Agent-group contribution "${entry.id}" failed: ${(err as Error).message ?? String(err)}`,
        { cause: err },
      );
    }
    if (contribution.mounts && contribution.mounts.length > 0) {
      mounts.push(...contribution.mounts);
    }
    if (contribution.env) {
      for (const [key, value] of Object.entries(contribution.env)) {
        const prior = envOrigin.get(key);
        if (prior !== undefined && env[key] !== value) {
          log.warn('Agent-group contribution env key collision (last-write-wins)', {
            key,
            priorId: prior,
            priorValue: env[key],
            newId: entry.id,
            newValue: value,
          });
        }
        env[key] = value;
        envOrigin.set(key, entry.id);
      }
    }
  }

  return { env, mounts };
}
