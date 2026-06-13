/**
 * Interaction status registry — barrel.
 *
 * Reusable host→container observability primitive. Consumers either
 * use the lazy process-wide singleton via `getInteractionStatusRegistry()`,
 * or instantiate `InteractionStatusRegistry` directly (tests, scoped
 * lifetimes).
 *
 * No side-effecting registration: this module does not appear in
 * `src/modules/index.ts`. HTTP route wiring for `handleSSE` /
 * `handleListInteractions` is the caller's job.
 */
export { InteractionStatusRegistry } from './registry.js';
export type { InteractionEvent, InteractionEventKind, InteractionState } from './types.js';

import { InteractionStatusRegistry } from './registry.js';

let singleton: InteractionStatusRegistry | null = null;

/** Process-wide singleton accessor. Lazy-initialized on first call. */
export function getInteractionStatusRegistry(): InteractionStatusRegistry {
  if (!singleton) singleton = new InteractionStatusRegistry();
  return singleton;
}
