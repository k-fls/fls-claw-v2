/**
 * `/agent-runtime` host command — manage the agent runtime's CLI version
 * without an image rebuild (inventory F2; generalizes the fork's claude-only
 * `/claude-version`).
 *
 *   - `/agent-runtime [group]`                — show runtime CLI status.
 *   - `/agent-runtime [group] select <v|latest>` — point the group at a fetched
 *                                               version (group-admin).
 *   - `/agent-runtime fetch <v|latest>`       — install a version into the
 *                                               shared store (global-admin).
 *   - `/agent-runtime auto <duration|off>`    — periodic latest fetch
 *                                               (global-admin).
 *
 * Two access tiers, by design:
 *   - **select** changes one group's choice among *already-fetched* versions —
 *     a group-config edit, so group-admin of the resolved group. The selection
 *     rides the provider identity string (`provider = claude:<version>`); a
 *     bare `claude` means the image-baked default.
 *   - **fetch / auto** install CLI versions into a host store shared by every
 *     group on the provider and run `npm install` (supply-chain-sensitive), so
 *     global-admin only — a per-group admin must not drive a host-wide install.
 *
 * Registered `scope: 'channel'` (one invocation; the handler enumerates engaged
 * groups via the wirings) with `access: 'group-admin'` for `/help` visibility.
 * The gate cannot resolve a group for a channel-scope command, so every
 * privilege check runs here: group-admin against the resolved group for
 * status/select, global-admin for fetch/auto.
 *
 * Fetches run in the background (multi-minute `npm install`): the handler acks
 * immediately and reports the result via a later `replyText`. A version change
 * applies to subsequently-spawned containers; running containers keep their CLI
 * until they respawn.
 */
import { isAdmin, registerHostCommand, type HostCommandContext } from '../command-gate.js';
import { parseProviderSpec, resolveProviderName } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { getMessagingGroupAgents } from '../db/messaging-groups.js';
import {
  canRemoveVersion,
  getRuntimeUpdateManager,
  parseRuntimeUpdate,
  type RuntimeUpdateManager,
} from '../modules/runtime-updater/index.js';
import type { AgentGroup } from '../types.js';

export const AGENT_RUNTIME_HELP =
  'Manage the agent CLI version — /agent-runtime [group] [select <v|latest> | fetch <v|latest> | remove <v> | auto <duration|off>]';

const USAGE =
  'Usage: /agent-runtime [group] [select <version|latest> | fetch <version|latest> | remove <version> | auto <duration|off>]';

/** Tokens that begin a verb (so a leading non-verb token is a group folder). */
const VERBS = new Set(['select', 'fetch', 'remove', 'auto']);

/** Provider id backing a group's agent runtime (version suffix stripped). */
function providerIdForGroup(group: AgentGroup): string {
  return resolveProviderName(undefined, getContainerConfig(group.id)?.provider);
}

/** The group's currently-selected CLI version (or undefined = image-baked default). */
function selectedVersion(group: AgentGroup): string | undefined {
  const provider = getContainerConfig(group.id)?.provider;
  return provider ? parseProviderSpec(provider).version : undefined;
}

function formatStatus(group: AgentGroup, manager: RuntimeUpdateManager): string {
  const fetched = manager.updater.installedVersions();
  const selection = selectedVersion(group);
  return [
    `*${manager.updater.label}* (${manager.updater.packageName})`,
    `Group *${group.folder}* selection: ${selection ?? 'default (image-baked)'}`,
    `Auto-update: ${manager.getSetting() || '(off)'}`,
    `Fetched versions: ${fetched.length ? fetched.join(', ') : '(none)'}`,
  ].join('\n');
}

export function handleAgentRuntimeCommand(ctx: HostCommandContext): void {
  if (ctx.userId == null) {
    ctx.replyText('/agent-runtime requires an identifiable user.');
    return;
  }
  const userId = ctx.userId;

  const wirings = getMessagingGroupAgents(ctx.messagingGroupId);
  const groups = wirings.map((w) => getAgentGroup(w.agent_group_id)).filter((g): g is AgentGroup => g != null);
  if (groups.length === 0) {
    ctx.replyText('No agent groups are wired to this channel.');
    return;
  }

  // A leading non-verb token is an explicit group folder; verbs start after it.
  let rest = [...ctx.args];
  let group: AgentGroup | undefined;
  if (rest[0] && !VERBS.has(rest[0].toLowerCase())) {
    const folder = rest[0];
    group = groups.find((g) => g.folder === folder);
    if (!group) {
      ctx.replyText(
        `No engaged agent group with folder *${folder}*. ` +
          `This channel engages: ${groups.map((g) => `*${g.folder}*`).join(', ')}.`,
      );
      return;
    }
    rest = rest.slice(1);
  }

  // Resolve the target group (for status/select) or just the provider.
  if (!group) {
    if (groups.length > 1) {
      ctx.replyText(
        'This channel engages multiple agent groups. Specify one:\n' +
          groups.map((g) => `  /agent-runtime ${g.folder} …`).join('\n'),
      );
      return;
    }
    group = groups[0];
  }

  const providerId = providerIdForGroup(group);
  const manager = getRuntimeUpdateManager(providerId);
  if (!manager) {
    ctx.replyText(`Provider *${providerId}* does not support runtime CLI updates.`);
    return;
  }
  const label = manager.updater.label;
  const verb = rest[0]?.toLowerCase();

  // ── Status (group-admin) ──
  if (!verb) {
    if (!isAdmin(userId, group.id)) {
      ctx.replyText(`Permission denied — /agent-runtime requires admin of *${group.folder}*.`);
      return;
    }
    ctx.replyText(formatStatus(group, manager));
    return;
  }

  // ── select <version|latest> (group-admin) ──
  if (verb === 'select') {
    if (!isAdmin(userId, group.id)) {
      ctx.replyText(`Permission denied — /agent-runtime select requires admin of *${group.folder}*.`);
      return;
    }
    const version = rest[1]?.trim() ?? '';
    if (!version) {
      ctx.replyText('Usage: /agent-runtime [group] select <version|latest>');
      return;
    }
    const fetched = manager.updater.installedVersions();
    if (version !== 'latest' && !fetched.includes(version)) {
      ctx.replyText(
        `${label} ${version} is not fetched. A global admin must \`/agent-runtime fetch ${version}\` first.\n` +
          `Fetched versions: ${fetched.length ? fetched.join(', ') : '(none)'}.`,
      );
      return;
    }
    ensureContainerConfig(group.id);
    updateContainerConfigScalars(group.id, { provider: `${providerId}:${version}` });
    ctx.replyText(`*${group.folder}* now uses ${label} ${version}. Applies to newly-spawned sessions.`);
    return;
  }

  // ── fetch <version|latest> (global-admin) ──
  if (verb === 'fetch') {
    if (!isAdmin(userId)) {
      ctx.replyText('Permission denied — /agent-runtime fetch requires a global admin.');
      return;
    }
    const target = rest[1]?.trim() ?? '';
    if (target === 'latest' || target === '') {
      ctx.replyText(`Fetching the latest ${label}…`);
      void manager
        .fetchLatest()
        .then((version) =>
          ctx.replyText(version ? `Fetched ${label} ${version}.` : 'Fetch failed. Check logs for details.'),
        );
      return;
    }
    if (parseRuntimeUpdate(target).mode !== 'pinned') {
      ctx.replyText(`Invalid version: ${target}\nExpected a version like 2.1.154, or 'latest'.`);
      return;
    }
    ctx.replyText(`Fetching ${label} ${target}…`);
    void manager
      .fetchVersion(target)
      .then((ok) => ctx.replyText(ok ? `Fetched ${label} ${target}.` : 'Fetch failed. Check logs for details.'));
    return;
  }

  // ── remove <version> (global-admin) ──
  if (verb === 'remove') {
    if (!isAdmin(userId)) {
      ctx.replyText('Permission denied — /agent-runtime remove requires a global admin.');
      return;
    }
    const version = rest[1]?.trim() ?? '';
    if (!version || version === 'latest') {
      ctx.replyText('Usage: /agent-runtime remove <version> (an exact fetched version).');
      return;
    }
    if (!manager.updater.installedVersions().includes(version)) {
      ctx.replyText(`${label} ${version} is not fetched — nothing to remove.`);
      return;
    }
    const check = canRemoveVersion(providerId, version);
    if (!check.ok) {
      ctx.replyText(`Cannot remove ${label} ${version}: ${check.reason}.`);
      return;
    }
    manager.updater.remove(version);
    ctx.replyText(`Removed ${label} ${version}.`);
    return;
  }

  // ── auto <duration|off> (global-admin) ──
  if (verb === 'auto') {
    if (!isAdmin(userId)) {
      ctx.replyText('Permission denied — /agent-runtime auto requires a global admin.');
      return;
    }
    const arg = rest[1]?.trim() ?? '';
    if (arg === 'off' || arg === '') {
      void manager.reconfigure('').then(() => ctx.replyText(`${label} auto-update disabled.`));
      return;
    }
    if (parseRuntimeUpdate(arg).mode !== 'latest') {
      ctx.replyText(`Invalid duration: ${arg}\nExpected a duration like 24h, 1d, 30m — or 'off'.`);
      return;
    }
    ctx.replyText(`Enabling ${label} auto-update every ${arg}…`);
    void manager.reconfigure(arg).then(() => ctx.replyText(formatStatus(group, manager)));
    return;
  }

  ctx.replyText(USAGE);
}

registerHostCommand('/agent-runtime', handleAgentRuntimeCommand, {
  scope: 'channel',
  access: 'group-admin',
  help: AGENT_RUNTIME_HELP,
});
