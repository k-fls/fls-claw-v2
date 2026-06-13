/**
 * Sync-action wakeup: the in-flight claim. A second wakeup for a requestId
 * already being processed fails rather than double-dispatching; the slot frees
 * once the first settles. Heavy deps (DBs, registry, IP map) are mocked so the
 * test isolates the claim semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  let resolveDispatch!: (v: unknown) => void;
  const dispatchGate = new Promise<unknown>((res) => {
    resolveDispatch = res;
  });
  return { dispatchGate, resolveDispatch: (v: unknown) => resolveDispatch(v), insertMessage: vi.fn() };
});

vi.mock('../host-rpc/index.js', () => ({ registerHostRpc: vi.fn() }));
vi.mock('../container-bootstrap/index.js', () => ({ lookupContainerSession: () => 'sess1' }));
vi.mock('../../db/sessions.js', () => ({ getSession: () => ({ id: 'sess1', agent_group_id: 'g1' }) }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: () => ({ id: 'g1', folder: 'f1' }) }));
vi.mock('../../session-manager.js', () => ({
  openInboundDb: () => ({ close() {} }),
  openOutboundDb: () => ({ close() {} }),
}));
vi.mock('../../db/session-db.js', () => ({
  getOutboundMessageById: () => ({
    id: 'req1',
    content: JSON.stringify({ action: 'a', sync: true, requestId: 'req1' }),
    platform_id: null,
    channel_type: null,
    thread_id: null,
  }),
  insertMessage: h.insertMessage,
}));
vi.mock('../../delivery.js', () => ({
  SYNC_ACTION_FLAG: 'sync',
  dispatchSyncAction: () => h.dispatchGate,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleActionWakeup } from './index.js';

const req = (requestId: string) => ({ method: 'POST', path: '/action', body: { requestId }, callerIP: 'ip1' }) as never;
const SCOPE = 'f1' as never;

afterEach(() => {
  h.insertMessage.mockClear();
});

describe('sync-action wakeup in-flight claim', () => {
  it('fails a concurrent duplicate requestId while the first is in flight', async () => {
    const first = handleActionWakeup(req('req1'), SCOPE); // hangs on the dispatch gate
    await expect(handleActionWakeup(req('req1'), SCOPE)).rejects.toThrow(/duplicate in-flight/);

    h.resolveDispatch({ ok: true }); // let the first complete
    const out = await first;
    expect(out.inboundId).toBeTruthy();
    expect(h.insertMessage).toHaveBeenCalledTimes(1); // only the first dispatched + wrote
  });

  it('rejects a missing requestId', async () => {
    await expect(handleActionWakeup({ body: {}, callerIP: 'ip1' } as never, SCOPE)).rejects.toThrow(
      /missing requestId/,
    );
  });
});
