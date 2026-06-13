/**
 * Dispatch one InterceptRule to a HostHandler.
 *
 * All four modes are implemented. `bearer-swap` and `token-exchange`
 * are the in-flight credential-swap paths; `device-code` and
 * `authorize-stub` are the interactive browser flows, which surface to a
 * human (and, for authorize-stub, deliver the code back) via
 * `HandlerContext.oauthEvents`. When that surface is absent the
 * interactive handlers degrade to a notification no-op / pass-through, so
 * building them is always safe.
 */
import type { HostHandler } from '../../credential-proxy.js';
import type { HandlerContext } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildAuthorizeStubHandler } from './authorize-stub.js';
import { buildBearerSwapHandler } from './bearer-swap.js';
import { buildDeviceCodeHandler } from './device-code.js';
import { buildTokenExchangeHandler } from './token-exchange.js';

export function buildHandlerForRule(
  provider: OAuthProvider,
  rule: InterceptRule,
  ctx: HandlerContext,
): HostHandler | null {
  switch (rule.mode) {
    case 'bearer-swap':
      return buildBearerSwapHandler(provider, rule, ctx);
    case 'token-exchange':
      return buildTokenExchangeHandler(provider, rule, ctx);
    case 'device-code':
      return buildDeviceCodeHandler(provider, rule, ctx);
    case 'authorize-stub':
      return buildAuthorizeStubHandler(provider, rule, ctx);
  }
}
