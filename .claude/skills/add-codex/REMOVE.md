# Remove the Codex agent provider

Reverses every change `/add-codex` makes and returns every group to the default provider. Safe to run when partially installed — skip any step whose target is already absent.

## 1. Switch codex groups back to the default

List groups still on codex and switch each one (each group's `memory/` tree stays on disk and readable; run `/migrate-memory` per group if its memory should carry back to Claude — see [docs/provider-migration.md](../../docs/provider-migration.md)):

```bash
ncl groups list
# for each group whose config shows provider=codex:
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

## 2. Delete the barrel imports and the credential registration

Delete (do not comment out) the `import './codex.js';` line from each of:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `setup/providers/index.ts`

The credential provider is not barrel-driven — registration is an explicit call
inside the host entry point. Delete both lines from `src/index.ts`:

```
import { registerCodexCredentialProvider } from './providers/codex-credential.js';
registerCodexCredentialProvider();
```

Leaving the call while deleting the file breaks host boot outright; leaving both
keeps the OpenAI hosts intercepted for every group with no credential behind them.

## 3. Delete every copied file

```bash
rm -f src/providers/codex.ts \
      src/providers/codex-agents-md.ts \
      src/providers/codex-registration.test.ts \
      src/providers/codex-host-contribution.test.ts \
      src/providers/codex-agents-md.test.ts \
      container/agent-runner/src/providers/codex.ts \
      container/agent-runner/src/providers/codex-app-server.ts \
      container/agent-runner/src/providers/exchange-archive.ts \
      container/agent-runner/src/providers/exchange-archive.test.ts \
      container/agent-runner/src/providers/codex-registration.test.ts \
      container/agent-runner/src/providers/codex.factory.test.ts \
      container/agent-runner/src/providers/codex.turns.test.ts \
      container/agent-runner/src/providers/codex-app-server.test.ts \
      container/agent-runner/src/providers/codex-cli-tools.test.ts \
      setup/providers/codex.ts \
      setup/providers/codex.test.ts \
      src/providers/codex-credential.ts \
      src/providers/codex-credential.test.ts
```

This skill itself (`.claude/skills/add-codex/`) stays — it ships with trunk so the provider can be re-added later.

`container/AGENTS.md` stays only if another installed provider uses agent surfaces; otherwise remove it too.

## 4. Remove the CLI manifest entry

Delete the `@openai/codex` entry from `container/cli-tools.json`:

```bash
node -e '
  const fs = require("fs");
  const file = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(file, "utf8")).filter((t) => t.name !== "@openai/codex");
  const fmt = (t) => "  { " + Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + " }";
  fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
'
```

## 5. Stored ChatGPT credentials (optional)

Each signed-in group holds its own credential in the host store, and it grants
nothing once the provider is gone. Per group, from a channel that engages it:

```
/creds delete codex
```

Or on the host, remove the keys file directly — one per signed-in scope:
`${XDG_CONFIG_HOME:-~/.config}/nanoclaw/credentials/<group-folder>/codex.keys.json`.

Revoking at OpenAI is a separate step and belongs to whoever signed in: the
stored refresh token stays valid at the provider until they sign the session out
of their ChatGPT account.

## 6. Rebuild and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
pnpm test
cd container/agent-runner && bun test
```

All suites green and `ncl groups list` showing no codex groups means the removal is complete. Restart the service (`launchctl kickstart -k gui/$(id -u)/<label>` on macOS, `systemctl --user restart <unit>` on Linux).
