/**
 * Binding-aware `/creds import` planner (inventory I2 — the import reverse
 * index). Registered into the credentials import seam at module load; the
 * `/creds import` command consults it via `planCredentialImport`.
 *
 * Ported from v1 `key-management.ts` (`buildEnvVarProviderIndex`,
 * `tokenizeImportLines` attribution) + `env-bindings.ts` (`groupEnvEntries`).
 * Three jobs v2's literal fallback can't do:
 *
 *   1. **Reverse index** — an un-prefixed `ALL_CAPS` key (bulk mode) is
 *      auto-attributed to the provider that declares it as an env var.
 *      Exactly one declarer → use it; several → ambiguous (skip, warn);
 *      none → no-provider (skip, warn).
 *   2. **Binding-aware credentialPath** — a key that matches a provider env
 *      binding is stored under the binding's *credentialPath* (e.g.
 *      `GH_TOKEN` → `oauth`), not under the literal env name, so the proxy's
 *      substitution actually finds it. Unbound keys fall back to the literal
 *      key as the credential id (v1 + v2 legacy behavior).
 *   3. **Composite joining** — several sliced env vars for one credential
 *      (e.g. `BROWSERSTACK_USERNAME` = `access_key[0]`,
 *      `BROWSERSTACK_ACCESS_KEY` = `access_key[1]`) are joined with the
 *      credential's declared `sep` into one stored value.
 *
 * Pure planning only — no scope, no storage, no minting. The command runs
 * the returned `stores` through the resolver; substitutes are (re)minted at
 * spawn by the credential-env publish (and per request by the proxy).
 */
import {
  registerImportPlanner,
  type ImportPlan,
  type ImportStore,
  type ImportToken,
} from '../credentials/import-resolver.js';
import { getAllCredentialProviders, getCredentialProvider } from '../credentials/providers/registry.js';

import { ENV_NAME_RE } from './env-name-validation.js';
import {
  isSubstitutingProvider,
  type CredentialScope,
  type EnvVarBinding,
  type SubstitutingProvider,
} from './types.js';

/** Reverse index: env-var name → ids of substituting providers declaring it. */
function buildEnvVarProviderIndex(scope?: CredentialScope): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const p of getAllCredentialProviders(scope)) {
    if (!isSubstitutingProvider(p)) continue;
    for (const b of p.substitutes.envBindings?.() ?? []) {
      let list = index.get(b.envName);
      if (!list) {
        list = [];
        index.set(b.envName, list);
      }
      if (!list.includes(p.id)) list.push(p.id);
    }
  }
  return index;
}

interface GroupResult {
  /** credentialPath → joined value + the env-var names that produced it. */
  resolved: Map<string, { value: string; sourceEnvNames: string[] }>;
  warnings: string[];
}

/**
 * Group one provider's `{ key → value }` import entries by credential path,
 * joining composite (sliced) bindings via the credential's `sep`. Direct port
 * of v1 `groupEnvEntries`. Keys that match no binding pass through with the
 * key itself as the credential path.
 */
function groupEnvEntries(provider: SubstitutingProvider, entries: Map<string, string>): GroupResult {
  const bindings = provider.substitutes.envBindings?.() ?? [];
  const resolved = new Map<string, { value: string; sourceEnvNames: string[] }>();
  const warnings: string[] = [];

  const byEnvName = new Map<string, EnvVarBinding>();
  for (const b of bindings) byEnvName.set(b.envName, b);

  const grouped = new Map<
    string,
    { isComposite: boolean; slices: Map<number, string>; direct?: { value: string }; sourceEnvNames: string[] }
  >();

  for (const [key, value] of entries) {
    const binding = byEnvName.get(key);
    const credentialPath = binding?.credentialPath ?? key;
    let bucket = grouped.get(credentialPath);
    if (!bucket) {
      bucket = { isComposite: false, slices: new Map(), sourceEnvNames: [] };
      grouped.set(credentialPath, bucket);
    }
    bucket.sourceEnvNames.push(key);
    if (binding?.slice !== undefined) {
      bucket.isComposite = true;
      bucket.slices.set(binding.slice, value);
    } else {
      bucket.direct = { value };
    }
  }

  for (const [credentialPath, bucket] of grouped) {
    if (bucket.isComposite) {
      const declared = bindings.filter((b) => b.credentialPath === credentialPath && b.slice !== undefined);
      const declaredIndices = declared.map((b) => b.slice as number).sort((a, b) => a - b);
      const missing = declaredIndices.filter((i) => !bucket.slices.has(i));
      if (missing.length > 0) {
        const names = declared.filter((b) => missing.includes(b.slice as number)).map((b) => b.envName);
        warnings.push(`${credentialPath}: composite credential incomplete — missing ${names.join(', ')}`);
        continue;
      }
      if (bucket.direct) {
        warnings.push(`${credentialPath}: cannot mix sliced and non-sliced env vars for the same credential`);
        continue;
      }
      const sep = provider.substitutes.credentialFormatFor?.(credentialPath)?.sep;
      if (!sep) {
        warnings.push(`${credentialPath}: sliced env vars require a credential separator (sep)`);
        continue;
      }
      const ordered = declaredIndices.map((i) => bucket.slices.get(i) as string);
      resolved.set(credentialPath, { value: ordered.join(sep), sourceEnvNames: bucket.sourceEnvNames });
    } else if (bucket.direct) {
      resolved.set(credentialPath, { value: bucket.direct.value, sourceEnvNames: bucket.sourceEnvNames });
    }
  }

  return { resolved, warnings };
}

/** Plan a `/creds import` against the live substituting-provider bindings. */
export function planImport(
  tokens: ImportToken[],
  defaultProviderId: string | null,
  scope?: CredentialScope,
): ImportPlan {
  const warnings: string[] = [];
  const unknownProviders = new Set<string>();
  const isBulk = defaultProviderId === null;
  const index = isBulk ? buildEnvVarProviderIndex(scope) : null;

  // Attribute each token to a provider, grouping its key=value entries.
  const byProvider = new Map<string, Map<string, string>>();
  for (const t of tokens) {
    // Single-provider mode: a line explicitly prefixed for another provider
    // is ignored (v1 parity), not stored under the default.
    if (defaultProviderId !== null && t.prefix !== null && t.prefix !== defaultProviderId) {
      // Never echo the value — these warnings are rendered back into chat.
      warnings.push(`ignored (${t.prefix} ≠ ${defaultProviderId}): ${t.key} (line ${t.line})`);
      continue;
    }
    let providerId = t.prefix ?? defaultProviderId;
    if (!providerId && index && ENV_NAME_RE.test(t.key)) {
      const candidates = index.get(t.key);
      if (candidates && candidates.length === 1) {
        providerId = candidates[0];
      } else if (candidates && candidates.length > 1) {
        warnings.push(
          `ambiguous env var ${t.key} (line ${t.line}): matches [${candidates.join(', ')}] — prefix with 'provider:'`,
        );
        continue;
      }
    }
    if (!providerId) {
      warnings.push(`no provider: ${t.key} (line ${t.line})`);
      continue;
    }
    let target = byProvider.get(providerId);
    if (!target) {
      target = new Map();
      byProvider.set(providerId, target);
    }
    target.set(t.key, t.value); // last-write-wins for a duplicate key
  }

  const stores: ImportStore[] = [];
  const envVarsByProvider: Record<string, string[]> = {};

  for (const [providerId, entries] of byProvider) {
    const provider = getCredentialProvider(providerId, scope);
    if (!provider || !isSubstitutingProvider(provider)) {
      unknownProviders.add(providerId);
      continue;
    }
    const { resolved, warnings: groupWarnings } = groupEnvEntries(provider, entries);
    warnings.push(...groupWarnings);
    for (const [credentialPath, { value, sourceEnvNames }] of resolved) {
      stores.push({ providerId, credentialId: credentialPath, value });
      const envNames = sourceEnvNames.filter((n) => ENV_NAME_RE.test(n));
      if (envNames.length > 0) {
        (envVarsByProvider[providerId] ??= []).push(...envNames);
      }
    }
  }

  return { stores, envVarsByProvider, unknownProviders: [...unknownProviders], warnings };
}

registerImportPlanner(planImport);
