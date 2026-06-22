# State scopes — what lives where, at which cardinality

NanoClaw's runtime state spans five axes. Knowing which axis a piece of
data belongs to determines where it lives on disk, who can mutate it,
when it's evicted, and whether two concurrent containers see the same
copy or different copies. This page is the reference.

Scopes, finest to coarsest:

1. **Per message** — one inbound message in flight.
2. **Per session** — one container = one (agent_group × messaging_group × thread) triple.
3. **Per messaging group** — one chat/channel on one platform.
4. **Per agent group** — one agent identity, possibly fronted by many messaging groups.
5. **Global** — host process and host filesystem.

See [isolation-model.md](isolation-model.md) for how the wiring between
agent groups and messaging groups produces the session-mode behavior
referenced below. See [db.md](db.md) for the three-DB model
underpinning the per-session and global tables.

---

## 1. Per message

**Identity:** a single `message_id` written into `inbound.db.messages_in`.

**Lifetime:** from the moment an adapter receives a platform event to
the moment the agent's reply (or system action) for that message has
been delivered and the message marked processed.

**Lives where:**

| Data | Location |
|---|---|
| Message row | `inbound.db.messages_in` (per session — see §2) |
| Attachments | `data/v2-sessions/<sessionId>/inbox/<message_id>/` |
| Pending agent reply | `outbound.db.messages_out` rows correlated by message id |
| In-flight interaction (one human question/answer the agent is awaiting) | `inbound.db.pending_questions` |
| Pending approval (one human approve/deny gate) | central `data/v2.db.pending_approvals` (yes — see §5; approvals live globally because they can outlive a container restart) |

**Who writes:** host (adapter → router → inbound DB) on receipt; the
container's agent-runner on processing; the host again on delivery.

**Concrete:** user `@bot` mentions in Slack. Adapter writes one row to
`messages_in`. The container wakes, the agent runs, writes one or more
rows to `messages_out` (text, system actions, attachments). Host
delivers. The message is "done." No persistent state above the session
level was touched unless the agent explicitly chose to.

---

## 2. Per session

**Identity:** `sessionId = (agent_group_id, messaging_group_id, thread_id)`.
The thread component is `NULL` when the channel adapter doesn't support
threading or when `session_mode = 'agent-shared'`. See
[isolation-model.md](isolation-model.md) for which session_mode
collapses which axes.

**Lifetime:** created on first message that needs the session; status
stays `active` until explicitly closed (`/end`, agent group deletion,
or a session-recycle path). The **container** for the session is
spawned on demand and torn down between messages — session ≠ container
lifetime. The session row outlives many container spawns.

**Lives where:**

| Data | Location |
|---|---|
| Session row | `data/v2.db.sessions` (one row per session) |
| Inbound DB (host writes, container reads) | `data/v2-sessions/<sessionId>/inbound.db` |
| Outbound DB (container writes, host reads) | `data/v2-sessions/<sessionId>/outbound.db` |
| Attachment inbox | `data/v2-sessions/<sessionId>/inbox/` |
| Container heartbeat | `data/v2-sessions/<sessionId>/.heartbeat` (touch file) |
| Container `.claude/` workspace state | container `/workspace/.claude/` |
| `sdk_session_id` continuation (which Claude JSONL to resume) | `outbound.db.session_state` |
| NanoClaw conversation transcript | `inbound.db.messages_in` + `outbound.db.messages_out` |

**Container mount:** the session dir is mounted as `/workspace` (RW)
inside the container. `src/container-runner.ts:319-320`.

**Who writes:**
- Exactly one host process writes to `inbound.db`.
- Exactly one container writes to `outbound.db`.
- No file is written by both sides — this is the single-writer rule
  that makes cross-mount SQLite safe. See [db-session.md](db-session.md).

**Sequence numbers:** host uses even `seq`, container uses odd.

**Concrete:** Slack channel `#support`, three live threads, `session_mode:
per-thread`. Three sessions exist concurrently for the same agent group.
Three independent `inbound.db` + `outbound.db` pairs. Three independent
conversation logs. Three containers when all three threads are hot.

---

## 3. Per messaging group

**Identity:** one row in `messaging_groups` — a single chat surface on a
single platform (one Slack channel, one Telegram chat, one Discord
channel, one GitHub PR thread, one iMessage chat, etc.).

**Lifetime:** from `/init-first-agent` or `/manage-channels` wiring
until the channel is unwired.

**Lives where:**

| Data | Location |
|---|---|
| Messaging group row (platform id, channel type, is_group, engage policy, unknown_sender_policy, sender_scope) | `data/v2.db.messaging_groups` |
| Wiring to agent groups (with session_mode, trigger_rules, priority) | `data/v2.db.messaging_group_agents` (many-to-many) |
| Channel adapter credentials | OneCLI vault (not in NanoClaw DB) |
| Channel-specific state (e.g. Chat SDK bridge state per channel) | `data/v2.db.chat_sdk_*` |
| Pending channel-registration approval | `data/v2.db.pending_channel_approvals` |
| User → DM messaging group cache | `data/v2.db.user_dms` |

**Mounts:** none. Messaging groups don't have a filesystem presence —
they're pure DB rows used by the router (`src/router.ts`) to decide
where an inbound platform event goes.

**Who writes:** host only. Channel adapters propose changes through
the channel-registry/router; the DB is the only state.

**Concrete:** the same Slack workspace can have ten channels — each
is its own messaging group, each can wire to a different agent group
or the same one. Two messaging groups (Slack #support and Telegram
chat 12345) wired to the same agent group with `session_mode: shared`
produce two sessions, both running under the same agent identity.

---

## 4. Per agent group

**Identity:** one row in `agent_groups`. The agent's name, folder,
container config, identity, skills, and memory.

**Lifetime:** from agent creation (typically `/init-first-agent` or
self-mod) until `deleteAgentGroup` (`src/db/agent-groups.ts:42`).
**Crucially, agent groups outlive any individual session.** The same
agent identity can be torn down and respawned across many sessions and
across many host process restarts; its on-disk state persists.

**Lives where:**

| Data | Location |
|---|---|
| Agent group row | `data/v2.db.agent_groups` |
| Working dir | `groups/<folder>/` |
| Per-group memory | `groups/<folder>/CLAUDE.local.md` |
| Composed system prompt | `groups/<folder>/CLAUDE.md` (regenerated each spawn) |
| Prompt fragments (skills, channel formatting, …) | `groups/<folder>/.claude-fragments/` |
| Container config | `groups/<folder>/container.json` |
| **Credentials store** | `${XDG_CONFIG_HOME:-~/.config}/nanoclaw/credentials/<folder>/` |
| **Credential resolver cache** | host process memory, keyed by folder |
| Grant state (who can borrow this group's creds) | `groups/<folder>/credentials/grantees.json` |
| Borrow source (who this group borrows from) | `groups/<folder>/credentials/borrowed` (symlink) |
| Distributed grantor manifests | `groups/<folder>/credentials/granted/<grantor>/` |
| Per-group GPG keyring | `${XDG_CONFIG_HOME}/nanoclaw/credentials/<folder>/.gnupg/` |
| Claude SDK state (settings, hooks index, projects/, JSONL transcripts) | `data/v2-sessions/<agent_group_id>/.claude-shared/` |
| Per-group skill symlinks | `data/v2-sessions/<agent_group_id>/.claude-shared/skills/` |
| Agent-to-agent destinations | `data/v2.db.module_agent_to_agent_destinations` |
| Members (unprivileged access list) | `data/v2.db.agent_group_members` |
| Scoped role assignments | `data/v2.db.user_roles` (role with `agent_group_id`) |

**Container mounts:**
- `groups/<folder>/` → `/workspace/agent` (RW, shared across all sessions of this group)
- `data/v2-sessions/<agent_group_id>/.claude-shared/` → `/home/node/.claude` (RW, shared)

`src/container-runner.ts:308,322-345,361-363`.

**Who writes:** the host (creation, config edits, credential store);
any container belonging to this agent group (`CLAUDE.local.md` edits,
working files, Claude SDK transcripts). Concurrent containers writing
the same files is possible but rare in practice — most agent-group
data is read-mostly at runtime.

**JSONL transcript caveat:** every session has its own Claude SDK
`session_id` and thus its own `.jsonl` file inside the shared
`projects/` dir. The directory is shared; the per-session files are
not. See [agent-runner-details.md](agent-runner-details.md).

**Concrete:** agent group `support-bot` wired to three messaging
groups, with two live threads in one of them and one in each of the
others, gives **four concurrent sessions** at peak. All four
containers mount the same `groups/support-bot/` and the same
`.claude-shared/`. If the agent in session A writes
`user_preferences.json` to `/workspace/agent/`, session B sees it on
its next turn. If session A appends to `CLAUDE.local.md`, every
future session of `support-bot` reads the new memory.

---

## 5. Global (host)

**Identity:** the host process and the host filesystem.

**Lifetime:** as long as the NanoClaw service is installed. Survives
host process restarts.

**Lives where:**

| Data | Location |
|---|---|
| Central DB (all the tables that aren't per-session) | `data/v2.db` |
| Schema version & migrations history | `data/v2.db.schema_version` |
| Users & DM cache | `data/v2.db.users`, `data/v2.db.user_dms` |
| Owner / global admin roles | `data/v2.db.user_roles` (role with `agent_group_id IS NULL`) |
| Pending approvals (multi-step gates, can outlive container restarts) | `data/v2.db.pending_approvals` |
| Dropped messages (audit) | `data/v2.db.dropped_messages` |
| Scheduled tasks / recurrence | `data/v2.db.module_scheduling_*` |
| AES encryption key (file-backed AES backend) | `${XDG_CONFIG_HOME}/nanoclaw/encryption-key` |
| Global memory (read-only at container mount) | `data/global/` (mounted as `/workspace/global`, RO) |
| Host logs | `logs/nanoclaw.log`, `logs/nanoclaw.error.log` |
| Channel adapters and provider registries | host process memory (registered at import) |
| Mount allowlist | `data/v2.db` mount-security tables |
| Container-IP allocation | host process memory (`src/modules/container-ip/`) |
| Scope-invalidator registrations | host process memory (`src/modules/credentials/scope-invalidator.ts`) |
| Credential resolver registry | host process memory (`src/modules/credentials/resolver.ts`) — one entry per agent-group folder ever touched in this process |

**Container mount:** `data/global/` → `/workspace/global` (RO).
`src/container-runner.ts:351`.

**Who writes:** the host process. The central DB is single-writer
(host only). The encryption key is created once at install or first
write.

**Concrete:** OneCLI gateway runs as a separate process and owns the
real credential vault; NanoClaw stores only credential-substitute /
manifest metadata, never raw secrets, in its own files. The central
DB never sees plaintext secrets. See [SECURITY.md](SECURITY.md).

---

## Cross-reference: what lives at which scope

Quick lookup when you're not sure.

| Resource | Scope | Notes |
|---|---|---|
| Inbound message | per message | written to per-session DB |
| Conversation transcript (NanoClaw view) | per session | `messages_in/out` |
| Claude SDK JSONL transcript file | per session | filename = `sdk_session_id` |
| Claude SDK projects dir, settings, hooks index | per agent group | `.claude-shared/` |
| `CLAUDE.local.md` (agent memory) | per agent group | shared across sessions |
| Composed `CLAUDE.md` | per agent group | regenerated at spawn |
| Container config (`container.json`) | per agent group | |
| Credential store (encrypted files) | per agent group | resolver caches in memory |
| Credential resolver instance | per agent group | host process memory |
| Grant state (grantees, borrow source) | per agent group | filesystem |
| Messaging-group → agent-group wiring | per messaging group | `messaging_group_agents` |
| Channel adapter credentials | per messaging group (logically) | actual storage = OneCLI vault |
| Engage / sender / unknown-sender policy | per messaging group | row in `messaging_groups` |
| User roles (owner, admin) | per user; scoped admin is per (user, agent_group) | `user_roles` |
| Pending approval | global | survives container restarts |
| Mount allowlist | global | single-writer DB |
| Encryption key | global | one key for all credential files |
| Container heartbeat | per session | touch file |
| `sdk_session_id` continuation | per session | row in `outbound.db.session_state` |

## Rules of thumb when adding new state

1. **If a single message produces the data and the agent's reply is
   the final consumer, it's per message.** Belongs in `messages_in/out`
   or session inbox.
2. **If the data is the agent's view of a conversation, it's per
   session.** Goes in `outbound.db` (container writer) or `inbound.db`
   (host writer), never both.
3. **If two sessions of the same agent identity must see the same
   value, it's per agent group.** Goes under `groups/<folder>/` or in
   a host-process registry keyed by folder.
4. **If the data describes a chat surface (one channel), it's per
   messaging group.** Central DB row.
5. **If the data is host-level config or cross-agent state, it's
   global.** Central DB or `~/.config/nanoclaw/`.

Wrong-axis state is the usual source of "why are two threads seeing
each other's data" bugs — pick the smallest scope that satisfies the
sharing requirement, not larger.
