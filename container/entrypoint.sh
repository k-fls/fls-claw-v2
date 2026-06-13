#!/bin/bash
# NanoClaw agent container entrypoint — env-gated dispatcher.
#
# Each optional block is gated on a variable set by the contributing skill
# (or container-bootstrap onSpawnPre observer). The default path is a
# plain "capture stdin → exec bun" matching the pre-A4 behavior.
#
# This file is mounted from the host snapshot at spawn time; the image
# ships only a fail-loud stub at /app/entrypoint.sh so an unmounted run
# is impossible to miss.

set -e

# ----- (optional) passwd shim — ssh-auth, future tools that resolve $UID -----
# When the container runs as a host UID with no matching /etc/passwd entry,
# tools like ssh and git fail with "No user exists for uid". The shim adds
# a minimal entry so getpwuid succeeds.
if [ -n "${ENSURE_PASSWD_ENTRY:-}" ] && [ -n "${HOST_UID:-}" ] && \
   ! getent passwd "$HOST_UID" >/dev/null 2>&1; then
  echo "agent:x:${HOST_UID}:${HOST_GID:-$HOST_UID}::/home/node:/bin/bash" \
    >> /etc/passwd
fi

# Capture stdin to a file so it's available for post-mortem and survives
# the privilege drop below (setpriv inherits open FDs but the original
# pipe may not be re-readable).
cat > /tmp/input.json

# ----- (optional) egress lockdown firewall -----
# When NANOCLAW_EGRESS_LOCKDOWN=1 (set by the `egress` spawn observer, which
# also grants NET_ADMIN and forces this root entrypoint), install a default-DROP
# OUTPUT firewall that permits egress ONLY to the host hop: the OneCLI proxy and
# the host-rpc port. The privilege drop below then strips NET_ADMIN (and the
# whole bounding set), so the unprivileged agent cannot flush these rules.
#
# Fail-closed: `set -e` means any iptables failure aborts the container rather
# than running it with open egress. IPv6 is disabled at the namespace level via
# the `--sysctl` flags the observer passes, so a v6 route can't bypass this.
if [ "${NANOCLAW_EGRESS_LOCKDOWN:-}" = "1" ]; then
  if [ "$(id -u)" != "0" ]; then
    echo "FATAL egress-lockdown: entrypoint is not root; cannot install firewall" >&2
    exit 1
  fi

  # host.docker.internal → the host gateway IP (host-rpc + proxy live there).
  egress_gw="$(getent hosts host.docker.internal | awk '{print $1; exit}')"
  if [ -z "$egress_gw" ]; then
    echo "FATAL egress-lockdown: cannot resolve host.docker.internal" >&2
    exit 1
  fi

  # Set by the `egress` spawn observer to host-rpc's actual bound port. No
  # literal fallback — that would be a second copy of the port that could drift
  # from the server's bind. Fail closed if it's somehow missing.
  egress_rpc_port="${NANOCLAW_HOST_RPC_PORT:-}"
  if [ -z "$egress_rpc_port" ]; then
    echo "FATAL egress-lockdown: NANOCLAW_HOST_RPC_PORT not set" >&2
    exit 1
  fi

  # Proxy host:port from the OneCLI-injected proxy URL. Parsed (not assumed)
  # so the allowlist tracks whatever OneCLI set, then resolved to an IP.
  egress_proxy_url="${HTTPS_PROXY:-${https_proxy:-}}"
  egress_proxy_host="$(printf '%s' "$egress_proxy_url" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/]*@)?([^:/]+):([0-9]+).*#\2#p')"
  egress_proxy_port="$(printf '%s' "$egress_proxy_url" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/]*@)?([^:/]+):([0-9]+).*#\3#p')"
  egress_proxy_ip=""
  if [ -n "$egress_proxy_host" ]; then
    egress_proxy_ip="$(getent hosts "$egress_proxy_host" | awk '{print $1; exit}')"
  fi

  iptables -P OUTPUT DROP
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -d "$egress_gw" -p tcp --dport "$egress_rpc_port" -j ACCEPT
  if [ -n "$egress_proxy_ip" ] && [ -n "$egress_proxy_port" ]; then
    iptables -A OUTPUT -d "$egress_proxy_ip" -p tcp --dport "$egress_proxy_port" -j ACCEPT
    echo "egress-lockdown: OUTPUT default-DROP; allow ${egress_gw}:${egress_rpc_port} (rpc), ${egress_proxy_ip}:${egress_proxy_port} (proxy)" >&2
  else
    echo "WARN egress-lockdown: no proxy in HTTPS_PROXY; only host-rpc reachable (API egress will fail)" >&2
  fi
fi

# ----- privilege drop -----
# If we started as root (root-drop launch mode), setpriv to HOST_UID before
# exec-ing the agent runner. We also empty the capability bounding set
# (--bounding-set=-all) so no capability — NET_ADMIN under egress lockdown, or
# anything else — can ever re-enter the agent's permitted set. The agent runs
# unprivileged and needs no caps, so this is unconditional defense-in-depth,
# mirroring the always-on --security-opt=no-new-privileges in baseRunArgs (which
# blocks the setuid/file-cap regain vector). Together they make the drop a hard
# boundary, so the agent cannot touch the egress firewall installed above.
# Otherwise (rootless mode), exec bun directly under the existing UID.
if [ "$(id -u)" = "0" ] && [ -n "${HOST_UID:-}" ]; then
  exec setpriv --reuid="$HOST_UID" --regid="${HOST_GID:-$HOST_UID}" \
       --clear-groups --inh-caps=-all --bounding-set=-all \
       -- bun run /app/src/index.ts < /tmp/input.json
else
  exec bun run /app/src/index.ts < /tmp/input.json
fi
