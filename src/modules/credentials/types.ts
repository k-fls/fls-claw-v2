/**
 * Credentials module — branded scope types.
 *
 * Two distinct branded string types, both derived from agent_group_id,
 * kept distinct at the type level so storage and runtime identity can't
 * be conflated accidentally.
 *
 *   GroupScope      — runtime identity in the proxy / token engine.
 *                     "Who is making this request." Used by access checks,
 *                     token resolution, container provisioning.
 *
 *   CredentialScope — on-disk storage location.
 *                     "Where the value lives on disk." Used by store I/O,
 *                     manifest writes, scope-directory paths.
 *
 * The two diverge under grant/borrow: an agent group running as
 * GroupScope=X may legitimately read credentials from CredentialScope=Y
 * because Y has granted to X. Without the branding, this is the kind of
 * mix-up a plain `string` signature would silently allow.
 *
 * The defining difference: a **GroupScope may resolve to delegated
 * credentials** (its own + any granted to it), whereas a **CredentialScope
 * is exactly one scope, no delegation** — it names where a value lives.
 *
 * Rule of thumb for which brand a parameter takes:
 *   - READ / mint / resolve a token  → GroupScope  (borrowing is allowed;
 *     the engine maps GroupScope → the effective CredentialScope for you).
 *   - WRITE / store a credential      → CredentialScope (always own-scope;
 *     `resolver.store` throws if the scope isn't the resolver's ownFolder).
 * So `containerContribution(ctx.groupScope)` mints (GroupScope) and
 * `AcquireContext.credentialScope` stores (CredentialScope).
 *
 * There is no "global" / "main" / `'default'` scope value. Every
 * credential belongs to exactly one CredentialScope; cross-group sharing
 * happens via explicit grant.
 *
 * Both types live module-local (NOT in src/types.ts). Other modules
 * import them from `../credentials/index.js` when they need to interact
 * with credentials APIs.
 */

declare const __credentialScope: unique symbol;
declare const __groupScope: unique symbol;

export type CredentialScope = string & { readonly [__credentialScope]: true };
export type GroupScope = string & { readonly [__groupScope]: true };

/** Cast a string into a CredentialScope. Use at the storage boundary. */
export function asCredentialScope(s: string): CredentialScope {
  return s as CredentialScope;
}

/** Cast a string into a GroupScope. Use at the runtime/engine boundary. */
export function asGroupScope(s: string): GroupScope {
  return s as GroupScope;
}

// ── Credential shape ────────────────────────────────────────────────────────

/**
 * One credential entry as it travels through the resolver↔consumer
 * boundary. `value` and `refresh.value` are the secret strings:
 *
 *   - In the resolver's cache and inside on-disk keys files, these
 *     fields carry their `enc:...` ciphertext.
 *   - When `resolve()` returns a Credential to a consumer, both fields
 *     are decrypted plaintext. The consumer is responsible for the
 *     plaintext from that point on.
 *
 * `authFields` carries non-secret per-credential metadata (e.g. SSH
 * host/port/username, OAuth-token type). It is plaintext on every
 * surface — never encrypted, never cached separately.
 */
export interface Credential {
  value: string;
  updated_ts: number;
  expires_ts?: number;
  authFields?: Record<string, string>;
  /**
   * Sourcing host stamped on a NON-global credential at store time. The
   * MITM bearer-swap guard only injects this credential at a request host
   * sharing its registrable domain (last two labels) — confining it to the
   * domain it was obtained for, regardless of how the agent later edits the
   * provider definition. Absent for global credentials (never stamped), so
   * the guard naturally skips them. See
   * `docs/fls/specs/per-group-oauth-providers.md`.
   */
  boundDomain?: string;
  refresh?: {
    value: string;
    updated_ts: number;
    expires_ts?: number;
  };
}
