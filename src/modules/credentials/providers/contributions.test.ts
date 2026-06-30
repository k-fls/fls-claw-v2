import { describe, it, expect } from 'vitest';
import {
  mergeContributions,
  type ContainerContributionCtx,
  type ContainerContributionResult,
  type ContainerContributor,
} from './contributions.js';
import { asGroupScope } from '../types.js';

const ctx = (over: Partial<ContainerContributionCtx> = {}): ContainerContributionCtx => ({
  agentGroupId: 'g1',
  groupScope: asGroupScope('group-a'),
  sessionDir: '/sessions/s1',
  hostEnv: {},
  runtimeConfig: {},
  agentProvider: undefined,
  providerVersion: undefined,
  ...over,
});

describe('mergeContributions', () => {
  it('folds env (later wins) and concatenates mounts; same type in and out', () => {
    const parts: ContainerContributionResult[] = [
      {
        env: { ANTHROPIC_BASE_URL: 'x', SHARED: 'base' },
        mounts: [{ hostPath: '/a', containerPath: '/a', readonly: true }],
      },
      { env: { SHARED: 'override' }, mounts: [{ hostPath: '/b', containerPath: '/b', readonly: false }] },
    ];
    const merged = mergeContributions(parts);
    expect(merged.env).toEqual({ ANTHROPIC_BASE_URL: 'x', SHARED: 'override' });
    expect(merged.mounts).toHaveLength(2);
    expect(merged.cliVersion).toBeUndefined();
  });

  it('keeps the first non-null cliVersion a contributor reports', () => {
    const merged = mergeContributions([{ env: {} }, { cliVersion: '2.1.154' }, { cliVersion: '9.9.9' }]);
    expect(merged.cliVersion).toBe('2.1.154');
  });

  it('omits empty env/mounts/cliVersion so spawn sees a clean object', () => {
    expect(mergeContributions([{}, {}])).toEqual({});
  });

  it('composes a set of contributor calls — each reads ctx fields additively', () => {
    const baseUrl: ContainerContributor = () => ({ env: { ANTHROPIC_BASE_URL: 'x' } });
    const cliMount: ContainerContributor = (c) =>
      c.providerVersion
        ? { cliVersion: c.providerVersion, mounts: [{ hostPath: '/cli', containerPath: '/cli', readonly: true }] }
        : {};

    const merged = mergeContributions([baseUrl(ctx()), cliMount(ctx({ providerVersion: '2.1.154' }))]);
    expect(merged.env).toEqual({ ANTHROPIC_BASE_URL: 'x' });
    expect(merged.cliVersion).toBe('2.1.154');
    expect(merged.mounts).toHaveLength(1);
  });
});
