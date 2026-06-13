/**
 * `/tap` host command — proxy tap-logger control surface (inventory C-tap).
 *
 * Ports the fork's `/tap` (v1 `src/commands/auth-commands.ts`). The tap
 * engine itself (`proxy-tap-logger.ts`) was already ported with C2; this is
 * the missing operator entry point that drives it.
 *
 * Registered with `scope: 'host'`: there is a single global proxy instance,
 * one tap filter, and one log file (`data/proxy-tap.jsonl`), so the command is
 * a process-wide concern, not per-agent. Because the tap exposes raw
 * cross-group proxy headers/bodies, it registers with
 * `access: 'global-admin'` — the gate denies non-(owner/global-admin)
 * callers before the handler runs; scoped admins do not qualify. The v2
 * equivalent of the fork's main-group-only access.
 *
 * NOT ported: the env-based boot activation (`PROXY_TAP_DOMAIN` /
 * `PROXY_TAP_PATH` → `createTapFilterFromEnv`). `/tap` is the sole activation
 * path in v2.
 */
import fs from 'fs';
import path from 'path';

import type { HostCommandContext } from '../../../command-gate.js';
import { GROUPS_DIR } from '../../../config.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { getCredentialProvider } from '../../credentials/providers/registry.js';
import { AGENT_RUNTIME } from '../../credentials/providers/types.js';
import { getProxy } from '../credential-proxy.js';
import { clearActiveTap, createTapFilter, getActiveTap, LOG_FILE, readTapLog } from '../proxy-tap-logger.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Read a group's materialized `container.json` (carries `env`/`runtimeConfig`). */
function readGroupContainerJson(
  folder: string,
): { provider?: string; env?: Record<string, string>; runtimeConfig?: unknown; model?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(GROUPS_DIR, folder, 'container.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Default `/tap all` host exclusions, reported by the runtimes themselves.
 *
 * Each agent group's runtime provider (the one declaring AGENT_RUNTIME) knows
 * the endpoint its model traffic goes to — which is *configurable* per group
 * (e.g. `ANTHROPIC_BASE_URL` repointed at an Ollama host). That host often
 * matches no credential-provider rule, so it can't be excluded by provider id;
 * the runtime names it via `defaultTapExcludeHosts(cfg)`. Because the tap is
 * global, union the reported hosts across every group. An explicit
 * `exclude=…` (provider-id based) is a separate override.
 */
function defaultExcludeHosts(): string[] {
  const hosts = new Set<string>();
  for (const group of getAllAgentGroups()) {
    const cfg = readGroupContainerJson(group.folder);
    const providerId = (cfg?.provider ?? group.agent_provider ?? 'claude').toLowerCase();
    const runtime = getCredentialProvider(providerId)?.getExtension?.(AGENT_RUNTIME);
    const reported = runtime?.defaultTapExcludeHosts?.({
      runtimeConfig: cfg?.runtimeConfig,
      env: cfg?.env,
      model: cfg?.model,
    });
    if (reported) {
      for (const host of reported) {
        const h = String(host).trim().toLowerCase();
        if (h) hosts.add(h);
      }
    }
  }
  return [...hosts];
}

export const TAP_HELP = 'Control the proxy tap logger — /tap [all [exclude=…] | <domain> <path> | list | stop]';

const USAGE = [
  'Usage:',
  '`/tap` — show current tap state',
  '`/tap all [exclude=p1,p2]` — tap all traffic (default-excludes each runtime’s model endpoint host)',
  '`/tap <domain-regex> <path-regex>` — tap matching requests',
  '`/tap list [head|tail <N>] [body]` — show logged entries',
  '`/tap stop` — disable the tap',
].join('\n');

export function handleTapCommand(ctx: HostCommandContext): void {
  const args = ctx.argsRaw.trim();

  // /tap (no args) — show current state
  if (!args) {
    const active = getActiveTap();
    if (!active) {
      ctx.replyText('Tap is not active.');
      return;
    }
    ctx.replyText(`Tap active — domain: ${active.domain}, path: ${active.path}\nLog: ${LOG_FILE}`);
    return;
  }

  // /tap stop — disable
  if (args === 'stop') {
    getProxy().setTapFilter(null);
    clearActiveTap();
    ctx.replyText('Tap stopped.');
    return;
  }

  // /tap list [head|tail <N>] [body] — show log entries
  if (args === 'list' || args.startsWith('list ')) {
    const listArgs = args.slice(4).trim().split(/\s+/).filter(Boolean);
    let mode: 'head' | 'tail' = 'tail';
    let count = 5;
    const showBody = listArgs.includes('body');
    const filtered = listArgs.filter((a) => a !== 'body');
    if (filtered[0] === 'head' || filtered[0] === 'tail') {
      mode = filtered[0];
      if (filtered[1]) count = parseInt(filtered[1], 10) || 5;
    } else if (filtered[0]) {
      count = parseInt(filtered[0], 10) || 5;
    }
    ctx.replyText(readTapLog(mode, count, showBody));
    return;
  }

  // /tap all [exclude=provider1,provider2] — tap everything.
  //   - explicit `exclude=…` → provider-id exclusion (v1 parity).
  //   - no explicit exclude → host exclusion of each runtime's configured
  //     model endpoint (see defaultExcludeHosts), so e.g. an Ollama-pointed
  //     group's traffic isn't logged even though it matches no provider rule.
  if (args === 'all' || args.startsWith('all ')) {
    const allArgs = args.slice(3).trim();
    if (allArgs && !/^exclude=\S*$/.test(allArgs)) {
      ctx.replyText('Usage: /tap all [exclude=provider1,provider2]');
      return;
    }
    const excludeMatch = allArgs.match(/^exclude=(\S*)$/);
    let excludeProviders = new Set<string>();
    let excludeHosts: string[] = [];
    if (excludeMatch) {
      const { excluded, unknown } = getProxy().parseTapExclude(excludeMatch[1]);
      if (unknown.length > 0) {
        ctx.replyText(`Unknown provider(s): ${unknown.join(', ')}`);
        return;
      }
      excludeProviders = excluded;
    } else {
      excludeHosts = defaultExcludeHosts();
    }

    const filter = createTapFilter(
      new RegExp(''),
      new RegExp(''),
      LOG_FILE,
      excludeProviders,
      excludeHosts.map((h) => new RegExp(`^${escapeRegex(h)}$`, 'i')),
    );
    getProxy().setTapFilter(filter);
    const excludeLabel =
      excludeProviders.size > 0
        ? `\nExcluding providers: ${[...excludeProviders].join(', ')}`
        : excludeHosts.length > 0
          ? `\nExcluding hosts: ${excludeHosts.join(', ')}`
          : '';
    ctx.replyText(`Tap started — all traffic${excludeLabel}\nLog: ${LOG_FILE}`);
    return;
  }

  // /tap <domain> <path> — enable a targeted tap
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    ctx.replyText(USAGE);
    return;
  }
  const [domain, pathPattern] = parts;
  try {
    const filter = createTapFilter(new RegExp(domain), new RegExp(pathPattern), LOG_FILE);
    getProxy().setTapFilter(filter);
    ctx.replyText(`Tap started — domain: ${domain}, path: ${pathPattern}\nLog: ${LOG_FILE}`);
  } catch (e) {
    ctx.replyText(`Invalid regex: ${e instanceof Error ? e.message : e}`);
  }
}
