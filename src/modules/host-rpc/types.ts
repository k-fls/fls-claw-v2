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
 * Handler for a registered prefix. Always invoked with a resolved
 * `scope` — the server returns 403 before reaching here if the caller
 * IP can't be mapped to a container.
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
