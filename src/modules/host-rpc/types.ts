/**
 * Host-RPC module — public types.
 *
 * The host exposes a small HTTP server on the nanoclaw bridge network
 * that containers can call for actions whose effect lives on the host
 * (and that don't fit the session-DB IO model). Each request's source
 * IP is resolved via the container-ip registry; if no scope is found
 * the request is rejected with 403 **before** any handler runs. The
 * handler signature reflects this: `scope` is a non-null
 * `ContainerScope` parameter, so a handler cannot be invoked without
 * one.
 *
 * Handlers register against a path **prefix** and own everything under
 * it. The handler decides method, sub-path, and any further dispatch.
 * This matches the fork's `addInternalHandler` shape and lets a single
 * feature group (e.g. `/ssh/*`) live in one place.
 */
import type { ContainerScope } from '../container-bootstrap/index.js';

export interface HostRpcRequest {
  /** HTTP method, uppercase: 'GET', 'POST', etc. */
  readonly method: string;
  /** Full request path including the matched prefix, e.g. '/ssh/connect'. */
  readonly path: string;
  /** Parsed JSON body, or `undefined` if no body / non-JSON request. */
  readonly body: unknown;
  /** Raw caller IP — for logging / diagnostics. Authorization already
   *  resolved this into `scope`; handlers should prefer `scope`. */
  readonly callerIP: string;
}

/**
 * Handler for a **session-bound** prefix (the default, `registerHostRpc`).
 * Always invoked with a resolved `scope` AND a non-null `sessionId`: the
 * server returns 403 before reaching here if the caller IP can't be mapped
 * to a container (no scope) or to a session (no sessionId).
 *
 * ⚠️ The non-null `sessionId` third parameter is load-bearing for downstream
 * branches. Handlers there (e.g. sync-action wakeups, and other session-scoped
 * RPCs added on feature branches) consume it directly as a `string` and would
 * break if it were widened to `string | null`. Endpoints that legitimately
 * have no session — those called by session-less containers such as the auth
 * container (which allocates its IP via `allocateContainerIP(scope)` with no
 * session) — must register via `registerScopedHostRpc` and use
 * `ScopedHostRpcHandler` instead, NOT relax this type. See `server.test.ts`
 * ("session-bound handler always receives a non-null sessionId").
 *
 * The return value becomes the body of `{ ok: true, result }`.
 * Throwing produces a 500 with `{ ok: false, error }`.
 *
 * Handlers may inspect `req.method` and `req.path` for sub-routing /
 * method dispatch within their prefix.
 */
export type HostRpcHandler = (
  req: HostRpcRequest,
  scope: ContainerScope,
  sessionId: string,
) => Promise<unknown> | unknown;

/**
 * Handler for a **scope-only** prefix (`registerScopedHostRpc`). Invoked with
 * a resolved `scope` but no session — for endpoints reachable by session-less
 * callers (e.g. the auth container's `/auth/*` flow). The gate still requires
 * a known scope (403 otherwise); it just does not require a session.
 */
export type ScopedHostRpcHandler = (req: HostRpcRequest, scope: ContainerScope) => Promise<unknown> | unknown;
