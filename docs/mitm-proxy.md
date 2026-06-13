# MITM credential proxy

## Summary

A host-side MITM proxy that gives containers substitute tokens in place
of real credentials. Containers receive format-preserving fakes via
`HTTP_PROXY` + a `/credentials/<id>/substitute` endpoint; outbound
TLS to providers whose host rules are registered is intercepted on the
proxy's bridge IP, the substitute is swapped for the real token, and
the upstream response is forwarded back. The real tokens live in the
credentials module and are read through a per-group resolver that
enforces grant/borrow access checks; the proxy never holds plaintext
across requests. The OAuth state machine, browser-open relay, and
provider-specific intercept handlers are out of scope of this module
— they ship in a separate OAuth submodule that plugs in through
`SubstitutingProvider` declarations and `initOAuthModule`.

The proxy is always-on transparent: explicit `HTTP_PROXY`/`HTTPS_PROXY`
and iptables-DNAT'd `:443` both reach it, multiplexed by first byte.

## Capabilities

- Consumers can generate a format-preserving substitute token for any
  real credential, with prefix/suffix/delimiter positions preserved and
  the middle randomized — containers see the fake, never the real value.
- A running container can request a substitute at runtime via
  `GET /credentials/<providerId>/substitute?path=<credentialPath>[&envVar=<NAME>]`
  on the proxy's bridge address; the proxy identifies the caller by IP
  and resolves the group scope automatically.
- Providers whose `SubstitutesSpec.hostRules()` declare intercept rules
  get bearer-swap (and other bespoke) handling on outbound HTTPS — the
  proxy MITMs the TLS connection, swaps the substitute in request
  headers for the real token, and forwards.
- The host's MITM CA cert is installed into the container's system CA
  store (Debian-style `update-ca-certificates`) so `curl` / `git` /
  `apt` / `wget` and any libssl-based binary trusts forged certs; Node
  apps also pick it up via `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.
  The CA is also installed into the container's Chromium and Firefox NSS
  trust stores.
- The substitute endpoint rejects `?envVar=NAME` overrides that would
  shadow a host-injected variable; the reserved set is contributed by
  every module that calls `reserveEnvName(name, owner)`.
- Tests can bind the proxy to an ephemeral port (`port: 0`) and read
  the assigned port back via `getBoundPort()`.

## Public contract

### `CredentialProxy`

```ts
class CredentialProxy {
  constructor();

  // Lifecycle
  start(opts?: CredentialProxyOptions): Promise<Server>;
  getBoundPort(): number;

  // Host-rule index (built from the credentials registry)
  indexProvider(p: SubstitutingProvider): void;
  rebuildIndex(): void;

  // Observability and test seams
  setTapFilter(filter: ProxyTapFilter | null): void;
  parseTapExclude(raw: string | undefined): { excluded: Set<string>; unknown: string[] };

  // IP → scope (fallback to container-bootstrap.lookupContainerIP)
  registerContainerIP(ip: string, scope: GroupScope): void;
  unregisterContainerIP(ip: string): void;
  resolveScope(sourceIP: string): GroupScope | null;
}

interface CredentialProxyOptions {
  /** TCP port. `0` (default) lets the OS assign an ephemeral port. */
  port?: number;
  /** Bind address. Default `127.0.0.1`. */
  host?: string;
  /** Directory for the MITM CA cert/key files. */
  caDir?: string;
}
```

`start()` runs an initial `rebuildIndex()` automatically — providers
that registered with `registerCredentialProvider` before `start()`
land in the index. Providers added later go in through
`indexProvider(p)`.

### Provider entity

A `SubstitutingProvider` is a `CredentialProvider` (the credentials
module's manifest-pipeline provider) with one extra slot:

```ts
interface SubstitutingProvider extends CredentialProvider {
  substitutes: SubstitutesSpec;
}

interface SubstitutesSpec {
  /** Build a substitute for a real value at this path. Null if not substitutable. */
  generateSubstitute(realValue: string, credentialPath: string): string | null;
  /** Enumerate env-var names this provider produces for one path. */
  envNamesFor(credentialPath: string): readonly string[];
  /** Materialize the value for one envName from substitute + credential. */
  envValueFor(envName: string, substitute: string, credential: Credential): string | null;
  /** All host rules in one call — single source for the proxy's anchor index. */
  hostRules(): readonly HostRule[];
}

function isSubstitutingProvider(p: CredentialProvider): p is SubstitutingProvider;
```

The contract is behavioral, not declarative. A provider that wants the
canonical implementation composes `defaultSubstitutes(...)`; a
provider that needs custom logic (e.g. a sliced binding with a
provider-specific separator) writes its own object.

### `defaultSubstitutes(input)`

```ts
interface DefaultSubstitutesInput {
  substituteConfig?: SubstituteConfig;     // default DEFAULT_SUBSTITUTE_CONFIG
  envBindings?: EnvVarBinding[];
  credentialFormat?: Record<string, CredentialFormatSpec>;
  hostRules?: HostRule[];
}
function defaultSubstitutes(input: DefaultSubstitutesInput): SubstitutesSpec;
```

A factory that returns a `SubstitutesSpec` closing over the
declarative bag. Use this in provider declarations unless you need
behavioral overrides.

### `HostRule`

```ts
interface HostRule {
  hostPattern: RegExp;
  pathPattern: RegExp;
  handler: HostHandler;
  /** Explicit anchor when hostPattern is templated. */
  anchor?: string;
}
```

For fixed-host patterns the anchor is derived from the regex source
(strip `^` / `$`, unescape `\.`); for templated patterns (e.g.
`(?<tenant>[^.]+)\.auth0\.com`) the caller passes `anchor: 'auth0.com'`.
Patterns whose derived anchor isn't domain-shaped throw at index time.

### Token substitute engine

```ts
type ResolverFactory = (groupScope: GroupScope) => EngineCredentialResolver;

function initTokenEngine(factory: ResolverFactory): TokenSubstituteEngine;
function getTokenEngine(): TokenSubstituteEngine;

interface EngineCredentialResolver {
  resolve(scope: CredentialScope, providerId: string, credentialId: string): Credential | null;
}
```

The factory is called per request with the calling group's scope. The
credentials module's per-group resolvers (returned from
`getOrCreateResolverForAgentGroup`) enforce their own access checks
against the grant store — the engine inherits that gating for free.

### Env-var name validation

```ts
function validateEnvVarFormat(name: string): string | null;  // null = valid
function isReservedEnvName(name: string): boolean;            // delegates to container-bootstrap
```

The substitute endpoint runs both checks on `?envVar=NAME`. Format
errors and reserved-name violations both return 400.

### Tap observability

```ts
function setProxyResponseHook(hook: ProxyResponseHook): void;
function setUpstreamAgent(agent: import('https').Agent): void;  // test seam
function createTapFilterFromEnv(proxy: CredentialProxy): ProxyTapFilter | null;
```

### `initOAuthModule(opts)`

Initializes the OAuth submodule at `src/modules/mitm-proxy/oauth/`.
Called by the host after `proxy.start()` resolves. Not loaded for any
side effect — substitution-only deployments never call this. Its full
contract is documented in the per-group OAuth providers spec and the
OAuth submodule itself.

## Behavior guarantees

- The engine multiplexes through the injected `ResolverFactory` on
  every read. No process-wide reader exists; the credentials module
  remains the sole owner of decrypt + access-check.
- The reserved-env set is a single source of truth in
  `container-bootstrap` (`reserveEnvName`, `isEnvNameReserved`).
  Every module that injects `-e` flags registers its names at module
  load. The substitute endpoint queries that set directly.
- `start()` runs `rebuildIndex()` before listening, so providers
  registered at host boot are routable from the first connection.
- `indexProvider(p)` throws on duplicate provider id and on
  un-indexable host patterns — failures surface at registration, not
  per request.
- Anchor derivation is centralized: a regex whose source doesn't
  reduce to a domain-suffix shape is rejected unless an explicit
  `anchor:` is supplied on the `HostRule`.
- The MITM CA is installed inside the container iff `MITM_CA_PATH` is
  set in the env (the observer's gate). When the observer contributes
  the cert mount it also requests `needsRootEntrypoint: true` so
  `update-ca-certificates` runs as root, then setpriv drops to
  `HOST_UID:HOST_GID` before bun exec.
- Caller IP → scope falls back to
  `container-bootstrap.lookupContainerIP()` when the proxy's local
  `containerIpToScope` map is empty. The IP allocator is the canonical
  registry.
- Substitute refs persist as V4 JSON under
  `${XDG_CONFIG_HOME}/nanoclaw/credentials/<scope>/<providerId>.refs.json`.
  No legacy-format migration runs; legacy files are logged and skipped.
- The engine never stores or deletes credentials. Both mutations live
  in the credentials module's resolver.

## Consumer usage

### Host boot wiring

```ts
import {
  CredentialProxy,
  setProxyInstance,
  initTokenEngine,
} from './modules/mitm-proxy/index.js';
import {
  getOrCreateResolverForAgentGroup,
} from './modules/credentials/index.js';
import { CREDENTIAL_PROXY_PORT } from './config.js';

const proxy = new CredentialProxy();
initTokenEngine((scope) => getOrCreateResolverForAgentGroup(scope));
setProxyInstance(proxy);
await proxy.start({ port: CREDENTIAL_PROXY_PORT });
```

### Declaring a substituting provider

```ts
import {
  registerCredentialProvider,
} from './modules/credentials/providers/registry.js';
import {
  defaultSubstitutes,
  getProxy,
} from './modules/mitm-proxy/index.js';

const githubProvider = {
  id: 'github',
  buildManifest: (scope) => [/* credentials-module manifest lines */],
  onManifestWritten: () => {},
  onManifestDeleted: () => {},
  substitutes: defaultSubstitutes({
    envBindings: [
      { envName: 'GH_TOKEN',     credentialPath: 'oauth' },
      { envName: 'GITHUB_TOKEN', credentialPath: 'oauth' },
    ],
    hostRules: [
      {
        hostPattern: /^api\.github\.com$/,
        pathPattern: /^\//,
        handler: bearerSwapHandler('github'),
      },
    ],
  }),
};

registerCredentialProvider(githubProvider);
getProxy().indexProvider(githubProvider);  // before start() lands in the initial rebuild
```

### Custom `SubstitutesSpec` (override one method)

```ts
const sliced: SubstitutesSpec = {
  ...defaultSubstitutes(input),
  envValueFor(envName, substitute, credential) {
    // Provider-specific slicing not covered by the default binding form.
    if (envName === 'GCP_PROJECT') return substitute.split(':', 2)[0] ?? null;
    return defaultSubstitutes(input).envValueFor(envName, substitute, credential);
  },
};
```

## Boundaries

**Not in scope:**

- OAuth state machine (authorize / token-exchange / refresh / device-
  code). The OAuth submodule under `src/modules/mitm-proxy/oauth/`
  ships those flows and is initialized separately via
  `initOAuthModule(opts)` — not via the module's barrel side effect.
- Container env / mount injection at the agent-group level — that is the
  agent-group contribution registry's responsibility
  (`registerAgentGroupContribution`). The mitm-proxy observer
  contributes via container-bootstrap's `onSpawnPre` instead.
- The reserved-env registry itself (lives in `container-bootstrap`).

**Dependencies / required peers:**

- `src/modules/credentials/` — `CredentialProvider` registry,
  per-group resolver, `Credential` shape, `CredentialScope` /
  `GroupScope` brands.
- `src/modules/container-bootstrap/` — lifecycle observer registry,
  IP allocator (`lookupContainerIP`), reserved-env registry
  (`reserveEnvName` / `isEnvNameReserved`), launch-mode resolver for
  `needsRootEntrypoint`.
- `container/entrypoint.sh` — env-gated `MITM_CA_PATH` block that runs
  `update-ca-certificates`.

## Failure modes

| Situation                                              | Signal                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Request from an IP not registered in container-bootstrap | HTTP 403 ("Forbidden: unknown container") on the proxy port.           |
| Substitute requested for an unknown provider id        | HTTP 404 with `{ "error": "Unknown provider: …" }`.                     |
| Substitute requested for a (scope, provider, path) with no stored credential | HTTP 404 with `{ "error": "No credentials found …" }`. |
| `?envVar=…` with malformed name                        | HTTP 400; `validateEnvVarFormat` returns the message.                  |
| `?envVar=…` naming a reserved variable                 | HTTP 400 ("Reserved env var name: …").                                 |
| `indexProvider(p)` with duplicate id                   | Throws at registration. Caller bug.                                    |
| Host pattern whose derived anchor isn't domain-shaped, no explicit `anchor:` | Throws at index time with a fix-it message. |
| Engine read miss (no credential)                       | `null` return; no exception; substitute endpoint surfaces 404.         |
| Per-entry borrow source revoked between resolves       | Engine drops the substitute and returns `null` on subsequent reads.    |
| `update-ca-certificates` not available in the image    | Falls back to appending the cert to `/etc/ssl/certs/ca-certificates.crt`; any failure is swallowed (best-effort). |

## Extension points

- **Provider entity.** A new credentialed service ships as a
  `SubstitutingProvider` (compose `defaultSubstitutes(...)`,
  `registerCredentialProvider`, `proxy.indexProvider(p)`). No mitm-
  proxy-side change needed.
- **OAuth.** Providers that need authorize / refresh / token-exchange
  also implement the OAuth submodule's `OAuthProvider` contract. The
  host calls `initOAuthModule(opts)` once after `proxy.start()`. The
  OAuth submodule registers its own intercept handlers with the same
  proxy through the `SubstitutesSpec.hostRules()` path.
- **Borrow source.** The engine accepts a `BorrowSourceResolver` via
  `setBorrowSourceResolver(fn)` so grant-aware modules can wire
  per-group "borrow from group X" indirection without the engine
  knowing about grants directly. Substitution-only deployments leave
  this unset; reads fall through to own-scope.
- **Custom substitute shape.** Providers override
  `generateSubstitute` (and/or `envValueFor`) on `SubstitutesSpec`
  for non-format-preserving fakes or non-default slicing.

## Test coverage

- Substitute engine: generate (format preservation, alnum-only
  heuristic, too-short, collision retry, randomizable-char floor),
  lookup (own scope, borrow + access-check, nested paths, scope
  isolation, attribute restriction), env-name merge, drop/prune
  lifecycle, V4 refs persistence round-trip.
- Proxy class: anchor index incremental and full-rebuild paths, anchor
  derivation + shape validation, IP → scope fallback to
  container-bootstrap, request/CONNECT dispatch including non-MITM
  tunnels, response hook + tap propagation.
- Substitute endpoint: provider lookup against the credentials
  registry, env-name format and reserved-name enforcement, custom
  `?envVar=` merging, URL-encoded provider ids.
- Observer: env contribution shape, mount shape, `MITM_CA_PATH` /
  `needsRootEntrypoint` only when the CA mount lands.
- Container entrypoint MITM block: covered by the container-bootstrap
  e2e harness alongside the privilege-drop case.
- Live-container e2e: bearer-swap and token-exchange over the wire,
  NSS cert trust probe, transparent DNAT path.

## Related

- [Credentials module](credentials.md)
- [Container lifecycle peer](container-bootstrap.md)
- [Per-group OAuth providers](per-group-oauth-providers.md)
- [Sync actions](sync-actions.md)
