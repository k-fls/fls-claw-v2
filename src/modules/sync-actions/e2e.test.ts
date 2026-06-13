/**
 * Host-stack e2e for the sync-action round-trip + `get_credential`.
 *
 * Exercises the real path **without Docker**: a `fetch` from loopback —
 * registered as the container IP via the network mock — hits the real host-rpc
 * `/action` handler, which resolves the session from the caller IP, reads the
 * sync request row from the real `outbound.db`, dispatches the real
 * `get_credential` action through the real token engine, writes the result to
 * the real `inbound.db`, and returns the row id. The test then reads the result
 * back. Real HTTP + real host-rpc routing + real session-DB files + real
 * registry/engine; only the credential *store* backend (the resolver) is
 * stubbed, since that's orthogonal and unit-tested elsewhere.
 *
 * The cross-container Docker networking + bind-mount visibility leg is covered
 * separately by `src/modules/mitm-proxy/e2e.test.ts` (substitution path).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

let tmpRoot = '';
const TMP_DATA = () => path.join(tmpRoot, 'data');
const TMP_GROUPS = () => path.join(tmpRoot, 'groups');

vi.mock('../../config.js', async () => {
  const real = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...real,
    get DATA_DIR() {
      return TMP_DATA();
    },
    get GROUPS_DIR() {
      return TMP_GROUPS();
    },
  };
});

// network.ts shells to docker at import; stub it so the IP registry hands out
// loopback as the "allocated" container IP — a real fetch from 127.0.0.1 then
// arrives as the registered container.
vi.mock('../container-bootstrap/network.js', () => ({
  allocateIPFromPool: () => '127.0.0.1',
  releaseIPToPool: () => {},
  networkArgs: () => [],
  ensureContainerNetwork: () => {},
}));

import { initDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath, outboundDbPath } from '../../session-manager.js';
import { asContainerScope } from '../container-bootstrap/types.js';
import { allocateContainerIP, __resetRegistryForTests } from '../container-bootstrap/ip-registry.js';
import { startHostRpcServer, stopHostRpcServer } from '../host-rpc/server.js';
import { TokenSubstituteEngine, setTokenEngine, _resetTokenEngineForTests } from '../mitm-proxy/token-substitute.js';
import { registerCredentialProvider, _resetProviderRegistryForTests } from '../credentials/providers/registry.js';
import { defaultSubstitutes } from '../mitm-proxy/defaults.js';
import { asGroupScope } from '../mitm-proxy/types.js';
import type { SubstitutingProvider } from '../mitm-proxy/types.js';
import type { AgentGroup, Session } from '../../types.js';

// Side-effects: register the /action wakeup handler and the get_credential action.
import '../sync-actions/index.js';
import '../mitm-proxy/get-credential-action.js';

const GROUP: AgentGroup = {
  id: 'g-e2e',
  name: 'e2e',
  folder: 'e2e-group',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00Z',
};
const SESSION: Session = {
  id: 's-e2e',
  agent_group_id: GROUP.id,
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-01-01T00:00:00Z',
};

const PROVIDER_ID = 'testprov';

let baseUrl = '';
let nextPort = 28381;
let seq = 1;

async function startOnFreePort(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = nextPort++;
    try {
      await startHostRpcServer({ port, bind: '127.0.0.1' });
      return `http://127.0.0.1:${port}`;
    } catch {
      /* port in use */
    }
  }
  throw new Error('No free port');
}

/** Write a sync get_credential request into outbound.db, as the container would. */
function writeSyncRequest(requestId: string, content: Record<string, unknown>): void {
  const db = new Database(outboundDbPath(GROUP.id, SESSION.id));
  db.pragma('journal_mode = DELETE');
  db.prepare(
    `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, NULL, datetime('now'), NULL, NULL, 'system', NULL, NULL, NULL, ?)`,
  ).run(requestId, (seq += 2), JSON.stringify({ ...content, sync: true, requestId }));
  db.close();
}

function readInboundContent(id: string): { ok?: boolean; result?: unknown; error?: string } {
  const db = new Database(inboundDbPath(GROUP.id, SESSION.id), { readonly: true });
  const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string } | undefined;
  db.close();
  if (!row) throw new Error(`no inbound row ${id}`);
  return JSON.parse(row.content);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-e2e-'));
  process.env.XDG_CONFIG_HOME = path.join(tmpRoot, 'config');
  fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  fs.mkdirSync(TMP_DATA(), { recursive: true });
  fs.mkdirSync(TMP_GROUPS(), { recursive: true });

  const db = initDb(path.join(TMP_DATA(), 'v2.db'));
  runMigrations(db);
  createAgentGroup(GROUP);
  createSession(SESSION);
  initSessionFolder(GROUP.id, SESSION.id);

  // Real engine; stub only the credential-store backend (resolver).
  setTokenEngine(
    new TokenSubstituteEngine(() => ({
      resolve: (_scope, providerId) =>
        providerId === PROVIDER_ID ? { value: 'REALSECRET-abcdef0123456789', updated_ts: 1 } : null,
    })),
  );
  const provider: SubstitutingProvider = {
    id: PROVIDER_ID,
    buildManifest: () => [],
    onManifestWritten: () => {},
    onManifestDeleted: () => {},
    substitutes: defaultSubstitutes({
      substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-_' },
      envBindings: [{ envName: 'TEST_TOKEN', credentialPath: 'api_key' }],
    }),
  };
  registerCredentialProvider(provider);

  allocateContainerIP(asContainerScope(GROUP.folder), SESSION.id); // → 127.0.0.1
});

beforeEach(async () => {
  baseUrl = await startOnFreePort();
});

afterEach(async () => {
  await stopHostRpcServer();
});

afterAll(() => {
  _resetTokenEngineForTests();
  _resetProviderRegistryForTests();
  __resetRegistryForTests();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sync-action e2e: get_credential round-trip', () => {
  it('resolves a substitute end-to-end through the real host stack', async () => {
    const requestId = 'req-ok';
    writeSyncRequest(requestId, {
      action: 'get_credential',
      providerId: PROVIDER_ID,
      credentialPath: 'api_key',
      envVar: 'TEST_TOKEN',
    });

    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    expect(res.status).toBe(200);
    const env = (await res.json()) as { ok: boolean; result: { inboundId: string } };
    expect(env.ok).toBe(true);
    expect(env.result.inboundId).toBeTruthy();

    const result = readInboundContent(env.result.inboundId) as {
      ok: boolean;
      result: { substitute: string; providerId: string; envNames: string[] };
    };
    expect(result.ok).toBe(true);
    expect(typeof result.result.substitute).toBe('string');
    expect(result.result.substitute.length).toBeGreaterThan(0);
    expect(result.result.substitute).not.toContain('REALSECRET'); // it's a placeholder, not the real value
    expect(result.result.providerId).toBe(PROVIDER_ID);
    expect(result.result.envNames).toContain('TEST_TOKEN');
  });

  it('returns a structured error for an unknown provider', async () => {
    const requestId = 'req-unknown';
    writeSyncRequest(requestId, { action: 'get_credential', providerId: 'nope', credentialPath: 'api_key' });

    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    const env = (await res.json()) as { ok: boolean; result: { inboundId: string } };
    expect(env.ok).toBe(true); // transport ok; the action failure is in the result row

    const result = readInboundContent(env.result.inboundId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown provider/);
  });

  it('rejects a malformed envVar name with a structured error (through the full stack)', async () => {
    const requestId = 'req-badenv';
    writeSyncRequest(requestId, {
      action: 'get_credential',
      providerId: PROVIDER_ID,
      credentialPath: 'api_key',
      envVar: 'bad-name', // hyphen → fails the UPPER_SNAKE_CASE format check
    });

    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    const env = (await res.json()) as { ok: boolean; result: { inboundId: string } };
    expect(env.ok).toBe(true); // transport ok; the validation failure is in the result row

    const result = readInboundContent(env.result.inboundId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid env var name format/);
  });

  it('rejects a wakeup whose requestId has no row', async () => {
    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'does-not-exist' }),
    });
    const env = (await res.json()) as { ok: boolean; error?: string };
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/request row not found/);
  });

  it('rejects a caller IP with no bound session (unknown container)', async () => {
    // Drop the registry so 127.0.0.1 no longer maps to a container.
    __resetRegistryForTests();
    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-ok' }),
    });
    expect(res.status).toBe(403); // host-rpc rejects unknown caller before the handler
    // restore for any later test ordering
    allocateContainerIP(asContainerScope(GROUP.folder), SESSION.id);
  });
});
