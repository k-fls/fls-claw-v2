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

import {
  registerCodexCredentialProvider,
  codexAuthFilePath,
  CODEX_OAUTH_PROVIDER,
  CRED_ACCOUNT_ID,
} from './codex-credential.js';
import { DATA_DIR } from '../config.js';
import { getCredentialProvider, _resetProviderRegistryForTests } from '../modules/credentials/providers/registry.js';
import { AGENT_RUNTIME } from '../modules/credentials/providers/types.js';
import { asGroupScope, asCredentialScope } from '../modules/credentials/types.js';
import { getOrCreateResolverForAgentGroup } from '../modules/credentials/resolver.js';
import {
  initTokenEngine,
  _resetTokenEngineForTests,
  CRED_OAUTH,
  CRED_OAUTH_REFRESH,
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
      expect(ruleFor('auth.openai.com', '/deviceauth/usercode')).toBe('device-code');
      expect(ruleFor('auth.openai.com', '/deviceauth/token')).toBe('token-exchange');
      expect(ruleFor('auth.openai.com', '/oauth/token')).toBe('token-exchange');
    });

    it('swaps the bearer on model traffic for both auth modes', () => {
      expect(ruleFor('chatgpt.com', '/backend-api/codex/responses')).toBe('bearer-swap');
      expect(ruleFor('api.openai.com', '/v1/responses')).toBe('bearer-swap');
    });

    it('matches no rule on a path outside the recorded set', () => {
      expect(ruleFor('auth.openai.com', '/oauth/authorize')).toBeNull();
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
});
