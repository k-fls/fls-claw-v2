/**
 * `reload_auth_providers` sync action (host side).
 *
 * A container's per-container OAuth provider tier (declared in
 * `groups/<folder>/.auth-discovery/`) is normally loaded once, when the
 * container's bridge IP is allocated at spawn (see `observer.ts`'s `onAllocate`
 * hook). When an agent edits or adds provider defs mid-session it would
 * otherwise have to wait for a container restart for them to take effect. This
 * action re-runs `loadGroupProvidersForContainer` for the **calling container's
 * own IP**, replacing its tier in place — no restart needed.
 *
 * The caller's IP is resolved from its session (container↔IP↔session is 1:1) —
 * never taken from the request body — so a container can only ever reload its
 * own tier, not a sibling's. Returns the same `{ registered, rejected }` shape
 * `loadGroupProvidersForContainer` produces (and writes back as the load report).
 *
 * Registered as a sync action; the container triggers it via the
 * `reload_auth_providers` MCP tool.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction } from '../../delivery.js';
import { lookupIPForSession } from '../container-bootstrap/index.js';

import { getProxy, hasProxyInstance } from './credential-proxy.js';
import { loadGroupProvidersForContainer } from './oauth/index.js';
import { asGroupScope } from './types.js';

registerDeliveryAction('reload_auth_providers', async (_content, session) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) throw new Error('reload_auth_providers: unknown agent group');

  if (!hasProxyInstance()) {
    throw new Error('reload_auth_providers: credential proxy is not running');
  }

  const ip = lookupIPForSession(session.id);
  if (!ip) {
    throw new Error('reload_auth_providers: no container IP bound to this session');
  }

  const result = loadGroupProvidersForContainer(asGroupScope(agentGroup.folder), ip, getProxy());
  return { registered: result.registered, rejected: result.rejected };
});
