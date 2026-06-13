/**
 * Host-RPC module — host-exposed HTTP endpoints for containers.
 *
 * Substrate for host-side endpoints containers intentionally call. The
 * MITM credential proxy (C2) intercepts *outbound* traffic; this is the
 * opposite direction — containers send HTTP requests to handlers
 * registered against a path prefix and get a JSON response. Caller
 * scope is resolved from the source IP via the container-ip registry
 * (no auth header, no token); unknown-IP requests never reach a
 * handler.
 *
 * Consumers (future):
 *   - C16 — ssh-auth `/ssh/*` endpoints (in the ssh-auth skill).
 *   - Group-OAuth — `/auth/browser-open`, interaction polling.
 *
 * Handlers self-register by importing the module and calling
 * `registerHostRpc(prefix, handler)`. The HTTP server is started
 * explicitly by src/index.ts after the bridge network is up.
 *
 * The shutdown hook stops the server cleanly.
 */
import { onShutdown } from '../../response-registry.js';
import { stopHostRpcServer } from './server.js';

export type { HostRpcRequest, HostRpcHandler } from './types.js';
export { registerHostRpc, matchHostRpc, listHostRpcHandlers } from './registry.js';
export { startHostRpcServer, stopHostRpcServer, getHostRpcAddress } from './server.js';
export { hostRpcPort, DEFAULT_HOST_RPC_PORT } from './port.js';

onShutdown(async () => {
  await stopHostRpcServer();
});
