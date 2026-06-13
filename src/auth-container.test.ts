/**
 * Auth-container arg-building (pure part). The spawn itself drives Docker and
 * is exercised live (P5).
 */
import { describe, it, expect } from 'vitest';

import { buildAuthSpawnArgs, type AuthSpawnArgsInput } from './auth-container.js';
import type { LaunchMode } from './modules/container-bootstrap/index.js';

const rootDrop: LaunchMode = { kind: 'root-drop', envVars: { HOST_UID: '1000', HOST_GID: '1000' } };

function baseInput(over: Partial<AuthSpawnArgsInput> = {}): AuthSpawnArgsInput {
  return {
    containerName: 'nanoclaw-auth-test-1',
    ip: '172.29.0.7',
    mode: 'auth_login',
    nonce: 'nonce-xyz',
    rpcPort: 10254,
    launchMode: rootDrop,
    mounts: [
      { hostPath: '/snap/container/entrypoint.sh', containerPath: '/app/entrypoint.sh', readonly: true },
      { hostPath: '/snap/container/agent-runner/src', containerPath: '/app/src', readonly: true },
      {
        hostPath: '/snap/container/agent-runner/src/auth-runner.ts',
        containerPath: '/app/src/index.ts',
        readonly: true,
      },
      { hostPath: '/data/auth-spawns/test-1/claude', containerPath: '/home/node/.claude', readonly: false },
    ],
    image: 'nanoclaw-agent:latest',
    ...over,
  };
}

describe('buildAuthSpawnArgs', () => {
  it('sets the auth env + bridge network/IP', () => {
    const s = buildAuthSpawnArgs(baseInput()).join(' ');
    expect(s).toContain('--network nanoclaw --ip 172.29.0.7');
    expect(s).toContain('NANOCLAW_AUTH_MODE=auth_login');
    expect(s).toContain('NANOCLAW_AUTH_NONCE=nonce-xyz');
    expect(s).toContain('NANOCLAW_HOST_RPC_PORT=10254');
  });

  it('mounts the normal entrypoint with the auth-runner shimmed over /app/src/index.ts', () => {
    const args = buildAuthSpawnArgs(baseInput());
    expect(args.some((a) => a.endsWith('/container/entrypoint.sh:/app/entrypoint.sh:ro'))).toBe(true);
    expect(args.some((a) => a.endsWith('/auth-runner.ts:/app/src/index.ts:ro'))).toBe(true);
  });

  it('emits the proxy contribution (extraEnv incl. NO_PROXY + extraArgs), deduped against base flags', () => {
    // The proxy contribution carries HTTPS_PROXY/CA + NO_PROXY=host.docker.internal
    // (so the runner's host-rpc calls bypass the proxy) — passed via extraEnv.
    const s = buildAuthSpawnArgs(
      baseInput({
        extraEnv: {
          HTTPS_PROXY: 'http://host.docker.internal:42351',
          MITM_CA_PATH: '/ca.crt',
          NO_PROXY: 'host.docker.internal',
        },
        extraArgs: ['--cap-add=NET_ADMIN', '--security-opt=no-new-privileges'],
      }),
    );
    expect(s.join(' ')).toContain('HTTPS_PROXY=http://host.docker.internal:42351');
    expect(s.join(' ')).toContain('MITM_CA_PATH=/ca.crt');
    expect(s.join(' ')).toContain('NO_PROXY=host.docker.internal');
    expect(s.join(' ')).toContain('--cap-add=NET_ADMIN');
    // baseRunArgs already sets no-new-privileges; the dup is deduped.
    expect(s.filter((a) => a === '--security-opt=no-new-privileges')).toHaveLength(1);
  });

  it('applies root-drop privilege (user 0:0 + HOST_UID/GID)', () => {
    const s = buildAuthSpawnArgs(baseInput()).join(' ');
    expect(s).toContain('--user 0:0');
    expect(s).toContain('HOST_UID=1000');
    expect(s).toContain('HOST_GID=1000');
  });

  it('falls back to rootless --user when host ids are unknown', () => {
    const s = buildAuthSpawnArgs(baseInput({ launchMode: { kind: 'rootless', userArg: '501:20' } })).join(' ');
    expect(s).toContain('--user 501:20');
    expect(s).not.toContain('--user 0:0');
  });

  it('ends with the image tag', () => {
    const args = buildAuthSpawnArgs(baseInput());
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
  });
});
