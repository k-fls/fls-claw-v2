/**
 * The Claude provider entity — one registration carrying every facet:
 *   - credential namespace (manifest hooks),
 *   - substitution (`substitutes`): mints format-preserving placeholders for
 *     the group's stored token and swaps them back on the wire
 *     (`api.anthropic.com` bearer-swap, `platform.claude.com` token-exchange),
 *   - AGENT_RUNTIME (arms the spawn-time validator),
 *   - ACQUIRE (interactive GPG-encrypted credential request at wake time),
 *   - CONTAINER_FEEDBACK (routes container auth errors to reauth),
 *   - REAUTH (mid-session interactive re-authentication).
 *
 * Registered at host boot (this branch runs the MITM proxy as the credential
 * path). Requires the token engine to be initialized first (the substitution
 * facet is built from the token engine). Claude is NOT a discovery-JSON
 * provider — it's this single merged entity, so `initOAuthModule` never dups it.
 *
 * Capability layers EXTEND the container shape ADDITIVELY — each is a pure
 * `ContainerContributor` added as one call to the `containerContribution`
 * merge, never a rewrite of another's body, so sibling branches compose:
 *   - baseline: `baseUrlContributor` (custom Anthropic-compatible endpoint env).
 *   - mitm-proxy: `credentialSubstitutes` minting token-engine substitutes.
 *   - runtime-updater: a contributor mounting the selected CLI version.
 * `mergeContributions` folds the calls: env keys union (later wins), mounts
 * concatenate, first non-null cliVersion wins.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import {
  registerCredentialProvider,
  mergeContributions,
  getOrCreateResolverForAgentGroup,
  asCredentialScope,
  defaultManifestBuilder,
  noManifestSideEffect,
  ExtensionBag,
  AGENT_RUNTIME,
  CONTAINER_FEEDBACK,
  REAUTH,
  ensureGpgKey,
  gpgHomeForScope,
  buildPgpEncryptUrl,
  startAuthEpisode,
  type AgentRuntimeExt,
  type ContainerContributor,
  type ContainerFeedbackExt,
  type CredentialScope,
  type ReauthContext,
  type ReauthExt,
} from '../modules/credentials/index.js';
import { pastePgpOn, pickOptionOn } from '../modules/interactions/index.js';
import { readEnvFile } from '../env.js';
import { spawnAuthContainer, type AuthMode } from '../auth-container.js';
import { asContainerScope } from '../modules/container-bootstrap/index.js';
import { log } from '../log.js';
import type { InteractionOrigin } from '../host-interactions.js';
import { ACQUIRE, type AcquireExt, type AcquireContext } from '../credential-acquisition.js';
import {
  oauthSubstitutesFor,
  getTokenEngine,
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
  type OAuthProvider,
  type SubstitutingProvider,
} from '../modules/mitm-proxy/index.js';

const PROVIDER_ID = 'claude';

/** Anthropic-owned endpoint suffixes — a Claude credential is only needed here. */
const ANTHROPIC_ENDPOINT_SUFFIXES = ['anthropic.com', 'claude.com'];

/**
 * The base URL the claude runtime actually points at: an explicit per-group
 * `env.ANTHROPIC_BASE_URL` wins, then `runtimeConfig.baseUrl`, then the host
 * `.env` `ANTHROPIC_BASE_URL`, then the api.anthropic.com default. (Same
 * precedence the runtime contribution and tap-exclusion use.)
 */
function resolveAnthropicBaseUrl(sources: { env?: Record<string, string>; runtimeConfig?: unknown }): string {
  return (
    sources.env?.ANTHROPIC_BASE_URL ??
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

/** Anthropic API keys look like `sk-ant-api…`. */
const API_KEY_RE = /^sk-ant-api\S+$/;

/**
 * Claude's substitution + on-the-wire swap rules (ported from v1). The token
 * engine uses `substituteConfig` to mint a format-preserving placeholder; the
 * proxy swaps it back on these hosts. `envBindings` map each credential path to
 * the container env var the agent reads.
 */
const CLAUDE_OAUTH_PROVIDER: OAuthProvider = {
  id: PROVIDER_ID,
  rules: [
    { anchor: 'platform.claude.com', pathPattern: /^\/v1\/oauth\/token$/, mode: 'token-exchange' },
    { anchor: 'api.anthropic.com', pathPattern: /^\//, mode: 'bearer-swap' },
    { anchor: 'platform.claude.com', pathPattern: /^\//, mode: 'bearer-swap' },
  ],
  scopeKeys: [],
  substituteConfig: { prefixLen: 14, suffixLen: 0, delimiters: '-_' },
  refreshStrategy: 'redirect',
  envBindings: [
    { envName: 'CLAUDE_CODE_OAUTH_TOKEN', credentialPath: 'oauth' },
    { envName: 'ANTHROPIC_API_KEY', credentialPath: 'api_key' },
  ],
  tokenFieldCapture: { scopeInclude: ['user:file_upload'] },
};

/**
 * mitm-proxy container contribution: mint a format-preserving substitute for the
 * group's stored credential and hand it to the container as env (+ a
 * `.credentials.json` mount for OAuth). The proxy swaps the substitute back to
 * the real token on the wire, so the real credential never enters the container.
 * Empty slice when no credential is bound yet — the wake-time gate / validator
 * handles that.
 */
const credentialSubstitutes: ContainerContributor = (ctx) => {
  const engine = getTokenEngine();
  const { groupScope } = ctx;

  // api-key mode.
  const subApiKey = engine.getOrCreateSubstitute(PROVIDER_ID, {}, groupScope, 'api_key', ['ANTHROPIC_API_KEY']);
  if (subApiKey) {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: subApiKey };
    return { env };
  }

  // OAuth mode: substitute access token in env + a `.credentials.json` mount
  // carrying substitute tokens + the real expiry (the SDK reads it).
  const subAccess = engine.getOrCreateSubstitute(PROVIDER_ID, {}, groupScope, CRED_OAUTH, ['CLAUDE_CODE_OAUTH_TOKEN']);
  if (!subAccess) return {}; // no credential bound yet — the wake-time gate / validator handles that
  const subRefresh = engine.getOrCreateSubstitute(PROVIDER_ID, {}, groupScope, CRED_OAUTH_REFRESH);

  // resolveCredential maps groupScope → its credential scope internally.
  const real = engine.resolveCredential(groupScope, PROVIDER_ID, CRED_OAUTH);
  const expiresAt = real?.expires_ts ?? 0;
  const credsHostPath = path.join(ctx.sessionDir, '.claude-creds', '.credentials.json');
  fs.mkdirSync(path.dirname(credsHostPath), { recursive: true });
  fs.writeFileSync(
    credsHostPath,
    JSON.stringify({ claudeAiOauth: { accessToken: subAccess, refreshToken: subRefresh ?? subAccess, expiresAt } }),
  );
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: subAccess };
  return {
    env,
    mounts: [{ hostPath: credsHostPath, containerPath: '/home/node/.claude/.credentials.json', readonly: false }],
  };
};

const agentRuntime: AgentRuntimeExt = {
  // Merge the set of contributor calls into the container shape. A capability
  // layer adds one call to this list (it does not rewrite the body); object in,
  // object out, so contributors compose without colliding. (env keys are
  // disjoint: base-url wiring vs. credential substitutes.)
  containerContribution: (ctx) =>
    mergeContributions([
      baseUrlContributor(ctx),
      credentialSubstitutes(ctx),
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
  // The agent's model traffic goes to ANTHROPIC_BASE_URL (default
  // api.anthropic.com), which a group may repoint at e.g. an Ollama host. Tap
  // exclusion is host-based, so report that host.
  defaultTapExcludeHosts: (cfg) => {
    try {
      const base = resolveAnthropicBaseUrl(cfg);
      // Tolerate a host[:port] with no scheme (e.g. host.docker.internal:11434).
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `https://${base}`);
      return url.hostname ? [url.hostname] : [];
    } catch {
      return [];
    }
  },
};

/**
 * Shared GPG-encrypted api-key paste flow — used by both ACQUIRE (wake-time,
 * no credential yet) and REAUTH (mid-session, credential rejected).
 *
 * Ensures the group's GPG keypair exists so the user can encrypt the key to
 * it. The API key is pasted **GPG-encrypted** and decrypted host-side — it
 * never travels through chat in cleartext (matches v1's "API key
 * (GPG-encryption required)" flow). `pastePgpOn` rejects anything that
 * isn't a PGP message and decrypts against this scope's private key.
 */
async function runApiKeyPaste(
  origin: InteractionOrigin,
  scope: CredentialScope,
  promptPreamble: string,
  successText: string,
): Promise<boolean> {
  ensureGpgKey(scope);
  const encryptUrl = buildPgpEncryptUrl(scope);

  const r = await pastePgpOn(origin, {
    prompt:
      `${promptPreamble}\n\n` +
      `1. Encrypt it for this group here: ${encryptUrl}\n` +
      '2. Paste the resulting `-----BEGIN PGP MESSAGE-----` block back here.\n\n' +
      'Or reply `cancel`.',
    gpgHome: gpgHomeForScope(scope),
    validate: (plaintext) =>
      API_KEY_RE.test(plaintext.trim())
        ? null
        : 'The decrypted value is not an Anthropic API key (expected `sk-ant-api…`).',
  });

  if (r.reason !== 'submitted' || !r.text) {
    origin.writeReply(
      r.reason === 'cancelled' ? 'Cancelled — no credential stored.' : 'Timed out — no credential stored.',
    );
    return false;
  }

  getOrCreateResolverForAgentGroup(scope).store(scope, PROVIDER_ID, 'api_key', {
    value: r.text.trim(),
    updated_ts: Date.now(),
    expires_ts: 0,
  });
  origin.writeReply(successText);
  return true;
}

/**
 * Browser-auth mode: spawn an auth container that runs the `claude` CLI and
 * bridges its OAuth hand-off to the user over host-rpc (see `auth-bridge.ts` +
 * `auth-container.ts`). The credential is captured host-side by the **MITM
 * proxy** intercepting the CLI's token-exchange (the CLI only ever sees
 * substitutes) — so success is decided by whether an OAuth credential now
 * exists in the store, NOT by anything the container returns.
 *
 * Any existing `claude` credential is cleared up front so the freshly-captured
 * one is unambiguous (and a rejected api_key can't shadow the new oauth — the
 * AGENT_RUNTIME contribution prefers api_key). On success the caller (wake-time
 * gate re-wake, or the reauth dispatcher's group restart) re-spawns so
 * substitutes pick it up.
 */
async function runBrowserAuth(origin: InteractionOrigin, scope: CredentialScope, mode: AuthMode): Promise<boolean> {
  const folder = String(scope);
  const resolver = getOrCreateResolverForAgentGroup(scope);
  // Start clean: drop any prior (rejected) claude credential.
  resolver.delete(scope, PROVIDER_ID);

  const nonce = randomBytes(16).toString('hex');
  const episode = startAuthEpisode({ scopeFolder: folder, nonce, origin });
  try {
    origin.writeReply(
      mode === 'setup_token'
        ? 'Starting Claude setup-token sign-in — launching a secure auth container…'
        : 'Starting Claude sign-in — launching a secure auth container…',
    );
    await spawnAuthContainer({
      scope: asContainerScope(folder),
      folder,
      mode,
      nonce,
      // The `claude` CLI needs a writable home for its config / token-exchange;
      // give it one under the auto-cleaned scratch dir.
      contribute: (scratchDir) => {
        const home = path.join(scratchDir, 'claude');
        fs.mkdirSync(home, { recursive: true });
        return { mounts: [{ hostPath: home, containerPath: '/home/node/.claude', readonly: false }] };
      },
    });

    // The proxy captures the real token during the token-exchange — success is
    // a credential now existing for this scope.
    if (resolver.resolve(scope, PROVIDER_ID, CRED_OAUTH)) {
      origin.writeReply('Claude sign-in complete — credential stored. Retrying your request now.');
      return true;
    }
    origin.writeReply('Sign-in did not complete — no credential stored.');
    return false;
  } catch (err) {
    log.error('Claude browser-auth failed', { folder, mode, err });
    origin.writeReply('Sign-in failed unexpectedly — no credential stored.');
    return false;
  } finally {
    episode.end();
  }
}

interface ClaudeAuthOption {
  label: string;
  run(origin: InteractionOrigin, scope: CredentialScope): Promise<boolean>;
}

/**
 * The Claude auth-mode menu, v1-shaped (fork `providers/claude.ts authOptions`):
 * GPG-encrypted api-key paste plus the two subscription OAuth modes, each
 * driven through the browser-auth container. `reason` is woven into the
 * api-key preamble when re-authenticating after a rejection.
 */
function claudeAuthOptions(reason?: string): ClaudeAuthOption[] {
  const rejected = reason ? ` — your stored credential was rejected (${reason})` : '';
  return [
    {
      label: 'Paste Anthropic API key (GPG-encrypted)',
      run: (origin, scope) =>
        runApiKeyPaste(
          origin,
          scope,
          `I need an Anthropic API key${rejected}, **GPG-encrypted** — never pasted in cleartext.`,
          'Claude API key stored (decrypted host-side). Retrying your request now.',
        ),
    },
    {
      label: 'Sign in with a Claude subscription (setup-token, long-lived)',
      run: (origin, scope) => runBrowserAuth(origin, scope, 'setup_token'),
    },
    {
      label: 'Sign in with a Claude subscription (auth login)',
      run: (origin, scope) => runBrowserAuth(origin, scope, 'auth_login'),
    },
  ];
}

/**
 * Present the auth-mode menu on `origin` and run the chosen mode. Shared by
 * ACQUIRE (wake-time, no credential yet) and REAUTH (mid-session rejection).
 */
async function runAuthMenu(
  origin: InteractionOrigin,
  scope: CredentialScope,
  opts: { intro: string; reason?: string },
): Promise<boolean> {
  const options = claudeAuthOptions(opts.reason);
  const pick = await pickOptionOn(origin, { prompt: opts.intro, options: options.map((o) => o.label) });
  if (pick.reason !== 'submitted' || pick.index == null) {
    origin.writeReply(
      pick.reason === 'cancelled' ? 'Cancelled — no credential stored.' : 'Timed out — no credential stored.',
    );
    return false;
  }
  // pickOptionOn resolves only after its A1a slot is released, so opening the
  // next interaction on the same key here can't conflict.
  return options[pick.index].run(origin, scope);
}

const acquire: AcquireExt = {
  acquire: (ctx: AcquireContext) =>
    runAuthMenu(ctx.origin, ctx.credentialScope, {
      intro: 'I need a Claude credential to continue. How would you like to provide it?',
    }),
};

/**
 * Route container-classified errors: an auth rejection drives the reauth
 * flow; everything else surfaces via the container's own "Error: …" chat
 * line (`'surface'` is the dispatcher's do-nothing default — `'ignore'`
 * would eat a signal users should see).
 */
const containerFeedback: ContainerFeedbackExt = {
  onContainerError: (event) => (event.classification === 'auth-invalid' ? 'reauth' : 'surface'),
};

const reauth: ReauthExt = {
  reauth: (ctx: ReauthContext) =>
    runAuthMenu(ctx.origin, ctx.credentialScope, {
      intro: '*Authentication required for Claude.* How would you like to re-authenticate?',
      reason: ctx.reason,
    }),
};

/**
 * Register the merged Claude provider. Call exactly once at boot, AFTER
 * `initTokenEngine` (the substitution facet is built from the token engine) and
 * BEFORE `proxy.start()` (whose `rebuildIndex` then indexes its swap rules).
 * Duplicate-id registration throws — the registry is the guard.
 */
export function registerClaudeCredentialProvider(): void {
  const ext = new ExtensionBag()
    .set(AGENT_RUNTIME, agentRuntime)
    .set(ACQUIRE, acquire)
    .set(CONTAINER_FEEDBACK, containerFeedback)
    .set(REAUTH, reauth);
  const provider: SubstitutingProvider = {
    id: PROVIDER_ID,
    buildManifest: defaultManifestBuilder(PROVIDER_ID),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
    substitutes: oauthSubstitutesFor(CLAUDE_OAUTH_PROVIDER),
    getExtension: ext.get,
  };
  registerCredentialProvider(provider);
}
