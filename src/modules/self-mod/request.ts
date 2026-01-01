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

const INVISIBLE_RE =
  /[\u202a\u202e\u2066\u2069\u200e\u200f\u061c\u200b\u200c\u200d\u2060\ufeff\u2028\u2029\u0060]/g;

export function escapeInvisibles(s: string): string {
  return s.replace(INVISIBLE_RE, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

const SECRET_KEY_RE = /(_TOKEN|_SECRET|_PASSWORD|_PASS|_KEY|_CREDENTIAL|_AUTH)$/i;
const SECRET_VALUE_PREFIXES = ['sk-', 'ghp_', 'glpat-', 'xoxb-', 'xoxp-'];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || /^(TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH)$/i.test(key);
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PREFIXES.some((p) => value.startsWith(p));
}

function redact(value: string): string {
  const byteLen = Buffer.byteLength(value, 'utf8');
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${byteLen} bytes, sha256 ${digest}>`;
}

function renderValue(s: string): string {
  return escapeInvisibles(s.replace(/\n/g, '\\n'));
}

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }

  const serverName = content.name as string;
  const command = content.command as string;
  if (!serverName || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return;
  }

  const rawArgs = content.args;
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs)) {
      notifyAgent(session, 'add_mcp_server failed: args must be an array of strings.');
      return;
    }
    const bad = (rawArgs as unknown[]).find((a) => typeof a !== 'string');
    if (bad !== undefined) {
      notifyAgent(session, 'add_mcp_server failed: each arg must be a string.');
      return;
    }
  }

  const rawEnv = content.env;
  if (rawEnv !== undefined) {
    if (Array.isArray(rawEnv) || typeof rawEnv !== 'object' || rawEnv === null) {
      notifyAgent(session, 'add_mcp_server failed: env must be a record of strings.');
      return;
    }
  }

  const args: string[] = (rawArgs as string[] | undefined) ?? [];
  const env: Record<string, string> = (rawEnv as Record<string, string> | undefined) ?? {};

  if (args.length > 32) {
    notifyAgent(session, 'add_mcp_server failed: max 32 args per request.');
    return;
  }
  if (Object.keys(env).length > 32) {
    notifyAgent(session, 'add_mcp_server failed: max 32 env vars per request.');
    return;
  }

  const payload = { name: serverName, command, args, env };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16384) {
    notifyAgent(session, 'add_mcp_server failed: payload exceeds 16384 bytes.');
    return;
  }

  const argsStr = `[${args.map((a) => (isSecretValue(a) ? redact(a) : renderValue(a))).join(', ')}]`;
  const envStr = `{${Object.entries(env)
    .map(([k, v]) => `${renderValue(k)}: ${isSecretKey(k) || isSecretValue(v) ? redact(v) : renderValue(v)}`)
    .join(', ')}}`;

  const question =
    `Agent "${agentGroup.name}" wants to add an MCP server:\n` +
    `\`\`\`\n` +
    `name: ${renderValue(serverName)}\n` +
    `command: ${renderValue(command)}\n` +
    `args: ${argsStr}\n` +
    `env: ${envStr}\n` +
    `\`\`\``;

  if (Buffer.byteLength(question, 'utf8') > 1500) {
    notifyAgent(session, 'add_mcp_server failed: approval card exceeds 1500 bytes.');
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload,
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
