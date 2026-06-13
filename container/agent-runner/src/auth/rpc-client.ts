/**
 * Container-side host-rpc client for the browser-auth flow. The auth container
 * is always the caller (no host→container stdin): it POSTs the OAuth URL out
 * and long-polls for the user's pasted code. Every call carries the
 * per-episode nonce the host seeded into our env, which the host validates
 * against the in-flight episode for our scope.
 *
 * host-rpc envelope: `{ ok: true, result }` on success, `{ ok: false, error }`
 * otherwise. We unwrap `result`.
 */

export type AuthCodeResult = { code: string } | { cancelled: true };

export interface AuthRpcClient {
  /** Relay the OAuth URL to the user; resolves once the host has shown it. */
  postUrl(url: string, instructions?: string): Promise<void>;
  /** Long-poll: resolves when the user pastes a code, or on cancel/timeout. */
  pollCode(): Promise<AuthCodeResult>;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * `pollCode` outlives the host's interaction timeout (10 min) on purpose, so
 * the host's `{ cancelled: true }` (not a client abort) is what ends a stalled
 * flow — keeping both sides' lifecycles in one place (the host episode).
 */
const POLL_TIMEOUT_MS = 11 * 60_000;

export function makeAuthRpcClient(opts: {
  baseUrl: string;
  nonce: string;
  fetchImpl?: typeof fetch;
}): AuthRpcClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');

  async function call(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: opts.nonce, ...body }),
      signal,
    });
    const env = (await res.json()) as Envelope;
    if (!res.ok || !env.ok) {
      throw new Error(`host-rpc ${path} failed: ${env.error ?? res.status}`);
    }
    return env.result;
  }

  return {
    async postUrl(url: string, instructions?: string): Promise<void> {
      await call('/auth/url', instructions != null ? { url, instructions } : { url });
    },
    async pollCode(): Promise<AuthCodeResult> {
      const result = (await call('/auth/code', {}, AbortSignal.timeout(POLL_TIMEOUT_MS))) as AuthCodeResult;
      if (result && typeof result === 'object' && ('code' in result || 'cancelled' in result)) {
        return result;
      }
      throw new Error('host-rpc /auth/code returned an unexpected shape');
    },
  };
}
