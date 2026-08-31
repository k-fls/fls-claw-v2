import { describe, it, expect } from 'bun:test';

import { isAuthMode, specFor, readAuthEnv } from './mode.js';

const ENV = {
  NANOCLAW_AUTH_MODE: 'codex_device',
  NANOCLAW_AUTH_NONCE: 'n1',
  NANOCLAW_HOST_RPC_PORT: '9000',
};

describe('isAuthMode', () => {
  it('accepts every declared mode', () => {
    expect(isAuthMode('setup_token')).toBe(true);
    expect(isAuthMode('auth_login')).toBe(true);
    expect(isAuthMode('codex_device')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'claude', 'codex', 'CODEX_DEVICE', undefined, null, 7, {}]) {
      expect(isAuthMode(bad)).toBe(false);
    }
  });

  it('rejects inherited Object properties', () => {
    expect(isAuthMode('constructor')).toBe(false);
    expect(isAuthMode('toString')).toBe(false);
  });
});

describe('specFor', () => {
  it('maps each Claude mode to its own command and keeps the code relay', () => {
    expect(specFor('setup_token').command).toBe('claude setup-token');
    expect(specFor('auth_login').command).toBe('claude auth login');
    expect(specFor('setup_token').relaysCode).toBe(true);
    expect(specFor('auth_login').relaysCode).toBe(true);
  });

  it('maps the Codex mode to a device login with no code relay', () => {
    const spec = specFor('codex_device');
    expect(spec.command).toBe('codex login --device-auth');
    expect(spec.relaysCode).toBe(false);
  });

  it('gives the device flow a human-scale wait, under the host lifetime backstop', () => {
    const device = specFor('codex_device').exitWaitMs;
    expect(device).toBeGreaterThan(specFor('auth_login').exitWaitMs);
    // The host kills the container at 12 min; its timeout must fire first.
    expect(device).toBeLessThan(12 * 60_000);
  });

  it('throws on an unrecognized mode rather than defaulting to a Claude command', () => {
    expect(() => specFor('nope' as never)).toThrow();
  });
});

describe('readAuthEnv', () => {
  it('returns the parsed triple when all three are present', () => {
    expect(readAuthEnv(ENV)).toEqual({ mode: 'codex_device', nonce: 'n1', port: '9000' });
  });

  it('reports an unrecognized mode instead of falling back', () => {
    const out = readAuthEnv({ ...ENV, NANOCLAW_AUTH_MODE: 'wat' });
    expect(out).toHaveProperty('error');
    expect((out as { error: string }).error).toContain('wat');
  });

  it('reports each missing variable', () => {
    expect(readAuthEnv({ ...ENV, NANOCLAW_AUTH_NONCE: undefined })).toEqual({
      error: 'NANOCLAW_AUTH_NONCE not set',
    });
    expect(readAuthEnv({ ...ENV, NANOCLAW_HOST_RPC_PORT: undefined })).toEqual({
      error: 'NANOCLAW_HOST_RPC_PORT not set',
    });
  });
});
