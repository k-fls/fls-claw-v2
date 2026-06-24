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
  gatewayBindHost,
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
    // Host-rpc and the MITM proxy bind here; containers reach them here so the
    // hop stays same-subnet and the real source IP survives. (bug #9)
    expect(gatewayIP()).toBe(`${__PREFIX}.0.1`);
  });
});

describe('gatewayBindHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds loopback on macOS (host.docker.internal → VM loopback)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    expect(gatewayBindHost()).toBe('127.0.0.1');
  });

  it('binds loopback on WSL (Docker Desktop VM)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true); // WSLInterop present
    expect(gatewayBindHost()).toBe('127.0.0.1');
  });

  it('binds the bridge gateway on bare-metal Linux — never 0.0.0.0 (bug #9)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // not WSL
    expect(gatewayBindHost()).toBe(gatewayIP());
    expect(gatewayBindHost()).not.toBe('0.0.0.0');
  });
});
