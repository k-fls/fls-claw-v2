/**
 * The Codex credential provider's rule table, substitute shapes, and the
 * substitute `auth.json` it writes.
 *
 * The shapes under test are format-preserving against a real Codex
 * `auth.json`: three JWT token fields and a UUID account identifier. The
 * security property is that nothing the container can read authenticates from
 * outside it, and that no claim identifies the signed-in person.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_ROOT = path.join(os.tmpdir(), `nc-codexcred-${process.pid}`);

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: path.join(os.tmpdir(), `nc-codexcred-${process.pid}`, 'data'),
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// The sign-in spawns a container; stub it so the acquire branches are unit
// testable without Docker.
vi.mock('../auth-container.js', () => ({ spawnAuthContainer: vi.fn() }));
vi.mock('../modules/permissions/access.js', () => ({ canAccessAgentGroup: vi.fn() }));
vi.mock('../modules/approvals/primitive.js', () => ({ pickApprover: vi.fn(() => []) }));
vi.mock('../modules/permissions/db/users.js', () => ({ getUser: vi.fn(() => undefined) }));
// The acquire/reauth entry point is a menu now. Default to the first route
// (browser sign-in); the device-mode case overrides `pick`.
const menu = vi.hoisted(() => ({ pick: 0 as number | null, options: [] as string[][] }));
vi.mock('../modules/interactions/index.js', () => ({
  pickOptionOn: async (_o: unknown, opts: { options: string[] }) => {
    menu.options.push(opts.options);
    return menu.pick == null ? { index: null, reason: 'cancelled' } : { index: menu.pick, reason: 'submitted' };
  },
  pastePgpOn: async () => ({ reason: 'cancelled' }),
}));

import {
  registerCodexCredentialProvider,
  _resetCodexSignInGuardForTests,
  codexAuthFilePath,
  CODEX_OAUTH_PROVIDER,
  CRED_ACCOUNT_ID,
} from './codex-credential.js';
import { DATA_DIR } from '../config.js';
import { spawnAuthContainer } from '../auth-container.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { pickApprover } from '../modules/approvals/primitive.js';
import { ACQUIRE } from '../credential-acquisition.js';
import { CONTAINER_FEEDBACK } from '../modules/credentials/providers/types.js';
import { REAUTH } from '../modules/credentials/reauth.js';
import type { InteractionOrigin } from '../host-interactions.js';
import { getCredentialProvider, _resetProviderRegistryForTests } from '../modules/credentials/providers/registry.js';
import { AGENT_RUNTIME } from '../modules/credentials/providers/types.js';
import { asGroupScope, asCredentialScope } from '../modules/credentials/types.js';
import { getOrCreateResolverForAgentGroup } from '../modules/credentials/resolver.js';
import {
  initTokenEngine,
  _resetTokenEngineForTests,
  CRED_OAUTH,
  type SubstitutesSpec,
} from '../modules/mitm-proxy/index.js';

const FOLDER = 'grp-codex';
const AGENT_GROUP_ID = 'ag-codex-1';

/** A JWT in shape only — stands in for a real Codex token. */
function fakeJwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(payload)}.${'s'.repeat(43)}`;
}

const REAL_ACCESS = fakeJwt({ exp: 9999999999, email: 'person@example.com' });
const REAL_REFRESH = fakeJwt({ exp: 9999999999 });
const REAL_ACCOUNT = '11111111-2222-3333-4444-555555555555';

function substitutes(): SubstitutesSpec {
  const p = getCredentialProvider('codex', asCredentialScope(FOLDER));
  const spec = (p as { substitutes?: SubstitutesSpec } | undefined)?.substitutes;
  if (!spec) throw new Error('codex provider not registered as substituting');
  return spec;
}

function contribute() {
  const p = getCredentialProvider('codex', asCredentialScope(FOLDER));
  const ext = p?.getExtension?.(AGENT_RUNTIME);
  if (!ext) throw new Error('AGENT_RUNTIME extension missing');
  return ext.containerContribution({
    agentGroupId: AGENT_GROUP_ID,
    groupScope: asGroupScope(FOLDER),
    sessionDir: path.join(TMP_ROOT, 'session'),
    hostEnv: {},
    runtimeConfig: {},
    agentProvider: 'codex',
    providerVersion: undefined,
  });
}

/** Store a credential for the group, as a proxy capture would. */
function storeCredential(opts: { refresh?: boolean; account?: boolean } = {}): void {
  const scope = asCredentialScope(FOLDER);
  const resolver = getOrCreateResolverForAgentGroup(asGroupScope(FOLDER));
  const at = Date.now();
  // The refresh token is a nested member of the oauth credential (the engine
  // resolves `oauth/refresh` as credential `oauth` -> `.refresh.value`), while
  // the account identifier is a credential in its own right.
  resolver.store(scope, 'codex', CRED_OAUTH, {
    value: REAL_ACCESS,
    updated_ts: at,
    ...(opts.refresh === false ? {} : { refresh: { value: REAL_REFRESH, updated_ts: at } }),
  });
  if (opts.account !== false) {
    resolver.store(scope, 'codex', CRED_ACCOUNT_ID, { value: REAL_ACCOUNT, updated_ts: at });
  }
}

/** First rule whose anchor and path both match, as the index would resolve it. */
function ruleFor(host: string, reqPath: string): string | null {
  const hit = CODEX_OAUTH_PROVIDER.rules.find((r) => r.anchor === host && r.pathPattern.test(reqPath));
  return hit ? hit.mode : null;
}

describe('codex credential provider', () => {
  let priorXdg: string | undefined;

  beforeEach(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    // The credential store roots at `configHome()/nanoclaw/credentials`, read
    // lazily from XDG_CONFIG_HOME — redirect it so a test never writes into the
    // operator's real credential store.
    priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(TMP_ROOT, 'config');

    vi.clearAllMocks();
    _resetCodexSignInGuardForTests();
    _resetProviderRegistryForTests();
    _resetTokenEngineForTests();
    initTokenEngine((scope) => getOrCreateResolverForAgentGroup(scope));
    registerCodexCredentialProvider();
    // Resolvers are cached per scope for the life of the module, so a
    // credential stored by an earlier test would otherwise still resolve.
    getOrCreateResolverForAgentGroup(asGroupScope(FOLDER)).delete(asCredentialScope(FOLDER), 'codex');
  });

  afterEach(() => {
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  describe('rule table', () => {
    it('routes the device-authorization and token endpoints to their handlers', () => {
      expect(ruleFor('auth.openai.com', '/api/accounts/deviceauth/usercode')).toBe('device-code');
      expect(ruleFor('auth.openai.com', '/api/accounts/deviceauth/token')).toBe('token-exchange');
      expect(ruleFor('auth.openai.com', '/oauth/token')).toBe('token-exchange');
    });

    it('swaps the bearer on model traffic for both auth modes', () => {
      expect(ruleFor('chatgpt.com', '/backend-api/codex/responses')).toBe('bearer-swap');
      expect(ruleFor('api.openai.com', '/v1/responses')).toBe('bearer-swap');
    });

    it('matches no rule on a path outside the recorded set', () => {
      expect(ruleFor('auth.openai.com', '/oauth/authorize')).toBeNull();
      // The paths the binary's strings suggested, which the wire disproved.
      expect(ruleFor('auth.openai.com', '/deviceauth/usercode')).toBeNull();
      expect(ruleFor('auth.openai.com', '/deviceauth/token')).toBeNull();
      expect(ruleFor('chatgpt.com', '/')).toBeNull();
      expect(ruleFor('ab.chatgpt.com', '/otlp/v1/metrics')).toBeNull();
    });

    it('registers under the codex id exactly once', () => {
      expect(getCredentialProvider('codex', asCredentialScope(FOLDER))).toBeTruthy();
      expect(() => registerCodexCredentialProvider()).toThrow();
    });

    it('advertises no env bindings — Codex reads auth.json, not env', () => {
      expect(substitutes().envNamesFor(CRED_OAUTH)).toEqual([]);
    });
  });

  describe('substitute shapes', () => {
    it('mints a UUID for the account identifier', () => {
      const sub = substitutes().generateSubstitute(REAL_ACCOUNT, CRED_ACCOUNT_ID);
      expect(sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(sub).not.toBe(REAL_ACCOUNT);
    });

    it('mints a three-segment JWT with a parseable payload for a token', () => {
      const sub = substitutes().generateSubstitute(REAL_ACCESS, CRED_OAUTH);
      expect(sub).toBeTruthy();
      const parts = sub!.split('.');
      expect(parts).toHaveLength(3);
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      expect(typeof payload.exp).toBe('number');
    });

    it('carries no claim identifying the signed-in person', () => {
      const sub = substitutes().generateSubstitute(REAL_ACCESS, CRED_OAUTH)!;
      const payload = Buffer.from(sub.split('.')[1], 'base64url').toString('utf-8');
      for (const claim of ['email', 'chatgpt_user_id', 'chatgpt_plan_type', 'chatgpt_account_is_fedramp']) {
        expect(payload).not.toContain(claim);
      }
    });

    it('declines a real value that is not JWT-shaped rather than breaking the format', () => {
      expect(substitutes().generateSubstitute('not-a-jwt', CRED_OAUTH)).toBeNull();
    });
  });

  describe('auth.json contribution', () => {
    it('writes substitutes in every token field and no real value', () => {
      storeCredential();
      contribute();

      const raw = fs.readFileSync(codexAuthFilePath(AGENT_GROUP_ID), 'utf-8');
      for (const real of [REAL_ACCESS, REAL_REFRESH, REAL_ACCOUNT]) {
        expect(raw).not.toContain(real);
      }
      const doc = JSON.parse(raw);
      expect(doc.tokens.access_token.split('.')).toHaveLength(3);
      expect(doc.tokens.refresh_token.split('.')).toHaveLength(3);
      expect(doc.tokens.id_token.split('.')).toHaveLength(3);
      expect(doc.auth_mode).toBe('chatgpt');
      expect(doc.OPENAI_API_KEY).toBeNull();
    });

    it('binds the id_token account claim to tokens.account_id by construction', () => {
      storeCredential();
      contribute();
      const doc = JSON.parse(fs.readFileSync(codexAuthFilePath(AGENT_GROUP_ID), 'utf-8'));
      const claims = JSON.parse(Buffer.from(doc.tokens.id_token.split('.')[1], 'base64url').toString('utf-8'));
      expect(claims['https://api.openai.com/auth'].chatgpt_account_id).toBe(doc.tokens.account_id);
    });

    it('writes inside the directory the agent-provider payload mounts', () => {
      // The payload mounts DATA_DIR/v2-sessions/<agentGroupId>/.codex-shared at
      // /home/node/.codex. A payload refresh that moves it must fail here.
      expect(codexAuthFilePath(AGENT_GROUP_ID)).toBe(
        path.join(DATA_DIR, 'v2-sessions', AGENT_GROUP_ID, '.codex-shared', 'auth.json'),
      );
    });

    it('replaces a symlink planted at auth.json instead of writing through it', () => {
      // The group's Codex dir is mounted read-write, so the agent can plant one.
      storeCredential();
      const authPath = codexAuthFilePath(AGENT_GROUP_ID);
      const decoy = path.join(TMP_ROOT, 'decoy.json');
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(decoy, 'untouched');
      fs.symlinkSync(decoy, authPath);

      contribute();

      expect(fs.readFileSync(decoy, 'utf-8')).toBe('untouched');
      expect(fs.lstatSync(authPath).isSymbolicLink()).toBe(false);
      expect(JSON.parse(fs.readFileSync(authPath, 'utf-8')).auth_mode).toBe('chatgpt');
    });

    it('contributes nothing and writes nothing when no credential is bound', () => {
      contribute();
      expect(fs.existsSync(codexAuthFilePath(AGENT_GROUP_ID))).toBe(false);
    });

    it('treats a credential with no refresh token as absent', () => {
      storeCredential({ refresh: false });
      contribute();
      expect(fs.existsSync(codexAuthFilePath(AGENT_GROUP_ID))).toBe(false);
    });

    it('treats a credential with no account identifier as absent', () => {
      storeCredential({ account: false });
      contribute();
      expect(fs.existsSync(codexAuthFilePath(AGENT_GROUP_ID))).toBe(false);
    });
  });
  describe('sign-in', () => {
    const KEY = { channelType: 'cli', platformId: 'local', threadId: null, userId: 'cli:op' };

    function origin(replies: string[]): InteractionOrigin {
      return {
        key: KEY,
        agentGroupId: AGENT_GROUP_ID,
        messagingGroupId: 'mg-1',
        replyAddr: { channelType: 'cli', platformId: 'local', threadId: null },
        writeReply: (text) => replies.push(text),
      };
    }

    function acquireExt() {
      const p = getCredentialProvider('codex', asCredentialScope(FOLDER));
      const ext = p?.getExtension?.(ACQUIRE);
      if (!ext) throw new Error('ACQUIRE extension missing');
      return ext;
    }

    beforeEach(() => {
      menu.pick = 0;
      menu.options = [];
    });

    const asAdmin = (): void => {
      vi.mocked(canAccessAgentGroup).mockReturnValue({ allowed: true, reason: 'admin_of_group' });
    };

    it('declines a non-admin, names who can, and spawns nothing', async () => {
      vi.mocked(canAccessAgentGroup).mockReturnValue({ allowed: true, reason: 'member' });
      vi.mocked(pickApprover).mockReturnValue(['cli:boss']);
      const replies: string[] = [];

      const ok = await acquireExt().acquire({ origin: origin(replies), credentialScope: asCredentialScope(FOLDER) });

      expect(ok).toBe(false);
      expect(spawnAuthContainer).not.toHaveBeenCalled();
      expect(replies.join(' ')).toContain('cli:boss');
      expect(
        getOrCreateResolverForAgentGroup(asGroupScope(FOLDER)).resolve(asCredentialScope(FOLDER), 'codex', CRED_OAUTH),
      ).toBeNull();
    });

    it('declines an unknown sender rather than treating them as an admin', async () => {
      vi.mocked(canAccessAgentGroup).mockReturnValue({ allowed: false, reason: 'unknown_user' });
      const replies: string[] = [];

      const ok = await acquireExt().acquire({ origin: origin(replies), credentialScope: asCredentialScope(FOLDER) });

      expect(ok).toBe(false);
      expect(spawnAuthContainer).not.toHaveBeenCalled();
      expect(replies).toHaveLength(1);
    });

    it('spawns the device-login mode for an admin and reports success once a credential resolves', async () => {
      asAdmin();
      // The proxy captures during the run; simulate that.
      vi.mocked(spawnAuthContainer).mockImplementation(async () => {
        storeCredential();
      });
      const replies: string[] = [];

      const ok = await acquireExt().acquire({ origin: origin(replies), credentialScope: asCredentialScope(FOLDER) });

      expect(ok).toBe(true);
      const call = vi.mocked(spawnAuthContainer).mock.calls[0][0];
      // The first route, and the one that needs no workspace setting.
      expect(call.mode).toBe('codex_login');
      expect(call.folder).toBe(FOLDER);
      expect(call.nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('spawns the device-login mode when that route is chosen instead', async () => {
      asAdmin();
      menu.pick = 1;
      vi.mocked(spawnAuthContainer).mockImplementation(async () => {
        storeCredential();
      });

      const ok = await acquireExt().acquire({ origin: origin([]), credentialScope: asCredentialScope(FOLDER) });

      expect(ok).toBe(true);
      expect(vi.mocked(spawnAuthContainer).mock.calls[0][0].mode).toBe('codex_device');
    });

    it('offers the browser route ahead of the device route, which names its prerequisite', async () => {
      asAdmin();
      vi.mocked(spawnAuthContainer).mockResolvedValue(undefined);

      await acquireExt().acquire({ origin: origin([]), credentialScope: asCredentialScope(FOLDER) });

      expect(menu.options[0][0]).toMatch(/browser/i);
      expect(menu.options[0][1]).toMatch(/device authorization/i);
      expect(menu.options[0][2]).toMatch(/API key/i);
    });

    it('decides success by the credential, not by the container exiting cleanly', async () => {
      asAdmin();
      vi.mocked(spawnAuthContainer).mockResolvedValue(undefined);
      const replies: string[] = [];

      const ok = await acquireExt().acquire({ origin: origin(replies), credentialScope: asCredentialScope(FOLDER) });

      expect(ok).toBe(false);
      expect(replies.join(' ')).toContain('did not complete');
    });

    it('reports plainly when the spawn throws, leaving no credential', async () => {
      asAdmin();
      vi.mocked(spawnAuthContainer).mockRejectedValue(new Error('docker gone'));
      const replies: string[] = [];

      const ok = await acquireExt().acquire({ origin: origin(replies), credentialScope: asCredentialScope(FOLDER) });

      expect(ok).toBe(false);
      expect(replies.join(' ')).toContain('failed');
    });

    it('mounts a throwaway Codex home and never seeds it from an existing auth file', async () => {
      asAdmin();
      vi.mocked(spawnAuthContainer).mockResolvedValue(undefined);

      await acquireExt().acquire({ origin: origin([]), credentialScope: asCredentialScope(FOLDER) });

      const call = vi.mocked(spawnAuthContainer).mock.calls[0][0];
      const scratch = path.join(TMP_ROOT, 'scratch');
      fs.mkdirSync(scratch, { recursive: true });
      const contribution = call.contribute!(scratch);

      const mount = contribution.mounts![0];
      expect(mount.containerPath).toBe('/home/node/.codex');
      expect(mount.hostPath.startsWith(scratch)).toBe(true);
      expect(mount.readonly).toBe(false);
      // Freshly created and empty — nothing copied in from any existing home.
      expect(fs.readdirSync(mount.hostPath)).toEqual([]);
      expect(mount.hostPath).not.toBe(codexAuthFilePath(AGENT_GROUP_ID));
    });

    it('does not start a second episode while one is in flight', async () => {
      asAdmin();
      let release: (() => void) | undefined;
      vi.mocked(spawnAuthContainer).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const first = acquireExt().acquire({ origin: origin([]), credentialScope: asCredentialScope(FOLDER) });
      const secondReplies: string[] = [];
      const second = await acquireExt().acquire({
        origin: origin(secondReplies),
        credentialScope: asCredentialScope(FOLDER),
      });

      expect(second).toBe(false);
      expect(secondReplies.join(' ')).toContain('already under way');
      expect(spawnAuthContainer).toHaveBeenCalledTimes(1);

      release!();
      await first;
    });

    it('releases the in-flight guard so a later attempt can run', async () => {
      asAdmin();
      vi.mocked(spawnAuthContainer).mockResolvedValue(undefined);

      await acquireExt().acquire({ origin: origin([]), credentialScope: asCredentialScope(FOLDER) });
      await acquireExt().acquire({ origin: origin([]), credentialScope: asCredentialScope(FOLDER) });

      expect(spawnAuthContainer).toHaveBeenCalledTimes(2);
    });

    it('re-authentication runs the same routine and states the rejection reason', async () => {
      asAdmin();
      vi.mocked(spawnAuthContainer).mockResolvedValue(undefined);
      const p = getCredentialProvider('codex', asCredentialScope(FOLDER));
      const replies: string[] = [];

      await p!.getExtension!(REAUTH)!.reauth({
        origin: origin(replies),
        credentialScope: asCredentialScope(FOLDER),
        classification: 'auth-invalid',
        reason: 'token_expired',
      });

      expect(replies.join(' ')).toContain('token_expired');
      expect(vi.mocked(spawnAuthContainer).mock.calls[0][0].mode).toBe('codex_login');
    });

    it('routes an auth rejection to reauth and anything else to the surfaced error', () => {
      const p = getCredentialProvider('codex', asCredentialScope(FOLDER));
      const fb = p!.getExtension!(CONTAINER_FEEDBACK)!;
      const call = (classification: string) => fb.onContainerError({ classification } as never, undefined, {} as never);
      expect(call('auth-invalid')).toBe('reauth');
      // A seat limit must not be re-authenticated; the proxy-side classifier
      // that produces that tag lands in a later unit.
      expect(call('rate-limit')).toBe('surface');
      expect(call('other')).toBe('surface');
    });
  });
});
