/**
 * Authorize-stub handler. Sits in front of a provider's
 * `authorization_endpoint`:
 *
 *   - Reconstruct the full authorization URL from the intercepted request.
 *   - Hand it to `ctx.oauthEvents.beginAuthorizeStub`, which surfaces the
 *     URL to a human, captures the returned code (or localhost callback
 *     URL), and delivers it into the container's own localhost callback
 *     via `docker exec`. It returns an interaction id synchronously.
 *   - Write the stub response so the calling library proceeds.
 *
 * When the interactive surface isn't wired (`oauthEvents` / `deliverCallback`
 * absent — e.g. tests) or no user/session can be resolved from the source
 * IP, forward the request unchanged so behaviour degrades to a plain
 * pass-through rather than a hang. Behavioural port of v1's
 * `createAuthorizeStubHandler`.
 */
import { proxyPipe } from '../../credential-proxy.js';
import type { HostHandler } from '../../credential-proxy.js';
import type { HandlerContext } from '../handler-context.js';
import { writeInterceptStub } from '../intercept-stub.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

export function buildAuthorizeStubHandler(
  provider: OAuthProvider,
  _rule: InterceptRule,
  ctx: HandlerContext,
): HostHandler {
  return async (clientReq, clientRes, targetHost, targetPort, scope, sourceIP) => {
    const authUrl = `https://${targetHost}${clientReq.url ?? ''}`;

    // Need both the chat surface and a way to deliver the code back into the
    // container. Either missing → pass through.
    const interactionId =
      ctx.oauthEvents && ctx.deliverCallback
        ? ctx.oauthEvents.beginAuthorizeStub({
            sourceIP,
            providerId: provider.id,
            authUrl,
            deliverCallback: ctx.deliverCallback,
          })
        : null;

    if (interactionId) {
      writeInterceptStub(clientRes, authUrl, interactionId);
      return;
    }

    // No user to prompt (or surface unwired) — forward the authorize request.
    proxyPipe(clientReq, clientRes, targetHost, targetPort, () => {}, scope);
  };
}
