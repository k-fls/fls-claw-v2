# NanoClaw Security Model

> The canonical, continuously-verified version of this model lives at
> [docs.nanoclaw.dev/concepts/security](https://docs.nanoclaw.dev/concepts/security).
> This in-repo copy can drift; if the two disagree, verify against
> `src/container-runner.ts` (`buildMounts`).

## Trust Model

Privilege is **user-level**, persisted in the `user_roles` table (owner /
admin, global or scoped to an agent group) plus `agent_group_members` (the
unprivileged access gate).

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Owners / admins (`user_roles`) | Trusted | Hold owner/admin roles; gate admin commands and approve credentialed actions |
| Group members (`agent_group_members`) | Access-gated | Membership grants access to an agent group, but their messages are still untrusted input |
| Unregistered senders | Untrusted | Subject to each messaging group's `unknown_sender_policy` |
| Agent containers | Sandboxed | Long-lived per-session container; isolated by mounts, non-root, no host reach |
| Incoming messages | User input | Potential prompt injection regardless of who sent them |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (Docker), providing:
- **Process isolation** — container processes cannot affect the host
- **Filesystem isolation** — only explicitly mounted directories are visible
- **Non-root execution** — runs as an unprivileged user (`node`, uid 1000, or the host uid remapped in)
- **Per-session containers** — one long-lived container per session polls that session's DBs and handles many messages, then is torn down (`--rm`) when the session goes idle.

This is the primary security boundary. Rather than relying on application-level
permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

`buildMounts` (`src/container-runner.ts`) composes a fixed set of mounts per
spawn. For the default (Claude) provider these are:

| Container path | Host source | Mode | Purpose |
|---|---|---|---|
| `/workspace` | `data/v2-sessions/<group>/<session>/` | RW | Session folder — `inbound.db`, `outbound.db`, `outbox/`, `.claude/` |
| `/workspace/agent` | `groups/<folder>/` | RW | Agent group working files + `CLAUDE.local.md` |
| `/workspace/agent/container.json` | group `container.json` | RO | Container config — readable, not writable |
| `/workspace/agent/CLAUDE.md` | composed `CLAUDE.md` | RO | Regenerated every spawn; agent edits would be clobbered |
| `/workspace/agent/.claude-fragments` | group `.claude-fragments/` | RO | Composer skill/MCP fragments |
| `/app/CLAUDE.md` | `container/CLAUDE.md` | RO | Shared base doc imported by the composed entry point |
| `/home/node/.claude` | `data/v2-sessions/<group>/.claude-shared/` | RW | Claude state, settings, skill symlinks |
| `/app/src` | `container/agent-runner/src/` | RO | Shared agent-runner source (same for all groups) |
| `/app/skills` | `container/skills/` | RO | Shared container skills |
| `/workspace/extra/<name>` | allowlisted host dir | RO (RW only if allowed) | Operator-configured additional mounts |

The config mounts (`container.json`, `CLAUDE.md`, `.claude-fragments`) are
**nested read-only mounts on top of the read-write group dir** — the agent can
read its config but cannot modify it. The project root is **never mounted**: the
container only ever sees the paths above plus any provider-contributed mounts
(e.g. an OpenCode XDG dir). Host application source (`src/`, `dist/`,
`package.json`) is not reachable.

**Additional-mount allowlist** — extra mounts from a group's container config
are validated against an allowlist at `~/.config/nanoclaw/mount-allowlist.json`,
which is:
- Outside the project root
- Never mounted into containers
- Not modifiable by agents

Its schema:

```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "Dev projects" },
    { "path": "~/Documents/work", "allowReadWrite": false, "description": "Read-only" }
  ],
  "blockedPatterns": ["password", "secret", "token"]
}
```

**Default blocked patterns** (merged with any in the file):
```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc, id_rsa, id_ed25519,
private_key, .secret
```

**Enforcement** (`src/modules/mount-security/index.ts`):
- **No allowlist file ⇒ every additional mount is blocked** — the fixed mounts above are unaffected, but nothing extra is granted until the operator creates the file.
- Symlinks are resolved to their real path (`realpathSync`) before any check, defeating traversal via symlink.
- The real path is rejected if it matches a blocked pattern, and rejected unless it sits under one of `allowedRoots`.
- The container path is validated: relative, non-empty, no `..`, no leading `/`, no `:` (blocks Docker `-v` option injection). It is mounted under `/workspace/extra/`.
- **Read-write is granted only when the mount requests it (`readonly: false`) *and* the matched root has `allowReadWrite: true`.** Otherwise the mount is forced read-only.

### 3. Session Isolation

Per-session state lives under `data/v2-sessions/<agent-group>/<session>/`
(`inbound.db`, `outbound.db`, `outbox/`, `.claude/`). Claude state
(`.claude-shared`) and the working folder are scoped to the agent group, so:
- Different agent groups cannot see each other's conversation history or files.
- A group's sessions share that group's memory but keep separate message DBs.

This prevents cross-group information disclosure.

### 4. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**Never on the container filesystem:**
- The project root and `.env` — never mounted; the container only receives the paths in the mount table above.
- The mount allowlist — external (`~/.config/nanoclaw/…`), never mounted.
- Real credentials — injected per request by the OneCLI gateway, never written into any mount.

### 5. Egress Lockdown (Forced Proxy)

The `HTTPS_PROXY` env var only redirects *proxy-aware* clients — a tool that
ignores it (or a raw socket) could reach the internet directly and bypass
credential injection, approvals, and audit. Egress lockdown closes that hole at
the network layer.

**How it works (in-container firewall).** Rather than putting the container on a
Docker `--internal` network with no route at all, NanoClaw keeps its managed
`nanoclaw` bridge (the static per-container IP that `host-rpc` authorizes by is
load-bearing, and an `--internal` net would sever it). Instead, egress is
enforced *inside* the container:

1. The `egress` spawn observer grants `NET_ADMIN`, drops `NET_RAW`, disables
   IPv6 in the container netns (`--sysctl`), and forces the root-drop launch
   mode.
2. `container/entrypoint.sh`, running as root, installs a **default-DROP OUTPUT
   firewall** (`iptables`) that permits egress ONLY to the host hop: the OneCLI
   proxy (`host:port` parsed from the injected `HTTPS_PROXY`) and the host-rpc
   port. Loopback and established/related return traffic are allowed.
3. The entrypoint then `setpriv`-drops to the host UID with an **empty
   capability bounding set** (`--bounding-set=-all`). Combined with the always-on
   `--security-opt=no-new-privileges`, the unprivileged agent has no `NET_ADMIN`
   and cannot regain it — so it **cannot flush the rules**.

A raw socket or non-proxy-aware client therefore has nowhere to go except the
proxy hop, while `host-rpc` and the credential broker stay reachable (the host
route is preserved, not removed).

- **Fail-closed:** the entrypoint runs under `set -e`, so any firewall error
  aborts the container rather than running it with open egress. The host also
  refuses to spawn (`EgressLockdownError`) if lockdown is on but the root-drop
  launch path is unavailable — it never silently falls back to open egress.
- **Docker-only:** the capability/sysctl/iptables mechanism requires Docker;
  Apple Container is not supported (same gap as the bridge network).

**Default: egress is open.** Lockdown is **off** unless you opt in; by default
the agent reaches the OneCLI gateway over the host-gateway path and outbound
traffic is not confined to the internal network.

**Configuration:**

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false` | Set `true` to opt in (otherwise the host-gateway path is used unchanged). |
| `NANOCLAW_HOST_RPC_PORT` | `17381` | host-rpc port the firewall allowlists (mirrors the host-rpc bind). |

**⚠ Behavior when enabled:** with lockdown on, agents have **no direct
internet** — all traffic must go through OneCLI. Proxy-aware clients (npm, pnpm,
pip, curl, node/bun with the proxy env) are unaffected. Any workflow that relies
on a **non-proxy-aware** tool reaching the internet directly will fail by design.
Lockdown is **off by default**; opt in with `NANOCLAW_EGRESS_LOCKDOWN=true`.

## Resource Limits

Per-container CPU and memory caps are **opt-in and unset by default** — a runaway
agent is not throttled unless the operator configures a limit:

| Env | Default | Meaning |
| --- | --- | --- |
| `CONTAINER_CPU_LIMIT` | *(empty — unbounded)* | Passed to `--cpus` when set (e.g. `2`). |
| `CONTAINER_MEMORY_LIMIT` | *(empty — unbounded)* | Passed to `--memory` when set (e.g. `8g`). |

Only `--memory` is a container-level cap; whether it's a *hard* cap depends on
the host having no swap (a deployment concern). On a swapless host a runaway is
OOM-killed at the limit.

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • Role / access checks (user_roles, agent_group_members)        │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security (pnpm)

NanoClaw uses pnpm with two supply chain defenses configured in `pnpm-workspace.yaml`:

### Minimum Release Age

`minimumReleaseAge: 4320` (3 days). pnpm will refuse to resolve any package version published less than 3 days ago. This defends against typosquatting and compromised maintainer accounts — most malicious publishes are detected and pulled within 72 hours.

**Excluding a package from the release age gate** (`minimumReleaseAgeExclude`):

This should be rare. When a zero-day fix or critical dependency requires an immediate update:

1. The exclusion must be reviewed and approved by a human maintainer
2. The entry must pin the **exact version** being excluded — never a range or wildcard
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # Approved by @user, 2026-04-14 — CVE-XXXX-YYYY fix
   ```
3. The exclusion should be removed once the version ages past the threshold (i.e. after 3 days)
4. Automated agents (Claude, CI bots) must never add exclusions without human sign-off

### Build Script Allowlist

`onlyBuiltDependencies` restricts which packages can execute install/postinstall scripts. Only packages on this list are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding a package to this list requires human approval — build scripts execute arbitrary code with the installing user's permissions.

### `.npmrc` Safety Net

The `.npmrc` file contains `minReleaseAge=3d` as a fallback. The authoritative setting is in `pnpm-workspace.yaml`, but `.npmrc` provides defense-in-depth if npm is ever invoked directly (e.g. by a tool that doesn't respect pnpm).
