/**
 * Browser-auth container spawn — the host side of P3.
 *
 * A short-lived container that runs `claude setup-token` / `claude auth login`
 * for one OAuth episode. NOT routed through the session-centric
 * `spawnContainer`: an auth container is not a session (no heartbeat, poll
 * loop, or session DB).
 *
 * It DOES route through the MITM proxy (unconditionally): the proxy intercepts
 * the CLI's token-exchange and stores the real credential host-side. This is
 * how the credential is captured — the runner only drives the OAuth UX
 * (relay the URL, deliver the pasted code); it does NOT read the token (the CLI
 * only ever sees substitutes). Verified live: `claude setup-token` hits
 * `platform.claude.com/v1/oauth/token`, which the proxy captures (incl.
 * `authFields` like `client_id`, needed for later refresh).
 *
 * What it reuses from the agent spawn machinery:
 *   - `allocateContainerIP(scope)` — registers the container IP → scope so both
 *     the host-rpc `/auth/*` bridge and the proxy authorize it.
 *   - `baseRunArgs` / `hostGatewayArgs` / `networkArgs` and the proxy
 *     contribution (`buildMitmProxyContribution`).
 *   - the **normal** `entrypoint.sh` + the snapshot `/app/src` tree.
 *
 * How the auth-runner runs (v1's mechanism): the normal entrypoint is used
 * unchanged and the auth-runner is mounted **over `/app/src/index.ts`** — so
 * `bun run /app/src/index.ts` runs the auth flow instead of the poll loop. Its
 * `./auth/*` imports resolve through the sibling `/app/src` dir mount.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, TIMEZONE } from './config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { baseRunArgs } from './container-runner.js';
import {
  allocateContainerIP,
  networkArgs,
  snapshotPath,
  resolveLaunchMode,
  defaultLaunchShape,
  type ContainerScope,
  type LaunchMode,
} from './modules/container-bootstrap/index.js';
import { hostRpcPort } from './modules/host-rpc/index.js';
import { buildMitmProxyContribution } from './modules/mitm-proxy/index.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import { log } from './log.js';

export type AuthMode = 'setup_token' | 'auth_login';

/** Backstop kill — the host episode times out at 10 min; allow margin past that. */
const AUTH_MAX_LIFETIME_MS = 12 * 60_000;

export interface AuthSpawnArgsInput {
  containerName: string;
  ip: string;
  mode: AuthMode;
  nonce: string;
  rpcPort: number;
  launchMode: LaunchMode;
  /**
   * Fully-assembled mount list: the standard launch shape (normal
   * `entrypoint.sh` + `/app/src` + skills), the auth-runner shimmed OVER
   * `/app/src/index.ts`, the proxy CA mount, and the provider's CLI-home mount.
   * Assembled by the caller so this stays pure.
   */
  mounts: VolumeMount[];
  /** Extra env (proxy env from the mitm contribution + provider env). */
  extraEnv?: Record<string, string>;
  /** Extra run flags (the mitm contribution's `--cap-add=NET_ADMIN`). */
  extraArgs?: string[];
  image: string;
}

/** Build the full `docker run …` argv for an auth container. Pure (no spawn, no fs). */
export function buildAuthSpawnArgs(input: AuthSpawnArgsInput): string[] {
  const args = baseRunArgs(input.containerName);
  args.push(...networkArgs(input.ip));
  args.push(...hostGatewayArgs());

  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_AUTH_MODE=${input.mode}`);
  args.push('-e', `NANOCLAW_AUTH_NONCE=${input.nonce}`);
  args.push('-e', `NANOCLAW_HOST_RPC_PORT=${input.rpcPort}`);
  // Let the normal entrypoint's passwd shim run under root-drop, so the
  // `claude` CLI / git don't fail resolving a foreign HOST_UID.
  args.push('-e', 'ENSURE_PASSWD_ENTRY=1');
  // NOTE: NO_PROXY=host.docker.internal (so the runner's host-rpc calls bypass
  // the proxy) arrives via the proxy contribution's env — see
  // buildMitmProxyContribution.
  // Extra env (proxy env from the mitm contribution + provider env).
  for (const [k, v] of Object.entries(input.extraEnv ?? {})) {
    args.push('-e', `${k}=${v}`);
  }

  // Privilege: prefer root-drop (so the entrypoint's passwd shim + setpriv +
  // proxy DNAT/CA install run), fall back to rootless --user when host ids are
  // unknown.
  if (input.launchMode.kind === 'root-drop') {
    args.push('--user', '0:0');
    args.push('-e', `HOST_UID=${input.launchMode.envVars.HOST_UID}`);
    args.push('-e', `HOST_GID=${input.launchMode.envVars.HOST_GID}`);
    args.push('-e', 'HOME=/home/node');
  } else if (input.launchMode.userArg) {
    args.push('--user', input.launchMode.userArg);
    args.push('-e', 'HOME=/home/node');
  }

  // Extra run flags (deduped — baseRunArgs already sets no-new-privileges).
  for (const a of input.extraArgs ?? []) {
    if (!args.includes(a)) args.push(a);
  }

  // Mounts (assembled by the caller; see the field doc).
  for (const m of input.mounts) {
    if (m.readonly) args.push(...readonlyMountArgs(m.hostPath, m.containerPath));
    else args.push('-v', `${m.hostPath}:${m.containerPath}`);
  }

  args.push(input.image);
  return args;
}

/**
 * Provider-supplied auth-container contribution. The auth flow is generic
 * infra (IP/network/host-rpc bridge/proxy); whatever a provider's auth CLI
 * specifically needs — e.g. a writable home for the `claude` CLI — is declared
 * here by that provider, not baked in. `scratchDir` is the per-spawn dir
 * (auto-removed on exit); place any writable mount sources under it.
 */
export interface AuthContainerContribution {
  mounts?: VolumeMount[];
  env?: Record<string, string>;
}

export interface SpawnAuthContainerOptions {
  /** Credential / container scope = group folder (branded). */
  scope: ContainerScope;
  /** Plain group folder string (for naming + scratch dirs). */
  folder: string;
  mode: AuthMode;
  /** Per-episode nonce, also seeded into the host auth-bridge episode. */
  nonce: string;
  /** Provider-specific mounts/env for its auth CLI (see AuthContainerContribution). */
  contribute?: (scratchDir: string) => AuthContainerContribution;
}

/**
 * Spawn the auth container and resolve once it exits (or the max-lifetime
 * backstop fires). Always releases the container IP and removes the scratch
 * dir. The credential is captured host-side by the proxy during the run; the
 * caller decides success by checking whether a credential now exists.
 */
export async function spawnAuthContainer(opts: SpawnAuthContainerOptions): Promise<void> {
  const allocated = allocateContainerIP(opts.scope);
  const stamp = Date.now();
  const containerName = `nanoclaw-auth-${opts.folder}-${stamp}`;
  const workDir = path.join(DATA_DIR, 'auth-spawns', `${opts.folder}-${stamp}`);
  fs.mkdirSync(workDir, { recursive: true });

  const contribution = opts.contribute?.(workDir) ?? {};

  // Route the auth container through the MITM proxy so it intercepts + captures
  // the CLI's token-exchange (the capture mechanism). Unconditional —
  // browser-auth depends on it.
  const mitm = buildMitmProxyContribution();
  if (!mitm) {
    log.warn('Auth container: no MITM proxy instance — credential capture cannot occur', { containerName });
  }

  // Generic infra: standard launch shape (normal entrypoint + /app/src +
  // skills) + the auth-runner shimmed over /app/src/index.ts. Then the
  // provider's CLI-home mount and the proxy's CA mount.
  const mounts: VolumeMount[] = [
    ...defaultLaunchShape().mounts,
    { hostPath: snapshotPath('agent-runner/src/auth-runner.ts'), containerPath: '/app/src/index.ts', readonly: true },
    ...(contribution.mounts ?? []),
    ...(mitm?.mounts ?? []),
  ];

  const args = buildAuthSpawnArgs({
    containerName,
    ip: allocated.ip,
    mode: opts.mode,
    nonce: opts.nonce,
    rpcPort: hostRpcPort(),
    launchMode: resolveLaunchMode(true),
    mounts,
    extraEnv: { ...contribution.env, ...mitm?.env },
    extraArgs: mitm?.args,
    image: CONTAINER_IMAGE,
  });

  log.info('Spawning auth container', { containerName, folder: opts.folder, mode: opts.mode, proxy: mitm != null });

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      allocated.release();
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      resolve();
    };

    const timer = setTimeout(() => {
      log.warn('Auth container exceeded max lifetime — killing', { containerName });
      try {
        stopContainer(containerName);
      } catch {
        /* close handler still fires */
      }
    }, AUTH_MAX_LIFETIME_MS);

    const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) {
        if (line) log.debug(line, { container: containerName });
      }
    });
    proc.on('close', () => {
      log.info('Auth container exited', { containerName });
      finish();
    });
    proc.on('error', (err) => {
      log.error('Auth container spawn error', { containerName, err });
      finish();
    });
  });
}
