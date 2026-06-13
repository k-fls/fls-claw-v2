/**
 * `/oauth/browser-open` host-rpc endpoint — the host side of the container
 * `xdg-open` shim (C10).
 *
 * The shim POSTs `{ url }` whenever a tool inside the container tries to open
 * a browser. We check whether the URL is a known OAuth *authorize* endpoint
 * (`matchAuthorizeUrl`); if so, hand it to the interactive authorize-stub
 * flow, which surfaces the URL to the operator and relays the resulting code
 * back into this container via `docker exec`. The caller's container is
 * resolved from `req.callerIP` (host-rpc already validated it → scope).
 *
 * Response contract (mirrors v1):
 *   - known + queued → `{ exit_code: 0, interactionId }` — shim exits 0.
 *   - anything else  → `{}` — shim falls through to a real xdg-open / exit 1.
 *
 * This is distinct from the proxy's *interception* of an authorize request:
 * a browser-launch URL is opened on the operator's machine, never on the
 * wire we MITM, so the shim is the only way to catch it.
 */
import { registerHostRpc } from '../host-rpc/index.js';

import { getProxy, hasProxyInstance } from './credential-proxy.js';
import { logger } from './logger.js';
import { matchAuthorizeUrl } from './oauth/index.js';
import { dockerExecDeliver, oauthInteractive } from './oauth/oauth-interactive.js';

registerHostRpc('/oauth/browser-open', (req) => {
  if (req.method !== 'POST') return {};
  const body = req.body as { url?: unknown } | undefined;
  const url = typeof body?.url === 'string' ? body.url : null;
  if (!url) return {};

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {}; // not a URL — pass through
  }

  const providerId = matchAuthorizeUrl(parsed.hostname, parsed.pathname);
  if (!providerId) return {}; // not a known OAuth authorize endpoint

  // Defensive: cross-check the source IP maps to a registered container.
  if (!hasProxyInstance() || !getProxy().resolveScope(req.callerIP)) {
    logger.warn({ callerIP: req.callerIP }, 'browser-open: unresolved caller scope');
    return {};
  }

  const interactionId = oauthInteractive.beginAuthorizeStub({
    sourceIP: req.callerIP,
    providerId,
    authUrl: url,
    deliverCallback: dockerExecDeliver,
  });
  if (!interactionId) return {}; // couldn't prompt anyone → pass through

  return { exit_code: 0, interactionId };
});
