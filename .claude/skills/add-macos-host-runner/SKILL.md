---
name: add-macos-host-runner
description: Run the NanoClaw host inside the Docker VM on macOS, so agent containers keep their real source IP and the credential proxy and host-rpc can identify them. Fixes "unknown caller IP, rejecting callerIP=127.0.0.1" and every credential sign-in and credential use failing on Docker Desktop for macOS. macOS only.
---

# Run the host inside the Docker VM (macOS)

On Docker Desktop for macOS, a host process running **on the Mac** is reached by
containers through Docker's port-forwarder, which rewrites the source address to
`127.0.0.1`. `lookupContainerIP` cannot identify the caller, so both host-rpc and the
credential proxy reject every container:

```
WARN host-rpc: unknown caller IP, rejecting  callerIP="127.0.0.1"
WARN Rejecting HTTP request from unknown container IP  remoteIP="127.0.0.1"
```

That blocks credential sign-in *and* credential use, for every provider — the MITM
credential path is unusable.

Run the same host process **inside the VM** and the container's real bridge IP survives.
This skill installs a small image and a launcher that do exactly that.

**macOS only**, and only for a Docker Desktop / Colima style VM-backed daemon. On Linux
the host already sees real container IPs; this skill is unnecessary there.

## Phase 1: Pre-flight

### Check platform

```bash
uname -s
```

If the output is not `Darwin`, stop and tell the user:

> This skill is macOS only. On Linux the host process already sees real container source
> IPs, so the containerized host runner solves nothing.

### Check Docker is running

```bash
docker info --format '{{.ServerVersion}}'
```

If this fails, tell the user to start Docker Desktop and re-run the skill.

### Check the host's networking module is present

```bash
grep -l 'CLAW_HOST_NET_MODE' src/modules/container-bootstrap/network.ts
```

If the file or the symbol is missing, stop and tell the user:

> This install predates `CLAW_HOST_NET_MODE`. The runner relies on the host binding its
> services to the nanoclaw bridge gateway, which that setting controls.

### Check for an already-installed runner

```bash
ls dev/host-runner/run-host.sh 2>/dev/null
```

If present, the skill is already installed — re-running the copy steps below is safe and
picks up any updates.

## Phase 2: Install

### Copy the runner in

```bash
mkdir -p dev/host-runner
cp "${CLAUDE_SKILL_DIR}/add/Dockerfile"   dev/host-runner/Dockerfile
cp "${CLAUDE_SKILL_DIR}/add/run-host.sh"  dev/host-runner/run-host.sh
cp "${CLAUDE_SKILL_DIR}/add/ncl"          dev/host-runner/ncl
chmod +x dev/host-runner/run-host.sh dev/host-runner/ncl
```

### Build the image

```bash
docker build -t claw-host:latest dev/host-runner
```

### Stop any Mac-side host

The containerized host binds the same TCP ports and the same unix sockets under the
shared `data/` directory, so the two cannot both run.

```bash
launchctl bootout gui/$(id -u)/com.nanoclaw 2>/dev/null || true
pkill -f 'tsx src/index.ts' 2>/dev/null || true
pkill -f 'node dist/index.js' 2>/dev/null || true
```

If the user runs the host under a slug-scoped launchd label rather than `com.nanoclaw`,
find it with `launchctl list | grep -i nanoclaw` and bootout that label instead.

### Start it

```bash
./dev/host-runner/run-host.sh
```

With a terminal attached this runs in the foreground. Without one it detaches, because a
foreground `docker run` dies with whatever process holds it — an automation harness
reaping its background task would otherwise take the host down with it. Detached logs are
at `docker logs -f claw-host`.

First start populates a container-local `node_modules` volume with
`pnpm install --frozen-lockfile`, which takes a few minutes.

## Phase 3: Verify

### The container is up

```bash
docker ps --filter name=claw-host --format '{{.Names}} {{.Status}}'
```

### Callers are identified

Wake any agent group and confirm the two rejection warnings above are absent from the
host log. When the caller is identified, the same probes return errors *about the
request* rather than about the caller:

```
host-rpc  → {"ok":false,"error":"no-active-auth-episode"}
proxy     → No credentials found for provider 'claude' ... in scope '<group>'
```

### `ncl` works

```bash
./dev/host-runner/ncl groups list
```

`ncl` must run inside the container: the CLI's unix socket lives under the repo's `data/`
directory, is created inside the VM, and a unix socket on a virtiofs share does not work
across the VM boundary — connecting from the Mac gets `ECONNREFUSED`. The wrapper is a
`docker exec` into `claw-host`.

Tell the user to use `./dev/host-runner/ncl` in place of `./bin/ncl` while the
containerized host is running.

## Testing

This skill makes no reach-in into existing code: it adds three files under
`dev/host-runner/` and changes how the operator launches an unmodified host process.
There is no line in the tree whose deletion a test could catch, so an integration test is
structurally inapplicable. Verification is Phase 3, run against the live host.

## Three things that are load-bearing

**Identical paths.** The repo and `$HOME` are mounted at their *Mac* paths, unchanged.
The host computes absolute host paths and passes them to `docker run -v`, and the daemon
resolves those against the Mac filesystem — any other mount point produces bind mounts
the daemon cannot find.

**`node_modules` is a container-local volume.** The Mac tree carries darwin-arm64 native
builds (`better-sqlite3`) that will not load on linux-arm64, so the mount shadows it and
`pnpm install --frozen-lockfile` populates the volume on first run.

**The host must not run as root.** `resolveLaunchMode` reads `process.getuid()` and
passes it to agent containers as `HOST_UID`, which their entrypoint setpriv-drops to. A
root host therefore produces a root agent, and the Claude CLI refuses outright:
`--dangerously-skip-permissions cannot be used with root/sudo privileges`. `run-host.sh`
runs `--user $(id -u):$(id -g)` plus `--group-add 0` for the root-owned docker socket.

## Configuration

`run-host.sh` reads these from the environment:

| Variable | Default | What it does |
|---|---|---|
| `REPO` | derived from the script's location | Repo root, mounted at its Mac path |
| `MAC_HOME` | `$HOME` | Mounted for `~/.config/nanoclaw` |
| `IMAGE` | `claw-host:latest` | Image to run |
| `CLAW_HOST_NET_MODE` | `gateway` | `gateway` binds host-rpc and the proxy to the nanoclaw bridge gateway and points `host.docker.internal` at it inside agent containers. `open` binds `0.0.0.0` and also works |
| `LOG_LEVEL` | `info` | Host log level |
| `RUN_UID` / `RUN_GID` | `id -u` / `id -g` | Non-root user to run as |
| `SOCK_GID` | `0` | Group added for `/var/run/docker.sock`, which is root-owned inside the VM |

## Troubleshooting

**A bare `Error: Claude Code process exited with code 1` in chat.** Usually the root-host
blocker above. The real message is invisible because the provider passes no `stderr`
callback to the Agent SDK and the subprocess's stderr is discarded. To recover it, run
the SDK by hand inside the container with `stderr: (d) => process.stderr.write(d)` set.

**Permission errors installing into the volumes.** `claw-host-node-modules` and
`claw-host-pnpm-store` are owned by whoever ran the first install. If that was root:

```bash
docker run --rm -v claw-host-node-modules:/nm alpine chown -R $(id -u):$(id -g) /nm
```

**`Failed to chmod ncl socket (continuing)` on boot.** Benign: virtiofs does not support
chmod on a socket, and the code carries on.

**Finding the proxy port.** It is dynamic (`port: 0`), so it changes every boot. Read it
from the `Credential proxy started` log line.

**A note on `gateway` mode.** `gatewayIP()`'s docstring in
`src/modules/container-bootstrap/network.ts` warns that Docker masquerades
container→host traffic even to the same-bridge gateway, so the source IP survives only
with a NOMASQ rule. Measured directly from inside the VM, it survives without one: a
listener on `172.29.0.1` in a `--network host` container saw `PEER=172.29.0.2` from a
peer on the `nanoclaw` network. If a caller is nonetheless rejected in `gateway` mode,
set `CLAW_HOST_NET_MODE=open`.

## Next steps

To go back to a Mac-side host, run `/add-macos-host-runner` removal — see
[REMOVE.md](REMOVE.md).
