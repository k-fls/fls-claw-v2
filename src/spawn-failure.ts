/**
 * Spawn-failure classification + poison set.
 *
 * Container spawn errors fall into two classes:
 *
 *   - **Retryable** (plain `Error`): transient infrastructure problems where
 *     the right behavior is "leave the inbound pending and let host-sweep
 *     try again on its next tick." Example: OneCLI gateway momentarily
 *     unreachable. No user notification — the system self-heals.
 *
 *   - **Fatal** (`FatalSpawnError`): a deterministic problem that retrying
 *     will not fix on its own — a buggy contribution callback, a mount
 *     source that does not exist, a misconfigured proxy URL. The host
 *     records the session as "poisoned" so the sweep stops re-waking it,
 *     and the caller that has channel context (the router) reports the
 *     error to the user via `deliverDirect`. The poison flag is cleared
 *     by the router when the user sends another inbound for that session
 *     — that's the user's "I've seen the error, try again" signal.
 *
 * The poison set is in-memory only. On host restart everything is forgotten
 * and the next inbound triggers a fresh spawn attempt.
 */

export class FatalSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FatalSpawnError';
  }
}

const poisoned = new Set<string>();

/** Mark a session as spawn-poisoned. wakeContainer short-circuits for poisoned sessions. */
export function markSpawnPoisoned(sessionId: string): void {
  poisoned.add(sessionId);
}

/** Test whether a session is currently spawn-poisoned. */
export function isSpawnPoisoned(sessionId: string): boolean {
  return poisoned.has(sessionId);
}

/**
 * Clear the spawn-poison flag for a session. Called by the router when the
 * user sends a new inbound for that session — they've been told about the
 * prior failure and are retrying.
 */
export function clearSpawnPoison(sessionId: string): boolean {
  return poisoned.delete(sessionId);
}

/** Test-only: drop all poison flags. */
export function _resetSpawnPoisonForTesting(): void {
  poisoned.clear();
}
