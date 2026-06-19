/**
 * Claude credential provider — baseline (credentials layer).
 *
 * Founds the claude credential-provider registration plus a **non-mitm**
 * container contribution: a custom Anthropic-compatible endpoint is wired via
 * env (`ANTHROPIC_BASE_URL` + a placeholder bearer that the credential proxy
 * rewrites on the wire); the standard api.anthropic.com path needs nothing here.
 *
 * Capability layers EXTEND this provider ADDITIVELY — they do not rewrite the
 * bodies here. Each is a pure `ContainerContributor` added as one call to the
 * `containerContribution` merge, plus its own extension, so sibling branches
 * merge cleanly:
 *   - mitm-proxy: a contributor minting token-engine substitutes; +
 *     `ext.set(ACQUIRE/REAUTH/CONTAINER_FEEDBACK, …)` + the `substitutes` spec.
 *   - runtime-updater: a contributor mounting the selected CLI version (reads
 *     `ctx.agentProvider` / `ctx.providerVersion`, reports the concrete
 *     `cliVersion`); + `ext.set(RUNTIME_UPDATER, …)`.
 * `mergeContributions` folds the calls: env keys union (later wins), mounts
 * concatenate, first non-null cliVersion wins.
 */
import {
  registerCredentialProvider,
  mergeContributions,
  defaultManifestBuilder,
  noManifestSideEffect,
  ExtensionBag,
  AGENT_RUNTIME,
  type AgentRuntimeExt,
  type ContainerContributor,
  type CredentialProvider,
} from '../modules/credentials/index.js';
import { readEnvFile } from '../env.js';

const PROVIDER_ID = 'claude';

/** Anthropic-owned endpoint suffixes — a Claude credential is only needed here. */
const ANTHROPIC_ENDPOINT_SUFFIXES = ['anthropic.com', 'claude.com'];

/**
 * The base URL the claude runtime actually points at: an explicit per-group
 * `runtimeConfig.baseUrl` wins, then the host `.env` `ANTHROPIC_BASE_URL`, then
 * the api.anthropic.com default.
 */
function resolveAnthropicBaseUrl(sources: { runtimeConfig?: unknown }): string {
  return (
    (sources.runtimeConfig as { baseUrl?: string } | undefined)?.baseUrl ??
    readEnvFile(['ANTHROPIC_BASE_URL']).ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  );
}

/**
 * Is `base` an Anthropic-owned endpoint? A custom host — e.g. a local Ollama
 * gateway repointed via `ANTHROPIC_BASE_URL` — authenticates differently (or not
 * at all), so requiring a Claude credential there would false-gate the spawn
 * ("sign in to Claude" on a group that never talks to Claude). Unparseable →
 * treat as Anthropic (keep requiring) so a typo never silently drops the gate.
 */
function isAnthropicEndpoint(base: string): boolean {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `https://${base}`);
    return ANTHROPIC_ENDPOINT_SUFFIXES.some((s) => url.hostname === s || url.hostname.endsWith('.' + s));
  } catch {
    return true;
  }
}

/**
 * Baseline container contribution: wire a custom Anthropic-compatible endpoint
 * via env (`ANTHROPIC_BASE_URL` + a placeholder bearer the proxy rewrites on the
 * wire); the standard api.anthropic.com path contributes nothing here.
 */
const baseUrlContributor: ContainerContributor = () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  return { env };
};

const agentRuntime: AgentRuntimeExt = {
  // Merge the set of contributor calls into the container shape. A capability
  // layer adds one call to this list (it does not rewrite the body); object in,
  // object out, so contributors compose without colliding.
  containerContribution: (ctx) =>
    mergeContributions([
      baseUrlContributor(ctx),
      // mitm-proxy adds:      credentialSubstitutes(ctx),
      // runtime-updater adds: runtimeCliMount(ctx),
    ]),
  // Claude is only required when the runtime actually talks to Anthropic. A
  // group repointed at a custom endpoint (e.g. Ollama via ANTHROPIC_BASE_URL)
  // needs no Claude credential — requiring one false-gates the spawn.
  requiredCredentialProviders: (runtimeConfig) => [
    { id: PROVIDER_ID, required: isAnthropicEndpoint(resolveAnthropicBaseUrl({ runtimeConfig })) },
  ],
  // Preserve `baseUrl` so requiredCredentialProviders (which only receives the
  // parsed config) can see a per-group endpoint override.
  parseRuntimeConfig: (raw) => {
    const r = (raw ?? {}) as { baseUrl?: unknown };
    return typeof r.baseUrl === 'string' ? { baseUrl: r.baseUrl } : {};
  },
};

export function registerClaudeCredentialProvider(): void {
  const ext = new ExtensionBag().set(AGENT_RUNTIME, agentRuntime);
  const provider: CredentialProvider = {
    id: PROVIDER_ID,
    buildManifest: defaultManifestBuilder(PROVIDER_ID),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
    getExtension: ext.get,
  };
  registerCredentialProvider(provider);
}
