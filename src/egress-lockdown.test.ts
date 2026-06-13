import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EgressLockdownError,
  assertEgressLaunchable,
  egressLockdownEnabled,
  egressSpawnArgs,
  egressSpawnEnv,
} from './egress-lockdown.js';
import type { LaunchMode } from './modules/container-bootstrap/index.js';
import { hostRpcPort } from './modules/host-rpc/port.js';

const ROOT_DROP: LaunchMode = { kind: 'root-drop', envVars: { HOST_UID: '501', HOST_GID: '20' } };
const ROOTLESS: LaunchMode = { kind: 'rootless', userArg: '501:20' };

describe('egress-lockdown', () => {
  let savedLockdown: string | undefined;
  let savedRpcPort: string | undefined;

  beforeEach(() => {
    savedLockdown = process.env.NANOCLAW_EGRESS_LOCKDOWN;
    savedRpcPort = process.env.NANOCLAW_HOST_RPC_PORT;
    delete process.env.NANOCLAW_EGRESS_LOCKDOWN;
    delete process.env.NANOCLAW_HOST_RPC_PORT;
  });

  afterEach(() => {
    if (savedLockdown === undefined) delete process.env.NANOCLAW_EGRESS_LOCKDOWN;
    else process.env.NANOCLAW_EGRESS_LOCKDOWN = savedLockdown;
    if (savedRpcPort === undefined) delete process.env.NANOCLAW_HOST_RPC_PORT;
    else process.env.NANOCLAW_HOST_RPC_PORT = savedRpcPort;
  });

  describe('egressLockdownEnabled', () => {
    it('is off by default', () => {
      expect(egressLockdownEnabled()).toBe(false);
    });
    it('is on only for the exact string "true"', () => {
      process.env.NANOCLAW_EGRESS_LOCKDOWN = 'true';
      expect(egressLockdownEnabled()).toBe(true);
      process.env.NANOCLAW_EGRESS_LOCKDOWN = '1';
      expect(egressLockdownEnabled()).toBe(false);
      process.env.NANOCLAW_EGRESS_LOCKDOWN = 'TRUE';
      expect(egressLockdownEnabled()).toBe(false);
    });
  });

  describe('hostRpcPort', () => {
    it('defaults to 17381 and matches the host-rpc default', () => {
      expect(hostRpcPort()).toBe(17381);
    });
    it('honors NANOCLAW_HOST_RPC_PORT', () => {
      process.env.NANOCLAW_HOST_RPC_PORT = '20000';
      expect(hostRpcPort()).toBe(20000);
    });
  });

  describe('egressSpawnArgs', () => {
    it('grants NET_ADMIN, drops NET_RAW, and disables IPv6', () => {
      const args = egressSpawnArgs();
      expect(args).toContain('--cap-add=NET_ADMIN');
      expect(args).toContain('--cap-drop=NET_RAW');
      // sysctl flag + value pairs are adjacent
      const i = args.indexOf('--sysctl');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args).toContain('net.ipv6.conf.all.disable_ipv6=1');
      expect(args).toContain('net.ipv6.conf.default.disable_ipv6=1');
    });
  });

  describe('egressSpawnEnv', () => {
    it('flags lockdown and passes the allowlisted host-rpc port', () => {
      process.env.NANOCLAW_HOST_RPC_PORT = '12345';
      expect(egressSpawnEnv()).toEqual({
        NANOCLAW_EGRESS_LOCKDOWN: '1',
        NANOCLAW_HOST_RPC_PORT: '12345',
      });
    });
  });

  describe('assertEgressLaunchable', () => {
    it('is a no-op when lockdown is disabled (any launch mode)', () => {
      expect(() => assertEgressLaunchable(ROOTLESS)).not.toThrow();
      expect(() => assertEgressLaunchable(ROOT_DROP)).not.toThrow();
    });
    it('allows root-drop when lockdown is enabled', () => {
      process.env.NANOCLAW_EGRESS_LOCKDOWN = 'true';
      expect(() => assertEgressLaunchable(ROOT_DROP)).not.toThrow();
    });
    it('refuses non-root-drop when lockdown is enabled (fail-closed)', () => {
      process.env.NANOCLAW_EGRESS_LOCKDOWN = 'true';
      expect(() => assertEgressLaunchable(ROOTLESS)).toThrow(EgressLockdownError);
    });
  });
});
