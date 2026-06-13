/**
 * Observer contribution unit test.
 *
 * The observer pulls the bound port from the singleton proxy and
 * contributes env, mounts, args, and `needsRootEntrypoint`. We stub the
 * proxy + MITM CA so the test doesn't need real iptables, a listener, or
 * a cert file — just the shape of the contribution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { clearContainerLifecycleObservers, fireSpawnPre } from '../container-bootstrap/index.js';
import { CredentialProxy, setProxyInstance, clearProxyInstance } from './credential-proxy.js';
import type { AgentGroup, Session } from '../../types.js';

// Side-effect: registers the observer.
import './observer.js';

function fakeAgentGroup(): AgentGroup {
  return {
    id: 'ag-test',
    folder: 'test',
    name: 'test',
    workspace: '/tmp/ws',
    timezone: 'UTC',
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as AgentGroup;
}

function fakeSession(): Session {
  return { id: 'sess-1', agent_group_id: 'ag-test' } as unknown as Session;
}

// SpawnPreContext for the observer under test. providerName/containerConfig
// are required by the type but unused by the mitm observer.
function spawnCtx() {
  return {
    agentGroup: fakeAgentGroup(),
    session: fakeSession(),
    providerName: 'claude',
    containerConfig: { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] },
  };
}

describe('mitm-proxy observer', () => {
  let proxy: CredentialProxy;

  beforeEach(() => {
    proxy = new CredentialProxy();
    // Bypass start() — fake the bound port directly.
    (proxy as unknown as { _boundPort: number })._boundPort = 12345;
    setProxyInstance(proxy);
  });

  afterEach(() => {
    clearProxyInstance();
    // Don't clear lifecycle observers — they're module-load side effects
    // and a clear would leave subsequent tests with no observers and no
    // way to re-register them.
  });

  it('contributes proxy env, network caps, and root-entrypoint flag', () => {
    const merged = fireSpawnPre(spawnCtx());

    // Explicit-proxy env vars
    expect(merged.env.HTTP_PROXY).toBe('http://host.docker.internal:12345');
    expect(merged.env.HTTPS_PROXY).toBe('http://host.docker.internal:12345');
    // Transparent-mode iptables env vars (entrypoint.sh consumes these)
    expect(merged.env.PROXY_HOST).toBe('host.docker.internal');
    expect(merged.env.PROXY_PORT).toBe('12345');
    // Non-egress targets are exempted from proxying (host gateway + loopback).
    expect(merged.env.NO_PROXY).toBe('host.docker.internal,localhost,127.0.0.1,::1');
    expect(merged.env.no_proxy).toBe(merged.env.NO_PROXY);
    // Docker args for iptables + no-new-privileges
    expect(merged.args).toContain('--cap-add=NET_ADMIN');
    expect(merged.args).toContain('--security-opt=no-new-privileges');
    // Root-drop launch mode so entrypoint can install iptables + CA cert
    expect(merged.needsRootEntrypoint).toBe(true);
  });

  it('omits proxy env when no proxy instance is set', () => {
    clearProxyInstance();
    const merged = fireSpawnPre(spawnCtx());
    expect(merged.env.HTTP_PROXY).toBeUndefined();
    expect(merged.env.PROXY_HOST).toBeUndefined();
  });

  it('contributes a CA mount + cert env when MITM CA is available', () => {
    // The cert path is determined by getMitmCaCertPath(); it throws if the
    // CA was never created. We don't stub it — if it's available we should
    // see the mount; if not, the observer must still emit the rest.
    const merged = fireSpawnPre(spawnCtx());
    if (merged.env.MITM_CA_PATH) {
      expect(merged.env.NODE_EXTRA_CA_CERTS).toBe(merged.env.MITM_CA_PATH);
      expect(merged.env.SSL_CERT_FILE).toBe(merged.env.MITM_CA_PATH);
      expect(merged.mounts.length).toBeGreaterThan(0);
    } else {
      // CA not initialized — no mount, but PROXY_HOST/PORT still set.
      expect(merged.env.PROXY_HOST).toBe('host.docker.internal');
    }
  });
});
