/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * Unwrap the text used for slash-command classification from an inbound
 * `content` payload. Chat adapters stamp `{ "text": "..." }`; a raw string
 * is also accepted.
 *
 * When the channel layer marked a leading bot-mention (`mentionPrefixEnd`,
 * set by the chat-sdk bridge from the bot's own platform identity — see
 * `leadingBotMentionEnd` there), the text is read FROM that offset. In a
 * group channel a user must @-mention the bot to engage it, and platforms
 * deliver that mention as a literal prefix — e.g. "@U0AKKG67T7X /auth"
 * (Slack), "<@123> /auth" (Discord), "@botname /auth" (Telegram). Without
 * skipping it the text never starts with '/', so every host/admin slash
 * command issued via mention in a group channel would slip past the gate
 * into the container.
 *
 * This is read-only: the stored `content` (what the container receives) is
 * never modified — we only classify against the post-mention slice.
 */
function classifiableText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    let text = typeof parsed.text === 'string' ? parsed.text : '';
    const end = typeof parsed.mentionPrefixEnd === 'number' ? parsed.mentionPrefixEnd : 0;
    if (end > 0 && end <= text.length) text = text.slice(end);
    return text.trim();
  } catch {
    return content.trim();
  }
}

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  const text = classifiableText(content);

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
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
