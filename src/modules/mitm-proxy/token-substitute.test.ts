/**
 * TokenSubstituteEngine — substitution-only test suite.
 *
 * The engine is now a pure cache + collision-retry loop; the substitute
 * shape lives on the `SubstitutingProvider`. Tests register a default
 * provider per `providerId` before exercising `getOrCreateSubstitute`.
 *
 * The v1 producer-flow tests (PersistentCredentialResolver, refresh,
 * import-env, grant/borrow revocation paths) live in
 * `docs/fls/v1-group-oauth-snapshot/src/auth/token-substitute.test.ts`
 * and need to be ported alongside the OAuth module. See
 * `docs/fls/mitm-proxy-oauth-readd.md` for the punch list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  registerCredentialProvider,
  setScopedCredentialProviders,
  _resetProviderRegistryForTests,
} from '../credentials/providers/registry.js';

import { TokenSubstituteEngine } from './token-substitute.js';
import { defaultSubstitutes } from './defaults.js';
import type {
  Credential,
  CredentialScope,
  EngineCredentialResolver,
  EnvVarBinding,
  SubstituteConfig,
  SubstitutingProvider,
} from './types.js';
import { asCredentialScope, asGroupScope, CRED_OAUTH, DEFAULT_SUBSTITUTE_CONFIG } from './types.js';

/** In-memory resolver: plaintext credentials, no encryption, no disk. */
class MockResolver implements EngineCredentialResolver {
  private creds = new Map<string, Credential>();
  private key(scope: CredentialScope, providerId: string, credentialId: string): string {
    return `${scope}|${providerId}|${credentialId}`;
  }
  put(scope: CredentialScope, providerId: string, credentialId: string, value: string): void {
    this.creds.set(this.key(scope, providerId, credentialId), {
      value,
      updated_ts: Date.now(),
    });
  }
  putWithRefresh(
    scope: CredentialScope,
    providerId: string,
    credentialId: string,
    value: string,
    refreshValue: string,
  ): void {
    this.creds.set(this.key(scope, providerId, credentialId), {
      value,
      updated_ts: Date.now(),
      refresh: { value: refreshValue, updated_ts: Date.now() },
    });
  }
  resolve(scope: CredentialScope, providerId: string, credentialId: string): Credential | null {
    return this.creds.get(this.key(scope, providerId, credentialId)) ?? null;
  }
}

/**
 * Register a substituting provider in the credentials registry. The
 * engine consults the registry on cache miss to call
 * `provider.substitutes.generateSubstitute`.
 */
function registerDefaultProvider(
  id: string,
  config: SubstituteConfig = DEFAULT_SUBSTITUTE_CONFIG,
  envBindings: EnvVarBinding[] = [],
): void {
  const p: SubstitutingProvider = {
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: defaultSubstitutes({ substituteConfig: config, envBindings }),
  };
  registerCredentialProvider(p);
}

/**
 * Register a substituting provider in the *per-scope* tier only (mirrors a
 * per-group `.auth-discovery/` provider) — never in the global registry.
 */
function registerScopedProvider(
  scope: CredentialScope,
  id: string,
  config: SubstituteConfig = DEFAULT_SUBSTITUTE_CONFIG,
): void {
  const p: SubstitutingProvider = {
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: defaultSubstitutes({ substituteConfig: config, envBindings: [] }),
  };
  setScopedCredentialProviders(scope, [p]);
}

// Many tests trigger persistRefs which writes under credentialsDir(). Point
// it at a per-suite tmp dir so we don't dirty ~/.config/nanoclaw/credentials.
let TMP_HOME: string;
const ORIG_XDG = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-proxy-test-'));
  process.env.XDG_CONFIG_HOME = TMP_HOME;
  _resetProviderRegistryForTests();
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
  vi.restoreAllMocks();
});

const group = asGroupScope('group-a');
const groupScope = group as unknown as CredentialScope;

describe('defaultSubstitutes.generateSubstitute — format-preserving algorithm', () => {
  it('preserves prefix, suffix, and delimiter positions; randomizes middle', () => {
    const real = 'sk-ant-api03-1234567890abcdef1234567890abcdef';
    const sub = defaultSubstitutes({ substituteConfig: DEFAULT_SUBSTITUTE_CONFIG }).generateSubstitute(
      real,
      CRED_OAUTH,
    );
    expect(sub).not.toBeNull();
    expect(sub!.startsWith(real.slice(0, 10))).toBe(true);
    expect(sub!.endsWith(real.slice(-4))).toBe(true);
    expect(sub!.length).toBe(real.length);
    const delims = '-._~';
    for (let i = 0; i < real.length; i++) {
      if (delims.includes(real[i])) expect(sub![i]).toBe(real[i]);
    }
    expect(sub).not.toBe(real);
  });

  it('returns null when token is shorter than prefix+suffix', () => {
    const sub = defaultSubstitutes({ substituteConfig: DEFAULT_SUBSTITUTE_CONFIG }).generateSubstitute(
      'short',
      CRED_OAUTH,
    );
    expect(sub).toBeNull();
  });

  it('returns null when middle has too few randomizable chars', () => {
    // Explicit (non-default) config so pickSubstituteConfigForToken's
    // alnum auto-switch doesn't kick in. 10 prefix + 4 suffix + only
    // 4 randomizable middle chars vs default min=16.
    const real = 'aaaaaaaaaabbbbcccc';
    const sub = defaultSubstitutes({
      substituteConfig: { prefixLen: 10, suffixLen: 4, delimiters: '-._~' },
    }).generateSubstitute(real, CRED_OAUTH);
    expect(sub).toBeNull();
  });
});

describe('TokenSubstituteEngine — per-group (scoped-only) providers', () => {
  it('mints a substitute for a provider that lives only in the caller scope tier', () => {
    // The security fix: a per-group provider is invisible to the global
    // registry, so without scope-aware lookup minting returned null and the
    // token-exchange handler leaked the real token to the container.
    registerScopedProvider(groupScope, 'per-group');
    const resolver = new MockResolver();
    const real = 'sk-grp-real-1234567890abcdef1234567890abcdef';
    resolver.put(groupScope, 'per-group', CRED_OAUTH, real);
    const engine = new TokenSubstituteEngine(() => resolver);

    const sub = engine.getOrCreateSubstitute('per-group', {}, group);
    expect(sub).not.toBeNull();
    expect(sub).not.toBe(real); // a real substitute, not the raw token
    expect(engine.resolveSubstitute(sub!, group)?.realToken).toBe(real);
  });

  it('does not mint the scoped provider for a different group', () => {
    registerScopedProvider(groupScope, 'per-group');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'per-group', CRED_OAUTH, 'sk-grp-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);

    // Another group cannot resolve the provider (scope tier miss → no global
    // fallback) ⇒ no substitute minted for it.
    expect(engine.getOrCreateSubstitute('per-group', {}, asGroupScope('other-group'))).toBeNull();
  });
});

describe('TokenSubstituteEngine — lookup', () => {
  it('round-trips a substitute back to its real token via resolveSubstitute', () => {
    registerDefaultProvider('claude');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'claude', CRED_OAUTH, 'sk-ant-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    const sub = engine.getOrCreateSubstitute('claude', {}, group);
    expect(sub).not.toBeNull();
    const resolved = engine.resolveSubstitute(sub!, group);
    expect(resolved?.realToken).toBe('sk-ant-real-1234567890abcdef1234567890abcdef');
    expect(resolved?.mapping.providerId).toBe('claude');
    expect(resolved?.mapping.credentialPath).toBe(CRED_OAUTH);
  });

  it('returns null for substitutes belonging to a different group', () => {
    registerDefaultProvider('claude');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'claude', CRED_OAUTH, 'sk-ant-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    const sub = engine.getOrCreateSubstitute('claude', {}, group)!;
    expect(engine.resolveSubstitute(sub, asGroupScope('other-group'))).toBeNull();
  });

  it('getOrCreateSubstitute returns existing substitute on second call (no regeneration)', () => {
    registerDefaultProvider('claude');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'claude', CRED_OAUTH, 'sk-ant-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    const sub1 = engine.getOrCreateSubstitute('claude', {}, group);
    const sub2 = engine.getOrCreateSubstitute('claude', {}, group);
    expect(sub1).toBe(sub2);
  });

  it('returns null if no credential exists for the scope', () => {
    registerDefaultProvider('claude');
    const engine = new TokenSubstituteEngine(() => new MockResolver());
    const sub = engine.getOrCreateSubstitute('claude', {}, group);
    expect(sub).toBeNull();
  });

  it('returns null if the providerId is not registered as a substituting provider', () => {
    const resolver = new MockResolver();
    resolver.put(groupScope, 'mystery', CRED_OAUTH, 'sk-ant-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    // No registerDefaultProvider('mystery') — engine should refuse.
    const sub = engine.getOrCreateSubstitute('mystery', {}, group);
    expect(sub).toBeNull();
  });

  it('resolveWithRestriction enforces scopeAttrs match', () => {
    registerDefaultProvider('p');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'p', CRED_OAUTH, 'sk-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    const sub = engine.getOrCreateSubstitute('p', { tenant: 'acme' }, group)!;
    expect(engine.resolveWithRestriction(sub, group, { tenant: 'acme' })).not.toBeNull();
    expect(engine.resolveWithRestriction(sub, group, { tenant: 'other' })).toBeNull();
    expect(engine.resolveWithRestriction(sub, group, {})).not.toBeNull();
  });
});

describe('TokenSubstituteEngine — nested credential paths', () => {
  it('resolves nested sub-tokens (oauth/refresh)', () => {
    registerDefaultProvider('claude');
    const resolver = new MockResolver();
    resolver.putWithRefresh(
      groupScope,
      'claude',
      'oauth',
      'sk-ant-real-1234567890abcdef1234567890abcdef',
      'refresh-real-1234567890abcdef1234567890abcdef',
    );
    const engine = new TokenSubstituteEngine(() => resolver);
    const refreshSub = engine.getOrCreateSubstitute('claude', {}, group, 'oauth/refresh');
    expect(refreshSub).not.toBeNull();
    const resolved = engine.resolveSubstitute(refreshSub!, group);
    expect(resolved?.realToken).toBe('refresh-real-1234567890abcdef1234567890abcdef');
    expect(resolved?.mapping.credentialPath).toBe('oauth/refresh');
  });
});

describe('TokenSubstituteEngine — env names', () => {
  it('mergeEnvNames deduplicates and persists', () => {
    registerDefaultProvider('gh');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'gh', CRED_OAUTH, 'ghp_real_1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    const sub = engine.getOrCreateSubstitute('gh', {}, group, CRED_OAUTH, ['GH_TOKEN'])!;
    engine.mergeEnvNames(group, 'gh', sub, ['GITHUB_TOKEN', 'GH_TOKEN']);
    const envVars = engine.collectEnvVars(group);
    expect(envVars).toEqual({ GH_TOKEN: sub, GITHUB_TOKEN: sub });
  });
});

describe('TokenSubstituteEngine — drop and prune', () => {
  it('dropProviderSubstitutes clears in-memory and refs', () => {
    registerDefaultProvider('p');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'p', CRED_OAUTH, 'sk-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    engine.getOrCreateSubstitute('p', {}, group);
    expect(engine.size).toBe(1);
    engine.dropProviderSubstitutes(group, 'p');
    expect(engine.size).toBe(0);
  });

  it('pruneStaleRefs removes substitutes whose credential is gone', () => {
    registerDefaultProvider('p');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'p', CRED_OAUTH, 'sk-real-1234567890abcdef1234567890abcdef');
    const engine = new TokenSubstituteEngine(() => resolver);
    engine.getOrCreateSubstitute('p', {}, group);
    expect(engine.size).toBe(1);
    // Wipe credential, prune, expect substitute dropped
    (resolver as unknown as { creds: Map<string, Credential> }).creds.clear();
    engine.pruneStaleRefs(group, 'p');
    expect(engine.size).toBe(0);
  });
});

describe('TokenSubstituteEngine — refs persistence round-trip', () => {
  it('persists and reloads V4 refs file', () => {
    registerDefaultProvider('gh');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'gh', CRED_OAUTH, 'ghp_real_1234567890abcdef1234567890abcdef');

    const engine1 = new TokenSubstituteEngine(() => resolver);
    const sub = engine1.getOrCreateSubstitute('gh', { tenant: 'acme' }, group, CRED_OAUTH, ['GH_TOKEN'])!;

    const engine2 = new TokenSubstituteEngine(() => resolver);
    engine2.loadAllPersistedRefs();
    expect(engine2.size).toBe(1);
    const resolved = engine2.resolveSubstitute(sub, group);
    expect(resolved?.realToken).toBe('ghp_real_1234567890abcdef1234567890abcdef');
    expect(resolved?.mapping.scopeAttrs).toEqual({ tenant: 'acme' });
  });
});

describe('TokenSubstituteEngine — borrow / access check', () => {
  it('borrows from source scope when access is allowed', () => {
    registerDefaultProvider('gh');
    const resolver = new MockResolver();
    const sourceScope = asCredentialScope('source-group');
    resolver.put(sourceScope, 'gh', CRED_OAUTH, 'ghp_real_1234567890abcdef1234567890abcdef');

    const engine = new TokenSubstituteEngine(() => resolver);
    engine.setBorrowSourceResolver(() => 'source-group');
    engine.setAccessCheck(() => true);

    const sub = engine.getOrCreateSubstitute('gh', {}, group)!;
    const resolved = engine.resolveSubstitute(sub, group);
    expect(resolved?.realToken).toBe('ghp_real_1234567890abcdef1234567890abcdef');
    expect(resolved?.mapping.credentialScope).toBe(sourceScope);
  });

  it('returns null and drops the borrow when access is revoked', () => {
    registerDefaultProvider('gh');
    const resolver = new MockResolver();
    const sourceScope = asCredentialScope('source-group');
    resolver.put(sourceScope, 'gh', CRED_OAUTH, 'ghp_real_1234567890abcdef1234567890abcdef');

    const engine = new TokenSubstituteEngine(() => resolver);
    engine.setBorrowSourceResolver(() => 'source-group');
    let allowed = true;
    engine.setAccessCheck(() => allowed);

    const sub = engine.getOrCreateSubstitute('gh', {}, group)!;
    expect(engine.resolveSubstitute(sub, group)).not.toBeNull();

    allowed = false;
    expect(engine.resolveSubstitute(sub, group)).toBeNull();
    expect(engine.size).toBe(0);
  });

  // Regression: production (index.ts) wires only setBorrowSourceResolver, with
  // no engine-level accessCheck — the per-group resolver enforces canAccess on
  // every read. These two cover that exact configuration and the string|null →
  // undefined adapter shape used to plug in getBorrowSource. Before the wiring
  // fix, borrowSource was never set, so borrowed credentials never resolved.
  it('borrows with only borrowSource wired (no engine accessCheck), via a string|null resolver', () => {
    registerDefaultProvider('gh');
    const resolver = new MockResolver();
    const sourceScope = asCredentialScope('source-group');
    resolver.put(sourceScope, 'gh', CRED_OAUTH, 'ghp_borrowed_1234567890abcdef1234567890');

    const engine = new TokenSubstituteEngine(() => resolver);
    // Mirror production: getBorrowSource returns string | null; the wiring
    // adapter coerces null → undefined. No setAccessCheck call.
    const getBorrowSourceStub = (folder: string): string | null =>
      folder === (group as unknown as string) ? 'source-group' : null;
    engine.setBorrowSourceResolver((gs) => getBorrowSourceStub(gs as unknown as string) ?? undefined);

    const sub = engine.getOrCreateSubstitute('gh', {}, group)!;
    const resolved = engine.resolveSubstitute(sub, group);
    expect(resolved?.realToken).toBe('ghp_borrowed_1234567890abcdef1234567890');
    expect(resolved?.mapping.credentialScope).toBe(sourceScope);
  });

  it('falls back to own scope when the borrow-source resolver yields nothing', () => {
    registerDefaultProvider('gh');
    const resolver = new MockResolver();
    resolver.put(groupScope, 'gh', CRED_OAUTH, 'ghp_own_1234567890abcdef1234567890ab');

    const engine = new TokenSubstituteEngine(() => resolver);
    // getBorrowSource returns null for a group with no `borrowed` link.
    engine.setBorrowSourceResolver(() => (null as string | null) ?? undefined);

    const sub = engine.getOrCreateSubstitute('gh', {}, group)!;
    const resolved = engine.resolveSubstitute(sub, group);
    expect(resolved?.realToken).toBe('ghp_own_1234567890abcdef1234567890ab');
    expect(resolved?.mapping.credentialScope).toBe(groupScope);
  });
});
