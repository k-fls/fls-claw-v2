import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { HostCommandContext } from '../../../command-gate.js';

const h = vi.hoisted(() => ({
  gpgAvailable: true,
  providers: new Set<string>(['github', 'claude']),
  storeProviders: [] as string[], // listProviderIds
  entries: new Map<string, string[]>(), // providerId → credential ids
  store: vi.fn(),
  del: vi.fn(),
  ensureGpgKey: vi.fn(),
  pasteResult: { reason: 'submitted', text: 'the-secret' } as { reason: string; text: string | null },
  paste: vi.fn(),
}));

vi.mock('../../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id ? { id, folder: 'mygroup' } : undefined),
  getAgentGroupByFolder: (f: string) => ({ id: `id-${f}`, folder: f }),
}));
vi.mock('../../interactions/index.js', () => ({
  pastePgp: (...a: unknown[]) => h.paste(...a),
}));
vi.mock('../grants.js', () => ({
  addGrantee: () => {},
  clearBorrowSource: () => {},
  getBorrowSource: () => null,
  isGrantee: () => false,
  listGrantees: () => [],
  removeGrantee: () => {},
  setBorrowSource: () => {},
}));
vi.mock('../gpg.js', () => ({
  buildPgpEncryptUrl: () => 'https://encrypt.example/?key=abc',
  ensureGpgKey: (...a: unknown[]) => h.ensureGpgKey(...a),
  exportPublicKey: () => '-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n-----END PGP PUBLIC KEY BLOCK-----',
  gpgHomeForScope: () => '/tmp/gpg-home/mygroup',
  isGpgAvailable: () => h.gpgAvailable,
}));
vi.mock('../manifest.js', () => ({ distributeAllManifests: () => {}, revokeGranteeManifests: () => {} }));
vi.mock('../providers/registry.js', () => ({
  getAllCredentialProviders: () => [...h.providers].map((id) => ({ id })),
  getCredentialProvider: (id: string) => (h.providers.has(id) ? { id } : undefined),
}));
vi.mock('../resolver.js', () => ({
  getOrCreateResolverForAgentGroup: () => ({ store: h.store, delete: h.del }),
}));
vi.mock('../scope-invalidator.js', () => ({ invalidateScope: () => {} }));
vi.mock('../store.js', () => ({
  listProviderIds: () => h.storeProviders,
  listEntries: (_s: string, p: string) => h.entries.get(p) ?? [],
}));
vi.mock('../types.js', () => ({ asCredentialScope: (s: string) => s }));

import { handleCredsCommand } from './creds.js';

function run(args: string[]): string[] {
  const replies: string[] = [];
  handleCredsCommand({
    command: '/creds',
    args,
    argsRaw: args.join(' '),
    userId: 'discord:op',
    agentGroupId: 'g1',
    messagingGroupId: 'mg1',
    scope: 'agent',
    reply: { channelType: 'discord', platformId: 'c1', threadId: null },
    replyText: (t: string) => replies.push(t),
    beginInteraction: () => {},
  } as unknown as HostCommandContext);
  return replies;
}

beforeEach(() => {
  h.gpgAvailable = true;
  h.providers = new Set(['github', 'claude']);
  h.storeProviders = [];
  h.entries = new Map();
  h.store = vi.fn();
  h.del = vi.fn();
  h.ensureGpgKey = vi.fn();
  h.pasteResult = { reason: 'submitted', text: 'the-secret' };
  h.paste = vi.fn(() => Promise.resolve(h.pasteResult));
});

describe('/creds gpg (C7g)', () => {
  it('ensures a key and prints the armored pubkey + encrypt link', () => {
    const r = run(['gpg']);
    expect(h.ensureGpgKey).toHaveBeenCalledTimes(1);
    expect(r[0]).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(r[0]).toContain('https://encrypt.example/?key=abc');
  });

  it('refuses when GPG is unavailable', () => {
    h.gpgAvailable = false;
    expect(run(['gpg'])[0]).toMatch(/GPG is not available/);
  });
});

describe('/creds list + status (C7o)', () => {
  it('list: reports none when nothing is stored', () => {
    expect(run(['list'])[0]).toMatch(/No credentials stored/);
  });

  it('list: shows providers and their entry ids', () => {
    h.storeProviders = ['github'];
    h.entries.set('github', ['oauth', 'ci']);
    const r = run(['list'])[0];
    expect(r).toContain('*github*: ci, oauth');
  });

  it('status: summarises stored credentials', () => {
    h.storeProviders = ['github'];
    h.entries.set('github', ['oauth']);
    expect(run(['status'])[0]).toContain('*github* (1)');
  });
});

describe('/creds delete (C7o)', () => {
  it('reports when there is nothing to delete', () => {
    expect(run(['delete', 'github'])[0]).toMatch(/No stored credentials/);
    expect(h.del).not.toHaveBeenCalled();
  });

  it('deletes a provider with stored entries', () => {
    h.entries.set('github', ['oauth', 'ci']);
    const r = run(['delete', 'github'])[0];
    expect(h.del).toHaveBeenCalledWith('mygroup', 'github');
    expect(r).toMatch(/2 entries removed/);
  });

  it('requires a provider argument', () => {
    expect(run(['delete'])[0]).toMatch(/Usage: \/creds delete/);
  });
});

describe('/creds set-key (C7o)', () => {
  it('requires a provider', () => {
    expect(run(['set-key'])[0]).toMatch(/Usage: \/creds set-key/);
  });

  it('rejects an unknown provider', () => {
    expect(run(['set-key', 'bogus'])[0]).toMatch(/Unknown provider/);
    expect(h.paste).not.toHaveBeenCalled();
  });

  it('refuses when GPG is unavailable', () => {
    h.gpgAvailable = false;
    expect(run(['set-key', 'github'])[0]).toMatch(/GPG is not available/);
  });

  it('launches a paste and stores under the default id on submit', async () => {
    run(['set-key', 'github']);
    expect(h.paste).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.store).toHaveBeenCalledTimes(1);
    const [scope, providerId, credId, cred] = h.store.mock.calls[0];
    expect([scope, providerId, credId]).toEqual(['mygroup', 'github', 'oauth']);
    expect((cred as { value: string }).value).toBe('the-secret');
  });

  it('honours an explicit credential id and expiry', async () => {
    run(['set-key', 'github', 'ci', 'expiry=123']);
    await new Promise((r) => setTimeout(r, 0));
    const [, , credId, cred] = h.store.mock.calls[0];
    expect(credId).toBe('ci');
    expect((cred as { expires_ts: number }).expires_ts).toBe(123);
  });

  it('does not store on cancel', async () => {
    h.pasteResult = { reason: 'cancelled', text: null };
    h.paste = vi.fn(() => Promise.resolve(h.pasteResult));
    run(['set-key', 'github']);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.store).not.toHaveBeenCalled();
  });
});

describe('/creds import (C7o)', () => {
  it('stores prefixed lines across providers on submit', async () => {
    h.pasteResult = { reason: 'submitted', text: 'github:oauth=ghp_1\nclaude:api_key=sk-ant\n# comment\nbad-line' };
    h.paste = vi.fn(() => Promise.resolve(h.pasteResult));
    run(['import']);
    expect(h.paste).toHaveBeenCalledTimes(1);
    await new Promise((res) => setTimeout(res, 0));
    expect(h.store).toHaveBeenCalledTimes(2);
    const stored = h.store.mock.calls.map((c) => [c[1], c[2], (c[3] as { value: string }).value]);
    expect(stored).toContainEqual(['github', 'oauth', 'ghp_1']);
    expect(stored).toContainEqual(['claude', 'api_key', 'sk-ant']);
  });

  it('attributes un-prefixed lines to an explicit default provider', async () => {
    h.pasteResult = { reason: 'submitted', text: 'oauth=ghp_2\nci=ghp_3' };
    h.paste = vi.fn(() => Promise.resolve(h.pasteResult));
    run(['import', 'github']);
    await new Promise((res) => setTimeout(res, 0));
    expect(h.store).toHaveBeenCalledTimes(2);
    expect(h.store.mock.calls.every((c) => c[1] === 'github')).toBe(true);
  });

  it('skips entries for unknown providers', async () => {
    h.pasteResult = { reason: 'submitted', text: 'github:oauth=ok\nbogus:x=y' };
    h.paste = vi.fn(() => Promise.resolve(h.pasteResult));
    const replies = run(['import']);
    await new Promise((res) => setTimeout(res, 0));
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1]).toBe('github');
    expect(replies[0]).toMatch(/unknown provider/i);
  });
});
