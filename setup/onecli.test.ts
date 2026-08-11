/**
 * The step DETECTS gateway /v1 compatibility and warns (pointing at
 * docs/onecli-upgrades.md) — it does not migrate the gateway; that's the
 * agent's job via /update-nanoclaw. The verify helper must distinguish
 * incompatible (pre-/v1 server: warn) from unreachable (transient: nothing to
 * say) so the warning only fires on a real pre-/v1 server.
 */
import net from 'net';

import { describe, expect, it } from 'vitest';

import { extractPortConflict, findFreePort, verifyGatewayV1 } from './onecli.js';

function fakeFetch(behavior: 'ok' | '404' | 'down'): typeof fetch {
  return (async () => {
    if (behavior === 'down') throw new Error('ECONNREFUSED');
    return { ok: behavior === 'ok' } as Response;
  }) as unknown as typeof fetch;
}

describe('verifyGatewayV1', () => {
  it('ok when /v1/health answers', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('ok'))).toBe('ok');
  });
  it('incompatible when the server answers HTTP without /v1', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('404'))).toBe('incompatible');
  });
  it('unreachable on connection failure', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('down'))).toBe('unreachable');
  });
});

describe('extractPortConflict', () => {
  it('extracts the port from the installer\'s conflict message', () => {
    const stderr =
      'Error: Port 5432 is already in use (probably a local PostgreSQL).\n\n' +
      "Pick a free port for OneCLI's database:\n  export POSTGRES_PORT=5433\n";
    expect(extractPortConflict(stderr)).toBe(5432);
  });
  it('returns null for unrelated failures', () => {
    expect(extractPortConflict('docker: command not found')).toBeNull();
  });
  it('returns null when stderr is undefined', () => {
    expect(extractPortConflict(undefined)).toBeNull();
  });
});

describe('findFreePort', () => {
  it('skips a port that is already bound and returns the next free one', async () => {
    const busy = net.createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', () => resolve()));
    const address = busy.address();
    const busyPort = typeof address === 'object' && address ? address.port : 0;

    try {
      const found = await findFreePort(busyPort);
      expect(found).not.toBe(busyPort);
      expect(found).toBeGreaterThanOrEqual(busyPort);
    } finally {
      busy.close();
    }
  });
});
