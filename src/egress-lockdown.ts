/**
 * Egress lockdown (opt-in) — force ALL agent traffic through the proxy hop.
 *
 * This is the fork's replacement for upstream's `--internal`-network egress
 * lockdown. The fork can't use the upstream mechanism: putting the container on
 * a Docker `--internal` net severs the `host.docker.internal` / docker0 route
 * that `host-rpc` (and the credential broker) depend on. So instead of removing
 * the route, the fork keeps its managed `nanoclaw` bridge and enforces egress
 * *inside* the container with a netfilter ruleset installed by the root
 * entrypoint, then drops `NET_ADMIN` so the agent can't undo it.
 *
 * Mechanism (per spawn, when enabled):
 *   1. This module contributes docker flags (`--cap-add=NET_ADMIN`,
 *      `--cap-drop=NET_RAW`, IPv6-off sysctls) and env (`NANOCLAW_EGRESS_LOCKDOWN=1`
 *      plus the host-rpc port) via the `egress` container-bootstrap observer,
 *      and forces the root-drop launch mode (`needsRootEntrypoint`).
 *   2. `container/entrypoint.sh`, running as root, installs a default-DROP
 *      OUTPUT firewall that permits egress ONLY to the OneCLI proxy hop and the
 *      host-rpc port, then `setpriv`-drops to the host UID with an empty
 *      capability + bounding set. Combined with the always-on
 *      `--security-opt=no-new-privileges`, the dropped agent has no `NET_ADMIN`
 *      and cannot regain it, so it cannot flush the rules.
 *
 * Fail-closed: the entrypoint aborts (set -e) if the firewall can't be
 * installed, and `assertEgressLaunchable` refuses to spawn if lockdown is on but
 * the root-drop path isn't available — never a silent fall-back to open egress.
 *
 * Off by default; opt in with NANOCLAW_EGRESS_LOCKDOWN=true.
 */
// Imported from the host-rpc leaf module (not the barrel) so the allowlist is
// derived from the SAME source the server binds — they can never drift — while
// avoiding the import cycle the barrel would introduce.
import { hostRpcPort } from './modules/host-rpc/port.js';
import type { LaunchMode } from './modules/container-bootstrap/index.js';

/** Off by default; set NANOCLAW_EGRESS_LOCKDOWN=true to opt in. */
export function egressLockdownEnabled(): boolean {
  return process.env.NANOCLAW_EGRESS_LOCKDOWN === 'true';
}

/** Raised when lockdown is requested but can't be safely established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Fix the cause, or set ` +
        `NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

/**
 * Docker run flags for a locked-down container:
 *   - NET_ADMIN so the root entrypoint can install iptables rules.
 *   - drop NET_RAW so no leftover raw-socket capability survives in the
 *     bounding set to bypass netfilter (the setpriv drop also clears it).
 *   - disable IPv6 in the container netns so a v6 route can't bypass the
 *     v4-only firewall (avoids needing ip6tables in the image).
 */
export function egressSpawnArgs(): string[] {
  return [
    '--cap-add=NET_ADMIN',
    '--cap-drop=NET_RAW',
    '--sysctl',
    'net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl',
    'net.ipv6.conf.default.disable_ipv6=1',
  ];
}

/** Env the entrypoint reads to install the firewall + harden the setpriv drop. */
export function egressSpawnEnv(): Record<string, string> {
  return {
    NANOCLAW_EGRESS_LOCKDOWN: '1',
    NANOCLAW_HOST_RPC_PORT: String(hostRpcPort()),
  };
}

/**
 * Fail-fast guard: lockdown enforcement lives in the root entrypoint, so it is
 * only real on the root-drop launch path. If lockdown is on but we resolved a
 * non-root launch mode (e.g. a host that doesn't expose uid/gid), refuse to
 * spawn rather than run the agent with the firewall never installed.
 */
export function assertEgressLaunchable(launchMode: LaunchMode): void {
  if (!egressLockdownEnabled()) return;
  if (launchMode.kind !== 'root-drop') {
    throw new EgressLockdownError(
      'the root-drop launch mode is unavailable (the host did not expose a ' +
        'UID/GID to drop to), so the in-container firewall cannot be installed',
    );
  }
}
