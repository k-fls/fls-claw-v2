/**
 * Claude credential provider — runtime-updater layer.
 *
 * Baseline (credentials) founds the registration + a non-mitm env contribution
 * (`baseUrlContributor`). runtime-updater adds the CLI version system as an
 * ADDITIVE contributor (`runtimeCliMount`) plus the RUNTIME_UPDATER extension —
 * it does NOT rewrite the base body. mitm-proxy separately adds its own
 * credential-substitute contributor + extensions. Each layer is one extra call
 * in the `containerContribution` merge, so sibling branches compose cleanly.
 *
 * `mergeContributions` folds the calls: env keys union (later wins), mounts
 * concatenate, first non-null cliVersion wins.
 */
import fs from 'fs';
import path from 'path';

import {
  registerCredentialProvider,
  mergeContributions,
  defaultManifestBuilder,
  noManifestSideEffect,
  ExtensionBag,
  AGENT_RUNTIME,
  RUNTIME_UPDATER,
  type AgentRuntimeExt,
  type ContainerContributor,
  type CredentialProvider,
} from '../modules/credentials/index.js';
import { RuntimeCliUpdater, resolveSelectedVersion } from '../modules/runtime-updater/index.js';
import { parseProviderSpec } from '../container-config.js';
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

const claudeRuntimeUpdater = new RuntimeCliUpdater({
  providerId: PROVIDER_ID,
  label: 'Claude Code',
  packageName: '@anthropic-ai/claude-code',
});

const CLI_MOUNT_DIR = '/opt/runtime-cli/claude';
const CLI_ENTRY = `${CLI_MOUNT_DIR}/node_modules/.bin/claude`;
const CLI_BAKED_PATH = '/pnpm/claude';

/**
 * runtime-updater container contribution: mount the selected CLI version. The
 * selection rides the provider identity's `:version` suffix (session override
 * replaces the group's wholesale), so it's derived here from `ctx.agentProvider`
 * / `ctx.providerVersion`. Empty slice when no version is active (default /
 * 'latest' with nothing fetched). When active, adds two RO mounts — the package
 * dir at CLI_MOUNT_DIR and a wrapper over /pnpm/claude that execs the mounted bin
 * shim, so the updated binary is the single source of truth for both the SDK and
 * any direct caller — and reports the concrete `cliVersion` so the caller can
 * record this spawn as holding it (deletion safety).
 */
const runtimeCliMount: ContainerContributor = (ctx) => {
  const selection = ctx.agentProvider ? parseProviderSpec(ctx.agentProvider).version : ctx.providerVersion;
  const version = resolveSelectedVersion(claudeRuntimeUpdater, selection);
  const dir = version ? claudeRuntimeUpdater.installedDir(version) : null;
  if (!version || !dir) return {};

  const wrapperPath = path.join(ctx.sessionDir, '.claude-cli', 'claude');
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec ${CLI_ENTRY} "$@"\n`, { mode: 0o755 });

  return {
    mounts: [
      { hostPath: dir, containerPath: CLI_MOUNT_DIR, readonly: true },
      { hostPath: wrapperPath, containerPath: CLI_BAKED_PATH, readonly: true },
    ],
    cliVersion: version,
  };
};

const agentRuntime: AgentRuntimeExt = {
  // Merge the set of contributor calls into the container shape. A capability
  // layer adds one call to this list (it does not rewrite the body); object in,
  // object out, so contributors compose without colliding.
  containerContribution: (ctx) =>
    mergeContributions([
      baseUrlContributor(ctx),
      runtimeCliMount(ctx),
      // mitm-proxy adds: credentialSubstitutes(ctx),
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
  const ext = new ExtensionBag().set(AGENT_RUNTIME, agentRuntime).set(RUNTIME_UPDATER, claudeRuntimeUpdater);
  const provider: CredentialProvider = {
    id: PROVIDER_ID,
    buildManifest: defaultManifestBuilder(PROVIDER_ID),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
    getExtension: ext.get,
  };
  registerCredentialProvider(provider);
}
