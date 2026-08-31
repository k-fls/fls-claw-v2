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
 * mount. `codexAuthFilePath` and the payload's mount must agree; the test pins
 * that agreement.
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
  getOrCreateResolverForAgentGroup,
  defaultManifestBuilder,
  noManifestSideEffect,
  ExtensionBag,
  AGENT_RUNTIME,
  CONTAINER_FEEDBACK,
  REAUTH,
  startAuthEpisode,
  type AgentRuntimeExt,
  type ContainerContributor,
  type ContainerFeedbackExt,
  type CredentialScope,
  type ReauthContext,
  type ReauthExt,
} from '../modules/credentials/index.js';
import { spawnAuthContainer } from '../auth-container.js';
import { asContainerScope } from '../modules/container-bootstrap/index.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { pickApprover } from '../modules/approvals/primitive.js';
import { getUser } from '../modules/permissions/db/users.js';
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
    // Paths observed on the wire from the pinned CLI (0.138.0) against a
    // forged certificate, not inferred from the binary's strings: the device
    // endpoints sit under /api/accounts, which the strings did not show.
    { anchor: AUTH_HOST, pathPattern: /^\/api\/accounts\/deviceauth\/usercode$/, mode: 'device-code' },
    { anchor: AUTH_HOST, pathPattern: /^\/api\/accounts\/deviceauth\/token$/, mode: 'token-exchange' },
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
 * One sign-in per (group, provider) at a time. The wake-time acquire path has
 * no guard of its own, so without this a second message arriving while a
 * container is still polling would start a second episode — and the first
 * episode's credential would be cleared out from under it.
 */
const inFlightSignIn = new Set<string>();

/** Test-only: the guard is module state and outlives a registry reset. */
export function _resetCodexSignInGuardForTests(): void {
  inFlightSignIn.clear();
}

/** Who the group can ask, for the message a non-admin gets. */
function approverNames(agentGroupId: string | null): string[] {
  return pickApprover(agentGroupId).map((id) => getUser(id)?.display_name || id);
}

/**
 * Codex sign-in: admin-gated, then a device login inside an auth container.
 *
 * Success is decided by a credential resolving afterwards, not by the
 * container's exit status — the proxy captures the token during the run, and a
 * CLI can exit zero having done nothing.
 *
 * Replies on every terminal branch, including the non-admin decline. The
 * wake-time gate leaves the triggering message pending and re-wakes only once a
 * credential is stored, so a silent branch strands that message until somebody
 * happens to send another.
 */
async function runCodexSignIn(origin: InteractionOrigin, scope: CredentialScope, reason?: string): Promise<boolean> {
  const folder = String(scope);
  const userId = origin.key.userId;
  const decision = userId ? canAccessAgentGroup(userId, origin.agentGroupId ?? '') : null;
  // Members can use the group but not bind its credential; only owner, global
  // admin, or an admin of this group can.
  if (!decision?.allowed || decision.reason === 'member') {
    const who = approverNames(origin.agentGroupId);
    origin.writeReply(
      who.length > 0
        ? `Signing in to Codex needs an admin of this group. Ask one of: ${who.join(', ')}.`
        : 'Signing in to Codex needs an admin of this group, and none is configured yet.',
    );
    return false;
  }

  const guardKey = `${folder}:${PROVIDER_ID}`;
  if (inFlightSignIn.has(guardKey)) {
    origin.writeReply('A Codex sign-in is already under way for this group — finish that one first.');
    return false;
  }
  inFlightSignIn.add(guardKey);

  const resolver = getOrCreateResolverForAgentGroup(scope);
  // Start clean: a rejected credential must not read as success afterwards.
  resolver.delete(scope, PROVIDER_ID);

  const nonce = randomBytes(16).toString('hex');
  const episode = startAuthEpisode({ scopeFolder: folder, nonce, origin });
  try {
    origin.writeReply(
      (reason ? `Your stored Codex credential was rejected (${reason}). ` : '') +
        'Starting Codex sign-in — launching a secure auth container. ' +
        'A link and a code will arrive here; you have about 10 minutes to complete it.',
    );
    await spawnAuthContainer({
      scope: asContainerScope(folder),
      folder,
      mode: 'codex_device',
      nonce,
      contribute: (scratchDir) => {
        // A throwaway home, never seeded from an existing auth file. OpenAI
        // rotates refresh tokens, so two consumers sharing one ChatGPT OAuth
        // session strand each other at the first refresh — taking down the
        // operator's own CLI along with this group. `scratchDir` is removed on
        // every exit path by the spawner.
        const home = path.join(scratchDir, 'codex');
        fs.mkdirSync(home, { recursive: true });
        return {
          mounts: [{ hostPath: home, containerPath: '/home/node/.codex', readonly: false }],
          env: { CODEX_HOME: '/home/node/.codex' },
        };
      },
    });

    if (resolver.resolve(scope, PROVIDER_ID, CRED_OAUTH)) {
      origin.writeReply('Codex sign-in complete — credential stored. Retrying your request now.');
      return true;
    }
    origin.writeReply('Sign-in did not complete — no credential stored.');
    return false;
  } catch (err) {
    log.error('Codex sign-in failed', { folder, err });
    origin.writeReply('Sign-in failed unexpectedly — no credential stored.');
    return false;
  } finally {
    episode.end();
    inFlightSignIn.delete(guardKey);
  }
}

const acquire: AcquireExt = {
  acquire: (ctx: AcquireContext) => runCodexSignIn(ctx.origin, ctx.credentialScope),
};

const reauth: ReauthExt = {
  reauth: (ctx: ReauthContext) => runCodexSignIn(ctx.origin, ctx.credentialScope, ctx.reason),
};

/**
 * An auth rejection drives re-authentication; everything else surfaces through
 * the container's own error line. A seat-limit rejection must NOT land here as
 * `auth-invalid` — re-authenticating an exhausted seat cannot help, and the
 * proxy-side classifier that separates the two is a later unit.
 */
const containerFeedback: ContainerFeedbackExt = {
  onContainerError: (event) => (event.classification === 'auth-invalid' ? 'reauth' : 'surface'),
};

/**
 * Register the Codex provider. Call exactly once at boot, AFTER
 * `initTokenEngine` (the substitution facet reads the engine) and BEFORE
 * `proxy.start()` (whose `rebuildIndex` indexes these swap rules). Duplicate-id
 * registration throws — the registry is the guard.
 */
export function registerCodexCredentialProvider(): void {
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
    substitutes: codexSubstitutes(),
    getExtension: ext.get,
  };
  registerCredentialProvider(provider);
}
