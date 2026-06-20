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
import type { ContainerScope } from '../container-bootstrap/index.js';
import type { HostRpcHandler, HostRpcRequest, ScopedHostRpcHandler } from './types.js';

const VALID_PREFIX = /^\/[a-zA-Z0-9._/-]*$/;

interface Entry {
  readonly prefix: string;
  /** Whether the gate must resolve a session before invoking. Session-bound
   *  entries (`registerHostRpc`) get a non-null `sessionId`; scope-only
   *  entries (`registerScopedHostRpc`) do not require one. */
  readonly requiresSession: boolean;
  /** Uniform call shape. For session-bound entries the gate guarantees
   *  `sessionId` is non-null before this runs, so the wrapped
   *  `HostRpcHandler` safely receives a `string`. */
  readonly invoke: (req: HostRpcRequest, scope: ContainerScope, sessionId: string | null) => Promise<unknown> | unknown;
}

const entries = new Map<string, Entry>(); // keyed by normalized prefix

function normalize(prefix: string): string {
  if (!VALID_PREFIX.test(prefix)) {
    throw new Error(`Invalid host-rpc prefix "${prefix}" — must match ${VALID_PREFIX}`);
  }
  // Strip trailing slash unless the prefix IS just '/'.
  return prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

function register(prefix: string, entry: Omit<Entry, 'prefix'>): void {
  const norm = normalize(prefix);
  if (entries.has(norm)) {
    log.warn('host-rpc handler re-registered (overwriting)', { prefix: norm });
  }
  entries.set(norm, { prefix: norm, ...entry });
}

/**
 * Register a **session-bound** handler (the default — most RPCs act on the
 * caller's session). The gate requires both a resolved scope and a session,
 * so the handler's `sessionId` third parameter is always a non-null `string`.
 * Downstream branches rely on that; see `HostRpcHandler` in `types.ts`.
 */
export function registerHostRpc(prefix: string, handler: HostRpcHandler): void {
  register(prefix, {
    requiresSession: true,
    // `sessionId as string` is sound: the gate returns 403 before invoke when
    // a session-bound entry has no session bound to the caller IP.
    invoke: (req, scope, sessionId) => handler(req, scope, sessionId as string),
  });
}

/**
 * Register a **scope-only** handler for endpoints reachable by session-less
 * callers (e.g. the auth container's `/auth/*` flow — it allocates its IP
 * with no session). The gate still requires a known scope; it does not
 * require a session.
 */
export function registerScopedHostRpc(prefix: string, handler: ScopedHostRpcHandler): void {
  register(prefix, {
    requiresSession: false,
    invoke: (req, scope) => handler(req, scope),
  });
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
