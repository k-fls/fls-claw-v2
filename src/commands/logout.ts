/**
 * `/logout` host command — forget a group's agent runtime and its credential.
 *
 * The inverse of the wake-time acquisition gate: `/creds delete <provider>` is
 * the surgical form, naming a provider and leaving the group's runtime choice
 * in place. `/logout` targets whatever runtime the group is on, clears the
 * choice as well, and stops the containers still holding live substitutes — so
 * the next message starts over at "which agent should I run as?".
 *
 * Group-admin, like every other credential-touching command on this surface.
 */
import { isAdmin, registerHostCommand, type HostCommandContext } from '../command-gate.js';
import { resolveProviderName } from '../container-config.js';
import { restartAgentGroupContainers } from '../container-restart.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { log } from '../log.js';
import { asCredentialScope, getOrCreateResolverForAgentGroup, listEntries } from '../modules/credentials/index.js';

export const LOGOUT_HELP = 'Sign the agent group out — forget its runtime choice and credential — /logout';

export function handleLogoutCommand(ctx: HostCommandContext): void {
  if (ctx.userId == null) {
    ctx.replyText('/logout requires an identifiable user.');
    return;
  }
  const group = ctx.agentGroupId ? getAgentGroup(ctx.agentGroupId) : null;
  if (!group) {
    ctx.replyText('/logout must be run in a channel with an engaged agent group.');
    return;
  }
  if (!isAdmin(ctx.userId, group.id)) {
    ctx.replyText(`Permission denied — /logout requires admin of *${group.folder}*.`);
    return;
  }

  const providerId = resolveProviderName(undefined, getContainerConfig(group.id)?.provider);
  const scope = asCredentialScope(group.folder);
  const removed = listEntries(scope, providerId).length;

  if (removed > 0) getOrCreateResolverForAgentGroup(scope).delete(scope, providerId);
  // Clearing the column is what makes the next message ask again; deleting the
  // credential alone would re-run the same provider's sign-in.
  updateContainerConfigScalars(group.id, { provider: null });
  // Substitutes are minted at spawn, so a container already running keeps a
  // working one until it is replaced. No wake message: the point is to stop,
  // not to come back on a runtime that no longer has a credential.
  restartAgentGroupContainers(group.id, 'manual /logout');

  log.info('Logout command: group signed out', { folder: group.folder, providerId, removed });
  ctx.replyText(
    `Signed *${group.folder}* out of *${providerId}*` +
      (removed > 0 ? ` (${removed} entr${removed !== 1 ? 'ies' : 'y'} removed).` : ' (nothing was stored).') +
      '\nSend another message when you want to pick an agent and sign in again.',
  );
}

registerHostCommand('/logout', handleLogoutCommand, {
  scope: 'agent',
  access: 'group-admin',
  help: LOGOUT_HELP,
});
