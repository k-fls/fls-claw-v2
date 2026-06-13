/**
 * Tests for the container-ip network primitives — subnet parsing, IP
 * pool walk, networkArgs shape. ensureContainerNetwork() shells out to
 * docker and is exercised in integration, not here.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { allocateIPFromPool, networkArgs, __resetPoolForTests, __PREFIX } from './network.js';

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
});
