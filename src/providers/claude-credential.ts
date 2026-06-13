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
  requiredCredentialProviders: () => [{ id: PROVIDER_ID, required: true }],
  parseRuntimeConfig: () => ({}),
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
