/**
 * Container-side sync-action client.
 *
 * Synchronous request/response with the host, with all business data kept in
 * the session DBs (the host-rpc call is a content-free doorbell). See the host
 * `src/modules/sync-actions/` for the other half.
 *
 *   1. Write a `kind='system'` outbound row carrying `{ action, sync:true,
 *      requestId, ...payload }`. The host delivery poll skips sync rows, so the
 *      wakeup is the row's sole processor.
 *   2. POST the host-rpc `/action` wakeup with only `{ requestId }`. The host
 *      resolves our session from the caller IP, dispatches the action, and
 *      returns the **inbound row id** of the result it wrote — no payload over
 *      the wire.
 *   3. Read the result row from inbound.db by that id and return its payload.
 *
 * Reachability: the host-rpc server listens on host.docker.internal:$PORT;
 * `host.docker.internal` is in the container's NO_PROXY so the call does not
 * loop back through the MITM proxy.
 */
import { getMessageIn, markCompleted } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getSessionRouting } from './db/session-routing.js';

const RESULT_POLL_MS = 200;
const RESULT_WAIT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  console.error(`[sync-action] ${msg}`);
}

/**
 * Invoke a host sync action and return its result payload. Throws if the host
 * is unreachable, the action is unknown / not sync-exposable, or the action
 * handler reported an error.
 */
export async function callSyncAction(
  action: string,
  payload: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const port = process.env.NANOCLAW_HOST_RPC_PORT;
  if (!port) throw new Error('NANOCLAW_HOST_RPC_PORT not set');

  const requestId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const r = getSessionRouting();

  writeMessageOut({
    id: requestId,
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, sync: true, requestId, ...payload }),
  });

  const res = await fetch(`http://host.docker.internal:${port}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const env = (await res.json()) as { ok?: boolean; result?: { inboundId?: string }; error?: string };
  if (!res.ok || !env.ok || !env.result?.inboundId) {
    throw new Error(`sync-action '${action}' wakeup failed: ${env.error ?? `HTTP ${res.status}`}`);
  }
  const inboundId = env.result.inboundId;

  // The host commits the result row before returning the id; journal_mode=DELETE
  // makes it cross-mount visible. A short retry covers any read-after-write lag.
  const deadline = Date.now() + RESULT_WAIT_MS;
  let row = getMessageIn(inboundId);
  while (!row && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_MS));
    row = getMessageIn(inboundId);
  }
  if (!row) throw new Error(`sync-action '${action}': result row ${inboundId} not visible`);

  markCompleted([inboundId]); // ack so the row doesn't linger as pending

  let parsed: { ok?: boolean; result?: unknown; error?: string };
  try {
    parsed = JSON.parse(row.content) as typeof parsed;
  } catch {
    throw new Error(`sync-action '${action}': result row content is not JSON`);
  }
  if (!parsed.ok) {
    log(`'${action}' failed: ${parsed.error ?? 'unknown error'}`);
    throw new Error(parsed.error ?? `sync-action '${action}' failed`);
  }
  return parsed.result;
}
