/**
 * Spawn-time credential→env-var publish (I2).
 *
 * Verifies `materializeGroupCredentialEnv`: it mints substitutes for the
 * providers a group has credentials for, materializes their bound env vars
 * (slicing composite credentials), skips AGENT_RUNTIME providers (they
 * self-inject), and drops reserved / colliding names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENT_RUNTIME } from '../credentials/index.js';
import {
  registerCredentialProvider,
  setScopedCredentialProviders,
  _resetProviderRegistryForTests,
  type CredentialProvider,
} from '../credentials/providers/registry.js';

import { materializeGroupCredentialEnv } from './credential-env.js';
import { defaultSubstitutes, type DefaultSubstitutesInput } from './defaults.js';
// Side-effect: reserve HTTPS_PROXY / NODE_EXTRA_CA_CERTS / … so the
// reserved-name guard has something to reject.
import './observer.js';
import { TokenSubstituteEngine, setTokenEngine, _resetTokenEngineForTests } from './token-substitute.js';
import {
  asCredentialScope,
  asGroupScope,
  type Credential,
  type CredentialScope,
  type EngineCredentialResolver,
  type SubstitutingProvider,
} from './types.js';

/** In-memory plaintext resolver (own-scope only). */
class MockResolver implements EngineCredentialResolver {
  private creds = new Map<string, Credential>();
  put(scope: CredentialScope, providerId: string, credentialId: string, value: string): void {
    this.creds.set(`${scope}|${providerId}|${credentialId}`, { value, updated_ts: 1 });
  }
  resolve(scope: CredentialScope, providerId: string, credentialId: string): Credential | null {
    return this.creds.get(`${scope}|${providerId}|${credentialId}`) ?? null;
  }
}

function register(id: string, input: DefaultSubstitutesInput, opts: { agentRuntime?: boolean } = {}): void {
  const p: SubstitutingProvider & Partial<CredentialProvider> = {
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: defaultSubstitutes(input),
  };
  if (opts.agentRuntime) {
    // Only AGENT_RUNTIME presence matters to the publish; the value is opaque.
    p.getExtension = <T>(type: unknown): T | undefined => (type === (AGENT_RUNTIME as unknown) ? ({} as T) : undefined);
  }
  registerCredentialProvider(p);
}

const GROUP = asGroupScope('group-a');
const CRED = asCredentialScope('group-a');
let TMP_HOME: string;
const ORIG_XDG = process.env.XDG_CONFIG_HOME;
let resolver: MockResolver;

beforeEach(() => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-env-test-'));
  process.env.XDG_CONFIG_HOME = TMP_HOME;
  _resetProviderRegistryForTests();
  _resetTokenEngineForTests();
  resolver = new MockResolver();
  setTokenEngine(new TokenSubstituteEngine(() => resolver));
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIG_XDG;
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* */
  }
  _resetProviderRegistryForTests();
  _resetTokenEngineForTests();
});

describe('materializeGroupCredentialEnv', () => {
  it('publishes a substitute (not the real token) for a stored credential', () => {
    register('github', { envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }] });
    resolver.put(CRED, 'github', 'oauth', 'ghp_realtokenrealtokenrealtoken01');

    const env = materializeGroupCredentialEnv(GROUP);
    expect(env.GH_TOKEN).toBeTruthy();
    expect(env.GH_TOKEN).not.toBe('ghp_realtokenrealtokenrealtoken01');
    // Format-preserving: same shape as the real token.
    expect(env.GH_TOKEN.length).toBe('ghp_realtokenrealtokenrealtoken01'.length);
  });

  it('publishes a per-group (scope-tier) provider, not in the global registry', () => {
    // Mirrors a per-group `.auth-discovery/` provider: lives only in the
    // caller scope's tier, so materialization must resolve it scope-aware.
    const grp: SubstitutingProvider = {
      id: 'grp',
      buildManifest: () => [],
      onManifestWritten: () => {},
      onManifestDeleted: () => {},
      substitutes: defaultSubstitutes({ envBindings: [{ envName: 'GRP_TOKEN', credentialPath: 'oauth' }] }),
    };
    setScopedCredentialProviders(CRED, [grp]);
    resolver.put(CRED, 'grp', 'oauth', 'grp_realtokenrealtokenrealtoken01');

    const env = materializeGroupCredentialEnv(GROUP);
    expect(env.GRP_TOKEN).toBeTruthy();
    expect(env.GRP_TOKEN).not.toBe('grp_realtokenrealtokenrealtoken01');

    // A different group's scope tier does not see it.
    expect(materializeGroupCredentialEnv(asGroupScope('other-group')).GRP_TOKEN).toBeUndefined();
  });

  it('omits providers with no stored credential for the group', () => {
    register('github', { envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }] });
    register('todoist', { envBindings: [{ envName: 'TODOIST_API_TOKEN', credentialPath: 'api_key' }] });
    resolver.put(CRED, 'github', 'oauth', 'ghp_realtokenrealtokenrealtoken01');

    const env = materializeGroupCredentialEnv(GROUP);
    expect(env.GH_TOKEN).toBeTruthy();
    expect(env.TODOIST_API_TOKEN).toBeUndefined();
  });

  it('slices composite credentials into separate env vars (browserstack shape)', () => {
    register('browserstack', {
      substituteConfig: { prefixLen: 2, suffixLen: 2, delimiters: ':' },
      credentialFormat: { access_key: { sep: ':' } },
      envBindings: [
        { envName: 'BROWSERSTACK_USERNAME', credentialPath: 'access_key', slice: 0 },
        { envName: 'BROWSERSTACK_ACCESS_KEY', credentialPath: 'access_key', slice: 1 },
      ],
    });
    resolver.put(CRED, 'browserstack', 'access_key', 'myusername123:myaccesskey456');

    const env = materializeGroupCredentialEnv(GROUP);
    expect(env.BROWSERSTACK_USERNAME).toBeTruthy();
    expect(env.BROWSERSTACK_ACCESS_KEY).toBeTruthy();
    // Two distinct halves, neither carrying the ':' join.
    expect(env.BROWSERSTACK_USERNAME).not.toContain(':');
    expect(env.BROWSERSTACK_ACCESS_KEY).not.toContain(':');
    expect(env.BROWSERSTACK_USERNAME).not.toBe(env.BROWSERSTACK_ACCESS_KEY);
    // Joined back, they reconstruct the (single) substitute the proxy matches.
    expect(`${env.BROWSERSTACK_USERNAME}:${env.BROWSERSTACK_ACCESS_KEY}`).not.toBe('myusername123:myaccesskey456');
  });

  it('skips providers that self-inject via AGENT_RUNTIME', () => {
    register(
      'claude',
      { envBindings: [{ envName: 'ANTHROPIC_API_KEY', credentialPath: 'api_key' }] },
      { agentRuntime: true },
    );
    resolver.put(CRED, 'claude', 'api_key', 'sk-ant-api03-realrealrealreal0001');

    const env = materializeGroupCredentialEnv(GROUP);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('drops reserved env-var names', () => {
    register('sneaky', { envBindings: [{ envName: 'HTTPS_PROXY', credentialPath: 'oauth' }] });
    resolver.put(CRED, 'sneaky', 'oauth', 'tokentokentokentokentoken00001');

    const env = materializeGroupCredentialEnv(GROUP);
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it('first provider to claim an env name wins on collision', () => {
    register('p1', { envBindings: [{ envName: 'SHARED_TOKEN', credentialPath: 'oauth' }] });
    register('p2', { envBindings: [{ envName: 'SHARED_TOKEN', credentialPath: 'oauth' }] });
    resolver.put(CRED, 'p1', 'oauth', 'p1tokenp1tokenp1tokenp1token01');
    resolver.put(CRED, 'p2', 'oauth', 'p2tokenp2tokenp2tokenp2token02');

    const env = materializeGroupCredentialEnv(GROUP);
    // Exactly one value present (registration order: p1 first).
    expect(env.SHARED_TOKEN).toBeTruthy();
    expect(env.SHARED_TOKEN.length).toBe('p1tokenp1tokenp1tokenp1token01'.length);
  });
});
