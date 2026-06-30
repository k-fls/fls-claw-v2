/**
 * Binding-aware `/creds import` planner (I2 reverse index).
 *
 * Verifies `planImport`: reverse-index attribution of un-prefixed ALL_CAPS
 * env-var names, binding-aware credentialPath resolution, composite joining,
 * ambiguity / unknown-provider handling, and the single-provider form.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerCredentialProvider,
  setScopedCredentialProviders,
  _resetProviderRegistryForTests,
} from '../credentials/providers/registry.js';

import { defaultSubstitutes, type DefaultSubstitutesInput } from './defaults.js';
import { planImport } from './import-planning.js';
import type { ImportToken } from '../credentials/import-resolver.js';
import { asCredentialScope, type CredentialScope, type SubstitutingProvider } from './types.js';

function makeProvider(id: string, input: DefaultSubstitutesInput): SubstitutingProvider {
  return {
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: defaultSubstitutes(input),
  };
}

function register(id: string, input: DefaultSubstitutesInput): void {
  registerCredentialProvider(makeProvider(id, input));
}

function registerScoped(scope: CredentialScope, id: string, input: DefaultSubstitutesInput): void {
  setScopedCredentialProviders(scope, [makeProvider(id, input)]);
}

const tok = (prefix: string | null, key: string, value: string, line = 1): ImportToken => ({
  prefix,
  key,
  value,
  line,
});

beforeEach(() => _resetProviderRegistryForTests());
afterEach(() => _resetProviderRegistryForTests());

describe('planImport — reverse index (bulk mode)', () => {
  it('auto-resolves an un-prefixed ALL_CAPS env name to its provider + credentialPath', () => {
    register('github', { envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }] });

    const plan = planImport([tok(null, 'GH_TOKEN', 'ghp_abc')], null);
    expect(plan.stores).toEqual([{ providerId: 'github', credentialId: 'oauth', value: 'ghp_abc' }]);
    expect(plan.envVarsByProvider.github).toEqual(['GH_TOKEN']);
    expect(plan.warnings).toEqual([]);
  });

  it('warns and skips when an env name is declared by more than one provider', () => {
    register('a', { envBindings: [{ envName: 'API_TOKEN', credentialPath: 'oauth' }] });
    register('b', { envBindings: [{ envName: 'API_TOKEN', credentialPath: 'oauth' }] });

    const plan = planImport([tok(null, 'API_TOKEN', 'v')], null);
    expect(plan.stores).toEqual([]);
    expect(plan.warnings.some((w) => /ambiguous env var API_TOKEN/.test(w))).toBe(true);
  });

  it('warns and skips an un-prefixed key matching no binding', () => {
    register('github', { envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }] });

    const plan = planImport([tok(null, 'MYSTERY_TOKEN', 'v')], null);
    expect(plan.stores).toEqual([]);
    expect(plan.warnings.some((w) => /no provider: MYSTERY_TOKEN/.test(w))).toBe(true);
  });

  it('joins composite (sliced) env vars into one credential via sep', () => {
    register('browserstack', {
      credentialFormat: { access_key: { sep: ':' } },
      envBindings: [
        { envName: 'BROWSERSTACK_USERNAME', credentialPath: 'access_key', slice: 0 },
        { envName: 'BROWSERSTACK_ACCESS_KEY', credentialPath: 'access_key', slice: 1 },
      ],
    });

    const plan = planImport(
      [tok(null, 'BROWSERSTACK_USERNAME', 'alice'), tok(null, 'BROWSERSTACK_ACCESS_KEY', 'secret')],
      null,
    );
    expect(plan.stores).toEqual([{ providerId: 'browserstack', credentialId: 'access_key', value: 'alice:secret' }]);
  });

  it('warns when a composite credential is incomplete', () => {
    register('browserstack', {
      credentialFormat: { access_key: { sep: ':' } },
      envBindings: [
        { envName: 'BROWSERSTACK_USERNAME', credentialPath: 'access_key', slice: 0 },
        { envName: 'BROWSERSTACK_ACCESS_KEY', credentialPath: 'access_key', slice: 1 },
      ],
    });

    const plan = planImport([tok(null, 'BROWSERSTACK_USERNAME', 'alice')], null);
    expect(plan.stores).toEqual([]);
    expect(plan.warnings.some((w) => /incomplete.*BROWSERSTACK_ACCESS_KEY/.test(w))).toBe(true);
  });

  it('collects an unknown provider prefix instead of storing', () => {
    const plan = planImport([tok('ghost', 'oauth', 'v')], null);
    expect(plan.stores).toEqual([]);
    expect(plan.unknownProviders).toEqual(['ghost']);
  });
});

describe('planImport — single-provider form', () => {
  it('attributes un-prefixed lines to the default provider, storing under the literal key', () => {
    register('github', { envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }] });

    // Un-prefixed non-env-name key under an explicit default → literal credentialId.
    const plan = planImport([tok(null, 'mykey', 'v')], 'github');
    expect(plan.stores).toEqual([{ providerId: 'github', credentialId: 'mykey', value: 'v' }]);
  });

  it('resolves an env-name key to its binding credentialPath even with a default provider', () => {
    register('github', { envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }] });

    const plan = planImport([tok(null, 'GH_TOKEN', 'ghp_abc')], 'github');
    expect(plan.stores).toEqual([{ providerId: 'github', credentialId: 'oauth', value: 'ghp_abc' }]);
  });

  it('ignores a line explicitly prefixed for a different provider', () => {
    register('github', { envBindings: [] });
    register('gitlab', { envBindings: [] });

    const plan = planImport([tok('gitlab', 'oauth', 'v')], 'github');
    expect(plan.stores).toEqual([]);
    expect(plan.warnings.some((w) => /ignored \(gitlab ≠ github\)/.test(w))).toBe(true);
  });

  it('never echoes the secret value in skip warnings (rendered back to chat)', () => {
    register('github', { envBindings: [] });
    register('gitlab', { envBindings: [] });

    const SECRET = 'sk-super-secret-token-value';

    // "no provider" path — bulk mode, un-prefixed key matching no binding.
    const bulk = planImport([tok(null, 'MYSTERY_TOKEN', SECRET, 4)], null);
    expect(bulk.stores).toEqual([]);
    // Warning cites the key + source line number, never the value.
    expect(bulk.warnings.some((w) => /no provider: MYSTERY_TOKEN \(line 4\)/.test(w))).toBe(true);
    expect(bulk.warnings.some((w) => w.includes(SECRET))).toBe(false);

    // "ignored" path — single-provider mode, line prefixed for another provider.
    const single = planImport([tok('gitlab', 'oauth', SECRET, 7)], 'github');
    expect(single.stores).toEqual([]);
    expect(single.warnings.some((w) => /ignored \(gitlab ≠ github\): oauth \(line 7\)/.test(w))).toBe(true);
    expect(single.warnings.some((w) => w.includes(SECRET))).toBe(false);
  });
});

describe('planImport — scope-aware (per-group providers)', () => {
  const A = asCredentialScope('group-a');

  it('reverse-index resolves a per-group provider only when its scope is passed', () => {
    registerScoped(A, 'grp', { envBindings: [{ envName: 'GRP_TOKEN', credentialPath: 'oauth' }] });

    const withScope = planImport([tok(null, 'GRP_TOKEN', 'v')], null, A);
    expect(withScope.stores).toEqual([{ providerId: 'grp', credentialId: 'oauth', value: 'v' }]);

    // No scope ⇒ the per-group binding is invisible (global tier only).
    const noScope = planImport([tok(null, 'GRP_TOKEN', 'v')], null);
    expect(noScope.stores).toEqual([]);
    expect(noScope.warnings.some((w) => /no provider: GRP_TOKEN/.test(w))).toBe(true);
  });

  it('a prefixed per-group provider is unknown without its scope, resolved with it', () => {
    registerScoped(A, 'grp', { envBindings: [] });

    expect(planImport([tok('grp', 'oauth', 'v')], 'grp').unknownProviders).toEqual(['grp']);
    expect(planImport([tok('grp', 'oauth', 'v')], 'grp', A).stores).toEqual([
      { providerId: 'grp', credentialId: 'oauth', value: 'v' },
    ]);
  });
});
