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
  decrypt: vi.fn(() => 'inline-secret') as (...a: unknown[]) => string,
  pasteResult: { reason: 'submitted', text: 'the-secret' } as { reason: string; text: string | null },
  paste: vi.fn(),
  borrowSource: null as string | null,
  canAccess: true,
  byScope: new Map<string, string[]>(), // non-own scope → provider ids (grantor scopes)
  isAdmin: false, // cross-group owner gate
  groupsById: new Map<string, { id: string; folder: string; name: string }>(),
  groupsByFolder: new Map<string, { id: string; folder: string; name: string }>(),
  messagingGroups: new Map<string, { id: string }>(),
  messagingGroupAgents: new Map<string, Array<{ agent_group_id: string }>>(),
}));

const SELF = { id: 'g1', folder: 'mygroup', name: 'My Group' };

vi.mock('../../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'g1' ? SELF : h.groupsById.get(id)),
  getAgentGroupByFolder: (f: string) => (f === 'mygroup' ? SELF : h.groupsByFolder.get(f)),
  getAllAgentGroups: () => [SELF, ...h.groupsById.values()],
}));
vi.mock('../../../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => h.messagingGroups.get(id),
  getMessagingGroupAgents: (mgId: string) => h.messagingGroupAgents.get(mgId) ?? [],
}));
vi.mock('../../../command-gate.js', () => ({
  isAdmin: () => h.isAdmin,
}));
vi.mock('../../interactions/index.js', () => ({
  pastePgp: (...a: unknown[]) => h.paste(...a),
}));
vi.mock('../grants.js', () => ({
  addGrantee: () => {},
  canAccess: () => h.canAccess,
  clearBorrowSource: () => {},
  getBorrowSource: () => h.borrowSource,
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
  normalizeArmoredBlock: (s: string) => s,
}));
vi.mock('../../crypto/gpg.js', () => ({
  gpgDecryptAt: (...a: unknown[]) => h.decrypt(...a),
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
  // Own scope is 'mygroup' (the test agent group's folder); any other scope is a
  // grantor scope seeded via h.byScope.
  listProviderIds: (scope: string) => (scope === 'mygroup' ? h.storeProviders : (h.byScope.get(scope) ?? [])),
  listEntries: (_s: string, p: string) => h.entries.get(p) ?? [],
}));
vi.mock('../types.js', () => ({ asCredentialScope: (s: string) => s }));

import { handleCredsCommand, _resetCredsCrossInFlightForTests } from './creds.js';

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
  h.decrypt = vi.fn(() => 'inline-secret');
  h.pasteResult = { reason: 'submitted', text: 'the-secret' };
  h.paste = vi.fn(() => Promise.resolve(h.pasteResult));
  h.borrowSource = null;
  h.canAccess = true;
  h.byScope = new Map();
  h.isAdmin = false;
  h.groupsById = new Map();
  h.groupsByFolder = new Map();
  h.messagingGroups = new Map();
  h.messagingGroupAgents = new Map();
  _resetCredsCrossInFlightForTests();
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

describe('/creds list borrow|shadow (C7s/C7o)', () => {
  it('rejects an unknown mode', () => {
    expect(run(['list', 'bogus'])[0]).toMatch(/Usage: \/creds list \[borrow\|shadow\]/);
  });

  it('borrow: reports when not borrowing', () => {
    h.borrowSource = null;
    expect(run(['list', 'borrow'])[0]).toMatch(/Not borrowing from any group/);
  });

  it('borrow: reports pending when the grant is not active', () => {
    h.borrowSource = 'lender';
    h.canAccess = false;
    expect(run(['list', 'borrow'])[0]).toMatch(/not active yet/);
  });

  it('borrow: lists the grantor providers, marking own-shadowed ones', () => {
    h.borrowSource = 'lender';
    h.canAccess = true;
    h.byScope.set('lender', ['claude', 'github']);
    h.storeProviders = ['github']; // own github shadows the borrowed one
    const r = run(['list', 'borrow'])[0];
    expect(r).toContain('Borrowable credentials');
    expect(r).toContain('*lender*');
    expect(r).toMatch(/\*claude\* — in use \(borrowed\)/);
    expect(r).toMatch(/\*github\* — shadowed by your own credential/);
  });

  it('shadow: lists providers where an own credential overrides a borrowed one', () => {
    h.borrowSource = 'lender';
    h.canAccess = true;
    h.byScope.set('lender', ['claude', 'github']);
    h.storeProviders = ['github'];
    const r = run(['list', 'shadow'])[0];
    expect(r).toContain('Shadowed credentials');
    expect(r).toContain('*github*');
    expect(r).not.toContain('*claude*'); // claude is borrowed, not shadowed
  });

  it('shadow: reports none when not actively borrowing', () => {
    h.borrowSource = null;
    expect(run(['list', 'shadow'])[0]).toMatch(/not actively borrowing/);
  });

  it('shadow: reports none when own creds do not overlap the grantor', () => {
    h.borrowSource = 'lender';
    h.canAccess = true;
    h.byScope.set('lender', ['claude']);
    h.storeProviders = ['github']; // no overlap
    expect(run(['list', 'shadow'])[0]).toMatch(/No shadowed credentials/);
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

  // v1-style inline block in the command tail (no interactive prompt).
  const INLINE = '-----BEGIN PGP MESSAGE-----\n\nAAAA\n=zzzz\n-----END PGP MESSAGE-----';

  it('stores an inline PGP block directly, without prompting', () => {
    h.decrypt = vi.fn(() => 'inline-secret');
    const replies = run(['set-key', 'github', 'ci', INLINE]);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.decrypt).toHaveBeenCalledTimes(1);
    const [scope, providerId, credId, cred] = h.store.mock.calls[0];
    expect([scope, providerId, credId]).toEqual(['mygroup', 'github', 'ci']);
    expect((cred as { value: string }).value).toBe('inline-secret');
    expect(replies[0]).toMatch(/Key stored for \*github\* \(\*ci\*\)/);
  });

  it('reports a decrypt failure for a bad inline block and does not store', () => {
    h.decrypt = vi.fn(() => {
      throw new Error('no valid OpenPGP data found');
    });
    const replies = run(['set-key', 'github', INLINE]);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.paste).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/PGP decrypt failed: no valid OpenPGP data found/);
  });

  it('still prompts interactively when no inline block is present', () => {
    run(['set-key', 'github']);
    expect(h.paste).toHaveBeenCalledTimes(1);
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

  it('imports an inline PGP block directly, without prompting', () => {
    h.decrypt = vi.fn(() => 'github:oauth=ghp_inline\nclaude:api_key=sk-inline');
    const INLINE = '-----BEGIN PGP MESSAGE-----\n\nAAAA\n=zzzz\n-----END PGP MESSAGE-----';
    run(['import', INLINE]);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.decrypt).toHaveBeenCalledTimes(1);
    const stored = h.store.mock.calls.map((c) => [c[1], c[2], (c[3] as { value: string }).value]);
    expect(stored).toContainEqual(['github', 'oauth', 'ghp_inline']);
    expect(stored).toContainEqual(['claude', 'api_key', 'sk-inline']);
  });
});

describe('/creds set-key + import — borrow shadow warning', () => {
  function pastePrompt(): string {
    return (h.paste.mock.calls[0][0] as { prompt: string }).prompt;
  }

  it('set-key warns that setting a key shadows the borrowed credential', () => {
    h.borrowSource = 'grantor-group';
    run(['set-key', 'github']);
    const prompt = pastePrompt();
    expect(prompt).toMatch(/borrowing/i);
    expect(prompt).toContain('grantor-group');
    expect(prompt).toMatch(/shadow/i);
    expect(prompt).toContain('github');
  });

  it('import warns when borrowing', () => {
    h.borrowSource = 'grantor-group';
    run(['import']);
    const prompt = pastePrompt();
    expect(prompt).toMatch(/borrowing/i);
    expect(prompt).toContain('grantor-group');
    expect(prompt).toMatch(/shadow/i);
  });

  it('no warning when the group is not borrowing', () => {
    h.borrowSource = null;
    run(['set-key', 'github']);
    expect(pastePrompt()).not.toMatch(/borrowing/i);
  });
});

describe('/creds cross-group (system-owner) — <target>@<provider>', () => {
  function seedGroup(id: string, folder: string, name = folder): void {
    const g = { id, folder, name };
    h.groupsById.set(id, g);
    h.groupsByFolder.set(folder, g);
  }

  it('denies a non-owner', () => {
    h.isAdmin = false;
    seedGroup('ag-other', 'other');
    const r = run(['set-key', 'other@github']);
    expect(r[0]).toMatch(/requires an owner or global admin/);
    expect(h.paste).not.toHaveBeenCalled();
  });

  it('owner set-key targets another group by folder (stores to its scope)', async () => {
    h.isAdmin = true;
    seedGroup('ag-other', 'other');
    run(['set-key', 'other@github']);
    await new Promise((res) => setTimeout(res, 0));
    expect(h.store).toHaveBeenCalledTimes(1);
    const [scope, providerId] = h.store.mock.calls[0];
    expect(scope).toBe('other'); // target scope (asCredentialScope identity in tests)
    expect(providerId).toBe('github');
    // The paste prompt names the target group.
    const prompt = (h.paste.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('for *other*');
  });

  it('reports when the target group is unknown', () => {
    h.isAdmin = true;
    expect(run(['delete', 'ghost@github'])[0]).toMatch(/No agent group matches "ghost"/);
  });

  it('reports ambiguity when a name matches multiple groups', () => {
    h.isAdmin = true;
    h.groupsById.set('ag-1', { id: 'ag-1', folder: 'team-a', name: 'dupe' });
    h.groupsById.set('ag-2', { id: 'ag-2', folder: 'team-b', name: 'dupe' });
    const r = run(['list', 'dupe@'])[0];
    expect(r).toMatch(/matches multiple groups/);
    expect(r).toContain('team-a');
    expect(r).toContain('team-b');
  });

  it('owner list targets another group', () => {
    h.isAdmin = true;
    seedGroup('ag-other', 'other');
    h.byScope.set('other', ['claude', 'github']);
    const r = run(['list', 'other@'])[0];
    expect(r).toContain('[→ other]');
    expect(r).toContain('*claude*');
    expect(r).toContain('*github*');
  });

  it('resolves a target by channel (messaging-group id) with a single agent', async () => {
    h.isAdmin = true;
    seedGroup('ag-other', 'other');
    h.messagingGroups.set('mg-x', { id: 'mg-x' });
    h.messagingGroupAgents.set('mg-x', [{ agent_group_id: 'ag-other' }]);
    run(['set-key', 'mg-x@github']);
    await new Promise((res) => setTimeout(res, 0));
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][0]).toBe('other');
  });

  it('fan-out guard: same message dispatched twice runs the op once', () => {
    h.isAdmin = true;
    seedGroup('ag-other', 'other');
    h.entries.set('github', ['oauth']); // so delete has something to remove
    run(['delete', 'other@github']);
    run(['delete', 'other@github']); // second engaged-agent dispatch of the same message
    expect(h.del).toHaveBeenCalledTimes(1);
  });
});
