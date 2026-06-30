---
name: credentials
description: >-
  How stored credentials work in this container. Your outbound HTTPS traffic is
  intercepted by a credential proxy that swaps placeholder "substitute" tokens
  for real secrets in flight — you never see or handle real credentials. Use
  this skill when you need a token for an external API (GitHub, etc.), hit a 401
  on a service whose credential should exist, or want to bind a credential to an
  env var. Do NOT ask the user for raw credentials.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Credentials

A host-side **credential proxy** sits on your outbound HTTPS path. Real secrets
live on the host and are injected at the proxy boundary — they never enter this
container. What you hold is always a **substitute**: a placeholder token the
proxy recognizes and swaps for the real secret as the request leaves.

## What this means for you

- **Never ask the user for a raw API key, token, or password.** If a credential
  is needed and missing, the host drives acquisition out-of-band.
- A substitute token will not look like the real secret and is useless outside
  this container — that's by design. Use it exactly where the real token would
  go; the swap happens in flight.
- Many providers are injected automatically at startup (e.g. as env vars). For
  those, just make the request — the proxy handles it.

## `get_credential`

When a credential exists on the host but isn't already in your environment (it
was added after you started, or the provider has no automatic injection), pull a
substitute with the `get_credential` tool:

- `providerId` — e.g. `"github"`, `"todoist"`.
- `credentialPath` — `"oauth"` for OAuth tokens, `"api_key"` for API keys.
- `envVar` (optional) — an `UPPER_SNAKE_CASE` name to publish the substitute as.
  When set, the value is written into your shell environment so subsequent
  `Bash` calls see it (e.g. `get_credential(providerId="github",
  credentialPath="oauth", envVar="GH_TOKEN")`, then `gh ...` just works).
  Reserved/host-injected names are rejected.

The tool returns the substitute string. Use it as the credential value
(Authorization header, CLI flag, or env var) — the proxy substitutes the real
secret when the request goes out.

## When something fails

- **401/403 from a service whose credential should exist:** the stored
  credential may be missing or expired. Don't retry blindly and don't ask for a
  raw key — report it; the host handles re-authentication.
- **"Unknown provider" / "No credentials found":** that provider/credential
  isn't stored for this group yet. Tell the user what's missing rather than
  improvising a credential.

## Discovering what credentials exist

This container can see only **manifests** — listings of which credentials exist
for your scope. There are **no token files to read** (v2 stores no
ready-to-use substitutes on disk); you always obtain a usable value via
`get_credential`. Your group folder is mounted at `/workspace/agent`:

```bash
# Own-scope manifests — one JSONL file per provider that has stored creds
ls /workspace/agent/credentials/manifests/ 2>/dev/null
cat /workspace/agent/credentials/manifests/github.jsonl 2>/dev/null
```

Each line describes one credential (no secret, no substitute):
```json
{"provider":"github","name":"oauth","credScope":"my-group"}
```
- `provider` — service id. `name` — the **credentialPath** to pass to
  `get_credential` (e.g. `oauth`, `api_key`). `credScope` — owning scope (your
  group, or a grantor you borrow from).

### Borrowed credentials
`credentials/borrowed` is a symlink to the active grantor under
`credentials/granted/<grantor>/`. Only credentials reachable through it are
usable:
```bash
ls -l /workspace/agent/credentials/borrowed
cat /workspace/agent/credentials/borrowed/*.jsonl 2>/dev/null
```
To start/stop borrowing, the user runs `/creds borrow <grantor>` /
`/creds stop-borrowing` (see the `proxy-operator` skill).

## When a credential is missing — acquisition ladder

If a credential isn't stored, do **not** ask the user for a raw key. Work down
this ladder:

1. **Device-code OAuth (preferred).** If the provider supports it, just start the
   flow (e.g. `gh auth login`). The proxy intercepts the device-code response and
   notifies the user (verification URL + code) out-of-band; when they approve,
   the credential becomes available via `get_credential`.
2. **Browser OAuth (authorize-stub).** Initiate the redirect flow. The proxy
   returns a JSON stub with an `interactionId` + `statusUrl`/`eventsUrl` instead
   of a real redirect — the host is now driving it with the user. Poll/stream
   status (below). If you get a *real* login page instead of a stub, the provider
   isn't proxy-configured — tell the user; never collect login credentials
   yourself.
3. **Manual key entry (operator command).** For plain API keys (no OAuth), tell
   the user to store it via chat — never pasted raw to you:
   - `/creds gpg` first (prints the group's public key to encrypt to),
   - then `/creds set-key <provider> [id]` (one key) or `/creds import [provider]`
     (bulk `[provider:]id=value` lines), or `/auth import` for the proxy set.
   Once stored, pull it with `get_credential`.

## Tracking interaction status (OAuth in flight)

The proxy is reachable from the container at `$PROXY_HOST:$PROXY_PORT`. Using the
`interactionId` from an authorize-stub response:
```bash
# status code only: 202=in-progress, 200=done, 410=failed/superseded, 404=unknown
curl -s -o /dev/null -w '%{http_code}' \
  http://${PROXY_HOST}:${PROXY_PORT}/interaction/<interactionId>/status
# live SSE stream: queued -> active -> completed|failed
curl -N http://${PROXY_HOST}:${PROXY_PORT}/interaction/<interactionId>/events
```
A `410` "superseded by <newId>" means a newer flow started — switch to the new id.

## Adding a provider the proxy doesn't know

If the service has no built-in provider, declare a per-group provider def and
reload — see the **`auth-providers`** skill (`/workspace/agent/.auth-discovery/`
+ `reload_auth_providers`).
