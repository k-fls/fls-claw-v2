/**
 * Unit tests for pastePlain. The helper is pure composition over
 * ctx.beginInteraction — we stub the context and drive its captured
 * handler manually to simulate user replies and the A1a timeout.
 */
import { describe, expect, it } from 'vitest';

import type { HostCommandContext } from '../../command-gate.js';
import type { BeginInteractionOptions, HostInteractionContext } from '../../host-interactions.js';
import { pastePlain } from './paste-plain.js';

interface MockCtxBundle {
  ctx: HostCommandContext;
  /** Captured opts from the last ctx.beginInteraction call. */
  get opts(): BeginInteractionOptions;
  /** Fire the handler with a given inbound text. */
  deliver(text: string): Promise<void>;
  /** Trigger the A1a timeout path. */
  timeout(): void;
  /** Replies captured from hctx.finish / hctx.ask / hctx.cancel. */
  replies: string[];
  /** Lifecycle action chosen by the handler on the most recent delivery. */
  action: 'ask' | 'finish' | 'cancel' | null;
}

function makeCtx(): MockCtxBundle {
  let captured: BeginInteractionOptions | null = null;
  const replies: string[] = [];
  const bundle: Partial<MockCtxBundle> = {
    replies,
    action: null,
  };
  const ctx: HostCommandContext = {
    command: '/test',
    argsRaw: '',
    args: [],
    userId: 'discord:alice',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    scope: 'agent',
    reply: { channelType: 'discord', platformId: 'chan-1', threadId: null },
    replyText: (t) => replies.push(t),
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
      reply: { channelType: 'discord', platformId: 'chan-1', threadId: null },
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
  bundle.timeout = () => {
    const key = {
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: null,
      userId: 'discord:alice',
    };
    bundle.opts!.onTimeout?.(key, ctx.reply);
  };
  return bundle as MockCtxBundle;
}

describe('pastePlain', () => {
  it("resolves with the user's reply and finishes the slot on submit", async () => {
    const bundle = makeCtx();
    const promise = pastePlain({ ctx: bundle.ctx, prompt: 'paste it' });
    expect(bundle.opts.initialPrompt).toBe('paste it');

    await bundle.deliver('   here is my key   ');
    const result = await promise;

    expect(result).toEqual({ text: '   here is my key   ', reason: 'submitted' });
    expect(bundle.action).toBe('finish');
  });

  it('resolves with text=null reason=cancelled on a cancel keyword', async () => {
    const bundle = makeCtx();
    const promise = pastePlain({ ctx: bundle.ctx, prompt: 'paste it' });
    await bundle.deliver('cancel');
    const result = await promise;
    expect(result).toEqual({ text: null, reason: 'cancelled' });
    expect(bundle.action).toBe('finish');
  });

  it('cancel matching is case-insensitive and ignores surrounding whitespace', async () => {
    const bundle = makeCtx();
    const promise = pastePlain({ ctx: bundle.ctx, prompt: 'paste it' });
    await bundle.deliver('  /CANCEL  ');
    expect(await promise).toEqual({ text: null, reason: 'cancelled' });
  });

  it('honours a custom cancelKeywords list', async () => {
    const bundle = makeCtx();
    const promise = pastePlain({
      ctx: bundle.ctx,
      prompt: 'paste',
      cancelKeywords: ['abort'],
    });
    await bundle.deliver('cancel'); // not in custom list
    expect(await promise).toEqual({ text: 'cancel', reason: 'submitted' });
  });

  it('resolves with reason=timeout when A1a fires onTimeout', async () => {
    const bundle = makeCtx();
    const promise = pastePlain({ ctx: bundle.ctx, prompt: 'paste it' });
    bundle.timeout();
    expect(await promise).toEqual({ text: null, reason: 'timeout' });
  });

  it('passes timeoutMs through to beginInteraction', async () => {
    const bundle = makeCtx();
    void pastePlain({ ctx: bundle.ctx, prompt: 'p', timeoutMs: 500 });
    expect(bundle.opts.timeoutMs).toBe(500);
  });

  it('validator rejection keeps the slot open and re-prompts; eventual valid input resolves', async () => {
    const bundle = makeCtx();
    const validate = (t: string) => (t.length < 5 ? 'too short, try again' : null);
    const promise = pastePlain({ ctx: bundle.ctx, prompt: 'paste', validate });

    await bundle.deliver('hi');
    expect(bundle.action).toBe('ask');
    expect(bundle.replies).toContain('too short, try again');

    await bundle.deliver('hello there');
    expect(bundle.action).toBe('finish');
    expect(await promise).toEqual({ text: 'hello there', reason: 'submitted' });
  });

  it('cancel keyword wins over validator', async () => {
    const bundle = makeCtx();
    const validate = () => 'never accepted';
    const promise = pastePlain({ ctx: bundle.ctx, prompt: 'paste', validate });
    await bundle.deliver('cancel');
    expect(await promise).toEqual({ text: null, reason: 'cancelled' });
  });
});
