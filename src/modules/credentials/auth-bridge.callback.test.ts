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

const paste = vi.hoisted(() => ({
  reply: null as string | null,
  validate: undefined as undefined | ((t: string) => string | null),
}));
vi.mock('../interactions/index.js', () => ({
  pastePlainOn: async (_o: unknown, opts: { validate?: (t: string) => string | null }) => {
    paste.validate = opts.validate;
    return paste.reply == null ? { reason: 'cancelled' } : { reason: 'submitted', text: paste.reply };
  },
}));

import type { InteractionOrigin } from '../../host-interactions.js';
import {
  _resetAuthBridgeForTests,
  looksShortened,
  bindAuthEpisodeContainerIP,
  setAuthCallbackHandler,
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
async function runPaste(pasted: string | null, deliver: (n: string, p: string, a: string) => Promise<boolean>) {
  paste.reply = pasted;
  setAuthCallbackHandler({ isCallback: (t) => /code=[^&…]+/.test(t) && /state=[^&…]+/.test(t), deliver });
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

  it('reports a delivery failure rather than blaming the paste', async () => {
    await runPaste(CALLBACK, async () => false);

    expect(replies.join(' ')).toContain('Could not hand the callback');
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

describe('a paste that is not a callback', () => {
  // The slot re-prompts on a validation failure, so a client-mangled paste can
  // be corrected in place. Ending the episode instead killed the auth container
  // and made a fresh sign-in the only way back — and a corrected paste arriving
  // seconds later had no slot left to land in.
  it('re-prompts instead of ending the sign-in', async () => {
    const deliver = vi.fn(async () => true);
    await runPaste(CALLBACK, deliver);

    const reject = paste.validate!('localhost/auth/callback?code=…&scope=openid+profile+email…&…');

    expect(reject).toContain('shortened link text');
    expect(paste.validate!(CALLBACK)).toBeNull();
  });
});
