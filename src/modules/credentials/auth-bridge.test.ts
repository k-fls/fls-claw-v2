/**
 * OAuth auth-bridge — the container↔user rendezvous, host side. Exercises the
 * real interaction machinery (beginInteractionOn / deliverToActiveInteraction)
 * and the registered `/auth/*` host-rpc handler, simulating the auth
 * container's calls by invoking the handler directly with a forged scope.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { matchHostRpc } from '../host-rpc/registry.js';
import {
  _resetHostInteractionsForTesting,
  deliverToActiveInteraction,
  type InteractionOrigin,
} from '../../host-interactions.js';
import type { ContainerScope } from '../container-bootstrap/index.js';
import { startAuthEpisode, _resetAuthBridgeForTests, type AuthCodeResult } from './auth-bridge.js';

const SCOPE = 'test-agent' as unknown as ContainerScope;
const OTHER_SCOPE = 'other-agent' as unknown as ContainerScope;
const NONCE = 'nonce-abc';
const URL = 'https://claude.ai/oauth/authorize?code_challenge=xyz';

function makeOrigin(replies: string[]): InteractionOrigin {
  return {
    key: { channelType: 'telegram', platformId: 'telegram:123', threadId: null, userId: 'telegram:42' },
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    replyAddr: { channelType: 'telegram', platformId: 'telegram:123', threadId: null },
    writeReply: (t) => replies.push(t),
  };
}

/** Invoke the registered `/auth/*` handler the way the host-rpc server would. */
function authRpc(path: string, body: unknown, scope: ContainerScope = SCOPE): Promise<unknown> {
  const entry = matchHostRpc(path);
  if (!entry) throw new Error(`no host-rpc handler for ${path}`);
  return Promise.resolve(entry.invoke({ method: 'POST', path, body, callerIP: '172.20.0.2' }, scope, 'test-session'));
}

/** Simulate the user pasting `text` into the active interaction. */
function userPastes(origin: InteractionOrigin, text: string): Promise<boolean> {
  return deliverToActiveInteraction(origin.key, JSON.stringify({ text }), 'chat');
}

beforeEach(() => {
  _resetHostInteractionsForTesting();
  _resetAuthBridgeForTests();
});

describe('auth-bridge', () => {
  it('relays the URL to the user and hands the pasted code to the code poll', async () => {
    const replies: string[] = [];
    const origin = makeOrigin(replies);
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin });

    const codeP = authRpc('/auth/code', { nonce: NONCE }) as Promise<AuthCodeResult>;

    const relayed = await authRpc('/auth/url', { nonce: NONCE, url: URL, instructions: 'paste the code' });
    expect(relayed).toEqual({ relayed: true });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(URL);
    expect(replies[0]).toContain('paste the code');

    await userPastes(origin, 'AUTHCODE-123');
    expect(await codeP).toEqual({ code: 'AUTHCODE-123' });
  });

  it('resolves the code poll as cancelled when the user cancels', async () => {
    const replies: string[] = [];
    const origin = makeOrigin(replies);
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin });

    const codeP = authRpc('/auth/code', { nonce: NONCE }) as Promise<AuthCodeResult>;
    await authRpc('/auth/url', { nonce: NONCE, url: URL });
    await userPastes(origin, 'cancel');

    expect(await codeP).toEqual({ cancelled: true });
  });

  it('re-prompts on an empty paste without resolving', async () => {
    const replies: string[] = [];
    const origin = makeOrigin(replies);
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin });
    await authRpc('/auth/url', { nonce: NONCE, url: URL });

    await userPastes(origin, '   '); // whitespace only
    expect(replies).toHaveLength(2); // initial prompt + re-prompt
    expect(replies[1].toLowerCase()).toContain('empty');

    const codeP = authRpc('/auth/code', { nonce: NONCE }) as Promise<AuthCodeResult>;
    await userPastes(origin, 'REAL-CODE');
    expect(await codeP).toEqual({ code: 'REAL-CODE' });
  });

  it('opens the user prompt only once for a duplicate /auth/url', async () => {
    const replies: string[] = [];
    const origin = makeOrigin(replies);
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin });

    await authRpc('/auth/url', { nonce: NONCE, url: URL });
    await authRpc('/auth/url', { nonce: NONCE, url: URL });
    expect(replies).toHaveLength(1);
  });

  it('rejects a nonce mismatch', async () => {
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin: makeOrigin([]) });
    await expect(authRpc('/auth/url', { nonce: 'WRONG', url: URL })).rejects.toThrow('no-active-auth-episode');
  });

  it('rejects when no episode is in-flight for the caller scope (agent container probing)', async () => {
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin: makeOrigin([]) });
    // A different container scope (e.g. the agent session container) sharing
    // no episode — rejected even with a guessed nonce.
    await expect(authRpc('/auth/code', { nonce: NONCE }, OTHER_SCOPE)).rejects.toThrow('no-active-auth-episode');
  });

  it('end() unblocks a pending code poll as cancelled', async () => {
    const handle = startAuthEpisode({ scopeFolder: 'test-agent', nonce: NONCE, origin: makeOrigin([]) });
    const codeP = authRpc('/auth/code', { nonce: NONCE }) as Promise<AuthCodeResult>;
    handle.end();
    expect(await codeP).toEqual({ cancelled: true });
  });

  it('replacing an episode cancels the prior one', async () => {
    const first = startAuthEpisode({ scopeFolder: 'test-agent', nonce: 'n1', origin: makeOrigin([]) });
    const firstPoll = authRpc('/auth/code', { nonce: 'n1' }) as Promise<AuthCodeResult>;
    startAuthEpisode({ scopeFolder: 'test-agent', nonce: 'n2', origin: makeOrigin([]) });
    expect(await firstPoll).toEqual({ cancelled: true });
    // The stale handle's end() is a no-op (already replaced).
    expect(() => first.end()).not.toThrow();
  });
});
