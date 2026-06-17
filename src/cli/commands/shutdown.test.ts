import { describe, expect, it } from 'vitest';

import { MAX_DRAIN_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS } from '../../config.js';
import { parseShutdownArgs } from './shutdown.js';

describe('ncl shutdown — mode selection (the three drain modes)', () => {
  it('--now → immediate (drainTimeout 0)', () => {
    expect(parseShutdownArgs({ now: true }).drainTimeoutMs).toBe(0);
  });

  it('--wait → wait-for-completion (clamped max, never Infinity)', () => {
    expect(parseShutdownArgs({ wait: true }).drainTimeoutMs).toBe(MAX_DRAIN_TIMEOUT_MS);
  });

  it('--drain <ms> → explicit finite budget', () => {
    expect(parseShutdownArgs({ drain: '30000' }).drainTimeoutMs).toBe(30000);
  });

  it('no flag → the configured default graceful budget', () => {
    expect(parseShutdownArgs({}).drainTimeoutMs).toBe(SHUTDOWN_DRAIN_TIMEOUT_MS);
  });

  it('--now wins over --drain / --wait', () => {
    expect(parseShutdownArgs({ now: true, drain: '30000', wait: true }).drainTimeoutMs).toBe(0);
  });

  it('rejects a negative / non-numeric --drain', () => {
    expect(() => parseShutdownArgs({ drain: '-5' })).toThrow();
    expect(() => parseShutdownArgs({ drain: 'soon' })).toThrow();
  });
});
