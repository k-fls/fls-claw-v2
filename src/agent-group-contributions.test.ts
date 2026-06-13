import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentGroupContributionContext,
  clearAgentGroupContributions,
  invokeAgentGroupContributions,
  registerAgentGroupContribution,
} from './agent-group-contributions.js';
import { log } from './log.js';
import { FatalSpawnError } from './spawn-failure.js';
import type { AgentGroup, Session } from './types.js';

const agentGroup: AgentGroup = {
  id: 'ag1',
  name: 'Test',
  folder: 'test',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00Z',
};

const session: Session = {
  id: 's1',
  agent_group_id: 'ag1',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01T00:00:00Z',
};

function ctx(): AgentGroupContributionContext {
  return { agentGroup, session, hostEnv: { FOO: 'bar' } as NodeJS.ProcessEnv };
}

beforeEach(() => {
  clearAgentGroupContributions();
});

afterEach(() => {
  clearAgentGroupContributions();
  vi.restoreAllMocks();
});

describe('invokeAgentGroupContributions', () => {
  it('returns empty when nothing is registered', () => {
    const out = invokeAgentGroupContributions(ctx());
    expect(out.env).toEqual({});
    expect(out.mounts).toEqual([]);
  });

  it('passes a single contribution through unchanged', () => {
    registerAgentGroupContribution('one', () => ({
      env: { A: '1' },
      mounts: [{ hostPath: '/h', containerPath: '/c', readonly: true }],
    }));
    const out = invokeAgentGroupContributions(ctx());
    expect(out.env).toEqual({ A: '1' });
    expect(out.mounts).toEqual([{ hostPath: '/h', containerPath: '/c', readonly: true }]);
  });

  it('concatenates mounts in registration order', () => {
    registerAgentGroupContribution('first', () => ({
      mounts: [{ hostPath: '/h1', containerPath: '/c1', readonly: false }],
    }));
    registerAgentGroupContribution('second', () => ({
      mounts: [{ hostPath: '/h2', containerPath: '/c2', readonly: true }],
    }));
    const out = invokeAgentGroupContributions(ctx());
    expect(out.mounts).toEqual([
      { hostPath: '/h1', containerPath: '/c1', readonly: false },
      { hostPath: '/h2', containerPath: '/c2', readonly: true },
    ]);
  });

  it('merges env last-write-wins and logs collisions', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    registerAgentGroupContribution('first', () => ({ env: { K: 'v1', UNIQUE: 'u' } }));
    registerAgentGroupContribution('second', () => ({ env: { K: 'v2' } }));
    const out = invokeAgentGroupContributions(ctx());
    expect(out.env).toEqual({ K: 'v2', UNIQUE: 'u' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, payload] = warnSpy.mock.calls[0];
    expect(payload).toMatchObject({ key: 'K', priorId: 'first', priorValue: 'v1', newId: 'second', newValue: 'v2' });
  });

  it('does not log a collision when both contributions set the same value', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    registerAgentGroupContribution('first', () => ({ env: { K: 'same' } }));
    registerAgentGroupContribution('second', () => ({ env: { K: 'same' } }));
    invokeAgentGroupContributions(ctx());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws FatalSpawnError annotated with the contributing id when a callback throws', () => {
    registerAgentGroupContribution('ok', () => ({}));
    registerAgentGroupContribution('bad', () => {
      throw new Error('proxy URL not configured');
    });
    let caught: unknown;
    try {
      invokeAgentGroupContributions(ctx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FatalSpawnError);
    expect((caught as FatalSpawnError).message).toContain('bad');
    expect((caught as FatalSpawnError).message).toContain('proxy URL not configured');
    expect((caught as FatalSpawnError).cause).toBeInstanceOf(Error);
  });
});

describe('registerAgentGroupContribution', () => {
  it('throws on duplicate id', () => {
    registerAgentGroupContribution('x', () => ({}));
    expect(() => registerAgentGroupContribution('x', () => ({}))).toThrow(/already registered: x/);
  });
});

describe('clearAgentGroupContributions', () => {
  it('empties the registry', () => {
    registerAgentGroupContribution('x', () => ({ env: { K: 'v' } }));
    clearAgentGroupContributions();
    expect(invokeAgentGroupContributions(ctx()).env).toEqual({});
  });
});
