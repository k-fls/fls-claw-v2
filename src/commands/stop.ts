/**
 * `/stop` host command (B1a) — stop the running agent for a group from chat.
 *
 * The fork shipped `/stop` as a `commands/builtins.ts` builtin that set
 * `stopContainer: true`. v2 has the mechanism (`killContainer`) but no
 * user-facing chat command; this re-registers it as an `agent`-scope host
 * command. Kills every running container for the invoking agent group with no
 * respawn — the agent comes back on the next user message.
 *
 * Admin-gated (`access: 'group-admin'`): stopping another user's in-flight
 * agent is a privileged action.
 */
import { registerHostCommand, type HostCommandContext } from '../command-gate.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { log } from '../log.js';

export const STOP_HELP = 'Stop the running agent for this group';

export function handleStopCommand(ctx: HostCommandContext): void {
  if (!ctx.agentGroupId) {
    ctx.replyText('/stop must be invoked against an agent group.');
    return;
  }

  const running = getSessionsByAgentGroup(ctx.agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );
  if (running.length === 0) {
    ctx.replyText('No agent running.');
    return;
  }

  for (const session of running) killContainer(session.id, 'user /stop');
  log.info('Stop command: killed running containers', { agentGroupId: ctx.agentGroupId, count: running.length });
  ctx.replyText('Stopping agent.');
}

registerHostCommand('/stop', handleStopCommand, { scope: 'agent', access: 'group-admin', help: STOP_HELP });
