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

# ----- iptables DNAT for transparent proxy — mitm-proxy module -----
# When PROXY_HOST/PROXY_PORT are set by the mitm-proxy observer, install a
# DNAT rule that redirects all outbound :443 traffic to the host-side
# proxy. This catches libraries that ignore HTTP_PROXY/HTTPS_PROXY env vars
# (curl --noproxy, statically-linked binaries, …) and routes them through
# the same MITM path. Requires uid 0 + CAP_NET_ADMIN; both are dropped by
# setpriv below before the agent runs.
#
# Failure modes (uid != 0, missing iptables, NAT module unavailable, rule
# rejected) are FATAL — we'd otherwise launch an agent whose direct :443
# traffic bypasses credential injection. Fail-loud rather than degrade
# silently to the explicit-proxy-only path.
if [ -n "${PROXY_HOST:-}" ] && [ -n "${PROXY_PORT:-}" ]; then
  PROXY_IP="$(getent hosts "$PROXY_HOST" | awk '{print $1; exit}')"
  [ -n "$PROXY_IP" ] || PROXY_IP="$PROXY_HOST"
  # `set -e` at the top of the script aborts the container on any
  # non-zero exit here — covers missing binary, non-root uid, missing
  # CAP_NET_ADMIN, and missing iptable_nat kernel module. iptables
  # prints its own diagnostic.
  #
  # --wait 5: nf_tables takes /run/xtables.lock for the duration of an
  # update. Concurrent rule installs (multiple containers spawning at
  # once, or Docker's bridge-network setup racing with our DNAT rule)
  # otherwise fail with exit 4 (XTABLES_LOCKED) instead of waiting.
  iptables --wait 5 -t nat -A OUTPUT -p tcp --dport 443 \
    -j DNAT --to-destination "$PROXY_IP:$PROXY_PORT"
fi

# ----- (optional) MITM CA install — mitm-proxy module -----
# When the mitm-proxy observer mounts the host's MITM CA cert into the
# container, install it into the system CA store so curl/git/apt/wget
# trust our forged TLS certs. Without this, only Node/OpenSSL apps that
# honour NODE_EXTRA_CA_CERTS / SSL_CERT_FILE work — anything that
# consults /etc/ssl/certs gets a TLS error.
#
# NSS browser trust lands in the block below.
if [ -n "${MITM_CA_PATH:-}" ] && [ -r "${MITM_CA_PATH}" ]; then
  if command -v update-ca-certificates >/dev/null 2>&1; then
    update-ca-certificates 2>/dev/null >&2 || true
  else
    cat "${MITM_CA_PATH}" >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true
  fi
fi

# ----- (optional) MITM CA install for Chromium/Firefox (NSS) -----
# Chromium on Linux reads its CA trust from the NSS shared SQL DB at
# $HOME/.pki/nssdb (cert9.db). The OpenSSL/system store above does NOT
# cover it — without this block, MITM'd HTTPS in headless Chromium /
# agent-browser fails with NET::ERR_CERT_AUTHORITY_INVALID.
#
# Ownership: when running root-drop (uid 0 here, HOST_UID set), we
# create the DB as root then chown to HOST_UID so Chromium running as
# that uid can read it. In rootless mode the entrypoint already runs as
# the target uid, so no chown needed.
if [ -n "${MITM_CA_PATH:-}" ] && [ -r "${MITM_CA_PATH}" ] && \
   command -v certutil >/dev/null 2>&1; then
  NSS_HOME="/home/node"
  NSS_DIR="${NSS_HOME}/.pki/nssdb"
  mkdir -p "$NSS_DIR"
  if [ ! -f "$NSS_DIR/cert9.db" ]; then
    certutil -N --empty-password -d "sql:$NSS_DIR" 2>/dev/null || true
  fi
  # -A: add cert. -t "C,," → trust as CA for TLS (no email/code-signing).
  # -n: nickname (idempotent — overwrites if present).
  certutil -A -d "sql:$NSS_DIR" -t "C,," -n "nanoclaw-mitm-ca" \
    -i "$MITM_CA_PATH" 2>/dev/null || true
  if [ "$(id -u)" = "0" ] && [ -n "${HOST_UID:-}" ]; then
    chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "${NSS_HOME}/.pki" 2>/dev/null || true
  fi
fi


# Capture stdin to a file so it's available for post-mortem and survives
# the privilege drop below (setpriv inherits open FDs but the original
# pipe may not be re-readable).
cat > /tmp/input.json

# ----- privilege drop -----
# If we started as root (root-drop launch mode), setpriv to HOST_UID before
# exec-ing the agent runner. Combined with host-side --security-opt=
# no-new-privileges, no privilege regain is possible after the drop.
# Otherwise (rootless mode), exec bun directly under the existing UID.
if [ "$(id -u)" = "0" ] && [ -n "${HOST_UID:-}" ]; then
  exec setpriv --reuid="$HOST_UID" --regid="${HOST_GID:-$HOST_UID}" \
       --clear-groups --inh-caps=-all \
       -- bun run /app/src/index.ts < /tmp/input.json
else
  exec bun run /app/src/index.ts < /tmp/input.json
fi
