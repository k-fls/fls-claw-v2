# NanoClaw v2 — genuine bugs / v1→v2 incompatibilities

Facts only. Code paths in `/tmp/flsclaw-inspect` (= `/home/nanoclaw/nanoclaw-v2`).
Genuine v2 bugs/incompatibilities (worked around or open): **#3, #4, #5, #6, #9, #10, #11, #12**.
(Registry #1 upgrade-tripwire and #2 telegram-not-bundled are by-design, not bugs.)
#9 blocks #8 (geosafe needs a fresh Claude login; the login flow is #9).

**#12 — Telegram typing indicator doesn't work (OPEN, not investigated).** Observed: no "typing…"
shown in Telegram while the agent works. Plumbing exists and is not obviously absent:
`chat-sdk-bridge.ts:545` implements `setTyping`; the `@chat-adapter/telegram` adapter supports it
(`sendChatAction action:"typing"`); `delivery.ts` wires a typing module (`setTypingAdapter`,
`pauseTypingRefreshAfterDelivery`) that fires on an interval. Root cause not determined; no fix
applied (per request).

**#11 — Telegram outbound (FIXED).** Two bugs: (a) `sanitizeTelegramLegacyMarkdown` emitted invalid
entities for a code span nested in `*bold*` (Telegram 400 "can't find end of the entity"); (b) the
bridge had no fallback — a generated reply was dropped after 3 retries. Fixed: sanitizer breaks the
nesting; bridge degrades to plain text then a stub so a reply is never silently lost. See
`nanoclaw-v2-code-changes.md` #9/#10.

## #3 — v1 credential filenames unreadable by v2 (`<prov>.keys.json` vs `<prov>.json`)
- v2 store path: `keysFilePath(scope,prov)` = `${scopeDir}/${prov}.json` (`src/modules/credentials/store.ts:58-59`; doc comment line 5).
- v1 on disk: `claude.keys.json`, `github.refs.json`, etc.
- `listProviderIds(scope)` (`store.ts:191-205`): regex `/^(.+)\.json$/` is greedy → `claude.keys.json` ⇒ provider id `claude.keys` (not `claude`); `claude.refs.json` ⇒ `claude.refs`.
- Gate (`src/credential-acquisition.ts:86-90`): `have = new Set(listProviderIds(scope))`; `missing = required.filter(r => r.required && !have.has(r.id))`. `have` contains `claude.keys`/`claude.refs`, not `claude` ⇒ `missing=['claude']` ⇒ acquisition gate fires.
- Side effect: manifest pipeline logs `regenerate skipping unregistered provider providerId="claude.keys"` for every `*.keys.json`/`*.refs.json`.
- Worked around: additive copy `*.keys.json`→`*.json` in scopes main+geosafe (v1 `.keys.json` left intact). v1 `.refs.json` not copied (v2 re-mints substitutes).

## #4 — `groups create` leaves the group unspawnable (no container_configs row)
- `ncl groups create` writes only `agent_groups` (CRUD, `src/cli/resources/...`); does NOT call `ensureContainerConfig`.
- `ensureContainerConfig(id)` callers: `src/group-init.ts:70`, `src/commands/agent-runtime.ts:158`, and boot-only `backfillContainerConfigs()` (`src/index.ts:109`).
- Spawn path: `materializeContainerJson(id)` throws `Container config not found for agent group: <id>` (`src/container-config.ts:150-155`) → `wakeContainer: spawn failed`.
- Repro: create a group via `ncl` while the daemon is running, send it a message → spawn fails.
- Worked around: daemon restart → `backfillContainerConfigs()` seeds rows (`Backfilled container_configs from disk count=2`).

## #5 — `wirings create` does not create the agent_destinations row
- After `ncl wirings create` (cli→agent), `ncl destinations list` → `(no rows)`.
- Agent emits `<message to="cli">…</message>`; container log: `Unknown destination in <message to="cli">, dropping block` → `agent output had no <message to=...> blocks — nothing was sent` (agent loops, re-querying).
- Worked around: `ncl destinations add --agent-group-id <id> --local-name cli --target-type channel --target-id <cli-mg-id>`.

## #6 — `wirings update --agent-group-id` is a silent no-op
- `ncl wirings update --id <wiring> --agent-group-id <other>` returns a success object, but `wirings list` shows the original `agent_group_id` unchanged.
- `--agent-group-id` is listed as `(required)` not `(updatable)` in `ncl wirings help`; engage_* fields are updatable.
- No error emitted. Worked around: `wirings delete --id <wiring>` + `wirings create` with the new agent.

---

# Open bugs (not yet worked around)

Blocks #8 (geosafe needs a fresh Claude login; the login flow is #9).

## #9 — auth-container → host-rpc `/auth/url` rejected

### Observed (run.log)
```
Spawning auth container  containerName=nanoclaw-auth-geosafe-<ts>  folder=geosafe  mode=setup_token  proxy=true
host-rpc: unknown caller IP, rejecting  callerIP=172.29.0.4  url=/auth/url
Auth container exited  containerName=nanoclaw-auth-geosafe-<ts>
```
- Auth container lifetime ≈ 18 s (spawn → reject → exit). URL never delivered. Triggered via `/auth` → menu option 2 (`setup_token`); same path for option 3 and for Telegram-origin `/auth`.

### Network state (box)
- docker network `nanoclaw`: subnet `172.29.0.0/16`, gateway `172.29.0.1`.
- host-rpc bind: `172.17.0.1:17381` (log: `host-rpc server listening bind=172.17.0.1 port=17381`; env `NANOCLAW_HOST_RPC_PORT`, default 17381 — `src/modules/host-rpc/port.ts`).
- Running agent containers at reject time: `nanoclaw-v2-main-… = 172.29.0.2`, `nanoclaw-v2-geosafe-… = 172.29.0.3`. Auth-container source IP (per reject): `172.29.0.4`.

### Code paths
- Caller check — `src/modules/host-rpc/server.ts:123-131`: `callerIP = clientIP(req)`; `clientIP` (server.ts:89) = `req.socket.remoteAddress`, strips `::ffff:`. `const scope = lookupContainerIP(callerIP)` (line 128); `if (!scope) { log.warn('host-rpc: unknown caller IP, rejecting', {callerIP,url}); ... }` (line 131).
- Registry — `src/modules/container-bootstrap/ip-registry.ts`: module-level `const byIp = new Map<string, AllocationRecord>()`. `allocateContainerIP(scope, sessionId?)` (line 36) does `byIp.set(ip, {scope, sessionId})`. `lookupContainerIP(ip)` (line 70) = `byIp.get(ip)?.scope ?? null`.
- host-rpc imports `lookupContainerIP, lookupContainerSession` from `../container-bootstrap/index.js` (server.ts:33) → same module instance as the allocator.
- Auth spawn — `src/auth-container.ts:156`: `const allocated = allocateContainerIP(opts.scope)` (no `sessionId` arg). Run args include `networkArgs(input.ip)` (auth-container.ts:79). `networkArgs(ip)` (`src/modules/container-bootstrap/network.ts:128`) = `['--network', 'nanoclaw', '--ip', ip]`.
- Endpoint: POST `/auth/url`.

### Not determined
- Why `byIp` has no entry for `172.29.0.4` at the time host-rpc looks it up (allocator pins `--ip` and registers; same code serves working agent containers).
- Whether agent containers ever call host-rpc successfully (their credential traffic goes through the proxy on `:45393`, not host-rpc).

## #10 — geosafe GitHub API call returns 401

### Observed
- `cmp -s main/github.json geosafe/github.json` → IDENTICAL (byte-for-byte copy).
- geosafe agent: `curl -s https://api.github.com/user` → `401 "Requires authentication"`.
- main agent (earlier, session had routed to `main`; not re-verified clean): reported login `cyrax-gs`.

### Credential file (`credentials/<scope>/github.json`)
```
{ "oauth": {
    "value": "enc:aes-256-gcm:… (131 chars)",
    "updated_ts": <int>, "expires_ts": <int>,
    "authFields": { "client_id": "178c6fc7… (20c)", "device_code": "…(40c)", "scope": "gist,rea…(18c)" }
}, "v": <int> }
```
- Entry key is `oauth` (device-flow); no `api_key` entry.

### Provider — `src/providers/github-credential.ts`
- `GITHUB_OAUTH_PROVIDER`: `id = github`; `rules = [ {anchor:'api.github.com', path:/^\//, mode:'bearer-swap'}, {anchor:'github.com', path:/^\//, mode:'bearer-swap'} ]`; `refreshStrategy:'redirect'`.
- `envBindings = [ {envName:'GH_TOKEN', credentialPath:'oauth'}, {envName:'GITHUB_TOKEN', credentialPath:'oauth'} ]` — token reaches the container only as those env vars (substitute value).
- `substituteConfig: DEFAULT_SUBSTITUTE_CONFIG`.
- `transportCodec: githubTransportCodec` (lines 40-58): `toTransport` for Basic scheme = `'Basic ' + base64('x-access-token:' + storedToken)`; for Bearer = `scheme + ' ' + storedToken`. `fromTransport` for Basic decodes `base64('<user>:<token>')` and takes the password half.

### Substitute config (token-format dependent)
- `DEFAULT_SUBSTITUTE_CONFIG` (`src/modules/mitm-proxy/types.ts:32`): `{ prefixLen:10, suffixLen:4, delimiters:'-._~' }`.
- `src/modules/mitm-proxy/defaults.ts:46`: `pickSubstituteConfigForToken(token) = ALNUM_ONLY_RE.test(token) ? DEFAULT_ALNUM_SUBSTITUTE_CONFIG : DEFAULT_SUBSTITUTE_CONFIG`.
- `defaults.ts:61`: when the provider's `substituteConfig === DEFAULT_SUBSTITUTE_CONFIG`, the engine re-selects via `pickSubstituteConfigForToken(realToken)` — i.e. config depends on whether the real token is alphanumeric-only (legacy 40-hex GitHub token) vs contains `-._~` / prefix (e.g. `ghp_`/`gho_`).

### Not determined
- Whether geosafe's container received non-empty `GH_TOKEN`/`GITHUB_TOKEN`, and whether the agent's `curl` sent an `Authorization` header.
- Real token format behind the `enc:` value (not decrypted).
