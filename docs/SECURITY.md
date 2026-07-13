# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (MITM credential proxy)

Real API credentials **never enter containers**. This fork runs a host-side **MITM credential proxy** (`src/modules/mitm-proxy/`, `src/modules/credentials/`) that hands containers substitute tokens and swaps in the real secret at the proxy boundary. Full contract: [mitm-proxy.md](mitm-proxy.md).

**How it works:**
1. Real credentials live on the host in the credentials module; the container is given a **format-preserving substitute** — a placeholder that looks like the real token but is useless outside this container.
2. When NanoClaw spawns a container, the credential-proxy lifecycle observer injects `HTTP_PROXY` and installs the host's MITM CA into the container's trust stores. Outbound HTTPS (explicit proxy or DNAT'd `:443`) is intercepted.
3. For providers whose host rules are registered, the proxy MITMs the TLS connection, swaps the substitute in request headers for the real token, and forwards. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`.
4. Substitutes are pulled on demand via `GET /credentials/<providerId>/substitute` (the `get_credential` MCP tool inside the container), or published as env vars at startup.

**Per-group scope:**
The proxy identifies the calling container by IP → group scope and resolves credentials through that group's per-group resolver, which enforces grant/borrow access checks. A group only reaches its own credentials (or ones explicitly borrowed from another group), and a group-declared provider def is confined to the registrable domain its credential was issued for.

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### 6. Egress Lockdown (Forced Proxy)

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
   firewall** (`iptables`) that permits egress ONLY to the host hop: the
   credential proxy (`host:port` parsed from the injected proxy URL) and the host-rpc
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

**Configuration:**

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false` | Set `true` to opt in (otherwise the host-gateway path is used unchanged). |
| `NANOCLAW_HOST_RPC_PORT` | `17381` | host-rpc port the firewall allowlists (mirrors the host-rpc bind). |

**⚠ Behavior when enabled:** agents have **no direct internet** — all traffic
must go through the proxy hop. Proxy-aware clients (npm, pnpm, pip, curl,
node/bun with the proxy env) are unaffected. Any workflow relying on a
**non-proxy-aware** tool reaching the internet directly will fail by design.
Lockdown is **off by default**.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Store (SQLite DB) | `/workspace/project/store` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

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
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • MITM credential proxy (injects credentials, enforces scope)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through the MITM credential proxy            │
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
