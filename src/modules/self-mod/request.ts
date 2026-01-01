/**
 * Validation + hold-request builders for agent-initiated self-modification.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. The delivery registry wraps
 * each one with the guard (see ./guard.ts — unconditional hold from the
 * container path): validation here runs as the wrapper's precheck, and the
 * hold builders create the approval card when the guard holds. On approve,
 * the continuation re-enters the wrapped action and ./apply.ts runs.
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { createHash } from 'node:crypto';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

// Escapes bidi controls, zero-width chars, BOM, line/para separators,
// and backticks (which would break a code fence) to \uXXXX sequences.
// Uses explicit \uXXXX escapes to avoid literal line-separator chars in source.
const ESCAPE_RE = /[\u0060\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060\u2066-\u2069\ufeff]/g;

export function escapeInvisibles(str: string): string {
  return str.replace(ESCAPE_RE, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

const SECRET_KEY_RE = /token|secret|key|pass(?:word)?|auth|credential/i;
const SECRET_VALUE_PREFIXES = ['sk-', 'ghp_', 'ghr_', 'ghs_', 'ghu_', 'github_pat_', 'xoxb-', 'xoxp-'];

function redactIfSecret(value: string, envKey?: string): string {
  const isByKey = envKey !== undefined && SECRET_KEY_RE.test(envKey);
  const isByValue = SECRET_VALUE_PREFIXES.some((p) => value.startsWith(p));
  if (!isByKey && !isByValue) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
}

const MAX_ARGS = 32;
const MAX_ENV_VARS = 32;
const MAX_PAYLOAD_BYTES = 16384;
const MAX_CARD_BYTES = 1500;

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }

  const name = content.name as string;
  const command = content.command as string;
  if (!name || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return;
  }

  const rawArgs = content.args ?? [];
  if (!Array.isArray(rawArgs)) {
    notifyAgent(session, 'add_mcp_server failed: args must be an array of strings.');
    return;
  }
  for (const a of rawArgs) {
    if (typeof a !== 'string') {
      notifyAgent(session, 'add_mcp_server failed: each element of args must be a string.');
      return;
    }
  }
  if (rawArgs.length > MAX_ARGS) {
    notifyAgent(session, `add_mcp_server failed: max ${MAX_ARGS} args allowed.`);
    return;
  }
  const args = rawArgs as string[];

  const rawEnv = content.env ?? {};
  if (typeof rawEnv !== 'object' || Array.isArray(rawEnv) || rawEnv === null) {
    notifyAgent(session, 'add_mcp_server failed: env must be a record of strings.');
    return;
  }
  const envEntries = Object.entries(rawEnv as Record<string, unknown>);
  for (const [, v] of envEntries) {
    if (typeof v !== 'string') {
      notifyAgent(session, 'add_mcp_server failed: env values must be strings.');
      return;
    }
  }
  if (envEntries.length > MAX_ENV_VARS) {
    notifyAgent(session, `add_mcp_server failed: max ${MAX_ENV_VARS} env vars allowed.`);
    return;
  }
  const env = rawEnv as Record<string, string>;

  const payloadRaw = { name, command, args, env };
  const payloadStr = JSON.stringify(payloadRaw);
  if (Buffer.byteLength(payloadStr, 'utf8') > MAX_PAYLOAD_BYTES) {
    notifyAgent(session, `add_mcp_server failed: payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
    return;
  }

  // Build the card question with secret redaction + invisible escaping.
  const cardArgs = args.map((a) => redactIfSecret(a));
  const cardEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    cardEnv[k] = redactIfSecret(v, k);
  }
  const argsLine = escapeInvisibles(JSON.stringify(cardArgs));
  const envLine = escapeInvisibles(JSON.stringify(cardEnv));
  const question =
    `add_mcp_server: ${name} (${command})\n\`\`\`\nname: ${name}\ncommand: ${command}\nargs: ${argsLine}\nenv: ${envLine}\n\`\`\``;

  if (Buffer.byteLength(question, 'utf8') > MAX_CARD_BYTES) {
    notifyAgent(session, `add_mcp_server failed: approval card exceeds ${MAX_CARD_BYTES} bytes.`);
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: payloadRaw,
    title: 'Add MCP Server Request',
    question,
  });
}

export function validateInstallPackages(content: Record<string, unknown>, session: Session): boolean {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return false;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return false;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return false;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return false;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return false;
  }
  return true;
}

export async function requestInstallPackagesHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}

export function validateAddMcpServer(content: Record<string, unknown>, session: Session): boolean {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return false;
  }
  const serverName = content.name as string;
  const command = content.command as string;
  if (!serverName || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return false;
  }
  return true;
}

export async function requestAddMcpServerHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const serverName = content.name as string;
  const command = content.command as string;
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: {
      name: serverName,
      command,
      args: (content.args as string[]) || [],
      env: (content.env as Record<string, string>) || {},
    },
    title: 'Add MCP Request',
    question: `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n${serverName} (${command})`,
  });
}
