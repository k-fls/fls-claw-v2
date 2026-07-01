/**
 * Bearer-swap handler. For every header that carries a known
 * substitute, swap in the real token and forward upstream. On 401,
 * attempt a refresh and apply the provider's `refreshStrategy`
 * (`redirect` / `buffer` / `passthrough`).
 *
 * v2 differences vs the v1 universal handler:
 *   - Context is closed over at factory time — no `setAuthErrorResolver`
 *     / `setTokenFetch` module globals.
 *   - Refresh writes go through the credentials-module resolver, not
 *     the engine.
 *   - Concurrent refresh dedup uses `HandlerContext.inFlightRefresh`
 *     instead of `engine.sharedOp`.
 *   - Auth-error callback path is deferred — failed refreshes return
 *     the upstream 401 to the client unmodified (no interactive prompt).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest, RequestOptions } from 'https';

import type { HostHandler } from '../../credential-proxy.js';
import { sameRegistrableDomain } from '../../domain.js';
import { logger } from '../../logger.js';
import type { CredentialScope, GroupScope } from '../../types.js';
import type { HandlerContext } from '../handler-context.js';
import type { CredentialContext, InterceptRule, OAuthProvider } from '../types.js';

import { buildDefaultTransportCodec, parseAuthScheme } from './default-codec.js';
import { tryRefresh } from './refresh.js';

type HeaderMap = Record<string, string | number | string[] | undefined>;

/** Max request body size for buffer strategy before falling back to passthrough. */
const BUFFER_MAX_BYTES = 2 * 1024 * 1024;
/** Proactive refresh trigger: refresh if token expires within this window. */
const REFRESH_AHEAD_MS = 60_000;
/**
 * Redirect-strategy circuit-breaker TTL. A refresh+redirect round-trip is
 * sub-second, so this window doesn't gate legitimate retries — it only bounds
 * how long a stale entry (left by an aborted/dropped retry) lingers before the
 * breaker treats it as absent and self-heals.
 */
const REDIRECT_BREAKER_TTL_MS = 30_000;

function prepareHeaders(req: IncomingMessage, targetHost: string): HeaderMap {
  const headers: HeaderMap = {
    ...(req.headers as Record<string, string>),
    host: targetHost,
  };
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  return headers;
}

function extractScopeAttrs(targetHost: string, rule: InterceptRule): Record<string, string> {
  if (!rule.hostPattern) return {};
  const match = rule.hostPattern.exec(targetHost);
  if (!match?.groups) return {};
  return { ...match.groups };
}

interface SwapEntry {
  headerName: string;
  /** The bare stored-form value the engine re-resolves on a refresh replay. */
  substitute: string;
  credentialId: string;
  credentialScope: CredentialScope;
  /** Rebuild this header's wire value from a (real / refreshed) token. */
  rebuild: (realToken: string) => string;
}

function sendUpstreamBuffered(
  targetHost: string,
  targetPort: number,
  method: string,
  path: string,
  headers: HeaderMap,
  body: Buffer,
): Promise<{
  statusCode: number;
  headers: import('http').IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: targetHost,
        port: targetPort,
        path,
        method,
        headers,
      } as RequestOptions,
      async (res) => {
        const chunks: Buffer[] = [];
        res.on('error', reject);
        res.on('data', (c: Buffer) => chunks.push(c));
        await new Promise<void>((r) => res.on('end', r));
        resolve({
          statusCode: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export function buildBearerSwapHandler(provider: OAuthProvider, rule: InterceptRule, ctx: HandlerContext): HostHandler {
  const refreshStrategy = provider.refreshStrategy;
  // A provider may own its on-wire encoding (e.g. GitHub git-HTTPS Basic);
  // otherwise the default codec handles the discovery shape (scheme-prefixed
  // token + the `_credential_format` base64 case). Resolved once per handler.
  const codec = provider.transportCodec ?? buildDefaultTransportCodec(provider.credentialFormat);

  return async (clientReq, clientRes, targetHost, targetPort, groupScope) => {
    // Buffer the request body up-front — the MITM HTTP parser drains
    // IncomingMessage on any microtask boundary, so attaching `data`
    // listeners later loses chunks.
    const pendingChunks: Buffer[] = [];
    let ended = false;
    let onChunk: ((c: Buffer) => void) | null = null;
    let onEnd: (() => void) | null = null;
    clientReq.on('data', (c: Buffer) => {
      pendingChunks.push(c);
      onChunk?.(c);
    });
    clientReq.on('end', () => {
      ended = true;
      onEnd?.();
    });

    const collectBody = (): Promise<Buffer> => {
      if (ended) return Promise.resolve(Buffer.concat(pendingChunks));
      return new Promise<Buffer>((resolve) => {
        onEnd = () => resolve(Buffer.concat(pendingChunks));
      });
    };
    const pipeBodyTo = (dest: import('http').ClientRequest): void => {
      for (const c of pendingChunks) dest.write(c);
      if (ended) {
        dest.end();
        return;
      }
      onChunk = (c) => dest.write(c);
      onEnd = () => dest.end();
    };

    const scopeAttrs = extractScopeAttrs(targetHost, rule);
    const headers = prepareHeaders(clientReq, targetHost);

    // Scan headers, swap substitutes for real values. The codec owns the
    // on-wire encoding: `fromTransport` extracts the bare candidate, the engine
    // resolves it, and `toTransport` rebuilds the wire value from the real token
    // (and again on a refresh replay, via the `rebuild` closure).
    const swapped: SwapEntry[] = [];
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;

      const scheme = parseAuthScheme(value);
      const candidate = codec.fromTransport(value, {
        credentialName: '',
        scheme,
        headerName: name,
        targetHost,
      });
      if (!candidate) continue;

      const entry = ctx.tokenEngine.resolveWithRestriction(candidate, groupScope, scopeAttrs);
      // Nested sub-tokens (oauth/refresh) never travel in headers — skip them.
      if (!entry || entry.mapping.credentialPath.includes('/')) continue;

      // Bound-domain guard: a credential stamped with a `boundDomain`
      // (non-global, container-sourced) may only be injected at a request
      // host sharing its registrable domain. On mismatch, forward the
      // substitute unswapped (a useless fake) rather than the real token.
      // `boundDomain` rides on the resolution result — no second lookup.
      if (entry.boundDomain && !sameRegistrableDomain(targetHost, entry.boundDomain)) {
        logger.warn(
          {
            providerId: entry.mapping.providerId,
            targetHost,
            boundDomain: entry.boundDomain,
          },
          'bearer-swap: request host outside credential bound domain — forwarding substitute unswapped',
        );
        continue;
      }

      const encodeCtx: CredentialContext = {
        credentialName: entry.mapping.credentialPath,
        scheme,
        headerName: name,
        targetHost,
      };
      const rebuild = (realToken: string): string => codec.toTransport(realToken, encodeCtx);
      headers[name] = rebuild(entry.realToken);
      swapped.push({
        headerName: name,
        substitute: candidate,
        credentialId: entry.mapping.credentialPath,
        credentialScope: entry.mapping.credentialScope,
        rebuild,
      });
    }

    // Figure out which swapped credentials are refreshable / near expiry.
    let proactiveAttempted = false;
    const refreshable = new Set<string>();
    const nearExpiry = new Set<string>();
    {
      const seen = new Set<string>();
      for (const swap of swapped) {
        if (seen.has(swap.credentialId)) continue;
        seen.add(swap.credentialId);
        const cred = ctx.tokenEngine.resolveCredential(groupScope, provider.id, swap.credentialId);
        if (!cred?.refresh) continue;
        refreshable.add(swap.credentialId);
        const exp = cred.expires_ts ?? 0;
        if (REFRESH_AHEAD_MS > 0 && exp > 0 && exp < Date.now() + REFRESH_AHEAD_MS) {
          nearExpiry.add(swap.credentialId);
        }
      }
    }

    const reResolveHeaders = (): void => {
      for (const swap of swapped) {
        const fresh = ctx.tokenEngine.resolveWithRestriction(swap.substitute, groupScope, scopeAttrs);
        if (fresh) headers[swap.headerName] = swap.rebuild(fresh.realToken);
      }
    };

    if (nearExpiry.size > 0 && refreshable.size > 0) {
      proactiveAttempted = true;
      logger.info(
        { provider: provider.id, scope: groupScope, credentials: [...nearExpiry] },
        'oauth.bearer-swap: proactive refresh before send',
      );
      const ok = await tryRefresh(provider, groupScope, ctx);
      if (ok) reResolveHeaders();
    }

    // Buffer mode: collect body now so we can replay after refresh.
    let reqBody: Buffer | null = null;
    let effectiveStrategy = refreshStrategy;
    if (refreshStrategy === 'buffer') {
      reqBody = await collectBody();
      if (reqBody.length > BUFFER_MAX_BYTES) {
        effectiveStrategy = 'passthrough';
        logger.debug(
          { provider: provider.id, scope: groupScope, size: reqBody.length },
          'oauth.bearer-swap: body exceeds buffer limit, falling back to passthrough',
        );
      }
    }

    // Send upstream — manual streaming so we can inspect status before
    // committing the response.
    await new Promise<void>((resolve) => {
      const upstream = httpsRequest(
        {
          hostname: targetHost,
          port: targetPort,
          path: clientReq.url,
          method: clientReq.method,
          headers: reqBody ? { ...headers, 'content-length': reqBody.length } : headers,
        } as RequestOptions,
        async (upRes) => {
          upRes.on('error', () => {
            if (!clientRes.headersSent) {
              clientRes.writeHead(502);
              clientRes.end();
            }
            resolve();
          });
          const statusCode = upRes.statusCode!;

          // Happy path: not a 401 — pipe through. A success means the current
          // token works, so reset the redirect breaker's one-retry budget for
          // these credentials — future legitimate refreshes redirect as normal.
          if (statusCode !== 401) {
            if (ctx.redirectRefreshBreaker) {
              for (const id of refreshable) {
                ctx.redirectRefreshBreaker.delete(`${groupScope}::${provider.id}::${id}`);
              }
            }
            clientRes.writeHead(statusCode, upRes.headers);
            upRes.pipe(clientRes);
            resolve();
            return;
          }

          // 401: buffer the upstream body, then decide whether to refresh.
          const upBodyChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => upBodyChunks.push(c));
          await new Promise<void>((r) => upRes.on('end', r));
          const upBody = Buffer.concat(upBodyChunks);

          const forwardBuffered = (status: number, rawHeaders: typeof upRes.headers, body: Buffer): void => {
            const h = { ...rawHeaders };
            delete h['transfer-encoding'];
            h['content-length'] = String(body.length);
            clientRes.writeHead(status, h);
            clientRes.end(body);
          };

          let refreshed = false;
          if (!proactiveAttempted && refreshable.size > 0) {
            logger.info(
              { provider: provider.id, scope: groupScope, status: statusCode },
              'oauth.bearer-swap: 401, attempting refresh',
            );
            refreshed = await tryRefresh(provider, groupScope, ctx);
          }

          if (!refreshed) {
            forwardBuffered(statusCode, upRes.headers, upBody);
            resolve();
            return;
          }

          switch (effectiveStrategy) {
            case 'redirect': {
              // The redirect retry is a fresh proxy request with no per-request
              // memory, so a refreshable-but-structurally-invalid credential
              // (refresh succeeds, upstream keeps 401ing the new token) would
              // loop 401→refresh→307 until the client's redirect cap. The
              // breaker gives us exactly one refresh+redirect per credential:
              // if we already redirected within the TTL and the 401 is back,
              // the refresh didn't help — forward the 401 and reset the budget.
              const breaker = ctx.redirectRefreshBreaker;
              if (breaker) {
                const now = Date.now();
                const keys = [...refreshable].map((id) => `${groupScope}::${provider.id}::${id}`);
                const tripped = keys.some((k) => {
                  const ts = breaker.get(k);
                  if (ts === undefined) return false;
                  if (now - ts >= REDIRECT_BREAKER_TTL_MS) {
                    breaker.delete(k); // stale — treat as absent (self-heal)
                    return false;
                  }
                  return true;
                });
                if (tripped) {
                  for (const k of keys) breaker.delete(k);
                  logger.warn(
                    { provider: provider.id, scope: groupScope, credentials: [...refreshable] },
                    'oauth.bearer-swap: refresh did not clear 401, forwarding 401 (redirect breaker tripped)',
                  );
                  forwardBuffered(statusCode, upRes.headers, upBody);
                  resolve();
                  break;
                }
                for (const k of keys) breaker.set(k, now);
              }
              clientRes.writeHead(307, {
                location: `https://${targetHost}${clientReq.url}`,
                'content-length': '0',
              });
              clientRes.end();
              resolve();
              break;
            }
            case 'buffer': {
              try {
                const replayHeaders = { ...headers };
                for (const swap of swapped) {
                  const fresh = ctx.tokenEngine.resolveWithRestriction(swap.substitute, groupScope, scopeAttrs);
                  if (fresh) {
                    replayHeaders[swap.headerName] = swap.rebuild(fresh.realToken);
                  }
                }
                const replay = await sendUpstreamBuffered(
                  targetHost,
                  targetPort,
                  clientReq.method || 'GET',
                  clientReq.url || '/',
                  replayHeaders,
                  reqBody ?? Buffer.alloc(0),
                );
                forwardBuffered(replay.statusCode, replay.headers, replay.body);
              } catch (err) {
                logger.error({ err, provider: provider.id }, 'oauth.bearer-swap: replay failed');
                if (!clientRes.headersSent) {
                  clientRes.writeHead(502);
                  clientRes.end('Bad Gateway');
                }
              }
              resolve();
              break;
            }
            case 'passthrough': {
              // Token is refreshed; client's next request gets the new sub.
              forwardBuffered(statusCode, upRes.headers, upBody);
              resolve();
              break;
            }
          }
        },
      );

      upstream.on('error', (err) => {
        logger.error({ err, host: targetHost, url: clientReq.url }, 'oauth.bearer-swap: upstream error');
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end('Bad Gateway');
        }
        resolve();
      });

      if (reqBody) upstream.end(reqBody);
      else pipeBodyTo(upstream);
    });
  };
}
