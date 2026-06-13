/**
 * Unit tests for pastePgp. Uses the same handler-driver pattern as
 * paste-plain.test.ts and mocks `crypto/gpg` so the test can choose
 * whether decrypt succeeds, fails, or throws. Retry-on-failure is an
 * internal behavior — we exercise it by re-delivering and asserting
 * the slot stayed open (action=ask) until valid input arrives.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../crypto/gpg.js', () => ({
  gpgDecryptAt: vi.fn(),
  isPgpMessage: vi.fn((s: string) => s.includes('-----BEGIN PGP MESSAGE-----')),
  normalizeArmoredBlock: vi.fn((s: string) => s.trim()),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { gpgDecryptAt, isPgpMessage, normalizeArmoredBlock } from '../crypto/gpg.js';
import type { HostCommandContext } from '../../command-gate.js';
import {
  deliverToActiveInteraction,
  _resetHostInteractionsForTesting,
  type BeginInteractionOptions,
  type HostInteractionContext,
  type InteractionOrigin,
} from '../../host-interactions.js';
import { pastePgp, pastePgpOn } from './paste-pgp.js';

interface Bundle {
  ctx: HostCommandContext;
  get opts(): BeginInteractionOptions;
  deliver(text: string): Promise<void>;
  timeout(): void;
  replies: string[];
  action: 'ask' | 'finish' | 'cancel' | null;
}

function makeCtx(): Bundle {
  let captured: BeginInteractionOptions | null = null;
  const replies: string[] = [];
  const bundle: Partial<Bundle> = { replies, action: null };
  const ctx: HostCommandContext = {
    command: '/test',
    argsRaw: '',
    args: [],
    userId: 'discord:alice',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    scope: 'agent',
    reply: { channelType: 'discord', platformId: 'chan-1', threadId: null },
    replyText: () => {},
    beginInteraction: (opts) => {
      captured = opts;
    },
  };
  bundle.ctx = ctx;
  Object.defineProperty(bundle, 'opts', {
    get() {
      if (!captured) throw new Error('beginInteraction was not called');
      return captured;
    },
  });
  bundle.deliver = async (text: string) => {
    let action: 'ask' | 'finish' | 'cancel' | null = null;
    const hctx: HostInteractionContext = {
      key: {
        channelType: 'discord',
        platformId: 'chan-1',
        threadId: null,
        userId: 'discord:alice',
      },
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      reply: ctx.reply,
      inboundContent: JSON.stringify({ text }),
      inboundKind: 'chat',
      ask: (t) => {
        action = 'ask';
        if (t.length > 0) replies.push(t);
      },
      finish: (t) => {
        action = 'finish';
        if (t && t.length > 0) replies.push(t);
      },
      cancel: (t) => {
        action = 'cancel';
        if (t && t.length > 0) replies.push(t);
      },
    };
    await bundle.opts!.handler(hctx);
    bundle.action = action;
  };
  bundle.timeout = () =>
    bundle.opts!.onTimeout?.(
      { channelType: 'discord', platformId: 'chan-1', threadId: null, userId: 'discord:alice' },
      ctx.reply,
    );
  return bundle as Bundle;
}

const ARMORED = '-----BEGIN PGP MESSAGE-----\nblob\n-----END PGP MESSAGE-----';

beforeEach(() => {
  vi.mocked(gpgDecryptAt).mockReset();
  vi.mocked(isPgpMessage).mockImplementation((s: string) => s.includes('-----BEGIN PGP MESSAGE-----'));
  vi.mocked(normalizeArmoredBlock).mockImplementation((s: string) => s.trim());
});

describe('pastePgp', () => {
  it('normalizes the armored block before decrypt and returns cleartext on success', async () => {
    vi.mocked(gpgDecryptAt).mockReturnValue('secret-cleartext');
    const bundle = makeCtx();
    const promise = pastePgp({ ctx: bundle.ctx, prompt: 'paste', gpgHome: '/tmp/gnupg' });

    await bundle.deliver(`  ${ARMORED}  `);
    expect(vi.mocked(normalizeArmoredBlock)).toHaveBeenCalled();
    expect(vi.mocked(gpgDecryptAt)).toHaveBeenCalledWith('/tmp/gnupg', ARMORED);
    expect(bundle.action).toBe('finish');
    expect(await promise).toEqual({ text: 'secret-cleartext', reason: 'submitted' });
  });

  it('non-PGP input is rejected with an ask reply; slot stays open', async () => {
    const bundle = makeCtx();
    void pastePgp({ ctx: bundle.ctx, prompt: 'paste', gpgHome: '/tmp/gnupg' });
    await bundle.deliver('hello world');
    expect(bundle.action).toBe('ask');
    expect(bundle.replies.at(-1)).toMatch(/PGP-encrypted/);
    expect(vi.mocked(gpgDecryptAt)).not.toHaveBeenCalled();
  });

  it('retries internally on decrypt failure, then resolves on a good paste', async () => {
    vi.mocked(gpgDecryptAt)
      .mockImplementationOnce(() => {
        throw new Error('no secret key');
      })
      .mockReturnValueOnce('good-cleartext');
    const bundle = makeCtx();
    const promise = pastePgp({ ctx: bundle.ctx, prompt: 'paste', gpgHome: '/tmp/gnupg' });

    await bundle.deliver(ARMORED);
    expect(bundle.action).toBe('ask');
    expect(bundle.replies.at(-1)).toMatch(/PGP decrypt failed: no secret key/);

    await bundle.deliver(ARMORED);
    expect(bundle.action).toBe('finish');
    expect(await promise).toEqual({ text: 'good-cleartext', reason: 'submitted' });
  });

  it('cancel during retry resolves cancelled', async () => {
    vi.mocked(gpgDecryptAt).mockImplementation(() => {
      throw new Error('boom');
    });
    const bundle = makeCtx();
    const promise = pastePgp({ ctx: bundle.ctx, prompt: 'paste', gpgHome: '/tmp/gnupg' });
    await bundle.deliver(ARMORED);
    expect(bundle.action).toBe('ask');
    await bundle.deliver('cancel');
    expect(await promise).toEqual({ text: null, reason: 'cancelled' });
  });

  it('timeout during retry resolves timeout', async () => {
    vi.mocked(gpgDecryptAt).mockImplementation(() => {
      throw new Error('boom');
    });
    const bundle = makeCtx();
    const promise = pastePgp({ ctx: bundle.ctx, prompt: 'paste', gpgHome: '/tmp/gnupg' });
    await bundle.deliver(ARMORED);
    bundle.timeout();
    expect(await promise).toEqual({ text: null, reason: 'timeout' });
  });

  it('validator rejection re-prompts; eventual valid plaintext resolves', async () => {
    vi.mocked(gpgDecryptAt).mockReturnValueOnce('short').mockReturnValueOnce('long-enough');
    const bundle = makeCtx();
    const promise = pastePgp({
      ctx: bundle.ctx,
      prompt: 'paste',
      gpgHome: '/tmp/gnupg',
      validate: (pt) => (pt.length < 6 ? 'Too short.' : null),
    });

    await bundle.deliver(ARMORED);
    expect(bundle.action).toBe('ask');
    expect(bundle.replies.at(-1)).toMatch(/Too short\./);

    await bundle.deliver(ARMORED);
    expect(await promise).toEqual({ text: 'long-enough', reason: 'submitted' });
  });
});

// pastePgpOn drives the REAL beginInteraction slot (non-command entry); crypto
// is still mocked so we control decrypt without real keys.
describe('pastePgpOn (non-command origin)', () => {
  const key = { channelType: 'cli', platformId: 'local', threadId: null, userId: 'cli:op' };
  let replies: string[];
  function origin(): InteractionOrigin {
    return {
      key,
      agentGroupId: 'ag',
      messagingGroupId: 'mg',
      replyAddr: { channelType: 'cli', platformId: 'local', threadId: null },
      writeReply: (t) => replies.push(t),
    };
  }
  const send = (text: string) => deliverToActiveInteraction(key, JSON.stringify({ text }), 'chat');

  beforeEach(() => {
    replies = [];
    _resetHostInteractionsForTesting();
  });
  afterEach(() => _resetHostInteractionsForTesting());

  it('rejects a non-PGP paste WITHOUT decrypting, then accepts an encrypted block', async () => {
    vi.mocked(gpgDecryptAt).mockReturnValue('sk-ant-api03-ok');
    const p = pastePgpOn(origin(), { prompt: 'encrypt + paste', gpgHome: '/tmp/h', validate: () => null });
    expect(replies).toContain('encrypt + paste');

    await send('sk-ant-api03-PLAINTEXTleak'); // not a PGP block
    expect(vi.mocked(gpgDecryptAt)).not.toHaveBeenCalled(); // never even attempted to decrypt
    expect(replies.at(-1)).toMatch(/PGP-encrypted/);

    await send(ARMORED);
    expect(vi.mocked(gpgDecryptAt)).toHaveBeenCalledWith('/tmp/h', ARMORED);
    expect(await p).toEqual({ text: 'sk-ant-api03-ok', reason: 'submitted' });
  });

  it('resolves cancelled on a cancel keyword', async () => {
    const p = pastePgpOn(origin(), { prompt: 'p', gpgHome: '/tmp/h' });
    await send('cancel');
    expect(await p).toEqual({ text: null, reason: 'cancelled' });
  });
});
