import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { CredentialProxy, type HostHandler } from './credential-proxy.js';
import type { SubstitutingProvider } from './types.js';

const ipA = '10.0.0.1';
const ipB = '10.0.0.2';

interface RuleSpec {
  anchor: string;
  hostPattern: RegExp;
  pathPattern: RegExp;
  handler: HostHandler;
}

/** Minimal SubstitutingProvider that only carries host rules. */
function provider(id: string, rules: RuleSpec[]): SubstitutingProvider {
  return {
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: {
      generateSubstitute: () => null,
      envNamesFor: () => [],
      envValueFor: () => null,
      hostRules: () => rules,
    },
  } as unknown as SubstitutingProvider;
}

function rule(anchor: string, handler: HostHandler): RuleSpec {
  return {
    anchor,
    hostPattern: new RegExp(`^${anchor.replace(/\./g, '\\.')}$`),
    pathPattern: /^\//,
    handler,
  };
}

describe('CredentialProxy — global + per-container rule tiers', () => {
  let proxy: CredentialProxy;

  beforeEach(() => {
    proxy = new CredentialProxy();
  });

  describe('container tier is scoped to its IP and dropped on unregister', () => {
    const hCont: HostHandler = async () => {};

    beforeEach(() => {
      proxy.registerContainerRules(ipA, [provider('cont', [rule('auth.test', hCont)])]);
    });

    it('intercepts only for the registering IP', () => {
      expect(proxy.shouldIntercept('auth.test', ipA)).toBe(true);
      // Another container's IP can't see it.
      expect(proxy.shouldIntercept('auth.test', ipB)).toBe(false);
      // No IP (global-only path) can't see it either.
      expect(proxy.shouldIntercept('auth.test')).toBe(false);
    });

    it('resolves the rule only for the registering IP', () => {
      expect(proxy.findMatchingRule('auth.test', '/', ipA)?.handler).toBe(hCont);
      expect(proxy.findMatchingRule('auth.test', '/', ipB)).toBeNull();
    });

    it('normalizes IPv4-mapped IPv6 source addresses', () => {
      expect(proxy.shouldIntercept('auth.test', `::ffff:${ipA}`)).toBe(true);
    });

    it('unregisterContainerIP drops the container tier', () => {
      proxy.unregisterContainerIP(ipA);
      expect(proxy.shouldIntercept('auth.test', ipA)).toBe(false);
      expect(proxy.findMatchingRule('auth.test', '/', ipA)).toBeNull();
    });

    it('empty providers clears the IP tier', () => {
      proxy.registerContainerRules(ipA, []);
      expect(proxy.shouldIntercept('auth.test', ipA)).toBe(false);
    });
  });

  describe('global always wins (match sequence: global → container)', () => {
    const hGlobal: HostHandler = async () => {};
    const hLocal: HostHandler = async () => {};

    it('a container may serve a subdomain a global exact rule cannot match', () => {
      // Global owns the exact host `acme.test`. A container adds the
      // distinct host `sub.acme.test` under its OWN provider name.
      proxy._addHostRuleForTests(/^acme\.test$/, /^\//, hGlobal, 'global');
      proxy.registerContainerRules(ipA, [provider('mine', [rule('sub.acme.test', hLocal)])]);

      // Same host both could match → global wins (tried first).
      expect(proxy.findMatchingRule('acme.test', '/', ipA)?.handler).toBe(hGlobal);
      // The subdomain: global's exact pattern doesn't match it, so the
      // container rule serves it. The anchor funnel must NOT let the global
      // `acme.test` rule swallow `sub.acme.test`.
      expect(proxy.findMatchingRule('sub.acme.test', '/', ipA)?.handler).toBe(hLocal);
    });

    it('falls through to the container tier when global misses', () => {
      const hCont: HostHandler = async () => {};
      proxy.registerContainerRules(ipA, [provider('cont', [rule('only.test', hCont)])]);
      expect(proxy.findMatchingRule('only.test', '/', ipA)?.handler).toBe(hCont);
    });

    it('a global rule and a container rule on separate anchors each resolve to their own tier', () => {
      proxy._addHostRuleForTests(/^api\.global\.test$/, /^\//, hGlobal, 'global');
      proxy.registerContainerRules(ipA, [provider('mine', [rule('api.local.test', hLocal)])]);

      // Each host resolves to the correct tier in the same lookup pass.
      expect(proxy.findMatchingRule('api.global.test', '/', ipA)?.handler).toBe(hGlobal);
      expect(proxy.findMatchingRule('api.local.test', '/', ipA)?.handler).toBe(hLocal);

      // Global is visible regardless of IP (or with none); the container
      // anchor is visible only to its own IP.
      expect(proxy.shouldIntercept('api.global.test')).toBe(true);
      expect(proxy.shouldIntercept('api.global.test', ipB)).toBe(true);
      expect(proxy.shouldIntercept('api.local.test', ipA)).toBe(true);
      expect(proxy.shouldIntercept('api.local.test', ipB)).toBe(false);
      expect(proxy.findMatchingRule('api.local.test', '/', ipB)).toBeNull();
    });
  });

  describe('anchor-ownership invariant (name-based)', () => {
    const noop: HostHandler = async () => {};

    it('rejects a foreign provider name on a global-owned anchor', () => {
      proxy._addHostRuleForTests(/^api\.globex\.test$/, /^\//, noop, 'globex');
      expect(() => proxy.registerContainerRules(ipA, [provider('mine', [rule('api.globex.test', noop)])])).toThrow(
        /owned by global provider 'globex'/,
      );
    });

    it('rejects a global provider name adding a NEW anchor from a container', () => {
      proxy.indexProvider(provider('globex', [rule('api.globex.test', noop)]));
      expect(() => proxy.registerContainerRules(ipA, [provider('globex', [rule('api.fresh.test', noop)])])).toThrow(
        /'globex' is a global provider/,
      );
    });

    it('ALLOWS the same provider name on its own global anchor (not a hijack)', () => {
      proxy.indexProvider(provider('globex', [rule('api.globex.test', noop)]));
      // Same name, same anchor it already owns → permitted (dead rule —
      // global wins by sequence — but not a violation).
      expect(() =>
        proxy.registerContainerRules(ipA, [provider('globex', [rule('api.globex.test', noop)])]),
      ).not.toThrow();
    });

    it('rejects a container anchor that is not at least two labels', () => {
      expect(() => proxy.registerContainerRules(ipA, [provider('mine', [rule('com', noop)])])).toThrow(
        /at least two labels/,
      );
    });

    it('global tier keeps intentional co-ownership (two ids, one anchor)', () => {
      // Mirrors the shipped baseline (e.g. login.microsoftonline.com).
      proxy._addHostRuleForTests(/^login\.shared\.test$/, /^\//, noop, 'variant-a');
      expect(() => proxy._addHostRuleForTests(/^login\.shared\.test$/, /^\/b/, noop, 'variant-b')).not.toThrow();
      expect(proxy.globalAnchorOwners('login.shared.test')).toEqual(['variant-a', 'variant-b']);
    });
  });
});
