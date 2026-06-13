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
