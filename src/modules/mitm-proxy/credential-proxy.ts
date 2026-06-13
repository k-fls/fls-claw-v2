/**
 * Credential proxy for container isolation.
 *
 * Two modes of operation:
 *   1. Transparent (iptables redirect): Raw TLS connections arrive on the
 *      proxy port. transparent-proxy.ts dispatches by first byte (TLS vs HTTP).
 *      TLS connections are MITM'd for registered hosts; others are TCP-tunneled.
 *   2. Explicit proxy (http_proxy/https_proxy): Containers set proxy env vars.
 *      CONNECT requests are MITM'd for registered hosts; others are tunneled.
 *      Plain HTTP requests are forwarded directly.
 *
 * Both modes validate callers by Docker bridge IP and reject unknown containers.
 * Credential injection happens only for registered host rules (transparent path)
 * or via CONNECT MITM (explicit proxy path). The proxy never modifies headers
 * on non-intercepted traffic — it's a plain tunnel for unregistered hosts.
 *
 * The HTTP server also serves internal endpoints (e.g. /health) for
 * host-to-guest communication.
 *
 * All mutable state lives in the CredentialProxy class so tests can create
 * isolated instances without cross-suite leakage.
 */
import { createServer, IncomingMessage, request as httpRequest, Server, ServerResponse } from 'http';
import { request as httpsRequest, RequestOptions } from 'https';
import { connect as netConnect, Socket } from 'net';
import { Duplex, PassThrough } from 'stream';
import { TLSSocket } from 'tls';
import type { Server as NetServer } from 'net';

import { lookupContainerIP } from '../container-bootstrap/index.js';
import { getAllCredentialProviders, getCredentialProvider } from '../credentials/providers/registry.js';

import { type CredentialBroker, getCredentialBrokers } from './broker-registry.js';
import { getBrokerRouting, hasAnyBrokerRouting } from './broker-routing.js';
import { isMultiLabelHost } from './domain.js';
import { logger } from './logger.js';
import { createMitmContext, type MitmContext } from './mitm-ca.js';
import { createTransparentServer } from './transparent-proxy.js';
import { handleSubstituteRequest } from './substitute-endpoint.js';
import type { GroupScope } from './types.js';
import { asGroupScope, isSubstitutingProvider, type SubstitutingProvider } from './types.js';

/** Swallow socket/stream errors to prevent uncaughtException crashes. */
function noop() {}

/**
 * Add an anchored host rule into a target Map. Used by both the
 * incremental path (`indexProvider`) and the full-rebuild path
 * (`rebuildIndex`) so anchor derivation lives in one place.
 *
 * Anchor derivation: strip ^/$ and unescape `\.` from the regex source.
 * For an exact-host pattern like /^api\.anthropic\.com$/ the anchor is
 * the hostname itself; for a suffix pattern like /\.auth0\.com$/ the
 * anchor is the suffix.
 */
/**
 * Domain-shape regex. The anchor we derive from a `hostPattern.source`
 * must look like a real hostname suffix — only lowercase letters,
 * digits, dots, and hyphens, starting and ending with alnum. Anything
 * else means the regex isn't anchor-derivable (contains metacharacters
 * the lookup can't honor), and we should refuse it at index time
 * instead of silently dropping requests.
 */
const ANCHOR_SHAPE_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Derive the lowercased anchor (fixed domain suffix) for a host rule —
 * the explicit `anchor` if given, else stripped from the regex source.
 * Throws if the result isn't a domain suffix (un-indexable). Shared by the
 * index builder and the anchor-ownership check so both see the same key.
 */
function deriveAnchor(hostPattern: RegExp, explicitAnchor: string | undefined, providerId: string): string {
  const anchor = (
    explicitAnchor ?? hostPattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\./g, '.')
  ).toLowerCase();
  if (!ANCHOR_SHAPE_RE.test(anchor)) {
    throw new Error(
      `Provider '${providerId}' host rule has un-indexable hostPattern: ` +
        `derived anchor '${anchor}' from /${hostPattern.source}/ is not a domain suffix. ` +
        `Use a regex whose source strips down to letters/digits/dots/hyphens (e.g. ` +
        `/^api\\.example\\.com$/ or /\\.example\\.com$/), or pass an explicit ` +
        `\`anchor\` field on the HostRule for templated hosts.`,
    );
  }
  return anchor;
}

function addRuleToMap(
  target: Map<string, IndexedHostRule[]>,
  hostPattern: RegExp,
  pathPattern: RegExp,
  handler: HostHandler,
  providerId: string,
  explicitAnchor?: string,
): void {
  const anchor = deriveAnchor(hostPattern, explicitAnchor, providerId);
  let rules = target.get(anchor);
  if (!rules) {
    rules = [];
    target.set(anchor, rules);
  }
  rules.push({ hostPattern, pathPattern, handler, providerId });
  logger.debug(
    {
      anchor,
      providerId,
      hostPattern: hostPattern.source,
      pathPattern: pathPattern.source,
    },
    'Indexed anchored host rule',
  );
}

// ── Types ───────────────────────────────────────────────────────────

/**
 * Request handler for a host rule. Owns the full upstream round-trip:
 * credential resolution, header injection, body buffering (if needed),
 * and writing the response.
 */
export type HostHandler = (
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  scope: GroupScope,
  /** Original container bridge IP (from connection time, not the MITM socket). */
  sourceIP?: string,
) => Promise<void>;

/** Pluggable credential resolver for proxy host handlers. */
export type ProxyCredentialResolver = (scope: string) => Record<string, string>;

/**
 * `HostRule` from a `SubstitutingProvider` enriched with the providerId
 * that contributed it. Used by the proxy's anchor index. The public
 * `HostRule` (in types.ts) is what providers return; the proxy adds
 * provenance during indexing.
 */
interface IndexedHostRule {
  hostPattern: RegExp;
  pathPattern: RegExp;
  handler: HostHandler;
  providerId: string;
}

interface MitmMeta {
  targetHost: string;
  targetPort: number;
  scope: GroupScope;
  /** Original container bridge IP (resolved at connection time). */
  sourceIP: string;
  /** Tap exclusion check — set when connection is tapped. */
  checkExclusion?: import('./proxy-tap-logger.js').TapExclusionCheck;
}

/** Options for the credential proxy. */
export interface CredentialProxyOptions {
  /**
   * TCP port to bind. Default `0` — let the OS assign an ephemeral port.
   * The observer reads `getBoundPort()` after start(), so dynamic ports
   * are the supported path.
   */
  port?: number;
  host?: string;
  /** Directory for MITM CA cert/key. */
  caDir?: string;
}

// ── Helpers (stateless) ─────────────────────────────────────────────

/** Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:172.17.0.2 → 172.17.0.2). */
function normalizeIP(raw: string): string {
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

/**
 * Match a host against an overtake host-pattern target: exact, or a
 * registrable-suffix (`stripe.com` matches `api.stripe.com`). Both lowercased.
 * (Provider-id overtake targets are matched separately, against the request's
 * native rule provenance.)
 */
function hostMatchesPattern(host: string, target: string): boolean {
  const h = host.toLowerCase();
  const t = target.toLowerCase();
  return h === t || h.endsWith(`.${t}`);
}

type HeaderMap = Record<string, string | number | string[] | undefined>;

/**
 * HTTPS agent used by proxyPipe/proxyBuffered for upstream connections.
 * Default agent verifies server certificates (rejects self-signed).
 * Tests replace this with an agent that skips verification.
 */
let _upstreamAgent: import('https').Agent | undefined;

/** Replace the upstream HTTPS agent. Primarily for tests with self-signed certs. */
export function setUpstreamAgent(agent: import('https').Agent): void {
  _upstreamAgent = agent;
}

/**
 * Called when the upstream response is received, before the body is piped.
 * Sees request headers (post-injection) and response status/headers.
 * Body is NOT buffered — this is a headers-only hook on the streaming path.
 */
export type ProxyResponseHook = (info: {
  targetHost: string;
  targetPort: number;
  /** Scope of the container that made the request. */
  scope: GroupScope;
  method: string;
  path: string;
  requestHeaders: HeaderMap;
  statusCode: number;
  responseHeaders: import('http').IncomingHttpHeaders;
}) => void;

let _responseHook: ProxyResponseHook | null = null;

/** Set the response hook. Called once at startup. */
export function setProxyResponseHook(hook: ProxyResponseHook): void {
  _responseHook = hook;
}

/**
 * Forward a request to upstream HTTPS, piping the body straight through.
 *
 * NOTE: DNS resolution happens on the host, not using the container's resolver.
 * This means split-horizon DNS (e.g., hostnames only resolvable inside the
 * container's network) won't work. Using the original destination IP from
 * iptables (SO_ORIGINAL_DST) would fix this but is overkill for now.
 *
 * @param injectHeaders — mutate headers in place to add credentials.
 * @param scope — group scope (passed to response hook).
 */
export function proxyPipe(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  injectHeaders: (headers: HeaderMap) => void,
  scope: GroupScope,
): void {
  const headers: HeaderMap = {
    ...(clientReq.headers as Record<string, string>),
    host: targetHost,
  };
  delete headers['connection'];
  delete headers['keep-alive'];
  injectHeaders(headers);

  const upstream = httpsRequest(
    {
      hostname: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers,
      agent: _upstreamAgent,
    } as RequestOptions,
    (upRes) => {
      upRes.on('error', noop);
      if (_responseHook) {
        _responseHook({
          targetHost,
          targetPort,
          scope,
          method: clientReq.method || '',
          path: clientReq.url || '',
          requestHeaders: headers,
          statusCode: upRes.statusCode!,
          responseHeaders: upRes.headers,
        });
      }
      clientRes.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(clientRes);
    },
  );
  upstream.on('error', (err) => {
    logger.error({ err, host: targetHost, url: clientReq.url }, 'proxyPipe upstream error');
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end('Bad Gateway');
    }
  });
  clientReq.pipe(upstream);
}

/**
 * Forward a request to upstream HTTPS, buffering body both directions
 * so callers can transform request/response bodies (e.g. OAuth token exchange).
 * @param injectHeaders — mutate headers in place to add credentials.
 * @param transformRequest — transform request body before sending upstream.
 * @param transformResponse — transform response body before sending to client.
 *   Receives the body and HTTP status code. Only called for successful (2xx) responses.
 */
export async function proxyBuffered(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
  injectHeaders: (headers: HeaderMap) => void,
  transformRequest: (body: string) => string,
  transformResponse: (body: string, statusCode: number) => string,
): Promise<void> {
  // Buffer request body
  const reqChunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    clientReq.on('data', (c) => reqChunks.push(c));
    clientReq.on('end', resolve);
  });
  const reqBody = transformRequest(Buffer.concat(reqChunks).toString());
  const reqBuf = Buffer.from(reqBody);

  const headers: HeaderMap = {
    ...(clientReq.headers as Record<string, string>),
    host: targetHost,
    'content-length': reqBuf.length,
  };
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  injectHeaders(headers);

  await new Promise<void>((resolve) => {
    const upstream = httpsRequest(
      {
        hostname: targetHost,
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers,
        agent: _upstreamAgent,
      } as RequestOptions,
      async (upRes) => {
        const resChunks: Buffer[] = [];
        await new Promise<void>((r) => {
          upRes.on('error', noop);
          upRes.on('data', (c: Buffer) => resChunks.push(c));
          upRes.on('end', r);
        });
        let resBody = Buffer.concat(resChunks).toString();
        const status = upRes.statusCode!;

        if (status >= 200 && status < 300) {
          try {
            resBody = transformResponse(resBody, status);
          } catch (err) {
            logger.error({ err, host: targetHost }, 'proxyBuffered transformResponse error');
          }
        }

        const resBuf = Buffer.from(resBody);
        const resHeaders = {
          ...upRes.headers,
          'content-length': String(resBuf.length),
        };
        delete resHeaders['transfer-encoding'];
        clientRes.writeHead(status, resHeaders);
        clientRes.end(resBuf);
        resolve();
      },
    );
    upstream.on('error', (err) => {
      logger.error({ err, host: targetHost, url: clientReq.url }, 'proxyBuffered upstream error');
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end('Bad Gateway');
      }
      resolve();
    });
    upstream.write(reqBuf);
    upstream.end();
  });
}

// ── CredentialProxy class ───────────────────────────────────────────

/**
 * Socket-level tap for observing raw HTTP bytes through the MITM proxy.
 * Both `inbound` (client → proxy) and `outbound` (proxy → client) chunks
 * are delivered as-is — the consumer parses HTTP framing externally.
 */
export interface ProxyTapEvent {
  direction: 'inbound' | 'outbound' | 'close';
  targetHost: string;
  targetPort: number;
  scope: GroupScope;
  chunk: Buffer;
}

/**
 * Two-stage tap:
 *   1. Filter `(hostname) => TapResolver | null` — called on hostname before
 *      the MITM/tunnel decision. If non-null, forces the MITM path so the tap
 *      sees decrypted HTTP bytes (even for hosts with no handler rules).
 *   2. Resolver `(targetHost, scope) => TapResult | null` — called per-connection
 *      after MITM setup. Returns the callback + control for deferred emission,
 *      or null to skip tapping this specific connection.
 */
export type ProxyTapFilter = (hostname: string, scope: GroupScope) => ProxyTapResolver | null;
export interface ProxyTapResult {
  callback: ProxyTapCallback;
  checkExclusion: import('./proxy-tap-logger.js').TapExclusionCheck;
}
export type ProxyTapResolver = (targetHost: string, scope: GroupScope) => ProxyTapResult | null;
export type ProxyTapCallback = (event: ProxyTapEvent) => void;

export class CredentialProxy {
  /**
   * Anchor-indexed rules: domain suffix → rules for that anchor.
   * Lookup walks domain parts from 2-part suffix upward:
   *   "myco.auth0.com" → tries "auth0.com", then "myco.auth0.com"
   */
  private anchorRules = new Map<string, IndexedHostRule[]>();
  private containerIpToScope = new Map<string, GroupScope>();
  /** Provider ids whose host rules are currently in `anchorRules`. */
  private indexedIds = new Set<string>();
  /**
   * Per-container "local" rules, keyed by normalized source IP. Container
   * lifetime — installed when the container's IP is allocated (loaded from
   * its agent group's `.auth-discovery/`), dropped in `unregisterContainerIP`.
   * See `docs/fls/specs/per-group-oauth-providers.md`.
   */
  private containerRules = new Map<string, Map<string, IndexedHostRule[]>>();
  private _mitmCtx: MitmContext | null = null;
  private _tapFilter: ProxyTapFilter | null = null;
  /** Port the listener actually bound to; null until start() resolves. */
  private _boundPort: number | null = null;

  /**
   * Shared HTTP server for dispatching all MITM'd requests (both transparent
   * and CONNECT paths). A single server avoids per-connection server creation
   * and its associated memory leak. Per-connection metadata (target host, port,
   * scope) is stashed in a WeakMap keyed on the socket.
   */
  private mitmDispatcher: Server;
  private socketMeta = new WeakMap<object, MitmMeta>();

  constructor() {
    this.mitmDispatcher = createServer((req, res) => {
      // Absorb socket errors centrally — covers all HostHandlers, proxyPipe,
      // proxyBuffered. Without this, ECONNRESET/EPIPE from either end crashes
      // the process via uncaughtException.
      req.on('error', noop);
      res.on('error', noop);

      const meta = this.socketMeta.get(req.socket);
      if (!meta) {
        logger.error({ url: req.url }, 'MITM request with no socket metadata');
        res.writeHead(500);
        res.end('Internal error');
        return;
      }
      const urlPath = req.url || '/';

      // Broker tier first: a delegated broker overtakes the native provider
      // (covered space) and handles the catch-all (uncovered space). When a
      // broker is routed it is the terminal owner — fail closed on error, never
      // silently fall through to native/pipe (spec §3b).
      const broker = this.resolveBrokerRoute(meta.sourceIP, meta.targetHost, urlPath);
      if (broker) {
        meta.checkExclusion?.(null); // broker traffic isn't a credential-provider match
        broker
          .tryForward(req, res, meta.targetHost, meta.targetPort, meta.scope, meta.sourceIP)
          .catch((err: unknown) => {
            logger.error({ err, brokerId: broker.id, host: meta.targetHost }, 'broker tryForward failed — fail closed');
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
        return;
      }

      const rule = this.findMatchingRule(meta.targetHost, urlPath, meta.sourceIP);

      // Resolve tap exclusion: tell the tap callback which provider matched
      meta.checkExclusion?.(rule?.providerId ?? null);

      if (rule) {
        rule.handler(req, res, meta.targetHost, meta.targetPort, meta.scope, meta.sourceIP).catch((err: unknown) => {
          logger.error({ err, host: meta.targetHost }, 'MITM handler error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
      } else {
        // Intercepted host but no path-specific handler — pipe unmodified
        proxyPipe(req, res, meta.targetHost, meta.targetPort, () => {}, meta.scope);
      }
    });
  }

  // ── State management ────────────────────────────────────────────

  /** Set a tap filter for observing raw MITM traffic. Pass null to disable. */
  setTapFilter(filter: ProxyTapFilter | null): void {
    this._tapFilter = filter;
  }

  hasContainerIP(ip: string): boolean {
    return this.containerIpToScope.has(ip);
  }

  registerContainerIP(ip: string, scope: GroupScope): void {
    this.containerIpToScope.set(ip, scope);
    logger.debug({ ip, scope }, 'Registered container IP');
  }

  unregisterContainerIP(ip: string): void {
    const norm = normalizeIP(ip);
    this.containerIpToScope.delete(ip);
    this.containerIpToScope.delete(norm);
    // Drop this container's ephemeral rule tier — O(1), no scan.
    this.containerRules.delete(norm);
    logger.debug({ ip }, 'Unregistered container IP');
  }

  // ── Provider index (derived from credentials registry) ──────────────
  //
  // The proxy does NOT own a provider registry. Providers live in
  // `credentials/providers/registry.ts`. The proxy maintains a host-rule
  // index over the subset that is a SubstitutingProvider with hostRules.
  //
  // Mutations:
  //   - `indexProvider(p)`: incremental add. Fail-loud on duplicate.
  //   - `rebuildIndex()`: atomic full rebuild from the registry. Swaps
  //     the anchorRules Map in one statement so in-flight handlers (which
  //     already captured their HostRule reference synchronously) are
  //     unaffected.
  //
  // Lookup callers (`shouldIntercept`, `findMatchingRule`) read
  // `this.anchorRules` synchronously — no await inside a lookup — so a
  // single lookup always sees a consistent snapshot.

  /**
   * Incremental add. Calls `p.substitutes.hostRules()` exactly once and
   * appends each rule to `anchorRules`. Throws if `p.id` is already
   * indexed, or if any rule's `hostPattern` doesn't yield a derivable
   * anchor (loud failure — providers must keep anchors implicit in
   * their regex source).
   */
  indexProvider(p: SubstitutingProvider): void {
    if (this.indexedIds.has(p.id)) {
      throw new Error(`Provider '${p.id}' already indexed in proxy`);
    }
    this.indexedIds.add(p.id);
    for (const r of p.substitutes.hostRules()) {
      addRuleToMap(this.anchorRules, r.hostPattern, r.pathPattern, r.handler, p.id, r.anchor);
    }
  }

  /**
   * Full rebuild from the credentials registry. Builds a new
   * `Map<anchor, IndexedHostRule[]>` in a local, then assigns it in one
   * statement — atomic w.r.t. the event loop. In-flight handlers keep
   * their captured `HostRule` refs (GC-rooted by the closure) until
   * their request completes.
   *
   * Long-lived MITM TLS sessions pick up new rules on their next request.
   */
  rebuildIndex(): void {
    const newAnchors = new Map<string, IndexedHostRule[]>();
    const newIndexed = new Set<string>();
    for (const p of getAllCredentialProviders()) {
      if (!isSubstitutingProvider(p)) continue;
      newIndexed.add(p.id);
      for (const r of p.substitutes.hostRules()) {
        addRuleToMap(newAnchors, r.hostPattern, r.pathPattern, r.handler, p.id, r.anchor);
      }
    }
    this.anchorRules = newAnchors;
    this.indexedIds = newIndexed;
  }

  /** Build an anchor map from a set of substituting providers' host rules. */
  private static buildRuleMap(providers: readonly SubstitutingProvider[]): Map<string, IndexedHostRule[]> {
    const map = new Map<string, IndexedHostRule[]>();
    for (const p of providers) {
      for (const r of p.substitutes.hostRules()) {
        addRuleToMap(map, r.hostPattern, r.pathPattern, r.handler, p.id, r.anchor);
      }
    }
    return map;
  }

  /** Is `id` a globally-registered provider? Used to forbid container shadowing. */
  isGlobalProvider(id: string): boolean {
    return this.indexedIds.has(id);
  }

  /** Does a global provider already own this anchor? */
  isGlobalAnchor(anchor: string): boolean {
    return this.anchorRules.has(anchor.toLowerCase());
  }

  /**
   * Global provider id(s) that own this anchor (empty if none). The
   * baseline ships a few intentionally co-owned anchors (region/sandbox
   * variants of the same upstream, e.g. `login.microsoftonline.com`), so an
   * anchor may have more than one owner — all of them global, all trusted.
   */
  globalAnchorOwners(anchor: string): readonly string[] {
    const rules = this.anchorRules.get(anchor.toLowerCase());
    if (!rules || rules.length === 0) return [];
    return [...new Set(rules.map((r) => r.providerId))];
  }

  /**
   * The anchor-ownership invariant for a local (container) rule, as one
   * predicate so the throwing path and the graceful load-filter path can't
   * drift. Returns a rejection reason, or null if allowed:
   *
   *   (a) the anchor is owned by a *different* provider name — adding a rule
   *       under another name would let that name's credential reach a domain
   *       fixed by the owner's definition;
   *   (b) the provider name is a *global* provider but the anchor is not one
   *       it already owns — a container may not extend a global provider's
   *       anchor set with new domains;
   *   (c) the anchor is not a domain of at least two labels — a bare TLD or
   *       single label would over-capture (`x.y` or deeper required).
   *
   * Same-name-on-its-own-anchor is allowed. See
   * `docs/fls/specs/per-group-oauth-providers.md`.
   */
  containerRuleViolation(providerId: string, anchor: string): string | null {
    const a = anchor.toLowerCase();
    if (!isMultiLabelHost(a)) {
      return `anchor '${a}' must be a domain of at least two labels (x.y or deeper)`;
    }
    const owners = this.globalAnchorOwners(a);
    if (owners.length > 0 && !owners.includes(providerId)) {
      return `anchor '${a}' is owned by global provider '${owners.join(',')}'`;
    }
    if (this.isGlobalProvider(providerId) && !owners.includes(providerId)) {
      return `'${providerId}' is a global provider — cannot add the new anchor '${a}' under it`;
    }
    return null;
  }

  /** Throw on the first container rule that violates the ownership invariant. */
  private assertContainerMayOwn(providers: readonly SubstitutingProvider[]): void {
    for (const p of providers) {
      for (const r of p.substitutes.hostRules()) {
        const anchor = deriveAnchor(r.hostPattern, r.anchor, p.id);
        const reason = this.containerRuleViolation(p.id, anchor);
        if (reason) throw new Error(`container rules: ${reason}`);
      }
    }
  }

  /**
   * Replace the per-container rule tier for one source IP. Dropped on
   * `unregisterContainerIP`. Installed when the container's IP is allocated
   * (from its agent group's `.auth-discovery/`) and for short-lived
   * containers that need rules only while they run (e.g. the Claude
   * browser-auth container). Subject to the anchor-ownership invariant.
   */
  registerContainerRules(ip: string, providers: readonly SubstitutingProvider[]): void {
    const norm = normalizeIP(ip);
    if (providers.length === 0) {
      this.containerRules.delete(norm);
      return;
    }
    this.assertContainerMayOwn(providers);
    this.containerRules.set(norm, CredentialProxy.buildRuleMap(providers));
  }

  /**
   * Parse a tap-exclude spec.
   *   undefined → no exclusions (v1 default of `'claude'` lands with OAuth)
   *   ""        → no exclusions
   *   "a,b,c"   → those ids; unknown ones surfaced in `unknown`
   */
  parseTapExclude(raw: string | undefined): {
    excluded: Set<string>;
    unknown: string[];
  } {
    if (raw === undefined || raw === '') return { excluded: new Set(), unknown: [] };
    const ids = raw.split(',').filter(Boolean);
    const excluded = new Set<string>();
    const unknown: string[] = [];
    for (const id of ids) {
      if (getCredentialProvider(id)) excluded.add(id);
      else unknown.push(id);
    }
    return { excluded, unknown };
  }

  /**
   * @internal Test-only helper. Production code routes host rules through
   * the credentials registry → `indexProvider` / `rebuildIndex` path.
   * Tests use this to exercise anchor lookup without constructing a full
   * `SubstitutingProvider` literal.
   */
  _addHostRuleForTests(hostPattern: RegExp, pathPattern: RegExp, handler: HostHandler, providerId: string): void {
    addRuleToMap(this.anchorRules, hostPattern, pathPattern, handler, providerId);
  }

  /**
   * @internal Test-only helper. Same as `_addHostRuleForTests` but takes
   * an explicit anchor (bypasses regex-derived anchor) so tests can
   * cover the anchor-specificity walk.
   */
  _addAnchoredRuleForTests(
    anchor: string,
    hostPattern: RegExp,
    pathPattern: RegExp,
    handler: HostHandler,
    providerId: string,
  ): void {
    anchor = anchor.toLowerCase();
    let rules = this.anchorRules.get(anchor);
    if (!rules) {
      rules = [];
      this.anchorRules.set(anchor, rules);
    }
    rules.push({ hostPattern, pathPattern, handler, providerId });
  }

  // ── Queries ─────────────────────────────────────────────────────

  /**
   * Find the matching anchor for a hostname in ONE anchor map by walking
   * domain parts. "myco.auth0.com" → tries "myco.auth0.com" (most
   * specific) down to "auth0.com". Returns the rules array if found.
   */
  private static findAnchorRulesIn(
    map: Map<string, IndexedHostRule[]> | undefined,
    targetHost: string,
  ): IndexedHostRule[] | null {
    if (!map) return null;
    let pos = 0;
    while (true) {
      const rules = map.get(targetHost.slice(pos));
      if (rules) return rules;
      pos = targetHost.indexOf('.', pos) + 1;
      if (pos <= 0) return null;
    }
  }

  /** Global-tier anchor walk (kept for existing internal/test callers). */
  private findAnchorRules(targetHost: string): IndexedHostRule[] | null {
    return CredentialProxy.findAnchorRulesIn(this.anchorRules, targetHost.toLowerCase());
  }

  /**
   * Should this hostname be TLS-terminated for this connection? An anchor
   * present only in *another* container's IP tier is invisible here, so it
   * can't trigger interception. `ip` omitted → global tier only (preserves
   * prior behavior for callers that don't supply it).
   */
  shouldIntercept(targetHost: string, ip?: string): boolean {
    const host = targetHost.toLowerCase();
    const providerCovered =
      !!CredentialProxy.findAnchorRulesIn(this.anchorRules, host) ||
      (ip ? !!CredentialProxy.findAnchorRulesIn(this.containerRules.get(normalizeIP(ip)), host) : false);
    if (providerCovered) return true;
    // Not provider-covered: a delegated broker may still want this host —
    // catch-all (uncovered space), or an overtake host-pattern. (An overtake
    // by provider-id would already be providerCovered above.)
    if (ip && this.brokerInterceptsHost(host, ip)) return true;
    return false;
  }

  /**
   * Host-level broker interception (no path yet — CONNECT/transparent time).
   * Only consulted when no provider covers the host, so any catch-all broker
   * claims it, as does an overtake **host-pattern** match.
   */
  private brokerInterceptsHost(host: string, ip: string): boolean {
    const routed = getBrokerRouting(normalizeIP(ip));
    for (const r of routed) {
      if (r.catchAll) return true;
      if (r.overtake.some((t) => hostMatchesPattern(host, t))) return true;
    }
    return false;
  }

  /**
   * Resolve which broker (if any) should handle a request, path-aware. Used by
   * the dispatcher; a broker route overtakes the native provider. Precedence:
   * brokers in registry (priority) order; for each, its routing snapshot entry
   * matches when an overtake target matches (a provider-id the request's native
   * rule belongs to, or a host pattern) OR catch-all applies to an uncovered
   * request. Returns null when no broker is routed (the common case — cheap
   * `hasAnyBrokerRouting` gate first).
   */
  resolveBrokerRoute(ip: string, host: string, urlPath: string): CredentialBroker | null {
    if (!hasAnyBrokerRouting()) return null;
    const routed = getBrokerRouting(normalizeIP(ip));
    if (routed.length === 0) return null;

    const lcHost = host.toLowerCase();
    const nativeRule = this.findMatchingRule(host, urlPath, ip);
    const providerCovered = nativeRule !== null;

    for (const broker of getCredentialBrokers()) {
      const entry = routed.find((r) => r.brokerId === broker.id);
      if (!entry) continue;
      const overtakes = entry.overtake.some(
        (t) => (nativeRule !== null && nativeRule.providerId === t) || hostMatchesPattern(lcHost, t),
      );
      if (overtakes) return broker;
      if (entry.catchAll && !providerCovered) return broker;
    }
    return null;
  }

  /**
   * Resolve scope from a container's source IP.
   * Returns null for unknown IPs — callers must reject the connection.
   */
  resolveScope(sourceIP: string): GroupScope | null {
    const ip = normalizeIP(sourceIP);
    // Local map wins for explicit registrations; otherwise fall back to
    // container-bootstrap's IP allocator registry (the canonical source).
    const local = this.containerIpToScope.get(ip);
    if (local) return local;
    const fromBootstrap = lookupContainerIP(ip);
    if (fromBootstrap) return asGroupScope(fromBootstrap);
    logger.warn({ remoteIP: ip }, 'Connection from unknown container IP, rejecting');
    return null;
  }

  /** Regex match within a single tier's anchor map. */
  private static matchIn(
    map: Map<string, IndexedHostRule[]> | undefined,
    targetHost: string,
    urlPath: string,
  ): IndexedHostRule | null {
    const rules = CredentialProxy.findAnchorRulesIn(map, targetHost);
    if (!rules) return null;
    return rules.find((r) => r.hostPattern.test(targetHost) && r.pathPattern.test(urlPath)) ?? null;
  }

  /**
   * Find the matching rule for a request by host + path, trying the tiers
   * in order: global → container[ip]. The first hit wins, so a global rule
   * can never be overridden by a container rule — not even by a
   * more-specific anchor. `ip` omitted → global only.
   */
  findMatchingRule(targetHost: string, urlPath: string, ip?: string): IndexedHostRule | null {
    const host = targetHost.toLowerCase();
    const global = CredentialProxy.matchIn(this.anchorRules, host, urlPath);
    if (global) return global;
    if (ip) {
      const cm = this.containerRules.get(normalizeIP(ip));
      const container = CredentialProxy.matchIn(cm, host, urlPath);
      if (container) return container;
    }
    return null;
  }

  /** Find the handler for a request. Convenience wrapper around findMatchingRule. */
  matchHostRule(targetHost: string, urlPath: string, ip?: string): HostHandler | null {
    return this.findMatchingRule(targetHost, urlPath, ip)?.handler ?? null;
  }

  // ── MITM dispatch ───────────────────────────────────────────────

  /**
   * Emit a TLS socket into the shared MITM HTTP server with connection metadata.
   * Called by both the transparent proxy and the CONNECT handler.
   */
  emitMitmConnection(
    socket: object,
    targetHost: string,
    targetPort: number,
    scope: GroupScope,
    sourceIP: string = '',
    tapResolver?: ProxyTapResolver | null,
  ): void {
    const tapResult = tapResolver?.(targetHost, scope) ?? null;
    const emitSocket = tapResult
      ? this.wrapWithTap(
          socket as Socket,
          tapResult.callback,
          {
            targetHost,
            targetPort,
            scope,
          },
          tapResult.checkExclusion,
        )
      : socket;
    this.socketMeta.set(emitSocket, {
      targetHost,
      targetPort,
      scope,
      sourceIP,
      checkExclusion: tapResult?.checkExclusion,
    });
    this.mitmDispatcher.emit('connection', emitSocket);
  }

  /**
   * Interpose PassThrough streams that tee raw bytes to a tap callback.
   * The dispatcher sees a normal duplex socket; the tap is passive.
   */
  /**
   * Wrap a socket with two PassThrough taps for bidirectional observation.
   *
   * Data flow:
   *   client → socket → inTap → dispatcher (HTTP server reads requests)
   *   dispatcher → outTap → socket → client (HTTP server writes responses)
   *
   * The dispatcher sees `inTap` as its socket (reads from it, writes to it).
   * Writes to `inTap` are intercepted and forwarded to `outTap` → socket.
   */
  private wrapWithTap(
    socket: Socket,
    tapCb: ProxyTapCallback,
    meta: { targetHost: string; targetPort: number; scope: GroupScope },
    checkExclusion?: import('./proxy-tap-logger.js').TapExclusionCheck,
  ): Duplex {
    const inTap = new PassThrough(); // client → dispatcher (request data)
    const outTap = new PassThrough(); // dispatcher → client (response data)
    inTap.on('error', noop);
    outTap.on('error', noop);

    // Inbound: socket → inTap (dispatcher reads from inTap)
    socket.on('data', (chunk: Buffer) => {
      try {
        tapCb({ ...meta, direction: 'inbound', chunk });
      } catch {}
      inTap.push(chunk);
    });
    socket.on('end', () => inTap.push(null));
    socket.on('error', (err) => inTap.destroy(err));

    // Outbound: dispatcher writes to inTap's writable side → route to outTap
    // The HTTP server calls res.write() which calls socket.write() — where
    // "socket" is the Duplex we return. Override _write to capture + forward.
    outTap.on('data', (chunk: Buffer) => {
      try {
        tapCb({ ...meta, direction: 'outbound', chunk });
      } catch {}
      socket.write(chunk);
    });
    outTap.on('end', () => socket.end());

    socket.on('close', () => {
      // Ensure exclusion check fires even if dispatcher never matched
      // (non-HTTP, connection dropped before request). Idempotent — safe
      // if the dispatcher already called it.
      try {
        checkExclusion?.(null);
      } catch {}
      try {
        tapCb({ ...meta, direction: 'close', chunk: Buffer.alloc(0) });
      } catch {}
    });

    // Return a Duplex that the dispatcher uses as its socket:
    //   reads come from inTap (client requests)
    //   writes go to outTap (server responses)
    const duplex = new Duplex({
      read() {
        // Pulls are satisfied by inTap pushing data above
      },
      write(chunk: Buffer, _enc: string, cb: () => void) {
        outTap.write(chunk, cb);
      },
      final(cb: () => void) {
        outTap.end(cb);
      },
      destroy(err: Error | null, cb: (err: Error | null) => void) {
        inTap.destroy();
        outTap.destroy();
        socket.destroy(err ?? undefined);
        cb(err);
      },
    });

    // Forward inTap readable data to the duplex's readable side
    inTap.on('data', (chunk: Buffer) => {
      if (!duplex.push(chunk)) inTap.pause();
    });
    inTap.on('end', () => duplex.push(null));
    duplex.on('drain', () => inTap.resume());

    return duplex;
  }

  // ── Caller validation ───────────────────────────────────────────

  private validateCaller(remoteAddress: string | undefined): GroupScope | null {
    const ip = normalizeIP(remoteAddress || '');
    const local = this.containerIpToScope.get(ip);
    if (local) return local;
    const fromBootstrap = lookupContainerIP(ip);
    return fromBootstrap ? asGroupScope(fromBootstrap) : null;
  }

  // ── Server ──────────────────────────────────────────────────────

  /**
   * Port the listener actually bound to. Throws if called before
   * `start()` resolves. Use this from the observer / any consumer that
   * needs the address — never rely on the option you passed to `start()`,
   * since the default is `0` (OS-assigned ephemeral).
   */
  getBoundPort(): number {
    if (this._boundPort === null) {
      throw new Error('CredentialProxy.getBoundPort() called before start() resolved');
    }
    return this._boundPort;
  }

  start(opts: CredentialProxyOptions = {}): Promise<NetServer> {
    const port = opts.port ?? 0;
    const bindHost = opts.host || '127.0.0.1';

    // Always init the MITM context. The proxy supports both iptables-
    // redirected raw TLS (first-byte dispatch in createTransparentServer)
    // and explicit HTTP_PROXY/HTTPS_PROXY clients (CONNECT path in the
    // wrapped httpServer) on the same listener.
    this._mitmCtx = createMitmContext(opts.caDir);

    // Build the host-rule index from whatever's currently in the
    // credentials registry. Late-registered providers (post-start) need
    // an explicit `indexProvider(p)` call from the caller.
    this.rebuildIndex();

    // HTTP server handles:
    // - Internal endpoints (/health) — no caller validation
    // - Plain HTTP proxy requests (explicit proxy mode) — caller validated
    // - Non-TLS traffic from transparent mode (first-byte detection)
    const httpServer = createServer((req, res) => {
      req.on('error', noop);
      res.on('error', noop);

      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const scope = this.validateCaller(req.socket.remoteAddress);
      if (!scope) {
        logger.warn(
          {
            remoteIP: normalizeIP(req.socket.remoteAddress || ''),
            url: req.url,
          },
          'Rejecting HTTP request from unknown container IP',
        );
        res.writeHead(403);
        res.end('Forbidden: unknown container');
        return;
      }

      // Credential substitute endpoint: container pulls a substitute at runtime
      if (req.url?.startsWith('/credentials/') && req.method === 'GET') {
        handleSubstituteRequest(req, res, scope);
        return;
      }

      // Standard HTTP proxy: forward the request to the target URL.
      // No credential injection — plain proxy for non-intercepted traffic.
      const targetUrl = new URL(req.url || '/', 'http://localhost');
      const upstream = httpRequest(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers: { ...req.headers, host: targetUrl.host },
        },
        (upRes) => {
          upRes.on('error', noop);
          res.writeHead(upRes.statusCode!, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        logger.error({ err, url: req.url }, 'HTTP proxy upstream error');
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Bad Gateway');
        }
      });
      req.pipe(upstream);
    });

    // CONNECT handler: standard HTTPS proxy with MITM for registered hosts.
    httpServer.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      clientSocket.on('error', noop);

      // A socket with no source address can't be identified — reject it
      // outright rather than fabricating an empty IP that would key the
      // container-rule tier (and the scope lookup) as a wildcard.
      const sourceIP = clientSocket.remoteAddress ? normalizeIP(clientSocket.remoteAddress) : null;
      const scope = sourceIP ? this.validateCaller(sourceIP) : null;
      if (!sourceIP || !scope) {
        logger.warn({ remoteIP: sourceIP ?? '(none)', target: req.url }, 'Rejecting CONNECT from unknown container IP');
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const [rawHost, targetPortStr] = (req.url || '').split(':');
      // Lowercase the host at the system boundary — the whole pipeline
      // (matching, bound-domain stamp + guard) assumes lowercase domains.
      const targetHost = rawHost.toLowerCase();
      const targetPort = parseInt(targetPortStr || '443');

      // Stage 1: check handler rules + tap filter
      const tapResolver = this._tapFilter?.(targetHost, scope) ?? null;
      const shouldMitm = this.shouldIntercept(targetHost, sourceIP) || tapResolver !== null;
      // Stage 2 (tapResolver) is passed to emitMitmConnection below

      if (!this._mitmCtx || !shouldMitm) {
        // No MITM — plain TCP tunnel (no header inspection or modification)
        const upstream = netConnect(targetPort, targetHost, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
        });
        upstream.on('error', (err) => {
          logger.debug({ err, host: targetHost }, 'CONNECT tunnel error');
          clientSocket.destroy();
        });
        clientSocket.on('error', () => upstream.destroy());
        return;
      }

      // MITM: TLS-terminate, dispatch per-request via shared mitmDispatcher
      const hostCert = this._mitmCtx.getHostCert(targetHost);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      const tlsSocket = new TLSSocket(clientSocket, {
        isServer: true,
        key: hostCert.keyPem,
        cert: hostCert.certPem,
      });

      if (head.length) clientSocket.unshift(head);

      tlsSocket.on('error', (err) => {
        logger.debug({ err, hostname: targetHost }, 'CONNECT TLS error');
        clientSocket.destroy();
      });

      // Stage 2: pass tapResolver to emitMitmConnection for per-connection callback
      this.emitMitmConnection(tlsSocket, targetHost, targetPort, scope, sourceIP, tapResolver);
    });

    return new Promise((resolve, reject) => {
      // Always wrap the HTTP server with TLS-aware net.Server so that
      // iptables-redirected raw TLS (first byte 0x16) is handled by
      // SNI-based MITM, while HTTP/CONNECT traffic falls through to the
      // wrapped httpServer.
      const server = createTransparentServer({
        httpServer,
        mitmCtx: this._mitmCtx!,
        shouldIntercept: (h, sc, ip) => {
          const tapResolver = this._tapFilter?.(h, sc) ?? null;
          if (this.shouldIntercept(h, ip)) return { tapResolver };
          if (tapResolver) return { tapResolver };
          return null;
        },
        resolveScope: (ip) => this.resolveScope(ip),
        emitMitmConnection: (s, h, p, sc, ip, tapResolver) =>
          this.emitMitmConnection(s, h, p, sc, ip, tapResolver as ProxyTapResolver | undefined),
      });

      server.listen(port, bindHost, () => {
        const addr = server.address();
        this._boundPort = typeof addr === 'object' && addr ? addr.port : port;
        const hosts = [...this.anchorRules.keys()];
        logger.info(
          { port: this._boundPort, host: bindHost, transparentHosts: hosts },
          'Credential proxy started (transparent mode)',
        );
        resolve(server);
      });
      server.on('error', reject);
    });
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: CredentialProxy | null = null;

/** Set the global proxy instance (called once at startup). */
export function setProxyInstance(proxy: CredentialProxy): void {
  _instance = proxy;
}

/** Clear the global instance (used by shutdown and tests). */
export function clearProxyInstance(): void {
  _instance = null;
}

/** Is the global proxy instance set? */
export function hasProxyInstance(): boolean {
  return _instance !== null;
}

/**
 * Get the global proxy instance.
 * Modules that can't receive the instance via parameters use this.
 */
export function getProxy(): CredentialProxy {
  if (!_instance) throw new Error('CredentialProxy not initialized — call setProxyInstance() first');
  return _instance;
}
