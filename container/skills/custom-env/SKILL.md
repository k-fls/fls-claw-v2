---
name: custom-env
description: >-
  Self-manage persistent custom environment variables for your agent group.
  Values you append to /workspace/agent/env-custom.jsonl are curated by the host
  and re-injected into your container on every spawn. Use this skill to set,
  view, update, or remove non-secret config (endpoints, IDs, feature flags) that
  should survive restarts. NOT for secrets — those go through the credential
  proxy (see the `credentials` skill).
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Custom Environment Variables

You can persist environment variables across restarts by editing one file in
your group folder. On **every spawn** the host reads
`/workspace/agent/env-custom.jsonl`, curates it (validates + dedupes), and
injects the result into your container env.

The file is JSONL — one JSON object per line:

```json
{"name":"API_BASE_URL","value":"https://api.example.com"}
{"name":"FEATURE_FLAG_X","value":"on"}
```

## View what's set

```bash
# What is persisted (the declarations the host curates next spawn):
cat /workspace/agent/env-custom.jsonl 2>/dev/null

# What is actually effective in THIS session:
printenv | sort          # all vars
echo "$API_BASE_URL"     # one var
```

The persisted file and the live environment can differ — see the timing caveat
below.

## Add or update a variable

Append a line. Updating a var = appending a new line with the same name
(last-write-wins on curation, so the last line for a name takes effect):

```bash
# Use printf, not echo, so quotes/escapes in the value survive.
printf '{"name":"%s","value":"%s"}\n' "API_BASE_URL" "https://api.example.com" \
  >> /workspace/agent/env-custom.jsonl
```

For values containing special characters, prefer a tool that JSON-escapes:

```bash
jq -nc --arg n "API_BASE_URL" --arg v "$SOME_VALUE" \
  '{name:$n,value:$v}' >> /workspace/agent/env-custom.jsonl
```

## Remove a variable

There is no delete line. To remove a var, rewrite the file without it. The file
is plain text and editable by you (or the operator):

```bash
# Drop every line declaring NAME:
grep -v '"name":"OLD_VAR"' /workspace/agent/env-custom.jsonl > /tmp/env.tmp \
  && mv /tmp/env.tmp /workspace/agent/env-custom.jsonl
```

(The removal takes effect next spawn. The var stays in the current session until
you `unset OLD_VAR`.)

## Crucial caveats

- **Takes effect on the NEXT spawn, not this session.** The file is read at
  container start. If you need the value *right now too*, also export it:
  ```bash
  export API_BASE_URL="https://api.example.com"   # this session only
  ```
  Persist it in the file **and** export it if you need both now and later.
- **`UPPER_SNAKE` names only.** A name must match `^[A-Z_][A-Z0-9_]{0,127}$`.
  Anything else is silently skipped at curation.
- **Reserved names are silently rejected.** The host already injects some names
  and refuses to let custom env shadow them — e.g. `PATH`, `HOME`, `SHELL`,
  `USER`, `PWD`, `TERM`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `TZ`,
  `HOST_UID`, `HOST_GID`, and the proxy vars. Pick a different name.
- **Last-write-wins** on duplicate names within the file.
- **Bad lines are skipped, never fatal.** An unparseable line, a missing
  `name`/`value`, an invalid name, or a reserved name is dropped (and logged on
  the host); the rest of the file still loads. If a var doesn't appear after a
  restart, check the name format and that it isn't reserved.

## NOT for secrets

`env-custom.jsonl` is plain text persisted in your group folder — it is for
**non-secret config**: API base URLs, account/project IDs, region names, feature
flags, log levels, and similar.

**Never put API keys, tokens, or passwords here.** Credentials are handled by
the host-side credential proxy and never stored as plain env values:

- To bind a credential to an env var for this session, use `get_credential` with
  its `envVar` argument — see the **`credentials`** skill.
- Operator-side credential storage/borrowing is in the **`proxy-operator`**
  skill (`/creds ...`).
