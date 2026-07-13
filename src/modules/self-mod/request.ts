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
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

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
