/**
 * GET /credentials/<providerId>/substitute?path=<credentialPath>[&envVar=<name>]
 *
 * Lets a running container pull a substitute token for a provider whose
 * credentials were added after the container started, or for providers
 * without an _env_vars mapping. The proxy identifies the caller by IP
 * and resolves the group scope automatically.
 *
 * Provider metadata (substituteConfig, envBindings) is looked up in the
 * single credentials provider registry, narrowed via the
 * `isSubstitutingProvider` type guard. Reserved env-var name validation
 * goes through `isReservedEnvName()` from `container-bootstrap` so the
 * deny set tracks what the container-runner actually injects.
 */
import type { IncomingMessage, ServerResponse } from 'http';

import { getCredentialProvider } from '../credentials/providers/registry.js';

import { logger } from './logger.js';
import { getTokenEngine } from './token-substitute.js';
import type { GroupScope } from './types.js';
import { asCredentialScope, isSubstitutingProvider } from './types.js';
import { isReservedEnvName, validateEnvVarFormat } from './env-name-validation.js';

/** Successful substitute resolution for a (scope, provider, path). */
export interface SubstituteResolution {
  substitute: string;
  providerId: string;
  credentialPath: string;
  envNames: string[];
}

/** A resolution failure, with an HTTP-style status the proxy endpoint maps onto
 * a response and the sync-action handler turns into an Error. */
export interface SubstituteError {
  status: number;
  error: string;
}

export function isSubstituteError(r: SubstituteResolution | SubstituteError): r is SubstituteError {
  return 'error' in r;
}

/**
 * Resolve (or mint) a substitute token for a credential in `scope`. Pure core
 * shared by both the proxy's `/credentials/.../substitute` endpoint and the
 * `get_credential` sync action — neither owns the logic. The substitute is a
 * non-sensitive placeholder swapped for the real token only at the proxy
 * boundary, so it is safe to return, log, and persist.
 */
export function resolveSubstituteForScope(
  scope: GroupScope,
  providerId: string,
  credentialPath: string,
  envVar?: string | null,
): SubstituteResolution | SubstituteError {
  if (!credentialPath) {
    return { status: 400, error: 'Missing required parameter: path (e.g. oauth or api_key)' };
  }

  if (envVar) {
    const fmt = validateEnvVarFormat(envVar);
    if (fmt) return { status: 400, error: fmt };
    if (isReservedEnvName(envVar)) return { status: 400, error: `Reserved env var name: '${envVar}'` };
  }

  // Scope-aware: resolves per-group `.auth-discovery/` providers, which live
  // only in the caller scope's tier (not the global registry).
  const provider = getCredentialProvider(providerId, asCredentialScope(scope));
  if (!provider || !isSubstitutingProvider(provider)) {
    return { status: 404, error: `Unknown provider: ${providerId}` };
  }

  const envNames: string[] = [];
  for (const name of provider.substitutes.envNamesFor(credentialPath)) {
    if (!envNames.includes(name)) envNames.push(name);
  }
  if (envVar && !envNames.includes(envVar)) envNames.push(envVar);

  const engine = getTokenEngine();
  const substitute = engine.getOrCreateSubstitute(
    providerId,
    {},
    scope,
    credentialPath,
    envNames.length > 0 ? envNames : undefined,
  );

  if (!substitute) {
    return {
      status: 404,
      error: `No credentials found for provider '${providerId}' (path: ${credentialPath}) in scope '${scope}'`,
    };
  }

  if (envVar) engine.mergeEnvNames(scope, providerId, substitute, [envVar]);

  logger.info({ providerId, credentialPath, scope, envNames }, 'Resolved substitute token');
  return { substitute, providerId, credentialPath, envNames };
}

/**
 * HTTP wrapper for the proxy's substitute endpoint. Parses the request and
 * delegates to {@link resolveSubstituteForScope}. Retained for back-compat; the
 * in-container retrieval path now goes through the `get_credential` sync action
 * (host-rpc), which calls the same core.
 */
export function handleSubstituteRequest(req: IncomingMessage, res: ServerResponse, scope: GroupScope): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[0] !== 'credentials' || segments[2] !== 'substitute') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected /credentials/<providerId>/substitute' }));
    return;
  }

  const providerId = decodeURIComponent(segments[1]);
  const credentialPath = url.searchParams.get('path');
  const envVarParam = url.searchParams.get('envVar');

  const result = resolveSubstituteForScope(scope, providerId, credentialPath ?? '', envVarParam);
  if (isSubstituteError(result)) {
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}
