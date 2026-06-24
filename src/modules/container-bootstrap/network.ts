/**
 * Container-IP network — Docker bridge network setup + IP pool.
 *
 * Owns the `nanoclaw` bridge network (created on host startup) and a
 * monotonic-counter IP allocator inside its /16 subnet. Apple Container
 * has its own networking model; not implemented here (see TODO below).
 *
 * Factored out of fork's src/auth/container-args.ts so the registry
 * (registry.ts) doesn't carry shell-out responsibility.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';

const NANOCLAW_NETWORK = 'nanoclaw';

interface ParsedSubnet {
  readonly subnet: string;
  readonly prefix: string;
}

function parseSubnet(value: string): ParsedSubnet {
  if (!/^\d+\.\d+\.0\.0\/16$/.test(value)) {
    throw new Error(`Invalid NANOCLAW_SUBNET "${value}" — must be X.Y.0.0/16`);
  }
  return { subnet: value, prefix: value.split('.').slice(0, 2).join('.') };
}

const { subnet: NANOCLAW_SUBNET, prefix: NANOCLAW_SUBNET_PREFIX } = parseSubnet(
  process.env.NANOCLAW_SUBNET || '172.29.0.0/16',
);

// Skip .0.0 (network) and .0.1 (gateway). Pool ranges 2..65534 inclusive.
const POOL_MIN = 2;
const POOL_MAX = 65534;
let nextHostPart = POOL_MIN;

function ipFromHostPart(hostPart: number): string {
  const hi = (hostPart >> 8) & 0xff;
  const lo = hostPart & 0xff;
  return `${NANOCLAW_SUBNET_PREFIX}.${hi}.${lo}`;
}

/**
 * Walk the monotonic counter until we find a free IP (per the predicate)
 * or wrap back to the start. Throws if the entire pool is exhausted.
 *
 * The predicate exists so the registry, not this module, owns the
 * "is this IP currently allocated?" question.
 */
export function allocateIPFromPool(isFree: (ip: string) => boolean): string {
  const start = nextHostPart;
  do {
    const ip = ipFromHostPart(nextHostPart);
    nextHostPart = nextHostPart >= POOL_MAX ? POOL_MIN : nextHostPart + 1;
    if (isFree(ip)) return ip;
  } while (nextHostPart !== start);
  throw new Error('Container IP pool exhausted');
}

/**
 * Returning an IP to the pool is a no-op with the monotonic-counter
 * scheme — the next allocation pass will skip-or-pick based on the
 * registry's `isFree` predicate. Exists so the registry has a paired
 * release symbol for symmetry and so a future free-list allocator can
 * slot in here without changing the registry.
 */
export function releaseIPToPool(_ip: string): void {
  // intentionally empty
}

/**
 * Ensure the dedicated nanoclaw bridge network exists. Idempotent.
 *
 * Called once at host startup from src/index.ts. Containers placed on
 * this network get static IPs from our pool (via `networkArgs`).
 *
 * TODO: Apple Container support. Apple's container runtime has a
 * different networking model and no `docker network create` analog;
 * defer until there's a way to test against it.
 */
export function ensureContainerNetwork(): void {
  if (CONTAINER_RUNTIME_BIN !== 'docker') {
    // Apple Container (or anything non-Docker) — not implemented yet.
    log.warn('container-ip: non-Docker runtime, bridge network setup skipped', {
      runtime: CONTAINER_RUNTIME_BIN,
      platform: os.platform(),
    });
    return;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${NANOCLAW_NETWORK}`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    log.debug('container-ip: nanoclaw network already exists');
    return;
  } catch {
    // not present — create below
  }

  try {
    execSync(
      `${CONTAINER_RUNTIME_BIN} network create ` +
        `--subnet ${NANOCLAW_SUBNET} ` +
        `-o com.docker.network.bridge.enable_icc=false ` +
        NANOCLAW_NETWORK,
      { stdio: 'pipe', timeout: 10000 },
    );
    log.info('container-ip: created nanoclaw network', { subnet: NANOCLAW_SUBNET });
  } catch {
    // Concurrent creation race — verify the network exists now.
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${NANOCLAW_NETWORK}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      throw new Error('Failed to create nanoclaw container network');
    }
  }
}

/** CLI args to place a container on the nanoclaw network with a static IP. */
export function networkArgs(ip: string): readonly string[] {
  return ['--network', NANOCLAW_NETWORK, '--ip', ip];
}

/**
 * The host's IP on the nanoclaw bridge — the `.0.1` gateway Docker assigns when
 * it creates the network. Host-side services that containers call (host-rpc,
 * the MITM proxy) bind here, and containers reach them here, rather than via
 * docker0 / the `host-gateway` alias. Agent containers live on the nanoclaw
 * bridge, so a hop to its own gateway is delivered at L2 and never crosses to
 * another bridge — Docker's per-network MASQUERADE rule (`-s <subnet> ! -o
 * nanoclaw`) never fires, so the container's real source IP survives. host-rpc's
 * caller-IP gate depends on seeing that real IP. (host-rpc bug #9)
 */
export function gatewayIP(): string {
  return `${NANOCLAW_SUBNET_PREFIX}.0.1`;
}

/**
 * The address host-side services (host-rpc, the credential proxy) should BIND
 * to: reachable from agent containers, but not from the wider host or LAN.
 *
 * Containers always reach these services at `host.docker.internal`, which
 * `hostGatewayArgs` points at:
 *   - loopback inside the Docker Desktop / WSL VM → bind `127.0.0.1`
 *   - the nanoclaw bridge gateway on bare-metal Linux → bind that gateway
 *
 * Binding this specific address (never `0.0.0.0`) keeps the listener off every
 * other host interface, so only containers on the nanoclaw bridge can connect.
 * That is the network-layer half of the defense the caller-IP gate completes —
 * a credential-bearing service should not be reachable from the LAN at all,
 * not merely rejected once a stranger connects. Single source of truth shared
 * by host-rpc's bind and the proxy's bind so the two cannot drift. (#9)
 */
export function gatewayBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';
  // WSL: Docker Desktop routes host-gateway → loopback in the VM.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';
  // Bare-metal Linux: the nanoclaw bridge gateway.
  return gatewayIP();
}

/** @internal — for tests. */
export function __resetPoolForTests(): void {
  nextHostPart = POOL_MIN;
}

/** @internal — for tests / diagnostics. */
export const __SUBNET = NANOCLAW_SUBNET;
export const __PREFIX = NANOCLAW_SUBNET_PREFIX;
