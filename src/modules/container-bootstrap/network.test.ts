/**
 * Tests for the container-ip network primitives — subnet parsing, IP
 * pool walk, networkArgs shape. ensureContainerNetwork() shells out to
 * docker and is exercised in integration, not here.
 */
import os from 'os';
import fs from 'fs';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  allocateIPFromPool,
  networkArgs,
  gatewayIP,
  serviceBindHost,
  serviceConnectTarget,
  __resetPoolForTests,
  __PREFIX,
} from './network.js';

beforeEach(() => {
  __resetPoolForTests();
});

describe('container-ip network', () => {
  it('default subnet prefix is 172.29', () => {
    // Sanity check the default. The env var override path is exercised
    // implicitly by the module-load time parse.
    expect(__PREFIX).toBe('172.29');
  });

  it('allocateIPFromPool returns the first free IP starting at .0.2', () => {
    const ip = allocateIPFromPool(() => true);
    expect(ip).toBe(`${__PREFIX}.0.2`);
  });

  it('allocateIPFromPool walks past taken IPs', () => {
    const taken = new Set([`${__PREFIX}.0.2`, `${__PREFIX}.0.3`]);
    const ip = allocateIPFromPool((candidate) => !taken.has(candidate));
    expect(ip).toBe(`${__PREFIX}.0.4`);
  });

  it('allocateIPFromPool throws when every IP is taken', () => {
    expect(() => allocateIPFromPool(() => false)).toThrow(/pool exhausted/i);
  });

  it('networkArgs returns the expected Docker CLI shape', () => {
    expect(networkArgs('172.29.0.5')).toEqual(['--network', 'nanoclaw', '--ip', '172.29.0.5']);
  });

  it('gatewayIP is the .0.1 host address on the bridge', () => {
    expect(gatewayIP()).toBe(`${__PREFIX}.0.1`);
  });
});

describe('serviceBindHost / serviceConnectTarget (CLAW_HOST_NET_MODE)', () => {
  const prevMode = process.env.CLAW_HOST_NET_MODE;
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevMode === undefined) delete process.env.CLAW_HOST_NET_MODE;
    else process.env.CLAW_HOST_NET_MODE = prevMode;
  });

  describe('open mode (default)', () => {
    beforeEach(() => {
      delete process.env.CLAW_HOST_NET_MODE;
    });

    it('binds 0.0.0.0 regardless of platform (rootless, real source IP preserved)', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(serviceBindHost()).toBe('0.0.0.0');
    });

    it('connect target is host-gateway (docker0)', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(serviceConnectTarget()).toBe('host-gateway');
    });
  });

  describe('gateway mode (opt-in)', () => {
    beforeEach(() => {
      process.env.CLAW_HOST_NET_MODE = 'gateway';
    });

    it('binds the bridge gateway on bare-metal Linux — off the LAN', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      vi.spyOn(fs, 'existsSync').mockReturnValue(false); // not WSL
      expect(serviceBindHost()).toBe(gatewayIP());
      expect(serviceConnectTarget()).toBe(gatewayIP());
    });

    it('binds loopback inside the Docker Desktop / WSL VM', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      vi.spyOn(fs, 'existsSync').mockReturnValue(true); // WSLInterop present
      expect(serviceBindHost()).toBe('127.0.0.1');
      expect(serviceConnectTarget()).toBe('host-gateway');
    });
  });
});
