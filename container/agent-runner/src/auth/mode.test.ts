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
  it('maps each Claude mode to its own command and returns the code over stdin', () => {
    expect(specFor('setup_token').command).toBe('claude setup-token');
    expect(specFor('auth_login').command).toBe('claude auth login');
    expect(specFor('setup_token').codeReturn).toBe('stdin');
    expect(specFor('auth_login').codeReturn).toBe('stdin');
  });

  it('maps the Codex device mode to a device login that relays no URL', () => {
    const spec = specFor('codex_device');
    expect(spec.command).toBe('codex login --device-auth');
    expect(spec.relaysUrl).toBe(false);
    expect(spec.codeReturn).toBe('none');
  });

  // `codex login` reads no code from stdin — it blocks on its own localhost
  // listener — so the runner relays the URL and the host delivers the callback.
  it('maps the Codex browser mode to a URL relay with a host-delivered callback', () => {
    const spec = specFor('codex_login');
    expect(spec.command).toBe('codex login');
    expect(spec.relaysUrl).toBe(true);
    expect(spec.codeReturn).toBe('callback');
  });

  it('gives the browser-scale flows a human wait, under the host lifetime backstop', () => {
    const device = specFor('codex_device').exitWaitMs;
    expect(specFor('codex_login').exitWaitMs).toBe(device);
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
