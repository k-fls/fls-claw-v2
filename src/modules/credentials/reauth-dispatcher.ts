/**
 * Mid-session reauth dispatcher — the host consumer of the container's
 * `feedback.container` system rows (written by the agent-runner poll-loop
 * when a provider classifies an error, e.g. an Anthropic 401 → 'auth-invalid').
 *
 * Flow: classify via the provider's CONTAINER_FEEDBACK extension → on
 * 'reauth', derive an InteractionOrigin from the session's recent inbound
 * messages. Only a **group admin** may fix the credential: an admin is
 * prompted (the provider's REAUTH extension, interactive, in the session's
 * own chat — same primitive as the wake-time acquisition gate in
 * `credential-acquisition.ts`); a non-admin's failing message is declined —
 * the container's raw error surfaces and it is **not retried**. On a
 * successful re-auth the agent group's containers restart with an on-wake
 * retry message (substitutes are minted at spawn and map to one credential
 * path, so a mode switch oauth → api_key only takes effect on a fresh spawn —
 * v1 parity). On cancel/timeout the message is not retried; the next failing
 * message simply prompts again — there is no cooldown, each message is an
 * independent request.
 *
 * The container also writes a user-facing `Error: …` chat row right after
 * the feedback row. While the reauth interaction is active that row is held
 * by the outbound pause (delivery.ts re-checks per row); the dispatcher marks
 * it delivered once the episode ends in success or cancel, so the user sees
 * the reauth conversation instead of the raw error. If reauth never starts
 * (surface fallback) the row delivers normally.
 */
import type Database from 'better-sqlite3';

import { restartAgentGroupContainers } from '../../container-restart.js';
import { isContainerRunning, wakeContainer } from '../../container-runner.js';
import { resolveProviderName } from '../../container-config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveredIds, markDelivered } from '../../db/session-db.js';
import { registerDeliveryAction } from '../../delivery.js';
import { BeginInteractionConflictError, deriveOrigin, type InteractionOrigin } from '../../host-interactions.js';
import { openInboundDb, openOutboundDb, writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

import { isAdmin } from '../../command-gate.js';

import { asCredentialScope, asGroupScope } from './types.js';
import { getCredentialProvider } from './providers/registry.js';
import { CONTAINER_FEEDBACK } from './providers/types.js';
import { REAUTH } from './reauth.js';

const MAX_REASON_LEN = 200;

/**
 * One concurrent reauth episode per (group folder, provider) — sessions of a
 * group share one credential, and the proxy-401 / container-401 double-fire
 * collapses here too. Purely a concurrency guard (cleared the moment the flow
 * resolves), not a rate limiter: there is no cooldown. In-memory is correct —
 * interaction slots are in-memory as well, so a host restart drops it and the
 * next failing message simply re-prompts.
 */
const inFlight = new Set<string>();

/** Strip formatting, control chars, and truncate so agent error text is safe for chat display (ported from v1). */
export function sanitizeReason(raw: string): string {
  return (
    raw
      .replace(/<[^>]*>/g, '') // HTML tags
      .replace(/[*_`~[\]]/g, '') // markdown formatting
      .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{S}]/gu, '') // keep only letters, numbers, punctuation, spaces, symbols
      .replace(/\s+/g, ' ') // collapse whitespace
      .trim()
      .slice(0, MAX_REASON_LEN) + (raw.length > MAX_REASON_LEN ? '…' : '')
  );
}

/**
 * Worded for every restarted session of the group, not just the erroring one
 * (the credential is group-scoped, so all containers respawn).
 */
const RETRY_TEXT =
  "The group's agent credential was just re-authenticated. " +
  'If a recent user request in this conversation went unanswered because of an auth failure, ' +
  'fulfill it now; otherwise no action is needed.';

interface FeedbackContent {
  provider: string;
  classification: string;
  message: string;
  retryable: boolean;
}

function parseFeedbackContent(content: Record<string, unknown>): FeedbackContent | null {
  if (
    typeof content.provider !== 'string' ||
    typeof content.classification !== 'string' ||
    typeof content.message !== 'string' ||
    typeof content.retryable !== 'boolean'
  ) {
    return null;
  }
  return {
    provider: content.provider,
    classification: content.classification,
    message: content.message,
    retryable: content.retryable,
  };
}

/**
 * Suppress the container's user-facing "Error: …" chat row(s) written
 * alongside the feedback row (`poll-loop.ts` writes `{text: 'Error: ' +
 * message}` byte-exact; one turn can produce more than one). Marks every
 * matching undelivered row delivered, SYNCHRONOUSLY at episode launch —
 * marking them later (after the flow resolves) races the release-kicked
 * delivery poll, which delivers held rows the instant the interaction slot
 * frees. If the flow then dies without prompting, the dispatcher surfaces
 * the error itself via `writeReply`. Returns the number of rows consumed.
 */
function suppressErrorRows(session: Session, message: string): number {
  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(session.agent_group_id, session.id);
    inDb = openInboundDb(session.agent_group_id, session.id);
  } catch {
    return 0;
  }
  try {
    const expected = JSON.stringify({ text: `Error: ${message}` });
    const delivered = getDeliveredIds(inDb);
    const rows = outDb
      .prepare("SELECT id, content FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT 20")
      .all() as Array<{ id: string; content: string }>;
    let consumed = 0;
    for (const row of rows) {
      if (row.content !== expected || delivered.has(row.id)) continue;
      markDelivered(inDb, row.id, null);
      consumed++;
    }
    return consumed;
  } catch (err) {
    log.warn('Reauth: failed to suppress error rows', { sessionId: session.id, err });
    return 0;
  } finally {
    outDb.close();
    inDb.close();
  }
}

/** On stored credential: restart the group (fresh substitutes) + retry instruction. */
function restartAndRetry(session: Session, agentGroup: AgentGroup, wasRunning: boolean): void {
  restartAgentGroupContainers(agentGroup.id, 'credential reauth', RETRY_TEXT);
  if (wasRunning) return;
  // The erroring container was already gone (e.g. idle-reaped during the
  // flow) — the group restart skipped this session, so wake it directly.
  writeSessionMessage(agentGroup.id, session.id, {
    id: `reauth-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: agentGroup.id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: RETRY_TEXT, sender: 'system', senderId: 'system' }),
    onWake: 1,
  });
  const fresh = getSession(session.id);
  if (fresh) {
    void wakeContainer(fresh).catch((err) => {
      log.error('Reauth: re-wake after credential reauth failed', { sessionId: session.id, err });
    });
  }
}

/**
 * Core entry, also exported for the future MITM-observer 401 path so both
 * detection channels share one dedup + flow. Returns `true` when a reauth
 * flow was started.
 */
export function requestReauth(args: {
  session: Session;
  agentGroup: AgentGroup;
  providerId: string;
  classification: string;
  message: string;
  origin: InteractionOrigin;
}): boolean {
  const { session, agentGroup, providerId, classification, message, origin } = args;

  const dedupKey = `${agentGroup.folder}::${providerId}`;
  if (inFlight.has(dedupKey)) {
    log.debug?.('Reauth: episode already in flight, deduped feedback row', { dedupKey, sessionId: session.id });
    return false;
  }

  // Only a group admin can fix the credential. A non-admin's failing message
  // is declined: nothing is suppressed (the container's raw error surfaces)
  // and the message is not retried.
  if (!isAdmin(origin.key.userId, agentGroup.id)) {
    log.info('Reauth: requester is not a group admin — surfacing error, no prompt/retry', {
      sessionId: session.id,
      userId: origin.key.userId,
    });
    return false;
  }

  const provider = getCredentialProvider(providerId);
  const reauthExt = provider?.getExtension?.(REAUTH);
  if (!reauthExt) return false;

  // Snapshot before the minutes-long flow; decides the retry path on success.
  const wasRunning = isContainerRunning(session.id);
  // Consume the redundant "Error: …" row(s) NOW, before any await — the
  // reauth conversation replaces them. Done at launch because doing it after
  // the flow resolves races the release-kicked delivery poll.
  suppressErrorRows(session, message);

  inFlight.add(dedupKey);
  log.info('Reauth: starting mid-session reauth', { sessionId: session.id, providerId, classification, dedupKey });

  // Launch synchronously: the provider flow calls beginInteractionOn before
  // its first await, so the interaction slot (and the outbound pause holding
  // the redundant "Error:" row) is active when this function returns.
  let flow: Promise<boolean>;
  try {
    flow = reauthExt.reauth({
      origin,
      credentialScope: asCredentialScope(agentGroup.folder),
      classification,
      reason: sanitizeReason(message),
    });
  } catch (err) {
    inFlight.delete(dedupKey);
    if (!(err instanceof BeginInteractionConflictError)) {
      log.error('Reauth: flow threw at launch', { dedupKey, err });
    }
    return false;
  }

  void flow.then(
    (stored) => {
      inFlight.delete(dedupKey);
      if (stored) {
        restartAndRetry(session, agentGroup, wasRunning);
      } else {
        // Cancel/timeout: the flow already replied; the suppressed error
        // rows stay consumed (episode over, message not retried). The next
        // failing message will prompt again — no cooldown.
        log.info('Reauth: flow ended without a credential', { dedupKey });
      }
    },
    (err) => {
      inFlight.delete(dedupKey);
      if (err instanceof BeginInteractionConflictError) {
        // Another flow owns the slot (e.g. the wake-time acquisition gate);
        // it will store the credential itself.
        log.info('Reauth: interaction slot busy, deferring', { dedupKey });
        return;
      }
      log.error('Reauth: flow failed', { dedupKey, err });
      // The error rows were suppressed at launch and no prompt ever reached
      // the user — surface the underlying failure directly.
      origin.writeReply(`Error: ${sanitizeReason(message)}`);
    },
  );
  return true;
}

async function handleContainerFeedback(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const feedback = parseFeedbackContent(content);
  if (!feedback) {
    log.warn('feedback.container: malformed content', { sessionId: session.id });
    return;
  }

  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  // The row is container-authored (semi-trusted) — cross-check its provider
  // claim against the host's own resolution and prefer the latter.
  const resolved = resolveProviderName(session.agent_provider, getContainerConfig(agentGroup.id)?.provider);
  if (feedback.provider !== resolved) {
    log.warn('feedback.container: provider mismatch, using host-resolved name', {
      sessionId: session.id,
      claimed: feedback.provider,
      resolved,
    });
  }

  const provider = getCredentialProvider(resolved);
  const feedbackExt = provider?.getExtension?.(CONTAINER_FEEDBACK);
  if (!feedbackExt) return; // no opinion → surface (the container's own Error row delivers)

  const action = feedbackExt.onContainerError(
    { message: feedback.message, retryable: feedback.retryable, classification: feedback.classification },
    undefined,
    // containerName isn't exposed by container-runner; Claude's classifier doesn't read it.
    { agentGroupId: agentGroup.id, scope: asGroupScope(agentGroup.folder), containerName: '' },
  );

  if (action === 'ignore') return;
  if (action === 'surface') return; // the container's own "Error: …" chat row delivers
  if (action === 'mark-stale') {
    log.info('feedback.container: mark-stale not implemented, surfacing', { sessionId: session.id });
    return;
  }

  // action === 'reauth'
  const origin = deriveOrigin(session, agentGroup, inDb);
  if (!origin) {
    // Nobody identifiable to prompt (cron/webhook-only history) — surface.
    log.info('Reauth: no identifiable user to prompt, surfacing error', { sessionId: session.id });
    return;
  }

  // Admin-gating + dedup live in requestReauth (the shared core entry).
  requestReauth({
    session,
    agentGroup,
    providerId: resolved,
    classification: feedback.classification,
    message: feedback.message,
    origin,
  });
}

registerDeliveryAction('feedback.container', handleContainerFeedback);

/** Test hook — clears dedup state between cases. */
export function _resetReauthDispatcherForTests(): void {
  inFlight.clear();
}
