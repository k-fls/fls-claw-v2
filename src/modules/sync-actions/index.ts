/**
 * Sync actions — synchronous request/response over the session DBs.
 *
 * The container→host action channel (delivery actions written to
 * `messages_out`, dispatched by `registerDeliveryAction`) is async and
 * fire-and-forget — no value returns to the caller. A *sync action* layers a
 * synchronous round-trip on top of the same registry, keeping business data
 * entirely inside the two session DBs:
 *
 *   1. The container writes a `kind='system'` `messages_out` row whose action
 *      content carries `sync: true` and a `requestId`. The delivery poll skips
 *      it (see `isSyncActionRequest` in `delivery.ts`), so the wakeup below is
 *      its sole processor — exactly-once.
 *   2. The container POSTs this **content-free** host-rpc wakeup, carrying only
 *      the pointer `{ requestId }`. The caller's **session is resolved host-side
 *      from its IP** (`lookupContainerSession`, 1:1 with the container) — never
 *      taken from the body, which a container could spoof to a sibling session
 *      in its own scope.
 *   3. The handler reads the request row, dispatches the action via
 *      `dispatchSyncAction` (the same handler the poll would run), and writes
 *      the result as a `kind='system'` `messages_in` row. System inbound rows
 *      are excluded from the agent's prompt poll and read by-id by the waiting
 *      MCP tool — exactly the `ask_question` response pattern.
 *   4. The wakeup returns **only the inbound row id** — no payload. host-rpc
 *      therefore carries no business data in either direction; the DB is the
 *      single source of truth. The container reads the result from its
 *      inbound.db by that id (the write commits before this returns, and
 *      `journal_mode=DELETE` guarantees cross-mount visibility).
 *
 * Any registered action is dispatchable here (sync is just a transport — the
 * container can already trigger any action async); response-bearing ones return
 * a value, fire-and-forget ones return nothing.
 */
import { randomUUID } from 'crypto';

import { dispatchSyncAction, SYNC_ACTION_FLAG } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { getOutboundMessageById, insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import { openInboundDb, openOutboundDb } from '../../session-manager.js';
import { lookupContainerSession } from '../container-bootstrap/index.js';
import { registerHostRpc } from '../host-rpc/index.js';
import type { ContainerScope } from '../container-bootstrap/index.js';
import type { HostRpcRequest } from '../host-rpc/index.js';

interface WakeupBody {
  requestId?: unknown;
}

/** Shape written into the result `messages_in` row's `content`. The container
 * reads this by id; `requestId` is embedded as audit/correlation metadata. */
interface SyncResultContent {
  requestId: string;
  action: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * In-flight requestIds. A wakeup claims its requestId here for the duration of
 * processing; a second wakeup for the same requestId while the first is in
 * flight **fails** rather than double-dispatching. Cleared when the first
 * settles. The claim is race-free because the check + set below run with no
 * `await` between them (the host is single-threaded). Built in from day one so
 * the duplicate-fails contract can't shift later.
 */
const inFlight = new Set<string>();

export async function handleActionWakeup(req: HostRpcRequest, scope: ContainerScope): Promise<{ inboundId: string }> {
  const body = (req.body ?? {}) as WakeupBody;
  const requestId = typeof body.requestId === 'string' ? body.requestId : null;
  if (!requestId) throw new Error('sync-action: missing requestId');

  // Atomic claim — no `await` between the check and the add.
  if (inFlight.has(requestId)) throw new Error(`sync-action: duplicate in-flight request ${requestId}`);
  inFlight.add(requestId);
  try {
    return await processWakeup(req, scope, requestId);
  } finally {
    inFlight.delete(requestId);
  }
}

async function processWakeup(
  req: HostRpcRequest,
  scope: ContainerScope,
  requestId: string,
): Promise<{ inboundId: string }> {
  // Resolve the session from the caller IP (1:1 with the container) — host-rpc
  // already mapped the IP to its scope, so this is authoritative and unspoofable.
  const sessionId = lookupContainerSession(req.callerIP);
  if (!sessionId) throw new Error('sync-action: no session bound to caller IP');

  const session = getSession(sessionId);
  if (!session) throw new Error('sync-action: unknown session');
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) throw new Error('sync-action: unknown agent group');

  // Sanity: the IP-bound session must live in the IP-derived scope. Always true
  // unless the two registries disagree — fail closed if so.
  if (agentGroup.folder !== String(scope)) {
    log.error('sync-action: IP session/scope registries disagree — rejecting', {
      sessionId,
      requestId,
      sessionFolder: agentGroup.folder,
      callerScope: String(scope),
    });
    throw new Error('sync-action: session/scope mismatch');
  }

  const inDb = openInboundDb(agentGroup.id, session.id);
  let outDb: ReturnType<typeof openOutboundDb> | null = null;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    const reqRow = getOutboundMessageById(outDb, requestId);
    if (!reqRow) throw new Error('sync-action: request row not found');

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(reqRow.content) as Record<string, unknown>;
    } catch {
      throw new Error('sync-action: request row content is not JSON');
    }
    if (content[SYNC_ACTION_FLAG] !== true) throw new Error('sync-action: row is not a sync request');
    const action = content.action;
    if (typeof action !== 'string') throw new Error('sync-action: request missing action');

    // Dispatch through the shared registry. Action errors are captured into the
    // result row (the container always gets a structured result, never a
    // transport-level failure that loses the round-trip).
    let resultContent: SyncResultContent;
    try {
      const result = await dispatchSyncAction(action, content, session, inDb);
      resultContent = { requestId, action, ok: true, result: result ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('sync-action: handler failed', { action, requestId, err });
      resultContent = { requestId, action, ok: false, error: message };
    }

    const inboundId = randomUUID();
    insertMessage(inDb, {
      id: inboundId,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: reqRow.platform_id,
      channelType: reqRow.channel_type,
      threadId: reqRow.thread_id,
      content: JSON.stringify(resultContent),
      processAfter: null,
      recurrence: null,
      trigger: 0, // never wakes the agent — it's a result the tool reads by id
    });

    log.info('sync-action: result written', { action, requestId, inboundId, ok: resultContent.ok });
    return { inboundId };
  } finally {
    outDb?.close();
    inDb.close();
  }
}

registerHostRpc('/action', handleActionWakeup);
