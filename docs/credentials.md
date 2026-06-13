# Credentials

The host-side credential substrate. It provides the storage, scoping,
sharing, and provider model that credential-using features (agent
providers, integrations) build on. The module owns:

- two branded scope types that keep storage location and runtime
  identity distinct at the type level,
- a credential-provider registry with a generic typed-extension
  mechanism,
- a per-agent-group cached resolver (the encrypted-at-rest ↔
  plaintext-in-use boundary),
- per-scope GPG keyrings for the encrypted-paste UX,
- a plaintext-envelope store with an attached manifest pipeline,
- filesystem-only grant/borrow state,
- a scope-invalidator registry, and
- the `/creds` host command.

Importing the module performs **no filesystem I/O** — no directory
creation, no key generation, no file writes happen at load time. The
first writes happen only when a real code path (a store call, a
manifest hook, a `/creds` subcommand) mutates credential state.

All public symbols are exported from
`src/modules/credentials/index.ts`.

## Scope types

```ts
export type CredentialScope = string & { readonly [__credentialScope]: true };
export type GroupScope      = string & { readonly [__groupScope]:      true };

export function asCredentialScope(s: string): CredentialScope;
export function asGroupScope(s: string): GroupScope;
```

Two distinct branded string types, both derived from `agent_group_id`,
kept distinct at the type level so storage location and runtime
identity cannot be conflated by accident.

- **`GroupScope`** — runtime identity. "Who is making this request."
  A `GroupScope` may resolve to *delegated* credentials: its own plus
  any granted to it. Used by access checks, token resolution, and
  container provisioning.
- **`CredentialScope`** — on-disk storage location. "Where the value
  lives on disk." A `CredentialScope` is exactly one scope, with no
  delegation. Used by store I/O, manifest writes, and scope-directory
  paths.

The two diverge under grant/borrow: an agent group running as
`GroupScope=X` may legitimately read credentials from
`CredentialScope=Y` because Y has granted to X. The branding makes
wrong-direction usage a compile error.

The rule of thumb for which brand a parameter takes:

- **Read / mint / resolve** a credential → `GroupScope`. Borrowing is
  allowed; the resolver maps the `GroupScope` to the effective
  `CredentialScope` for the caller.
- **Write / store** a credential → `CredentialScope`. Always own-scope:
  `resolver.store` throws if the scope is not the resolver's own
  folder.

`asCredentialScope` and `asGroupScope` are the only legitimate way to
cross from a raw `string` to a branded value. They record intent at the
point of conversion and make the crossing grep-able.

There is no "global" / "main" / `'default'` scope value. Every
credential belongs to exactly one `CredentialScope`; cross-group
sharing happens via explicit grant.

## Credential shape

```ts
export interface Credential {
  value: string;
  updated_ts: number;
  expires_ts?: number;
  authFields?: Record<string, string>;
  boundDomain?: string;
  refresh?: { value: string; updated_ts: number; expires_ts?: number };
}
```

`Credential` is the shape an entry takes as it travels across the
resolver↔consumer boundary.

- `value` and `refresh.value` are the secret strings. In the resolver's
  cache and inside the on-disk keys file they carry `enc:...`
  ciphertext; `resolve()` returns them as decrypted plaintext, and the
  consumer owns the plaintext from that point on.
- `authFields` carries non-secret per-credential metadata (e.g. an SSH
  host/port/username). It is plaintext on every surface — never
  encrypted, never cached separately.
- `expires_ts` / `refresh.expires_ts` are optional expiry timestamps;
  `boundDomain` is optional metadata a writer may stamp on an entry.

## Provider registry

A `CredentialProvider` is a storage-namespace participant. Every
`providerId` stored under `{scope}/{providerId}.json` has a registered
provider that fully describes how its JSONL manifest is built and what
fires after the manifest file is written or deleted on disk. Nothing
more belongs on this interface — auth-flow hooks, env bindings, host
routing, and catalog metadata live with their own consumers, not on
this type.

```ts
export interface CredentialProvider {
  readonly id: string;
  buildManifest(scope: CredentialScope): string[];
  onManifestWritten(scope: CredentialScope): void;
  onManifestDeleted(scope: CredentialScope): void;
  getExtension?<T>(type: ExtensionType<T>): T | undefined;
}

export function registerCredentialProvider(p: CredentialProvider): void;
export function getCredentialProvider(id: string, scope?: CredentialScope): CredentialProvider | undefined;
export function getAllCredentialProviders(scope?: CredentialScope): CredentialProvider[];
export function setScopedCredentialProviders(scope: CredentialScope, list: readonly CredentialProvider[]): void;
export function clearScopedCredentialProviders(scope: CredentialScope): void;
```

- `buildManifest`, `onManifestWritten`, and `onManifestDeleted` are
  **required**. There is no fallback path inside the registry — a
  registered provider always fully describes its own manifest behavior.
  Providers with no provider-specific behavior compose the default
  helpers below.
- `getExtension` is **optional** — it is the entry point to the
  extension mechanism (see below). Providers with no extra capabilities
  omit it.
- `registerCredentialProvider` **throws on a duplicate id**. A duplicate
  is always a bug — two import paths installing the same provider — not
  a configuration choice.
- `getAllCredentialProviders()` (no scope) returns providers in
  registration order.

### Global and per-scope tiers

The registry holds two tiers:

- The **global tier** — providers shared by every scope, registered via
  `registerCredentialProvider`. Duplicate ids throw.
- A **per-scope tier** — providers a single agent group declares for
  itself, keyed by `CredentialScope` and installed via
  `setScopedCredentialProviders`. A provider declared by group A is
  invisible to, and unusable from, group B.

`getCredentialProvider(id, scope)` consults the per-scope tier first
(it shadows the global tier for the same id), then falls back to global.
`getAllCredentialProviders(scope)` returns the global set merged with
the scope's tier, the scope's own view winning on a shared id.
`setScopedCredentialProviders` is idempotent — re-loading a group's
providers replaces its tier rather than throwing; an empty list clears
the tier. `clearScopedCredentialProviders` drops a scope's entire tier
(e.g. on group teardown).

### Default helpers

For providers with no provider-specific manifest behavior:

```ts
export function defaultManifestBuilder(providerId: string): (scope: CredentialScope) => string[];
export function noManifestSideEffect(scope: CredentialScope): void;
```

`defaultManifestBuilder(id)` returns a builder that reads
`{scope}/{id}.json` via the store and emits one JSONL line
(`{"provider":id,"name":entryName}`) per top-level object entry,
skipping the `v` version marker and any non-object entry.

`noManifestSideEffect` is a no-op. Providers without lifecycle side
effects pass it for `onManifestWritten` / `onManifestDeleted`.

### Extension mechanism

A provider's capabilities **beyond** its credential namespace —
driving an agent runtime, OAuth/refresh production, response
classification, per-container state, runtime-CLI updates, and so on —
do not live as fields on `CredentialProvider`. They attach as **typed
extensions**, retrieved through the optional `getExtension` method.
This keeps `CredentialProvider` focused on the manifest pipeline while
letting downstream features layer capabilities onto a provider without
widening the core interface.

```ts
export interface ExtensionType<T> { readonly id: string; }
export function defineExtension<T>(id: string): ExtensionType<T>;

export class ExtensionBag {
  set<T>(type: ExtensionType<T>, value: T): this;
  readonly get: <T>(type: ExtensionType<T>) => T | undefined;
  has(type: ExtensionType<unknown>): boolean;
}
```

The pattern:

```ts
const ext = new ExtensionBag().set(AGENT_RUNTIME, runtime);
const provider: CredentialProvider = {
  id, buildManifest, onManifestWritten, onManifestDeleted,
  getExtension: ext.get,        // bound — pass directly
};
```

`defineExtension<T>(id)` mints a typed key: the phantom `T` ties the key
to its value type so `getExtension(KEY)` infers the right return type.
`ExtensionBag` holds a provider's extensions by key and exposes a bound
`get` suitable as the provider's `getExtension`.

The module defines the well-known extension **keys** as the published
extension points. The value type behind each key is declared here; each
key's *implementation* is supplied by whatever feature consumes it.

| Key | Capability |
|-----|------------|
| `AGENT_RUNTIME` | Drive the per-group agent runtime — container env/mount contributions, required-provider declarations, runtime-config parsing. |
| `CONTAINER_STATE` | One opaque state object per (provider, container), for extensions of the same provider that must observe each other within a container. |
| `CONTAINER_FEEDBACK` | Classify container-agent error events into a `FeedbackAction`. |
| `MITM_FEEDBACK` | Classify upstream responses (e.g. an auth failure vs a rate limit). |
| `PRODUCER` | OAuth flow / device-code / refresh production. |
| `UX` | Custom rendering of credential status. |
| `RUNTIME_UPDATER` | Install/manage the runtime's agent-CLI binary on the host without an image rebuild. |

A provider declares only the extensions it implements; consumers
retrieve a capability with `provider.getExtension?.(KEY)` and treat
`undefined` as "this provider does not have it."

## Per-scope GPG

Thin scope-bound wrappers over `src/modules/crypto/gpg.ts`. They bind a
fixed base directory and accept `CredentialScope` instead of raw strings
so the storage/runtime axis is preserved at the call site. The
encrypted-paste verbs of `/creds` use them: the command resolves the
scope's homedir, ensures a keypair exists, sends the user a public key /
encrypt link, then passes the homedir into the `pastePgp` interaction
helper.

```ts
export function gpgHomeForScope(scope: CredentialScope): string;
export function ensureGpgKey(scope: CredentialScope, maxAgeDays?: number): void;
export function exportPublicKey(scope: CredentialScope): string;
export function exportPublicKeyBinary(scope: CredentialScope): Buffer;
export function buildPgpEncryptUrl(scope: CredentialScope): string;
export function getKeyMeta(scope: CredentialScope): GpgKeyMeta | null;
export function isKeyExpired(scope: CredentialScope): boolean;
export const PGP_ENCRYPT_BASE_URL: string;

export { isGpgAvailable, isPgpMessage, normalizeArmoredBlock } from '../crypto/gpg.js';
export type { GpgKeyMeta } from '../crypto/gpg.js';
```

- The base directory is
  `${XDG_CONFIG_HOME:-~/.config}/nanoclaw/gpg-home/` and is resolved
  lazily on every call, so module import stays side-effect-free and a
  test that overrides `HOME` / `XDG_CONFIG_HOME` at runtime sees the
  override.
- `gpgHomeForScope` is pure path computation. `ensureGpgKey` is the call
  that creates the homedir and generates the keypair, recording its
  creation timestamp + max age so expiry can be checked later.
- `exportPublicKey` / `exportPublicKeyBinary` auto-regenerate the
  keypair if it has passed its configured max age. Decryption is
  unaffected — existing ciphertext stays decryptable.
- `buildPgpEncryptUrl` builds a `PGP_ENCRYPT_BASE_URL?key=…&hash=…` link
  with the scope's binary public key embedded (base64url) and a sha256
  hash for tamper detection, so a user can encrypt a secret locally
  without hand-copying an armored key block.

## Store

Per-(scope, providerId) **plaintext-envelope** JSON file at
`${XDG_CONFIG_HOME:-~/.config}/nanoclaw/credentials/{scope}/{providerId}.json`.

```ts
export const ENTRY_VERSION_KEY: 'v';
export function credentialsDir(): string;
export function scopeDir(scope: CredentialScope): string;
export function keysFilePath(scope: CredentialScope, providerId: string): string;

export function readKeysFile(scope: CredentialScope, providerId: string): Record<string, unknown>;
export function writeKeysFile(scope: CredentialScope, providerId: string, entries: Record<string, unknown>): void;
export function updateKeysFile(scope: CredentialScope, providerId: string, mutator: (entries: Record<string, unknown>) => void): void;
export function deleteKeysFile(scope: CredentialScope, providerId: string): void;
export function deleteScope(scope: CredentialScope): void;

export function listEntries(scope: CredentialScope, providerId: string): string[];
export function listProviderIds(scope: CredentialScope): string[];
export function listScopes(): CredentialScope[];
```

The file shape is a `Record<string, unknown>` whose top-level keys are
credential entry names, plus a reserved `v` schema-version marker the
pipeline skips. An entry's shape is consumer-defined.

**Encryption-at-rest is a resolver concern, not a store concern.** The
file envelope is plaintext JSON; secret string fields inside an entry
must already carry their own `enc:aes-256-gcm:…` ciphertext when handed
to the store. The store moves bytes; it does not decide what is secret.
This keeps the manifest pipeline free of decrypt cost (it reads metadata
directly).

- `readKeysFile` returns `{}` when the file does not exist and creates
  no directories. It throws on invalid JSON — a corrupt store or an
  external writer is not safe to paper over.
- `updateKeysFile` is the preferred mutation path: an atomic
  read-modify-write that strips the `v` marker, runs the mutator,
  restores the marker, and writes back with the fd held open across
  read and write so two concurrent writers in the same Node process
  cannot lose each other's edits. On success it fires
  `onKeysFileWritten` and `invalidateScope`.
- `writeKeysFile` replaces the entire file's contents (computed from
  outside — fixtures, regeneration). It creates the scope directory
  recursively, writes atomically (temp + rename, mode `0600`), stamps
  the `v` marker, then fires `onKeysFileWritten` and `invalidateScope`.
- `deleteKeysFile` removes one keys file (no-op on ENOENT) and fires
  `onKeysFileDeleted(scope, providerId)` + `invalidateScope`. The hook
  fires even when the file was already absent, so a stale manifest left
  by an aborted earlier delete still gets cleaned up.
- `deleteScope` removes the entire scope directory in one recursive
  `rmSync`, then fires `onKeysFileDeleted(scope)` (whole-scope) and
  `invalidateScope` exactly once.
- `listEntries` skips the `v` marker; `listProviderIds` returns the
  `*.json` basenames under a scope; `listScopes` returns the
  subdirectories under `credentialsDir()`. Each returns `[]` for an
  absent directory.

## Resolver

A per-agent-group cached resolver is the boundary between
encrypted-at-rest and plaintext-in-use.

```ts
export interface CredentialResolver {
  resolve(scope: CredentialScope, providerId: string, credentialId: string): Credential | null;
  store(scope: CredentialScope, providerId: string, credentialId: string, credential: Credential): void;
  delete(scope: CredentialScope, providerId?: string): void;
  unloadCache(scope?: CredentialScope, providerId?: string): void;
  dispose(): void;
}

export function getOrCreateResolverForAgentGroup(ownFolder: string): CredentialResolver;
export function disposeResolverForAgentGroup(ownFolder: string): void;
export function getResolverForAgentGroup(ownFolder: string): CredentialResolver | null;
```

- One resolver per agent group, not per session. Concurrent sessions of
  the same agent group share one cache.
- `resolve()` first runs an access check (`grants.canAccess(ownFolder,
  scope)`); a scope the resolver may not read returns `null`. On a cache
  miss it reads the keys file, caches the encrypted entry, then returns
  a **decrypted** `Credential` on the stack. The plaintext lives only as
  long as the caller keeps the reference.
- `store()` throws unless `scope` is the resolver's own folder —
  borrowing is read-only. It encrypts the secret fields, merges the
  entry through the store's atomic `updateKeysFile` (sibling entries
  preserved), and re-populates its own cache.
- Eviction is driven by the scope-invalidator registry: every store
  write and every grant mutation fires `invalidateScope(scope)`, which
  each live resolver subscribes to and uses to drop the matching scope
  from its cache. Borrowing from an inactive grantor still works because
  the on-disk store is always readable.
- `dispose()` releases the scope-invalidator subscription and clears the
  cache; a disposed resolver may not be reused.
  `disposeResolverForAgentGroup` is called from session teardown when
  the last session for an agent group closes.

The resolver depends on `src/modules/crypto` for AES encryption. The
AES key file at `${XDG_CONFIG_HOME:-~/.config}/nanoclaw/encryption-key`
(mode `0600`) is created lazily on the first encrypt/decrypt and reuses
any encryption singleton already initialized elsewhere.

## Grants

Filesystem-only grant/borrow state — no DB tables.

```ts
export function listGrantees(grantorFolder: string): string[];
export function isGrantee(grantorFolder: string, granteeFolder: string): boolean;
export function addGrantee(grantorFolder: string, granteeFolder: string): void;
export function removeGrantee(grantorFolder: string, granteeFolder: string): void;

export function getBorrowSource(granteeFolder: string): string | null;
export function setBorrowSource(granteeFolder: string, grantorFolder: string): void;
export function clearBorrowSource(granteeFolder: string): void;

export function grantedDir(granteeFolder: string, grantorFolder: string): string;
export function canAccess(borrowerFolder: string, grantorFolder: string): boolean;
```

Storage shape:

- `groups/{grantor}/credentials/grantees.json` — a JSON object
  (`{ grantees: string[] }`) listing grantee folder strings, deduped +
  sorted on write. The grantee list mutates through one atomic
  read-modify-write entry point, so concurrent edits in one Node process
  cannot race.
- `groups/{grantee}/credentials/borrowed` — a relative symlink →
  `granted/{grantorFolder}`. The symlink **is** the borrow-source
  record; there is no parallel state file. `getBorrowSource` reads the
  link and parses the prefix, returning `null` for an absent link, a
  non-symlink path, or a target that doesn't match the expected shape.
- `groups/{grantee}/credentials/granted/{grantor}/` — pre-created by
  `setBorrowSource` so the symlink never dangles, even before any
  manifest is distributed.

Every folder string is validated through `assertValidGroupFolder`
before any path is composed.

`canAccess(borrower, grantor)` is the single **bilateral** grant check
shared by the resolver and every credential-using feature. It returns
true iff the borrower is the grantor (own scope), **or** the borrower
has set the grantor as its borrow source **and** the grantor lists the
borrower in its grantee set. A unilateral claim on either side flips the
answer to false.

## Manifest pipeline

Every credential scope advertises what it offers via JSONL manifest
files — one per `providerId` — at
`credentials/{scope}/manifests/{providerId}.jsonl`. The pipeline then
copies each manifest (fire-and-forget) into every grantee's
`groups/{grantee}/credentials/granted/{grantor}/{providerId}.jsonl`, so
grantees see what a grantor offers without ever holding the underlying
credentials.

```ts
export function onKeysFileWritten(scope: CredentialScope, providerId: string): void;
export function onKeysFileDeleted(scope: CredentialScope, providerId?: string): void;
export function distributeAllManifests(grantorFolder: string, granteeFolder: string): void;
export function revokeGranteeManifests(grantorFolder: string, granteeFolder: string): void;
export function regenerateAllManifests(): void;
```

- `onKeysFileWritten` calls `provider.buildManifest(scope)`, writes the
  resulting JSONL to the manifest path, fires `provider.onManifestWritten`,
  then fans out a fire-and-forget copy to every grantee. The store calls
  this automatically, so consumers writing through the store never
  invoke it themselves; direct invocation is for unusual paths such as
  manifest regeneration after a config change.
- A `buildManifest` returning `[]` still writes an empty manifest file,
  so readers can distinguish "advertised but empty" from "never
  advertised."
- `onKeysFileDeleted(scope, providerId)` removes that one manifest +
  grantee copies and fires `onManifestDeleted`. Without a `providerId`
  it removes the entire `manifests/` directory and each grantee's
  `granted/{grantor}/` dir in a single pass.
- `distributeAllManifests` copies every existing manifest from a grantor
  to a freshly-added grantee (used by `/creds share`).
  `revokeGranteeManifests` removes a grantee's per-grantor distribution
  dir (used by `/creds revoke`); it deliberately does **not** clear the
  grantee's `borrowed` symlink — that is `/creds revoke`'s policy, not
  the manifest helper's.
- A missing provider for a stored `providerId` is logged at warn and
  skipped — it never throws into the caller. A `buildManifest` that
  throws is also caught: no manifest is written and the lifecycle hook
  does not fire.
- The first entry into the pipeline (`onKeysFileWritten`,
  `onKeysFileDeleted`, or `regenerateAllManifests`) trips a once-flag
  that sweeps every existing keys file and rewrites its manifest. This
  keeps host wiring side-effect-free while still picking up stored
  provider-shape changes the first time anything touches the pipeline.
  `regenerateAllManifests` skips providerIds with no registered provider
  rather than wiping their manifests, so a temporarily-unloaded feature
  does not lose its advertised entries.

## Scope invalidator

```ts
export type ScopeInvalidator = (scope: CredentialScope) => void;
export function registerScopeInvalidator(cb: ScopeInvalidator): () => void;
export function invalidateScope(scope: CredentialScope): void;
```

Consumers register a callback that drops their per-scope cached state.
`invalidateScope(scope)` runs every registered callback; a callback that
throws is caught and logged at warn so one misbehaving consumer cannot
block the rest. `registerScopeInvalidator` returns an unsubscribe
function.

Invalidation is keyed by **`CredentialScope`** (the on-disk storage
location), not `GroupScope`: a write to scope A must invalidate every
cached entry under A regardless of which group cached it. Three things
fire it:

1. The grant-mutating `/creds` verbs (`borrow`, `revoke`,
   `stop-borrowing`).
2. The store's `writeKeysFile` / `updateKeysFile` / `deleteKeysFile` /
   `deleteScope`, so no reader serves a stale cached entry after another
   writer updates the same on-disk file.
3. Any further credential-using feature that changes effective access.

The resolver registers a callback that evicts the scope from its
in-memory cache.

## `/creds` host command

Registered at module load with `scope: 'agent'` and
`access: 'group-admin'` — grant/borrow moves real credentials between
groups, so the command requires admin privilege over the target agent
group (gate-enforced). It appears in `/help` as soon as the module is
imported.

```
/creds                         sharing status (borrow source + grantee list)
/creds share <target>          grant target read access to this group
/creds borrow <source>         borrow credentials from source
/creds revoke <target>         revoke target's grant
/creds stop-borrowing          stop borrowing
/creds set-key <provider> [id] [expiry=<ts>]   store one key via GPG-encrypted paste
/creds import [provider]       bulk import [provider:]KEY=value lines (GPG-encrypted paste)
/creds delete <provider>       delete a provider's stored credentials
/creds list                    list providers with stored credentials
/creds status                  credential + sharing summary
/creds gpg                     print this group's GPG public key + encrypt link
```

The handler resolves the current agent group via `ctx.agentGroupId` and
finds peers via `getAgentGroupByFolder`. Behavior:

- **Sharing.** `share` adds the target to the grantee list and
  distributes existing manifests; the target must then `borrow`.
  `borrow` sets the `borrowed` symlink and invalidates the scope; if the
  source has not yet `share`d, it succeeds but replies *pending*. A
  `borrow` against a different source while one is already active is
  rejected with "Run `/creds stop-borrowing` first." `revoke` removes
  the grantee + its distributed manifests, and clears the target's
  `borrowed` link if it still points at this folder. Self-share and
  self-borrow are rejected.
- **Credential setting.** `set-key` and `import` collect secrets through
  a GPG-encrypted paste (`pastePgp`) so cleartext never enters chat:
  they ensure the scope's GPG key, send an encrypt link, then store the
  decrypted result through the resolver (which encrypts at rest).
  `import` consults the registered import planner (see below) for
  binding-aware resolution of un-prefixed `ALL_CAPS` env-var names,
  falling back to literal storage when no planner is registered.
- **Inspection.** `delete` drops a provider's stored credentials via the
  resolver; `list` and `status` report stored providers and the sharing
  state. `gpg` prints the group's armored public key plus the encrypt
  link, which the operator needs before `set-key` / `import`.

### Import planner seam

```ts
export interface ImportToken { prefix: string | null; key: string; value: string; }
export interface ImportStore { providerId: string; credentialId: string; value: string; }
export interface ImportPlan {
  stores: ImportStore[];
  envVarsByProvider: Record<string, string[]>;
  unknownProviders: string[];
  warnings: string[];
}
export type ImportPlanner = (tokens: ImportToken[], defaultProviderId: string | null, scope?: CredentialScope) => ImportPlan;

export function registerImportPlanner(fn: ImportPlanner): void;
export function planCredentialImport(tokens: ImportToken[], defaultProviderId: string | null, scope?: CredentialScope): ImportPlan | null;
```

`/creds import` resolves pasted `[provider:]KEY=value` lines to concrete
`(providerId, credentialId, value)` store targets. Reverse-mapping an
un-prefixed env-var name to its provider — and any binding-aware
credentialPath resolution — is knowledge that lives with the
credential-using features, not this module. So the seam lets a feature
register a planner at boot, and the import command consults it. With no
planner registered, the command falls back to literal storage
(`credentialId = key`, prefix- or default-provider attribution only).

## Storage layout

```
${XDG_CONFIG_HOME:-~/.config}/nanoclaw/
  credentials/
    {credentialScope}/{providerId}.json            — plaintext-envelope keys file
    {credentialScope}/manifests/{providerId}.jsonl — scope manifests
  encryption-key                                    — AES key, mode 0600 (lazy)
  gpg-home/{credentialScope}/.gnupg/                — per-scope GPG homedirs

groups/{grantor}/credentials/grantees.json                     — grantee list
groups/{grantee}/credentials/granted/{grantor}/…               — distributed manifest copies
groups/{grantee}/credentials/borrowed -> granted/{grantor}/    — relative symlink
```

Credentials live deliberately outside `data/`. `data/` is the
install-relative root next to mountable state (session DBs, agent-group
workspaces); keeping credentials under XDG config means no mount rule,
accidental or otherwise, can expose them.

## Behavior guarantees

- Loading the module performs **no filesystem I/O**. The first writes
  happen when a real code path mutates credential state.
- `CredentialScope` and `GroupScope` are not interchangeable. Assigning
  one to the other is a compile error; "simplifying" to a single
  `string` breaks the build.
- `/creds` is registered at module load and appears in `/help`
  immediately.
- AES encryption initializes lazily on the first resolver
  encrypt/decrypt, creating the encryption key file if absent and
  reusing any existing encryption singleton.

## Failure modes

| Situation | Signal |
|-----------|--------|
| `registerCredentialProvider` with a duplicate id | Throws `Credential provider '<id>' already registered`. |
| `readKeysFile` on a malformed / undecryptable blob | Throws — corrupt store or wrong key, not safe to paper over. |
| `writeKeysFile` to a path with no parent dir | Creates `credentials/{scope}/` recursively and writes atomically (temp + rename, mode `0600`). |
| `onKeysFileWritten` with no provider registered | Logs at warn and skips; no manifest is written. The keys-file write is not undone. |
| `provider.buildManifest` throws | Logged at warn; no manifest is written; the lifecycle hook does not fire. |
| `resolver.store` with a scope other than own | Throws — borrowing is read-only. |
| Scope-invalidator callback throws | Logged at warn; remaining invalidators still run. |
| `/creds <unknown>` | Replies the usage string. |
| `/creds share <self>` / `borrow <self>` | Rejected ("Cannot share/borrow with yourself"). |
| `/creds borrow` while another borrow is active | Replies "Already borrowing from *X*. Run `/creds stop-borrowing` first." |

## Extension points

- `CredentialProvider` is focused on the manifest pipeline. New methods
  land on it only if they belong to that pipeline; every other
  capability attaches via `getExtension` and a `defineExtension` key.
- The well-known extension keys (`AGENT_RUNTIME`, `CONTAINER_STATE`,
  `CONTAINER_FEEDBACK`, `MITM_FEEDBACK`, `PRODUCER`, `UX`,
  `RUNTIME_UPDATER`) are published extension points; their value types
  are declared here and their implementations supplied by the features
  that consume them.
- `registerImportPlanner` lets a feature supply binding-aware import
  resolution to `/creds import`.

## Dependencies

- `command-gate` for host-command registration.
- `src/modules/crypto` for the AES (resolver) and GPG (per-scope
  keyring) primitives.
- `src/modules/interactions` for the `pastePgp` encrypted-paste helper
  used by `/creds set-key` / `import`.
- `src/group-folder` for `assertValidGroupFolder` /
  `resolveGroupFolderPath`.

## Related

- [crypto.md](crypto.md) — the AES + GPG primitives the resolver and
  per-scope keyring compose against.
- [interactions-helpers.md](interactions-helpers.md) — the paste
  interaction helpers.
- [host-commands.md](host-commands.md) — the host-command registration
  surface `/creds` plugs into.
