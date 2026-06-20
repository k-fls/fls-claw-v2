/**
 * Wake-time credential gate. Mocks container-runner + DB so the decision logic
 * is tested without the spawn machinery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = path.join(os.tmpdir(), `nc-gate-${process.pid}`);

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: path.join(os.tmpdir(), `nc-gate-${process.pid}`, 'groups'),
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./command-gate.js', () => ({ registerHostCommand: vi.fn() }));
// Only wakeContainer is needed from container-runner (runAcquire's re-wake);
// resolveProviderName now lives in container-config (real, unmocked).
vi.mock('./container-runner.js', () => ({ wakeContainer: vi.fn(async () => true) }));
vi.mock('./db/container-configs.js', () => ({ getContainerConfig: () => ({ provider: 'claude' }) }));
vi.mock('./db/sessions.js', () => ({ getSession: () => undefined }));
vi.mock('./delivery.js', () => ({ deliverDirect: vi.fn(), registerDeliveryAction: vi.fn() }));

import { maybeBeginCredentialAcquisition, ACQUIRE } from './credential-acquisition.js';
import {
  registerCredentialProvider,
  _resetProviderRegistryForTests,
} from './modules/credentials/providers/registry.js';
import { ExtensionBag, AGENT_RUNTIME, type AgentRuntimeExt } from './modules/credentials/providers/types.js';
import type { AcquireExt } from './credential-acquisition.js';
import type { AgentGroup, Session } from './types.js';

const FOLDER = 'grp';
const deliveryAddr = { channelType: 'cli', platformId: 'local', threadId: null };

function agentGroup(): AgentGroup {
  return { id: 'ag', name: 'g', folder: FOLDER, agent_provider: null, created_at: '' } as AgentGroup;
}
function session(): Session {
  return {
    id: 's',
    agent_group_id: 'ag',
    messaging_group_id: 'mg',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: '',
  };
}

const rt: AgentRuntimeExt = {
  containerContribution: () => ({}),
  requiredCredentialProviders: () => [{ id: 'claude', required: true }],
  parseRuntimeConfig: () => ({}),
};

function registerClaude(opts: { acquire?: AcquireExt } = {}): void {
  const bag = new ExtensionBag().set(AGENT_RUNTIME, rt);
  if (opts.acquire) bag.set(ACQUIRE, opts.acquire);
  registerCredentialProvider({
    id: 'claude',
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    getExtension: bag.get,
  });
}

function seedStoredCredential(): void {
  const dir = path.join(TMP, '.config', 'nanoclaw', 'credentials', FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.keys.json'), JSON.stringify({ api_key: { value: 'enc:x' } }));
}

beforeEach(() => {
  fs.mkdirSync(path.join(TMP, 'groups'), { recursive: true });
  vi.stubEnv('HOME', TMP);
  _resetProviderRegistryForTests();
});
afterEach(() => {
  _resetProviderRegistryForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('maybeBeginCredentialAcquisition (wake-time gate)', () => {
  it('starts acquisition (true) + invokes acquire when the required cred is missing', () => {
    const acquire = vi.fn(async () => true);
    registerClaude({ acquire: { acquire } });
    const started = maybeBeginCredentialAcquisition({
      agentGroup: agentGroup(),
      session: session(),
      deliveryAddr,
      userId: 'cli:op',
    });
    expect(started).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('proceeds (false) when the credential is already present', () => {
    const acquire = vi.fn(async () => true);
    registerClaude({ acquire: { acquire } });
    seedStoredCredential();
    const started = maybeBeginCredentialAcquisition({
      agentGroup: agentGroup(),
      session: session(),
      deliveryAddr,
      userId: 'cli:op',
    });
    expect(started).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('proceeds (false) when there is no identifiable user to prompt', () => {
    const acquire = vi.fn(async () => true);
    registerClaude({ acquire: { acquire } });
    const started = maybeBeginCredentialAcquisition({
      agentGroup: agentGroup(),
      session: session(),
      deliveryAddr,
      userId: null,
    });
    expect(started).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('proceeds (false) when the provider declares no acquire capability', () => {
    registerClaude({}); // AGENT_RUNTIME only, no ACQUIRE
    const started = maybeBeginCredentialAcquisition({
      agentGroup: agentGroup(),
      session: session(),
      deliveryAddr,
      userId: 'cli:op',
    });
    expect(started).toBe(false);
  });
});
