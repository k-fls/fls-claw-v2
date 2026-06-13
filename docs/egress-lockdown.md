# Egress Lockdown — Host-Side Wiring

Opt-in enforcement that forces all agent container traffic through the proxy
hop. The conceptual model, threat it closes, and the in-container firewall are
described in the **"Egress Lockdown (Forced Proxy)"** section of
[SECURITY.md](SECURITY.md). This document covers the host side: how a spawn
acquires the lockdown flags and env, and the fail-closed guard that refuses to
launch when the firewall could not be installed.

Off by default. Opt in with `NANOCLAW_EGRESS_LOCKDOWN=true`.

## Policy module (`src/egress-lockdown.ts`)

A small policy module with no host orchestration of its own — it is consumed by
the `egress` container-bootstrap observer and by `container-runner`.

- `egressLockdownEnabled()` — `true` iff `NANOCLAW_EGRESS_LOCKDOWN === 'true'`
  (exact match; any other value, including unset, is off).
- `egressSpawnArgs()` — the docker run flags a locked-down container needs:
  - `--cap-add=NET_ADMIN` so the root entrypoint can install the firewall.
  - `--cap-drop=NET_RAW` so no leftover raw-socket capability survives in the
    bounding set to bypass netfilter.
  - `--sysctl net.ipv6.conf.{all,default}.disable_ipv6=1` so an IPv6 route can't
    bypass the v4-only ruleset (avoids needing `ip6tables` in the image).
- `egressSpawnEnv()` — the env the entrypoint reads:
  - `NANOCLAW_EGRESS_LOCKDOWN=1` — the firewall trigger.
  - `NANOCLAW_HOST_RPC_PORT` — the host-rpc port to allowlist, sourced from
    `hostRpcPort()`. This is imported from the host-rpc **leaf** module
    (`modules/host-rpc/port.js`), not the barrel, so the allowlisted port is
    derived from the same source the host-rpc server binds — they cannot drift —
    while avoiding the import cycle the barrel would introduce.
- `assertEgressLaunchable(launchMode)` — the fail-closed guard (below).
- `EgressLockdownError` — raised by the guard.

## Spawn-arg / env wiring (the `egress` observer)

`src/modules/container-bootstrap/egress-observer.ts` self-registers an `egress`
container-lifecycle observer (via the side-effect import in the
container-bootstrap barrel). On `onSpawnPre`:

- When lockdown is disabled it returns nothing — a complete no-op.
- When enabled it contributes `egressSpawnArgs()` + `egressSpawnEnv()` and sets
  `needsRootEntrypoint: true`.

The `needsRootEntrypoint` flag pushes privilege resolution to the **root-drop**
launch mode, which is what makes the root entrypoint actually run as root so it
can install iptables. The observer composes with the `container-ip` observer:
that one supplies `--network nanoclaw --ip <ip>` (kept intact — the host route
that `host-rpc` and the credential broker rely on is preserved, not removed),
and the `egress` observer layers the capability/sysctl flags and lockdown env on
top.

## Fail-closed guard (`assertEgressLaunchable`)

The firewall only exists on the root-drop launch path. If lockdown is requested
but the resolved launch mode is anything else (e.g. a host that did not expose a
UID/GID to drop to), the agent would run with the firewall never installed —
i.e. open egress. To prevent that, `container-runner` calls
`assertEgressLaunchable(resolveLaunchMode(true))` **before** `fireSpawnPre`
allocates the container IP, so the throw frees no resources:

- Disabled → no-op.
- Enabled and `launchMode.kind === 'root-drop'` → proceeds.
- Enabled and any other launch mode → throws `EgressLockdownError`.

The check passes `resolveLaunchMode(true)` because the `egress` observer forces
`needsRootEntrypoint`, so the mode resolved here matches the one this spawn will
actually use.

This is the host half of a two-layer fail-closed contract: the entrypoint runs
under `set -e`, so any in-container firewall error aborts the container, and the
host refuses to spawn at all when the root-drop path is unavailable. Egress is
never silently left open.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false` | Set `true` to opt in. |
| `NANOCLAW_HOST_RPC_PORT` | `17381` | host-rpc port the firewall allowlists (mirrors the host-rpc bind). |

Docker only — the capability/sysctl/iptables mechanism is unavailable on Apple
Container (the same gap as the bridge network).
