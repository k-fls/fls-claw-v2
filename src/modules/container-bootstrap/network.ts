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
 * it creates the network. Used as the bind/connect address in `gateway` mode
 * (see serviceBindHost / serviceConnectTarget).
 *
 * NOTE: Docker masquerades container→host traffic even to this same-bridge
 * gateway, so the container's real source IP is only preserved here if a NOMASQ
 * exception is installed (needs NET_ADMIN / root) — which is why `gateway` mode
 * is opt-in and `open` (bind 0.0.0.0) is the default. (host-rpc bug #9)
 */
export function gatewayIP(): string {
  return `${NANOCLAW_SUBNET_PREFIX}.0.1`;
}

/**
 * Host networking mode (`CLAW_HOST_NET_MODE`):
 *
 *  - `open` (default): host-side services bind `0.0.0.0`. Works rootless, and
 *    the caller-IP gate sees the container's real source IP — binding all
 *    interfaces is what preserves it (verified in production: the credential
 *    proxy has always run this way and correctly identifies containers). The
 *    trade-off is that the listeners are reachable on every host interface,
 *    including the LAN (the caller-IP gate is still the access control).
 *
 *  - `gateway`: services bind only the bridge gateway (off the LAN). Because
 *    Docker masquerades container→host traffic even on the same bridge, this
 *    needs a NOMASQ rule (NET_ADMIN) to preserve the source IP — deliberately
 *    NOT installed here, so it only works where you add that rule yourself.
 */
function hostNetMode(): 'open' | 'gateway' {
  return process.env.CLAW_HOST_NET_MODE === 'gateway' ? 'gateway' : 'open';
}

/** Docker Desktop (macOS) and WSL route host.docker.internal → loopback in the VM. */
function isLocalVmHost(): boolean {
  return os.platform() === 'darwin' || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}

/**
 * Address host-side services (host-rpc, the credential proxy) BIND to.
 * Deliberately decoupled from the address clients connect to
 * (`serviceConnectTarget`) so the listener can be `0.0.0.0` while clients still
 * reach it by a concrete name.
 */
export function serviceBindHost(): string {
  if (hostNetMode() === 'gateway') return isLocalVmHost() ? '127.0.0.1' : gatewayIP();
  return '0.0.0.0';
}

/**
 * What `host.docker.internal` resolves to (the `--add-host` target) so a
 * container can reach the services. Clients always dial the
 * `host.docker.internal` hostname — this is only what that name points at.
 * `host-gateway` is Docker's built-in alias for the host (docker0); used in
 * open mode and inside the Desktop/WSL VM. In gateway mode on bare-metal Linux
 * it's the nanoclaw bridge gateway instead.
 */
export function serviceConnectTarget(): string {
  if (hostNetMode() === 'gateway' && !isLocalVmHost()) return gatewayIP();
  return 'host-gateway';
}

/** @internal — for tests. */
export function __resetPoolForTests(): void {
  nextHostPart = POOL_MIN;
}

/** @internal — for tests / diagnostics. */
export const __SUBNET = NANOCLAW_SUBNET;
export const __PREFIX = NANOCLAW_SUBNET_PREFIX;
