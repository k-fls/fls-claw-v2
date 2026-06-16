/**
 * Baseline claude credential provider — the AGENT_RUNTIME endpoint gate.
 *
 * A group whose runtime is repointed at a custom (non-Anthropic) endpoint
 * — e.g. an Ollama gateway via ANTHROPIC_BASE_URL — must NOT be required to
 * hold a Claude credential, otherwise the wake-gate / spawn-validator
 * false-gates the spawn with a phantom "sign in to Claude".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { registerClaudeCredentialProvider } from './claude-credential.js';
import { getCredentialProvider, _resetProviderRegistryForTests } from '../modules/credentials/providers/registry.js';
import { AGENT_RUNTIME } from '../modules/credentials/providers/types.js';

function claudeRequired(raw: unknown): boolean {
  _resetProviderRegistryForTests();
  registerClaudeCredentialProvider();
  const ext = getCredentialProvider('claude')?.getExtension?.(AGENT_RUNTIME);
  if (!ext) throw new Error('claude provider missing AGENT_RUNTIME');
  const reqs = ext.requiredCredentialProviders(ext.parseRuntimeConfig(raw));
  const claude = reqs.find((r) => r.id === 'claude');
  if (!claude) throw new Error('claude not in requiredCredentialProviders');
  return claude.required;
}

describe('Claude credential provider (baseline) — endpoint gate', () => {
  beforeEach(() => _resetProviderRegistryForTests());
  afterEach(() => _resetProviderRegistryForTests());

  it('requires a claude credential by default (api.anthropic.com)', () => {
    // No ANTHROPIC_BASE_URL in the repo .env → default Anthropic endpoint.
    expect(claudeRequired({})).toBe(true);
  });

  it('does NOT require a credential at a custom (Ollama) endpoint', () => {
    expect(claudeRequired({ baseUrl: 'http://host.docker.internal:11434' })).toBe(false);
  });

  it('tolerates a scheme-less custom host[:port]', () => {
    expect(claudeRequired({ baseUrl: 'ollama.local:11434' })).toBe(false);
  });

  it('still requires for anthropic.com / its subdomains', () => {
    expect(claudeRequired({ baseUrl: 'https://api.anthropic.com' })).toBe(true);
    expect(claudeRequired({ baseUrl: 'https://something.anthropic.com/v1' })).toBe(true);
  });

  it('requires (fails safe) when the base url is unparseable', () => {
    expect(claudeRequired({ baseUrl: ':::not a url:::' })).toBe(true);
  });
});
