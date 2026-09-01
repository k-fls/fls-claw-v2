/**
 * Runtime selection at the wake-time gate: which agent a group is asked to be
 * before any credential is requested.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = path.join(os.tmpdir(), `nc-choice-${process.pid}`);

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: path.join(os.tmpdir(), `nc-choice-${process.pid}`, 'groups'),
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./command-gate.js', () => ({ registerHostCommand: vi.fn() }));
vi.mock('./container-runner.js', () => ({ wakeContainer: vi.fn(async () => true) }));
vi.mock('./db/sessions.js', () => ({ getSession: () => undefined }));
vi.mock('./delivery.js', () => ({ deliverDirect: vi.fn(), registerDeliveryAction: vi.fn() }));

const cfg = vi.hoisted(() => ({ provider: null as string | null, updates: [] as unknown[] }));
vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: () => ({ provider: cfg.provider }),
  updateContainerConfigScalars: (id: string, u: unknown) => {
    cfg.updates.push({ id, ...(u as object) });
    cfg.provider = (u as { provider: string | null }).provider;
  },
}));

const menu = vi.hoisted(() => ({ pick: 0 as number | null, prompts: [] as string[], options: [] as string[][] }));
vi.mock('./modules/interactions/pick-option.js', () => ({
  pickOptionOn: async (_o: unknown, opts: { prompt: string; options: string[] }) => {
    menu.prompts.push(opts.prompt);
    menu.options.push(opts.options);
    return menu.pick == null ? { index: null, reason: 'cancelled' } : { index: menu.pick, reason: 'submitted' };
  },
}));

import { maybeBeginCredentialAcquisition, offerableRuntimes, ACQUIRE } from './credential-acquisition.js';
import {
  registerCredentialProvider,
  _resetProviderRegistryForTests,
} from './modules/credentials/providers/registry.js';
import { ExtensionBag, AGENT_RUNTIME, type AgentRuntimeExt } from './modules/credentials/providers/types.js';
import type { AcquireExt } from './credential-acquisition.js';
import type { AgentGroup, Session } from './types.js';

const FOLDER = 'grp';
const deliveryAddr = { channelType: 'cli', platformId: 'local', threadId: null };

const group = { id: 'ag', name: 'g', folder: FOLDER, agent_provider: null, created_at: '' } as AgentGroup;
const sess: Session = {
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

function runtimeFor(id: string): AgentRuntimeExt {
  return {
    containerContribution: () => ({}),
    requiredCredentialProviders: () => [{ id, required: true }],
    parseRuntimeConfig: () => ({}),
  };
}

function register(id: string, acquire: AcquireExt): void {
  const bag = new ExtensionBag().set(AGENT_RUNTIME, runtimeFor(id)).set(ACQUIRE, acquire);
  registerCredentialProvider({
    id,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    getExtension: bag.get,
  });
}

function seedCredential(providerId: string): void {
  const dir = path.join(TMP, '.config', 'nanoclaw', 'credentials', FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${providerId}.keys.json`), JSON.stringify({ api_key: { value: 'enc:x' } }));
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fs.mkdirSync(path.join(TMP, 'groups'), { recursive: true });
  vi.stubEnv('HOME', TMP);
  _resetProviderRegistryForTests();
  cfg.provider = null;
  cfg.updates = [];
  menu.pick = 0;
  menu.prompts = [];
  menu.options = [];
});
afterEach(() => {
  _resetProviderRegistryForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('offerableRuntimes', () => {
  it('offers only labelled agent runtimes whose runtime half is installed', () => {
    register('claude', { runtimeLabel: 'Claude', acquire: async () => true });
    register('codex', { runtimeLabel: 'Codex', isRuntimeAvailable: () => false, acquire: async () => true });
    // Signs in but never offered as a choice — a tool credential, not a runtime.
    register('github', { acquire: async () => true });

    expect(offerableRuntimes()).toEqual([{ id: 'claude', label: 'Claude' }]);
  });

  it('preserves registration order so the default runtime is listed first', () => {
    register('claude', { runtimeLabel: 'Claude', acquire: async () => true });
    register('codex', { runtimeLabel: 'Codex', acquire: async () => true });

    expect(offerableRuntimes().map((o) => o.id)).toEqual(['claude', 'codex']);
  });
});

describe('wake-time gate — runtime selection', () => {
  it('asks which agent to run as, records the answer, then signs into the pick', async () => {
    const claudeAcquire = vi.fn(async () => true);
    const codexAcquire = vi.fn(async () => true);
    register('claude', { runtimeLabel: 'Claude', acquire: claudeAcquire });
    register('codex', { runtimeLabel: 'Codex', acquire: codexAcquire });
    menu.pick = 1; // Codex

    expect(maybeBeginCredentialAcquisition({ agentGroup: group, session: sess, deliveryAddr, userId: 'cli:op' })).toBe(
      true,
    );
    await flush();

    expect(menu.options[0]).toEqual(['Claude', 'Codex']);
    expect(cfg.updates).toEqual([{ id: 'ag', provider: 'codex' }]);
    expect(codexAcquire).toHaveBeenCalledOnce();
    expect(claudeAcquire).not.toHaveBeenCalled();
  });

  it('skips the menu when only one runtime is offerable', async () => {
    const acquire = vi.fn(async () => true);
    register('claude', { runtimeLabel: 'Claude', acquire });

    maybeBeginCredentialAcquisition({ agentGroup: group, session: sess, deliveryAddr, userId: 'cli:op' });
    await flush();

    expect(menu.prompts).toEqual([]);
    expect(cfg.updates).toEqual([]);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('never re-asks a group whose runtime was set deliberately', async () => {
    const acquire = vi.fn(async () => true);
    register('claude', { runtimeLabel: 'Claude', acquire });
    register('codex', { runtimeLabel: 'Codex', acquire: async () => true });
    cfg.provider = 'claude'; // e.g. `ncl groups config update --provider claude`

    maybeBeginCredentialAcquisition({ agentGroup: group, session: sess, deliveryAddr, userId: 'cli:op' });
    await flush();

    expect(menu.prompts).toEqual([]);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('does not sign in when the chosen runtime already holds a credential', async () => {
    const codexAcquire = vi.fn(async () => true);
    register('claude', { runtimeLabel: 'Claude', acquire: async () => true });
    register('codex', { runtimeLabel: 'Codex', acquire: codexAcquire });
    seedCredential('codex');
    menu.pick = 1;

    maybeBeginCredentialAcquisition({ agentGroup: group, session: sess, deliveryAddr, userId: 'cli:op' });
    await flush();

    expect(cfg.updates).toEqual([{ id: 'ag', provider: 'codex' }]);
    expect(codexAcquire).not.toHaveBeenCalled();
  });

  it('records nothing and signs into nothing when the menu is cancelled', async () => {
    const acquire = vi.fn(async () => true);
    register('claude', { runtimeLabel: 'Claude', acquire });
    register('codex', { runtimeLabel: 'Codex', acquire: async () => true });
    menu.pick = null;

    maybeBeginCredentialAcquisition({ agentGroup: group, session: sess, deliveryAddr, userId: 'cli:op' });
    await flush();

    expect(cfg.updates).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
  });
});
