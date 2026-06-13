/**
 * Discovery file loader. Reads baseline `*.json` from the in-tree
 * `discovery/` directory and (optionally) merges per-install overrides
 * from `~/.config/nanoclaw/auth-discovery/`.
 *
 * Merge semantics (v1-faithful):
 *   - Standard OIDC fields from the override win over baseline.
 *   - Any key starting with `_` is taken from the baseline only —
 *     overrides cannot rewrite intercept rules, env bindings, or
 *     refresh strategy. This invariant keeps refreshed catalogs
 *     incapable of breaking the proxy's wire behavior.
 *
 * Discovery files that lack a token_endpoint AND authorization_endpoint
 * AND api_base_url (e.g. aws-iam.json) load with zero rules and are
 * dropped. Override-only files (no matching baseline id) are warned
 * about and skipped — the baseline always defines the provider set.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { CredentialFormatSpec, EnvVarBinding, SubstituteConfig } from '../types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from '../types.js';

import { parseEnvVarValue } from './env-bindings.js';
import { OAUTH_LOAD_REPORT_FILENAME } from './discovery-paths.js';
import type { DiscoveryFile, InterceptRule, OAuthProvider, RefreshStrategy } from './types.js';

// ── URL parsing helpers ───────────────────────────────────────────────

/** Placeholder pattern in URLs: {name} */
const PLACEHOLDER_RE = /\{(\w+)\}/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface EndpointDef {
  field: keyof DiscoveryFile;
  mode: InterceptRule['mode'];
  /** Prefix match for api_base_url — covers all sub-paths. */
  prefixMatch?: boolean;
}

const PRIMARY_FIELDS: EndpointDef[] = [
  { field: 'token_endpoint', mode: 'token-exchange' },
  { field: 'authorization_endpoint', mode: 'authorize-stub' },
  { field: 'device_authorization_endpoint', mode: 'device-code' },
  { field: 'api_base_url', mode: 'bearer-swap', prefixMatch: true },
];

const SECONDARY_FIELDS: EndpointDef[] = [
  { field: 'revocation_endpoint', mode: 'bearer-swap' },
  { field: 'userinfo_endpoint', mode: 'bearer-swap' },
];

function parseEndpointUrl(url: string): { host: string; path: string } | null {
  const m = url.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const host = m[1].replace(/:\d+$/, '');
  const pathStr = m[2] || '/';
  return { host, path: pathStr };
}

/**
 * Build anchor and optional hostPattern from a hostname.
 *
 * Fixed host: anchor = exact host, no hostPattern.
 * Templated host: anchor = fixed suffix, hostPattern = regex with named groups.
 *
 * Returns null if the host is fully templated (no fixed suffix).
 */
export function buildHostMatch(host: string): {
  anchor: string;
  hostPattern?: RegExp;
  scopeKeys: string[];
} | null {
  // Lowercase at the oauth-file boundary. `new URL().host` is already
  // lowercase, but raw `_api_hosts` strings from JSON are not — and the
  // whole pipeline assumes lowercase domains.
  host = host.toLowerCase();
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(host)) {
    return { anchor: host, scopeKeys: [] };
  }

  const parts = host.split('.');
  const fixedSuffix: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    PLACEHOLDER_RE.lastIndex = 0;
    if (PLACEHOLDER_RE.test(parts[i])) break;
    fixedSuffix.unshift(parts[i]);
  }

  if (fixedSuffix.length === 0) return null;
  const anchor = fixedSuffix.join('.');

  const regexSource = parts
    .map((part) => {
      PLACEHOLDER_RE.lastIndex = 0;
      if (PLACEHOLDER_RE.test(part)) {
        PLACEHOLDER_RE.lastIndex = 0;
        return part.replace(PLACEHOLDER_RE, '(?<$1>[^.]+)');
      }
      return escapeRegex(part);
    })
    .join('\\.');

  const hostPattern = new RegExp(`^${regexSource}$`);

  const scopeKeys: string[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(host)) !== null) {
    scopeKeys.push(m[1]);
  }

  return { anchor, hostPattern, scopeKeys };
}

export function buildPathPattern(urlPath: string, prefixMatch: boolean): RegExp {
  PLACEHOLDER_RE.lastIndex = 0;
  const regexSource = urlPath
    .split('/')
    .map((seg) => {
      PLACEHOLDER_RE.lastIndex = 0;
      if (PLACEHOLDER_RE.test(seg)) return '[^/]+';
      return escapeRegex(seg);
    })
    .join('/');

  if (prefixMatch) return new RegExp(`^${regexSource}`);
  return new RegExp(`^${regexSource}$`);
}

// ── Discovery file → OAuthProvider ────────────────────────────────────

/**
 * Parse a single discovery file into an OAuthProvider.
 * Returns null if the file produces no usable rules.
 */
export function parseDiscoveryFile(id: string, data: DiscoveryFile): OAuthProvider | null {
  const rules: InterceptRule[] = [];
  const allScopeKeys = new Set<string>();
  const hostsWithEndpoints = new Set<string>();
  const hostsWithBearerSwap = new Set<string>();

  const processFields = (defs: EndpointDef[]): void => {
    for (const def of defs) {
      const url = data[def.field] as string | undefined;
      if (!url || typeof url !== 'string') continue;
      const parsed = parseEndpointUrl(url);
      if (!parsed) continue;
      const hostMatch = buildHostMatch(parsed.host);
      if (!hostMatch) continue;

      hostsWithEndpoints.add(parsed.host);
      if (def.mode === 'bearer-swap') hostsWithBearerSwap.add(parsed.host);
      for (const key of hostMatch.scopeKeys) allScopeKeys.add(key);

      rules.push({
        anchor: hostMatch.anchor,
        hostPattern: hostMatch.hostPattern,
        pathPattern: buildPathPattern(parsed.path, def.prefixMatch ?? false),
        mode: def.mode,
      });
    }
  };

  processFields(PRIMARY_FIELDS);

  // _api_hosts: additional bearer-swap hosts (primary)
  if (data._api_hosts) {
    for (const apiHost of data._api_hosts) {
      const hostMatch = buildHostMatch(apiHost);
      if (!hostMatch) continue;
      for (const key of hostMatch.scopeKeys) allScopeKeys.add(key);
      rules.push({
        anchor: hostMatch.anchor,
        hostPattern: hostMatch.hostPattern,
        pathPattern: /^\//,
        mode: 'bearer-swap',
      });
      hostsWithBearerSwap.add(apiHost);
    }
  }

  // Catch-all bearer-swap for endpoint hosts without an explicit one
  if (!data.api_base_url && !data._api_hosts) {
    for (const host of hostsWithEndpoints) {
      if (hostsWithBearerSwap.has(host)) continue;
      const hostMatch = buildHostMatch(host);
      if (!hostMatch) continue;
      rules.push({
        anchor: hostMatch.anchor,
        hostPattern: hostMatch.hostPattern,
        pathPattern: /^\//,
        mode: 'bearer-swap',
      });
    }
  }

  if (rules.length === 0) {
    logger.debug({ id }, 'oauth.discovery: no usable rules');
    return null;
  }

  processFields(SECONDARY_FIELDS);

  // Substitute config
  let substituteConfig: SubstituteConfig = DEFAULT_SUBSTITUTE_CONFIG;
  if (data._token_format) {
    substituteConfig = {
      prefixLen: data._token_format.prefixLen ?? DEFAULT_SUBSTITUTE_CONFIG.prefixLen,
      suffixLen: data._token_format.suffixLen ?? DEFAULT_SUBSTITUTE_CONFIG.suffixLen,
      delimiters: data._token_format.delimiters ?? DEFAULT_SUBSTITUTE_CONFIG.delimiters,
    };
  }

  // Env bindings
  let envBindings: EnvVarBinding[] | undefined;
  if (data._env_vars) {
    envBindings = [];
    for (const [envName, raw] of Object.entries(data._env_vars)) {
      const b = parseEnvVarValue(envName, raw);
      if (!b) {
        logger.warn({ id, envName, raw }, 'oauth.discovery: bad _env_vars entry');
        continue;
      }
      envBindings.push(b);
    }
  }

  let credentialFormat: Record<string, CredentialFormatSpec> | undefined;
  if (data._credential_format) {
    credentialFormat = data._credential_format;
    // Auto-extend delimiters with sep chars so the substitute engine
    // preserves them while randomizing the middle.
    const extra = new Set<string>();
    for (const spec of Object.values(credentialFormat)) {
      if (spec.sep) for (const ch of spec.sep) extra.add(ch);
    }
    if (extra.size > 0) {
      const existing = new Set(substituteConfig.delimiters);
      for (const ch of extra) existing.add(ch);
      substituteConfig = {
        ...substituteConfig,
        delimiters: [...existing].join(''),
      };
    }
  }

  let tokenFieldCapture: OAuthProvider['tokenFieldCapture'];
  if (data._token_field_capture) {
    const c = data._token_field_capture;
    tokenFieldCapture = {
      ...(c.from_request && { fromRequest: c.from_request }),
      ...(c.from_response && { fromResponse: c.from_response }),
      ...(c.scope_exclude && { scopeExclude: c.scope_exclude }),
      ...(c.scope_include && { scopeInclude: c.scope_include }),
    };
  }

  const refreshStrategy: RefreshStrategy = data._refresh_strategy ?? 'redirect';

  return {
    id,
    rules,
    scopeKeys: [...allScopeKeys],
    substituteConfig,
    refreshStrategy,
    ...(envBindings && envBindings.length > 0 && { envBindings }),
    ...(credentialFormat && { credentialFormat }),
    ...(tokenFieldCapture && { tokenFieldCapture }),
  };
}

// ── Baseline + override merge ─────────────────────────────────────────

/**
 * Merge a baseline discovery file with an optional override.
 * Standard fields from the override win; `_*` custom fields always
 * come from the baseline.
 */
export function mergeDiscoveryData(baseline: DiscoveryFile, override: Record<string, unknown> | null): DiscoveryFile {
  if (!override) return baseline;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(baseline)) merged[k] = v;
  for (const [k, v] of Object.entries(override)) {
    if (!k.startsWith('_')) merged[k] = v;
  }
  return merged as DiscoveryFile;
}

// ── Directory readers ─────────────────────────────────────────────────

function readJsonDir(dir: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== OAUTH_LOAD_REPORT_FILENAME);
  } catch {
    return result;
  }
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      result.set(file.replace(/\.json$/, ''), JSON.parse(content));
    } catch (err) {
      logger.warn({ err, file, dir }, 'oauth.discovery: unparseable file, skipping');
    }
  }
  return result;
}

export interface DiscoveryLoadResult {
  providers: Map<string, OAuthProvider>;
  /** Merged raw data for each loaded provider (refresh path uses this). */
  rawData: Map<string, DiscoveryFile>;
}

/**
 * Load all baseline discovery files, merging with overrides from
 * `overrideDir`. Missing override dir is fine; warn-and-skip files in
 * the override dir that have no baseline counterpart.
 */
export function loadDiscoveryProviders(baselineDir: string, overrideDir?: string): DiscoveryLoadResult {
  const providers = new Map<string, OAuthProvider>();
  const rawData = new Map<string, DiscoveryFile>();

  let baselineFiles: string[];
  try {
    baselineFiles = fs.readdirSync(baselineDir).filter((f) => f.endsWith('.json') && f !== OAUTH_LOAD_REPORT_FILENAME);
  } catch (err) {
    logger.warn({ err, baselineDir }, 'oauth.discovery: cannot read baseline dir');
    return { providers, rawData };
  }

  const overrides = overrideDir ? readJsonDir(overrideDir) : new Map();
  if (overrides.size > 0) {
    logger.info({ count: overrides.size, overrideDir }, 'oauth.discovery: loaded override files');
  }

  for (const file of baselineFiles) {
    const id = file.replace(/\.json$/, '');
    try {
      const content = fs.readFileSync(path.join(baselineDir, file), 'utf-8');
      const baselineData = JSON.parse(content) as DiscoveryFile;
      const data = mergeDiscoveryData(baselineData, overrides.get(id) ?? null);
      rawData.set(id, data);

      const provider = parseDiscoveryFile(id, data);
      if (provider) providers.set(id, provider);
    } catch (err) {
      logger.warn({ err, file }, 'oauth.discovery: bad baseline file, skipping');
    }
  }

  for (const overrideId of overrides.keys()) {
    if (!rawData.has(overrideId)) {
      logger.warn({ id: overrideId }, 'oauth.discovery: override has no baseline counterpart, skipping');
    }
  }

  logger.info({ count: providers.size, total: baselineFiles.length }, 'oauth.discovery: loaded providers');

  return { providers, rawData };
}
