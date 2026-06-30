---
name: proxy-operator
description: >-
  Operator-facing chat commands for the credential proxy and credential store —
  /creds (store, list, share, borrow), /auth (re-authenticate), and /tap
  (inspect the proxy's outbound HTTPS traffic). Use when the user asks to add,
  share, or borrow a credential; to re-auth a provider; or to debug what the
  proxy is doing with outbound requests. You do NOT run these — you coach the
  user, who issues them in chat.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Proxy & Credential Operator Commands

These are **host slash commands the user types in chat** — not MCP tools you
call. Your job is to recognize when a user needs one and explain the exact
syntax. They resolve against the current group; some are admin-gated. Secrets
are always pasted GPG-encrypted — never have a user type a raw secret into chat;
have them run `/creds gpg` first and encrypt to that key.

## `/creds` — credential store & sharing

```
/creds                                   — show sharing status
/creds status                            — credential + sharing summary
/creds list                              — list providers with stored credentials
/creds gpg                               — print this group's GPG public key
                                           (encrypt secrets to this before set-key/import)
/creds set-key <provider> [id] [expiry=<ts>]  — store one key (GPG-encrypted paste)
/creds import [provider]                 — bulk import [provider:]id=value lines
                                           (GPG-encrypted paste)
/creds delete <provider>                 — delete a provider's stored credentials
/creds share <target-group-folder>       — grant another group access to your creds
/creds borrow <source-group-folder>      — borrow a grantor's shared creds
/creds revoke <target>                   — revoke a grant you issued
/creds stop-borrowing                    — stop borrowing from your current grantor
```

`/creds set-key` / `/creds import` are the "manual key" rung of the credentials
acquisition ladder (see the `credentials` skill). Sharing/borrowing controls
what appears under `/workspace/agent/credentials/borrowed/`.

## `/auth` — re-authenticate the proxy credential set

```
/auth import         — import / re-authenticate credentials for this agent group
/auth [group-folder] — (admin) target a specific group
```

Point users here when a stored OAuth/proxy credential is expired and the
device-code / authorize-stub flow needs re-running, or to import the initial set.

## `/tap` — inspect the proxy's outbound traffic

A debugging surface that logs what the proxy sees on outbound HTTPS. Off by
default; `/tap` is the **only** way to enable it.

```
/tap                                  — show current tap state
/tap all [exclude=p1,p2]              — tap all traffic
                                        (auto-excludes each runtime's model endpoint host)
/tap <domain-regex> <path-regex>      — tap only matching requests
/tap list [head|tail <N>] [body]      — show logged entries (optionally with bodies)
/tap stop                             — disable the tap
```

When helping debug "my API call to X isn't working": suggest `/tap <domain> <path>`
scoped to that host, reproduce the call, `/tap list` to inspect, then `/tap stop`.
Tap output includes request/response metadata through the proxy — treat as sensitive.

## Relationship to your own tools

- **Using** an existing credential → `get_credential` MCP tool (`credentials` skill).
- **Adding a provider the proxy doesn't know** → `/workspace/agent/.auth-discovery/`
  + `reload_auth_providers` (`auth-providers` skill).
- **Storing/sharing the secret, re-auth, or tapping traffic** → the `/creds`,
  `/auth`, `/tap` chat commands above (user-driven).
