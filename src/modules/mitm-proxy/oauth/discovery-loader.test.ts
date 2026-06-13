import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { loadDiscoveryProviders, mergeDiscoveryData, parseDiscoveryFile } from './discovery-loader.js';
import type { DiscoveryFile } from './types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auth-discovery-test-'));
}

function writeJson(dir: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2));
}

describe('mergeDiscoveryData', () => {
  it('returns the baseline when override is null', () => {
    const baseline: DiscoveryFile = {
      token_endpoint: 'https://baseline/token',
      _env_vars: { TOKEN: 'oauth' },
    };
    expect(mergeDiscoveryData(baseline, null)).toBe(baseline);
  });

  it('overrides standard fields but never `_*` fields', () => {
    const baseline: DiscoveryFile = {
      token_endpoint: 'https://baseline/token',
      authorization_endpoint: 'https://baseline/auth',
      _env_vars: { OLD: 'oauth' },
      _refresh_strategy: 'redirect',
    };
    const override = {
      token_endpoint: 'https://refreshed/token',
      _env_vars: { NEW: 'oauth' }, // must be ignored
      _refresh_strategy: 'buffer', // must be ignored
    };
    const merged = mergeDiscoveryData(baseline, override);
    expect(merged.token_endpoint).toBe('https://refreshed/token');
    expect(merged.authorization_endpoint).toBe('https://baseline/auth');
    expect(merged._env_vars).toEqual({ OLD: 'oauth' });
    expect(merged._refresh_strategy).toBe('redirect');
  });
});

describe('parseDiscoveryFile', () => {
  it('builds bearer-swap + token-exchange rules from a minimal OIDC file', () => {
    const data: DiscoveryFile = {
      token_endpoint: 'https://api.example.com/oauth/token',
      authorization_endpoint: 'https://api.example.com/oauth/authorize',
      api_base_url: 'https://api.example.com/v1',
      _refresh_strategy: 'redirect',
      _env_vars: { EXAMPLE_TOKEN: 'oauth' },
    };
    const provider = parseDiscoveryFile('example', data)!;
    expect(provider.id).toBe('example');
    expect(provider.refreshStrategy).toBe('redirect');
    expect(provider.envBindings).toEqual([{ envName: 'EXAMPLE_TOKEN', credentialPath: 'oauth' }]);
    const modes = provider.rules.map((r) => r.mode).sort();
    expect(modes).toContain('token-exchange');
    expect(modes).toContain('bearer-swap');
  });

  it('extracts named-group scope keys from templated hosts', () => {
    const data: DiscoveryFile = {
      token_endpoint: 'https://{tenant}.auth0.com/oauth/token',
      authorization_endpoint: 'https://{tenant}.auth0.com/authorize',
    };
    const provider = parseDiscoveryFile('auth0', data)!;
    expect(provider.scopeKeys).toEqual(['tenant']);
    const tokenRule = provider.rules.find((r) => r.mode === 'token-exchange')!;
    expect(tokenRule.anchor).toBe('auth0.com');
    expect(tokenRule.hostPattern).toBeDefined();
    expect(tokenRule.hostPattern!.exec('acme.auth0.com')?.groups?.tenant).toBe('acme');
  });

  it('returns null when no rules can be produced', () => {
    expect(parseDiscoveryFile('empty', {})).toBeNull();
  });
});

describe('loadDiscoveryProviders', () => {
  it('reads baseline and merges overrides', () => {
    const baseline = tmpDir();
    const override = tmpDir();
    writeJson(baseline, 'svc.json', {
      token_endpoint: 'https://baseline/token',
      api_base_url: 'https://api.baseline/v1',
      _refresh_strategy: 'redirect',
    });
    writeJson(override, 'svc.json', {
      // Override changes the api host post-baseline.
      api_base_url: 'https://api.refreshed/v1',
      _refresh_strategy: 'buffer', // must be ignored — baseline wins
    });

    const { providers, rawData } = loadDiscoveryProviders(baseline, override);
    expect(providers.has('svc')).toBe(true);

    const raw = rawData.get('svc')!;
    expect(raw.api_base_url).toBe('https://api.refreshed/v1');
    expect(raw._refresh_strategy).toBe('redirect');
    expect(providers.get('svc')!.refreshStrategy).toBe('redirect');
  });

  it('skips override files that have no matching baseline', () => {
    const baseline = tmpDir();
    const override = tmpDir();
    writeJson(baseline, 'svc.json', {
      token_endpoint: 'https://baseline/token',
      api_base_url: 'https://api.baseline/v1',
    });
    writeJson(override, 'unrelated.json', {
      token_endpoint: 'https://other/token',
    });

    const { providers } = loadDiscoveryProviders(baseline, override);
    expect([...providers.keys()]).toEqual(['svc']);
  });

  it('is a no-op when the override dir does not exist', () => {
    const baseline = tmpDir();
    writeJson(baseline, 'svc.json', {
      api_base_url: 'https://api.baseline/v1',
    });
    const { providers } = loadDiscoveryProviders(
      baseline,
      path.join(os.tmpdir(), 'nonexistent-oauth-override-dir-' + Date.now()),
    );
    expect(providers.has('svc')).toBe(true);
  });
});
