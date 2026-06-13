/**
 * Parse a single `_env_vars` value (`"credId"` or `"credId[n]"`) into a
 * typed binding. Pure helper; ported verbatim from v1.
 */
import type { EnvVarBinding } from '../types.js';

export function parseEnvVarValue(envName: string, raw: string): EnvVarBinding | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const m = raw.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
  if (!m) return null;
  const credentialPath = m[1];
  const slice = m[2] === undefined ? undefined : Number(m[2]);
  return slice === undefined ? { envName, credentialPath } : { envName, credentialPath, slice };
}
