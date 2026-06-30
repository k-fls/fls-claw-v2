/**
 * SSH subsystem initialization.
 *
 * Registers the 'ssh' and 'pem-passwords' CredentialProviders, builds the
 * process-singleton SSHManager wired to v2's per-agent-group resolver
 * factory + grant primitives, and registers the `/ssh` host-rpc handler.
 *
 * Called once at module load via the barrel `index.ts`.
 */
import fs from 'fs';

import { log } from '../../log.js';
import {
  canAccess,
  getBorrowSource,
  getOrCreateResolverForAgentGroup,
  asGroupScope,
  noManifestSideEffect,
  readKeysFile,
  registerCredentialProvider,
  type CredentialResolver as V2CredentialResolver,
  type CredentialScope,
  type GroupScope,
} from '../credentials/index.js';
import { getHostRpcAddress, registerHostRpc } from '../host-rpc/index.js';
import { registerAgentGroupContribution } from '../../agent-group-contributions.js';
import { registerContainerLifecycleObserver } from '../container-bootstrap/index.js';
import { FatalSpawnError } from '../../spawn-failure.js';
import { socketDir } from './manager.js';
import { SSH_PROVIDER_ID, PEM_PASSWORDS_PROVIDER_ID } from './types.js';
import { SSHManager } from './manager.js';
import type { CredentialResolver as SSHResolver } from './manager.js';
import { makeSSHRpcHandler } from './rpc.js';
import { prunePendingForSession } from './pending.js';

// ── Singleton ─────────────────────────────────────────────────────

let _sshManager: SSHManager | null = null;

export function getSSHManager(): SSHManager {
  if (!_sshManager) throw new Error('SSH manager not initialized');
  return _sshManager;
}

// ── Resolver adapter ──────────────────────────────────────────────

/**
 * Adapt a v2 `CredentialResolver` (whose `store` takes
 * (scope, providerId, id, cred)) into the v1-shape interface SSHManager
 * and the SSH proxy handlers consume (`store` takes (providerId, scope,
 * id, cred)). Keeps the SSH module body byte-identical to the fork.
 */
function adaptResolver(v2: V2CredentialResolver): SSHResolver {
  return {
    resolve: (scope, providerId, id) => v2.resolve(scope, providerId, id),
    store: (providerId, scope, id, cred) => v2.store(scope, providerId, id, cred),
    unloadCache: (scope, providerId) => v2.unloadCache(scope, providerId),
    delete: (scope, providerId) => v2.delete(scope, providerId),
  };
}

/**
 * Production resolver: routes each call to the v2 per-agent-group resolver
 * keyed by the scope it operates on. Borrow-source / canAccess checks live
 * in SSHManager's `resolveCredentialScope`, which calls `resolve` against
 * either the borrower's scope or the source scope explicitly — both
 * legitimate `ownFolder` values for `getOrCreateResolverForAgentGroup`.
 */
function makeProductionResolver(): SSHResolver {
  return {
    resolve(scope, providerId, id) {
      return adaptResolver(getOrCreateResolverForAgentGroup(scope as unknown as string)).resolve(scope, providerId, id);
    },
    store(providerId, scope, id, cred) {
      adaptResolver(getOrCreateResolverForAgentGroup(scope as unknown as string)).store(providerId, scope, id, cred);
    },
    unloadCache(scope, providerId) {
      if (!scope) return;
      adaptResolver(getOrCreateResolverForAgentGroup(scope as unknown as string)).unloadCache?.(scope, providerId);
    },
    delete(scope, providerId) {
      adaptResolver(getOrCreateResolverForAgentGroup(scope as unknown as string)).delete?.(scope, providerId);
    },
  };
}

// ── Manifest providers ────────────────────────────────────────────

/**
 * SSH manifest builder: enriches entries with connection metadata from
 * authFields, excluding publicKey and hostKey (agent retrieves those
 * explicitly via ssh_request_credential).
 */
function sshBuildManifest(credentialScope: CredentialScope): string[] {
  const keys = readKeysFile(credentialScope, SSH_PROVIDER_ID);
  const lines: string[] = [];
  for (const [id, entry] of Object.entries(keys)) {
    if (id === 'v') continue;
    if (!entry || typeof entry !== 'object' || !('value' in entry)) continue;
    const af = (entry as { authFields?: Record<string, string> }).authFields;
    if (!af?.host) continue;
    const obj: Record<string, string | number> = {
      provider: SSH_PROVIDER_ID,
      name: id,
      credScope: credentialScope as unknown as string,
      host: af.host,
      port: parseInt(af.port, 10) || 22,
      username: af.username,
    };
    lines.push(JSON.stringify(obj));
  }
  return lines;
}

// Mirroring a scope's own manifest into its group folder (for container
// visibility at /workspace/agent/credentials/manifests/) is now done generically
// by the manifest pipeline for every provider — see mirrorManifestToOwnGroupDir
// in credentials/manifest.ts. SSH no longer needs a bespoke onManifestWritten
// hook; it uses the shared no-op like every other provider.

// ── Initialization ────────────────────────────────────────────────

let initialized = false;

/**
 * Initialize the SSH subsystem. The 0-arg form wires production defaults
 * (per-agent-group resolver from credentials/index.ts, canAccess and
 * getBorrowSource for access/source resolution). The 4-arg legacy form
 * accepts injected resolver / groupResolver / accessCheck for tests —
 * the proxy argument is accepted for v1-shape compatibility but ignored
 * (v2 routes through host-rpc, not the v1 credential-proxy).
 */
export function initSSHSystem(): SSHManager;
export function initSSHSystem(
  injectedResolver: SSHResolver,
  groupResolver: (scope: GroupScope) => { containerConfig?: { credentialSource?: string } } | undefined,
  accessCheck: (borrower: GroupScope, grantor: CredentialScope) => boolean,
  _proxy: unknown,
): SSHManager;
export function initSSHSystem(
  injectedResolver?: SSHResolver,
  groupResolver?: (scope: GroupScope) => { containerConfig?: { credentialSource?: string } } | undefined,
  accessCheck?: (borrower: GroupScope, grantor: CredentialScope) => boolean,
  _proxy?: unknown,
): SSHManager {
  if (_sshManager) return _sshManager;

  // Startup sweep: clean stale sockets
  SSHManager.startupSweep();

  const resolver = injectedResolver ?? makeProductionResolver();

  const sshManager = new SSHManager(resolver);
  // Plumb in v2 substrate equivalents of v1's bilateral access check
  // and group-source resolver. Both arguments to canAccess are scope
  // strings — GroupScope and CredentialScope are both branded strings
  // and the underlying folder names match.
  sshManager.setAccessCheck(
    accessCheck ?? ((borrower, grantor) => canAccess(borrower as unknown as string, grantor as unknown as string)),
  );
  sshManager.setGroupResolver(
    groupResolver ??
      ((scope: GroupScope) => {
        const src = getBorrowSource(scope as unknown as string);
        return src ? { containerConfig: { credentialSource: src } } : undefined;
      }),
  );

  _sshManager = sshManager;

  // Register the `/ssh` host-rpc handler (proxy)
  registerHostRpc('/ssh', makeSSHRpcHandler(sshManager, resolver));

  log.info('SSH subsystem initialized');
  return sshManager;
}

export function registerSSHProviders(): void {
  if (initialized) return;
  initialized = true;

  // A3 contribution: bind-mount the per-scope socket directory at
  // /ssh-sockets inside every container, and expose the host-rpc URL.
  registerAgentGroupContribution('ssh-auth', ({ agentGroup }) => {
    const scope = asGroupScope(agentGroup.folder);
    const hostPath = socketDir(scope);
    // Ensure the directory exists with 0700 so the bind mount can be
    // applied even on first connect; SSHManager.doConnect will mkdir
    // it as well, but doing it here avoids a docker-side bind error on
    // a brand-new agent group whose first SSH call hasn't fired yet.
    try {
      fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
    } catch {}
    const addr = getHostRpcAddress();
    if (!addr) {
      throw new FatalSpawnError(
        'ssh-auth: host-rpc server is not running — refusing to spawn container without CLAW_HOST_RPC_URL',
      );
    }
    return {
      // Containers reach host-rpc via the host.docker.internal hostname (mapped
      // by --add-host per CLAW_HOST_NET_MODE), NOT addr.bind — the bind may be
      // 0.0.0.0 (open mode), which is unconnectable. Only the port comes from
      // the running server. (host-rpc bug #9)
      env: { CLAW_HOST_RPC_URL: `http://host.docker.internal:${addr.port}` },
      mounts: [{ hostPath, containerPath: '/ssh-sockets', readonly: false }],
    };
  });

  // Container-exit teardown: drop ControlMaster sockets and any pending
  // SSH credential requests issued from this session that can no longer
  // be delivered.
  registerContainerLifecycleObserver('ssh-auth', {
    onContainerExited(ctx) {
      const scope = asGroupScope(ctx.agentGroup.folder);
      try {
        getSSHManager().disconnectAll(scope);
      } catch {
        // Manager may not be initialized in test harnesses.
      }
      prunePendingForSession(scope, ctx.session.id);
    },
  });

  registerCredentialProvider({
    id: SSH_PROVIDER_ID,
    buildManifest: sshBuildManifest,
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
  });

  registerCredentialProvider({
    id: PEM_PASSWORDS_PROVIDER_ID,
    buildManifest: () => [],
    onManifestWritten: noManifestSideEffect,
    onManifestDeleted: noManifestSideEffect,
  });
}
