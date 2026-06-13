import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';

import { InteractionStatusRegistry } from './registry.js';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Create a mock ServerResponse that captures written data. */
function mockResponse(): {
  res: import('http').ServerResponse;
  chunks: string[];
  headArgs: unknown[];
  ended: boolean;
} {
  const chunks: string[] = [];
  let headArgs: unknown[] = [];
  let ended = false;
  const stream = new PassThrough();
  const res = Object.assign(stream, {
    writeHead: vi.fn((...args: unknown[]) => {
      headArgs = args;
      return res;
    }),
    headersSent: false,
    end: vi.fn((data?: string) => {
      if (data) chunks.push(data);
      ended = true;
    }),
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
  }) as unknown as import('http').ServerResponse;
  return {
    res,
    chunks,
    headArgs,
    get ended() {
      return ended;
    },
  };
}

describe('InteractionStatusRegistry', () => {
  it('emits and tracks events', () => {
    const reg = new InteractionStatusRegistry();
    reg.emit('github:12345', 'notification', 'queued', 'new event');
    reg.emit('github:12345', 'notification', 'active', 'presenting to user');

    expect(reg.currentState('github:12345')).toBe('active');
    expect(reg.events('github:12345')).toHaveLength(2);
    expect(reg.events('github:12345')[0].state).toBe('queued');
    expect(reg.events('github:12345')[1].state).toBe('active');
  });

  it('returns null for unknown interactions', () => {
    const reg = new InteractionStatusRegistry();
    expect(reg.currentState('nonexistent')).toBeNull();
    expect(reg.events('nonexistent')).toEqual([]);
  });

  it('tracks multiple interactions independently', () => {
    const reg = new InteractionStatusRegistry();
    reg.emit('github:1', 'notification', 'queued', 'test');
    reg.emit('google:1', 'notification', 'queued', 'test');
    reg.emit('github:1', 'notification', 'completed', 'done');

    expect(reg.currentState('github:1')).toBe('completed');
    expect(reg.currentState('google:1')).toBe('queued');
  });

  it('listInteractions returns all interactions with current state', () => {
    const reg = new InteractionStatusRegistry();
    reg.emit('github:1', 'notification', 'queued', 'test');
    reg.emit('google:1', 'notification', 'active', 'test');

    const interactions = reg.listInteractions();
    expect(interactions).toHaveLength(2);

    const github = interactions.find((i) => i.interactionId === 'github:1');
    const google = interactions.find((i) => i.interactionId === 'google:1');
    expect(github).toEqual({
      interactionId: 'github:1',
      state: 'queued',
      eventType: 'notification',
    });
    expect(google).toEqual({
      interactionId: 'google:1',
      state: 'active',
      eventType: 'notification',
    });
  });

  it('events include timestamps', () => {
    const reg = new InteractionStatusRegistry();
    const before = Date.now();
    reg.emit('i1', 'notification', 'queued', 'test');
    const after = Date.now();

    const events = reg.events('i1');
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('destroy clears all state', () => {
    const reg = new InteractionStatusRegistry();
    reg.emit('i1', 'notification', 'queued', 'test');
    reg.destroy();
    expect(reg.listInteractions()).toEqual([]);
  });

  // ── handleSSE ─────────────────────────────────────────────────

  describe('handleSSE', () => {
    it('writes SSE headers', () => {
      const reg = new InteractionStatusRegistry();
      const { res } = mockResponse();
      reg.handleSSE('int-1', {} as import('http').IncomingMessage, res);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
    });

    it('replays existing events on connect', () => {
      const reg = new InteractionStatusRegistry();
      reg.emit('int-1', 'notification', 'queued', 'queued by proxy');
      reg.emit('int-1', 'notification', 'active', 'presenting');

      const { res, chunks } = mockResponse();
      reg.handleSSE('int-1', {} as import('http').IncomingMessage, res);

      const eventLines = chunks.filter((c) => c.includes('event:'));
      expect(eventLines).toHaveLength(2);
      expect(eventLines[0]).toContain('event: queued');
      expect(eventLines[1]).toContain('event: active');
    });

    it('streams live events to subscribers', () => {
      const reg = new InteractionStatusRegistry();
      const { res, chunks } = mockResponse();

      reg.handleSSE('int-2', {} as import('http').IncomingMessage, res);
      reg.emit('int-2', 'notification', 'queued', 'test');

      const eventLines = chunks.filter((c) => c.includes('event: queued'));
      expect(eventLines).toHaveLength(1);
    });

    it('creates state for unknown interactionId', () => {
      const reg = new InteractionStatusRegistry();
      const { res } = mockResponse();
      reg.handleSSE('new-int', {} as import('http').IncomingMessage, res);
      expect(reg.currentState('new-int')).toBeNull();
    });
  });

  // ── handleListInteractions ────────────────────────────────────

  describe('handleListInteractions', () => {
    it('returns JSON array of all interactions', () => {
      const reg = new InteractionStatusRegistry();
      reg.emit('i1', 'notification', 'queued', 'test');
      reg.emit('i2', 'notification', 'completed', 'done');

      const { res, chunks } = mockResponse();
      reg.handleListInteractions({} as import('http').IncomingMessage, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'content-type': 'application/json',
      });
      const body = JSON.parse(chunks[0]);
      expect(body).toHaveLength(2);
      expect(body.find((i: { interactionId: string }) => i.interactionId === 'i1')).toEqual({
        interactionId: 'i1',
        state: 'queued',
        eventType: 'notification',
      });
    });

    it('returns empty array when no interactions exist', () => {
      const reg = new InteractionStatusRegistry();
      const { res, chunks } = mockResponse();
      reg.handleListInteractions({} as import('http').IncomingMessage, res);
      expect(JSON.parse(chunks[0])).toEqual([]);
    });
  });

  // ── destroy with SSE subscribers ──────────────────────────────

  describe('destroy with subscribers', () => {
    it('ends all SSE connections', () => {
      const reg = new InteractionStatusRegistry();
      const { res: res1 } = mockResponse();
      const { res: res2 } = mockResponse();
      reg.handleSSE('int-1', {} as import('http').IncomingMessage, res1);
      reg.handleSSE('int-2', {} as import('http').IncomingMessage, res2);

      reg.destroy();

      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).toHaveBeenCalled();
      expect(reg.listInteractions()).toEqual([]);
    });
  });
});
