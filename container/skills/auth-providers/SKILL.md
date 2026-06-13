---
name: auth-providers
description: >-
  How to add or edit per-group auth providers (OAuth or plain HTTP/bearer) for
  the MITM credential proxy from inside this container, and apply the change live with
  `reload_auth_providers`. Use when the user wants you to reach an API the
  proxy doesn't already know about (no automatic env injection, "Unknown
  provider" from `get_credential`), or when you've edited a provider def and
  need it to take effect without a restart. Pairs with the `credentials` skill
  (which covers using a credential once the provider exists).
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Per-group auth providers

The host-side **credential proxy** intercepts your outbound HTTPS and swaps
substitute tokens for real secrets in flight (see the `credentials` skill). It
knows ~60 providers out of the box (GitHub, Todoist, …). For a service it
*doesn't* know, this group can declare its own **provider definition** — a JSON
file that tells the proxy which hosts to intercept and how to substitute a
credential there.

These defs live in a hidden directory in your workspace:

```
/workspace/agent/.auth-discovery/
```

It's dot-prefixed, so it won't show up in a plain `ls` — use `ls -a` (or look at
`.auth-discovery/` directly). It is read-write: you edit it; the host reads it.

> Declaring a provider sets up **interception + substitution rules** only. The
> real credential is stored host-side (the host drives that out-of-band) — you
> never put a raw secret in these files or anywhere else. A def with no stored
> credential just means `get_credential` / requests return "no credentials
> found" until the host has one.

## Provider definition format

One `*.json` file per provider; the filename (minus `.json`) is the provider
id. Standard OIDC/endpoint fields define what to intercept; `_`-prefixed fields
tune behavior. Minimal shape for a plain bearer-token API:

```json
{
  "api_base_url": "https://api.example.com",
  "_env_vars": { "EXAMPLE_TOKEN": "api_key" }
}
```

Common fields:

- `api_base_url` — all sub-paths under this host are intercepted (bearer-swap).
- `token_endpoint` / `authorization_endpoint` — for OAuth token exchange flows.
- `_api_hosts` — extra hosts to bearer-swap beyond `api_base_url`.
- `_env_vars` — map of `ENV_NAME` → credential path (`"api_key"` or `"oauth"`).
  The substitute for that credential is published under the env name.

Model new defs on the built-in ones — for example GitHub's shape:

```json
{
  "issuer": "https://github.com",
  "token_endpoint": "https://github.com/login/oauth/access_token",
  "api_base_url": "https://api.github.com",
  "_env_vars": { "GH_TOKEN": "oauth" }
}
```

## Applying changes — `reload_auth_providers`

Provider defs load once, when this container started. After you add or edit a
file in `.auth-discovery/`, call the **`reload_auth_providers`** tool to apply
it immediately — no restart. It re-runs the loader and returns
`{ registered, rejected }`. The same outcome is written to
`.auth-discovery/_load-report.json` (read it to see exactly what happened):

```json
{
  "registered": ["example"],
  "rejected": [{ "id": "widen", "reason": "anchor 'api.github.com' is owned by global provider 'github'" }],
  "ip": "…", "scope": "…", "generatedAt": "…"
}
```

If your def is in `rejected`, fix it per the reason and reload again. Once a
provider is `registered`, pull its substitute with `get_credential` (see the
`credentials` skill) or use the `_env_vars` name you declared.

## What gets a def rejected (safety rules)

These guardrails stop a group def from hijacking traffic it shouldn't. The
report's `reason` will name which one fired:

- **Reusing a built-in provider id** (e.g. naming your file `github.json`) —
  rejected. Pick a distinct id.
- **Intercepting a host a built-in provider owns** (e.g. pointing
  `api_base_url` at `api.github.com`) — rejected. A group def can never widen
  or override where a global credential is sent.
- **Anchor too broad** — a group provider's host must have **at least two
  labels** (`example.com`, not a bare TLD).
- **Env-var name collision** — an `_env_vars` name that's reserved by the host,
  or already used by another provider in this container — rejected. Use a
  unique name.

## Bound-domain confinement

Because you can edit these defs, a credential captured for a group provider is
**pinned to the registrable domain it was issued for**. If you later edit the
def to point at a different domain, the proxy will *not* send the real token
there — it forwards the (useless) substitute instead. This is a security
boundary, not a bug: you can't redirect a real secret by editing a def. Built-in
(global) providers are exempt.
