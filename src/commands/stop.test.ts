import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { HostCommandContext } from '../command-gate.js';

const h = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; status: string }>,
  running: new Set<string>(),
  killed: [] as string[],
}));

// stop.ts calls registerHostCommand at import time — make it a no-op.
vi.mock('../command-gate.js', () => ({ registerHostCommand: () => {} }));
vi.mock('../container-runner.js', () => ({
  isContainerRunning: (id: string) => h.running.has(id),
  killContainer: (id: string) => h.killed.push(id),
}));
vi.mock('../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => h.sessions,
}));
vi.mock('../log.js', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }));

import { handleStopCommand } from './stop.js';

function run(agentGroupId: string | null): string[] {
  const replies: string[] = [];
  handleStopCommand({
    agentGroupId,
    args: [],
    replyText: (t: string) => replies.push(t),
  } as unknown as HostCommandContext);
  return replies;
}

beforeEach(() => {
  h.sessions = [];
  h.running = new Set();
  h.killed = [];
});

describe('/stop command', () => {
  it('rejects when no agent group is resolved', () => {
    expect(run(null)[0]).toMatch(/must be invoked against an agent group/);
    expect(h.killed).toEqual([]);
  });

  it('reports when nothing is running', () => {
    h.sessions = [{ id: 's1', status: 'active' }];
    // s1 not in running set
    expect(run('g1')[0]).toBe('No agent running.');
    expect(h.killed).toEqual([]);
  });

  it('kills every running active container for the group', () => {
    h.sessions = [
      { id: 's1', status: 'active' },
      { id: 's2', status: 'active' },
      { id: 's3', status: 'closed' },
    ];
    h.running = new Set(['s1', 's2', 's3']);
    const replies = run('g1');
    expect(h.killed.sort()).toEqual(['s1', 's2']); // s3 is not active
    expect(replies[0]).toBe('Stopping agent.');
  });

  it('ignores active sessions whose container is not running', () => {
    h.sessions = [
      { id: 's1', status: 'active' },
      { id: 's2', status: 'active' },
    ];
    h.running = new Set(['s2']);
    run('g1');
    expect(h.killed).toEqual(['s2']);
  });
});
