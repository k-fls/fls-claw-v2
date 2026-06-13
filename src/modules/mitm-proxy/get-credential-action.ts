/**
 * `get_credential` sync action (host side).
 *
 * Lets a running container pull a substitute token for any registered
 * substituting provider — for credentials added after spawn, or providers with
 * no spawn-time env injection. Registered as a **sync action** (see
 * `src/modules/sync-actions/`): the container writes the request to its
 * outbound DB and triggers the wakeup; this handler resolves the substitute and
 * returns it as the sync result (persisted to inbound.db by the framework).
 *
 * The substitute is a non-sensitive placeholder — the real token is swapped in
 * only at the proxy boundary — so returning and persisting it leaks nothing.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction } from '../../delivery.js';

import { resolveSubstituteForScope, isSubstituteError } from './substitute-endpoint.js';
import { asGroupScope } from './types.js';

registerDeliveryAction('get_credential', async (content, session) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) throw new Error('get_credential: unknown agent group');

  const providerId = typeof content.providerId === 'string' ? content.providerId : '';
  const credentialPath = typeof content.credentialPath === 'string' ? content.credentialPath : '';
  const envVar = typeof content.envVar === 'string' ? content.envVar : null;
  if (!providerId) throw new Error('get_credential: providerId is required');
  if (!credentialPath) throw new Error('get_credential: credentialPath is required');

  const result = resolveSubstituteForScope(asGroupScope(agentGroup.folder), providerId, credentialPath, envVar);
  if (isSubstituteError(result)) throw new Error(result.error);
  return result; // { substitute, providerId, credentialPath, envNames }
});
