/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Registered host commands: handled by a host-side module; the
 *   container never sees the message (`handle` action)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 *
 * Modules register host commands at import time via
 * `registerHostCommand`. A built-in `/help` handler is auto-registered
 * here; it composes a reply from registered host commands plus a
 * static table of known container-side commands.
 */
import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';
import { deliverDirect } from './delivery.js';
import type { DeliveryAddress } from './channels/adapter.js';
import {
  beginInteraction as beginInteractionImpl,
  type BeginInteractionOptions,
  type HostInteractionKey,
} from './host-interactions.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'handle'; command: string; handler: HostCommandHandler };

const FILTERED_COMMANDS = new Set(['/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * One-line descriptions for well-known container-side slash commands.
 * Used by the `/help` host handler to surface what the container will
 * respond to. Static because the host can't introspect container state;
 * if Claude Code adds a new built-in, add a line here.
 */
const CONTAINER_HELP: ReadonlyMap<string, string> = new Map([
  ['/clear', 'Clear the conversation context'],
  ['/compact', 'Compact the conversation history'],
  ['/context', 'Show context window usage'],
  ['/cost', 'Show token cost for the session'],
  ['/files', 'List files in the session workspace'],
]);

// ── Host command registry ──

/**
 * Where a host command's effect lives. Drives router dispatch:
 *
 *   - 'agent'   (default): dispatched per engaging agent. The command
 *                operates on agent-owned state (credentials, grants,
 *                per-agent settings). `agentGroupId` is set.
 *   - 'channel': dispatched once per inbound message, before fan-out.
 *                The command operates on channel state or is purely
 *                informational. `agentGroupId` is null.
 *   - 'host':    dispatched once per inbound message, before fan-out.
 *                The command affects host-process state shared across
 *                all agents. `agentGroupId` is null. Today behaves
 *                identically to 'channel' on the routing path —
 *                semantic distinction only.
 */
export type HostCommandScope = 'agent' | 'channel' | 'host';

/**
 * Privilege required to invoke a host command (and to see it in `/help`).
 *
 *   - 'any'          (default): any identifiable user.
 *   - 'group-admin':  owner, global admin, or admin scoped to the target
 *                     agent group. Gate-enforced for 'agent'-scope commands
 *                     (the per-agent classifier knows the group). For
 *                     'channel'/'host'-scope commands the gate cannot know
 *                     the group — the handler resolves it itself (e.g.
 *                     `/auth <scope>`) and must check
 *                     `isAdmin(userId, resolvedGroupId)`; the flag then
 *                     drives `/help` visibility only (evaluated as
 *                     "admin of any group").
 *   - 'global-admin': owner or global admin only — scoped-admin rows do
 *                     not qualify (e.g. `/tap`, which exposes cross-group
 *                     proxy traffic). Gate-enforced at both classifier
 *                     tiers.
 */
export type HostCommandAccess = 'any' | 'group-admin' | 'global-admin';

export interface HostCommandContext {
  /** The slash-command word as the user typed it, lowercased (e.g. "/auth"). */
  command: string;
  /** Everything after the command word, untrimmed. */
  argsRaw: string;
  /** Whitespace-split tokens from argsRaw. No quoting / escape parsing. */
  args: string[];
  /** User who issued the command. Null only for adapter events with no sender; the gate denies those before dispatch, so handlers always see a non-null value. */
  userId: string | null;
  /** Agent group the command was dispatched against. Non-null for 'agent' scope; null for 'channel' / 'host' scope. */
  agentGroupId: string | null;
  /** Messaging group (channel) of the originating event. */
  messagingGroupId: string;
  /** Scope under which this dispatch happened. Lets handlers branch if they support multiple scopes. */
  scope: HostCommandScope;
  /** Channel address to reply to (mirrors router's deliveryAddr). */
  reply: DeliveryAddress;
  /** Convenience: write a chat reply directly to messages_out at `reply`. */
  replyText(text: string): void;
  /**
   * Begin a host interaction bound to (reply.channelType, reply.platformId,
   * reply.threadId, userId). After this handler returns, the user's next
   * messages on this key are routed to `opts.handler` instead of the
   * classifier / container until the handler calls finish/cancel or the
   * timeout fires. Throws BeginInteractionConflictError if a slot is
   * already active for the key (unless `opts.mode === 'replace'`).
   */
  beginInteraction(opts: BeginInteractionOptions): void;
}

export type HostCommandHandler = (ctx: HostCommandContext) => void | Promise<void>;

interface HostCommandEntry {
  handler: HostCommandHandler;
  scope: HostCommandScope;
  access: HostCommandAccess;
  help?: string;
}

export interface RegisterHostCommandOptions {
  /** One-line description shown by `/help`. Omit to hide from help output. */
  help?: string;
  /** Where the command's effect lives. Default: 'agent'. See HostCommandScope. */
  scope?: HostCommandScope;
  /** Privilege required to invoke (and list in `/help`). Default: 'any'. See HostCommandAccess. */
  access?: HostCommandAccess;
}

const hostCommands = new Map<string, HostCommandEntry>();

/**
 * Register a host-side slash command handler.
 *
 * `prefix` MUST start with '/'. Comparison is case-insensitive on the
 * first whitespace-delimited token of the inbound message. Re-registering
 * an existing prefix logs a warning and overwrites.
 *
 * Handlers run from the router's perspective (it awaits them) and must
 * NOT call into the container or write to the session inbound; they
 * reply via `ctx.replyText` which routes to messages_out.
 */
export function registerHostCommand(
  prefix: string,
  handler: HostCommandHandler,
  options: RegisterHostCommandOptions = {},
): void {
  if (!prefix.startsWith('/')) {
    throw new Error(`registerHostCommand: prefix must start with '/' (got "${prefix}")`);
  }
  const key = prefix.toLowerCase();
  if (hostCommands.has(key)) {
    log.warn('Host command re-registered (overwriting)', { prefix: key });
  }
  hostCommands.set(key, {
    handler,
    scope: options.scope ?? 'agent',
    access: options.access ?? 'any',
    help: options.help,
  });
}

/** Look up the scope of a registered host command. Returns undefined if unregistered. */
export function getHostCommandScope(prefix: string): HostCommandScope | undefined {
  return hostCommands.get(prefix.toLowerCase())?.scope;
}

/** Look up the access level of a registered host command. Returns undefined if unregistered. */
export function getHostCommandAccess(prefix: string): HostCommandAccess | undefined {
  return hostCommands.get(prefix.toLowerCase())?.access;
}

/** List registered host-command prefixes (lowercased). */
export function getRegisteredHostCommands(): readonly string[] {
  return Array.from(hostCommands.keys());
}

/**
 * Test-only: clear all host-command registrations and re-register the
 * built-in `/help` handler. Intended for `beforeEach` so test order
 * doesn't matter and prefix reuse between cases is safe.
 */
export function _resetHostCommandsForTesting(): void {
  hostCommands.clear();
  registerBuiltinHelp();
}

// ── Slash-command parsing ──

export interface ParsedSlashCommand {
  /** Lowercased command word, e.g. "/auth". */
  command: string;
  /** Everything after the command word, untrimmed. */
  argsRaw: string;
  /** Whitespace-split argsRaw. */
  args: string[];
}

/**
 * Extract the slash-command word and arguments from a message `content`
 * payload. Mirrors the JSON-text unwrap used elsewhere: chat adapters
 * stamp `{"text": "..."}`; raw strings are also accepted. Returns `null`
 * when the content doesn't begin with a slash command.
 *
 * No quoting / escape parsing — `args` is a plain whitespace split.
 */
export function parseSlashCommand(content: string): ParsedSlashCommand | null {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return null;

  const match = text.match(/^(\S+)(\s*)([\s\S]*)$/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argsRaw = match[3];
  const args =
    argsRaw.length === 0
      ? []
      : argsRaw
          .trim()
          .split(/\s+/)
          .filter((s) => s.length > 0);
  return { command, argsRaw, args };
}

// ── Classifier ──

/**
 * Per-agent classifier (called from inside fan-out). Only matches
 * 'agent'-scope host commands; 'channel' / 'host' scope are caught
 * pre-fanout via `classifyAtMessagingGroup` and must not be reclassified
 * per-agent.
 *
 * Precedence (highest first):
 *   1. Not a slash command → pass
 *   2. FILTERED_COMMANDS → filter (defensive — also caught pre-fanout)
 *   3. Registered 'agent'-scope host command → handle (or deny if anonymous
 *      or the caller fails the command's declared `access` level)
 *   4. ADMIN_COMMANDS → pass (admin) / deny (non-admin)
 *   5. Default → pass (covers non-agent-scope host commands too — they were
 *      handled pre-fanout, the per-agent path ignores them)
 *
 * Host registrations take precedence over ADMIN_COMMANDS by design: a
 * module that wants to claim a built-in admin prefix can do so without
 * the built-in classification silently shadowing it.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  const parsed = parseSlashCommand(content);
  if (!parsed) return { action: 'pass' };

  const command = parsed.command;

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  const entry = hostCommands.get(command);
  if (entry && entry.scope === 'agent') {
    if (userId == null) return { action: 'deny', command };
    if (!passesCommandAccess(entry.access, userId, agentGroupId)) return { action: 'deny', command };
    return { action: 'handle', command, handler: entry.handler };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  return { action: 'pass' };
}

/**
 * Check whether `userId` has owner or admin role.
 *
 * - With `agentGroupId`: matches scoped-admin rows for that group OR
 *   any global owner/admin row (`agent_group_id IS NULL`).
 * - Without `agentGroupId`: matches only global owner/admin rows.
 *   Use this form for messaging-group-scoped commands where there's
 *   no canonical agent.
 *
 * Returns false for null userId. If the permissions module isn't
 * installed (no `user_roles` table), returns true — same allow-all
 * degradation as the rest of the host.
 */
export function isAdmin(userId: string | null, agentGroupId?: string | null): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  if (agentGroupId == null) {
    const row = db
      .prepare(
        `SELECT 1 FROM user_roles
         WHERE user_id = ?
           AND (role = 'owner' OR role = 'admin')
           AND agent_group_id IS NULL
         LIMIT 1`,
      )
      .get(userId);
    return row != null;
  }
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}

/**
 * True when `userId` holds any owner/admin row at all (global or scoped
 * to any agent group). Used where a 'group-admin' requirement must be
 * evaluated with no resolvable group — `/help` visibility at
 * messaging-group level. Same allow-all degradation as `isAdmin` when
 * the permissions module isn't installed.
 */
export function hasAnyAdminRole(userId: string | null): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const row = getDb()
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
       LIMIT 1`,
    )
    .get(userId);
  return row != null;
}

/**
 * Does `userId` clear a command's declared access level? With a null
 * `agentGroupId` (no group resolvable in the calling context),
 * 'group-admin' falls back to "admin of any group".
 */
function passesCommandAccess(access: HostCommandAccess, userId: string | null, agentGroupId: string | null): boolean {
  if (access === 'any') return true;
  if (access === 'global-admin') return isAdmin(userId);
  return agentGroupId != null ? isAdmin(userId, agentGroupId) : hasAnyAdminRole(userId);
}

// ── Dispatch ──

/** Narrowed alias for the `handle` GateResult variant. */
export type HandleGateResult = Extract<GateResult, { action: 'handle' }>;

export interface HostCommandDispatchParams {
  /** Raw inbound content (chat JSON or plain text). */
  content: string;
  /** Authenticated caller (non-null at this point — gate denies anonymous). */
  userId: string | null;
  /** Messaging group (channel) the command originated in. */
  messagingGroupId: string;
  /** Session id used for the outbound reply write. */
  sessionId: string;
  /** Agent group of the session that holds the outbound DB. For 'agent' scope this is the target agent; for 'channel' / 'host' scope it's a delivery anchor only. */
  anchorAgentGroupId: string;
  /** Dispatch scope. Determines what `agentGroupId` the handler sees. */
  scope: HostCommandScope;
  /** Channel address to reply to (router's effective deliveryAddr). */
  reply: DeliveryAddress;
}

/**
 * Run a `handle` GateResult to completion: build the handler context,
 * invoke the handler, write the reply to the session's outbound DB, and
 * convert exceptions into a generic `"Command failed."` reply.
 *
 * Owns the host-command call shape so the router doesn't have to:
 * argument parsing, reply-id minting, error containment, and the
 * outbound write all live here.
 */
export async function dispatchHostCommand(gate: HandleGateResult, params: HostCommandDispatchParams): Promise<void> {
  const parsed = parseSlashCommand(params.content);
  const argsRaw = parsed?.argsRaw ?? '';
  const args = parsed?.args ?? [];

  // Host-command and interaction replies bypass messages_out: they
  // call the channel adapter directly via deliverDirect. This keeps
  // sensitive flow content out of the per-session DBs and avoids the
  // 1s/60s polling latency on channel/host-scope sessions that may
  // never have a running container. Same writer for both — the only
  // difference between a one-shot replyText and an interaction reply
  // was persistence-flavoured, and now neither persists.
  const writeReply = (text: string): void => {
    deliverDirect(params.reply.channelType, params.reply.platformId, params.reply.threadId, text);
  };
  const replyText = writeReply;
  const writeInteractionReply = writeReply;

  const handlerAgentGroupId = params.scope === 'agent' ? params.anchorAgentGroupId : null;
  const beginInteraction = (opts: BeginInteractionOptions): void => {
    const key: HostInteractionKey = {
      channelType: params.reply.channelType,
      platformId: params.reply.platformId,
      threadId: params.reply.threadId,
      userId: params.userId,
    };
    beginInteractionImpl(key, handlerAgentGroupId, params.messagingGroupId, params.reply, writeInteractionReply, opts);
  };

  try {
    await gate.handler({
      command: gate.command,
      argsRaw,
      args,
      userId: params.userId,
      agentGroupId: handlerAgentGroupId,
      messagingGroupId: params.messagingGroupId,
      scope: params.scope,
      reply: params.reply,
      replyText,
      beginInteraction,
    });
    log.info('Host command handled', {
      command: gate.command,
      scope: params.scope,
      userId: params.userId,
      messagingGroupId: params.messagingGroupId,
      agentGroupId: handlerAgentGroupId,
    });
  } catch (err) {
    log.error('Host command handler threw', { command: gate.command, err });
    replyText('Command failed.');
  }
}

/**
 * Result of pre-fanout classification (messaging-group level).
 *
 *   - `none`: no pre-fanout action — caller proceeds with normal
 *     per-agent fan-out (where 'agent'-scope host commands and
 *     ADMIN_COMMANDS are handled).
 *   - `filter`: drop the message; do not fan out.
 *   - `handle`: dispatch a 'channel' or 'host'-scope command once.
 *     Caller resolves an anchor session and invokes `dispatchHostCommand`.
 *   - `deny`: 'channel' or 'host'-scope command invoked anonymously, or
 *     by a caller failing a 'global-admin' access level; deliver a
 *     permission-denied reply via the anchor session and do not fan out.
 *
 * 'agent'-scope host commands and ADMIN_COMMANDS are NOT classified
 * here — they fall through to per-agent fan-out.
 */
export type MessagingGroupGateResult =
  | { action: 'none' }
  | { action: 'filter' }
  | { action: 'handle'; command: string; handler: HostCommandHandler; scope: HostCommandScope }
  | { action: 'deny'; command: string };

/**
 * Classify an inbound message at messaging-group scope (before per-agent
 * fan-out). Returns the actions a host can act on without choosing an
 * agent.
 *
 * For `handle` and `deny`, the caller must still resolve an anchor
 * session — see `dispatchHostCommand` / `writeOutboundDirect`.
 */
export function classifyAtMessagingGroup(content: string, userId: string | null): MessagingGroupGateResult {
  const parsed = parseSlashCommand(content);
  if (!parsed) return { action: 'none' };

  const command = parsed.command;

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  const entry = hostCommands.get(command);
  if (entry && entry.scope !== 'agent') {
    if (userId == null) return { action: 'deny', command };
    // 'global-admin' is enforceable here (no group needed). 'group-admin'
    // is NOT: the handler resolves the target group itself (e.g.
    // `/auth <scope>`) and owns the isAdmin(userId, group) check.
    if (entry.access === 'global-admin' && !isAdmin(userId)) {
      return { action: 'deny', command };
    }
    return { action: 'handle', command, handler: entry.handler, scope: entry.scope };
  }

  return { action: 'none' };
}

// ── Built-in /help handler ──

function formatHelpEntry(prefix: string, help: string | undefined): string {
  const desc = help && help.length > 0 ? help : '(no description)';
  return `  ${prefix.padEnd(16)} ${desc}`;
}

function buildHelpOverview(userId: string | null): string {
  const lines: string[] = ['Available commands:', ''];

  const hostLines: string[] = [];
  for (const [prefix, entry] of hostCommands) {
    if (!entry.help) continue;
    // Role-aware listing: a command is shown only to callers who clear its
    // declared access level. No group is resolvable at /help's channel
    // scope, so 'group-admin' is evaluated as "admin of any group".
    if (!passesCommandAccess(entry.access, userId, null)) continue;
    hostLines.push(formatHelpEntry(prefix, entry.help));
  }
  if (hostLines.length > 0) {
    lines.push('Host commands:');
    hostLines.sort();
    lines.push(...hostLines);
    lines.push('');
  }

  const containerLines: string[] = [];
  for (const [prefix, help] of CONTAINER_HELP) {
    containerLines.push(formatHelpEntry(prefix, help));
  }
  if (containerLines.length > 0) {
    lines.push('Container commands:');
    containerLines.sort();
    lines.push(...containerLines);
  }

  return lines.join('\n').trimEnd();
}

function lookupHelpFor(rawArg: string, userId: string | null): string | null {
  const normalized = (rawArg.startsWith('/') ? rawArg : `/${rawArg}`).toLowerCase();
  const host = hostCommands.get(normalized);
  // Commands the caller can't access are reported as unknown, matching
  // their absence from the overview.
  if (host && host.help && passesCommandAccess(host.access, userId, null)) {
    return `${normalized} — ${host.help}`;
  }
  const container = CONTAINER_HELP.get(normalized);
  if (container) return `${normalized} — ${container}`;
  return null;
}

function registerBuiltinHelp(): void {
  registerHostCommand(
    '/help',
    (ctx) => {
      if (ctx.args.length === 0) {
        ctx.replyText(buildHelpOverview(ctx.userId));
        return;
      }
      const hit = lookupHelpFor(ctx.args[0], ctx.userId);
      ctx.replyText(hit ?? `Unknown command: ${ctx.args[0]}`);
    },
    {
      help: 'Show available commands (use `/help <command>` for details)',
      scope: 'channel',
    },
  );
}

registerBuiltinHelp();
