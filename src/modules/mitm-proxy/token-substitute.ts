/**
 * Format-preserving token substitute engine — substitution-only port.
 *
 * Generates substitute tokens that look like the real ones (same prefix,
 * suffix, delimiter positions, character classes) but with randomized
 * middle sections. Containers never see real tokens — only substitutes.
 *
 * The engine does NOT store credentials. It maintains substitute → identity
 * mappings (`ProviderSubstitutes` keyed by `GroupScope` and `providerId`)
 * and reads real credentials through an injected `EngineCredentialResolver`
 * (typically the v2 credentials module's resolver). Producer-side flows
 * (writing credentials, refresh, importEnv, manifest publishing) belong
 * in the OAuth module — see `docs/fls/mitm-proxy-oauth-readd.md`.
 *
 * Internal structure:
 *   scopes:         Map<GroupScope, Map<providerId, ProviderSubstitutes>>
 *   subToProvider:  Map<substitute, { groupScope, providerId }>  (reverse index)
 *
 * Refs persistence (`{credentialsDir}/{groupScope}/{providerId}.refs.json`)
 * is substitution-only state; the engine owns the V4 format directly.
 */
import fs from 'fs';
import path from 'path';

import { credentialsDir } from '../credentials/index.js';
import { getCredentialProvider } from '../credentials/providers/registry.js';

import type {
  Credential,
  CredentialScope,
  EngineCredentialResolver,
  GroupScope,
  ProviderSubstitutes,
  ResolverFactory,
  ScopeAccessCheck,
  SubstituteEntry,
  SubstituteMapping,
} from './types.js';
import { asCredentialScope, asGroupScope, CRED_OAUTH, extractToken, isSubstitutingProvider } from './types.js';
import { logger } from './logger.js';

/** Max attempts when asking a provider for a non-colliding substitute. */
const MAX_GENERATE_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Credential path helpers
// ---------------------------------------------------------------------------

/**
 * Parse a credentialPath into its top-level credential id and optional
 * nested sub-token name. `'oauth'` → `{ id: 'oauth' }`,
 * `'oauth/refresh'` → `{ id: 'oauth', nested: 'refresh' }`.
 */
function parsePath(credentialPath: string): { id: string; nested?: string } {
  const slash = credentialPath.indexOf('/');
  if (slash === -1) return { id: credentialPath };
  return { id: credentialPath.slice(0, slash), nested: credentialPath.slice(slash + 1) };
}

function resolveCredentialPathToRealToken(
  resolver: EngineCredentialResolver,
  credentialScope: CredentialScope,
  providerId: string,
  credentialPath: string,
): { token: string; boundDomain?: string } | null {
  const { id, nested } = parsePath(credentialPath);
  const cred = resolver.resolve(credentialScope, providerId, id);
  if (!cred) return null;
  const token = extractToken(cred, nested);
  if (!token) return null;
  return cred.boundDomain !== undefined ? { token, boundDomain: cred.boundDomain } : { token };
}

/**
 * The engine routes every read through the resolver for the calling
 * group. The credentials module's per-group resolver enforces its own
 * `canAccess(ownFolder, scope)` check, which is exactly the borrow
 * gate the engine needs — no duplicated access logic here.
 */

function toCredentialScope(groupScope: GroupScope): CredentialScope {
  return asCredentialScope(groupScope);
}

// ---------------------------------------------------------------------------
// Refs file (substitution-only state) — V4 only
// ---------------------------------------------------------------------------

interface RefsFileV4 {
  v: 4;
  substitutes: Record<
    string,
    {
      credentialPath: string;
      scopeAttrs: Record<string, string>;
      sourceScope?: string;
      envNames?: string[];
    }
  >;
}

function refsPath(groupScope: GroupScope, providerId: string): string {
  return path.join(credentialsDir(), groupScope, `${providerId}.refs.json`);
}

function readJsonFile<T extends object>(filePath: string): T {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return {} as T;
    throw err;
  }
  if (!content.trim()) return {} as T;
  return JSON.parse(content) as T;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ResolvedToken {
  realToken: string;
  mapping: SubstituteMapping;
  /**
   * Sourcing host stamped on the credential (non-global only). Surfaced here
   * so the bearer-swap bound-domain guard reads it off the resolution result
   * — no second credential lookup. Absent for global credentials.
   */
  boundDomain?: string;
}

/**
 * Hook for resolving a group's borrow source (set by the OAuth module
 * when borrow flags exist). Returns the credential scope name to borrow
 * from, or undefined for own-scope. Substitution-only trunk leaves this
 * unset; engine treats every group as borrowing from its own scope.
 */
export type BorrowSourceResolver = (groupScope: GroupScope) => string | undefined;

export class TokenSubstituteEngine {
  /** Two-level lookup: GroupScope → providerId → ProviderSubstitutes. */
  private scopes = new Map<GroupScope, Map<string, ProviderSubstitutes>>();

  /** Reverse index: substitute string → { groupScope, providerId }. */
  private subToProvider = new Map<string, { groupScope: GroupScope; providerId: string }>();

  private accessCheck: ScopeAccessCheck | null = null;
  private borrowSource: BorrowSourceResolver | null = null;

  constructor(private resolverFactory: ResolverFactory) {}

  /**
   * Pick the resolver for the calling group. The credentials module
   * returns a per-group instance whose access check already enforces
   * borrow gating; we route every engine read through it.
   */
  private resolverFor(groupScope: GroupScope): EngineCredentialResolver {
    return this.resolverFactory(groupScope);
  }

  // ── Configuration ───────────────────────────────────────────────────

  setAccessCheck(check: ScopeAccessCheck): void {
    this.accessCheck = check;
  }

  /**
   * Wire the borrow-source resolver. Without one, all groups are own-scope.
   * The OAuth module sets this once at startup.
   */
  setBorrowSourceResolver(fn: BorrowSourceResolver): void {
    this.borrowSource = fn;
  }

  // ── State helpers ───────────────────────────────────────────────────

  private providerMap(groupScope: GroupScope): Map<string, ProviderSubstitutes> {
    let map = this.scopes.get(groupScope);
    if (!map) {
      map = new Map();
      this.scopes.set(groupScope, map);
    }
    return map;
  }

  private getOrCreateProvSubs(groupScope: GroupScope, providerId: string): ProviderSubstitutes {
    const pmap = this.providerMap(groupScope);
    let ps = pmap.get(providerId);
    if (!ps) {
      ps = { substitutes: new Map() };
      pmap.set(providerId, ps);
    }
    return ps;
  }

  private insertSub(groupScope: GroupScope, providerId: string, substitute: string, entry: SubstituteEntry): void {
    const ps = this.getOrCreateProvSubs(groupScope, providerId);
    ps.substitutes.set(substitute, entry);
    this.subToProvider.set(substitute, { groupScope, providerId });
  }

  private effectiveScopeForEntry(groupScope: GroupScope, entry: SubstituteEntry): CredentialScope {
    return entry.sourceScope ?? toCredentialScope(groupScope);
  }

  private findEntryByPath(ps: ProviderSubstitutes, credentialPath: string): SubstituteEntry | undefined {
    for (const entry of ps.substitutes.values()) {
      if (entry.credentialPath === credentialPath) return entry;
    }
    return undefined;
  }

  /** For nested paths (e.g. oauth/refresh), inherit sourceScope from the parent entry. */
  private findParentSourceScope(
    groupScope: GroupScope,
    providerId: string,
    credentialPath: string,
  ): CredentialScope | undefined {
    const { id, nested } = parsePath(credentialPath);
    if (!nested) return undefined;
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return undefined;
    return this.findEntryByPath(ps, id)?.sourceScope;
  }

  // ── Credential scope resolution ─────────────────────────────────────

  /**
   * For a (group, provider, credentialPath), determine whether the
   * credential comes from the group's own scope or a borrowed source scope.
   * Borrow resolution falls back to own scope when no `BorrowSourceResolver`
   * is wired (substitution-only trunk).
   */
  resolveCredentialScope(groupScope: GroupScope, providerId: string, credentialPath: string): CredentialScope {
    const { id: credentialId } = parsePath(credentialPath);
    const ownScope = toCredentialScope(groupScope);
    const resolver = this.resolverFor(groupScope);

    if (resolver.resolve(ownScope, providerId, credentialId)) return ownScope;

    const sourceName = this.borrowSource?.(groupScope);
    if (sourceName) {
      const sourceScope = asCredentialScope(sourceName);
      if (
        resolver.resolve(sourceScope, providerId, credentialId) &&
        (!this.accessCheck || this.accessCheck(groupScope, sourceScope))
      ) {
        return sourceScope;
      }
    }

    return ownScope;
  }

  // ── Env name merging ────────────────────────────────────────────────

  /** Merge additional env var names into an existing substitute entry. */
  mergeEnvNames(groupScope: GroupScope, providerId: string, substitute: string, newNames: string[]): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    const entry = ps?.substitutes.get(substitute);
    if (!entry) return;

    const existing = new Set(entry.envNames ?? []);
    const sizeBefore = existing.size;
    for (const name of newNames) existing.add(name);
    if (existing.size === sizeBefore) return;

    entry.envNames = [...existing].sort();
    this.persistRefs(groupScope, providerId);
  }

  // ── Public lookup ───────────────────────────────────────────────────

  /**
   * Get an existing substitute for (providerId, groupScope, credentialPath).
   * When multiple exist, returns the first when sorted (deterministic).
   */
  getSubstitute(providerId: string, groupScope: GroupScope, credentialPath: string = CRED_OAUTH): string | null {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return null;
    const matches: string[] = [];
    for (const [sub, entry] of ps.substitutes) {
      if (entry.credentialPath === credentialPath) matches.push(sub);
    }
    if (matches.length === 0) return null;
    return matches.sort()[0];
  }

  /**
   * Get an existing substitute or ask the provider to generate one for
   * the resolver's stored credential. The engine is a pure cache + a
   * collision/retry loop; substitute *shape* lives entirely on the
   * `SubstitutingProvider`.
   */
  getOrCreateSubstitute(
    providerId: string,
    scopeAttrs: Record<string, string>,
    groupScope: GroupScope,
    credentialPath: string = CRED_OAUTH,
    envNames?: string[],
  ): string | null {
    const existing = this.getSubstitute(providerId, groupScope, credentialPath);
    if (existing) {
      if (envNames && envNames.length > 0) {
        this.mergeEnvNames(groupScope, providerId, existing, envNames);
      }
      return existing;
    }

    // Scope-aware: per-group `.auth-discovery/` providers live only in the
    // caller scope's tier, not the global registry. Without the scope the
    // lookup misses them and minting silently fails — the path that let a
    // real OAuth token reach the container instead of a substitute.
    const provider = getCredentialProvider(providerId, toCredentialScope(groupScope));
    if (!provider || !isSubstitutingProvider(provider)) {
      logger.warn({ providerId }, 'getOrCreateSubstitute: provider not registered (or not substituting)');
      return null;
    }

    const credScope = this.resolveCredentialScope(groupScope, providerId, credentialPath);
    const ownCredScope = toCredentialScope(groupScope);
    const sourceScope = credScope !== ownCredScope ? credScope : undefined;

    const resolved = resolveCredentialPathToRealToken(
      this.resolverFor(groupScope),
      credScope,
      providerId,
      credentialPath,
    );
    if (!resolved) return null;
    const realToken = resolved.token;

    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
      const candidate = provider.substitutes.generateSubstitute(realToken, credentialPath);
      if (candidate === null) return null;
      if (candidate === realToken) continue;
      if (this.subToProvider.has(candidate)) continue;

      const effectiveSource = sourceScope ?? this.findParentSourceScope(groupScope, providerId, credentialPath);
      const entry: SubstituteEntry = { credentialPath, scopeAttrs };
      if (effectiveSource) entry.sourceScope = effectiveSource;
      if (envNames && envNames.length > 0) entry.envNames = [...new Set(envNames)];
      this.insertSub(groupScope, providerId, candidate, entry);
      this.persistRefs(groupScope, providerId);

      return candidate;
    }

    logger.warn(
      { providerId, credentialPath, attempts: MAX_GENERATE_ATTEMPTS },
      'Substitute generation exhausted retries (collision or echo)',
    );
    return null;
  }

  /**
   * Resolve a substitute to the real token + mapping. Returns null if
   * unknown substitute, mismatched scope, access-revoked borrow, or
   * resolver can't find the credential.
   */
  resolveSubstitute(substitute: string, groupScope: GroupScope): ResolvedToken | null {
    const ref = this.subToProvider.get(substitute);
    if (!ref || ref.groupScope !== groupScope) return null;

    const ps = this.scopes.get(groupScope)?.get(ref.providerId);
    if (!ps) return null;

    const entry = ps.substitutes.get(substitute);
    if (!entry) return null;

    if (entry.sourceScope && this.accessCheck) {
      if (!this.accessCheck(groupScope, entry.sourceScope)) {
        // Borrow access revoked — drop the entry and report not-found.
        ps.substitutes.delete(substitute);
        this.subToProvider.delete(substitute);
        this.persistRefs(groupScope, ref.providerId);
        return null;
      }
    }

    const effCredScope = this.effectiveScopeForEntry(groupScope, entry);
    const resolved = resolveCredentialPathToRealToken(
      this.resolverFor(groupScope),
      effCredScope,
      ref.providerId,
      entry.credentialPath,
    );
    if (!resolved) return null;

    return {
      realToken: resolved.token,
      mapping: {
        providerId: ref.providerId,
        credentialPath: entry.credentialPath,
        scopeAttrs: entry.scopeAttrs,
        credentialScope: effCredScope,
      },
      ...(resolved.boundDomain !== undefined && { boundDomain: resolved.boundDomain }),
    };
  }

  /** Resolve with scope attribute restriction. */
  resolveWithRestriction(
    substitute: string,
    groupScope: GroupScope,
    requiredAttrs: Record<string, string>,
  ): ResolvedToken | null {
    const resolved = this.resolveSubstitute(substitute, groupScope);
    if (!resolved) return null;

    const requiredKeys = Object.keys(requiredAttrs);
    if (requiredKeys.length === 0) return resolved;

    for (const key of requiredKeys) {
      const entryVal = resolved.mapping.scopeAttrs[key];
      if (entryVal !== undefined && entryVal !== requiredAttrs[key]) {
        return null;
      }
    }
    return resolved;
  }

  /**
   * Resolve a real token for (group, provider, credentialPath) without
   * going through a substitute. Handles sourceScope indirection.
   */
  resolveRealToken(groupScope: GroupScope, providerId: string, credentialPath: string): string | null {
    const credScope = this.resolveCredentialScope(groupScope, providerId, credentialPath);
    return (
      resolveCredentialPathToRealToken(this.resolverFor(groupScope), credScope, providerId, credentialPath)?.token ??
      null
    );
  }

  /** Resolve a cached Credential by (group, provider, credentialId). */
  resolveCredential(groupScope: GroupScope, providerId: string, credentialId: string): Credential | null {
    const credScope = this.resolveCredentialScope(groupScope, providerId, credentialId);
    return this.resolverFor(groupScope).resolve(credScope, providerId, credentialId);
  }

  // ── Substitute lifecycle ────────────────────────────────────────────

  /**
   * Drop all substitutes for a (group, provider) — clears the in-memory
   * maps and the refs file. Does NOT touch stored credentials; credential
   * lifecycle lives in the credentials module.
   */
  dropProviderSubstitutes(groupScope: GroupScope, providerId: string): number {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return 0;
    const count = ps.substitutes.size;
    for (const sub of ps.substitutes.keys()) {
      this.subToProvider.delete(sub);
    }
    this.scopes.get(groupScope)!.delete(providerId);
    if (this.scopes.get(groupScope)!.size === 0) this.scopes.delete(groupScope);
    this.deleteRefs(groupScope, providerId);
    return count;
  }

  /** Drop substitutes for a whole group scope. */
  dropGroupSubstitutes(groupScope: GroupScope): number {
    const pmap = this.scopes.get(groupScope);
    if (!pmap) return 0;
    let count = 0;
    for (const [pid, ps] of pmap) {
      count += ps.substitutes.size;
      for (const sub of ps.substitutes.keys()) {
        this.subToProvider.delete(sub);
      }
      this.deleteRefs(groupScope, pid);
    }
    this.scopes.delete(groupScope);
    return count;
  }

  /**
   * Remove substitute refs whose credential is no longer present in the
   * resolver. Called when credentials change underneath the engine.
   */
  pruneStaleRefs(groupScope: GroupScope, providerId: string): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return;

    const resolver = this.resolverFor(groupScope);
    const toRemove: string[] = [];
    for (const [sub, entry] of ps.substitutes) {
      const effCredScope = this.effectiveScopeForEntry(groupScope, entry);
      const realToken = resolveCredentialPathToRealToken(resolver, effCredScope, providerId, entry.credentialPath);
      if (!realToken) toRemove.push(sub);
    }

    for (const sub of toRemove) {
      ps.substitutes.delete(sub);
      this.subToProvider.delete(sub);
    }

    if (ps.substitutes.size === 0) {
      this.scopes.get(groupScope)?.delete(providerId);
      if (this.scopes.get(groupScope)?.size === 0) this.scopes.delete(groupScope);
      this.deleteRefs(groupScope, providerId);
    } else {
      this.persistRefs(groupScope, providerId);
    }
  }

  // ── Env vars ────────────────────────────────────────────────────────

  /** Collect all envName → substitute assignments for a group scope. */
  collectEnvVars(groupScope: GroupScope): Record<string, string> {
    const result: Record<string, string> = {};
    const providers = this.scopes.get(groupScope);
    if (!providers) return result;
    for (const [, ps] of providers) {
      for (const [substitute, entry] of ps.substitutes) {
        if (!entry.envNames) continue;
        for (const name of entry.envNames) {
          result[name] = substitute;
        }
      }
    }
    return result;
  }

  // ── Metrics ─────────────────────────────────────────────────────────

  get size(): number {
    return this.subToProvider.size;
  }

  get scopeCount(): number {
    return this.scopes.size;
  }

  // ── Refs persistence ────────────────────────────────────────────────

  private persistRefs(groupScope: GroupScope, providerId: string): void {
    const ps = this.scopes.get(groupScope)?.get(providerId);
    if (!ps) return;

    const data: RefsFileV4 = { v: 4, substitutes: {} };
    for (const [sub, entry] of ps.substitutes) {
      const ref: RefsFileV4['substitutes'][string] = {
        credentialPath: entry.credentialPath,
        scopeAttrs: entry.scopeAttrs,
      };
      if (entry.sourceScope && (entry.sourceScope as string) !== (groupScope as string)) {
        ref.sourceScope = entry.sourceScope as string;
      }
      if (entry.envNames && entry.envNames.length > 0) {
        ref.envNames = entry.envNames;
      }
      data.substitutes[sub] = ref;
    }

    try {
      const filePath = refsPath(groupScope, providerId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    } catch (err) {
      logger.warn({ err, groupScope, providerId }, 'Refs persistence failed');
    }
  }

  private deleteRefs(groupScope: GroupScope, providerId: string): void {
    try {
      fs.unlinkSync(refsPath(groupScope, providerId));
    } catch {
      /* already gone */
    }
  }

  /**
   * Load persisted refs for a (groupScope, providerId). V4 format only —
   * V2/V3 migration was completed in v1; if a legacy file appears it is
   * silently skipped (logged at debug). Returns the number of substitutes
   * loaded.
   */
  loadPersistedRefs(groupScope: GroupScope, providerId: string): number {
    const raw = readJsonFile<Record<string, unknown>>(refsPath(groupScope, providerId));
    if (raw.v !== 4 || !raw.substitutes || typeof raw.substitutes !== 'object') {
      if (Object.keys(raw).length > 0) {
        logger.debug({ groupScope, providerId, version: raw.v }, 'Skipping non-V4 refs file (legacy format)');
      }
      return 0;
    }

    const subs = raw.substitutes as Record<string, Record<string, unknown>>;
    const entries = Object.entries(subs);
    if (entries.length === 0) return 0;

    for (const [substitute, entryRaw] of entries) {
      const credentialPath = entryRaw.credentialPath as string;
      const rawSource = entryRaw.sourceScope as string | undefined;
      const entrySourceScope =
        rawSource && rawSource !== (groupScope as string) ? asCredentialScope(rawSource) : undefined;

      const entry: SubstituteEntry = {
        credentialPath,
        scopeAttrs: (entryRaw.scopeAttrs as Record<string, string>) ?? {},
      };
      if (entrySourceScope) entry.sourceScope = entrySourceScope;
      const rawEnvNames = entryRaw.envNames as string[] | undefined;
      if (rawEnvNames && rawEnvNames.length > 0) entry.envNames = [...new Set(rawEnvNames)];
      this.insertSub(groupScope, providerId, substitute, entry);
    }

    return this.scopes.get(groupScope)?.get(providerId)?.substitutes.size ?? 0;
  }

  /** Scan the credentials root for refs files and load them. */
  loadAllPersistedRefs(): number {
    let total = 0;
    const root = credentialsDir();
    try {
      if (!fs.existsSync(root)) return 0;
      const scopeDirs = fs.readdirSync(root, { withFileTypes: true });
      for (const dir of scopeDirs) {
        if (!dir.isDirectory()) continue;
        const scopePath = path.join(root, dir.name);
        const files = fs.readdirSync(scopePath);
        for (const file of files) {
          const m = /^(.+)\.refs\.json$/.exec(file);
          if (m) {
            total += this.loadPersistedRefs(asGroupScope(dir.name), m[1]);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to scan for persisted refs');
    }
    return total;
  }
}

// Re-export for callers that still import Credential / AuthToken from here.
export type { Credential } from './types.js';

// ---------------------------------------------------------------------------
// Engine singleton
// ---------------------------------------------------------------------------

let _engine: TokenSubstituteEngine | null = null;
let _factory: ResolverFactory | null = null;

/**
 * Wire the per-group resolver factory the engine multiplexes through.
 * Call once at host startup. The credentials module supplies the
 * production factory:
 *
 *   initTokenEngine((scope) => getOrCreateResolverForAgentGroup(scope));
 *
 * Tests can pass a factory backed by a mock resolver.
 */
export function initTokenEngine(factory: ResolverFactory): TokenSubstituteEngine {
  if (_engine) {
    throw new Error('initTokenEngine: engine already initialized');
  }
  _factory = factory;
  _engine = new TokenSubstituteEngine(factory);
  return _engine;
}

export function getTokenEngine(): TokenSubstituteEngine {
  if (!_engine) {
    throw new Error('getTokenEngine: call initTokenEngine() first');
  }
  return _engine;
}

/** @internal Override the engine (e2e tests). */
export function setTokenEngine(engine: TokenSubstituteEngine | null): void {
  _engine = engine;
}

export function _resetTokenEngineForTests(): void {
  _engine = null;
  _factory = null;
}

/** @internal Test helper. */
export function _getEngineFactoryForTests(): ResolverFactory | null {
  return _factory;
}
