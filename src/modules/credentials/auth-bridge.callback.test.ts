/**
 * Browser-flow callback delivery.
 *
 * `codex login` reads no code from stdin — it blocks on its own localhost
 * listener — so the host delivers what the user pasted into the auth container
 * rather than answering the runner's `/auth/code` long-poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Capture the `/auth` handler at registration rather than exporting it.
const rpc = vi.hoisted(() => ({ handler: null as null | ((req: unknown, scope: unknown) => Promise<unknown>) }));
vi.mock('../host-rpc/index.js', () => ({
  registerScopedHostRpc: (_p: string, h: (req: unknown, scope: unknown) => Promise<unknown>) => {
    rpc.handler = h;
  },
}));

const paste = vi.hoisted(() => ({ reply: null as string | null }));
vi.mock('../interactions/index.js', () => ({
  pastePlainOn: async () =>
    paste.reply == null ? { reason: 'cancelled' } : { reason: 'submitted', text: paste.reply },
}));

import type { InteractionOrigin } from '../../host-interactions.js';
import {
  _resetAuthBridgeForTests,
  looksShortened,
  bindAuthEpisodeContainerIP,
  setAuthCallbackDeliverer,
  startAuthEpisode,
} from './auth-bridge.js';

const replies: string[] = [];
function origin(): InteractionOrigin {
  return {
    key: 'k' as unknown as InteractionOrigin['key'],
    agentGroupId: 'ag',
    messagingGroupId: 'mg',
    replyAddr: {} as unknown as InteractionOrigin['replyAddr'],
    writeReply: (t: string) => replies.push(t),
  };
}

const CALLBACK = 'http://localhost:1455/auth/callback?code=abc&state=xyz';

/** Drive an episode to the point where the paste has been handled. */
async function runPaste(pasted: string | null, deliverer: (n: string, p: string, a: string) => Promise<boolean>) {
  paste.reply = pasted;
  setAuthCallbackDeliverer(deliverer);
  startAuthEpisode({ scopeFolder: 'grp', nonce: 'n1', origin: origin(), codeDelivery: 'callback', label: 'Codex' });
  bindAuthEpisodeContainerIP('n1', '10.0.0.5', 'nanoclaw-auth-grp-1');
  await callAuthUrl();
  await new Promise((r) => setTimeout(r, 0));
}

/** Post the CLI's authorize URL the way the container runner does. */
async function callAuthUrl(): Promise<void> {
  await rpc.handler!(
    { path: '/auth/url', body: { nonce: 'n1', url: 'https://auth.openai.com/oauth/authorize' } },
    'grp',
  );
}

beforeEach(() => {
  replies.length = 0;
});
afterEach(() => {
  _resetAuthBridgeForTests();
});

describe('callback delivery', () => {
  it('delivers the pasted callback into the episode container', async () => {
    const deliver = vi.fn(async () => true);

    await runPaste(CALLBACK, deliver);

    expect(deliver).toHaveBeenCalledWith('nanoclaw-auth-grp-1', CALLBACK, expect.stringContaining('authorize'));
  });

  it('tells the user what a callback URL looks like when the paste is not one', async () => {
    await runPaste('not-a-url', async () => false);

    expect(replies.join(' ')).toContain('code=');
  });

  it('delivers nothing when the user cancels', async () => {
    const deliver = vi.fn(async () => true);

    await runPaste(null, deliver);

    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('looksShortened', () => {
  it('recognises the anchor label Slack sends in place of the URL', () => {
    expect(looksShortened('localhost/auth/callback?code=…&scope=openid+profile+email…&…')).toBe(true);
  });

  it('does not flag a real callback', () => {
    expect(looksShortened('http://localhost:1455/auth/callback?code=abc123&state=xyz789')).toBe(false);
  });
});
