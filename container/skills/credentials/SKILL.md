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
