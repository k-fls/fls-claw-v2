/**
 * notifyUser — host→user push helper for SSH async events.
 *
 * v1 used `ContainerSessionContext.interactionQueue.push(...)` to surface
 * mid-session events (credential needed, TOFU pin, host-key mismatch) to
 * the requesting user. v2 has no equivalent host→container notification
 * queue; instead we resolve the agent group's approver (owner / admin /
 * scoped admin), open or reuse their DM messaging-group via `ensureUserDm`,
 * and deliver the text directly through the channel adapter via
 * `deliverDirect`. Best-effort: silently drops if no approver is reachable.
 */
import { log } from '../../log.js';
import { deliverDirect } from '../../delivery.js';
import { pickApprover } from '../approvals/primitive.js';
import { ensureUserDm } from '../permissions/user-dm.js';

export async function notifyUser(agentGroupId: string, text: string): Promise<void> {
  const approvers = pickApprover(agentGroupId);
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (!mg) continue;
    deliverDirect(mg.channel_type, mg.platform_id, null, text);
    return;
  }
  log.warn('ssh.notifyUser: no reachable approver', { agentGroupId });
}
