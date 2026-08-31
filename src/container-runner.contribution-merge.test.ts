/**
 * The provider-contribution seam.
 *
 * One provider name can carry two contribution sources — its credential
 * provider's AGENT_RUNTIME extension and its entry in the provider-container
 * registry. Both must always be applied: the agent-surfaces capability is read
 * from the registry entry, so a provider served only its runtime extension
 * gets neither its own surfaces nor the defaults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { ContainerConfig } from './container-config.js';
import { resolveProviderContribution } from './container-runner.js';
import { AGENT_RUNTIME } from './modules/credentials/index.js';
import {
  registerCredentialProvider,
  _resetProviderRegistryForTests,
} from './modules/credentials/providers/registry.js';
import {
  registerProviderContainerConfig,
  resetProviderContainerConfigsForTest,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { FatalSpawnError } from './spawn-failure.js';
import type { AgentGroup, Session } from './types.js';

const PROVIDER = 'merge-test-provider';

const session = { id: 's-merge', agent_group_id: 'ag-merge', agent_provider: PROVIDER } as Session;
const agentGroup = { id: 'ag-merge', name: 'merge', folder: 'merge' } as AgentGroup;
const containerConfig = { skills: 'all' } as ContainerConfig;

const runtimeMount: VolumeMount = { hostPath: '/host/runtime', containerPath: '/c/runtime', readonly: true };
const registryMount: VolumeMount = { hostPath: '/host/registry', containerPath: '/c/registry', readonly: false };

/** Register a credential provider whose AGENT_RUNTIME extension contributes. */
function registerRuntime(contribution: () => { env?: Record<string, string>; mounts?: VolumeMount[] }): void {
  registerCredentialProvider({
    id: PROVIDER,
    getExtension: (key: unknown) =>
      key === AGENT_RUNTIME
        ? { parseRuntimeConfig: (raw: unknown) => raw, containerContribution: contribution }
        : undefined,
  } as never);
}

beforeEach(() => {
  _resetProviderRegistryForTests();
  resetProviderContainerConfigsForTest();
});

afterEach(() => {
  _resetProviderRegistryForTests();
  resetProviderContainerConfigsForTest();
});

describe('resolveProviderContribution source merge', () => {
  it('applies both sources for a provider that registers each', async () => {
    registerRuntime(() => ({ env: { FROM_RUNTIME: '1' }, mounts: [runtimeMount] }));
    registerProviderContainerConfig(PROVIDER, () => ({ env: { FROM_REGISTRY: '1' }, mounts: [registryMount] }));

    const { contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

    expect(contribution.env).toEqual({ FROM_RUNTIME: '1', FROM_REGISTRY: '1' });
    expect(contribution.mounts).toEqual([runtimeMount, registryMount]);
  });

  it('behaves as before for a provider with only a runtime extension', async () => {
    registerRuntime(() => ({ env: { FROM_RUNTIME: '1' }, mounts: [runtimeMount] }));

    const { contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

    expect(contribution.env).toEqual({ FROM_RUNTIME: '1' });
    expect(contribution.mounts).toEqual([runtimeMount]);
  });

  it('behaves as before for a provider with only a registry entry', async () => {
    registerProviderContainerConfig(PROVIDER, () => ({ env: { FROM_REGISTRY: '1' }, mounts: [registryMount] }));

    const { contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

    expect(contribution.env).toEqual({ FROM_REGISTRY: '1' });
    expect(contribution.mounts).toEqual([registryMount]);
  });

  // The runtime source's env values are the per-group credential substitutes the
  // proxy matches on, so a registry entry must never shadow one.
  it('keeps the runtime value when both sources set the same env key', async () => {
    registerRuntime(() => ({ env: { SHARED: 'runtime-substitute' } }));
    registerProviderContainerConfig(PROVIDER, () => ({ env: { SHARED: 'registry-placeholder', OTHER: '1' } }));

    const { contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

    expect(contribution.env).toEqual({ SHARED: 'runtime-substitute', OTHER: '1' });
  });

  it('contributes nothing for a provider that registers neither', async () => {
    const { contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

    expect(contribution.env).toBeUndefined();
    expect(contribution.mounts).toBeUndefined();
  });
});

describe('resolveProviderContribution failure handling', () => {
  // Left unwrapped, a throw here reads as a transient spawn error: host-sweep
  // re-wakes the session every 60s forever without incrementing the attempt
  // count, so a deterministic bug becomes an infinite quiet retry.
  it('fails the spawn fatally when the runtime contribution throws', async () => {
    registerRuntime(() => {
      throw new Error('runtime boom');
    });

    await expect(resolveProviderContribution(session, agentGroup, containerConfig)).rejects.toThrow(FatalSpawnError);
  });

  it('fails the spawn fatally when the registry contribution throws', async () => {
    registerProviderContainerConfig(PROVIDER, () => {
      throw new Error('registry boom');
    });

    await expect(resolveProviderContribution(session, agentGroup, containerConfig)).rejects.toThrow(FatalSpawnError);
  });

  // A contribution does real I/O — the default provider writes its substitute
  // file on every OAuth-mode spawn — so an errno the next attempt may clear has
  // to stay retryable. Wrapping it would poison the session until the user sends
  // another message.
  it('leaves a transient errno retryable instead of poisoning the spawn', async () => {
    registerRuntime(() => {
      throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    });

    await expect(resolveProviderContribution(session, agentGroup, containerConfig)).rejects.toThrow(
      'too many open files',
    );
    await expect(resolveProviderContribution(session, agentGroup, containerConfig)).rejects.not.toThrow(
      FatalSpawnError,
    );
  });

  it('names the failing source and preserves the cause', async () => {
    registerProviderContainerConfig(PROVIDER, () => {
      throw new Error('registry boom');
    });

    try {
      await resolveProviderContribution(session, agentGroup, containerConfig);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(PROVIDER);
      expect((err as Error).message).toContain('registry boom');
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
    }
  });
});
