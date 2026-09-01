/**
 * Wake-time credential acquisition.
 *
 * The inbound message is already persisted (pending) by the time the router
 * reaches the wake step. This gate runs there: if the group's agent runtime
 * requires a credential provider the group lacks, and that provider declares an
 * interactive `ACQUIRE` capability, and there's an identifiable user to prompt,
 * we start the interactive acquisition *instead of* spawning. The pending
 * message is left untouched and is processed on the re-wake fired once the
 * credential is stored.
 *
 * The non-interactive backstop (cron / host-sweep wakes with no user) stays the
 * `onSpawnPre` spawn validator, which fails the spawn fast.
 *
 * A group nobody has chosen a runtime for is asked which agent to run as
 * before any credential is requested, provided more than one runtime is
 * offerable. The answer is written to the group's container config, so the
 * question is asked once; a group whose runtime was set deliberately (`ncl
 * groups config update --provider`) is never second-guessed.
 *
 * The acquire flow itself is owned by the provider (its `ACQUIRE` extension) —
 * it drives the conversation via the host interaction primitive
 * (`beginInteraction`), not a slash command.
 */
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { getSession } from './db/sessions.js';
import { deliverDirect } from './delivery.js';
import { resolveProviderName } from './container-config.js';
import { wakeContainer } from './container-runner.js';
import { pickOptionOn } from './modules/interactions/pick-option.js';
import {
  getAllCredentialProviders,
  getCredentialProvider,
  asCredentialScope,
  availableProviderIds,
  AGENT_RUNTIME,
  defineExtension,
  type CredentialScope,
} from './modules/credentials/index.js';
import { type InteractionOrigin } from './host-interactions.js';
import { log } from './log.js';
import type { DeliveryAddress } from './channels/adapter.js';
import type { AgentGroup, Session } from './types.js';

export interface AcquireContext {
  /** Interaction origin to prompt the user on. */
  origin: InteractionOrigin;
  /**
   * The credential scope to store the acquired credential under. A stored
   * credential belongs to exactly one scope (no delegation), so this is a
   * `CredentialScope`, not a `GroupScope`.
   */
  credentialScope: CredentialScope;
}

/**
 * A credential provider's interactive-acquisition capability. `acquire` prompts
 * the user (via `pastePgpOn` / `beginInteraction`), validates, and stores the
 * credential, resolving `true` when one was stored or `false` on cancel /
 * timeout / decline.
 */
export interface AcquireExt {
  acquire(ctx: AcquireContext): Promise<boolean>;
  /**
   * Menu label when a group is asked which agent runtime to use. Absent ⇒ the
   * provider is never offered as a choice, only used when already selected.
   */
  readonly runtimeLabel?: string;
  /**
   * False when the provider's credential half is registered but its runtime
   * half is not installed — a skill-installed provider whose payload is
   * missing would otherwise be offered and then fail at spawn. Absent ⇒ always
   * available.
   */
  isRuntimeAvailable?(): boolean;
}

export const ACQUIRE = defineExtension<AcquireExt>('credential-acquire');

function runtimeProviderName(session: Session, agentGroup: AgentGroup): string {
  const row = getContainerConfig(agentGroup.id);
  return resolveProviderName(session.agent_provider, row?.provider);
}

/** An agent runtime the user can be offered. */
export interface OfferableRuntime {
  id: string;
  label: string;
}

/**
 * Agent runtimes a group can be switched to: registered credential providers
 * that drive a runtime (`AGENT_RUNTIME`), can be signed into interactively
 * (`ACQUIRE`), name themselves for a menu, and whose runtime half is actually
 * installed. Tool-credential providers declare no `AGENT_RUNTIME` and so never
 * appear.
 *
 * Registration order, which puts the default provider first — `src/index.ts`
 * registers Claude before any skill-installed runtime.
 */
export function offerableRuntimes(): OfferableRuntime[] {
  const out: OfferableRuntime[] = [];
  for (const provider of getAllCredentialProviders()) {
    if (!provider.getExtension?.(AGENT_RUNTIME)) continue;
    const acquire = provider.getExtension?.(ACQUIRE);
    if (!acquire?.runtimeLabel) continue;
    if (acquire.isRuntimeAvailable?.() === false) continue;
    out.push({ id: provider.id, label: acquire.runtimeLabel });
  }
  return out;
}

/**
 * True when nothing has chosen this group's runtime yet. `resolveProviderName`
 * falls back to `claude`, so an unset column is indistinguishable from an
 * explicit `claude` once resolved — the distinction has to be made on the raw
 * values, and only an unset group is asked to choose.
 */
export function hasUnsetRuntime(session: Session, agentGroup: AgentGroup): boolean {
  return !session.agent_provider && !getContainerConfig(agentGroup.id)?.provider;
}

/**
 * Ask which agent runtime to use and record the answer on the agent group.
 * Returns the chosen provider id, or null when cancelled or timed out.
 *
 * Writes the choice before the sign-in runs, so an abandoned sign-in still
 * leaves the group on the runtime the user picked rather than silently back on
 * the default.
 */
export async function chooseRuntimeOn(
  origin: InteractionOrigin,
  agentGroupId: string,
  options: OfferableRuntime[],
  prompt: string,
): Promise<string | null> {
  const pick = await pickOptionOn(origin, { prompt, options: options.map((o) => o.label) });
  if (pick.reason !== 'submitted' || pick.index == null) {
    origin.writeReply(pick.reason === 'cancelled' ? 'Cancelled — nothing changed.' : 'Timed out — nothing changed.');
    return null;
  }
  const chosen = options[pick.index];
  updateContainerConfigScalars(agentGroupId, { provider: chosen.id });
  log.info('Agent runtime selected', { agentGroupId, provider: chosen.id });
  return chosen.id;
}

/**
 * Returns `true` when an interactive acquisition was started — the caller must
 * then skip the spawn (the pending message rides the post-acquire re-wake).
 * Returns `false` to proceed with a normal wake.
 */
export function maybeBeginCredentialAcquisition(args: {
  agentGroup: AgentGroup;
  session: Session;
  deliveryAddr: DeliveryAddress;
  userId: string | null;
}): boolean {
  const { agentGroup, session, deliveryAddr, userId } = args;
  // No identifiable user / group to prompt → leave it to the spawn-time backstop.
  if (!userId || !session.messaging_group_id) return false;

  const providerName = runtimeProviderName(session, agentGroup);
  const provider = getCredentialProvider(providerName);
  const runtime = provider?.getExtension?.(AGENT_RUNTIME);
  const acquireExt = provider?.getExtension?.(ACQUIRE);
  if (!runtime || !acquireExt) return false; // provider declares no need + acquire

  // Borrow-aware: a group that borrows a required provider from a granting
  // source counts as having it (it resolves the grantor's credential at
  // runtime), so we must not prompt-to-acquire before the borrow path runs.
  const have = availableProviderIds(agentGroup.folder);
  const missing = runtime
    .requiredCredentialProviders(runtime.parseRuntimeConfig({}))
    .filter((r) => r.required && !have.has(r.id));
  if (missing.length === 0) return false; // credentials present (own or borrowed) → proceed

  const origin: InteractionOrigin = {
    key: {
      channelType: deliveryAddr.channelType,
      platformId: deliveryAddr.platformId,
      threadId: deliveryAddr.threadId,
      userId,
    },
    agentGroupId: agentGroup.id,
    messagingGroupId: session.messaging_group_id,
    replyAddr: deliveryAddr,
    writeReply: (text) => deliverDirect(deliveryAddr.channelType, deliveryAddr.platformId, deliveryAddr.threadId, text),
  };

  log.info('Credential acquisition gate engaged', {
    sessionId: session.id,
    providerName,
    missing: missing.map((m) => m.id),
  });
  void runGate({ origin, agentGroup, session, providerName });
  return true;
}

/**
 * Fire-and-forget: settle which runtime the group uses, sign into it, then
 * re-wake so the message left pending at the gate is processed.
 */
async function runGate(args: {
  origin: InteractionOrigin;
  agentGroup: AgentGroup;
  session: Session;
  providerName: string;
}): Promise<void> {
  const { origin, agentGroup, session } = args;
  let providerName = args.providerName;

  // A group nobody has chosen a runtime for is asked, provided there is more
  // than one answer. One offerable runtime is not a choice, and a group whose
  // runtime was set deliberately is never second-guessed.
  if (hasUnsetRuntime(session, agentGroup)) {
    const options = offerableRuntimes();
    if (options.length > 1) {
      const chosen = await chooseRuntimeOn(
        origin,
        agentGroup.id,
        options,
        'Which agent should I run as for this group?',
      );
      if (!chosen) return;
      providerName = chosen;
    }
  }

  const ext = getCredentialProvider(providerName)?.getExtension?.(ACQUIRE);
  if (!ext) {
    origin.writeReply(`*${providerName}* cannot be signed into from chat.`);
    return;
  }

  // The picked runtime may already hold a credential — switching to it is then
  // the whole job, and asking for a sign-in would be noise.
  if (!runtimeNeedsCredential(agentGroup.folder, providerName)) {
    origin.writeReply(`Switched to *${providerName}*, which is already signed in. Picking up where we left off.`);
    await rewake(session.id);
    return;
  }

  let stored = false;
  try {
    stored = await ext.acquire({ origin, credentialScope: asCredentialScope(agentGroup.folder) });
  } catch (err) {
    log.error('Credential acquisition threw', { sessionId: session.id, err });
    return;
  }
  if (!stored) return;
  await rewake(session.id);
}

/** True when `providerName`'s runtime requires a credential the group lacks. */
export function runtimeNeedsCredential(folder: string, providerName: string): boolean {
  const runtime = getCredentialProvider(providerName)?.getExtension?.(AGENT_RUNTIME);
  if (!runtime) return false;
  const have = availableProviderIds(folder);
  return runtime.requiredCredentialProviders(runtime.parseRuntimeConfig({})).some((r) => r.required && !have.has(r.id));
}

async function rewake(sessionId: string): Promise<void> {
  const fresh = getSession(sessionId);
  if (!fresh) return;
  try {
    await wakeContainer(fresh);
  } catch (err) {
    log.error('Re-wake after credential acquisition failed', { sessionId, err });
  }
}
