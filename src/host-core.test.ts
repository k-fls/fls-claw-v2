/**
 * Integration tests for the v2 host core.
 * Tests routing, session creation, message writing, and delivery
 * without spawning actual containers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
} from './db/index.js';
import {
  resolveSession,
  writeSessionMessage,
  writeSessionRouting,
  initSessionFolder,
  sessionDir,
  inboundDbPath,
  outboundDbPath,
} from './session-manager.js';
import { getSession, findSession } from './db/sessions.js';
import { _resetHostCommandsForTesting, registerHostCommand } from './command-gate.js';
import { _resetHostInteractionsForTesting } from './host-interactions.js';
import type { InboundEvent } from './channels/adapter.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host' };
});

function now() {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-host';

beforeEach(() => {
  // Clean test directory
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  _resetHostCommandsForTesting();
  _resetHostInteractionsForTesting();
});

describe('session manager', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  it('should create session folder and both DBs', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'outbox'))).toBe(true);

    // Verify inbound.db
    const inPath = inboundDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(inPath)).toBe(true);
    const inDb = new Database(inPath);
    const inTables = inDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(inTables.map((t) => t.name)).toContain('messages_in');
    expect(inTables.map((t) => t.name)).toContain('delivered');
    inDb.close();

    // Verify outbound.db
    const outPath = outboundDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(outPath)).toBe(true);
    const outDb = new Database(outPath);
    const outTables = outDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    expect(outTables.map((t) => t.name)).toContain('messages_out');
    expect(outTables.map((t) => t.name)).toContain('processing_ack');
    outDb.close();
  });

  it('should resolve to existing session (shared mode)', () => {
    const { session: s1, created: c1 } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(c1).toBe(true);

    const { session: s2, created: c2 } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(c2).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should create separate sessions per thread (per-thread mode)', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2 } = resolveSession('ag-1', 'mg-1', 'thread-2', 'per-thread');
    expect(s1.id).not.toBe(s2.id);
  });

  it('should reuse session for same thread', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2, created } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    expect(created).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should write message to inbound DB', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'chan-123',
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ sender: 'User', text: 'Hello' }),
    });

    // Read from the inbound DB
    const dbPath = inboundDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{
      id: string;
      kind: string;
      status: string;
      content: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('msg-1');
    expect(rows[0].status).toBe('pending');
    expect(JSON.parse(rows[0].content).text).toBe('Hello');
  });

  it('should update last_active on message write', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(getSession(session.id)!.last_active).toBeNull();

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi' }),
    });

    expect(getSession(session.id)!.last_active).not.toBeNull();
  });

  it('should refuse path-traversal in attachment filenames', () => {
    // Regression: attachment.name comes from untrusted senders (E2EE-protected
    // chat platforms can't sanitize it server-side). Without the guard, a
    // `../../../tmp/pwned` filename escapes the inbox dir and writes anywhere
    // the host process can reach.
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inboxBase = path.join(sessionDir('ag-1', session.id), 'inbox');
    const escapeTarget = path.join('/tmp', 'nanoclaw-traversal-canary');
    if (fs.existsSync(escapeTarget)) fs.rmSync(escapeTarget);

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-attack',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'pwn',
        attachments: [
          {
            type: 'document',
            name: '../../../../../../../../tmp/nanoclaw-traversal-canary',
            data: Buffer.from('owned').toString('base64'),
          },
        ],
      }),
    });

    expect(fs.existsSync(escapeTarget)).toBe(false);
    // The bytes should still land — under a synthesized safe name inside the
    // inbox — so the agent doesn't lose data on a malicious filename.
    const inboxDir = path.join(inboxBase, 'msg-attack');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const written = fs.readdirSync(inboxDir);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('/');
    expect(written[0]).not.toContain('..');
  });
});

describe('router', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    // Use 'public' policy so the router tests exercise routing, not the
    // access gate. Dedicated access-gate tests live with the access module.
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('should route a message end-to-end', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hello agent!' }),
        timestamp: now(),
      },
    };

    await routeInbound(event);

    // Verify session was created
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    // Verify message was written to inbound DB
    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello agent!');

    // Verify container was woken
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('auto-creates messaging group only when the bot is addressed (mention/DM)', async () => {
    // The router's no-mg branch is escalation-gated: plain chatter on an
    // unknown channel stays silent (no DB writes) so a bot that sits in
    // many unwired channels doesn't bloat messaging_groups. Only explicit
    // mentions and DMs trigger auto-create.
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // Plain message on unknown channel — should NOT auto-create.
    await routeInbound({
      channelType: 'slack',
      platformId: 'C-PLAIN',
      threadId: null,
      message: {
        id: 'msg-plain',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hi' }),
        timestamp: now(),
      },
    });
    expect(getMessagingGroupByPlatform('slack', 'C-PLAIN')).toBeUndefined();

    // Mention on unknown channel — SHOULD auto-create (next step: channel-registration flow).
    await routeInbound({
      channelType: 'slack',
      platformId: 'C-MENTIONED',
      threadId: null,
      message: {
        id: 'msg-mentioned',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
      },
    });
    expect(getMessagingGroupByPlatform('slack', 'C-MENTIONED')).toBeDefined();
  });

  it('should route multiple messages to the same session', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-a', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'First' }), timestamp: now() },
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-b',
        kind: 'chat',
        content: JSON.stringify({ sender: 'B', text: 'Second' }),
        timestamp: now(),
      },
    });

    // Both should be in the same session
    const session = findSession('mg-1', null);
    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in ORDER BY timestamp').all();
    db.close();

    expect(rows).toHaveLength(2);
  });

  it('fans out to every matching agent, each in its own session', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Wire a second agent to the same messaging group.
    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary Agent',
      folder: 'secondary-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-fan', kind: 'chat', content: JSON.stringify({ text: 'hello all' }), timestamp: now() },
    });

    // Both agents should now have their own session and be woken.
    expect(wakeContainer).toHaveBeenCalledTimes(2);

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    expect(getSessionsByAgentGroup('ag-1')).toHaveLength(1);
    expect(getSessionsByAgentGroup('ag-2')).toHaveLength(1);
  });

  it('accumulates without waking when engage fails + ignored_message_policy=accumulate', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Replace the seed row with a mention-only wiring whose accumulate
    // policy should store context even when the message doesn't mention us.
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', {
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-nomatch',
        kind: 'chat',
        content: JSON.stringify({ text: 'no mention here' }),
        timestamp: now(),
      },
    });

    expect(wakeContainer).not.toHaveBeenCalled();

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id, trigger FROM messages_in').all() as Array<{
      id: string;
      trigger: number;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(0);
  });

  it('dispatches host-registered commands without writing inbound or waking container', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { setDeliveryAdapter } = await import('./delivery.js');
    setSenderResolver(() => 'user-host-cmd');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const delivered: string[] = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _k, content) => {
        delivered.push(JSON.parse(content).text);
        return undefined;
      },
    });

    const seen: Array<{ args: string[] }> = [];
    registerHostCommand('/a1-router-test', (ctx) => {
      seen.push({ args: ctx.args });
      ctx.replyText('ok');
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-host-cmd',
        kind: 'chat',
        content: JSON.stringify({ text: '/a1-router-test foo bar' }),
        timestamp: now(),
      },
    });

    // Handler ran with parsed args
    expect(seen).toHaveLength(1);
    expect(seen[0].args).toEqual(['foo', 'bar']);

    // Container was not woken
    expect(wakeContainer).not.toHaveBeenCalled();

    // Session got no inbound row
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const inDb = new Database(inboundDbPath('ag-1', session!.id));
    const inRows = inDb.prepare('SELECT id FROM messages_in').all();
    inDb.close();
    expect(inRows).toHaveLength(0);

    // Reply went straight to the adapter (NOT to messages_out).
    await new Promise((res) => setImmediate(res));
    expect(delivered).toEqual(['ok']);
    const outDb = new Database(outboundDbPath('ag-1', session!.id));
    const outRows = outDb.prepare('SELECT id FROM messages_out').all();
    outDb.close();
    expect(outRows).toHaveLength(0);
  });

  it('agent-scope host command dispatches per engaging agent in a multi-agent channel', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    setSenderResolver(() => 'user-multi-agent');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Wire a second agent (alongside beforeEach-seeded ag-1 / mga-1).
    // Both engage on every message (pattern='.').
    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary',
      folder: 'secondary',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const seenAgents: Array<string | null> = [];
    // Default scope = agent.
    registerHostCommand('/a1-multi-agent', (ctx) => {
      seenAgents.push(ctx.agentGroupId);
      ctx.replyText('ok');
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-multi-agent',
        kind: 'chat',
        content: JSON.stringify({ text: '/a1-multi-agent' }),
        timestamp: now(),
      },
    });

    // Handler ran once per engaging agent, with each agent's id in context.
    expect(seenAgents.sort()).toEqual(['ag-1', 'ag-2']);

    // Neither container was woken (host command dispatch skips wake).
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('agent-scope host command dispatches only for engaging agents', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    setSenderResolver(() => 'user-engage-filter');

    // Wire a second agent that only engages on a different prefix.
    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary',
      folder: 'secondary',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      // Pattern that won't match "/a1-engage-test"
      engage_pattern: '^@second\\b',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const seenAgents: Array<string | null> = [];
    registerHostCommand('/a1-engage-test', (ctx) => {
      seenAgents.push(ctx.agentGroupId);
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-engage-filter',
        kind: 'chat',
        content: JSON.stringify({ text: '/a1-engage-test' }),
        timestamp: now(),
      },
    });

    // Only ag-1 (pattern='.' from beforeEach) engages.
    expect(seenAgents).toEqual(['ag-1']);
  });

  it('channel-scope host command dispatches exactly once in a multi-agent channel', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { setDeliveryAdapter } = await import('./delivery.js');
    setSenderResolver(() => 'user-multi-channel');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const delivered: string[] = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _k, content) => {
        delivered.push(JSON.parse(content).text);
        return undefined;
      },
    });

    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary',
      folder: 'secondary',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    let calls = 0;
    let observedAgentGroupId: string | null | undefined;
    registerHostCommand(
      '/a1-multi-channel',
      (ctx) => {
        calls++;
        observedAgentGroupId = ctx.agentGroupId;
        ctx.replyText('ok');
      },
      { scope: 'channel' },
    );

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-multi-channel',
        kind: 'chat',
        content: JSON.stringify({ text: '/a1-multi-channel' }),
        timestamp: now(),
      },
    });

    expect(calls).toBe(1);
    expect(observedAgentGroupId).toBeNull();
    expect(wakeContainer).not.toHaveBeenCalled();

    // Exactly one reply was sent to the adapter; nothing in messages_out.
    await new Promise((res) => setImmediate(res));
    expect(delivered).toEqual(['ok']);
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const allSessions = [...getSessionsByAgentGroup('ag-1'), ...getSessionsByAgentGroup('ag-2')];
    const totalOutboundRows = allSessions
      .map((s) => {
        const p = outboundDbPath(s.agent_group_id, s.id);
        if (!fs.existsSync(p)) return 0;
        const db = new Database(p);
        const rows = db.prepare('SELECT id FROM messages_out').all();
        db.close();
        return rows.length;
      })
      .reduce((a, b) => a + b, 0);
    expect(totalOutboundRows).toBe(0);
  });

  it('host command handler that throws produces a generic reply and does not crash', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    const { setDeliveryAdapter } = await import('./delivery.js');
    setSenderResolver(() => 'user-host-throw');

    const delivered: string[] = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _k, content) => {
        delivered.push(JSON.parse(content).text);
        return undefined;
      },
    });

    registerHostCommand('/a1-router-throw', () => {
      throw new Error('boom — internal detail');
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-host-throw',
        kind: 'chat',
        content: JSON.stringify({ text: '/a1-router-throw' }),
        timestamp: now(),
      },
    });

    await new Promise((res) => setImmediate(res));
    expect(delivered).toEqual(['Command failed.']);
    expect(delivered[0]).not.toMatch(/boom/);
    expect(delivered[0]).not.toMatch(/internal detail/);
  });

  // ── A1a: host interactions ──

  it('host interaction consumes the next inbound; container is not woken; nothing in messages_in or messages_out', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { setDeliveryAdapter } = await import('./delivery.js');
    setSenderResolver(() => 'user-int-1');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const delivered: string[] = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _k, content) => {
        delivered.push(JSON.parse(content).text);
        return undefined;
      },
    });

    const turns: string[] = [];
    registerHostCommand(
      '/a1a-flow',
      (ctx) => {
        ctx.beginInteraction({
          handler: (ictx) => {
            turns.push(ictx.inboundContent);
            ictx.finish('done');
          },
          initialPrompt: 'paste it',
        });
      },
      { scope: 'channel' },
    );

    // Turn 1: the slash command begins the interaction.
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-flow-1', kind: 'chat', content: JSON.stringify({ text: '/a1a-flow' }), timestamp: now() },
    });

    // Turn 2: free-form follow-up. Should land in the interaction, NOT in
    // messages_in, NOT in command-gate, NOT in wakeContainer.
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-flow-2',
        kind: 'chat',
        content: JSON.stringify({ text: 'plain text answer' }),
        timestamp: now(),
      },
    });

    expect(turns).toHaveLength(1);
    expect(JSON.parse(turns[0]).text).toBe('plain text answer');
    expect(wakeContainer).not.toHaveBeenCalled();

    const session = findSession('mg-1', null);
    const inDb = new Database(inboundDbPath('ag-1', session!.id));
    const inRows = inDb.prepare('SELECT id FROM messages_in').all();
    inDb.close();
    expect(inRows).toHaveLength(0);

    // Replies went straight to the adapter; messages_out is empty —
    // interaction traffic is fully ephemeral.
    await new Promise((res) => setImmediate(res));
    expect(delivered).toEqual(['paste it', 'done']);

    const outDb = new Database(outboundDbPath('ag-1', session!.id));
    const outRows = outDb.prepare('SELECT id FROM messages_out').all();
    outDb.close();
    expect(outRows).toHaveLength(0);
  });

  it('after the interaction finishes, the next chat flows normally to the session', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    setSenderResolver(() => 'user-int-resume');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    registerHostCommand(
      '/a1a-resume',
      (ctx) => {
        ctx.beginInteraction({
          handler: (ictx) => ictx.finish('flow-done'),
        });
      },
      { scope: 'channel' },
    );

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'm1', kind: 'chat', content: JSON.stringify({ text: '/a1a-resume' }), timestamp: now() },
    });
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'm2', kind: 'chat', content: JSON.stringify({ text: 'answer' }), timestamp: now() },
    });

    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Now interaction is over — a regular chat should route to the agent.
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'm3', kind: 'chat', content: JSON.stringify({ text: 'hello' }), timestamp: now() },
    });

    expect(wakeContainer).toHaveBeenCalled();
    const session = findSession('mg-1', null);
    const inDb = new Database(inboundDbPath('ag-1', session!.id));
    const inRows = inDb.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
    inDb.close();
    expect(inRows).toHaveLength(1);
    expect(JSON.parse(inRows[0].content).text).toBe('hello');
  });

  it('outbound suppression: a container row is paused while a flow is active and drains after finish', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    setSenderResolver(() => 'user-pause');

    const { deliverSessionMessages, setDeliveryAdapter } = await import('./delivery.js');
    const delivered: string[] = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _k, content) => {
        delivered.push(JSON.parse(content).text);
        return undefined;
      },
    });

    let inboundResolver: ((value?: void) => void) | null = null;
    registerHostCommand(
      '/a1a-pause',
      (ctx) => {
        ctx.beginInteraction({
          handler: (ictx) =>
            new Promise<void>((res) => {
              inboundResolver = () => {
                ictx.finish('flow-end');
                res();
              };
            }),
          initialPrompt: 'waiting',
        });
      },
      { scope: 'channel' },
    );

    // Begin the interaction.
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'mp1', kind: 'chat', content: JSON.stringify({ text: '/a1a-pause' }), timestamp: now() },
    });

    // The interaction's initialPrompt went straight to the adapter; it
    // never entered messages_out and the pause never applied to it.
    await new Promise((res) => setImmediate(res));
    expect(delivered).toEqual(['waiting']);

    const session = findSession('mg-1', null)!;

    // Simulate the container writing a chat message to messages_out while
    // the flow is active. This is the traffic the pause is for.
    const Database2 = (await import('better-sqlite3')).default;
    const outPath = outboundDbPath('ag-1', session.id);
    const wdb = new Database2(outPath);
    wdb.pragma('journal_mode = DELETE');
    wdb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages_out), datetime('now'), 'chat', 'chan-123', 'discord', NULL, ?)`,
      )
      .run('agent-chat-1', JSON.stringify({ text: 'from container' }));
    wdb.close();

    // Drain while paused: container row stays in messages_out, adapter
    // does NOT see 'from container'.
    await deliverSessionMessages(session);
    expect(delivered).toEqual(['waiting']);
    const peekDb = new Database(outPath);
    const stillThere = peekDb.prepare('SELECT id FROM messages_out WHERE id = ?').get('agent-chat-1');
    peekDb.close();
    expect(stillThere).toBeDefined();

    // Send the user's reply; the handler's promise resolves via inboundResolver
    // and the slot finishes.
    const replyPromise = routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'mp2', kind: 'chat', content: JSON.stringify({ text: 'reply' }), timestamp: now() },
    });
    while (inboundResolver === null) await new Promise((res) => setImmediate(res));
    (inboundResolver as () => void)();
    await replyPromise;
    await new Promise((res) => setImmediate(res));

    // finish('flow-end') took the direct-adapter path immediately.
    expect(delivered).toContain('flow-end');

    // Drain once more — the previously-paused container row now flows
    // through (the slot is gone, the pause predicate returns false).
    await deliverSessionMessages(session);
    expect(delivered).toContain('from container');
  });

  it('beginInteraction conflict throws and the original handler error reply is sent', async () => {
    const { routeInbound, setSenderResolver } = await import('./router.js');
    setSenderResolver(() => 'user-conflict');

    let calls = 0;
    registerHostCommand(
      '/a1a-conflict',
      (ctx) => {
        calls++;
        ctx.beginInteraction({ handler: (ictx) => ictx.finish() });
      },
      { scope: 'channel' },
    );

    // First call: begins the slot.
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'c1', kind: 'chat', content: JSON.stringify({ text: '/a1a-conflict' }), timestamp: now() },
    });
    // Second call: the slot exists, the handler's beginInteraction throws,
    // dispatchHostCommand's catch converts to "Command failed." reply.
    // BUT — the second slash command is ALSO consumed by the active
    // interaction (which calls finish() on it), so the host command
    // handler is never invoked again. calls remains 1.
    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'c2', kind: 'chat', content: JSON.stringify({ text: '/a1a-conflict' }), timestamp: now() },
    });
    expect(calls).toBe(1);
  });

  it('drops silently when engage fails + ignored_message_policy=drop', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', { engage_mode: 'mention' }); // drop is the default

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-drop', kind: 'chat', content: JSON.stringify({ text: 'ignored' }), timestamp: now() },
    });

    expect(wakeContainer).not.toHaveBeenCalled();
    // No session should have been created for this agent.
    expect(findSession('mg-1', null)).toBeUndefined();
  });
});

describe('router — channel instances', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Default Bot',
      folder: 'default-bot',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-2',
      name: 'Tester Bot',
      folder: 'tester-bot',
      agent_provider: null,
      created_at: now(),
    });
    // Two messaging groups on the SAME (channel_type, platform_id), owned
    // by different adapter instances and wired to different agents.
    createMessagingGroup({
      id: 'mg-default',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      name: 'Default chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-tester',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      instance: 'slack-tester',
      name: 'Tester chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    for (const [mgaId, mgId, agId] of [
      ['mga-default', 'mg-default', 'ag-1'],
      ['mga-tester', 'mg-tester', 'ag-2'],
    ] as const) {
      createMessagingGroupAgent({
        id: mgaId,
        messaging_group_id: mgId,
        agent_group_id: agId,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now(),
      });
    }
  });

  it('routes by receiving instance: named instance lands in its own mg/agent, default in the default', async () => {
    const { routeInbound } = await import('./router.js');
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
      await import('./channels/channel-registry.js');
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');

    // Default 'slack' adapter is THREADED; the named instance is NOT.
    // The same arm therefore also pins the thread-policy lookup at the
    // receiving instance: if the router resolved the adapter by
    // channelType, the tester event's threadId would survive.
    const makeAdapter = (instance: string | undefined, supportsThreads: boolean) => ({
      name: instance ?? 'slack',
      channelType: 'slack',
      instance,
      supportsThreads,
      async setup() {},
      async teardown() {},
      isConnected: () => true,
      async deliver() {
        return undefined;
      },
    });
    registerChannelAdapter('slack', { factory: () => makeAdapter(undefined, true) });
    registerChannelAdapter('slack-tester', { factory: () => makeAdapter('slack-tester', false) });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    try {
      // Inbound on the named instance, with a threadId the non-threaded
      // adapter must collapse.
      await routeInbound({
        channelType: 'slack',
        instance: 'slack-tester',
        platformId: 'slack:C1',
        threadId: 'thread-9',
        message: {
          id: 'msg-tester',
          kind: 'chat',
          content: JSON.stringify({ sender: 'U', text: 'to tester' }),
          timestamp: now(),
        },
      });

      const testerSessions = getSessionsByAgentGroup('ag-2');
      expect(testerSessions).toHaveLength(1);
      expect(testerSessions[0].messaging_group_id).toBe('mg-tester');
      expect(getSessionsByAgentGroup('ag-1')).toHaveLength(0);

      const tDb = new Database(inboundDbPath('ag-2', testerSessions[0].id));
      const tRow = tDb.prepare('SELECT thread_id, content FROM messages_in').get() as {
        thread_id: string | null;
        content: string;
      };
      tDb.close();
      expect(JSON.parse(tRow.content).text).toBe('to tester');
      // Collapsed by the named instance's thread policy.
      expect(tRow.thread_id).toBeNull();

      // Same address, no instance ⇒ default instance ⇒ default mg/agent,
      // and the default adapter is threaded so the threadId survives.
      await routeInbound({
        channelType: 'slack',
        platformId: 'slack:C1',
        threadId: 'thread-9',
        message: {
          id: 'msg-default',
          kind: 'chat',
          content: JSON.stringify({ sender: 'U', text: 'to default' }),
          timestamp: now(),
        },
      });

      const defaultSessions = getSessionsByAgentGroup('ag-1');
      expect(defaultSessions).toHaveLength(1);
      expect(defaultSessions[0].messaging_group_id).toBe('mg-default');
      const dDb = new Database(inboundDbPath('ag-1', defaultSessions[0].id));
      const dRow = dDb.prepare('SELECT thread_id FROM messages_in').get() as { thread_id: string | null };
      dDb.close();
      expect(dRow.thread_id).toBe('thread-9');
    } finally {
      await teardownChannelAdapters();
    }
  });

  it('auto-create persists the receiving instance instead of hijacking the default row', async () => {
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // No row exists for this address on ANY instance yet; create an
    // unwired default row to prove the named event doesn't reuse it.
    createMessagingGroup({
      id: 'mg-plain',
      channel_type: 'slack',
      platform_id: 'slack:C-NEW',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    await routeInbound({
      channelType: 'slack',
      instance: 'slack-tester',
      platformId: 'slack:C-NEW',
      threadId: null,
      message: {
        id: 'msg-mention',
        kind: 'chat',
        content: JSON.stringify({ sender: 'U', text: '@tester hi' }),
        timestamp: now(),
        isMention: true,
      },
    });

    const created = getMessagingGroupByPlatform('slack', 'slack:C-NEW', 'slack-tester');
    expect(created).toBeDefined();
    expect(created!.instance).toBe('slack-tester');
    expect(created!.id).not.toBe('mg-plain');
    // The default row is untouched.
    expect(getMessagingGroupByPlatform('slack', 'slack:C-NEW', 'slack')!.id).toBe('mg-plain');
  });
});

describe('routing metadata preservation', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('routed message carries platformId, channelType, threadId on the messages_in row', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: 'thread-42',
      message: { id: 'msg-r1', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'hi' }), timestamp: now() },
    });

    const session = findSession('mg-1', null);
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const row = db
      .prepare('SELECT platform_id, channel_type, thread_id FROM messages_in WHERE id LIKE ?')
      .get('msg-r1%') as {
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
    };
    db.close();

    expect(row.platform_id).toBe('chan-123');
    expect(row.channel_type).toBe('discord');
    expect(row.thread_id).toBe('thread-42');
  });

  it('fan-out gives each agent its own routing, not leaked from sibling', async () => {
    const { routeInbound } = await import('./router.js');

    createAgentGroup({
      id: 'ag-2',
      name: 'Agent Two',
      folder: 'agent-two',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: 'thread-fanout',
      message: { id: 'msg-fo', kind: 'chat', content: JSON.stringify({ text: 'fan' }), timestamp: now() },
    });

    // Both agents should have the message with correct routing
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    for (const agId of ['ag-1', 'ag-2']) {
      const sessions = getSessionsByAgentGroup(agId);
      expect(sessions).toHaveLength(1);
      const db = new Database(inboundDbPath(agId, sessions[0].id));
      const row = db.prepare('SELECT platform_id, channel_type, thread_id FROM messages_in LIMIT 1').get() as {
        platform_id: string | null;
        channel_type: string | null;
        thread_id: string | null;
      };
      db.close();
      expect(row.platform_id).toBe('chan-123');
      expect(row.channel_type).toBe('discord');
      expect(row.thread_id).toBe('thread-fanout');
    }
  });
});

describe('writeSessionRouting', () => {
  it('populates session_routing from the messaging group', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'tg:12345',
      name: 'Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('telegram');
    expect(row!.platform_id).toBe('tg:12345');
    expect(row!.thread_id).toBeNull();
  });

  it('writes null routing for agent-shared session (no messaging group)', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBeNull();
    expect(row!.platform_id).toBeNull();
    expect(row!.thread_id).toBeNull();
  });

  it('includes thread_id from per-thread session', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', 'thread-77', 'per-thread');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('discord');
    expect(row!.platform_id).toBe('chan-123');
    expect(row!.thread_id).toBe('thread-77');
  });
});

describe('agent-shared session resolution', () => {
  it('resolves to the same session on repeated calls', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session: s1, created: c1 } = resolveSession('ag-1', null, null, 'agent-shared');
    const { session: s2, created: c2 } = resolveSession('ag-1', null, null, 'agent-shared');

    expect(c1).toBe(true);
    expect(c2).toBe(false);
    expect(s1.id).toBe(s2.id);
  });

  it('agent-shared session has null messaging_group_id', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    expect(session.messaging_group_id).toBeNull();
  });
});

describe('agent-to-agent routing', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-pa',
      name: 'PA',
      folder: 'pa-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-slack',
      channel_type: 'slack',
      platform_id: 'C-GENERAL',
      name: 'Slack General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-researcher',
      name: 'Researcher',
      folder: 'researcher-agent',
      agent_provider: null,
      created_at: now(),
    });

    // Wire bidirectional A2A destinations (table created by runMigrations)
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-pa', 'researcher', 'agent', 'ag-researcher', ?)`,
    ).run(now());
    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-researcher', 'pa', 'agent', 'ag-pa', ?)`,
    ).run(now());
  });

  it('A2A outbound lands in a session for the target agent', async () => {
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSlackSession } = resolveSession('ag-pa', 'mg-slack', null, 'shared');

    await routeAgentMessage(
      {
        id: 'out-a2a-1',
        platform_id: 'ag-researcher',
        content: JSON.stringify({ text: 'research this' }),
        in_reply_to: null,
      },
      paSlackSession,
    );

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSessions = getSessionsByAgentGroup('ag-researcher');
    expect(researcherSessions.length).toBeGreaterThanOrEqual(1);

    const rDb = new Database(inboundDbPath('ag-researcher', researcherSessions[0].id));
    const rows = rDb.prepare('SELECT platform_id, channel_type, content FROM messages_in').all() as Array<{
      platform_id: string | null;
      channel_type: string | null;
      content: string;
    }>;
    rDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('agent');
    expect(rows[0].platform_id).toBe('ag-pa');
    expect(JSON.parse(rows[0].content).text).toBe('research this');
  });

  it('A2A return path routes to originating session, not newest (#2332)', async () => {
    // PA has Slack session, then gets wired to Discord (newer session).
    // Researcher responds to PA. With the return-path fix, the reply
    // routes back to the Slack session (originator) not Discord (newest).
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSlackSession } = resolveSession('ag-pa', 'mg-slack', null, 'shared');

    createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'chan-discord',
      name: 'Discord',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session: paDiscordSession } = resolveSession('ag-pa', 'mg-discord', null, 'shared');

    // PA sends from Slack
    await routeAgentMessage(
      { id: 'out-fwd', platform_id: 'ag-researcher', content: JSON.stringify({ text: 'research' }), in_reply_to: null },
      paSlackSession,
    );

    // Researcher responds back to PA
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSession = getSessionsByAgentGroup('ag-researcher')[0];

    await routeAgentMessage(
      { id: 'out-reply', platform_id: 'ag-pa', content: JSON.stringify({ text: 'found it' }), in_reply_to: null },
      researcherSession,
    );

    const slackDb = new Database(inboundDbPath('ag-pa', paSlackSession.id));
    const slackA2a = slackDb.prepare("SELECT * FROM messages_in WHERE channel_type = 'agent'").all();
    slackDb.close();

    const discordDb = new Database(inboundDbPath('ag-pa', paDiscordSession.id));
    const discordA2a = discordDb.prepare("SELECT * FROM messages_in WHERE channel_type = 'agent'").all();
    discordDb.close();

    // Fixed: response lands in Slack (origin) not Discord (newest)
    expect(slackA2a).toHaveLength(1);
    expect(discordA2a).toHaveLength(0);
  });

  it('BUG: A2A-only session gets null session_routing (#2332)', async () => {
    // Researcher only has an agent-shared session (no channel wiring).
    // writeSessionRouting writes nulls because messaging_group_id is null.
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSession } = resolveSession('ag-pa', 'mg-slack', null, 'shared');
    await routeAgentMessage(
      { id: 'out-1', platform_id: 'ag-researcher', content: JSON.stringify({ text: 'go' }), in_reply_to: null },
      paSession,
    );

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSessions = getSessionsByAgentGroup('ag-researcher');
    expect(researcherSessions).toHaveLength(1);

    writeSessionRouting('ag-researcher', researcherSessions[0].id);

    const rDb = new Database(inboundDbPath('ag-researcher', researcherSessions[0].id));
    const routing = rDb.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
        }
      | undefined;
    rDb.close();

    // BUG: session_routing is all null — researcher has no default routing
    expect(routing).toBeDefined();
    expect(routing!.channel_type).toBeNull();
    expect(routing!.platform_id).toBeNull();
  });
});

describe('delivery', () => {
  it('should detect undelivered messages in outbound DB', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-test',
      channel_type: 'discord',
      platform_id: 'chan-test',
      name: 'Test',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-test', null, 'shared');

    // Write a response to the outbound DB (simulating what the agent-runner does)
    const dbPath = outboundDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-1', datetime('now'), 'chat', 'chan-123', 'discord', ?)`,
    ).run(JSON.stringify({ text: 'Agent response' }));

    const undelivered = db.prepare('SELECT * FROM messages_out').all() as Array<{
      id: string;
      content: string;
    }>;
    db.close();

    expect(undelivered).toHaveLength(1);
    expect(JSON.parse(undelivered[0].content).text).toBe('Agent response');
  });
});
