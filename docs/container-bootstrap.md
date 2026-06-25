# Container Bootstrap

## Summary

One module that owns the full container-launch contract: snapshot
management, the default launch shape, lifecycle observers, privilege-mode
resolution, the bridge-network IP registry, and the reserved env-var
registry. Other modules that need to influence container spawn (allocate
IPs, install an egress firewall, ensure an `/etc/passwd` entry) register an
observer here rather than reaching into `container-runner.ts`.

The module has no DB and no migrations. `initSnapshot()` and
`ensureContainerNetwork()` are the only entry points that touch host state;
both are called explicitly from `src/index.ts` at boot.

## Responsibilities

1. **Snapshot management** (`snapshot.ts`) — `initSnapshot()` runs once at
   host boot. Copies `process.cwd()/container/` →
   `DATA_DIR/snapshot/container/` (excluding `node_modules`). The snapshot
   is regenerated on every host start, so a `git pull` between restarts
   always wins. Containers mount from the snapshot, not the live tree, so
   mid-run host edits don't disturb in-flight containers. After the copy,
   `initSnapshot()` asserts a set of required paths exist (entrypoint plus
   the agent-runner entry points); a partial copy is caught at boot rather
   than surfacing later as an opaque container-side failure.
2. **Default launch shape** (`launch-shape.ts`) — `defaultLaunchShape()`
   produces the snapshot-derived read-only mounts every container gets:
   `/app/entrypoint.sh`, `/app/src` (agent-runner), `/app/skills`,
   `/app/CLAUDE.md` (when present). Per-spawn dynamic mounts (session dir,
   group dir, `.claude-shared`, additional `container.json` mounts, provider
   mounts, group contributions) stay in `container-runner.buildMounts`.
3. **Lifecycle observers** (`registry.ts` + `fire.ts`) — `onSpawnPre`,
   `onContainerStarted`, `onContainerExited`. See "Observer dispatch
   contract".
4. **Privilege-mode resolution** (`privilege.ts`) — a pure function over the
   aggregate `needsRootEntrypoint` flag. See "Privilege-mode contract".
5. **Bridge-network IP registry** (`ip-registry.ts` + `network.ts`) — a
   process-local map from container IP to its owning scope, plus the Docker
   network plumbing. The allocation itself is wired through the lifecycle
   pipeline by `ip-observer.ts`, which self-registers on import. Other
   consumers resolve `caller IP → ContainerScope` via `lookupContainerIP()`.
6. **Reserved env-var registry** (`reserved-env.ts`) — the single source of
   truth for which env-var names the host already injects into containers.
   See "Reserved env-var registry".

## Observer dispatch contract

- Duplicate `id` throws at registration.
- Observers run in registration order. All callbacks are synchronous.
- `onSpawnPre` results merge: arrays (mounts, args) concatenate, env objects
  shallow-merge (last write wins on key collision, logged with both origins),
  `needsRootEntrypoint` is OR'd, and `cleanup` callbacks are collected.
- A throwing `onSpawnPre` observer is wrapped in `FatalSpawnError` and aborts
  the spawn (classified non-retryable by the caller's existing catch path).
- The other phases isolate failures: a throwing observer is logged with id +
  phase + error and does **not** abort the remaining observers.
- `onContainerStarted` fires once per session, after the spawn process is
  alive and before the first poll.
- `onContainerExited` fires exactly once per session, even on spawn error.
  `reason` discriminates: `'normal'` (close handler), `'killed'`
  (`killContainer` was called), `'spawn-error'` (error handler or a failure
  before the process was alive).
- `cleanup` callbacks collected from `onSpawnPre` results fire from
  `onContainerExited` even when no observer registered an exit hook and even
  when the spawn failed before the process started. Each cleanup is wrapped
  in a once-shim at the collection boundary, so the idempotency claim in
  `SpawnPreResult` holds regardless of how `fireContainerExited` is invoked.
  This is how the IP observer releases its IP without needing a separate exit
  hook.

## Privilege-mode contract

`resolveLaunchMode(needsRoot, hostIds?)` returns:

- `{ kind: 'rootless', userArg: 'UID:GID' }` — the default. The container
  runs as the host user.
- `{ kind: 'rootless', userArg: null }` — when the host UID is `0` or `1000`
  (the image's baked-in default) or when UID/GID are unavailable (non-POSIX
  host). The `--user` flag is omitted entirely.
- `{ kind: 'root-drop', envVars: { HOST_UID, HOST_GID } }` — when any
  contribution sets `needsRootEntrypoint: true`. The container starts as
  root, the entrypoint runs its root-only blocks, then setpriv-drops to
  `HOST_UID:HOST_GID` before exec-ing bun. If root is requested but the
  platform can't expose UID/GID, this falls back to `rootless` rather than
  handing setpriv an empty argument. Combined with host-side
  `--security-opt=no-new-privileges`, no privilege regain is possible after
  the drop.

## Bridge network and IP registry

`network.ts` owns the `nanoclaw` Docker bridge network (created once at host
startup via `ensureContainerNetwork()`) and a monotonic-counter IP allocator
inside its `/16` subnet. The subnet defaults to `172.29.0.0/16` and is
overridable via `CLAW_SUBNET` (must be `X.Y.0.0/16`). The pool skips the
network and gateway addresses. Inter-container communication is disabled on
the bridge (`com.docker.network.bridge.enable_icc=false`). Apple Container
has a different networking model and no `docker network create` analog;
bridge setup is skipped (with a warning) on non-Docker runtimes.

`ip-registry.ts` is a process-local, in-memory map from a container IP to its
owning `ContainerScope` (a branded string carrying the agent-group folder).
Container ↔ IP is 1:1. The map is ephemeral — it starts empty after a host
restart, which is correct because containers spawn fresh. `allocateContainerIP`
sets the entry and returns an idempotent `release()`; `lookupContainerIP`
resolves an incoming connection's source IP to its scope — authoritative and
unspoofable, unlike a container-supplied id. `onAllocate` / `onRelease` hooks
let future consumers react to lifecycle without modifying the registry.

## Reserved env-var registry

`reserved-env.ts` is the single source of truth for "which env-var names is
the host already injecting into containers." Each contributor of `-e` flags
reserves the names it injects at module load:

```ts
reserveEnvName('HTTP_PROXY', 'some-module');
```

A set of dangerous shell/runtime names (`PATH`, `SHELL`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `NODE_OPTIONS`, etc.) is always reserved — they aren't
injected by anyone, but allowing them through a runtime-substitute path would
invite container escape. The container-runner reserves its own statics
(`TZ`, `HOME`, `HOST_UID`, `HOST_GID`), and the bootstrap module reserves
`ENSURE_PASSWD_ENTRY` (the entrypoint passwd-shim gate). Re-registration by
the same owner is a no-op; by a different owner it is logged at warn.

`isEnvNameReserved(name)` is consumed by any host-curated env path (see
"Custom container env") so injected names can never be silently shadowed.

## Custom container env

`src/modules/container-env/index.ts` lets an operator or agent persist
arbitrary environment variables for an agent group across sessions by
appending JSONL lines to `groups/<folder>/env-custom.jsonl`
(`{"name":"FOO","value":"bar"}`). On each spawn the host curates the file and
injects the result through the agent-group contribution registry, so the
values land in the container env. Curation rules:

- the name must match `UPPER_SNAKE` format;
- the name must not be reserved by the host (the same `isEnvNameReserved`
  registry — so custom env can never shadow a var the container-runner
  injects);
- last write wins for a duplicated name;
- a malformed line is skipped (logged), never fatal.

## Persistent group home

`container-runner.prepareGroupHomeDir(homeDir)` prepares the per-group
persistent home directory backing `/home/node`, mounted read-write at
`DATA_DIR/v2-sessions/<agent-group>/home`. Subdirectories (tool config and
caches like `.config/gh/`, `.aws/`, `.npm/`) survive across runs so tool
state isn't lost between sessions. Top-level flat files in `~/` are removed
on every launch to prevent dotfile injection (`.bashrc`, `.profile`,
`.bash_profile`) from carrying between sessions — this wipe is the security
boundary, not incidental cleanup. Nested files (e.g. `.config/gh/hosts.yml`)
are untouched. The per-group `.claude-shared` directory nests on top of this
mount at `/home/node/.claude`.

## Entrypoint env-var schema

The script at `container/entrypoint.sh` (mounted from the snapshot) reads:

| Var | Set by | Effect |
| --- | ------ | ------ |
| `ENSURE_PASSWD_ENTRY` (+ `HOST_UID` / `HOST_GID`) | an `onSpawnPre` observer | append an `/etc/passwd` entry when none matches `HOST_UID` |
| `NANOCLAW_EGRESS_LOCKDOWN` | the `egress` observer | install the in-container egress firewall before dropping privileges |
| `HOST_UID` / `HOST_GID` | container-runner when `launchMode='root-drop'` | setpriv args for the privilege drop |

Each block is independent and env-gated, so a plain spawn (no contributing
observers) takes the default `cat > /tmp/input.json; exec bun ...` path. When
the script starts as root (root-drop mode), it runs its root-only blocks and
then `setpriv`-drops to `HOST_UID:HOST_GID` before exec-ing bun.

## Built-in observers

- **`container-ip`** (`ip-observer.ts`) — allocates a bridge-network IP at
  spawn, splices `networkArgs(ip)` into the Docker args, and releases the IP
  on exit (including spawn error) via a `cleanup` callback. The scope key is
  the agent-group folder.
- **`egress`** (`egress-observer.ts`) — when `NANOCLAW_EGRESS_LOCKDOWN` is
  enabled, contributes the Docker capability/sysctl flags and the lockdown
  env that let the root entrypoint install an in-container egress firewall,
  and forces the root-drop launch mode so that entrypoint actually runs as
  root. No-op when lockdown is disabled. Composes with `container-ip`: the IP
  observer supplies the static IP, this one layers the lockdown flags on top.

## Public surface

```ts
// snapshot
initSnapshot(): void
snapshotPath(relative?: string): string

// observers
interface ContainerLifecycleObserver {
  onSpawnPre?(ctx: SpawnPreContext): SpawnPreResult | void
  onContainerStarted?(ctx: LifecycleContext): void
  onContainerExited?(ctx: ExitContext): void
}
// SpawnPreContext: { agentGroup, session }.
//   containerName is NOT here — it is created after fireSpawnPre; observers
//   needing it use the later phases (LifecycleContext / ExitContext both
//   carry containerName).
registerContainerLifecycleObserver(id, obs): void
clearContainerLifecycleObservers(): void  // tests

// dispatch (used only by container-runner)
fireSpawnPre(ctx): MergedSpawnPre
fireContainerStarted(ctx): void
fireContainerExited(ctx, cleanups?): void

// launch shape
defaultLaunchShape(): { mounts: VolumeMount[] }

// privilege
resolveLaunchMode(needsRoot, hostIds?): LaunchMode

// IP registry + network
allocateContainerIP(scope): AllocatedIP
lookupContainerIP(ip): ContainerScope | null
networkArgs(ip): readonly string[]
ensureContainerNetwork(): void

// reserved env-var registry
reserveEnvName(name, owner): void
isEnvNameReserved(name): boolean
reservedEnvNames(): ReadonlySet<string>
```

## Out of scope

- Per-group writable copy of `agent-runner/src` (a `.fingerprint`-style
  resync). The snapshot read-only mount is enough for the "ad-hoc updates
  without rebuild" goal; defer until a self-mod tier explicitly needs it.
- Async observers. The pipeline stays synchronous.
- Mid-life observers (`onIdle`, `onHeartbeat`).
- Versioned or garbage-collected snapshots. One snapshot per host process is
  enough.
</content>
</invoke>
