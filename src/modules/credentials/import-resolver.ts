/**
 * Credential-import planning seam (inventory I2 — the import reverse index).
 *
 * `/creds import` (commands/creds.ts) resolves pasted `[provider:]key=value`
 * lines to concrete `(providerId, credentialId, value)` store targets. For
 * un-prefixed `ALL_CAPS` keys that means a **reverse** lookup
 * env-var-name → provider, plus binding-aware credentialPath resolution and
 * composite (sliced) joining. All of that knowledge lives on the MITM
 * substituting providers (the `mitm-proxy` module), which the credentials
 * module must not import (cycle — see the `DEFAULT_CREDENTIAL_ID` note in
 * `commands/creds.ts`).
 *
 * So `mitm-proxy` registers a planner here at boot; the import command
 * consults it. With no planner registered (mitm-proxy not loaded), the
 * command falls back to literal storage (`credentialId = key`, prefix or
 * `<provider>`-default attribution only).
 */

import type { CredentialScope } from './types.js';

/** One tokenized import line. `prefix` is set when the line was `provider:key=value`. */
export interface ImportToken {
  prefix: string | null;
  key: string;
  value: string;
}

/** A credential the caller should persist via the resolver. */
export interface ImportStore {
  providerId: string;
  credentialId: string;
  value: string;
}

export interface ImportPlan {
  /** Credentials to store. The caller runs `resolver.store` for each. */
  stores: ImportStore[];
  /** Env-var names that will resolve per provider (for the summary message). */
  envVarsByProvider: Record<string, string[]>;
  /** Provider ids referenced but unknown / not substituting. */
  unknownProviders: string[];
  /** Per-line skip reasons (ambiguous env var, incomplete composite, …). */
  warnings: string[];
}

export type ImportPlanner = (
  tokens: ImportToken[],
  defaultProviderId: string | null,
  scope?: CredentialScope,
) => ImportPlan;

let planner: ImportPlanner | null = null;

/** Register the binding-aware planner. Called once by mitm-proxy at boot. */
export function registerImportPlanner(fn: ImportPlanner): void {
  planner = fn;
}

/** Plan an import via the registered planner, or `null` when none is registered. */
export function planCredentialImport(
  tokens: ImportToken[],
  defaultProviderId: string | null,
  scope?: CredentialScope,
): ImportPlan | null {
  return planner ? planner(tokens, defaultProviderId, scope) : null;
}

/** Test-only: clear the registered planner. */
export function _resetImportPlannerForTests(): void {
  planner = null;
}
