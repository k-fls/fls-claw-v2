/**
 * In-container e2e runner for ssh-auth.
 *
 * Mounted over `/app/src/index.ts` by `e2e.test.ts`. The image's
 * entrypoint.sh execs `bun run /app/src/index.ts`, so this is the only
 * patch the test injects — everything else (image, entrypoint, env wiring)
 * is unchanged from production.
 *
 * Drives the full SSH loop from inside the container:
 *   1. POST /ssh/connect      → host spawns ControlMaster, returns usage
 *   2. ls /ssh-sockets        → confirm the socket bind-mount is visible
 *   3. ssh _ whoami           → multiplexed command via ControlPath socket
 *   4. POST /ssh/disconnect   → host tears down ControlMaster
 *   5. ls /ssh-sockets        → confirm socket is gone
 *
 * Prints a single sentinel `E2E_ALL_OK` on success; exits non-zero with
 * a tagged stderr line on failure. The host test asserts on those.
 *
 * Env in: CLAW_HOST_RPC_URL, E2E_ALIAS, E2E_EXPECTED_USER.
 */
import { spawnSync } from 'child_process';

const hostRpcUrl = process.env.CLAW_HOST_RPC_URL;
const alias = process.env.E2E_ALIAS;
const expectedUser = process.env.E2E_EXPECTED_USER;

if (!hostRpcUrl || !alias || !expectedUser) {
  console.error('E2E_RUNNER_BAD_ENV');
  process.exit(10);
}

async function rpc(path: string, body: unknown): Promise<{ ok: boolean; result?: any; error?: string }> {
  const res = await fetch(`${hostRpcUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: any; error?: string };
}

function sh(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

const socketPath = `/ssh-sockets/${alias}.sock`;

try {
  // 1. Connect
  const connect = await rpc('/ssh/connect', { alias });
  if (!connect.ok || connect.result?.status !== 'ok') {
    console.error('E2E_CONNECT_FAILED', JSON.stringify(connect));
    process.exit(1);
  }
  console.log('STEP_CONNECT_OK');

  // 2. Socket visible
  const ls = sh('ls', ['/ssh-sockets/']);
  if (!ls.stdout.includes(`${alias}.sock`)) {
    console.error('E2E_SOCKET_MISSING', JSON.stringify(ls));
    process.exit(2);
  }
  console.log('STEP_SOCKET_OK');

  // 3. Multiplexed command
  const sshResult = sh('ssh', ['-o', `ControlPath=${socketPath}`, '_', 'whoami']);
  if (sshResult.code !== 0 || sshResult.stdout !== expectedUser) {
    console.error('E2E_SSH_FAILED', JSON.stringify(sshResult));
    process.exit(3);
  }
  console.log('STEP_SSH_OK');

  // 4. Disconnect
  const disconnect = await rpc('/ssh/disconnect', { alias });
  if (!disconnect.ok || disconnect.result?.status !== 'ok') {
    console.error('E2E_DISCONNECT_FAILED', JSON.stringify(disconnect));
    process.exit(4);
  }
  console.log('STEP_DISCONNECT_OK');

  // 5. Socket gone
  const lsAfter = sh('ls', ['/ssh-sockets/']);
  if (lsAfter.stdout.includes(`${alias}.sock`)) {
    console.error('E2E_SOCKET_STILL_PRESENT', JSON.stringify(lsAfter));
    process.exit(5);
  }
  console.log('STEP_DISCONNECT_SOCKET_GONE');

  console.log('E2E_ALL_OK');
  process.exit(0);
} catch (err) {
  console.error('E2E_UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
  process.exit(99);
}
