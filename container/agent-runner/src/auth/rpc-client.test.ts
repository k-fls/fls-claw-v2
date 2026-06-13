import { describe, test, expect } from 'bun:test';

import { makeAuthRpcClient } from './rpc-client.js';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** Build a fake `fetch` that records calls and returns a canned envelope. */
function fakeFetch(envelope: unknown, ok = true): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => envelope,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('makeAuthRpcClient', () => {
  test('postUrl posts the nonce + url and unwraps the envelope', async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, result: { relayed: true } });
    const client = makeAuthRpcClient({ baseUrl: 'http://host.docker.internal:9000/', nonce: 'N1', fetchImpl });

    await client.postUrl('https://claude.ai/oauth?x=1', 'paste it');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://host.docker.internal:9000/auth/url');
    expect(calls[0].body).toEqual({ nonce: 'N1', url: 'https://claude.ai/oauth?x=1', instructions: 'paste it' });
  });

  test('postUrl omits instructions when not provided', async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, result: { relayed: true } });
    const client = makeAuthRpcClient({ baseUrl: 'http://h:1', nonce: 'N', fetchImpl });
    await client.postUrl('https://claude.ai/x');
    expect(calls[0].body).toEqual({ nonce: 'N', url: 'https://claude.ai/x' });
  });

  test('pollCode returns the code result', async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, result: { code: 'ABC123' } });
    const client = makeAuthRpcClient({ baseUrl: 'http://h:1', nonce: 'N', fetchImpl });
    expect(await client.pollCode()).toEqual({ code: 'ABC123' });
    expect(calls[0].url).toBe('http://h:1/auth/code');
  });

  test('pollCode returns the cancelled result', async () => {
    const { fetchImpl } = fakeFetch({ ok: true, result: { cancelled: true } });
    const client = makeAuthRpcClient({ baseUrl: 'http://h:1', nonce: 'N', fetchImpl });
    expect(await client.pollCode()).toEqual({ cancelled: true });
  });

  test('throws when the host returns ok:false', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, error: 'no-active-auth-episode' }, false);
    const client = makeAuthRpcClient({ baseUrl: 'http://h:1', nonce: 'N', fetchImpl });
    await expect(client.postUrl('https://claude.ai/x')).rejects.toThrow('no-active-auth-episode');
  });
});
