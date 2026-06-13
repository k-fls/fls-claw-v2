/**
 * Env-var name validation for the substitute endpoint.
 *
 * Two concerns split cleanly:
 *   - Format: a static regex check (uppercase letters/digits/underscores,
 *     starts with letter or underscore, ≤128 chars). Lives here because
 *     the substitute endpoint defines the shape it will accept.
 *   - Reserved: delegated to `container-bootstrap.isEnvNameReserved`,
 *     which is the single source of truth for "the host already injects
 *     a var by this name." This module does NOT keep its own list.
 *
 * The observer registers the mitm-proxy's own injected names
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
 * `MITM_CA_PATH`) via `reserveEnvName(name, 'mitm-proxy')` at module
 * load — see `observer.ts`.
 */
import { isEnvNameReserved as bootstrapIsReserved } from '../container-bootstrap/index.js';

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Returns an error message if the name doesn't match the format, null if valid. */
export function validateEnvVarFormat(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) {
    return `Invalid env var name format: '${name}' (must match ${ENV_NAME_RE})`;
  }
  return null;
}

/** Re-export from container-bootstrap so the substitute endpoint has one import. */
export function isReservedEnvName(name: string): boolean {
  return bootstrapIsReserved(name);
}
