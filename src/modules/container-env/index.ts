/**
 * Container custom env vars (inventory I1).
 *
 * Lets an operator/agent persist arbitrary environment variables for an agent
 * group across sessions by appending JSONL lines to
 * `groups/<folder>/env-custom.jsonl` (`{"name":"FOO","value":"bar"}`). On each
 * spawn the host curates the file and injects the result via the agent-group
 * contribution registry (A3), so the values land in the container env.
 *
 * This is a standalone concern — independent of the MITM proxy. The proxy is
 * merely one *producer* of values (substitutes published via the container-side
 * BASH_ENV file); this module is the host-curated, persisted env surface.
 *
 * Curation rules:
 *   - name must match UPPER_SNAKE format;
 *   - name must not be reserved by the host (the same `isEnvNameReserved`
 *     registry the substitute path consults — so custom env can never shadow a
 *     var the container-runner itself injects);
 *   - last write wins for a duplicated name.
 * A bad line is skipped (logged), never fatal.
 */
import fs from 'fs';
import path from 'path';

import { registerAgentGroupContribution } from '../../agent-group-contributions.js';
import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';
import { isEnvNameReserved } from '../container-bootstrap/index.js';

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

function customEnvFile(folder: string): string {
  return path.resolve(GROUPS_DIR, folder, 'env-custom.jsonl');
}

/** Read + curate a group's custom env. Returns name→value (last-write-wins). */
export function loadCustomEnv(folder: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(customEnvFile(folder), 'utf8');
  } catch {
    return {}; // common case — no custom env declared
  }

  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: { name?: unknown; value?: unknown };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      log.warn('container-env: skipping unparseable line', { folder });
      continue;
    }

    const name = typeof entry.name === 'string' ? entry.name : '';
    const value = typeof entry.value === 'string' ? entry.value : null;
    if (!name || value === null) {
      log.warn('container-env: skipping entry missing name/value', { folder });
      continue;
    }
    if (!ENV_NAME_RE.test(name)) {
      log.warn('container-env: invalid env var name, skipping', { folder, name });
      continue;
    }
    if (isEnvNameReserved(name)) {
      log.warn('container-env: name reserved by host, skipping', { folder, name });
      continue;
    }
    out[name] = value;
  }
  return out;
}

registerAgentGroupContribution('container-env', (ctx) => {
  const env = loadCustomEnv(ctx.agentGroup.folder);
  return Object.keys(env).length > 0 ? { env } : {};
});
