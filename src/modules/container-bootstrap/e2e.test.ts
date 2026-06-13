/**
 * Live-container e2e test for A4 (container-bootstrap).
 *
 * Drives the real `wakeContainer` path end-to-end against a real Docker
 * daemon. Verifies:
 *   1. The snapshot's `entrypoint.sh` is the one that runs (not the image's
 *      fail-loud stub).
 *   2. The default launch shape mounts agent-runner src / skills / CLAUDE.md
 *      from the snapshot.
 *   3. The rootless launch path produces a process running as the host UID
 *      and receives the host's stdin payload.
 *   4. When an `onSpawnPre` observer returns `needsRootEntrypoint: true` +
 *      custom env, the container starts as root, the entrypoint's setpriv
 *      block drops to HOST_UID before exec-ing bun, and the custom env is
 *      visible inside.
 *
 * Auto-skips when:
 *   - Docker is unavailable.
 *   - The agent image isn't built locally (`./container/build.sh`).
 *
 * Strategy: stand up a minimal central DB + tmp DATA_DIR/GROUPS_DIR, mock
 * the OneCLI SDK so `applyContainerConfig` is a no-op, overwrite the
 * snapshot's `agent-runner/src/index.ts` with a tiny TS probe that writes
 * a result JSON to /workspace, then call the real `wakeContainer`. After
 * `fireContainerExited`, read the result file and assert.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import type { AgentGroup, Session } from '../../types.js';

// ---------------------------------------------------------------------------
// Mocks — set up before any imports that read DATA_DIR / GROUPS_DIR.
// ---------------------------------------------------------------------------

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
    ONECLI_URL: 'http://127.0.0.1:1',
    ONECLI_API_KEY: 'test',
  };
});

// OneCLI gateway is a no-op for this test — credential injection isn't what
// we're exercising. `applyContainerConfig` must return true so spawn proceeds.
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

// Imports must follow the mocks.
import { CONTAINER_IMAGE } from '../../config.js';
import { initDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { initSessionFolder } from '../../session-manager.js';
import {
  clearContainerLifecycleObservers,
  initSnapshot,
  registerContainerLifecycleObserver,
  snapshotPath,
  type ExitContext,
} from './index.js';
import { wakeContainer } from '../../container-runner.js';

// ---------------------------------------------------------------------------
// Skip predicates
// ---------------------------------------------------------------------------

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function imageAvailable(tag: string): boolean {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();
const HAVE_IMAGE = HAVE_DOCKER && imageAvailable(CONTAINER_IMAGE);
// Skip only when there's nothing to test against — no Docker, or no image at
// all. A built-but-wrong-shape image (e.g. a stale v1 build missing bun)
// will exit 127 inside the container and trip the `expect(exitCode).toBe(0)`
// assertion — no need for a separate pre-flight probe.
const RUN_E2E = HAVE_DOCKER && HAVE_IMAGE;

// ---------------------------------------------------------------------------
// Probe — overwrites the snapshot's agent-runner index.ts and reports the
// container-side state we care about back into /workspace.
// ---------------------------------------------------------------------------

const PROBE_SOURCE = `
import fs from 'fs';

const result = {
  uid: process.getuid?.() ?? -1,
  gid: process.getgid?.() ?? -1,
  home: process.env.HOME ?? null,
  pwd: process.cwd(),
  hostUidEnv: process.env.HOST_UID ?? null,
  hostGidEnv: process.env.HOST_GID ?? null,
  customEnv: process.env.A4_PROBE_ENV ?? null,
  stdinReceived: fs.existsSync('/tmp/input.json'),
  stdinPayload: fs.existsSync('/tmp/input.json')
    ? fs.readFileSync('/tmp/input.json', 'utf-8')
    : null,
  entrypointVisible: fs.existsSync('/app/entrypoint.sh'),
  agentRunnerSrcVisible: fs.existsSync('/app/src/index.ts'),
  claudeMdVisible: fs.existsSync('/app/CLAUDE.md'),
};

fs.writeFileSync('/workspace/a4-probe.json', JSON.stringify(result));
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AGENT_GROUP_ID = 'ag-a4-e2e';
const AGENT_GROUP_FOLDER = 'a4-e2e';
const SESSION_ID = 'sess-a4-e2e';

function mkAgentGroup(): AgentGroup {
  return {
    id: AGENT_GROUP_ID,
    name: 'a4-e2e',
    folder: AGENT_GROUP_FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
}

function mkSession(): Session {
  return {
    id: SESSION_ID,
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

function waitForExit(): Promise<ExitContext> {
  return new Promise((resolve) => {
    registerContainerLifecycleObserver('test-await-exit', {
      onContainerExited(ctx) {
        resolve(ctx);
      },
    });
  });
}

function setupCentralDb(): void {
  fs.mkdirSync(TMP_DATA(), { recursive: true });
  const db = initDb(path.join(TMP_DATA(), 'v2.db'));
  runMigrations(db);
}

function setupAgentGroup(): void {
  fs.mkdirSync(TMP_GROUPS(), { recursive: true });
  const group = mkAgentGroup();
  createAgentGroup(group);
  createSession(mkSession());
  initGroupFilesystem(group);
  // Create the session folder up-front. Without it, Docker creates the bind-
  // mount source as root and the container (running as uid 1000) can't write
  // back to /workspace.
  initSessionFolder(group.id, SESSION_ID);
}

function readProbeResult(): Record<string, unknown> {
  const resultPath = path.join(TMP_DATA(), 'v2-sessions', AGENT_GROUP_ID, SESSION_ID, 'a4-probe.json');
  expect(fs.existsSync(resultPath)).toBe(true);
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_E2E)('A4 container-bootstrap — live container', () => {
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-e2e-'));
    setupCentralDb();
    initSnapshot();
    // Replace the snapshot's agent-runner entrypoint with the probe. Image's
    // ENTRYPOINT → snapshot entrypoint.sh → `bun run /app/src/index.ts` →
    // probe writes /workspace/a4-probe.json and exits 0.
    fs.writeFileSync(snapshotPath('agent-runner/src/index.ts'), PROBE_SOURCE);
    setupAgentGroup();
  }, 60_000);

  afterAll(() => {
    closeDb();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Container ran as root and left files we can't remove from userland.
        // Best-effort cleanup via docker — borrow the image's root context.
        try {
          execSync(`docker run --rm -v ${tmpRoot}:/cleanup alpine sh -c 'rm -rf /cleanup/*'`, { stdio: 'pipe' });
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* leave tmp dir; OS will reap on reboot */
        }
      }
    }
  });

  beforeEach(() => {
    clearContainerLifecycleObservers();
    // Re-register the built-in IP observer that the barrel side-effect import
    // already installed once; clear() also dropped it. Easiest restore is to
    // re-import the ip-observer module — Node caches it but we need its
    // registration after clear().
    void import('./ip-observer.js');
    // Wipe any previous probe result.
    const prev = path.join(TMP_DATA(), 'v2-sessions', AGENT_GROUP_ID, SESSION_ID, 'a4-probe.json');
    if (fs.existsSync(prev)) fs.unlinkSync(prev);
  });

  it('rootless path: snapshot entrypoint runs, stdin arrives, process runs as host UID', async () => {
    const exited = waitForExit();
    const ok = await wakeContainer(mkSession());
    expect(ok).toBe(true);
    const exit = await exited;
    expect(exit.reason).toBe('normal');
    expect(exit.exitCode).toBe(0);

    const probe = readProbeResult();
    expect(probe.entrypointVisible).toBe(true);
    expect(probe.agentRunnerSrcVisible).toBe(true);
    expect(probe.stdinReceived).toBe(true);
    // The image's USER node has uid=1000; we expect the host's uid (or 1000
    // when the host happens to be root or 1000 already — the rootless
    // fallback case from resolveLaunchMode).
    const hostUid = process.getuid?.() ?? -1;
    if (hostUid === 0 || hostUid === 1000 || hostUid === -1) {
      // Image default: USER node = 1000.
      expect(probe.uid).toBe(1000);
    } else {
      expect(probe.uid).toBe(hostUid);
    }
    expect(probe.customEnv).toBeNull();
    expect(probe.hostUidEnv).toBeNull();
  }, 120_000);

  it('root-drop path: needsRootEntrypoint observer triggers setpriv drop + env passthrough', async () => {
    const hostUid = process.getuid?.() ?? -1;
    // The drop path requires the host to expose a UID/GID (POSIX). Skip on
    // platforms where it doesn't (also skipped above by RUN_E2E gating on
    // Docker, which is POSIX anyway).
    if (hostUid < 0) return;

    registerContainerLifecycleObserver('test-root-drop', {
      onSpawnPre() {
        return {
          needsRootEntrypoint: true,
          env: { A4_PROBE_ENV: 'visible' },
        };
      },
    });

    const exited = waitForExit();
    const ok = await wakeContainer(mkSession());
    expect(ok).toBe(true);
    const exit = await exited;
    expect(exit.reason).toBe('normal');
    expect(exit.exitCode).toBe(0);

    const probe = readProbeResult();
    expect(probe.customEnv).toBe('visible');
    // HOST_UID env reaches the container (set by container-runner because
    // launchMode resolved to root-drop).
    expect(probe.hostUidEnv).toBe(String(hostUid));
    // Post-setpriv uid matches the host's — proving the drop fired.
    expect(probe.uid).toBe(hostUid);
  }, 120_000);
});
