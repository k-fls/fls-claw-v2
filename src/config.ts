import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'ONECLI_URL', 'ONECLI_API_KEY', 'TZ']);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
// Auth-provider discovery override directory. Baseline JSONs ship in-tree at
// `src/modules/mitm-proxy/oauth/discovery/`; per-install overrides
// (typically written by the discovery refresh) live here.
export const AUTH_DISCOVERY_DIR = path.join(HOME_DIR, '.config', 'nanoclaw', 'auth-discovery');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);
// Demand-driven eviction (group-queue port). A warm (idle) container holds a
// concurrency slot; under cap pressure the oldest-idle one is evicted to make
// room. IDLE_BEFORE_EVICT protects a freshly-idle container from preemption;
// EVICTION_TIMEOUT is the no-demand backstop (the sweep reaps a heartbeat-stale,
// claim-free container after this even with no pressure). See
// docs/fls/migration-analysis/d-queue-concurrency-risks.md.
export const IDLE_BEFORE_EVICT = parseInt(process.env.IDLE_BEFORE_EVICT || '600000', 10); // 10min protection window
export const EVICTION_TIMEOUT = parseInt(process.env.EVICTION_TIMEOUT || '14400000', 10); // 4h idle backstop
// Grace window (ms, like the knobs above) for a graceful container stop —
// eviction + host shutdown. Docker sends SIGTERM, waits this long for the
// agent-runner to abort its in-flight turn + flush, then SIGKILL. Converted to
// integer seconds at the single `docker stop -t` boundary. Stuck-container
// kills ignore this and use the fast 1s path.
export const GRACEFUL_STOP_MS = Math.max(2000, parseInt(process.env.GRACEFUL_STOP_MS || '10000', 10) || 10000);

// MITM credential proxy (substitution mode). Host bind port.
// Default `0` — let the OS assign an ephemeral port. Set
// `CREDENTIAL_PROXY_PORT` only if you need a fixed port (e.g. for an
// external firewall rule). The actual bound port is observable via
// `CredentialProxy.getBoundPort()`.
export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '0', 10);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
