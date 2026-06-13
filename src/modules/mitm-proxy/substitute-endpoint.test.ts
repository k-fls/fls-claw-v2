/**
 * substitute-endpoint — tests against the unified credentials registry.
 * Substituting providers are registered via `registerCredentialProvider`;
 * the token engine is constructed with a stub resolver factory.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { registerCredentialProvider, _resetProviderRegistryForTests } from '../credentials/providers/registry.js';

import { handleSubstituteRequest } from './substitute-endpoint.js';
// Side-effect: reserves HTTP_PROXY / HTTPS_PROXY / NODE_EXTRA_CA_CERTS /
// SSL_CERT_FILE / MITM_CA_PATH with container-bootstrap so the reserved
// env-var-name check in the substitute endpoint actually has them.
import './observer.js';
import { TokenSubstituteEngine, setTokenEngine, _resetTokenEngineForTests } from './token-substitute.js';
import { asGroupScope } from './types.js';
import { DEFAULT_SUBSTITUTE_CONFIG } from './types.js';
import type { SubstitutingProvider } from './types.js';
import { defaultSubstitutes, type DefaultSubstitutesInput } from './defaults.js';

function mockRequest(url: string): http.IncomingMessage {
  return { url, method: 'GET' } as http.IncomingMessage;
}

function mockResponse(): http.ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) {
      res._status = status;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  } as unknown as http.ServerResponse & { _status: number; _body: string };
  return res;
}

const SCOPE = asGroupScope('test-group');

function mockEngine(
  opts: {
    substitute?: string | null;
    onMerge?: ReturnType<typeof vi.fn>;
  } = {},
): TokenSubstituteEngine {
  const engine = {
    getOrCreateSubstitute: vi.fn().mockReturnValue(opts.substitute ?? null),
    mergeEnvNames: opts.onMerge ?? vi.fn(),
  } as unknown as TokenSubstituteEngine;
  setTokenEngine(engine);
  return engine;
}

/** Build and register a SubstitutingProvider using the default factory. */
function registerSubstituting(id: string, input: DefaultSubstitutesInput): void {
  const p: SubstitutingProvider = {
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: defaultSubstitutes(input),
  };
  registerCredentialProvider(p);
}

beforeEach(() => {
  _resetTokenEngineForTests();
  _resetProviderRegistryForTests();
});

afterEach(() => {
  _resetTokenEngineForTests();
  _resetProviderRegistryForTests();
});

describe('substitute-endpoint', () => {
  it('returns 400 for malformed path', () => {
    mockEngine();
    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/github'), res, SCOPE);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/Expected/);
  });

  it('returns 400 when path query param is missing', () => {
    mockEngine();
    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/github/substitute'), res, SCOPE);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/Missing required parameter: path/);
  });

  it('returns 404 for unknown provider', () => {
    mockEngine();
    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/nonexistent/substitute?path=oauth'), res, SCOPE);
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/Unknown provider/);
  });

  it('returns 404 when no credentials exist for scope', () => {
    registerSubstituting('github', {
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      envBindings: [{ envName: 'GH_TOKEN', credentialPath: 'oauth' }],
    });
    mockEngine({ substitute: null });
    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth'), res, SCOPE);
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/No credentials found/);
  });

  it('returns substitute with envNames for a registered provider', () => {
    registerSubstituting('github', {
      substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '_' },
      envBindings: [
        { envName: 'GH_TOKEN', credentialPath: 'oauth' },
        { envName: 'GITHUB_TOKEN', credentialPath: 'oauth' },
      ],
    });
    mockEngine({ substitute: 'ghp_FaKeSuBsTiTuTe1234567890abcdef' });

    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth'), res, SCOPE);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.substitute).toBe('ghp_FaKeSuBsTiTuTe1234567890abcdef');
    expect(body.providerId).toBe('github');
    expect(body.credentialPath).toBe('oauth');
    expect(body.envNames).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
  });

  it('passes envNames to getOrCreateSubstitute', () => {
    registerSubstituting('todoist', {
      substituteConfig: { prefixLen: 10, suffixLen: 4, delimiters: '-._~' },
      envBindings: [{ envName: 'TODOIST_API_TOKEN', credentialPath: 'api_key' }],
    });
    const engine = mockEngine({ substitute: 'sub_token' });

    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/todoist/substitute?path=api_key'), res, SCOPE);
    // Engine no longer takes SubstituteConfig — substitute shape lives
    // on the SubstitutingProvider, not in the engine call signature.
    expect(engine.getOrCreateSubstitute).toHaveBeenCalledWith('todoist', {}, SCOPE, 'api_key', ['TODOIST_API_TOKEN']);
    expect(JSON.parse(res._body).envNames).toEqual(['TODOIST_API_TOKEN']);
  });

  it('returns empty envNames for a provider with no envBindings', () => {
    registerSubstituting('claude', {});
    mockEngine({ substitute: 'sub_claude' });

    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/claude/substitute?path=oauth'), res, SCOPE);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.substitute).toBe('sub_claude');
    expect(body.envNames).toEqual([]);
  });

  it('only maps envNames matching the requested credentialPath', () => {
    registerSubstituting('stripe', {
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
      envBindings: [
        { envName: 'STRIPE_SECRET_KEY', credentialPath: 'api_key' },
        { envName: 'STRIPE_TOKEN', credentialPath: 'oauth' },
      ],
    });
    mockEngine({ substitute: 'tok_substitute' });

    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/stripe/substitute?path=api_key'), res, SCOPE);
    expect(JSON.parse(res._body).envNames).toEqual(['STRIPE_SECRET_KEY']);
  });

  it('decodes URL-encoded provider IDs', () => {
    registerSubstituting('my-provider', {
      substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
    });
    mockEngine({ substitute: 'sub' });

    const res = mockResponse();
    handleSubstituteRequest(mockRequest('/credentials/my-provider/substitute?path=oauth'), res, SCOPE);
    expect(res._status).toBe(200);
  });

  describe('envVar parameter', () => {
    function setupGithub(onMerge?: ReturnType<typeof vi.fn>) {
      registerSubstituting('github', {
        substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
        envBindings: [
          { envName: 'GH_TOKEN', credentialPath: 'oauth' },
          { envName: 'GITHUB_TOKEN', credentialPath: 'oauth' },
        ],
      });
      return mockEngine({ substitute: 'ghp_FaKeSuBsTiTuTe1234567890abcdef', onMerge });
    }

    it('rejects invalid envVar format (lowercase)', () => {
      setupGithub();
      const res = mockResponse();
      handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth&envVar=my_token'), res, SCOPE);
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Invalid env var name format/);
    });

    it('rejects reserved env var names (host-injected)', () => {
      setupGithub();
      // HTTP_PROXY is reserved by the mitm-proxy observer at module load.
      const res = mockResponse();
      handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth&envVar=HTTP_PROXY'), res, SCOPE);
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Reserved env var name/);
    });

    it('rejects dangerous system env var names', () => {
      setupGithub();
      for (const name of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS']) {
        const res = mockResponse();
        handleSubstituteRequest(mockRequest(`/credentials/github/substitute?path=oauth&envVar=${name}`), res, SCOPE);
        expect(res._status).toBe(400);
        expect(JSON.parse(res._body).error).toMatch(/Reserved env var name/);
      }
    });

    it('rejects container-runner statics (HOST_UID etc.)', () => {
      setupGithub();
      for (const name of ['TZ', 'HOME', 'HOST_UID', 'HOST_GID']) {
        const res = mockResponse();
        handleSubstituteRequest(mockRequest(`/credentials/github/substitute?path=oauth&envVar=${name}`), res, SCOPE);
        expect(res._status).toBe(400);
        expect(JSON.parse(res._body).error).toMatch(/Reserved env var name/);
      }
    });

    it('includes custom envVar in envNames and calls mergeEnvNames', () => {
      const merge = vi.fn();
      setupGithub(merge);

      const res = mockResponse();
      handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth&envVar=MY_GITHUB'), res, SCOPE);
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.envNames).toEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'MY_GITHUB']);
      expect(merge).toHaveBeenCalledWith(SCOPE, 'github', 'ghp_FaKeSuBsTiTuTe1234567890abcdef', ['MY_GITHUB']);
    });

    it('deduplicates envVar that already exists in discovery', () => {
      setupGithub();
      const res = mockResponse();
      handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth&envVar=GH_TOKEN'), res, SCOPE);
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).envNames).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
    });

    it('accepts valid custom envVar names', () => {
      setupGithub();
      for (const name of ['MY_TOKEN', 'CUSTOM_API_KEY', '_PRIVATE', 'A']) {
        const res = mockResponse();
        handleSubstituteRequest(mockRequest(`/credentials/github/substitute?path=oauth&envVar=${name}`), res, SCOPE);
        expect(res._status).toBe(200);
      }
    });

    it('rejects envVar starting with digit', () => {
      setupGithub();
      const res = mockResponse();
      handleSubstituteRequest(mockRequest('/credentials/github/substitute?path=oauth&envVar=3INVALID'), res, SCOPE);
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/Invalid env var name format/);
    });
  });
});
