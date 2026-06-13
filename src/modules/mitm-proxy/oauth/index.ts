/**
 * OAuth detection + handling on top of the v2 MITM credential proxy.
 *
 * This module is intentionally scoped to *detection and handling*:
 *
 *   - Detection — load 60+ baseline OAuth provider JSONs from
 *     `./discovery/`, optionally merge per-install overrides from
 *     `~/.config/nanoclaw/auth-discovery/`, build intercept rules,
 *     and register each provider with the credentials registry + the
 *     proxy's anchor index.
 *
 *   - Handling — for traffic matching a provider's intercept rules,
 *     run the bearer-swap and token-exchange paths (plus the
 *     refresh-on-401 loop), all closing over a single `HandlerContext`.
 *
 * Out of scope in this first cut (deliberately deferred — do not grow
 * the module sideways into these):
 *   - `authorize-stub` and `device-code` handler modes.
 *   - `/auth/browser-open` and `/interaction/*` HTTP endpoints.
 *   - Provider-info file publishing (`/auth` UX) and `/creds` commands.
 *   - GPG, manifest pipeline, key management, importEnv, V2→V3 keys
 *     migration.
 *   - Scheduled discovery refresh (a lazy one-shot at init is all this
 *     PR ships).
 *
 * The header comment must stay in sync with
 * `docs/fls/mitm-proxy-oauth-readd.md` — if you find yourself wanting
 * to add one of the items above, update the readd doc first.
 */
import fs from 'fs';
import path from 'path';

import { registerCredentialProvider, setScopedCredentialProviders } from '../../credentials/providers/registry.js';
import { getOrCreateResolverForAgentGroup } from '../../credentials/resolver.js';
import { isEnvNameReserved } from '../../container-bootstrap/index.js';
import { getProxy, hasProxyInstance } from '../credential-proxy.js';
import type { CredentialProxy } from '../credential-proxy.js';
import type { GroupScope } from '../types.js';
import { asCredentialScope } from '../types.js';
import { getTokenEngine } from '../token-substitute.js';

import {
  baselineDiscoveryDir,
  overrideDiscoveryDir,
  groupDiscoveryDir,
  OAUTH_LOAD_REPORT_FILENAME,
} from './discovery-paths.js';
import { loadDiscoveryProviders, type DiscoveryLoadResult } from './discovery-loader.js';
import { startDiscoveryRefreshSchedule, type RefreshResult, type RefreshScheduleHandle } from './discovery-refresh.js';
import { toSubstitutingProvider } from './provider-adapter.js';
import type { AuthCodeDeliver, HandlerContext, OAuthEvents } from './handler-context.js';
import type { OAuthProvider } from './types.js';
import type { SubstitutesSpec, SubstitutingProvider } from '../types.js';
import { logger } from '../logger.js';

export type { OAuthProvider, InterceptRule, RefreshStrategy, DiscoveryFile } from './types.js';

export interface OAuthModuleHandle {
  /** Provider ids actually registered with the proxy. */
  providers: readonly string[];
  /** Resolves after the initial startup refresh sweep completes (or no-ops). */
  discoveryRefreshDone: Promise<RefreshResult | null>;
  /**
   * The recurring discovery-refresh schedule (C14), or null if refresh is
   * disabled. Call `.stop()` to cancel the timer (host shutdown / tests); the
   * interval is `unref`'d so leaving it running never blocks process exit.
   */
  discoveryRefreshSchedule: RefreshScheduleHandle | null;
}

export interface InitOAuthModuleOptions {
  proxy: CredentialProxy;
  /** Default: true. Set to false for a complete no-op (no providers loaded). */
  enabled?: boolean;
  /** Default: `~/.config/nanoclaw/auth-discovery/`. */
  overrideDir?: string;
  /** Default: true. Pass false to skip discovery refresh entirely (no schedule). */
  refreshEnabled?: boolean;
  /** Per-file staleness threshold; a file is only re-fetched if older. Default 24h. */
  refreshStaleMs?: number;
  /** Sweep cadence for the recurring refresh (C14). Default: `refreshStaleMs`. */
  refreshIntervalMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /**
   * Host surface for the interactive OAuth modes (`device-code`,
   * `authorize-stub`). Wired at boot from `../oauth-interactive.ts`. Absent
   * → those handlers degrade to a no-op notice / pass-through.
   */
  oauthEvents?: OAuthEvents;
  /**
   * Code-delivery primitive the authorize-stub handler forwards into
   * `oauthEvents.beginAuthorizeStub`. Wired at boot alongside `oauthEvents`
   * (`dockerExecDeliver`). Absent → authorize-stub passes through.
   */
  deliverCallback?: AuthCodeDeliver;
}

/**
 * Interactive-OAuth surface captured at `initOAuthModule` time so the
 * per-container loader (`loadGroupProvidersForContainer`, a separate call
 * path) can hand the same seam to group-defined device-code/authorize-stub
 * providers. Undefined until the host wires it; the handlers degrade
 * gracefully when so.
 */
let moduleOAuthEvents: OAuthEvents | undefined;
let moduleDeliverCallback: AuthCodeDeliver | undefined;

/**
 * Authorize-endpoint matchers captured at init, so the `/oauth/browser-open`
 * host endpoint (driven by the container `xdg-open` shim) can map a URL the
 * agent tried to open in a browser back to a provider id — and confirm it's a
 * genuine OAuth *authorize* URL, not just any host the provider claims. Only
 * the `authorize-stub`-mode rules of globally-loaded providers; per-container
 * group providers aren't covered here (their browser flows are an edge case).
 */
interface AuthorizeMatcher {
  providerId: string;
  hostPattern: RegExp;
  pathPattern: RegExp;
}
let authorizeMatchers: AuthorizeMatcher[] = [];

/**
 * Identify the provider for an authorization URL the agent asked to open.
 * Returns the provider id when the URL matches a loaded `authorize-stub`
 * rule (host + path), else null (caller treats it as a non-OAuth URL).
 */
export function matchAuthorizeUrl(host: string, path: string): string | null {
  const h = host.toLowerCase();
  for (const m of authorizeMatchers) {
    if (m.hostPattern.test(h) && m.pathPattern.test(path)) return m.providerId;
  }
  return null;
}

/**
 * Initialize the OAuth module. Call once at host startup, **after**
 * `proxy.start()` resolves.
 *
 * Steps:
 *   1. Load baseline JSONs + merge overrides.
 *   2. Build a `HandlerContext` closing over the engine + resolver
 *      factory + injected fetch.
 *   3. For each loaded provider, register a `SubstitutingProvider` with
 *      the credentials registry and call `proxy.indexProvider(...)`.
 *   4. Kick off the lazy well-known refresh into the override dir for
 *      the next process start.
 */
/**
 * Build just the `substitutes` facet (mint + env + bearer-swap/token-exchange
 * host rules) for a single, programmatically-defined provider — used for
 * providers that aren't loaded from discovery JSON (e.g. the merged `claude`
 * provider entity). Requires the token engine to be initialized.
 */
export function oauthSubstitutesFor(provider: OAuthProvider): SubstitutesSpec {
  const ctx: HandlerContext = {
    tokenEngine: getTokenEngine(),
    resolverFor: (scope) => getOrCreateResolverForAgentGroup(scope),
    fetchImpl: globalThis.fetch,
    inFlightRefresh: new Map(),
    isGlobalProvider: (id) => hasProxyInstance() && getProxy().isGlobalProvider(id),
  };
  return toSubstitutingProvider(provider, ctx).substitutes;
}

export function initOAuthModule(opts: InitOAuthModuleOptions): OAuthModuleHandle {
  if (opts.enabled === false) {
    return {
      providers: [],
      discoveryRefreshDone: Promise.resolve(null),
      discoveryRefreshSchedule: null,
    };
  }

  moduleOAuthEvents = opts.oauthEvents;
  moduleDeliverCallback = opts.deliverCallback;
  const overrideDir = opts.overrideDir ?? overrideDiscoveryDir();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const loaded: DiscoveryLoadResult = loadDiscoveryProviders(baselineDiscoveryDir(), overrideDir);

  // Capture authorize-endpoint matchers for the browser-open shim path.
  authorizeMatchers = [];
  for (const p of loaded.providers.values()) {
    for (const r of p.rules) {
      if (r.mode !== 'authorize-stub') continue;
      const hostPattern = r.hostPattern ?? new RegExp(`^${r.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      authorizeMatchers.push({ providerId: p.id, hostPattern, pathPattern: r.pathPattern });
    }
  }

  const ctx: HandlerContext = {
    tokenEngine: getTokenEngine(),
    resolverFor: (scope) => getOrCreateResolverForAgentGroup(scope),
    fetchImpl,
    inFlightRefresh: new Map(),
    isGlobalProvider: (id) => opts.proxy.isGlobalProvider(id),
    oauthEvents: opts.oauthEvents,
    deliverCallback: opts.deliverCallback,
  };

  const registered: string[] = [];
  for (const provider of loaded.providers.values()) {
    let subProvider;
    try {
      subProvider = toSubstitutingProvider(provider, ctx);
    } catch (err) {
      logger.warn({ err, providerId: provider.id }, 'oauth: provider-adapter failed, skipping');
      continue;
    }
    try {
      registerCredentialProvider(subProvider);
    } catch (err) {
      logger.warn({ err, providerId: provider.id }, 'oauth: credentials-registry rejected provider, skipping');
      continue;
    }
    try {
      opts.proxy.indexProvider(subProvider);
    } catch (err) {
      logger.warn({ err, providerId: provider.id }, 'oauth: proxy.indexProvider failed, skipping');
      continue;
    }
    registered.push(provider.id);
  }

  logger.info(
    { registered: registered.length, total: loaded.providers.size },
    'oauth: providers registered with proxy',
  );

  // C14: schedule recurring discovery refresh (was a lazy one-shot). The first
  // sweep still fires immediately — `discoveryRefreshDone` resolves with it for
  // back-compat — and subsequent sweeps repeat on the staleness cadence.
  const refreshEnabled = opts.refreshEnabled !== false;
  const discoveryRefreshSchedule: RefreshScheduleHandle | null = refreshEnabled
    ? startDiscoveryRefreshSchedule({
        baseline: loaded.rawData,
        overrideDir,
        staleMs: opts.refreshStaleMs,
        intervalMs: opts.refreshIntervalMs,
        fetchImpl,
      })
    : null;

  return {
    providers: registered,
    discoveryRefreshDone: discoveryRefreshSchedule ? discoveryRefreshSchedule.initial : Promise.resolve(null),
    discoveryRefreshSchedule,
  };
}

/**
 * Write the per-group load report back into `groups/<folder>/.auth-discovery/`.
 * Called on every load of an existing dir (container start and `reload_auth_providers`)
 * so an agent editing provider defs always sees what was installed and what was
 * rejected, with reasons. Best-effort: a write failure is logged, never thrown
 * (the report is diagnostics, not load state). The loader skips this file by
 * name (`OAUTH_LOAD_REPORT_FILENAME`) so it's never parsed as a provider def.
 */
/**
 * Remove a stale load report before a (re)load. Best-effort. Deleting up front
 * means the on-disk report always reflects the *latest* load: if the fresh
 * write later fails, the dir is left with no report rather than a misleading
 * stale one. `force: true` makes a missing file a no-op.
 */
function removeLoadReport(dir: string): void {
  try {
    fs.rmSync(path.join(dir, OAUTH_LOAD_REPORT_FILENAME), { force: true });
  } catch (err) {
    logger.warn({ err, dir }, 'oauth.group: failed to remove stale load report');
  }
}

function writeLoadReport(
  dir: string,
  report: {
    scope: GroupScope;
    ip: string;
    registered: string[];
    rejected: Array<{ id: string; reason: string }>;
    error?: string;
  },
): void {
  const body = {
    _README:
      'Auto-generated by NanoClaw on each load of this directory (container ' +
      'start and reload_auth_providers). Do not edit — it is overwritten. ' +
      "'registered' lists installed providers; 'rejected' lists ones refused, " +
      'with the reason. Fix a rejected def and trigger reload_auth_providers.',
    generatedAt: new Date().toISOString(),
    scope: String(report.scope),
    ip: report.ip,
    registered: report.registered,
    rejected: report.rejected,
    ...(report.error ? { error: report.error } : {}),
  };
  try {
    const file = path.join(dir, OAUTH_LOAD_REPORT_FILENAME);
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  } catch (err) {
    logger.warn({ err, dir }, 'oauth.group: failed to write load report');
  }
}

export interface GroupOAuthLoadResult {
  scope: GroupScope;
  ip: string;
  /** Provider ids installed into this container's tier. */
  registered: string[];
  /** Providers refused, with the reason (safety/env collision/adapter). */
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * Load one agent group's declared OAuth providers from
 * `groups/<folder>/.auth-discovery/` and install them into the
 * **per-container** tier for `ip` (the container that was just allocated
 * this IP for that scope). Called from the IP-allocate hook; the rules are
 * dropped when the IP is released. Safe to call freely — never throws; a
 * missing dir or bad file installs nothing.
 *
 * Safety filters (see `docs/fls/specs/per-group-oauth-providers.md`):
 *   1. a provider may not reuse a GLOBAL provider id;
 *   2. a rule may not use an anchor a GLOBAL provider owns — a local
 *      provider cannot widen the domain set a credential is sent to;
 *   3. a published env var name may not collide with the global reserved
 *      set, nor with another provider already accepted for this container
 *      (the env namespace is flat; match order can't disambiguate it).
 *
 * A provider failing any check is dropped whole (recorded in `rejected`);
 * the rest still load.
 */
export function loadGroupProvidersForContainer(
  scope: GroupScope,
  ip: string,
  proxy: CredentialProxy,
): GroupOAuthLoadResult {
  const registered: string[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  // A missing per-group dir is the common case (most groups declare no
  // providers) — install nothing and return quietly, no loader warn.
  const dir = groupDiscoveryDir(scope);
  if (!fs.existsSync(dir)) {
    proxy.registerContainerRules(ip, []);
    // No discovery dir ⇒ the group declares no providers; drop any stale tier.
    setScopedCredentialProviders(asCredentialScope(scope), []);
    return { scope, ip, registered, rejected };
  }

  // Drop any prior report before loading, so the report on disk always
  // corresponds to this load (a fresh one is written below on every path).
  removeLoadReport(dir);

  let loaded: DiscoveryLoadResult;
  try {
    loaded = loadDiscoveryProviders(dir);
  } catch (err) {
    logger.warn({ err, scope, ip }, 'oauth.group: load failed, installing nothing');
    proxy.registerContainerRules(ip, []);
    writeLoadReport(dir, {
      scope,
      ip,
      registered,
      rejected,
      error: err instanceof Error ? err.message : String(err),
    });
    return { scope, ip, registered, rejected };
  }

  // Built lazily — only touch the token engine if a provider actually
  // passes the filters (keeps a no-op / all-rejected reload engine-free).
  let ctx: HandlerContext | null = null;
  const handlerCtx = (): HandlerContext =>
    (ctx ??= {
      tokenEngine: getTokenEngine(),
      resolverFor: (s) => getOrCreateResolverForAgentGroup(s),
      fetchImpl: globalThis.fetch,
      inFlightRefresh: new Map(),
      isGlobalProvider: (id) => proxy.isGlobalProvider(id),
      oauthEvents: moduleOAuthEvents,
      deliverCallback: moduleDeliverCallback,
    });

  const accepted: SubstitutingProvider[] = [];
  const containerEnvNames = new Set<string>();

  for (const provider of loaded.providers.values()) {
    // (1) Anchor-ownership invariant — same predicate the proxy enforces on
    //     registerContainerRules. Rejects a foreign name on a global-owned
    //     anchor, or a global provider name on a new anchor.
    const violation = provider.rules
      .map((r) => proxy.containerRuleViolation(provider.id, r.anchor))
      .find((v): v is string => v !== null);
    if (violation) {
      rejected.push({ id: provider.id, reason: violation });
      continue;
    }
    // (2) Env-name collisions — flat namespace, checked at load.
    const envNames = (provider.envBindings ?? []).map((b) => b.envName);
    const clashGlobal = envNames.find((n) => isEnvNameReserved(n));
    if (clashGlobal) {
      rejected.push({ id: provider.id, reason: `env var '${clashGlobal}' is reserved/global` });
      continue;
    }
    const clashLocal = envNames.find((n) => containerEnvNames.has(n));
    if (clashLocal) {
      rejected.push({ id: provider.id, reason: `env var '${clashLocal}' duplicated for this container` });
      continue;
    }

    let sub: SubstitutingProvider;
    try {
      sub = toSubstitutingProvider(provider, handlerCtx());
    } catch (err) {
      logger.warn({ err, providerId: provider.id, scope }, 'oauth.group: adapter failed, skipping');
      rejected.push({ id: provider.id, reason: 'adapter error' });
      continue;
    }
    for (const n of envNames) containerEnvNames.add(n);
    accepted.push(sub);
    registered.push(provider.id);
  }

  proxy.registerContainerRules(ip, accepted);
  // Make the accepted per-group providers visible to every registry-driven
  // surface (minting via `getOrCreateSubstitute`, the `/substitute` endpoint),
  // scoped to this group so other groups can't see or mint them. Replace
  // semantics — re-running this loader for the group refreshes the tier. The
  // transient load-failure path above intentionally leaves a prior tier in
  // place rather than revoking a working group's providers on a flaky read.
  setScopedCredentialProviders(asCredentialScope(scope), accepted);
  if (rejected.length > 0) {
    logger.warn({ scope, ip, rejected }, 'oauth.group: some providers rejected');
  }
  logger.info(
    { scope, ip, registered: registered.length, rejected: rejected.length },
    'oauth.group: installed per-container provider tier',
  );
  writeLoadReport(dir, { scope, ip, registered, rejected });
  return { scope, ip, registered, rejected };
}
