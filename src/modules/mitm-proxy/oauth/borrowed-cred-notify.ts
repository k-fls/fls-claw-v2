/**
 * Host implementation of `BorrowedCredentialEvents` — alerts a grantor's
 * owners when a *borrowed* credential can no longer be refreshed (the grantor's
 * stored credential is expired/revoked, so every borrower is now failing and
 * only the grantor can fix it).
 *
 * Spam control mirrors the existing per-episode guards (`reauth-dispatcher`'s
 * in-flight set, `auth-bridge`'s `urlPrompted`): a credential is alerted **once
 * per expiry episode**, keyed by `${owningScope}::${providerId}`, and the entry
 * is cleared the moment the credential heals (`onCredentialHealed`, fired on any
 * successful refresh or re-auth for that scope) so a later expiry alerts again.
 * A 24h backstop re-alerts if a broken credential is never healed. State is
 * in-memory — a host restart drops it, costing at most one extra notice.
 *
 * Recipient resolution reuses the approvals primitive: the grantor group's
 * scoped admins → global admins → owners, delivered to the first reachable DM.
 * When nobody has a DM, it falls back to the grantor group's own chat channel.
 */
import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../../db/messaging-groups.js';
import { deliverDirect } from '../../../delivery.js';
import { log } from '../../../log.js';
import { pickApprover, pickApprovalDelivery } from '../../approvals/primitive.js';

import type { BorrowedCredentialEvents } from './handler-context.js';

/** Re-alert a still-broken credential at most this often (backstop). */
const NOTIFY_BACKSTOP_MS = 24 * 60 * 60 * 1000;

/** `${owningScope}::${providerId}` → ms timestamp of the last alert sent. */
const notified = new Map<string, number>();

function key(owningScope: string, providerId: string): string {
  return `${owningScope}::${providerId}`;
}

function expiredMessage(owningFolder: string, providerId: string): string {
  return (
    `⚠️ The *${providerId}* credential owned by this group (*${owningFolder}*) has expired and ` +
    `could not be refreshed automatically. Groups borrowing it are now failing to authenticate. ` +
    `Please re-authenticate in this group's chat — run \`/auth\`, or \`/creds set-key ${providerId}\`.`
  );
}

async function deliverExpiredNotice(owningFolder: string, providerId: string): Promise<void> {
  const grantor = getAgentGroupByFolder(owningFolder);
  if (!grantor) {
    log.warn('borrowed-cred-notify: grantor group not found for scope', { owningFolder, providerId });
    return;
  }
  const text = expiredMessage(owningFolder, providerId);

  // Preferred: DM the grantor's owners/admins (admins@group → global admins → owners).
  const approvers = pickApprover(grantor.id);
  const target = await pickApprovalDelivery(approvers, '');
  if (target) {
    deliverDirect(target.messagingGroup.channel_type, target.messagingGroup.platform_id, null, text);
    log.info('borrowed-cred-notify: alerted grantor owner', { owningFolder, providerId, userId: target.userId });
    return;
  }

  // Fallback: post to the grantor group's own chat channel.
  const channels = getMessagingGroupsByAgentGroup(grantor.id);
  if (channels.length > 0) {
    const mg = channels[0];
    deliverDirect(mg.channel_type, mg.platform_id, null, text);
    log.info('borrowed-cred-notify: alerted grantor channel (no owner DM reachable)', {
      owningFolder,
      providerId,
      messagingGroupId: mg.id,
    });
    return;
  }

  log.warn('borrowed-cred-notify: no owner DM or channel to alert', { owningFolder, providerId });
}

export const borrowedCredentialNotifier: BorrowedCredentialEvents = {
  onBorrowedRefreshFailed({ owningScope, providerId }) {
    const k = key(owningScope, providerId);
    const last = notified.get(k);
    if (last !== undefined && Date.now() - last < NOTIFY_BACKSTOP_MS) {
      // Already alerted this episode (and not yet healed) — suppress.
      return;
    }
    notified.set(k, Date.now());
    void deliverExpiredNotice(owningScope, providerId).catch((err) =>
      log.error('borrowed-cred-notify: delivery failed', { owningScope, providerId, err }),
    );
  },

  onCredentialHealed({ credentialScope, providerId }) {
    notified.delete(key(credentialScope, providerId));
  },
};

/** Test hook — clear the per-episode notify state between cases. */
export function _resetBorrowedCredNotifyForTests(): void {
  notified.clear();
}
