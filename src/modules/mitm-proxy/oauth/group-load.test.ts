import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { loadGroupProvidersForContainer } from './index.js';
import { groupDiscoveryDir, OAUTH_LOAD_REPORT_FILENAME } from './discovery-paths.js';
import { CredentialProxy } from '../credential-proxy.js';
import type { HostHandler } from '../credential-proxy.js';
import { asGroupScope } from '../types.js';
import type { SubstitutingProvider } from '../types.js';
import { _resetTokenEngineForTests, initTokenEngine } from '../token-substitute.js';

/** A global provider occupying id `globex` + anchor `api.globex.test`. */
function globalProvider(): SubstitutingProvider {
  const handler: HostHandler = async () => {};
  return {
    id: 'globex',
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: {
      generateSubstitute: () => null,
      envNamesFor: () => [],
      envValueFor: () => null,
      hostRules: () => [
        {
          anchor: 'api.globex.test',
          hostPattern: /^api\.globex\.test$/,
          pathPattern: /^\//,
          handler,
        },
      ],
    },
  } as unknown as SubstitutingProvider;
}

function apiKeyProvider(host: string, envName: string): Record<string, unknown> {
  return {
    api_base_url: `https://${host}`,
    _auth_method: 'api_key',
    _auth_header_format: 'Authorization: Bearer {api_key}',
    _env_vars: { [envName]: 'api_key' },
  };
}

function writeFixtures(scope: string, files: Record<string, unknown>): void {
  const dir = groupDiscoveryDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(body));
  }
}

function cleanupScope(scope: string): void {
  // groups/<scope>/ — remove the whole test scope dir.
  const groupDir = groupDiscoveryDir(scope).replace(/\/\.auth-discovery$/, '');
  fs.rmSync(groupDir, { recursive: true, force: true });
}

describe('rebuildGroupOAuthIndex — safety + env-collision filters', () => {
  let proxy: CredentialProxy;
  const scopes: string[] = [];

  beforeEach(() => {
    _resetTokenEngineForTests();
    initTokenEngine(() => ({}) as never);
    proxy = new CredentialProxy();
    proxy.indexProvider(globalProvider());
  });

  afterEach(() => {
    for (const s of scopes.splice(0)) cleanupScope(s);
    _resetTokenEngineForTests();
  });

  function freshScope(tag: string): string {
    const s = `__pgop_${tag}_test`;
    scopes.push(s);
    cleanupScope(s); // in case a prior run left it behind
    return s;
  }

  const ip = '10.0.0.7';

  it('accepts a clean new provider and installs it into the container tier', () => {
    const scope = freshScope('accept');
    writeFixtures(scope, { acme: apiKeyProvider('api.acme.test', 'ACME_TOKEN') });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    expect(res.registered).toEqual(['acme']);
    expect(res.rejected).toEqual([]);
    expect(proxy.shouldIntercept('api.acme.test', ip)).toBe(true);
    // Invisible to a different container IP.
    expect(proxy.shouldIntercept('api.acme.test', '10.0.0.8')).toBe(false);
  });

  it('rejects a provider that reuses a global provider id (new anchor under it)', () => {
    const scope = freshScope('idclash');
    writeFixtures(scope, { globex: apiKeyProvider('api.elsewhere.test', 'GLOBEX_TOKEN') });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    expect(res.registered).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].id).toBe('globex');
    expect(res.rejected[0].reason).toMatch(/'globex' is a global provider/);
  });

  it('rejects a provider that introduces a rule on a global-owned anchor', () => {
    const scope = freshScope('anchorclash');
    // api_base_url points at the global provider's anchor — widening the
    // domain set a global credential would be sent to.
    writeFixtures(scope, { widen: apiKeyProvider('api.globex.test', 'WIDEN_TOKEN') });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    expect(res.registered).toEqual([]);
    expect(res.rejected[0].id).toBe('widen');
    expect(res.rejected[0].reason).toMatch(/owned by global provider 'globex'/);
    // The global anchor still intercepts (its global rule is untouched).
    expect(proxy.shouldIntercept('api.globex.test', ip)).toBe(true);
  });

  it('rejects a provider whose env var collides with the global reserved set', () => {
    const scope = freshScope('envglobal');
    // PATH is in the always-reserved dangerous set.
    writeFixtures(scope, { danger: apiKeyProvider('api.danger.test', 'PATH') });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    expect(res.registered).toEqual([]);
    expect(res.rejected[0].id).toBe('danger');
    expect(res.rejected[0].reason).toMatch(/reserved\/global/);
  });

  it('rejects the second provider that duplicates an env var for the container', () => {
    const scope = freshScope('envlocal');
    writeFixtures(scope, {
      dupa: apiKeyProvider('api.dupa.test', 'DUP_TOKEN'),
      dupb: apiKeyProvider('api.dupb.test', 'DUP_TOKEN'),
    });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    // Exactly one wins; the other is rejected for the dup.
    expect(res.registered).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/duplicated for this container/);
  });

  it('lowercases the host at the oauth-file boundary (uppercase JSON → lowercase anchor)', () => {
    const scope = freshScope('case');
    writeFixtures(scope, {
      shouty: apiKeyProvider('API.UPPER.TEST', 'UPPER_TOKEN'),
    });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    expect(res.registered).toEqual(['shouty']);
    // The anchor was lowercased on load, so a (lowercase) request host matches.
    expect(proxy.shouldIntercept('api.upper.test', ip)).toBe(true);
  });

  it('a missing per-group dir is a quiet no-op', () => {
    const scope = freshScope('missing');
    // No fixtures written → dir absent.
    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);
    expect(res.registered).toEqual([]);
    expect(res.rejected).toEqual([]);
  });

  it('writes a load report back to the dir, and the loader ignores it next time', () => {
    const scope = freshScope('report');
    writeFixtures(scope, {
      acme: apiKeyProvider('api.acme.test', 'ACME_TOKEN'),
      // PATH is reserved → rejected, so the report carries both outcomes.
      danger: apiKeyProvider('api.danger.test', 'PATH'),
    });

    const res = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);

    const reportPath = `${groupDiscoveryDir(scope)}/${OAUTH_LOAD_REPORT_FILENAME}`;
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    expect(report.scope).toBe(scope);
    expect(report.ip).toBe(ip);
    expect(report.registered).toEqual(res.registered);
    expect(report.rejected).toEqual(res.rejected);
    expect(report.rejected[0].id).toBe('danger');

    expect(res.rejected).toHaveLength(1);

    // Drop the rejected def, then reload. The report is deleted before the
    // reload and regenerated, so it reflects the NEW state (no stale rejection)
    // — and the prior report file is never parsed as a provider def.
    fs.rmSync(`${groupDiscoveryDir(scope)}/danger.json`);
    const res2 = loadGroupProvidersForContainer(asGroupScope(scope), ip, proxy);
    expect(res2.registered).toEqual(['acme']);
    expect(res2.rejected).toEqual([]);

    const report2 = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    expect(report2.registered).toEqual(['acme']);
    expect(report2.rejected).toEqual([]);
  });
});
