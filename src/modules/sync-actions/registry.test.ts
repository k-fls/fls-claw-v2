/**
 * Sync-action registry semantics: any registered action is dispatchable via
 * `dispatchSyncAction` (sync is just a transport), and the handler's return
 * value is surfaced as the result. (The full wakeup round-trip — DB read/write
 * + session resolution — is exercised by integration coverage.)
 */
import { describe, expect, it } from 'vitest';

import { registerDeliveryAction, dispatchSyncAction } from '../../delivery.js';
import type { Session } from '../../types.js';

const SESSION = { id: 's1', agent_group_id: 'g1' } as unknown as Session;
const INDB = {} as never;

describe('sync-action registry', () => {
  it('dispatches a registered action and returns its result', async () => {
    registerDeliveryAction('test_sync_ok', async (content) => ({ echoed: content.x }));
    const result = await dispatchSyncAction('test_sync_ok', { action: 'test_sync_ok', x: 42 }, SESSION, INDB);
    expect(result).toEqual({ echoed: 42 });
  });

  it('dispatches a fire-and-forget action too (result undefined)', async () => {
    registerDeliveryAction('test_void', async () => undefined);
    const result = await dispatchSyncAction('test_void', { action: 'test_void' }, SESSION, INDB);
    expect(result).toBeUndefined();
  });

  it('throws for an unknown action', async () => {
    await expect(dispatchSyncAction('test_nope', { action: 'test_nope' }, SESSION, INDB)).rejects.toThrow(
      /unknown action/,
    );
  });

  it('propagates handler errors to the caller', async () => {
    registerDeliveryAction('test_sync_throw', async () => {
      throw new Error('boom');
    });
    await expect(dispatchSyncAction('test_sync_throw', { action: 'test_sync_throw' }, SESSION, INDB)).rejects.toThrow(
      /boom/,
    );
  });
});
