/**
 * Host-rpc port resolution — the single source of truth for the port the
 * host-rpc server binds to.
 *
 * Leaf module (only reads process.env) so it can be imported by both the
 * server and the egress-lockdown allowlist without an import cycle. The egress
 * firewall MUST allow exactly this port, so both sides resolve it here rather
 * than re-hardcoding the default.
 */

/** Default host-rpc port when NANOCLAW_HOST_RPC_PORT is unset. */
export const DEFAULT_HOST_RPC_PORT = 17381;

/** The port host-rpc binds (env override, else the default). */
export function hostRpcPort(): number {
  return Number(process.env.NANOCLAW_HOST_RPC_PORT) || DEFAULT_HOST_RPC_PORT;
}
