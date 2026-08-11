/**
 * The step DETECTS gateway /v1 compatibility and warns (pointing at
 * docs/onecli-upgrades.md) — it does not migrate the gateway; that's the
 * agent's job via /update-nanoclaw. The verify helper must distinguish
 * incompatible (pre-/v1 server: warn) from unreachable (transient: nothing to
 * say) so the warning only fires on a real pre-/v1 server.
 */
import net from 'net';

import { describe, expect, it, vi } from 'vitest';

import { extractPortConflict, findFreePort, installOnecli, verifyGatewayV1 } from './onecli.js';

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

describe('installOnecli', () => {
  const conflictStderr = 'Error: Port 5432 is already in use (probably a local PostgreSQL).';

  it('retries once with POSTGRES_PORT after a port-conflict failure, then succeeds', async () => {
    const runInstallFn = vi
      .fn()
      .mockReturnValueOnce({ stdout: '', stderr: conflictStderr, ok: false })
      .mockReturnValueOnce({ stdout: 'https://example.local installed', ok: true });
    const findFreePortFn = vi.fn().mockResolvedValue(5433);
    const installCliFn = vi.fn().mockReturnValue({ stdout: 'cli installed', ok: true });

    const result = await installOnecli(runInstallFn, findFreePortFn, installCliFn);

    expect(result.ok).toBe(true);
    expect(runInstallFn).toHaveBeenCalledTimes(2);
    expect(findFreePortFn).toHaveBeenCalledWith(5433);
    expect(runInstallFn.mock.calls[1][0]).toContain('export POSTGRES_PORT=5433 && ');
  });

  it('fails without a second retry when the retried install also fails', async () => {
    const runInstallFn = vi
      .fn()
      .mockReturnValueOnce({ stdout: '', stderr: conflictStderr, ok: false })
      .mockReturnValueOnce({ stdout: '', stderr: 'still broken', ok: false });
    const findFreePortFn = vi.fn().mockResolvedValue(5433);

    const result = await installOnecli(runInstallFn, findFreePortFn);

    expect(result.ok).toBe(false);
    expect(runInstallFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the failure is not a port conflict', async () => {
    const runInstallFn = vi.fn().mockReturnValueOnce({ stdout: '', stderr: 'docker: command not found', ok: false });
    const findFreePortFn = vi.fn();

    const result = await installOnecli(runInstallFn, findFreePortFn);

    expect(result.ok).toBe(false);
    expect(runInstallFn).toHaveBeenCalledTimes(1);
    expect(findFreePortFn).not.toHaveBeenCalled();
  });

  it('keeps the original failure (does not throw) when no free port can be found', async () => {
    const runInstallFn = vi.fn().mockReturnValueOnce({ stdout: '', stderr: conflictStderr, ok: false });
    const findFreePortFn = vi.fn().mockRejectedValue(new Error('No free port found near 5433 for OneCLI Postgres'));

    const result = await installOnecli(runInstallFn, findFreePortFn);

    expect(result.ok).toBe(false);
    expect(runInstallFn).toHaveBeenCalledTimes(1);
  });
});
