/**
 * Container contribution — the shape (env + mounts) a provider adds to its
 * spawn, assembled from a set of small contributor calls.
 *
 * WHY this shape: capability layers (mitm-proxy's credential substitutes,
 * runtime-updater's CLI-version mount, …) each contribute env/mounts for the
 * same provider. Rather than rewriting one shared body, each layer is a pure
 * `ContainerContributor` and the provider's `containerContribution` merges a
 * list of their calls — a layer adds one call line. Both the input
 * (`ContainerContributionCtx`) and output (`ContainerContributionResult`) are
 * plain objects, so a layer that needs a new input field or emits a new output
 * field adds a field; it does not change a signature or rewrite a return.
 */
import type { VolumeMount } from '../../../providers/provider-container-registry.js';
import type { GroupScope } from '../types.js';

/**
 * Everything a contributor might read, carried as one object so new layers can
 * read new fields additively. The resolver builds this once per spawn.
 */
export interface ContainerContributionCtx {
  agentGroupId: string;
  /** The group's runtime scope — keys substitute minting in the token engine. */
  groupScope: GroupScope;
  sessionDir: string;
  hostEnv: NodeJS.ProcessEnv;
  /** Provider's parsed per-group runtime config (from `AgentRuntimeExt.parseRuntimeConfig`). */
  runtimeConfig: unknown;
  /**
   * Raw provider identity `provider[:version]` (the `session.agent_provider`
   * override), for a version-aware contributor to parse its own selection.
   * The base layer never reads it; runtime-updater's contributor does.
   */
  agentProvider: string | null | undefined;
  /** Group-configured CLI version (`ContainerConfig.providerVersion`), same purpose. */
  providerVersion: string | undefined;
}

/**
 * A contributor's slice. `env`/`mounts` fold into the spawn; `cliVersion` is
 * metadata the resolver surfaces as `ProviderResult.cliVersion` (in-use
 * bookkeeping) — null/omitted = image-baked.
 */
export interface ContainerContributionResult {
  env?: Record<string, string>;
  mounts?: VolumeMount[];
  cliVersion?: string | null;
}

/** Pure producer of an additive slice. Object in, object out. */
export type ContainerContributor = (ctx: ContainerContributionCtx) => ContainerContributionResult;

/**
 * Field-union merge of a set of contributor results — same type in and out:
 * `env` keys merge (later call wins on a clash), `mounts` concatenate in order,
 * `cliVersion` takes the first non-null reported. The resolver splits the
 * spawn-facing `env`/`mounts` from the host-only `cliVersion` when it builds
 * `ProviderResult`.
 */
export function mergeContributions(parts: readonly ContainerContributionResult[]): ContainerContributionResult {
  const env: Record<string, string> = {};
  const mounts: VolumeMount[] = [];
  let cliVersion: string | null = null;
  for (const p of parts) {
    if (p.env) Object.assign(env, p.env);
    if (p.mounts) mounts.push(...p.mounts);
    if (cliVersion === null && p.cliVersion != null) cliVersion = p.cliVersion;
  }
  const result: ContainerContributionResult = {};
  if (Object.keys(env).length) result.env = env;
  if (mounts.length) result.mounts = mounts;
  if (cliVersion !== null) result.cliVersion = cliVersion;
  return result;
}
