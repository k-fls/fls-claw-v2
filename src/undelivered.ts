/**
 * Outbound dead-letter view.
 *
 * Inbound already has one: a message the router drops is recorded in
 * `unregistered_senders` and surfaced by `ncl dropped-messages`. Outbound had
 * no equivalent — when the delivery poll gave up on a reply, the only record
 * was a `status='failed'` row in one session's `inbound.db`, which
 * `getDeliveredIds` then treats as settled forever. A complete agent answer
 * could be destroyed with no operator-visible trace and no way back.
 *
 * This module is the missing half. It reads failed rows out of every session's
 * `delivered` table and joins them against the reply that was lost, so the
 * failure is inspectable; and it clears a failed row so the next delivery poll
 * re-attempts the send.
 *
 * Cross-session by necessity: delivery bookkeeping is per-session state, so
 * there is no single table to query. The fan-out is bounded by session count,
 * and every handle is closed before the next session is opened.
 */
import { getAllSessions, getSessionsByAgentGroup } from './db/sessions.js';
import { clearFailedDelivery, getFailedDeliveries, getOutboundMessageById } from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb } from './session-manager.js';
import type { Session } from './types.js';

/** How much of the lost reply to carry into a listing. Enough to recognize the
 *  message, short enough that a long answer does not flood a terminal. */
const PREVIEW_CHARS = 160;

export interface UndeliveredMessage {
  messageOutId: string;
  sessionId: string;
  agentGroupId: string;
  failedAt: string;
  channelType: string | null;
  platformId: string | null;
  /** Null when the reply itself is gone from messages_out — the failure is
   *  still real and worth showing, but there is nothing left to re-send. */
  preview: string | null;
  recoverable: boolean;
}

/** Best-effort human-readable text for an outbound row's JSON content. */
function previewOf(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'string') text = parsed;
    else if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      const field = o.text ?? o.markdown ?? o.question ?? o.title;
      if (typeof field === 'string') text = field;
    }
  } catch {
    /* not JSON — show the raw value */
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** Collect failed deliveries for one session. Never throws — a session whose
 *  databases are missing or unreadable is skipped, because one unreadable
 *  session must not hide the failures recorded in every other one. */
function collectForSession(session: Session): UndeliveredMessage[] {
  let inDb;
  try {
    inDb = openInboundDb(session.agent_group_id, session.id);
  } catch (err) {
    log.debug('Undelivered scan: inbound DB unreadable, skipping session', { sessionId: session.id, err });
    return [];
  }

  let failed: ReturnType<typeof getFailedDeliveries>;
  try {
    failed = getFailedDeliveries(inDb);
  } catch (err) {
    log.debug('Undelivered scan: failed-delivery query errored, skipping session', { sessionId: session.id, err });
    return [];
  } finally {
    inDb.close();
  }
  if (failed.length === 0) return [];

  // Only opened once a session actually has failures, so the common case (no
  // dead letters anywhere) costs one read per session rather than two.
  let outDb;
  try {
    outDb = openOutboundDb(session.agent_group_id, session.id);
  } catch (err) {
    log.debug('Undelivered scan: outbound DB unreadable, reporting without content', {
      sessionId: session.id,
      err,
    });
    return failed.map((f) => ({
      messageOutId: f.message_out_id,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      failedAt: f.failed_at,
      channelType: null,
      platformId: null,
      preview: null,
      recoverable: false,
    }));
  }

  try {
    return failed.map((f) => {
      const row = getOutboundMessageById(outDb, f.message_out_id);
      return {
        messageOutId: f.message_out_id,
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        failedAt: f.failed_at,
        channelType: row?.channel_type ?? null,
        platformId: row?.platform_id ?? null,
        preview: row ? previewOf(row.content) : null,
        recoverable: row !== undefined,
      };
    });
  } finally {
    outDb.close();
  }
}

/**
 * Every permanently-failed outbound reply, newest first.
 *
 * `agentGroupId` narrows the scan to one agent group; without it every session
 * is scanned. Both paths include closed sessions on purpose — a loss that
 * becomes invisible when its session is archived is the bug this surface
 * exists to remove.
 */
export function listUndelivered(opts: { agentGroupId?: string; limit?: number } = {}): UndeliveredMessage[] {
  const sessions = opts.agentGroupId ? getSessionsByAgentGroup(opts.agentGroupId) : getAllSessions();
  const all = sessions.flatMap(collectForSession);
  all.sort((a, b) => b.failedAt.localeCompare(a.failedAt));
  return opts.limit != null ? all.slice(0, opts.limit) : all;
}

export interface RequeueResult {
  requeued: boolean;
  messageOutId: string;
  sessionId?: string;
  agentGroupId?: string;
  reason?: string;
}

/**
 * Clear a failed row so the delivery poll re-attempts the send.
 *
 * The id alone does not say which session holds it, so the scan locates it
 * first — which also means a caller cannot requeue a message by guessing an id
 * that belongs to a session they did not name.
 *
 * Requeuing does not itself send anything: it removes the marker that made the
 * reply ineligible, and the next poll does the rest. If the original cause is
 * still present the message simply fails again, which is the same outcome as
 * before with the failure still visible here.
 */
export function requeueUndelivered(messageOutId: string, opts: { agentGroupId?: string } = {}): RequeueResult {
  const match = listUndelivered(opts).find((m) => m.messageOutId === messageOutId);
  if (!match) {
    return {
      requeued: false,
      messageOutId,
      reason: 'No failed delivery with that message id was found in the scanned sessions.',
    };
  }
  if (!match.recoverable) {
    return {
      requeued: false,
      messageOutId,
      sessionId: match.sessionId,
      agentGroupId: match.agentGroupId,
      reason: 'The reply is no longer present in messages_out, so there is nothing left to re-send.',
    };
  }

  // inbound.db is the host's to write and ncl runs in the host process, so
  // this is the sanctioned writer rather than a cross-mount reach — the same
  // handle delivery.ts marks rows through.
  const inDb = openInboundDb(match.agentGroupId, match.sessionId);
  try {
    const cleared = clearFailedDelivery(inDb, messageOutId);
    if (cleared) {
      log.info('Undelivered message requeued', {
        messageOutId,
        sessionId: match.sessionId,
        agentGroupId: match.agentGroupId,
      });
    }
    return {
      requeued: cleared,
      messageOutId,
      sessionId: match.sessionId,
      agentGroupId: match.agentGroupId,
      reason: cleared ? undefined : 'The row was no longer marked failed — nothing was changed.',
    };
  } finally {
    inDb.close();
  }
}
