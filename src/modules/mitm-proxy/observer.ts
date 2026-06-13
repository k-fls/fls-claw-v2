/**
 * Container-bootstrap observer for the MITM credential proxy.
 *
 * Contributes everything a session container needs to reach the proxy:
 *   - HTTP_PROXY / HTTPS_PROXY env (for libraries that honour them)
 *   - PROXY_HOST / PROXY_PORT env (for the entrypoint's iptables DNAT
 *     block, which catches direct :443 traffic from libraries that
 *     ignore the proxy env vars — curl --noproxy, statically-linked
 *     binaries, etc.)
 *   - MITM CA cert mount + NODE_EXTRA_CA_CERTS / SSL_CERT_FILE /
 *     MITM_CA_PATH so Node and system-store consumers trust the forged
 *     certs.
 *   - `--cap-add=NET_ADMIN` + `--security-opt=no-new-privileges` so the
 *     entrypoint can install the iptables rule and then drop privileges
 *     irreversibly via setpriv.
 *   - `needsRootEntrypoint: true` so container-bootstrap picks the
 *     root-drop launch mode (matches the iptables/CA-install needs).
 *
 * The proxy itself is always in transparent mode (`credential-proxy.ts`
 * wraps the HTTP server with `createTransparentServer`). On the listener
 * the two paths multiplex by first byte: 0x16 (TLS ClientHello) → SNI
 * parse + MITM/passthrough; otherwise → HTTP server (explicit-proxy
 * GET/CONNECT). Both arrive on the same port.
 *
 * IP → scope identification at request time goes through
 * `container-bootstrap.lookupContainerIP()` directly (see
 * `credential-proxy.ts`), so no per-spawn IP registration is needed.
 */
import {
  registerContainerLifecycleObserver,
  reserveEnvName,
  onAllocate,
  onRelease,
} from '../container-bootstrap/index.js';

import { getProxy, hasProxyInstance } from './credential-proxy.js';
import { getMitmCaCertPath } from './mitm-ca.js';
import { loadGroupProvidersForContainer } from './oauth/index.js';
import { asGroupScope } from './types.js';

// Reserve the names this observer contributes via `-e` so the substitute
// endpoint can't be tricked into shadowing them with `?envVar=…`.
const MITM_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'no_proxy',
  'PROXY_HOST',
  'PROXY_PORT',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'MITM_CA_PATH',
] as const;
for (const n of MITM_ENV_NAMES) reserveEnvName(n, 'mitm-proxy');

/** Hostname containers use to reach the host machine (Docker). */
const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/** A container's own loopback — never an egress target, so never proxied. */
const LOOPBACK_HOSTS = 'localhost,127.0.0.1,::1';

const CA_CERT_PATH_IN_CONTAINER = '/usr/local/share/ca-certificates/nanoclaw-mitm.crt';

export interface MitmProxyContribution {
  env: Record<string, string>;
  args: string[];
  needsRootEntrypoint: true;
  mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
}

/**
 * The env + args + CA mount a container needs to route through the MITM proxy
 * (transparent DNAT + explicit-proxy env + forged-cert trust). Returns null
 * when no proxy instance is running. Shared by the session-container lifecycle
 * observer (below) and the browser-auth container spawn (`auth-container.ts`),
 * so both attach the proxy identically — the env names must match what
 * `entrypoint.sh` reads.
 */
export function buildMitmProxyContribution(): MitmProxyContribution | null {
  if (!hasProxyInstance()) return null;
  // Port is resolved per spawn because `start()` defaults to a dynamic
  // (OS-assigned) port. Reading it at module load would capture the static
  // config value before the listener bound.
  const boundPort = String(getProxy().getBoundPort());
  const proxyUrl = `http://${CONTAINER_HOST_GATEWAY}:${boundPort}`;

  let caCertPath: string | null = null;
  try {
    caCertPath = getMitmCaCertPath();
  } catch {
    /* MITM CA not initialized; skip the cert mount. */
  }

  const env: Record<string, string> = {
    // Explicit-proxy path — libraries that honour these route HTTPS
    // through CONNECT and HTTP through GET on the proxy URL.
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    // Transparent path — entrypoint.sh installs an iptables DNAT rule
    // that redirects outbound :443 → $PROXY_HOST:$PROXY_PORT, so even
    // libraries that ignore the proxy env vars are intercepted.
    PROXY_HOST: CONTAINER_HOST_GATEWAY,
    PROXY_PORT: boundPort,
    // Never proxy non-egress traffic:
    //   - the host gateway (host-rpc + the proxy's own substitute endpoint) —
    //     otherwise HTTP_PROXY routes it to the proxy, which can't resolve the
    //     container-only name host.docker.internal;
    //   - the container's own loopback (e.g. the `claude` OAuth CLI's
    //     localhost callback listener) — proxying it would misdirect to the
    //     host's loopback.
    NO_PROXY: `${CONTAINER_HOST_GATEWAY},${LOOPBACK_HOSTS}`,
    no_proxy: `${CONTAINER_HOST_GATEWAY},${LOOPBACK_HOSTS}`,
  };
  if (caCertPath) {
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH_IN_CONTAINER;
    env.SSL_CERT_FILE = CA_CERT_PATH_IN_CONTAINER;
    // Gate for entrypoint.sh: when set, the entrypoint installs the
    // mounted cert into the system CA store via update-ca-certificates
    // so curl/git/apt/wget/chromium trust our forged certs.
    env.MITM_CA_PATH = CA_CERT_PATH_IN_CONTAINER;
  }

  return {
    env,
    // iptables requires CAP_NET_ADMIN, dropped together with all caps
    // by setpriv before the agent runs. no-new-privileges prevents any
    // child process from re-escalating via setuid binaries after the
    // privilege drop.
    args: ['--cap-add=NET_ADMIN', '--security-opt=no-new-privileges'],
    // Entrypoint must start as root for both the iptables DNAT install and
    // update-ca-certificates. Container-bootstrap maps this to root-drop.
    needsRootEntrypoint: true,
    ...(caCertPath && {
      mounts: [{ hostPath: caCertPath, containerPath: CA_CERT_PATH_IN_CONTAINER, readonly: true }],
    }),
  };
}

registerContainerLifecycleObserver('mitm-proxy', {
  onSpawnPre() {
    return buildMitmProxyContribution() ?? undefined;
  },
});

// Per-container OAuth provider tier. When a container's bridge IP is
// allocated we know both its IP and its scope (folder), so we load that
// group's `.auth-discovery/` providers into the proxy's per-container tier
// keyed by IP; on release we drop them. The IP-allocate hook is the right
// seam — at `onSpawnPre` the IP isn't known yet (a different observer
// allocates it). `loadGroupProvidersForContainer` never throws.
onAllocate((ip, scope) => {
  if (hasProxyInstance()) {
    loadGroupProvidersForContainer(asGroupScope(scope), ip, getProxy());
  }
});

onRelease((ip) => {
  if (hasProxyInstance()) {
    getProxy().unregisterContainerIP(ip);
  }
});
