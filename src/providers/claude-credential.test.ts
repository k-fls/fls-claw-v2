/**
 * The Claude credential provider's interactive credential acquisition. Uses
 * REAL gpg: the key must be pasted GPG-encrypted and is decrypted host-side.
 * The security property under test is that a *cleartext* key is rejected and
 * never stored (matches v1's GPG-required flow).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const TMP_ROOT = path.join(os.tmpdir(), `nc-cclaude-${process.pid}`);

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: path.join(os.tmpdir(), `nc-cclaude-${process.pid}`, 'groups'),
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../command-gate.js', () => ({ registerHostCommand: vi.fn() }));
// The browser-auth modes spawn a container; stub it so the menu's OAuth paths
// are unit-testable without Docker.
vi.mock('../auth-container.js', () => ({ spawnAuthContainer: vi.fn() }));

import { registerClaudeCredentialProvider } from './claude-credential.js';
import { spawnAuthContainer } from '../auth-container.js';
import { ACQUIRE } from '../credential-acquisition.js';
import { getCredentialProvider, _resetProviderRegistryForTests } from '../modules/credentials/providers/registry.js';
import { AGENT_RUNTIME, CONTAINER_FEEDBACK } from '../modules/credentials/providers/types.js';
import { REAUTH } from '../modules/credentials/reauth.js';
import { asGroupScope } from '../modules/credentials/types.js';
import { readKeysFile } from '../modules/credentials/store.js';
import { asCredentialScope } from '../modules/credentials/types.js';
import { gpgHomeForScope, isGpgAvailable } from '../modules/credentials/gpg.js';
import { getOrCreateResolverForAgentGroup } from '../modules/credentials/resolver.js';
import { initTokenEngine, _resetTokenEngineForTests, CRED_OAUTH } from '../modules/mitm-proxy/index.js';
import {
  deliverToActiveInteraction,
  _resetHostInteractionsForTesting,
  type InteractionOrigin,
} from '../host-interactions.js';

const FOLDER = 'grp-claude';
const KEY = { channelType: 'cli', platformId: 'local', threadId: null, userId: 'cli:op' };

function makeOrigin(replies: string[]): InteractionOrigin {
  return {
    key: KEY,
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    replyAddr: { channelType: 'cli', platformId: 'local', threadId: null },
    writeReply: (t) => replies.push(t),
  };
}
const reply = (text: string) => deliverToActiveInteraction(KEY, JSON.stringify({ text }), 'chat');

function acquireExt() {
  registerClaudeCredentialProvider();
  const ext = getCredentialProvider('claude')?.getExtension?.(ACQUIRE);
  if (!ext) throw new Error('claude provider missing ACQUIRE extension');
  return ext;
}

/** Encrypt `plaintext` to the scope's own GPG key (the key acquire() created). */
function encryptToScope(plaintext: string): string {
  const home = gpgHomeForScope(asCredentialScope(FOLDER));
  return execFileSync(
    'gpg',
    ['--homedir', home, '--armor', '--encrypt', '--trust-model', 'always', '-r', `${FOLDER}@nanoclaw.local`],
    { input: plaintext },
  ).toString();
}

function storedKeys(): string[] {
  try {
    return Object.keys(readKeysFile(asCredentialScope(FOLDER), 'claude'));
  } catch {
    return [];
  }
}

beforeEach(() => {
  fs.mkdirSync(path.join(TMP_ROOT, 'groups'), { recursive: true });
  vi.stubEnv('HOME', TMP_ROOT);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(TMP_ROOT, '.config'));
  _resetProviderRegistryForTests();
  _resetHostInteractionsForTesting();
  _resetTokenEngineForTests();
  // The merged provider's substitution facet reads the token engine.
  initTokenEngine((s) => getOrCreateResolverForAgentGroup(s as unknown as string));
});
afterEach(() => {
  _resetProviderRegistryForTests();
  _resetHostInteractionsForTesting();
  _resetTokenEngineForTests();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Claude credential provider — GPG-encrypted acquire', () => {
  // Menu option 1 = "Paste Anthropic API key (GPG-encrypted)". The acquire/
  // reauth flows present this menu first; pick 1 to reach the api-key paste.
  const PICK_API_KEY = '1';

  it('rejects a CLEARTEXT key and never stores it (the security property)', async () => {
    if (!isGpgAvailable()) return;
    const replies: string[] = [];
    const p = acquireExt().acquire({ origin: makeOrigin(replies), credentialScope: asCredentialScope(FOLDER) });

    await reply(PICK_API_KEY); // choose api-key paste from the menu
    expect(replies.some((r) => /GPG-encrypted/i.test(r))).toBe(true); // prompt demands encryption
    await reply('sk-ant-api03-PLAINTEXTleakage'); // user pastes the raw key
    expect(replies.some((r) => /PGP-encrypted/i.test(r))).toBe(true); // rejected, re-prompted
    expect(storedKeys()).not.toContain('api_key'); // plaintext NEVER stored

    await reply('cancel');
    expect(await p).toBe(false);
  }, 30000);

  it('accepts a GPG-encrypted key, decrypts host-side, and stores it', async () => {
    if (!isGpgAvailable()) return;
    const replies: string[] = [];
    const p = acquireExt().acquire({ origin: makeOrigin(replies), credentialScope: asCredentialScope(FOLDER) });

    await reply(PICK_API_KEY); // ensureGpgKey runs here, creating the scope's gpg home
    await reply(encryptToScope('sk-ant-api03-realvalidkey1234567890'));
    expect(await p).toBe(true);
    expect(storedKeys()).toContain('api_key');
    expect(replies.some((r) => /stored/i.test(r))).toBe(true);
  }, 30000);

  it('rejects an encrypted blob whose cleartext is not an API key', async () => {
    if (!isGpgAvailable()) return;
    const replies: string[] = [];
    const p = acquireExt().acquire({ origin: makeOrigin(replies), credentialScope: asCredentialScope(FOLDER) });

    await reply(PICK_API_KEY);
    await reply(encryptToScope('definitely-not-an-api-key'));
    expect(replies.some((r) => /not an Anthropic API key/i.test(r))).toBe(true);
    expect(storedKeys()).not.toContain('api_key');

    await reply('cancel');
    expect(await p).toBe(false);
  }, 30000);

  it('returns false and stores nothing on cancel at the menu', async () => {
    if (!isGpgAvailable()) return;
    const replies: string[] = [];
    const p = acquireExt().acquire({ origin: makeOrigin(replies), credentialScope: asCredentialScope(FOLDER) });
    await reply('cancel');
    expect(await p).toBe(false);
    expect(storedKeys()).not.toContain('api_key');
  }, 30000);

  it('browser-auth mode (auth_login): success when the proxy captures a credential', async () => {
    // The real capture is the proxy intercepting the CLI token-exchange; the
    // spawn mock simulates it by storing an oauth credential mid-run.
    vi.mocked(spawnAuthContainer).mockImplementation(async () => {
      getOrCreateResolverForAgentGroup(FOLDER).store(asCredentialScope(FOLDER), 'claude', CRED_OAUTH, {
        value: 'sk-ant-oat01-captured-by-proxy',
        updated_ts: Date.now(),
        expires_ts: 0,
      });
    });
    const replies: string[] = [];
    const p = acquireExt().acquire({ origin: makeOrigin(replies), credentialScope: asCredentialScope(FOLDER) });

    await reply('3'); // menu option 3 = auth login
    expect(await p).toBe(true);
    expect(vi.mocked(spawnAuthContainer)).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auth_login', folder: FOLDER }),
    );
    expect(storedKeys()).toContain('oauth');
    expect(replies.some((r) => /complete|stored/i.test(r))).toBe(true);
  }, 30000);

  it('browser-auth mode: failure when the proxy captures nothing (cancel/timeout)', async () => {
    vi.mocked(spawnAuthContainer).mockResolvedValue(undefined); // container ran, nothing captured
    const replies: string[] = [];
    const p = acquireExt().acquire({ origin: makeOrigin(replies), credentialScope: asCredentialScope(FOLDER) });

    await reply('2'); // setup-token
    expect(await p).toBe(false);
    expect(storedKeys()).not.toContain('oauth');
    expect(replies.some((r) => /did not complete/i.test(r))).toBe(true);
  }, 30000);
});

describe('Claude credential provider — CONTAINER_FEEDBACK routing', () => {
  const ctx = { agentGroupId: 'ag-1', scope: asGroupScope(FOLDER), containerName: '' };

  it("routes 'auth-invalid' to reauth and everything else to surface", () => {
    registerClaudeCredentialProvider();
    const ext = getCredentialProvider('claude')?.getExtension?.(CONTAINER_FEEDBACK);
    if (!ext) throw new Error('claude provider missing CONTAINER_FEEDBACK extension');
    expect(
      ext.onContainerError({ message: '401', retryable: false, classification: 'auth-invalid' }, undefined, ctx),
    ).toBe('reauth');
    expect(
      ext.onContainerError({ message: 'slow down', retryable: true, classification: 'rate-limit' }, undefined, ctx),
    ).toBe('surface');
    expect(ext.onContainerError({ message: 'boom', retryable: false }, undefined, ctx)).toBe('surface');
  });
});

describe('Claude credential provider — AGENT_RUNTIME defaultTapExcludeHosts', () => {
  function tapHosts(cfg: { env?: Record<string, string>; runtimeConfig?: unknown }): string[] {
    registerClaudeCredentialProvider();
    const ext = getCredentialProvider('claude')?.getExtension?.(AGENT_RUNTIME);
    if (!ext?.defaultTapExcludeHosts) throw new Error('claude provider missing defaultTapExcludeHosts');
    return [...ext.defaultTapExcludeHosts(cfg)];
  }

  it('defaults to api.anthropic.com with no config', () => {
    expect(tapHosts({})).toEqual(['api.anthropic.com']);
  });

  it('reads the host from ANTHROPIC_BASE_URL env (Ollama case)', () => {
    expect(tapHosts({ env: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' } })).toEqual([
      'host.docker.internal',
    ]);
  });

  it('tolerates a scheme-less host[:port] base url', () => {
    expect(tapHosts({ env: { ANTHROPIC_BASE_URL: 'ollama.local:11434' } })).toEqual(['ollama.local']);
  });

  it('falls back to runtimeConfig.baseUrl when no env override', () => {
    expect(tapHosts({ runtimeConfig: { baseUrl: 'https://llm.internal.acme/v1' } })).toEqual(['llm.internal.acme']);
  });

  it('prefers env over runtimeConfig', () => {
    expect(
      tapHosts({
        env: { ANTHROPIC_BASE_URL: 'https://from-env.example' },
        runtimeConfig: { baseUrl: 'https://from-rc.example' },
      }),
    ).toEqual(['from-env.example']);
  });
});

describe('Claude credential provider — AGENT_RUNTIME requiredCredentialProviders (endpoint gate)', () => {
  function required(raw: unknown): boolean {
    _resetProviderRegistryForTests(); // allow multiple calls per test
    registerClaudeCredentialProvider();
    const ext = getCredentialProvider('claude')?.getExtension?.(AGENT_RUNTIME);
    if (!ext) throw new Error('claude provider missing AGENT_RUNTIME');
    const reqs = ext.requiredCredentialProviders(ext.parseRuntimeConfig(raw));
    const claude = reqs.find((r) => r.id === 'claude');
    if (!claude) throw new Error('claude not in requiredCredentialProviders');
    return claude.required;
  }

  it('requires a claude credential by default (api.anthropic.com)', () => {
    // No .env ANTHROPIC_BASE_URL in the repo → default Anthropic endpoint.
    expect(required({})).toBe(true);
  });

  it('does NOT require a credential when repointed at a custom (Ollama) endpoint', () => {
    expect(required({ baseUrl: 'http://host.docker.internal:11434' })).toBe(false);
  });

  it('tolerates a scheme-less custom host[:port]', () => {
    expect(required({ baseUrl: 'ollama.local:11434' })).toBe(false);
  });

  it('still requires for an anthropic.com subdomain', () => {
    expect(required({ baseUrl: 'https://api.anthropic.com' })).toBe(true);
    expect(required({ baseUrl: 'https://something.anthropic.com/v1' })).toBe(true);
  });

  it('requires (fails safe) when the base url is unparseable', () => {
    expect(required({ baseUrl: ':::not a url:::' })).toBe(true);
  });
});

describe('Claude credential provider — REAUTH (mid-session, GPG paste)', () => {
  function reauthExt() {
    registerClaudeCredentialProvider();
    const ext = getCredentialProvider('claude')?.getExtension?.(REAUTH);
    if (!ext) throw new Error('claude provider missing REAUTH extension');
    return ext;
  }

  it('prompts with the rejection reason, stores a GPG-encrypted replacement key', async () => {
    if (!isGpgAvailable()) return;
    const replies: string[] = [];
    const p = reauthExt().reauth({
      origin: makeOrigin(replies),
      credentialScope: asCredentialScope(FOLDER),
      classification: 'auth-invalid',
      reason: 'API Error 401',
    });

    expect(replies.some((r) => /Authentication required for Claude/.test(r))).toBe(true); // menu intro
    await reply('1'); // choose api-key paste
    expect(replies.some((r) => r.includes('API Error 401'))).toBe(true); // rejection reason in the preamble
    expect(replies.some((r) => /GPG-encrypted/i.test(r))).toBe(true);

    await reply(encryptToScope('sk-ant-api03-replacementkey1234567890'));
    expect(await p).toBe(true);
    expect(storedKeys()).toContain('api_key');
    expect(replies.some((r) => /Retrying/i.test(r))).toBe(true);
  }, 30000);

  it('returns false and stores nothing on cancel', async () => {
    if (!isGpgAvailable()) return;
    const replies: string[] = [];
    const p = reauthExt().reauth({
      origin: makeOrigin(replies),
      credentialScope: asCredentialScope(FOLDER),
      classification: 'auth-invalid',
      reason: 'API Error 401',
    });
    await reply('cancel');
    expect(await p).toBe(false);
    expect(storedKeys()).not.toContain('api_key');
  }, 30000);
});
