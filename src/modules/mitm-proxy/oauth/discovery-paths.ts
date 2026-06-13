/**
 * Resolve the two directories the discovery loader reads.
 *
 *   - baseline: in-tree, ships with the repo. Source of truth for the
 *     set of known providers.
 *   - override: out-of-tree (`~/.config/nanoclaw/auth-discovery/`).
 *     Writable by the refresh path. Standard OIDC fields here override
 *     the baseline; `_*` custom fields never do.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { AUTH_DISCOVERY_DIR, GROUPS_DIR } from '../../../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Name of the load report the per-group loader writes back into a group's
 * `auth-discovery/` directory after each load (see `loadGroupProvidersForContainer`).
 * It records which declared providers were installed and which were rejected
 * (with reasons), so an agent editing provider defs gets immediate feedback.
 * The loader skips this file by name so it's never parsed as a provider def.
 */
export const OAUTH_LOAD_REPORT_FILENAME = '_load-report.json';

/** In-tree baseline directory: `src/modules/mitm-proxy/oauth/discovery/`. */
export function baselineDiscoveryDir(): string {
  return path.join(HERE, 'discovery');
}

/** Out-of-tree override directory (per-install, writable). */
export function overrideDiscoveryDir(): string {
  return AUTH_DISCOVERY_DIR;
}

/**
 * Per-group discovery directory: `groups/<folder>/.auth-discovery/`.
 * `scope` is the agent-group folder (== `GroupScope`). May not exist —
 * the loader treats a missing dir as "no group providers".
 *
 * Dot-prefixed so it stays out of a default `ls` in the agent's workspace
 * (the group dir is mounted RW at `/workspace/agent`) — it's machinery the
 * agent edits deliberately (see the `auth-providers` container skill), not
 * everyday workspace clutter.
 */
export const GROUP_DISCOVERY_DIRNAME = '.auth-discovery';

export function groupDiscoveryDir(scope: string): string {
  return path.join(GROUPS_DIR, scope, GROUP_DISCOVERY_DIRNAME);
}
