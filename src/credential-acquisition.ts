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
 * The acquire flow itself is owned by the provider (its `ACQUIRE` extension) —
 * it drives the conversation via the host interaction primitive
 * (`beginInteraction`), not a slash command.
 */
import { getContainerConfig } from './db/container-configs.js';
import { getSession } from './db/sessions.js';
import { deliverDirect } from './delivery.js';
import { resolveProviderName } from './container-config.js';
import { wakeContainer } from './container-runner.js';
import {
  getCredentialProvider,
  asCredentialScope,
  listProviderIds,
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
}

export const ACQUIRE = defineExtension<AcquireExt>('credential-acquire');

function runtimeProviderName(session: Session, agentGroup: AgentGroup): string {
  const row = getContainerConfig(agentGroup.id);
  return resolveProviderName(session.agent_provider, row?.provider);
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

  const have = new Set(listProviderIds(asCredentialScope(agentGroup.folder)));
  const missing = runtime
    .requiredCredentialProviders(runtime.parseRuntimeConfig({}))
    .filter((r) => r.required && !have.has(r.id));
  if (missing.length === 0) return false; // credentials present → proceed

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
  void runAcquire(acquireExt, { origin, credentialScope: asCredentialScope(agentGroup.folder) }, session.id);
  return true;
}

/** Fire-and-forget: run the provider's acquire, then re-wake on success. */
async function runAcquire(ext: AcquireExt, ctx: AcquireContext, sessionId: string): Promise<void> {
  let stored = false;
  try {
    stored = await ext.acquire(ctx);
  } catch (err) {
    log.error('Credential acquisition threw', { sessionId, err });
    return;
  }
  if (!stored) return;
  // Credential now present — process the message left pending at the gate.
  const fresh = getSession(sessionId);
  if (!fresh) return;
  try {
    await wakeContainer(fresh);
  } catch (err) {
    log.error('Re-wake after credential acquisition failed', { sessionId, err });
  }
}
