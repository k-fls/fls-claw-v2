#!/usr/bin/env bash
# Run the NanoClaw host inside the Docker VM so container source IPs survive.
#
# LOAD-BEARING: the repo and $HOME are mounted at their *Mac* paths, unchanged.
# The host computes absolute host paths and hands them to `docker run -v`, and
# the daemon resolves those against the Mac filesystem — so any other mount
# point would produce bind mounts the daemon cannot find.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MAC_HOME="${MAC_HOME:-$HOME}"
IMAGE="${IMAGE:-claw-host:latest}"

# LOAD-BEARING: the host must NOT run as root. `resolveLaunchMode` reads
# `process.getuid()` and passes it to agent containers as HOST_UID, which their
# entrypoint setpriv-drops to. A root host therefore produces a root agent, and
# the Claude CLI refuses outright:
#   --dangerously-skip-permissions cannot be used with root/sudo privileges
# Running as the Mac user also keeps bind-mounted file ownership sane.
RUN_UID="${RUN_UID:-$(id -u)}"
RUN_GID="${RUN_GID:-$(id -g)}"
# /var/run/docker.sock inside the VM is root:root 0660, so the non-root process
# needs the root *group* to reach it. Dev-box compromise, deliberate.
SOCK_GID="${SOCK_GID:-0}"

[ -d "$REPO" ] || { echo "REPO not found: $REPO" >&2; exit 1; }
mkdir -p "$MAC_HOME/.config/nanoclaw"

# The Mac-side host must not be running: it holds the same TCP ports and the
# same unix sockets under the (shared) repo data/ directory.
if pgrep -f "tsx src/index.ts" >/dev/null 2>&1 || pgrep -f "node dist/index.js" >/dev/null 2>&1; then
  echo "A host process is already running on the Mac — stop it first." >&2
  exit 1
fi

# -t only when stdin really is a terminal; docker refuses otherwise. A plain
# string, not an array: macOS ships bash 3.2, where expanding an empty array
# under `set -u` is itself an error.
TTY_FLAGS=""
if [ -t 0 ]; then
  TTY_FLAGS="-it"
else
  # Detached when there is no terminal. A foreground `docker run` dies with
  # whatever process holds it, so an automation harness reaping its background
  # task takes the host down with it. Logs move to `docker logs claw-host`.
  TTY_FLAGS="-d"
fi

# shellcheck disable=SC2086 -- deliberate word-split of the optional flag
exec docker run --rm $TTY_FLAGS \
  --name claw-host \
  --network host \
  --user "$RUN_UID:$RUN_GID" \
  --group-add "$SOCK_GID" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO":"$REPO" \
  -v claw-host-node-modules:"$REPO/node_modules" \
  -v claw-host-pnpm-store:/pnpm-store \
  -v "$MAC_HOME/.config/nanoclaw":"$MAC_HOME/.config/nanoclaw" \
  -e HOME="$MAC_HOME" \
  -e LOG_LEVEL="${LOG_LEVEL:-info}" \
  -e CLAW_HOST_NET_MODE="${CLAW_HOST_NET_MODE:-gateway}" \
  -e XDG_CACHE_HOME=/tmp/xdg-cache \
  -w "$REPO" \
  "$IMAGE" \
  bash -c '
    set -e
    # node_modules is a container-local volume: the Mac tree carries
    # darwin-arm64 native builds (better-sqlite3) that will not load here.
    # `bash -c`, not `-lc`: a login shell re-reads /etc/profile and wipes the
    # PATH the image set.
    if [ ! -d node_modules/.pnpm ]; then
      echo "[run-host] installing linux deps into the container volume..."
      pnpm install --frozen-lockfile --store-dir /pnpm-store
    fi
    exec pnpm run dev
  '
