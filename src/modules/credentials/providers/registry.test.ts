import { afterEach, describe, expect, it } from 'vitest';

import type { CredentialScope } from '../types.js';

import {
  _resetProviderRegistryForTests,
  clearScopedCredentialProviders,
  getAllCredentialProviders,
  getCredentialProvider,
  registerCredentialProvider,
  setScopedCredentialProviders,
  type CredentialProvider,
} from './registry.js';
import { asCredentialScope } from '../types.js';
import { AGENT_RUNTIME, CONTAINER_FEEDBACK, ExtensionBag, type AgentRuntimeExt } from './types.js';
import { REAUTH } from '../reauth.js';

function cred(id: string, getExtension?: CredentialProvider['getExtension']): CredentialProvider {
  return {
    id,
    buildManifest: (_s: CredentialScope) => [],
    onManifestWritten: (_s: CredentialScope) => {},
    onManifestDeleted: (_s: CredentialScope) => {},
    getExtension,
  };
}

afterEach(() => _resetProviderRegistryForTests());

describe('credential provider registry', () => {
  it('round-trips a provider', () => {
    const c = cred('github');
    registerCredentialProvider(c);
    expect(getCredentialProvider('github')).toBe(c);
    expect(getAllCredentialProviders()).toContain(c);
  });

  it('throws on duplicate id', () => {
    registerCredentialProvider(cred('y'));
    expect(() => registerCredentialProvider(cred('y'))).toThrow(/already registered/);
  });
});

describe('per-scope provider tier', () => {
  const A = asCredentialScope('group-a');
  const B = asCredentialScope('group-b');

  it('resolves a scoped provider only within its scope', () => {
    const p = cred('per-group');
    setScopedCredentialProviders(A, [p]);
    expect(getCredentialProvider('per-group', A)).toBe(p);
    expect(getCredentialProvider('per-group', B)).toBeUndefined();
    expect(getCredentialProvider('per-group')).toBeUndefined(); // not global
  });

  it('falls back to global when the scope tier misses', () => {
    const g = cred('global-one');
    registerCredentialProvider(g);
    setScopedCredentialProviders(A, [cred('local-only')]);
    expect(getCredentialProvider('global-one', A)).toBe(g); // scope miss → global
  });

  it('scope tier shadows a same-id global provider', () => {
    const g = cred('shared');
    const local = cred('shared');
    registerCredentialProvider(g);
    setScopedCredentialProviders(A, [local]);
    expect(getCredentialProvider('shared', A)).toBe(local); // scope wins
    expect(getCredentialProvider('shared')).toBe(g); // global unaffected
    expect(getCredentialProvider('shared', B)).toBe(g); // other scope → global
  });

  it('getAllCredentialProviders(scope) merges global with the scope tier (scope shadows)', () => {
    const g = cred('shared');
    const gOnly = cred('global-only');
    const local = cred('shared');
    const localOnly = cred('local-only');
    registerCredentialProvider(g);
    registerCredentialProvider(gOnly);
    setScopedCredentialProviders(A, [local, localOnly]);

    const all = getAllCredentialProviders(A);
    expect(all).toContain(gOnly);
    expect(all).toContain(localOnly);
    expect(all).toContain(local); // shadowed id resolves to the scoped one
    expect(all).not.toContain(g);
    // No scope → global only, untouched by the scope tier.
    expect(getAllCredentialProviders()).toEqual([g, gOnly]);
  });

  it('replaces (does not accumulate) on re-set and never throws on duplicate id', () => {
    const first = cred('repeat');
    const second = cred('repeat');
    setScopedCredentialProviders(A, [first]);
    expect(() => setScopedCredentialProviders(A, [second])).not.toThrow();
    expect(getCredentialProvider('repeat', A)).toBe(second);
  });

  it('an empty list clears the scope tier', () => {
    setScopedCredentialProviders(A, [cred('gone')]);
    setScopedCredentialProviders(A, []);
    expect(getCredentialProvider('gone', A)).toBeUndefined();
  });

  it('clearScopedCredentialProviders drops the tier without touching others', () => {
    setScopedCredentialProviders(A, [cred('a-only')]);
    setScopedCredentialProviders(B, [cred('b-only')]);
    clearScopedCredentialProviders(A);
    expect(getCredentialProvider('a-only', A)).toBeUndefined();
    expect(getCredentialProvider('b-only', B)).toBeDefined();
  });
});

describe('provider extensions via getExtension', () => {
  const runtime: AgentRuntimeExt = {
    containerContribution: () => ({}),
    requiredCredentialProviders: () => [{ id: 'claude', required: true }],
    parseRuntimeConfig: (raw) => raw,
  };

  it('returns a declared extension by typed key', () => {
    const ext = new ExtensionBag().set(AGENT_RUNTIME, runtime);
    registerCredentialProvider(cred('claude', ext.get));
    const p = getCredentialProvider('claude');
    expect(p?.getExtension?.(AGENT_RUNTIME)).toBe(runtime);
    expect(p?.getExtension?.(AGENT_RUNTIME)?.requiredCredentialProviders({})).toEqual([
      { id: 'claude', required: true },
    ]);
  });

  it('returns undefined for an undeclared extension', () => {
    const ext = new ExtensionBag().set(AGENT_RUNTIME, runtime);
    registerCredentialProvider(cred('claude', ext.get));
    expect(getCredentialProvider('claude')?.getExtension?.(REAUTH)).toBeUndefined();
    expect(getCredentialProvider('claude')?.getExtension?.(CONTAINER_FEEDBACK)).toBeUndefined();
  });

  it('a provider without getExtension is handled by optional-chaining', () => {
    registerCredentialProvider(cred('plain'));
    expect(getCredentialProvider('plain')?.getExtension?.(AGENT_RUNTIME)).toBeUndefined();
  });
});
