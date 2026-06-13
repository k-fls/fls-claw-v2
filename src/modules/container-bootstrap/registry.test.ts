/**
 * Tests for the container-lifecycle observer registry + dispatchers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { FatalSpawnError } from '../../spawn-failure.js';
import { clearContainerLifecycleObservers, registerContainerLifecycleObserver } from './registry.js';
import { fireContainerExited, fireContainerStarted, fireSpawnPre } from './fire.js';
import type { ExitContext, LifecycleContext, SpawnPreContext, SpawnPreResult } from './types.js';
import type { AgentGroup, Session } from '../../types.js';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mkCtx = (): SpawnPreContext => ({
  agentGroup: { id: 'ag-1', folder: 'ag-1', name: 'ag', agent_provider: null } as unknown as AgentGroup,
  session: { id: 'sess-1', agent_group_id: 'ag-1' } as unknown as Session,
});

const mkLifeCtx = (): LifecycleContext => ({ ...mkCtx(), containerName: 'c1' });
const mkExitCtx = (): ExitContext => ({ ...mkLifeCtx(), exitCode: 0, reason: 'normal' });

beforeEach(() => clearContainerLifecycleObservers());

describe('registry', () => {
  it('duplicate id throws', () => {
    registerContainerLifecycleObserver('a', {});
    expect(() => registerContainerLifecycleObserver('a', {})).toThrow(/already registered/);
  });

  it('empty registry: fire functions are no-ops, merged result is empty', () => {
    const merged = fireSpawnPre(mkCtx());
    expect(merged).toEqual({
      mounts: [],
      env: {},
      args: [],
      needsRootEntrypoint: false,
      cleanups: [],
    });
    expect(() => fireContainerStarted(mkLifeCtx())).not.toThrow();
    expect(() => fireContainerExited(mkExitCtx())).not.toThrow();
  });
});

describe('fireSpawnPre', () => {
  it('dispatches in registration order, merges mounts/args/env/needsRoot/cleanup', () => {
    const order: string[] = [];
    registerContainerLifecycleObserver('a', {
      onSpawnPre(): SpawnPreResult {
        order.push('a');
        return {
          mounts: [{ hostPath: '/a', containerPath: '/A', readonly: true }],
          args: ['--from-a'],
          env: { K1: 'a', K2: 'a' },
          cleanup: () => order.push('cleanup-a'),
        };
      },
    });
    registerContainerLifecycleObserver('b', {
      onSpawnPre(): SpawnPreResult {
        order.push('b');
        return {
          mounts: [{ hostPath: '/b', containerPath: '/B', readonly: false }],
          args: ['--from-b'],
          env: { K2: 'b', K3: 'b' }, // K2 collides
          needsRootEntrypoint: true,
          cleanup: () => order.push('cleanup-b'),
        };
      },
    });

    const merged = fireSpawnPre(mkCtx());

    expect(order).toEqual(['a', 'b']);
    expect(merged.mounts).toHaveLength(2);
    expect(merged.args).toEqual(['--from-a', '--from-b']);
    expect(merged.env).toEqual({ K1: 'a', K2: 'b', K3: 'b' });
    expect(merged.needsRootEntrypoint).toBe(true);
    expect(merged.cleanups).toHaveLength(2);
  });

  it('observer with no onSpawnPre is skipped', () => {
    registerContainerLifecycleObserver('a', {});
    expect(fireSpawnPre(mkCtx()).args).toEqual([]);
  });

  it('throwing observer in onSpawnPre wraps as FatalSpawnError', () => {
    registerContainerLifecycleObserver('a', {
      onSpawnPre() {
        throw new Error('boom');
      },
    });
    expect(() => fireSpawnPre(mkCtx())).toThrow(FatalSpawnError);
  });
});

describe('fireContainerStarted', () => {
  it('runs all started observers; one throw does not stop others', () => {
    const seen: string[] = [];
    registerContainerLifecycleObserver('a', {
      onContainerStarted() {
        seen.push('a');
        throw new Error('boom');
      },
    });
    registerContainerLifecycleObserver('b', {
      onContainerStarted() {
        seen.push('b');
      },
    });
    fireContainerStarted(mkLifeCtx());
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('fireContainerExited', () => {
  it('runs cleanups before observer exit hooks, in order', () => {
    const seen: string[] = [];
    registerContainerLifecycleObserver('a', {
      onContainerExited() {
        seen.push('obs-a');
      },
    });
    fireContainerExited(mkExitCtx(), [() => seen.push('cleanup-1'), () => seen.push('cleanup-2')]);
    expect(seen).toEqual(['cleanup-1', 'cleanup-2', 'obs-a']);
  });

  it('a throwing cleanup does not abort remaining cleanups or observers', () => {
    const seen: string[] = [];
    registerContainerLifecycleObserver('a', {
      onContainerExited() {
        seen.push('obs');
      },
    });
    fireContainerExited(mkExitCtx(), [
      () => {
        throw new Error('boom');
      },
      () => seen.push('cleanup-2'),
    ]);
    expect(seen).toEqual(['cleanup-2', 'obs']);
  });

  it('cleanups collected by fireSpawnPre run at most once across repeated fireContainerExited calls', () => {
    // Defends the SpawnPreResult.cleanup idempotency contract at the
    // collection boundary, independent of caller cooperation. Without the
    // once-shim in fire.ts, a second fireContainerExited would re-invoke
    // every cleanup — observers that allocated a non-idempotent handle
    // (release-twice = double-free / underflow) would break.
    const counts = { a: 0, b: 0 };
    registerContainerLifecycleObserver('a', {
      onSpawnPre: () => ({ cleanup: () => counts.a++ }),
    });
    registerContainerLifecycleObserver('b', {
      onSpawnPre: () => ({ cleanup: () => counts.b++ }),
    });

    const merged = fireSpawnPre(mkCtx());
    expect(merged.cleanups).toHaveLength(2);

    fireContainerExited(mkExitCtx(), merged.cleanups);
    fireContainerExited({ ...mkExitCtx(), reason: 'spawn-error', exitCode: null }, merged.cleanups);
    fireContainerExited(mkExitCtx(), merged.cleanups);

    expect(counts).toEqual({ a: 1, b: 1 });
  });

  it('throwing observer in onContainerExited does not stop other observers', () => {
    const seen: string[] = [];
    registerContainerLifecycleObserver('a', {
      onContainerExited() {
        throw new Error('boom');
      },
    });
    registerContainerLifecycleObserver('b', {
      onContainerExited() {
        seen.push('b');
      },
    });
    fireContainerExited(mkExitCtx());
    expect(seen).toEqual(['b']);
  });

  it('exit reason field reaches the observer', () => {
    let captured: ExitContext | null = null;
    registerContainerLifecycleObserver('a', {
      onContainerExited(ctx) {
        captured = ctx;
      },
    });
    fireContainerExited({ ...mkExitCtx(), reason: 'spawn-error', exitCode: null });
    expect(captured!.reason).toBe('spawn-error');
    expect(captured!.exitCode).toBeNull();
  });
});
