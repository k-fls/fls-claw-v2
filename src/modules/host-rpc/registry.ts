/**
 * Host-RPC prefix registry.
 *
 * Each handler owns a path prefix and receives every request under it
 * (any HTTP method). Longest-prefix match wins on dispatch. A handler
 * registered against `'/foo'` claims `/foo`, `/foo/`, `/foo/bar`, etc.,
 * but not `/foobar` — match boundaries respect path segments.
 *
 * Prefix syntax:
 *   - Must start with `/`.
 *   - May contain `[a-zA-Z0-9._/-]`.
 *   - Trailing `/` is stripped at registration time so `/foo` and
 *     `/foo/` are equivalent and only one registration wins.
 */
import { log } from '../../log.js';
import type { HostRpcHandler } from './types.js';

const VALID_PREFIX = /^\/[a-zA-Z0-9._/-]*$/;

interface Entry {
  readonly prefix: string;
  readonly handler: HostRpcHandler;
}

const entries = new Map<string, Entry>(); // keyed by normalized prefix

function normalize(prefix: string): string {
  if (!VALID_PREFIX.test(prefix)) {
    throw new Error(`Invalid host-rpc prefix "${prefix}" — must match ${VALID_PREFIX}`);
  }
  // Strip trailing slash unless the prefix IS just '/'.
  return prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

export function registerHostRpc(prefix: string, handler: HostRpcHandler): void {
  const norm = normalize(prefix);
  if (entries.has(norm)) {
    log.warn('host-rpc handler re-registered (overwriting)', { prefix: norm });
  }
  entries.set(norm, { prefix: norm, handler });
}

/**
 * Find the handler whose prefix is the longest match for `path`.
 * A prefix matches when `path === prefix`, `path.startsWith(prefix + '/')`,
 * or the prefix is the root `'/'` (matches everything).
 */
export function matchHostRpc(path: string): Entry | undefined {
  let best: Entry | undefined;
  for (const entry of entries.values()) {
    const matches = entry.prefix === '/' || path === entry.prefix || path.startsWith(entry.prefix + '/');
    if (matches && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry;
    }
  }
  return best;
}

export function listHostRpcHandlers(): readonly string[] {
  return [...entries.keys()];
}

/** @internal — for tests. */
export function __resetHostRpcRegistryForTests(): void {
  entries.clear();
}
