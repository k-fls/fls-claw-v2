# Agent Runtime CLI Versioning

The agent runtime is the CLI binary a provider drives inside the container (for
Claude, `@anthropic-ai/claude-code`). By default a container uses the version
baked into the image, and changing it would mean rebuilding the image. The
runtime-updater lets the host install runtime-CLI versions onto the host
filesystem and point an agent group at one — no image rebuild, no container
downtime beyond the next respawn.

This is a **provider-generic** capability. The host owns the version store,
selection, deletion safety, and auto-update cadence; each provider supplies the
mechanism to install its own CLI and to expose an installed version to a
container. Providers that don't declare the capability simply have no runtime
versioning, and `/agent-runtime` reports "not supported" for their groups.

## Layers

The feature splits cleanly into a provider-supplied **mechanism** and a
host-owned **policy** layer.

| Layer | Owner | Concern |
|-------|-------|---------|
| Install mechanism | provider (`RUNTIME_UPDATER` extension) | Install a version into an immutable host dir; list / locate / remove installed versions; query the latest published version. |
| Update policy | host (`src/modules/runtime-updater/manager.ts`) | Per-provider auto-update cadence, periodic-fetch timer, in-use tracking, deletion safety, spawn-time selection resolution. |
| Version selection | per-group config | Which fetched version a group runs, carried in the provider identity string. |
| Command surface | `src/commands/agent-runtime.ts` | The `/agent-runtime` verbs and their access split. |

### The `RUNTIME_UPDATER` extension contract

A provider declares the capability by exposing a `RUNTIME_UPDATER` extension
(`src/modules/credentials/providers/types.ts`), retrieved via
`provider.getExtension(RUNTIME_UPDATER)`. The contract is deliberately small —
install a version, and report the host directory it lives in:

```ts
interface RuntimeUpdaterExt {
  readonly label: string;        // human label, e.g. "Claude Code"
  readonly packageName: string;  // managed package, e.g. "@anthropic-ai/claude-code"
  latestVersion(): string | null;          // newest published version, or null on lookup failure
  installedVersions(): string[];            // versions installed on disk (unordered)
  installedDir(version: string): string | null;  // host dir of an installed version, or null
  fetch(version: string): Promise<string>;  // ensure installed, return host dir (privileged: runs the installer)
  remove(version: string): void;            // delete an installed version's dir (no-op if absent)
}
```

Each version installs into its **own immutable directory**, so there is no
in-place swap and no lock: a spawn only ever binds a fully-installed,
never-mutated directory, and a different version installs alongside it. How that
directory is mounted into a container, and how the runtime's CLI path is pointed
at it, is the provider's concern (it is runtime-specific) — the extension returns
only the host path. The provider's `AGENT_RUNTIME` extension receives the
resolved `cliVersion` at spawn time and is responsible for mounting it.

`installedDir` is synchronous because the spawn path consults it but never
installs — a group can only select a version a global admin has already fetched.
`fetch` is the privileged path: it runs the installer (for an npm-based CLI, an
`npm install` into the version's directory).

The actual install implementation lives with each provider. The Claude provider
backs its extension with the shared `RuntimeCliUpdater` class
(`src/modules/runtime-updater/updater.ts`), which installs a self-contained copy
of the npm package into `<DATA_DIR>/runtime-cli/<provider>/<version>/` via a
throwaway container running the agent image (so native postinstall binaries match
the runtime container). Other providers may supply their own mechanism.

## Version selection — the provider identity string

A group's selected version is **not** a dedicated column. It rides the existing
agent-runtime identity string used to pick a provider, after a colon:

```
claude            → image-baked default CLI
claude:2.1.154    → the fetched 2.1.154 install
claude:latest     → the newest fetched version at spawn time
```

`parseProviderSpec` (`src/container-config.ts`) splits `id[:version]` into a
`{ id, version? }` pair: the bare id is what container.json, the container side,
and provider lookups expect; the `:version` suffix surfaces separately for the
spawn mount. The identity string lives in `container_configs.provider` (the
group's selection) and may be overridden per session by `sessions.agent_provider`
— a session override replaces the group's selection wholesale, mirroring
provider-id precedence (`resolveProviderSpec`).

### Spawn-time resolution

At spawn the host resolves the selection to a concrete fetched version
(`resolveSelectedVersion`):

- bare provider (no version) → `null` — use the image-baked CLI;
- `latest` → the newest fetched version (`null` if none fetched);
- an exact version → that version if fetched (`null` otherwise).

Resolution **never installs** — it only reports what a global admin has already
fetched. If the version isn't present, the spawn falls back to the image-baked
CLI rather than blocking.

`latest` resolves to the then-newest fetched version. A newer version fetched
later does not retroactively change a running container's CLI; the container
keeps what it mounted until it respawns.

## Auto-update policy

Per provider, the host can keep the version store fresh by periodically fetching
the latest published CLI. The cadence is a single global-admin setting string per
provider, persisted in the central DB (`runtime_auto_update`, migration 016) so
it survives restarts.

`parseRuntimeUpdate` interprets the setting (provider-agnostic):

| Setting | Mode | Behavior |
|---------|------|----------|
| `''` (or unrecognized) | off | No auto-update. |
| `24h` / `1d` / `30m` | latest | Fetch the newest published version now, then on the given interval. |
| `2.1.92` (`major.minor[.patch]`) | pinned | Fetch this exact version once. |

`RuntimeUpdateManager` (one per provider) owns the setting and the timer.
`reconfigure(setting)` persists the new setting and applies it (initial fetch +
reschedule). The periodic timer is `unref`'d so it never holds the process open.

At boot, `startRuntimeUpdaters()` (called from `src/index.ts`) creates a manager
for every provider that declares `RUNTIME_UPDATER`, seeds each from the DB, and
applies it. `stopRuntimeUpdaters()` clears the timers on shutdown. A
per-provider manager registry (`getRuntimeUpdateManager(providerId)`) backs the
command's global-admin verbs.

## Deletion safety and in-use tracking

A fetched version may be removed, but not while it is in use. `canRemoveVersion`
refuses when the version is either:

1. **selected by a group's config** — removing it would break that group's next
   spawn (the global admin must change the group's selection first); or
2. **mounted in a running container** — including a `latest` container that froze
   onto it at spawn.

Case (2) relies on **in-use tracking**: because `latest` freezes onto the
then-newest version at spawn and can later be superseded, the running version
can't be recomputed from config. The host therefore records the concrete version
each running container actually mounted, keyed by session id. `container-runner`
calls `markCliVersionInUse` at spawn — before the first await that precedes the
mount, closing the TOCTOU window against a concurrent `remove` — and
`releaseCliVersionInUse` on every exit and spawn-error path. `cliVersionsInUse`
reports the concrete versions a provider's running containers hold.

## The `/agent-runtime` command

Manage the agent runtime's CLI version from a chat channel. The command is
registered with `scope: 'channel'` (one invocation; the handler enumerates the
agent groups wired to the channel via the wirings). A leading non-verb token is
read as an explicit group folder; if the channel engages exactly one group it is
implied, otherwise the command asks the caller to name one.

```
/agent-runtime [group]                         show runtime CLI status
/agent-runtime [group] select <version|latest> point the group at a fetched version
/agent-runtime fetch <version|latest>          install a version into the shared store
/agent-runtime remove <version>                delete a fetched version from the store
/agent-runtime auto <duration|off>             periodic latest fetch
```

### Access split

The verbs fall into two access tiers by design, and because a channel-scope
command can't have a group resolved by the gate, every privilege check runs in
the handler:

| Verb | Access | Why |
|------|--------|-----|
| status (no verb) | group-admin of the resolved group | Reads one group's selection + the shared store. |
| `select` | group-admin of the resolved group | Changes one group's choice among already-fetched versions — a group-config edit. |
| `fetch` | global-admin | Installs into a host store shared by every group on the provider, and runs the installer (supply-chain-sensitive). A per-group admin must not drive a host-wide install. |
| `remove` | global-admin | Deletes from the shared store. |
| `auto` | global-admin | Sets host-wide, per-provider cadence. |

`select` validates that the named version is already fetched (or `latest`); if
not, it tells the caller a global admin must `fetch` it first. It writes the
group's selection by setting `container_configs.provider` to `<id>:<version>`.

`fetch` and `auto` run in the background — the installer is a multi-minute
operation — so the handler acks immediately and reports the result via a later
reply. `remove` first checks `canRemoveVersion` and refuses with the reason if
the version is selected or in use.

A version change applies to **subsequently-spawned** containers; running
containers keep their current CLI until they respawn.

## Key files

| File | Purpose |
|------|---------|
| `src/modules/runtime-updater/updater.ts` | `RuntimeCliUpdater` — the install/locate/list/remove mechanism; `maxSemver`. |
| `src/modules/runtime-updater/manager.ts` | `RuntimeUpdateManager`, the per-provider registry, auto-update parsing, selection resolution, in-use tracking, deletion safety. |
| `src/modules/runtime-updater/index.ts` | Module barrel. |
| `src/commands/agent-runtime.ts` | The `/agent-runtime` command + access split. |
| `src/db/runtime-auto-update.ts` | Persistence for the per-provider auto-update setting. |
| `src/db/migrations/016-runtime-version.ts` | `runtime_auto_update` table. |
| `src/container-config.ts` | `parseProviderSpec` / `resolveProviderSpec` — the `provider:<version>` identity string. |
| `src/modules/credentials/providers/types.ts` | `RuntimeUpdaterExt` contract + `RUNTIME_UPDATER` extension key. |
| `src/container-runner.ts` | Spawn-time selection resolution + in-use mark/release. |
