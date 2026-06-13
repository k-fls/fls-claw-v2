/**
 * End-to-end ssh-auth test.
 *
 * Boots the actual nanoclaw-agent image with a single mount-patch:
 * `e2e-runner.ts` is bind-mounted over `/app/src/index.ts`, replacing the
 * agent-runner main. Everything else (entrypoint.sh, image, tini, bun,
 * privilege drop, openssh-client) is the production code path.
 *
 * Flow:
 *   1. Start an sshd in a sibling container on the nanoclaw bridge.
 *   2. Start the host-rpc server, init ssh-auth, store an SSH cred for
 *      a synthetic agent group.
 *   3. Allocate a container IP for the agent (registers caller IP →
 *      scope/session in ip-registry).
 *   4. `docker run -d` the agent image with the runner mounted in;
 *      `docker wait` for it to exit.
 *   5. Assert exit code 0 and the runner's success sentinel in stdout.
 *
 * Auto-skipped if Docker is missing or the image isn't built. No special
 * env var required — runs in any CI/CD with Docker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  allocateContainerIP,
  asContainerScope,
  ensureContainerNetwork,
  networkArgs,
  type AllocatedIP,
} from '../container-bootstrap/index.js';
import { startHostRpcServer, stopHostRpcServer, getHostRpcAddress } from '../host-rpc/index.js';
import { asCredentialScope, asGroupScope, getOrCreateResolverForAgentGroup } from '../credentials/index.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup, deleteAgentGroup } from '../../db/agent-groups.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from '../../container-runtime.js';
import { getDefaultContainerImage } from '../../install-slug.js';
import { sshToCredential, SSH_PROVIDER_ID } from './types.js';
import type { SSHCredentialMeta } from './types.js';
import { socketDir } from './manager.js';

// ── Constants ─────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTAINER_IMAGE = process.env.NANOCLAW_AGENT_IMAGE || getDefaultContainerImage();
const AGENT_GROUP_ID = 'ssh-e2e-group';
const SCOPE_FOLDER = 'ssh-e2e';
const SESSION_ID = 'ssh-e2e-session';
const ALIAS = 'e2e-sshd';
const USERNAME = 'testuser';

function isImageAvailable(): boolean {
  // `docker image inspect` fails the same way whether the daemon is down
  // or the image is missing — covers both checks in one call.
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['image', 'inspect', CONTAINER_IMAGE], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const canRun = isImageAvailable();

// ── sshd container ────────────────────────────────────────────────

interface SshdHandle {
  containerName: string;
  ip: string;
  port: number;
  username: string;
  stop: () => void;
}

function startSshdContainer(publicKey: string): SshdHandle {
  const containerName = `nanoclaw-e2e-sshd-${Date.now()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshd-e2e-'));

  const initScript = path.join(tmpDir, 'init.sh');
  fs.writeFileSync(
    initScript,
    [
      '#!/bin/sh',
      'set -e',
      'apk add --no-cache openssh >/dev/null',
      `adduser -D -s /bin/sh ${USERNAME}`,
      `passwd -u ${USERNAME}`,
      `mkdir -p /home/${USERNAME}/.ssh`,
      `echo '${publicKey}' > /home/${USERNAME}/.ssh/authorized_keys`,
      `chmod 755 /home/${USERNAME}`,
      `chmod 700 /home/${USERNAME}/.ssh`,
      `chmod 600 /home/${USERNAME}/.ssh/authorized_keys`,
      `chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}`,
      'ssh-keygen -A >/dev/null 2>&1',
      'exec /usr/sbin/sshd -D -e',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  // sshd lives on docker's default bridge — only the host needs to reach
  // it (the SSH ControlMaster runs on the host). Keeping it off the
  // nanoclaw bridge avoids competing with `allocateContainerIP` for the
  // pool, which only tracks our process-local allocations.
  execFileSync(
    CONTAINER_RUNTIME_BIN,
    ['run', '-d', '--name', containerName, '-v', `${initScript}:/init.sh:ro`, 'alpine:latest', '/init.sh'],
    { stdio: 'pipe' },
  );

  let ready = false;
  let containerIp = '';
  for (let i = 0; i < 60; i++) {
    try {
      const status = execFileSync(CONTAINER_RUNTIME_BIN, ['inspect', '--format', '{{.State.Status}}', containerName], {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      if (status !== 'running') {
        const logs = execFileSync(CONTAINER_RUNTIME_BIN, ['logs', containerName], { encoding: 'utf-8', stdio: 'pipe' });
        throw new Error(`sshd container exited (${status}):\n${logs}`);
      }
      execFileSync(
        CONTAINER_RUNTIME_BIN,
        ['exec', containerName, 'sh', '-c', 'netstat -tlnp 2>/dev/null | grep -q :22'],
        { stdio: 'pipe', timeout: 2000 },
      );
      containerIp = execFileSync(
        CONTAINER_RUNTIME_BIN,
        ['inspect', '--format', '{{.NetworkSettings.Networks.bridge.IPAddress}}', containerName],
        { encoding: 'utf-8', stdio: 'pipe' },
      ).trim();
      ready = true;
      break;
    } catch (err) {
      if (err instanceof Error && err.message.includes('sshd container exited')) throw err;
      execSync('sleep 0.5', { stdio: 'pipe' });
    }
  }
  if (!ready) throw new Error('sshd container never became ready after 30s');
  if (!containerIp) throw new Error('sshd container IP not resolved');

  return {
    containerName,
    ip: containerIp,
    port: 22,
    username: USERNAME,
    stop: () => {
      try {
        execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], { stdio: 'pipe' });
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function generateKeyPair(dir: string): { privateKey: string; publicKey: string } {
  const keyPath = path.join(dir, 'key');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'nanoclaw-e2e'], {
    stdio: 'pipe',
  });
  return {
    privateKey: fs.readFileSync(keyPath, 'utf-8'),
    publicKey: fs.readFileSync(keyPath + '.pub', 'utf-8').trim(),
  };
}

// ── Suite ─────────────────────────────────────────────────────────

describe.skipIf(!canRun)('SSH e2e (Docker)', () => {
  let tmpDir: string;
  let xdgDir: string;
  let sshd: SshdHandle;
  let allocated: AllocatedIP;
  let agentContainerName = '';
  let runnerStdout = '';
  let runnerStderr = '';
  let runnerExitCode = -1;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-e2e-'));
    xdgDir = path.join(tmpDir, 'xdg');
    fs.mkdirSync(xdgDir, { recursive: true });

    // Redirect credential storage to a temp dir so we don't touch
    // ~/.config/nanoclaw on a developer machine.
    process.env.XDG_CONFIG_HOME = xdgDir;

    // In-memory DB with the central schema applied.
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'ssh-e2e',
      folder: SCOPE_FOLDER,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    // Importing the barrel triggers registerSSHProviders() + initSSHSystem(),
    // which registers the /ssh host-rpc handler and the lifecycle observer.
    await import('./index.js');

    ensureContainerNetwork();
    // Bind to 0.0.0.0 so callers on the nanoclaw bridge (different subnet
    // than docker0) can reach via host.docker.internal/host-gateway.
    await startHostRpcServer({ bind: '0.0.0.0' });
    const addr = getHostRpcAddress();
    if (!addr) throw new Error('host-rpc server did not bind');

    // 1. Client keypair + sshd
    const keyPair = generateKeyPair(tmpDir);
    sshd = startSshdContainer(keyPair.publicKey);

    // 2. Store the SSH credential in the test agent group's scope
    const credScope = asCredentialScope(SCOPE_FOLDER);
    const meta: SSHCredentialMeta = {
      host: sshd.ip,
      port: sshd.port,
      username: sshd.username,
      authType: 'key',
      publicKey: keyPair.publicKey,
      hostKey: '*', // accept-any — skips ssh-keyscan / TOFU
    };
    const resolver = getOrCreateResolverForAgentGroup(SCOPE_FOLDER);
    resolver.store(credScope, SSH_PROVIDER_ID, ALIAS, sshToCredential(keyPair.privateKey, meta));

    // 3. Allocate an IP on the nanoclaw bridge keyed to our test scope +
    //    session, so host-rpc dispatch resolves caller IP correctly.
    allocated = allocateContainerIP(asContainerScope(AGENT_GROUP_ID), SESSION_ID);

    // 4. Prepare the /app/src bind: write the runner under a name bun can
    //    resolve. Bun-side `fetch` + child_process work without deps, so
    //    no package.json / node_modules are required in this dir.
    const runnerDir = path.join(tmpDir, 'runner');
    fs.mkdirSync(runnerDir, { recursive: true });
    const runnerSrc = path.resolve(__dirname, 'e2e-runner.ts');
    fs.copyFileSync(runnerSrc, path.join(runnerDir, 'index.ts'));

    // 5. /ssh-sockets host dir (init.ts's onSpawnPre would normally create
    //    it; here we mount it directly so we can bypass container-runner).
    const groupScope = asGroupScope(SCOPE_FOLDER);
    const sockHost = socketDir(groupScope);
    fs.mkdirSync(sockHost, { recursive: true, mode: 0o700 });

    // 6. Mount the production entrypoint.sh so the in-image fail-loud
    //    stub doesn't fire. The runtime path then matches production.
    const entrypointSrc = path.resolve(__dirname, '../../../container/entrypoint.sh');

    // 7. Spawn the agent container. -d for detached + named so we can
    //    `docker wait` + `docker logs`. No --rm: we need logs after exit.
    //    --user matches the test process so the bind-mounted socket dir
    //    (created by us at mode 0700) is reachable inside the container.
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? uid;
    agentContainerName = `nanoclaw-ssh-e2e-agent-${Date.now()}`;
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '-d',
        '--name',
        agentContainerName,
        '--user',
        `${uid}:${gid}`,
        '-e',
        `HOME=/home/node`,
        ...hostGatewayArgs(),
        ...networkArgs(allocated.ip),
        '-v',
        `${runnerDir}:/app/src:ro`,
        '-v',
        `${entrypointSrc}:/app/entrypoint.sh:ro`,
        '-v',
        `${sockHost}:/ssh-sockets:rw`,
        // Container reaches the host via the bridge gateway aliased by
        // --add-host. The bind that host-rpc reports (`0.0.0.0`) isn't
        // useful inside the container, so we substitute the alias here.
        '-e',
        `CLAW_HOST_RPC_URL=http://host.docker.internal:${addr.port}`,
        '-e',
        `E2E_ALIAS=${ALIAS}`,
        '-e',
        `E2E_EXPECTED_USER=${USERNAME}`,
        CONTAINER_IMAGE,
      ],
      { stdio: 'pipe' },
    );

    // 8. Poll for container exit (docker wait can be flaky on this host).
    //    60s is plenty — the runner only needs to do a few fetches + an ssh.
    const { spawnSync } = await import('child_process');
    const deadline = Date.now() + 60_000;
    let exited = false;
    while (Date.now() < deadline) {
      const inspect = spawnSync(
        CONTAINER_RUNTIME_BIN,
        ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', agentContainerName],
        { encoding: 'utf-8' },
      );
      const [status, codeStr] = (inspect.stdout ?? '').trim().split(/\s+/);
      if (status === 'exited') {
        runnerExitCode = parseInt(codeStr, 10);
        exited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!exited) {
      const partial = spawnSync(CONTAINER_RUNTIME_BIN, ['logs', agentContainerName], { encoding: 'utf-8' });
      runnerExitCode = -1;
      runnerStdout = `[wait-timeout] ${partial.stdout ?? ''}`;
      runnerStderr = `[wait-timeout] ${partial.stderr ?? ''}`;
      return;
    }

    const logsProc = spawnSync(CONTAINER_RUNTIME_BIN, ['logs', agentContainerName], { encoding: 'utf-8' });
    runnerStdout = logsProc.stdout ?? '';
    runnerStderr = logsProc.stderr ?? '';
  }, 180_000);

  afterAll(async () => {
    if (process.env.E2E_KEEP_CONTAINER) {
      console.log('[E2E_KEEP] agent container:', agentContainerName);
    } else {
      try {
        if (agentContainerName) {
          execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', agentContainerName], { stdio: 'pipe' });
        }
      } catch {}
    }
    try {
      allocated?.release();
    } catch {}
    try {
      sshd?.stop();
    } catch {}
    try {
      await stopHostRpcServer();
    } catch {}
    try {
      deleteAgentGroup(AGENT_GROUP_ID);
    } catch {}
    try {
      closeDb();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }, 30_000);

  it('runner completes the full SSH loop end-to-end', () => {
    if (runnerExitCode !== 0) {
      // Surface the runner's tagged failure code + logs so a CI failure
      // is debuggable without reproducing locally.
      throw new Error(
        `runner exited with code ${runnerExitCode}\n` +
          `--- stdout ---\n${runnerStdout}\n` +
          `--- stderr ---\n${runnerStderr}`,
      );
    }
    expect(runnerStdout).toContain('STEP_CONNECT_OK');
    expect(runnerStdout).toContain('STEP_SOCKET_OK');
    expect(runnerStdout).toContain('STEP_SSH_OK');
    expect(runnerStdout).toContain('STEP_DISCONNECT_OK');
    expect(runnerStdout).toContain('E2E_ALL_OK');
  });
});
