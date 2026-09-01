---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription, credentials held on the host by the MITM proxy. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
---

# Codex agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth codex` performs this whole install (manifest-driven from the providers branch: files, barrels, CLI manifest entry, image rebuild) plus the credential check in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Codex provider: copy the payload from the `providers` branch, append one import to each of the three provider barrels, add the pinned Codex CLI to the container manifest (`container/cli-tools.json`), and rebuild.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id, no on-disk transcript).

Credentials go through this edition's **MITM credential proxy** — the same path Claude uses here, and the only one. The real ChatGPT tokens live in the host credential store, scoped to one agent group. At every spawn the host writes the group's `~/.codex/auth.json` filled with **substitutes**: format-preserving placeholders (structurally valid JWTs, a UUID account id) that the proxy swaps for the real values as the request leaves. Nothing in the container authenticates against OpenAI on its own, and nothing reads a key from `.env`. See [docs/mitm-proxy.md](../../docs/mitm-proxy.md).

## Install

### Pre-flight

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/codex.ts` and `src/providers/codex-agents-md.ts`
- `src/providers/codex-credential.ts` (this edition's credential provider — see **Fork-owned files**)
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/providers/codex.ts`
- `import './codex.js';` in `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, and `setup/providers/index.ts`
- an `@openai/codex` entry in `container/cli-tools.json`
- `src/project-doc-compose.ts` — the provider-generic project-doc composer the payload's AGENTS.md spec imports. Absent means this tree predates it; port it before copying the payload or the host typecheck fails.

### Fork-owned files

Four paths are authored on this edition and must **not** be overwritten by a copy or a refresh. `setup/add-codex.sh` already excludes them; a manual apply has to as well:

| Path | Why |
|---|---|
| `src/providers/codex-credential.ts` | The proxy credential provider — substitutes, swap rules, the in-channel sign-in. Upstream has no equivalent. |
| `setup/providers/codex.ts` | Upstream's binds the ChatGPT session into the OneCLI vault, which this fork removed. |
| `container/agent-runner/src/providers/codex-app-server.ts` | Carries the HTTP transport pin. The container rewrites this config at agent-runner startup, so the pin survives nowhere else. |
| `src/providers/codex-host-contribution.test.ts` | This edition's `buildMounts` takes its launch shape from `container-bootstrap`'s snapshot; the test has to initialise one. |

### Fetch and copy

The payload branch lives on the **nanoclaw** remote, which on a fork is not `origin` — resolve it the way the install script does (`setup/lib/channels-remote.sh`), then:

```bash
REMOTE=$(bash -c 'source setup/lib/channels-remote.sh; resolve_channels_remote')
git fetch "$REMOTE" providers
```

Copy each file with `git show "$REMOTE/providers:<path>" > <path>` (additive — never merge the branch):

Host (`src/providers/`):
- `codex.ts` — provider contribution: per-group `.codex-shared` state dir, AGENTS.md compose, skill links
- `codex-agents-md.ts` — AGENTS.md composition (32KB Codex cap: degrades by dropping the largest instruction sections, never blocks a spawn)
- `codex-registration.test.ts` — barrel-driven host registration guard
- `codex-host-contribution.test.ts` — **fork-owned**; copy only if absent
- `codex-agents-md.test.ts` — cap-degradation behavior

Container (`container/agent-runner/src/providers/`):
- `codex.ts` — the provider (turn loop, steering, memory scaffold + `onExchangeComplete` archiving)
- `codex-app-server.ts` — **fork-owned**; copy only if absent
- `exchange-archive.ts` — per-exchange markdown writer the `onExchangeComplete` hook uses (provider-owned, not runner code)
- `exchange-archive.test.ts` — writer behavior
- `codex-registration.test.ts` — barrel-driven container registration guard
- `codex.factory.test.ts`, `codex.turns.test.ts`, `codex-app-server.test.ts` — provider behavior
- `codex-cli-tools.test.ts` — structural guard for the Codex entry in `container/cli-tools.json`

Setup (`setup/providers/`) — **not copied**: `codex.ts` and `codex.test.ts` are this edition's, and the setup registration guard's job is covered by them.

Shared base (skip if present):
- `container/AGENTS.md` — the runtime-contract base the composed AGENTS.md embeds

### Wire the barrels

Append `import './codex.js';` to each of:
- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `setup/providers/index.ts`

### CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. `setup/add-codex.sh` does this step, and its `CODEX_VERSION` is the **canonical pin** — read the value from there rather than repeating it here, so the two can never drift (`setup/providers/codex.test.ts` guards the equality):

```bash
CODEX_VERSION=$(sed -n 's/^CODEX_VERSION="\(.*\)"$/\1/p' setup/add-codex.sh)
node -e '
  const fs = require("fs");
  const file = "container/cli-tools.json";
  const version = process.argv[1];
  const tools = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!tools.some((t) => t.name === "@openai/codex")) {
    tools.push({ name: "@openai/codex", version });
    const fmt = (t) => "  { " + Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + " }";
    fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
  }
' "$CODEX_VERSION"
```

`@openai/codex` has no native postinstall, so no `onlyBuilt`. The Dockerfile already installs every manifest entry via pinned `pnpm install -g`; no Dockerfile edit is needed.

Do not lower the pin. The Codex login client only honours a custom CA from the release that unified its CA handling onward, and this edition's proxy depends on that — an older CLI cannot complete a sign-in through the MITM.

### Build

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

Changing the CLI manifest changes the image. `provider-auth` rebuilds automatically when either `container/Dockerfile` or `container/cli-tools.json` moved; a manual apply has to run `./container/build.sh` itself, or the first Codex turn fails with `spawn codex ENOENT`.

### Restart the host

The image rebuild does not reload the **host**. Codex's host contribution
(`src/providers/codex.ts`) registers the `/home/node/.codex` bind mount + env
passthrough, and the credential provider registers at boot — the running host
only picks either up on restart. Skip this and the first Codex turn fails with
`EACCES` writing `/home/node/.codex/config.toml` — with no mount, Docker
auto-creates the dir root-owned and the non-root container user can't write to it.

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux (systemd)
systemctl --user restart nanoclaw
```

### Validate

```bash
pnpm vitest run src/providers/ setup/providers/ src/modules/mitm-proxy/oauth/handlers/
cd container/agent-runner && bun test src/providers/
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

There is nothing to run here. A Codex group signs itself in, in its own channel, the first time somebody messages it:

1. The wake-time gate sees no Codex credential for the group and offers the ChatGPT sign-in — **only** to an owner, a global admin, or an admin of that agent group. Anyone else gets a message naming who can.
2. The user picks a route. **Browser** (default) runs `codex login`: the runner relays the authorize URL, the user authorizes, their browser fails to reach `localhost:1455`, and they paste that URL back — the host delivers it into the auth container. **Device code** runs `codex login --device-auth`, which needs device-code authorization enabled in ChatGPT security settings (an enterprise workspace often withholds it). **API key** stores a GPG-encrypted OpenAI platform key instead, billed separately from any ChatGPT subscription.
3. They authorize at OpenAI. The container polls the token endpoint; the proxy captures the real tokens out of that exchange, stores them against the group, and hands the container substitutes.
4. The group respawns and answers the original message.

`pnpm exec tsx setup/index.ts --step provider-auth codex` reports whether a group is already signed in and runs the install check; it binds nothing.

**Use a ChatGPT account dedicated to the bot.** OpenAI rotates refresh tokens and detects reuse, so a second consumer on the same account — the signing admin's own Codex CLI, most likely — will be evicted at the first rotation, and so will the group. Reverting the group to Claude does not restore the evicted session.

To re-authenticate after a rejection, the group prompts an admin in-channel automatically; `/auth` reaches the same flow on demand.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Memory does NOT carry over automatically — each provider keeps its own store; run `/migrate-memory` to carry it across. See [docs/provider-migration.md](../../docs/provider-migration.md) for the carry-over table and rollback.

There is no install-wide default provider. Setup's provider picker sets codex on the first agent it creates; creation itself is provider-agnostic (no `--provider` flag — provider is a DB property). Any group switches afterward via `ncl groups config update --provider` as above.

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`.
- **Spawn fails with `requires credential provider(s) not bound to this group: codex`:** nobody has completed the sign-in yet. Message the group as a group admin and accept the offer.
- **Auth errors mid-conversation:** the stored credential was rejected. The group re-prompts an admin in-channel; if the account was evicted at OpenAI (see **Authenticate**), sign in again with an account nothing else is using.
- **The sign-in offer never arrives:** the auth container has to reach the host to relay the code. Check `logs/nanoclaw.error.log` for `host-rpc: unknown caller IP` — the container's source address must resolve to a registered container scope.
