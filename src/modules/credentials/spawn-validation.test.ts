import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { FatalSpawnError } from '../../spawn-failure.js';
import { validateRuntimeCredentials, runtimeFor } from './spawn-validation.js';
import {
  registerCredentialProvider,
  _resetProviderRegistryForTests,
  type CredentialProvider,
} from './providers/registry.js';
import { ExtensionBag, AGENT_RUNTIME, type AgentRuntimeExt } from './providers/types.js';

function fakeRuntime(
  required: Array<{ id: string; required: boolean }>,
  parse: (raw: unknown) => unknown = (r) => r,
): AgentRuntimeExt {
  return {
    containerContribution: () => ({}),
    requiredCredentialProviders: () => required,
    parseRuntimeConfig: parse,
  };
}

describe('validateRuntimeCredentials', () => {
  it('is a no-op when the provider declares no agent-runtime extension', () => {
    expect(() =>
      validateRuntimeCredentials({
        providerName: 'claude',
        runtimeConfigRaw: {},
        getRuntime: () => undefined,
        hasProvider: () => {
          throw new Error('hasProvider must not be consulted without a runtime');
        },
      }),
    ).not.toThrow();
  });

  it('passes when all required credential providers are bound', () => {
    expect(() =>
      validateRuntimeCredentials({
        providerName: 'claude',
        runtimeConfigRaw: {},
        getRuntime: () => fakeRuntime([{ id: 'claude', required: true }]),
        hasProvider: (id) => id === 'claude',
      }),
    ).not.toThrow();
  });

  it('throws FatalSpawnError naming only the missing required providers', () => {
    let err: unknown;
    try {
      validateRuntimeCredentials({
        providerName: 'opencode',
        runtimeConfigRaw: {},
        getRuntime: () =>
          fakeRuntime([
            { id: 'anthropic', required: true },
            { id: 'deepseek', required: true },
          ]),
        hasProvider: (id) => id === 'anthropic',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FatalSpawnError);
    expect((err as Error).message).toContain('deepseek');
    expect((err as Error).message).not.toContain('anthropic'); // bound → not listed
  });

  it('does not hard-fail a missing required provider that a broker supplies (C3)', () => {
    expect(() =>
      validateRuntimeCredentials({
        providerName: 'claude',
        runtimeConfigRaw: {},
        getRuntime: () => fakeRuntime([{ id: 'claude', required: true }]),
        hasProvider: () => false, // not bound natively
        brokerSupplies: (id) => id === 'claude', // but the broker overtakes it
      }),
    ).not.toThrow();
  });

  it('still fails when neither native nor a broker supplies a required provider', () => {
    expect(() =>
      validateRuntimeCredentials({
        providerName: 'claude',
        runtimeConfigRaw: {},
        getRuntime: () => fakeRuntime([{ id: 'claude', required: true }]),
        hasProvider: () => false,
        brokerSupplies: (id) => id === 'something-else',
      }),
    ).toThrow(FatalSpawnError);
  });

  it('ignores optional (required:false) providers that are missing', () => {
    expect(() =>
      validateRuntimeCredentials({
        providerName: 'opencode',
        runtimeConfigRaw: {},
        getRuntime: () => fakeRuntime([{ id: 'openrouter', required: false }]),
        hasProvider: () => false,
      }),
    ).not.toThrow();
  });

  it('parses runtimeConfig and threads the parsed value to requiredCredentialProviders', () => {
    const seen: unknown[] = [];
    const rt: AgentRuntimeExt = {
      containerContribution: () => ({}),
      parseRuntimeConfig: () => ({ parsed: true }),
      requiredCredentialProviders: (cfg) => {
        seen.push(cfg);
        return [];
      },
    };
    validateRuntimeCredentials({
      providerName: 'x',
      runtimeConfigRaw: { raw: 1 },
      getRuntime: () => rt,
      hasProvider: () => true,
    });
    expect(seen).toEqual([{ parsed: true }]);
  });

  it('propagates a parseRuntimeConfig throw (the lifecycle dispatcher wraps it as FatalSpawnError)', () => {
    const rt: AgentRuntimeExt = {
      containerContribution: () => ({}),
      parseRuntimeConfig: () => {
        throw new Error('bad runtime config');
      },
      requiredCredentialProviders: () => [],
    };
    expect(() =>
      validateRuntimeCredentials({
        providerName: 'x',
        runtimeConfigRaw: {},
        getRuntime: () => rt,
        hasProvider: () => true,
      }),
    ).toThrow('bad runtime config');
  });
});

describe('runtimeFor (registry → extension wiring)', () => {
  beforeEach(() => _resetProviderRegistryForTests());
  afterEach(() => _resetProviderRegistryForTests());

  function credProvider(id: string, ext?: AgentRuntimeExt): CredentialProvider {
    const bag = new ExtensionBag();
    if (ext) bag.set(AGENT_RUNTIME, ext);
    return {
      id,
      buildManifest: () => [],
      onManifestWritten: () => {},
      onManifestDeleted: () => {},
      ...(ext ? { getExtension: bag.get } : {}),
    };
  }

  it('resolves the AGENT_RUNTIME extension from a registered provider', () => {
    const rt = fakeRuntime([{ id: 'claude', required: true }]);
    registerCredentialProvider(credProvider('claude', rt));
    expect(runtimeFor('claude')).toBe(rt);
  });

  it('returns undefined for a registered provider without the extension', () => {
    registerCredentialProvider(credProvider('plain'));
    expect(runtimeFor('plain')).toBeUndefined();
  });

  it('returns undefined for an unregistered provider', () => {
    expect(runtimeFor('nope')).toBeUndefined();
  });
});
