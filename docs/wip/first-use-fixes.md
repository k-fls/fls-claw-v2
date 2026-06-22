# NanoClaw v2 — code changes made during integration

Scope: hand-edits to the v2 source while integrating branches
`feat/mitm-credential-proxy` + `feat/ssh-auth` + `module/split-docker-image` +
`module/runtime-updater` onto `origin/main` (branch `integration/v2-hagent`).
Telegram-adapter addition is **excluded** here (documented separately).
All edits are merge-conflict resolutions except #6, which is a fix.

Tree on box: `/home/nanoclaw/nanoclaw-v2`. Local clone: `/tmp/flsclaw-inspect`.

| # | File | Change |
|---|------|--------|
| 1 | `container/agent-runner/src/mcp-tools/index.ts` | Union of side-effect imports — kept all three: `import './credentials.js'`, `import './auth-providers.js'`, `import './ssh.js'`. |
| 2 | `container/Dockerfile` | Adopted `split-docker-image`'s app-layer (`FROM ${BASE_IMAGE}`). Re-added 4 apt packages absent from the base but required by ssh/mitm at runtime: `openssh-client`, `util-linux`, `iptables`, `libnss3-tools`. Added a comment noting why. **`container/Dockerfile.base` left unmodified** (identical to `origin/module/split-docker-image`). Note: `vercel` global install is dropped (came from the split branch). |
| 3 | `src/providers/claude-credential.ts` | Composed mitm + runtime-updater (7 conflict hunks): unioned imports (added `RUNTIME_UPDATER`, kept mitm's `CONTAINER_FEEDBACK/REAUTH/ensureGpgKey/...` and `randomBytes`, kept `interactions` + added `runtime-updater`/`parseProviderSpec` imports); kept BOTH contributors and call them both in `mergeContributions([... credentialSubstitutes(ctx), runtimeCliMount(ctx)])`; ExtensionBag set to union `AGENT_RUNTIME + ACQUIRE + CONTAINER_FEEDBACK + REAUTH + RUNTIME_UPDATER`; provider type kept as `SubstitutingProvider`. Header doc comment merged. |
| 4 | `src/container-runner.ts` | Took `runtime-updater`'s comment wording ("`resolveProviderName` moved to container-config"); removed a stale doc-comment block that sat above `resolveProviderContribution`. |
| 5 | `src/index.ts` | Union of top-level command imports — kept `./commands/stop.js` and added `./commands/agent-runtime.js` + `import { startRuntimeUpdaters, stopRuntimeUpdaters } from './modules/runtime-updater/index.js'`. |
| 6 | `src/container-config.ts` | **Fix (not a conflict):** the merge produced two `export function resolveProviderName` definitions (one from each side, at different line ranges, so git did not flag it) → `tsc` error TS2323/TS2393. Removed the duplicate `.toLowerCase()`-based copy; kept the version-aware one (`resolveProviderSpec(...).id`, which also lowercases via `parseProviderSpec`). |

Verification: `tsc --noEmit` → exit 0 after resolutions (including after the Telegram adapter was added). Host build `pnpm build` → `dist/` (337 .js + 78 assets), `better_sqlite3.node` compiled.

## Later edits (session/task migration)

| # | File | Change |
|---|------|--------|
| 7 | `container/Dockerfile` | Added `ENV CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS=0` and `ENV CLAUDE_TRANSCRIPT_ROTATE_BYTES=33554432`. These are read by the agent-runner (`container/agent-runner/src/providers/claude.ts`) via `process.env`; without them, migrated v1 transcripts (>14 days old; geosafe 20.5 MB) get rotated-aside on first wake. Image rebuilt + retagged `nanoclaw-agent-v2-1e478a5f`. (Correction: these are container-side, not host `.env`.) |
| 8 | `setup/migrate-v2/sessions.ts` | Added `'skills'` to `SKIP_NAMES`. `copyTree` of v1 `.claude/` collided with v2 `group-init`'s pre-created `.claude-shared/skills/<name>` dangling symlinks (→ container `/app/skills/...`), throwing `mkdirSync ENOENT`. v2 re-syncs skills at spawn, so skipping them is safe. |

## Telegram outbound robustness (bug #11)

| # | File | Change |
|---|------|--------|
| 9 | `src/channels/telegram-markdown-sanitize.ts` | Break code-span-inside-emphasis nesting. Telegram legacy Markdown can't nest a `` `code` `` inside `*bold*`/`_italic_` (the protected `*`/`` ` `` make the parser lose the entity boundary → "can't find end of the entity" → 400). Added a pass that drops the emphasis delimiters wrapping a code placeholder (keeps the code). Unit-verified on the failing reply + edge cases. |
| 10 | `src/channels/chat-sdk-bridge.ts` | **Delivery guarantee.** A reply the agent generated must never silently drop on a formatting rejection. Wrapped the outbound text send: on a format/entity error (`isFormatError`), retry the chunk as **plain** (`{ raw }` → adapter sends with no `parse_mode`, via `toPlainText`); if even that fails, send a stub. Added exported `isFormatError`/`toPlainText` helpers. |

Both are host-side (`src/channels/` → `dist/`), deployed via `pnpm build` + daemon restart (no image rebuild). `tsc --noEmit` → 0.

## Migration ran against an **already-live** v2 (not greenfield), so two things needed manual fixup beyond the scripts (data, not code): the official `sessions.ts` skips the `-workspace-group`→`-workspace-agent` transcript copy and continuation when `-workspace-agent` already exists (it did, from v2's same-day runs), so it picked a v2-native continuation. Fixed by copying each v1 transcript `.jsonl` into `-workspace-agent/` (the SDK resumes only from the current-cwd project dir) and setting `session_state['continuation:claude']` to the v1 UUID (main `24d79d08`, geosafe `38f4f663`) in each session's `outbound.db`.

## Non-code changes (for completeness — not source edits)
- Data/config only: credential file copies (`*.keys.json`→`*.json`), `.env`, `v2.db` rows via `ncl` (groups/messaging-groups/wirings/destinations/roles), `upgrade-state.json` stamp, data-dir symlinks to `/mnt/nanoclaw-data`, image retag to slug `1e478a5f`. None touch source.
