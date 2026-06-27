# Upstream Changes: `d85efea2` (our fork, v2.1.1) → `upstream/main` (`2afbd182`, ~v2.1.21)

~150 commits, +9,622/−1,457 across 179 files. Three big feature themes (agent-to-agent approval policies, channel instances, operator-driven providers) plus a new uninstaller, container resource limits, a data-driven CLI manifest, and a hardened approval-authorization model.

> ⚠️ **Critical fork-collision warning for whoever merges this:** Our fork's `feat/cli-policies` branch adds `src/db/migrations/016-cli-policies.ts` AND a `policies` ncl resource (`src/cli/resources/policies.ts`) meaning *CLI-capability grants*. Upstream **independently** adds `016-messaging-group-instance.ts` AND a `policies` ncl resource (`src/cli/resources/policies.ts`) meaning *agent-to-agent approval policies*. Both the migration number `016` and the `policies` resource/file name collide head-on with different semantics. This is the single highest-risk merge conflict in the range.

---

## 1. User/Admin functions ADDED

### New `ncl` resource: `policies` (agent-to-agent approval gate)
`ncl policies list/set/remove` creates a directed, per-pair require-approval gate on an existing A→B agent connection — every message A sends to B is held for human approval before delivery, without un-wiring the connection. No row = free flow. Operator-only (agents cannot manage their own gates). Each policy carries a **mandatory `approver`** user-id; only that user (or an owner) can approve. Files: `src/cli/resources/policies.ts`, `src/modules/agent-to-agent/db/agent-message-policies.ts`, `src/modules/agent-to-agent/message-gate.ts`.

### New ncl group-config flag: `--provider`
`ncl groups config update --provider <name>` + restart switches a live agent group's provider (Claude ↔ Codex). Provider is now an explicit per-group DB property (`container_configs.provider`), not a Claude-only assumption. Commit `13a37def`.

### New env knobs: per-container resource limits (opt-in)
`CONTAINER_CPU_LIMIT` and `CONTAINER_MEMORY_LIMIT` pass through to `docker run` as `--cpus` / `--memory`. Empty by default = unbounded (byte-identical spawn args to today). Files: `src/config.ts`, `src/container-runner.ts`. Commit `1d6bba4d`.

### New agent provider: Codex (OpenAI) via `/add-codex`
Full runtime via `codex app-server` (planning, MCP tools, server-side history, resume). Auth is vault-only via OneCLI — no credential enters a container. The skill was reworked to install Codex through `cli-tools.json` instead of editing the Dockerfile. Files: `.claude/skills/add-codex/SKILL.md`, `setup/add-codex.sh`.

### New skill: `/learn`
Instruction-only skill that distills a reusable `SKILL.md` from a directory, URL, pasted notes, or "what we just did," or refines an existing skill in place. File: `.claude/skills/learn/SKILL.md`. Commit `520ec44a`.

### New skill: `/migrate-memory`
Operator-run skill that carries a group's agent memory across a provider switch in either direction (flat `CLAUDE.local.md` ↔ `memory/` scaffold tree). Copy-never-move, idempotent. File: `.claude/skills/migrate-memory/SKILL.md`. Added to CLAUDE.md skills table.

### New capability: per-checkout uninstaller
`nanoclaw.sh --uninstall` (and the `uninstall.sh` shim) removes only artifacts tagged with this checkout's install slug, so multiple installs coexist. Four default-No confirmation groups (app/service, data/.env, agent memory, OneCLI vault agents), `--dry-run` and `--yes` flags, nothing deleted until all decisions made. OneCLI cleanup deletes only this copy's vault agents (`onecli agents list`); the OneCLI app/gateway are never touched. Setup now also detects an existing install and offers Keep/Uninstall. Files: `setup/uninstall/*.ts`, `uninstall.sh`, `nanoclaw.sh`, `setup/auto.ts`.

### New capability: channel instances (multiple adapters of one platform)
`messaging_groups.instance` lets an operator run N adapters of one platform side-by-side (e.g. three Slack apps, each its own token/signing-secret/webhook URL at `/webhook/<instance>`). Default instance value *is* the `channel_type`, so single-instance installs are unchanged. Commits `0b31695e` and related.

### New setup flow: select/install/authenticate a non-default provider
Setup gains a provider picker (Claude | Codex); a non-default pick installs the payload, runs a vault auth walkthrough, and records the pick on the first agent. Late adopters can run `pnpm exec tsx setup/index.ts --step provider-auth <provider>` without re-running full setup. Files: `setup/providers/registry.ts`, `setup/provider-auth.ts`, `setup/lib/picked-provider.ts`.

### New internal capability: raw (non-Chat-SDK) webhook registry
`registerWebhookHandler(path, handler)` lets modules receive raw webhooks (GitHub, payment providers, health checks) at `/webhook/<path>` on the shared server without a new port — primarily an extension seam, but newly available to skills/adapters. File: `src/webhook-server.ts`.

### New docs (user-facing)
`docs/provider-migration.md`, `docs/onecli-upgrades.md` (gateway upgrade runbook), `docs/customizing.md`, `docs/skills-model.md`, `docs/skill-guidelines.md`; removed the 677-line `docs/skills-as-branches.md`. Korean README (`README_ko.md`).

---

## 2. User/Admin functions CHANGED

### [SECURITY/BREAKING] `create_agent` now authorized host-side
Previously trusted the (bypassable) container-side MCP gate. Now enforced by CLI scope on the host: only `cli_scope: 'global'` (owner) groups create directly; **every confined group — including the default `group` scope — must get admin approval first**, and unknown config fails closed to the approval path. The MCP tool description changed from "Admin-only" to "May require admin approval." A child agent now inherits its creator's provider. Commit `c6627d32`, `src/modules/agent-to-agent/create-agent.ts`.

### [SECURITY/BREAKING] Approval responses now require authorization
Every approval-card click is gated through `isAuthorizedApprovalClick` — a valid `questionId` is no longer sufficient. The clicker must be the named approver (if set), else owner/global-admin, else hold admin on the approval's agent group. Unauthorized clicks are logged and ignored. Any prior flow resolving approvals from a non-privileged identity will now silently no-op. Commit `728c6a64`, `src/modules/approvals/response-handler.ts`.

### Approval cards gained a third button: "Reject with reason…"
Parks the approval at `status='awaiting_reason'`, DMs the admin for a one-line reason (≤280 chars, captured via a router interceptor), and relays it to the requesting agent. A host-sweep finalizer (~5 min) turns a ghosted hold into a plain reject so the agent is never stranded. Commit `e8148bc0`, `src/modules/approvals/reason-capture.ts`, `finalize.ts`. OneCLI credential cards keep their two-button set.

### Approval cards now show who acted
Resolved cards display `— <actorName>` byline. `src/channels/chat-sdk-bridge.ts`, commit `0ac8073e`.

### Budget/billing error turns now delivered instead of dropped
A non-retryable provider error (e.g. Anthropic `403 billing_error`) with no `<message>` envelope is delivered to the user as a notice instead of being silently dropped, and the re-wrap nudge is skipped so it stops hammering the failing gateway. Commit `01433bae`, `container/agent-runner/src/poll-loop.ts`, `providers/claude.ts`.

### Slash commands now interrupt an in-flight turn
A runner-handled command (`/clear`, `/compact`, `/cost`) arriving mid-turn calls `query.abort()` (was `query.end()`) and runs immediately. Commit `3d2f3e58`, `poll-loop.ts`.

### [BREAKING] Chat SDK pinned to `4.29.0` (was `^4.24.0`)
`chat` and `@chat-adapter/*` are version-locked; a mismatched pair fails to typecheck. Any installed channel must re-run its `/add-<channel>` skill to pull the matching adapter. All `/add-*` SKILL.md + `setup/*.sh` install pins bumped.

### [BREAKING] OneCLI SDK `0.5.0` → `2.2.1` (requires `/v1` API)
Older OneCLI servers 404 every SDK call. Sanctioned gateway/CLI versions now pinned in a new `versions.json`. The gateway is a separate component — updating NanoClaw does not upgrade it; `/update-nanoclaw` gained Step 5.5 to upgrade it when the pin moves (runbook in `docs/onecli-upgrades.md`). Commit `3f9e89d3`.

### `/update-nanoclaw` and `/update-skills` workflow changes
`/update-nanoclaw` Step 7 now treats skill updates as part of the update (default-in, single opt-out). `/update-skills` now rebuilds the agent image when a re-apply touched anything under `container/`. Commits `055cf49b`, `add6145f`.

### `init-first-agent` / `manage-channels` skills ask which provider
Both gained `--provider <name>` handling when a non-default provider is installed. `scripts/init-first-agent.ts` accepts the flag.

---

## 3. Internal functionality ADDED or SIGNIFICANTLY CHANGED

### New migrations (016–018)
- **016-messaging-group-instance** — adds NOT-NULL `instance` column with `UNIQUE(channel_type, platform_id, instance)`, backfilled `instance = channel_type`. Requires an FK-safe table recreate; introduces a new `disableForeignKeys` migration flag and a `foreign_key_check` before/after-diff harness in `src/db/migrations/index.ts` (toggles `foreign_keys=OFF` around the transaction, fails only on *introduced* violations, warns on pre-existing orphans). Also adds a `denied_at` column.
- **017-agent-message-policies** — new `agent_message_policies(from, to, approver, created_at)` table for the a2a gate.
- **018-approvals-approver-user-id** — adds `approver_user_id` to `pending_approvals`; when set, only that exact user may resolve. `pending_approvals` also gained an `awaiting_reason` status + expiry for reject-with-reason.

### File relocations (will conflict on merge)
`src/onecli-approvals.ts` → `src/modules/approvals/onecli-approvals.ts`; `src/user-dm.ts` → `src/modules/permissions/user-dm.ts`. CLAUDE.md key-files paths updated accordingly.

### Approval-resolved callback registry
`registerApprovalResolvedHandler` / `notifyApprovalResolved` fire after any authorized approve/reject so modules can observe resolution (e.g. clear a status indicator). Reject finalization unified into one `finalizeReject` path shared by the instant button, captured-reason reply, and sweep finalizer. `src/modules/approvals/primitive.ts`, `finalize.ts`. Commit `93a302b5`.

### Multiple message interceptors
Router's single `setMessageInterceptor` → `registerMessageInterceptor` (ordered, first-to-claim wins), so agent-naming capture and reject-reason capture coexist. `src/router.ts`, `src/modules/permissions/index.ts`.

### Channel registry keyed by instance
`activeAdapters` keyed by `instance ?? channelType`. New `getChannelAdapterExact()` (no fallback, for instance-addressed delivery/typing so a reply never exits via the wrong sibling bot) vs. fallback-bearing `getChannelAdapter()`. Instance threaded through router, delivery (origin-session-first messaging-group resolution), and typing. Per-instance Chat SDK state namespaces in `src/state-sqlite.ts` (default instance stays unprefixed to avoid orphaning live rows). `[SECURITY] reject unsafe forwarded a2a attachments` — symlink/realpath containment guard in `src/modules/agent-to-agent/agent-route.ts` (commit `8385236c`).

### Provider abstraction seams
- **agent-surfaces capability seam** — `registerProviderContainerConfig` takes `ProviderHostCapabilities.providesAgentSurfaces`; when declared, the host skips composing/mounting default surfaces (CLAUDE.md, `.claude`, `CLAUDE.local.md` seeding) and lets the provider own them. `src/providers/provider-container-registry.ts`, `src/group-init.ts`.
- **`onExchangeComplete` poll-loop hook** — called after each completed exchange so providers without an on-disk transcript (Codex) can persist exchanges; `processQuery` exported and now maintains an `archivePrompts` queue so the hook sees the real user prompt. `container/agent-runner/src/poll-loop.ts`, `providers/types.ts`.
- **opt-in memory scaffold** — providers set `usesMemoryScaffold`; the runner builds a persistent `memory/` tree from templates at boot, idempotently. `container/agent-runner/src/memory-scaffold.ts`, `memory-templates/`.

### Container build: data-driven CLI manifest
Global Node CLIs (`vercel`, `agent-browser`, `@anthropic-ai/claude-code`) moved from hand-edited Dockerfile `RUN` layers into `container/cli-tools.json` + `install-cli-tools.sh` (preserves pnpm supply-chain policy). A skill now adds a CLI by appending one manifest entry. Commits `785fce37`, `adfae676`.

### Container spawn/restart
`container-runner.ts` appends `--cpus`/`--memory` when set, and now keeps a 10-line stderr tail logging "Container exited non-zero" with `stderrTail` (surfaces unknown-provider / missing-binary boot failures). `container-restart.ts` now respawns after a kill whenever there are pending/claimed messages (not only on an explicit wake message), so a mid-conversation provider switch doesn't go dark.

### Host-sweep & session-manager fixes
Grace period for freshly-woken containers with stale `processing` claims (`a8065341`, `src/host-sweep.ts`); `writeOutboundDirect` now opens `outbound.db` read-write (`eef285ba`, `src/session-manager.ts`); `getDeliveryAction` read-side added to the delivery action registry (`539a2b3c`).

### Setup internals
New `setup/peer-cleanup.ts` reaps dead peer launchd/systemd registrations whose binary is gone; `setup/lib/captured-token.ts` extracts a Claude OAuth token out of wrapped `script(1)` PTY capture (CSI/ANSI normalization); `setup/lib/version-pins.ts` reads `versions.json`; `setup/environment.ts` gained `upsertEnvKey()`. `.claude` mirrored into `.agents` via symlinks (`e4907c2c`).

### Long tail (briefly)
agent-runner `@anthropic-ai/claude-agent-sdk` `^0.3.154`→`^0.3.170`; claude-code bumped to 2.1.170; dead `resolveGroupIpcPath` removed; `setup/auto.ts` `NANOCLAW_AGENT_PROVIDER` preselect; numerous test files added; version bumped to 2.1.21; final commit `797491d8` fixes a `migrate-v2` SELECT of a missing `is_main` column.
