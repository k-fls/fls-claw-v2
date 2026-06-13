/**
 * Mid-session reauth dispatcher, exercised through the real delivery path:
 * a container-authored `feedback.container` system row drains via
 * `deliverSessionMessages` → `handleSystemAction` → the dispatcher. Covers
 * classification routing, origin derivation from `messages_in`, the per-row
 * outbound-pause re-check holding the redundant "Error: …" row, in-flight
 * dedup, admin-gating (non-admins are declined, not prompted), and the
 * restart-with-retry continuation.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ paused: false }));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-reauth' };
});

// Real host-interactions except the pause predicate: the mock REAUTH flow
// flips `state.paused` the way a real beginInteractionOn would.
vi.mock('../../host-interactions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../host-interactions.js')>()),
  isOutboundPaused: () => state.paused,
}));

const TEST_DIR = '/tmp/nanoclaw-test-reauth';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { getDeliveredIds } from '../../db/session-db.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { BeginInteractionConflictError } from '../../host-interactions.js';
import { isContainerRunning, killContainer, wakeContainer } from '../../container-runner.js';
import { resolveSession, outboundDbPath, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';

import { registerCredentialProvider, _resetProviderRegistryForTests } from './providers/registry.js';
import { ExtensionBag, CONTAINER_FEEDBACK, type FeedbackAction } from './providers/types.js';
import { REAUTH, type ReauthContext } from './reauth.js';
import { _resetReauthDispatcherForTests, sanitizeReason } from './reauth-dispatcher.js';

function now(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({ id: 'ag-1', name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  // The default inbound sender (senderId '42' → telegram:42) is a group admin,
  // so the reauth prompt is permitted. Non-admin behaviour is covered by a
  // dedicated test that seeds a different sender.
  createUser({ id: 'telegram:42', kind: 'telegram', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'telegram:42', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
}

function makeSession(): Session {
  seedAgentAndChannel();
  const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
  return session;
}

/** Seed an inbound user message so the dispatcher can derive who to prompt. */
function seedInboundChat(session: Session, content: Record<string, unknown> = { text: 'hi', senderId: '42' }): void {
  writeSessionMessage('ag-1', session.id, {
    id: `in-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: now(),
    platformId: 'telegram:123',
    channelType: 'telegram',
    threadId: null,
    content: JSON.stringify(content),
  });
}

let outSeq = 1;
function insertFeedbackRow(session: Session, message = 'API Error: 401', id = `fb-${outSeq}`): void {
  const db = new Database(outboundDbPath('ag-1', session.id));
  db.prepare(`INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'system', ?)`).run(
    id,
    (outSeq += 2),
    now(outSeq),
    JSON.stringify({
      action: 'feedback.container',
      provider: 'claude',
      classification: 'auth-invalid',
      message,
      retryable: false,
    }),
  );
  db.close();
}

/** The user-facing line the poll-loop writes right after the feedback row. */
function insertErrorRow(session: Session, message = 'API Error: 401', id = 'err-1'): void {
  const db = new Database(outboundDbPath('ag-1', session.id));
  db.prepare(
    `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, ?, 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(id, (outSeq += 2), now(outSeq), JSON.stringify({ text: `Error: ${message}` }));
  db.close();
}

function registerProvider(opts: { action?: FeedbackAction; reauth?: (ctx: ReauthContext) => Promise<boolean> }): void {
  const bag = new ExtensionBag().set(CONTAINER_FEEDBACK, {
    onContainerError: () => opts.action ?? 'reauth',
  });
  if (opts.reauth) bag.set(REAUTH, { reauth: opts.reauth });
  registerCredentialProvider({
    id: 'claude',
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    getExtension: bag.get,
  });
}

function recordingAdapter(): string[] {
  const delivered: string[] = [];
  setDeliveryAdapter({
    async deliver(_ct, _pid, _tid, _kind, content) {
      delivered.push(content);
      return 'plat-1';
    },
  });
  return delivered;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function inboundRows(session: Session): Array<{ id: string; kind: string; content: string; on_wake: number }> {
  const db = openInboundDb('ag-1', session.id);
  try {
    return db.prepare('SELECT id, kind, content, on_wake FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      content: string;
      on_wake: number;
    }>;
  } finally {
    db.close();
  }
}

function deliveredIds(session: Session): Set<string> {
  const db = openInboundDb('ag-1', session.id);
  try {
    return getDeliveredIds(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  _resetProviderRegistryForTests();
  _resetReauthDispatcherForTests();
  state.paused = false;
  outSeq = 1;
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(killContainer).mockClear();
  vi.mocked(wakeContainer).mockClear();
});

afterEach(() => {
  _resetProviderRegistryForTests();
  _resetReauthDispatcherForTests();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.restoreAllMocks();
});

describe('feedback.container dispatcher — routing', () => {
  it("does nothing on 'surface': no reauth, the Error row delivers", async () => {
    const reauth = vi.fn(async () => true);
    registerProvider({ action: 'surface', reauth });
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session);
    insertErrorRow(session);
    const delivered = recordingAdapter();

    await deliverSessionMessages(session);

    expect(reauth).not.toHaveBeenCalled();
    expect(delivered.some((c) => c.includes('Error: API Error: 401'))).toBe(true);
  });

  it('tolerates malformed feedback content', async () => {
    registerProvider({ action: 'reauth', reauth: vi.fn(async () => true) });
    const session = makeSession();
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(`INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('bad-1', 1, ?, 'system', ?)`).run(
      now(),
      JSON.stringify({ action: 'feedback.container', provider: 42 }),
    );
    db.close();
    recordingAdapter();

    await expect(deliverSessionMessages(session)).resolves.toBeUndefined();
  });

  it('falls back to surface when no user is derivable from messages_in', async () => {
    const reauth = vi.fn(async () => true);
    registerProvider({ action: 'reauth', reauth });
    const session = makeSession();
    // Only a system-authored row — nobody to prompt.
    seedInboundChat(session, { text: 'tick', senderId: 'system' });
    insertFeedbackRow(session);
    insertErrorRow(session);
    const delivered = recordingAdapter();

    await deliverSessionMessages(session);

    expect(reauth).not.toHaveBeenCalled();
    expect(delivered.some((c) => c.includes('Error:'))).toBe(true);
  });
});

describe('feedback.container dispatcher — reauth episode', () => {
  it('derives the origin, holds the Error row, and on success restarts the group with a retry message', async () => {
    const calls: ReauthContext[] = [];
    let resolveFlow!: (stored: boolean) => void;
    registerProvider({
      reauth: (ctx) => {
        calls.push(ctx);
        state.paused = true; // what beginInteractionOn would do
        return new Promise<boolean>((res) => (resolveFlow = res));
      },
    });
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session, 'API Error: 401 {"type":"error"}');
    insertErrorRow(session, 'API Error: 401 {"type":"error"}', 'err-held');
    const delivered = recordingAdapter();

    await deliverSessionMessages(session);

    // Flow launched with the derived origin; the Error row was held by the
    // per-row pause re-check (same drain batch).
    expect(calls).toHaveLength(1);
    expect(calls[0].origin.key).toEqual({
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: null,
      userId: 'telegram:42',
    });
    expect(calls[0].credentialScope).toBe('test-agent');
    expect(calls[0].classification).toBe('auth-invalid');
    expect(calls[0].reason).toContain('401');
    expect(delivered.some((c) => c.includes('Error:'))).toBe(false);

    resolveFlow(true);
    await flush();
    state.paused = false;

    // Error row consumed without ever reaching the adapter.
    expect(deliveredIds(session).has('err-held')).toBe(true);
    // Group restart: kill + on-wake retry instruction.
    expect(vi.mocked(killContainer)).toHaveBeenCalledWith(session.id, 'credential reauth', expect.any(Function));
    const retry = inboundRows(session).find((r) => r.content.includes('re-authenticated'));
    expect(retry).toBeDefined();
    expect(retry?.on_wake).toBe(1);
  });

  it('wakes the session directly when its container was already gone', async () => {
    registerProvider({ reauth: async () => true });
    vi.mocked(isContainerRunning).mockReturnValue(false);
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session);
    recordingAdapter();

    await deliverSessionMessages(session);
    await flush();

    expect(vi.mocked(killContainer)).not.toHaveBeenCalled();
    expect(vi.mocked(wakeContainer)).toHaveBeenCalled();
    const retry = inboundRows(session).find((r) => r.content.includes('re-authenticated'));
    expect(retry?.on_wake).toBe(1);
  });

  it('dedups while in-flight; re-prompts immediately after a failed episode (no cooldown)', async () => {
    const resolvers: Array<(b: boolean) => void> = [];
    const reauth = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolvers.push(res);
        }),
    );
    registerProvider({ reauth });
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session, 'API Error: 401', 'fb-a');
    recordingAdapter();

    await deliverSessionMessages(session);
    expect(reauth).toHaveBeenCalledTimes(1);

    // Second row while the flow is pending → deduped (concurrency guard only).
    insertFeedbackRow(session, 'API Error: 401', 'fb-b');
    await deliverSessionMessages(session);
    expect(reauth).toHaveBeenCalledTimes(1);

    // Flow ends without a credential → no cooldown; the next failing message
    // starts a fresh episode right away (each message is independent).
    resolvers[0](false);
    await flush();
    insertFeedbackRow(session, 'API Error: 401', 'fb-c');
    await deliverSessionMessages(session);
    expect(reauth).toHaveBeenCalledTimes(2);
  });

  it('declines a non-admin requester: no prompt, message not retried, raw error surfaces', async () => {
    const reauth = vi.fn<(ctx: ReauthContext) => Promise<boolean>>().mockResolvedValue(true);
    registerProvider({ reauth });
    const session = makeSession();
    // senderId '99' → telegram:99, who holds no role for the group.
    seedInboundChat(session, { text: 'hi', senderId: '99' });
    insertFeedbackRow(session, 'API Error: 401', 'fb-na');
    insertErrorRow(session, 'API Error: 401', 'err-na');
    const delivered = recordingAdapter();

    await deliverSessionMessages(session);
    await flush();

    expect(reauth).not.toHaveBeenCalled();
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled(); // not retried
    // The container's own error row is NOT suppressed — it delivers as-is.
    expect(delivered.some((c) => c.includes('Error: API Error: 401'))).toBe(true);
  });

  it('suppresses the Error row(s) at launch — no race with the release-kicked poll', async () => {
    registerProvider({ reauth: () => new Promise<boolean>(() => {}) }); // never resolves
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session, 'boom 401', 'fb-s');
    insertErrorRow(session, 'boom 401', 'err-launch');
    insertErrorRow(session, 'boom 401', 'err-launch-2'); // one turn can write several
    recordingAdapter();

    await deliverSessionMessages(session);

    expect(deliveredIds(session).has('err-launch')).toBe(true);
    expect(deliveredIds(session).has('err-launch-2')).toBe(true);
  });

  it('surfaces the error via writeReply when the flow dies without prompting', async () => {
    registerProvider({ reauth: () => Promise.reject(new Error('gpg exploded')) });
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session, 'API Error: 401', 'fb-x');
    insertErrorRow(session, 'API Error: 401', 'err-x');
    const delivered = recordingAdapter();

    await deliverSessionMessages(session);
    await flush();

    // The suppressed row never delivers; the dispatcher surfaces directly.
    expect(deliveredIds(session).has('err-x')).toBe(true);
    expect(delivered.some((c) => c.includes('Error: API Error: 401'))).toBe(true);
  });

  it('starts a fresh episode after a slot-busy conflict', async () => {
    const key = { channelType: 'telegram', platformId: 'telegram:123', threadId: null, userId: 'telegram:42' };
    const reauth = vi
      .fn<(ctx: ReauthContext) => Promise<boolean>>()
      .mockRejectedValueOnce(new BeginInteractionConflictError(key))
      .mockResolvedValue(true);
    registerProvider({ reauth });
    const session = makeSession();
    seedInboundChat(session);
    insertFeedbackRow(session, 'API Error: 401', 'fb-1');
    recordingAdapter();

    await deliverSessionMessages(session);
    await flush();
    expect(reauth).toHaveBeenCalledTimes(1);

    // The conflict just released the slot — the next row starts a fresh episode.
    insertFeedbackRow(session, 'API Error: 401', 'fb-2');
    await deliverSessionMessages(session);
    expect(reauth).toHaveBeenCalledTimes(2);
  });
});

describe('sanitizeReason', () => {
  it('strips markup and control chars and caps the length', () => {
    expect(sanitizeReason('<b>API</b> *Error* 401')).toBe('API Error 401');
    const long = 'x'.repeat(300);
    expect(sanitizeReason(long)).toHaveLength(201); // 200 + ellipsis
    expect(sanitizeReason(long).endsWith('…')).toBe(true);
  });
});
