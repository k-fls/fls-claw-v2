/**
 * The REAUTH provider extension — mid-session re-authentication.
 *
 * Consumed by the `feedback.container` dispatcher (`./reauth-dispatcher.ts`):
 * when a container reports a classified auth error and the provider's
 * CONTAINER_FEEDBACK extension routes it to `'reauth'`, the dispatcher calls
 * this extension to drive an interactive re-authentication with the user.
 *
 * The provider owns the whole UX behind `reauth()` — mode menu, paste flow,
 * browser hand-off — exactly like ACQUIRE owns the wake-time flow (the
 * `defineExtension`-in-consumer precedent is `credential-acquisition.ts`).
 * The dispatcher stays mode-agnostic.
 */
import type { InteractionOrigin } from '../../host-interactions.js';
import type { CredentialScope } from './types.js';
import { defineExtension } from './providers/types.js';

export interface ReauthContext {
  /** Interaction origin to prompt the user on. */
  origin: InteractionOrigin;
  /**
   * Scope to store the replacement credential under. Write/store is
   * own-scope only, hence `CredentialScope` (see `types.ts` header).
   */
  credentialScope: CredentialScope;
  /** The container classifier's tag that triggered this, e.g. 'auth-invalid'. */
  classification: string;
  /** Sanitized, length-capped human-readable reason (the container error). */
  reason: string;
}

/**
 * Interactive re-authentication. Resolves `true` iff a replacement
 * credential was stored; `false` on cancel / timeout / decline.
 */
export interface ReauthExt {
  reauth(ctx: ReauthContext): Promise<boolean>;
}

export const REAUTH = defineExtension<ReauthExt>('reauth');
