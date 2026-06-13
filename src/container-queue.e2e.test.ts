/**
 * Live-container e2e for the D group-queue cluster (concurrency cap +
 * demand-driven eviction + graceful soft-stop).
 *
 * The unit suite (`container-queue.test.ts`) proves the queue *logic* with
 * mocked spawn/evict deps. This drives the real `wakeContainer` path against a
 * real Docker daemon to prove the parts that only exist on metal:
 *
 *   1. **Cap holds + FIFO drain.** With MAX_CONCURRENT_CONTAINERS=2, two real
 *      containers occupy both slots; a third wake is *deferred* (no third
 *      container). When one of the two exits, the deferred session drains into
 *      the freed slot — proving `queue.onExit` → `drain` → real spawn. Eviction
 *      is suppressed here by marking the two live containers as mid-turn
 *      (outstanding claim → not evictable), isolating pure cap+drain.
 *
 *   2. **Demand-driven eviction via graceful soft-stop.** At cap with two idle
 *      (unclaimed) containers, a new wake evicts the oldest-idle one through the
 *      graceful path (`docker stop -t N`). The victim's SIGTERM handler runs
 *      *before* exit (writes a marker) — proving the soft-stop signal is
 *      delivered and honored, not a torn SIGKILL — and the waiting session
 *      drains into the freed slot.
 *
 * Auto-skips when the agent image isn't built locally.
 *
 * Strategy mirrors `container-bootstrap/e2e.test.ts`: a tmp central DB +
 * DATA_DIR/GROUPS_DIR, a no-op OneCLI mock, and the snapshot's agent-runner
 * `index.ts` overwritten with a tiny long-lived probe. The probe idles (holding
 * its slot like a warm container), exits 0 on a host-written `/workspace/finish`
 * sentinel, and on SIGTERM/SIGINT writes `/workspace/graceful.marker` then
 * exits 0.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import type { AgentGroup, Session } from './types.js';

// ---------------------------------------------------------------------------
// Mocks — must precede any import that reads config / the OneCLI SDK.
// ---------------------------------------------------------------------------

let tmpRoot = '';
const TMP_DATA = () => path.join(tmpRoot, 'data');
const TMP_GROUPS = () => path.join(tmpRoot, 'groups');

vi.mock('./config.js', async () => {
  const real = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...real,
    get DATA_DIR() {
      return TMP_DATA();
    },
    get GROUPS_DIR() {
      return TMP_GROUPS();
    },
    ONECLI_URL: 'http://127.0.0.1:1',
    ONECLI_API_KEY: 'test',
    // The three queue knobs are captured into the module-global `queue`
    // singleton at container-runner load — fix them here (not via env) so the
    // values are deterministic regardless of the runner's environment.
    MAX_CONCURRENT_CONTAINERS: 2,
    IDLE_BEFORE_EVICT: 0, // any unclaimed container is immediately evictable
    GRACEFUL_STOP_MS: 2000, // → docker stop -t 2 (min grace)
  };
});

// OneCLI gateway is a no-op — credential injection isn't under test.
// applyContainerConfig must return true so the spawn proceeds.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    async ensureAgent() {
      /* no-op */
    }
    async applyContainerConfig() {
      return true;
    }
    async configureManualApproval() {
      /* no-op */
    }
  },
}));

// Imports follow the mocks.
import { CONTAINER_IMAGE } from './config.js';
import { initDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createSession } from './db/sessions.js';
import { initGroupFilesystem } from './group-init.js';
import { initSessionFolder, sessionDir } from './session-manager.js';
import {
  clearContainerLifecycleObservers,
  initSnapshot,
  registerContainerLifecycleObserver,
  snapshotPath,
  type ExitContext,
} from './modules/container-bootstrap/index.js';
import {
  wakeContainer,
  recordContainerLiveness,
  getActiveContainerCount,
  isContainerRunning,
  getContainerName,
} from './container-runner.js';

// ---------------------------------------------------------------------------
// Skip predicate
// ---------------------------------------------------------------------------

function imageAvailable(tag: string): boolean {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const RUN_E2E = imageAvailable(CONTAINER_IMAGE);

// ---------------------------------------------------------------------------
// Probe — a long-lived agent-runner stand-in. Idles (holding its slot like a
// warm container), exits 0 on /workspace/finish, and on SIGTERM/SIGINT writes
// a marker then exits 0 (the graceful soft-stop the host's `docker stop -t`
// expects). Writes /workspace/ready.marker once up so the host can wait until
// the bun process is alive before signalling it.
// ---------------------------------------------------------------------------

const PROBE_SOURCE = `
import fs from 'fs';

let done = false;
function finish(marker) {
  if (done) return;
  done = true;
  if (marker) {
    try { fs.writeFileSync('/workspace/' + marker, String(Date.now())); } catch {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => finish('graceful.marker'));
process.on('SIGINT', () => finish('graceful.marker'));

try { fs.writeFileSync('/workspace/ready.marker', '1'); } catch {}

setInterval(() => {
  if (fs.existsSync('/workspace/finish')) finish(null);
}, 100);
`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_GROUP_ID = 'ag-dq-e2e';
const AGENT_GROUP_FOLDER = 'dq-e2e';

function mkAgentGroup(): AgentGroup {
  return {
    id: AGENT_GROUP_ID,
    name: 'dq-e2e',
    folder: AGENT_GROUP_FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
}

function mkSession(id: string): Session {
  return {
    id,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function sPath(sessionId: string, name: string): string {
  return path.join(sessionDir(AGENT_GROUP_ID, sessionId), name);
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

// Per-session exit routing: a single observer records every exit; awaitExit
// resolves from the recorded map or registers a pending resolver.
const exited = new Map<string, ExitContext>();
const exitResolvers = new Map<string, (ctx: ExitContext) => void>();

function awaitExit(sessionId: string, timeoutMs = 30_000): Promise<ExitContext> {
  const already = exited.get(sessionId);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`exit timeout for ${sessionId}`)), timeoutMs);
    exitResolvers.set(sessionId, (ctx) => {
      clearTimeout(timer);
      resolve(ctx);
    });
  });
}

function setupSession(sessionId: string): void {
  createSession(mkSession(sessionId));
  // Create the session folder up-front so Docker doesn't create the bind-mount
  // source as root (container runs as uid 1000 and must write /workspace).
  initSessionFolder(AGENT_GROUP_ID, sessionId);
}

function forceRemove(sessionId: string): void {
  const name = getContainerName(sessionId);
  if (!name) return;
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'pipe', timeout: 10_000 });
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_E2E)('D group-queue — live container (cap + eviction + soft-stop)', () => {
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-e2e-'));
    fs.mkdirSync(TMP_DATA(), { recursive: true });
    fs.mkdirSync(TMP_GROUPS(), { recursive: true });
    const db = initDb(path.join(TMP_DATA(), 'v2.db'));
    runMigrations(db);
    initSnapshot();
    // Replace the snapshot's agent-runner entrypoint with the long-lived probe.
    fs.writeFileSync(snapshotPath('agent-runner/src/index.ts'), PROBE_SOURCE);
    const group = mkAgentGroup();
    createAgentGroup(group);
    initGroupFilesystem(group);
  }, 60_000);

  afterAll(() => {
    closeDb();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        try {
          execSync(`docker run --rm -v ${tmpRoot}:/cleanup alpine sh -c 'rm -rf /cleanup/*'`, { stdio: 'pipe' });
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* OS reaps tmp on reboot */
        }
      }
    }
  });

  beforeEach(() => {
    exited.clear();
    exitResolvers.clear();
    clearContainerLifecycleObservers();
    // clear() also dropped the built-in IP observer the barrel installed once;
    // re-import to re-register it (Node caches the module).
    void import('./modules/container-bootstrap/ip-observer.js');
    registerContainerLifecycleObserver('dq-e2e-exit-router', {
      onContainerExited(ctx) {
        exited.set(ctx.session.id, ctx);
        const r = exitResolvers.get(ctx.session.id);
        if (r) {
          exitResolvers.delete(ctx.session.id);
          r(ctx);
        }
      },
    });
  });

  it('cap holds: a third wake is deferred, then drains into a freed slot (FIFO)', async () => {
    const [a, b, c] = ['dq-cap-a', 'dq-cap-b', 'dq-cap-c'];
    [a, b, c].forEach(setupSession);

    try {
      // Fill both slots.
      expect(await wakeContainer(mkSession(a))).toBe(true);
      expect(await wakeContainer(mkSession(b))).toBe(true);
      expect(getActiveContainerCount()).toBe(2);

      // Mark both as mid-turn (outstanding claim) so eviction is suppressed —
      // this isolates pure cap+defer (not demand eviction). Mirrors the sweep's
      // per-tick liveness stamp.
      recordContainerLiveness(a, 0, true);
      recordContainerLiveness(b, 0, true);

      // Third wake at cap → deferred. No third container; the inbound row would
      // stay pending in production.
      expect(await wakeContainer(mkSession(c))).toBe(false);
      expect(isContainerRunning(c)).toBe(false);
      expect(getActiveContainerCount()).toBe(2);

      // Wait for A to be alive, then finish it cleanly → it exits 'normal'.
      expect(await waitForFile(sPath(a, 'ready.marker'), 30_000)).toBe(true);
      fs.writeFileSync(sPath(a, 'finish'), '1');

      const aExit = await awaitExit(a);
      expect(aExit.reason).toBe('normal');
      expect(aExit.exitCode).toBe(0);

      // The freed slot drains to the longest-waiting session (C), not a 3rd new
      // container — occupancy never exceeds the cap.
      expect(await waitUntil(() => isContainerRunning(c), 15_000)).toBe(true);
      expect(isContainerRunning(a)).toBe(false);
      expect(getActiveContainerCount()).toBe(2); // B + C
    } finally {
      // Release everything still alive.
      [a, b, c].forEach((s) => {
        if (isContainerRunning(s)) {
          try {
            fs.writeFileSync(sPath(s, 'finish'), '1');
          } catch {
            /* ignore */
          }
        }
      });
      await waitUntil(() => [a, b, c].every((s) => !isContainerRunning(s)), 20_000);
      [a, b, c].forEach(forceRemove);
    }
  }, 120_000);

  it('demand eviction: the oldest idle container is soft-stopped (SIGTERM honored) and the waiter drains in', async () => {
    const [a, b, c] = ['dq-evict-a', 'dq-evict-b', 'dq-evict-c'];
    [a, b, c].forEach(setupSession);

    try {
      // Fill both slots; leave both idle (no claim) → evictable. A spawned
      // first ⇒ lower spawnedAt ⇒ the oldest-idle victim.
      expect(await wakeContainer(mkSession(a))).toBe(true);
      expect(await waitForFile(sPath(a, 'ready.marker'), 30_000)).toBe(true);
      expect(await wakeContainer(mkSession(b))).toBe(true);
      expect(await waitForFile(sPath(b, 'ready.marker'), 30_000)).toBe(true);
      expect(getActiveContainerCount()).toBe(2);

      // New wake at cap → deferred + demand eviction of the oldest idle (A).
      expect(await wakeContainer(mkSession(c))).toBe(false);

      // A is evicted via the graceful path: its SIGTERM handler runs before
      // exit and writes the marker (proving soft-stop, not a torn SIGKILL).
      const aExit = await awaitExit(a);
      expect(aExit.reason).toBe('killed');
      expect(fs.existsSync(sPath(a, 'graceful.marker'))).toBe(true);

      // The freed slot drains to the waiting session C.
      expect(await waitUntil(() => isContainerRunning(c), 20_000)).toBe(true);
      expect(isContainerRunning(a)).toBe(false);
      expect(isContainerRunning(b)).toBe(true);
      expect(getActiveContainerCount()).toBe(2); // B + C
    } finally {
      [a, b, c].forEach((s) => {
        if (isContainerRunning(s)) {
          try {
            fs.writeFileSync(sPath(s, 'finish'), '1');
          } catch {
            /* ignore */
          }
        }
      });
      await waitUntil(() => [a, b, c].every((s) => !isContainerRunning(s)), 20_000);
      [a, b, c].forEach(forceRemove);
    }
  }, 120_000);
});
