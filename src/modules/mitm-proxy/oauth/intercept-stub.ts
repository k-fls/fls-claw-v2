/**
 * Authorize-stub response writer.
 *
 * When the proxy intercepts a request to a provider's
 * `authorization_endpoint`, it can't forward it (that would start a real
 * browser redirect the agent can't complete). Instead it writes this stub
 * so the calling library believes the authorize step was accepted, while
 * the host surfaces the URL to a human out-of-band and delivers the code
 * back into the container's localhost callback.
 *
 * `interactionId` (when present) lets a client poll `/interaction/{id}/…`
 * for progress; those endpoints are optional observability, not required
 * for the flow to complete. Direct port of v1's `writeInterceptStub`.
 */
import type { ServerResponse } from 'http';

export function writeInterceptStub(res: ServerResponse, authUrl: string, interactionId: string | null): void {
  const encodedId = interactionId ? encodeURIComponent(interactionId) : null;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'intercepted',
      message: 'OAuth authorization URL intercepted by proxy and queued for user authentication',
      url: authUrl,
      ...(interactionId && {
        interactionId,
        statusUrl: `/interaction/${encodedId}/status`,
        eventsUrl: `/interaction/${encodedId}/events`,
      }),
    }),
  );
}
