/**
 * `/auth` host command — credential (re)authentication trigger (C7o).
 *
 * A **pure trigger surface**: `/auth` starts the agent group's interactive
 * (re)authentication flow on demand, instead of waiting for the automatic
 * wake-time acquisition gate or a mid-session 401. Credential-*setting* verbs
 * (set-key / import / delete / list / status) live on the `/creds` surface.
 *
 *   - `/auth`          — (re)authenticate the channel's single engaged group.
 *   - `/auth <folder>` — disambiguate when the channel engages >1 agent group.
 *
 * Registered `scope: 'channel'` (one invocation; the handler enumerates the
 * engaged groups via the wirings — an agent-scope fan-out would produce N
 * replies + N−1 interaction-slot conflicts). The command gate cannot resolve
 * a group for a channel-scope command, so the `group-admin` check runs
 * **here**, against the resolved group (scoped admins work); the registry
 * `access` flag drives `/help` visibility only.
 *
 * The flow itself is owned by the provider's REAUTH extension (the same menu
 * the mid-session reauth dispatcher and wake-time gate use). On success the
 * group's containers restart so freshly-minted substitutes pick up the new
 * credential (substitutes are spawn-minted — v1 parity with `/auth`'s
 * `stopContainer: true`).
 */
import { isAdmin, type HostCommandContext } from '../../../command-gate.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import { resolveProviderName } from '../../../container-config.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { getMessagingGroupAgents } from '../../../db/messaging-groups.js';
import { BeginInteractionConflictError, type InteractionOrigin } from '../../../host-interactions.js';
import { log } from '../../../log.js';
import { asCredentialScope, getCredentialProvider, REAUTH } from '../../credentials/index.js';
import type { AgentGroup } from '../../../types.js';

export const AUTH_HELP = 'Re-authenticate the agent group — /auth [group-folder]';

/**
 * One concurrent `/auth` episode per (group folder, provider). A second
 * invocation while one is in flight replies "already in progress" rather
 * than opening a competing interaction. In-memory — a host restart clears it
 * (interaction slots are in-memory too), so the next `/auth` simply re-prompts.
 */
const inFlight = new Set<string>();

const RETRY_TEXT =
  "The group's agent credential was just re-authenticated. " +
  'If a recent user request in this conversation went unanswered because of an auth failure, ' +
  'fulfill it now; otherwise no action is needed.';

/** Resolve the credential-provider id for a group's agent runtime. */
function providerIdForGroup(group: AgentGroup): string {
  return resolveProviderName(undefined, getContainerConfig(group.id)?.provider);
}

export function handleAuthCommand(ctx: HostCommandContext): void {
  if (ctx.userId == null) {
    ctx.replyText('/auth requires an identifiable user.');
    return;
  }

  // Engaged agent groups for this channel (wirings).
  const wirings = getMessagingGroupAgents(ctx.messagingGroupId);
  const groups = wirings.map((w) => getAgentGroup(w.agent_group_id)).filter((g): g is AgentGroup => g != null);
  if (groups.length === 0) {
    ctx.replyText('No agent groups are wired to this channel.');
    return;
  }

  // Resolve the target group: explicit `/auth <folder>`, else the sole group.
  const wantFolder = ctx.args[0];
  let group: AgentGroup;
  if (wantFolder) {
    const match = groups.find((g) => g.folder === wantFolder);
    if (!match) {
      ctx.replyText(
        `No engaged agent group with folder *${wantFolder}*. ` +
          `This channel engages: ${groups.map((g) => `*${g.folder}*`).join(', ')}.`,
      );
      return;
    }
    group = match;
  } else if (groups.length > 1) {
    ctx.replyText(
      'This channel engages multiple agent groups. Specify one:\n' +
        groups.map((g) => `  /auth ${g.folder}`).join('\n'),
    );
    return;
  } else {
    group = groups[0];
  }

  // Group-admin gate against the resolved group (scoped admins qualify).
  if (!isAdmin(ctx.userId, group.id)) {
    ctx.replyText(`Permission denied — /auth requires admin of *${group.folder}*.`);
    return;
  }

  const providerId = providerIdForGroup(group);
  const provider = getCredentialProvider(providerId);
  const reauthExt = provider?.getExtension?.(REAUTH);
  if (!reauthExt) {
    ctx.replyText(`Provider *${providerId}* does not support interactive (re)authentication.`);
    return;
  }

  const dedupKey = `${group.folder}::${providerId}`;
  if (inFlight.has(dedupKey)) {
    ctx.replyText(`A (re)authentication for *${group.folder}* is already in progress.`);
    return;
  }

  const origin: InteractionOrigin = {
    key: {
      channelType: ctx.reply.channelType,
      platformId: ctx.reply.platformId,
      threadId: ctx.reply.threadId,
      userId: ctx.userId,
    },
    agentGroupId: group.id,
    messagingGroupId: ctx.messagingGroupId,
    replyAddr: ctx.reply,
    writeReply: ctx.replyText,
  };

  inFlight.add(dedupKey);
  log.info('Auth command: starting interactive (re)auth', { folder: group.folder, providerId, userId: ctx.userId });

  // Launch fire-and-forget: the provider opens its interaction slot
  // synchronously (before its first await), so the slot is active by the time
  // this handler returns — the router must NOT block on the minutes-long flow.
  let flow: Promise<boolean>;
  try {
    flow = reauthExt.reauth({
      origin,
      credentialScope: asCredentialScope(group.folder),
      classification: 'manual',
      reason: '',
    });
  } catch (err) {
    inFlight.delete(dedupKey);
    if (err instanceof BeginInteractionConflictError) {
      ctx.replyText('Another interactive flow is already active on this channel. Finish or cancel it first.');
    } else {
      log.error('Auth command: flow threw at launch', { dedupKey, err });
      ctx.replyText('Command failed.');
    }
    return;
  }

  void flow.then(
    (stored) => {
      inFlight.delete(dedupKey);
      if (stored) {
        restartAgentGroupContainers(group.id, 'manual /auth', RETRY_TEXT);
      }
    },
    (err) => {
      inFlight.delete(dedupKey);
      if (err instanceof BeginInteractionConflictError) {
        ctx.replyText('Another interactive flow is already active on this channel. Finish or cancel it first.');
        return;
      }
      log.error('Auth command: flow failed', { dedupKey, err });
    },
  );
}

/** Test hook — clears dedup state between cases. */
export function _resetAuthCommandForTests(): void {
  inFlight.clear();
}
