/**
 * The Codex provider entity — programmatic (not a discovery JSON), registered
 * at host boot beside Claude and GitHub.
 *
 * Codex takes no credential from env: the CLI reads `~/.codex/auth.json`, and
 * the agent-provider payload deliberately strips `OPENAI_API_KEY` from the
 * codex process env. So `envBindings` is empty and the credential reaches the
 * container as a file — written here, filled with substitutes, at every spawn.
 *
 * The payload (`src/providers/codex.ts`) already creates
 * `<DATA_DIR>/v2-sessions/<agentGroupId>/.codex-shared/` and mounts it at
 * `/home/node/.codex`, so this contributor writes the file and returns NO
 * mount. `CODEX_AUTH_FILE_SUBPATH` and the payload's mount must agree; the
 * test pins that agreement.
 *
 * Substitute shapes are format-preserving against a real `auth.json`: all
 * three token fields are JWTs and `account_id` is a UUID. `id_token` is built
 * here rather than minted through the token engine — the engine keys a
 * substitute by (scope, provider, credentialPath) and offers no way to bind a
 * caller-supplied value, and the account claim inside `id_token` has to be the
 * same string as `tokens.account_id`. Building it locally makes that equality
 * hold by construction. Nothing sends `id_token` upstream on the subscription
 * path (it is the subject token of the API-key exchange, which this provider
 * does not offer), and if anything ever does, the proxy forwards a substitute
 * that does not authenticate — it fails closed.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';

import { DATA_DIR } from '../config.js';
import {
  registerCredentialProvider,
  mergeContributions,
  defaultManifestBuilder,
  noManifestSideEffect,
  ExtensionBag,
  AGENT_RUNTIME,
  type AgentRuntimeExt,
  type ContainerContributor,
} from '../modules/credentials/index.js';
import {
  oauthSubstitutesFor,
  getTokenEngine,
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
  type OAuthProvider,
  type SubstitutingProvider,
} from '../modules/mitm-proxy/index.js';

const PROVIDER_ID = 'codex';

/** Credential path for the ChatGPT account identifier (`tokens.account_id`). */
export const CRED_ACCOUNT_ID = 'account_id';

const AUTH_HOST = 'auth.openai.com';
const CHATGPT_HOST = 'chatgpt.com';
const API_HOST = 'api.openai.com';

/** Namespace the Codex id_token nests its ChatGPT claims under. */
const CLAIM_NAMESPACE = 'https://api.openai.com/auth';

/**
 * Where the payload mounts the group's Codex state, relative to `DATA_DIR`.
 * Mirrors the payload's own construction; a payload refresh that moves it must
 * fail loudly here rather than land the file where nothing reads it.
 */
export function codexAuthFilePath(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.codex-shared', 'auth.json');
}

/**
 * Codex's substitution + on-the-wire swap rules. One anchor per host with every
 * path rule for that host under it: the index resolves the most specific anchor
 * and does not fall through, so a host's rules cannot be split across anchors.
 */
export const CODEX_OAUTH_PROVIDER: OAuthProvider = {
  id: PROVIDER_ID,
  rules: [
    { anchor: AUTH_HOST, pathPattern: /^\/deviceauth\/usercode$/, mode: 'device-code' },
    { anchor: AUTH_HOST, pathPattern: /^\/deviceauth\/token$/, mode: 'token-exchange' },
    { anchor: AUTH_HOST, pathPattern: /^\/oauth\/token$/, mode: 'token-exchange' },
    { anchor: AUTH_HOST, pathPattern: /^\/api\/accounts\/v1\//, mode: 'bearer-swap' },
    { anchor: CHATGPT_HOST, pathPattern: /^\/backend-api\//, mode: 'bearer-swap' },
    { anchor: API_HOST, pathPattern: /^\/v1\//, mode: 'bearer-swap' },
  ],
  scopeKeys: [],
  substituteConfig: { prefixLen: 0, suffixLen: 0, delimiters: '.-_' },
  refreshStrategy: 'redirect',
  // Codex reads auth.json; the payload strips OPENAI_API_KEY from the CLI env.
  envBindings: [],
};

function b64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

/** A JWT in shape only: three base64url segments, arbitrary signature. */
function jwtShaped(payload: Record<string, unknown>, signatureBytes = 64): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${randomBytes(signatureBytes).toString('base64url')}`;
}

/**
 * Substitute shapes, overriding the OAuth-derived spec's generator. Real
 * `auth.json` values: `id_token` / `access_token` / `refresh_token` are JWTs,
 * `account_id` is a UUID. A substitute that does not preserve the shape gets
 * rejected by the CLI's own local parsing before any request goes out.
 */
function codexSubstitutes(): SubstitutingProvider['substitutes'] {
  const base = oauthSubstitutesFor(CODEX_OAUTH_PROVIDER);
  return {
    ...base,
    generateSubstitute(realValue: string, credentialPath: string): string | null {
      if (credentialPath === CRED_ACCOUNT_ID) return randomUUID();
      // Returning a JWT for a value that is not one would not preserve the
      // format the CLI parses, so decline instead — the caller treats a null
      // substitute as "no credential" rather than shipping a broken one.
      if (realValue.split('.').length !== 3) return null;
      // Carry an expiry the CLI can parse and nothing that identifies the
      // signed-in person: no email, user id, plan type or fedramp flag.
      return jwtShaped({ exp: Math.floor(Date.now() / 1000) + 3600 });
    },
  };
}

/**
 * LOAD-BEARING. The group's Codex directory is mounted read-write at
 * `/home/node/.codex`, so the agent can replace `auth.json` with a symlink
 * before the host writes it; a plain write would then follow that link and turn
 * this into an arbitrary-write primitive against any path the host user can
 * reach. Unlinking first drops the planted entry, and `wx` (O_CREAT|O_EXCL)
 * refuses to follow or overwrite anything that reappears in between, so a race
 * fails closed rather than writing through it.
 */
function writeNoFollow(filePath: string, content: string): void {
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, content, { flag: 'wx', mode: 0o600 });
}

/**
 * Write the group's substitute `auth.json`. Empty contribution when no
 * credential is bound, or when one is bound without a refresh token or an
 * account identifier — the wake-time gate and the spawn validator own the
 * empty case, exactly as they do for Claude.
 */
export const codexAuthFile: ContainerContributor = (ctx) => {
  const engine = getTokenEngine();
  const { groupScope } = ctx;

  const subAccess = engine.getOrCreateSubstitute(PROVIDER_ID, {}, groupScope, CRED_OAUTH);
  if (!subAccess) return {};
  const subRefresh = engine.getOrCreateSubstitute(PROVIDER_ID, {}, groupScope, CRED_OAUTH_REFRESH);
  const subAccount = engine.getOrCreateSubstitute(PROVIDER_ID, {}, groupScope, CRED_ACCOUNT_ID);
  if (!subRefresh || !subAccount) return {};

  const authPath = codexAuthFilePath(ctx.agentGroupId);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  writeNoFollow(
    authPath,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwtShaped({
          exp: Math.floor(Date.now() / 1000) + 3600,
          [CLAIM_NAMESPACE]: { chatgpt_account_id: subAccount },
        }),
        access_token: subAccess,
        refresh_token: subRefresh,
        account_id: subAccount,
      },
      last_refresh: new Date().toISOString(),
    }),
  );
  // No mount: the payload already mounts the containing directory.
  return {};
};

const agentRuntime: AgentRuntimeExt = {
  containerContribution: (ctx) => mergeContributions([codexAuthFile(ctx)]),
  requiredCredentialProviders: () => [{ id: PROVIDER_ID, required: true }],
  // Nothing in the Codex runtime config changes whether a credential is needed
  // or where it goes, so no field has to survive parsing.
  parseRuntimeConfig: () => ({}),
  // The agent's model traffic carries prompts and completions; a tap must never
  // record them. The subscription path uses chatgpt.com, the API-key path
  // api.openai.com, and the CLI reports telemetry to ab.chatgpt.com.
  defaultTapExcludeHosts: () => [CHATGPT_HOST, API_HOST, 'ab.chatgpt.com'],
};

/**
 * Register the Codex provider. Call exactly once at boot, AFTER
 * `initTokenEngine` (the substitution facet reads the engine) and BEFORE
 * `proxy.start()` (whose `rebuildIndex` indexes these swap rules). Duplicate-id
 * registration throws — the registry is the guard.
 */
export function registerCodexCredentialProvider(): void {
  const ext = new ExtensionBag().set(AGENT_RUNTIME, agentRuntime);
  const provider: SubstitutingProvider = {
    id: PROVIDER_ID,
    buildManifest: defaultManifestBuilder(PROVIDER_ID),
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
    substitutes: codexSubstitutes(),
    getExtension: ext.get,
  };
  registerCredentialProvider(provider);
}
