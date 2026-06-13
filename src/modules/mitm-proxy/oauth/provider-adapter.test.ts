import { describe, expect, it } from 'vitest';

import type { HandlerContext } from './handler-context.js';
import { toSubstitutingProvider } from './provider-adapter.js';
import type { OAuthProvider } from './types.js';

function ctxStub(): HandlerContext {
  return {
    tokenEngine: {} as HandlerContext['tokenEngine'],
    resolverFor: () => ({}) as ReturnType<HandlerContext['resolverFor']>,
    fetchImpl: globalThis.fetch,
    inFlightRefresh: new Map(),
  };
}

describe('toSubstitutingProvider', () => {
  it('builds host rules with the explicit anchor for templated hosts', () => {
    const p: OAuthProvider = {
      id: 'auth0',
      rules: [
        {
          anchor: 'auth0.com',
          hostPattern: /^(?<tenant>[^.]+)\.auth0\.com$/,
          pathPattern: /^\/oauth\/token$/,
          mode: 'token-exchange',
        },
      ],
      scopeKeys: ['tenant'],
      substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
      refreshStrategy: 'redirect',
    };
    const sp = toSubstitutingProvider(p, ctxStub());
    const rules = sp.substitutes.hostRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].anchor).toBe('auth0.com');
    expect(rules[0].hostPattern.exec('acme.auth0.com')?.groups?.tenant).toBe('acme');
    expect(rules[0].pathPattern.test('/oauth/token')).toBe(true);
  });

  it('synthesizes a fixed-host regex when the rule has no hostPattern', () => {
    const p: OAuthProvider = {
      id: 'fixed',
      rules: [
        {
          anchor: 'api.example.com',
          pathPattern: /^\/v1/,
          mode: 'bearer-swap',
        },
      ],
      scopeKeys: [],
      substituteConfig: { prefixLen: 10, suffixLen: 4, delimiters: '-._~' },
      refreshStrategy: 'redirect',
    };
    const sp = toSubstitutingProvider(p, ctxStub());
    const rules = sp.substitutes.hostRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].hostPattern.test('api.example.com')).toBe(true);
    expect(rules[0].hostPattern.test('evil-api.example.com')).toBe(false);
  });

  it('builds handlers for all four modes (none dropped)', () => {
    // authorize-stub / device-code are now implemented (they degrade to a
    // pass-through / no-op notice when no oauthEvents surface is wired, as in
    // this stub ctx), so every rule is retained — nothing is filtered out.
    const p: OAuthProvider = {
      id: 'mixed',
      rules: [
        {
          anchor: 'api.example.com',
          pathPattern: /^\/v1/,
          mode: 'bearer-swap',
        },
        {
          anchor: 'auth.example.com',
          pathPattern: /^\/authorize$/,
          mode: 'authorize-stub',
        },
        {
          anchor: 'auth.example.com',
          pathPattern: /^\/device$/,
          mode: 'device-code',
        },
      ],
      scopeKeys: [],
      substituteConfig: { prefixLen: 10, suffixLen: 4, delimiters: '-._~' },
      refreshStrategy: 'redirect',
    };
    const sp = toSubstitutingProvider(p, ctxStub());
    const rules = sp.substitutes.hostRules();
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.pathPattern.source)).toEqual(['^\\/v1', '^\\/authorize$', '^\\/device$']);
    for (const r of rules) expect(typeof r.handler).toBe('function');
  });

  it('propagates env bindings through to envNamesFor', () => {
    const p: OAuthProvider = {
      id: 'env-test',
      rules: [
        {
          anchor: 'api.example.com',
          pathPattern: /^\/v1/,
          mode: 'bearer-swap',
        },
      ],
      scopeKeys: [],
      substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
      refreshStrategy: 'redirect',
      envBindings: [
        { envName: 'EXAMPLE_TOKEN', credentialPath: 'oauth' },
        { envName: 'EXAMPLE_ALT', credentialPath: 'oauth' },
      ],
    };
    const sp = toSubstitutingProvider(p, ctxStub());
    expect(sp.substitutes.envNamesFor('oauth')).toEqual(['EXAMPLE_TOKEN', 'EXAMPLE_ALT']);
  });
});
