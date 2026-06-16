/**
 * Claude credential provider — baseline (credentials layer).
 *
 * Founds the claude credential-provider registration plus a **non-mitm**
 * AGENT_RUNTIME runtime contribution: a custom Anthropic-compatible endpoint is
 * wired via env (`ANTHROPIC_BASE_URL` + a placeholder bearer that the credential
 * proxy rewrites on the wire); the standard api.anthropic.com path needs nothing
 * here.
 *
 * Capability layers MODIFY this file in place (the single `registerCredentialProvider`
 * call stays put; siblings only edit the extension bag + impls, composed at the
 * `everything` merge):
 *   - mitm-proxy: replaces `containerContribution` with token-engine substitutes;
 *     adds ACQUIRE / REAUTH / CONTAINER_FEEDBACK + the `substitutes` spec.
 *   - runtime-updater: adds the RUNTIME_UPDATER extension + the CLI version-mount.
 */
import {
  registerCredentialProvider,
  defaultManifestBuilder,
  noManifestSideEffect,
  ExtensionBag,
  AGENT_RUNTIME,
  type AgentRuntimeExt,
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

const agentRuntime: AgentRuntimeExt = {
  containerContribution: () => {
    const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
    const env: Record<string, string> = {};
    if (dotenv.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
      env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
    }
    return { env };
  },
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
