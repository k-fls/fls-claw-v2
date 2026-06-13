/**
 * Device-code handler. Sits in front of a provider's
 * `device_authorization_endpoint`:
 *
 *   - Forward the device-authorization request to upstream (buffered).
 *   - Parse `user_code` + `verification_uri(_complete)` out of the 2xx
 *     response and surface them to the user via `ctx.oauthEvents`.
 *   - Return the upstream response to the container unchanged — the
 *     container then polls the token endpoint itself (handled by the
 *     token-exchange / bearer-swap paths) until the user authorizes.
 *
 * No code travels back through the host: device-code is notification-only.
 * Direct behavioural port of v1's `createDeviceCodeHandler`.
 */
import { proxyBuffered } from '../../credential-proxy.js';
import type { HostHandler } from '../../credential-proxy.js';
import { logger } from '../../logger.js';
import type { HandlerContext } from '../handler-context.js';
import { parseBody } from '../oauth-interceptor.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

export function buildDeviceCodeHandler(
  provider: OAuthProvider,
  _rule: InterceptRule,
  ctx: HandlerContext,
): HostHandler {
  return async (clientReq, clientRes, targetHost, targetPort, scope, sourceIP) => {
    await proxyBuffered(
      clientReq,
      clientRes,
      targetHost,
      targetPort,
      (headers) => {
        // proxyBuffered does string conversion on the body; a gzipped
        // response would be corrupted, so refuse compression upstream.
        delete headers['accept-encoding'];
      },
      (body) => body,
      (body, statusCode) => {
        // proxyBuffered only calls this for 2xx, but guard anyway.
        if (statusCode < 200 || statusCode >= 300) return body;
        const parsed = parseBody(body);
        if (!parsed) {
          logger.warn({ provider: provider.id, scope }, 'oauth.device-code: could not parse response body');
          return body;
        }
        const userCode = parsed.fields.user_code;
        const verificationUri = parsed.fields.verification_uri_complete || parsed.fields.verification_uri;
        if (userCode && verificationUri) {
          ctx.oauthEvents?.notifyDeviceCode({
            sourceIP,
            providerId: provider.id,
            userCode,
            verificationUri,
          });
        } else {
          logger.warn(
            { provider: provider.id, scope, hasCode: !!userCode, hasUri: !!verificationUri },
            'oauth.device-code: response missing user_code / verification_uri',
          );
        }
        return body;
      },
    );
  };
}
