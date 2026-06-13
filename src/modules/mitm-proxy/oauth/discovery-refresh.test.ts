import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { refreshDiscoveryCache, startDiscoveryRefreshSchedule } from './discovery-refresh.js';
import type { DiscoveryFile } from './types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auth-discovery-refresh-test-'));
}

describe('refreshDiscoveryCache', () => {
  it('fetches well-known docs and writes filtered JSON to the override dir', async () => {
    const overrideDir = tmpDir();
    const baseline = new Map<string, DiscoveryFile>([
      [
        'example',
        {
          issuer: 'https://example.com',
          token_endpoint: 'https://example.com/oauth/token',
        },
      ],
    ]);

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token_endpoint: 'https://refreshed.example.com/oauth/token',
        authorization_endpoint: 'https://refreshed.example.com/oauth/authorize',
        _internal_bogus_field: 'should be dropped',
      }),
    })) as unknown as typeof fetch;

    const result = await refreshDiscoveryCache({
      baseline,
      overrideDir,
      fetchImpl,
    });

    expect(result.refreshed).toEqual(['example']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/.well-known/openid-configuration',
      expect.objectContaining({ headers: expect.any(Object) }),
    );

    const written = JSON.parse(fs.readFileSync(path.join(overrideDir, 'example.json'), 'utf-8'));
    expect(written.token_endpoint).toBe('https://refreshed.example.com/oauth/token');
    // `_*` fields must be filtered out before write.
    expect(written._internal_bogus_field).toBeUndefined();
  });

  it('honors _well_known_url === false (previously failed)', async () => {
    const overrideDir = tmpDir();
    const baseline = new Map<string, DiscoveryFile>([['skipme', { issuer: 'https://skipme', _well_known_url: false }]]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await refreshDiscoveryCache({ baseline, overrideDir, fetchImpl });
    expect(result.skipped).toEqual(['skipme']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips fresh override files', async () => {
    const overrideDir = tmpDir();
    const baseline = new Map<string, DiscoveryFile>([['svc', { issuer: 'https://svc.example.com' }]]);
    fs.writeFileSync(path.join(overrideDir, 'svc.json'), JSON.stringify({ token_endpoint: 'https://svc/old' }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await refreshDiscoveryCache({
      baseline,
      overrideDir,
      fetchImpl,
      staleMs: 60_000,
    });
    expect(result.skipped).toEqual(['svc']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records failures without aborting the batch', async () => {
    const overrideDir = tmpDir();
    const baseline = new Map<string, DiscoveryFile>([
      ['good', { issuer: 'https://good.example.com' }],
      ['bad', { issuer: 'https://bad.example.com' }],
    ]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://bad')) throw new Error('boom');
      return { ok: true, json: async () => ({ token_endpoint: 'https://good/token' }) };
    }) as unknown as typeof fetch;

    const result = await refreshDiscoveryCache({
      baseline,
      overrideDir,
      fetchImpl,
    });
    expect(result.refreshed).toEqual(['good']);
    expect(result.failed).toEqual(['bad']);
  });
});

describe('startDiscoveryRefreshSchedule (C14)', () => {
  it('runs an initial sweep immediately, repeats on the interval, and stops on stop()', async () => {
    vi.useFakeTimers();
    try {
      const overrideDir = tmpDir();
      const baseline = new Map<string, DiscoveryFile>([['svc', { issuer: 'https://svc.example.com' }]]);
      // Always fails → never writes a fresh override file, so every sweep
      // re-attempts the fetch (deterministic count, independent of mtime).
      const fetchImpl = vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch;

      const handle = startDiscoveryRefreshSchedule({
        baseline,
        overrideDir,
        fetchImpl,
        intervalMs: 1_000,
      });

      // Initial sweep fires synchronously at start (no timer).
      const initial = await handle.initial;
      expect(initial.failed).toEqual(['svc']);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // One interval → a second sweep.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // After stop(), no further sweeps regardless of elapsed time.
      handle.stop();
      handle.stop(); // idempotent
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
