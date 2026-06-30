/**
 * Live-container e2e test for the mitm-proxy substitution path.
 *
 * Spins up a real CredentialProxy + agent container and asserts the
 * substitute endpoint, reserved-env rejection, unknown-IP rejection,
 * MITM CA install, root-drop launch path, and HTTPS pass-through to a
 * real external host all work end-to-end.
 *
 * No OAuth — substitution-only. Covers system-CA trust + NSS browser
 * trust (Chromium/Firefox via /home/node/.pki/nssdb). Exercises both
 * the explicit-HTTP_PROXY path (substitute endpoint, external CONNECT)
 * and the transparent iptables DNAT path (curl with --noproxy hitting
 * a registered hostRule).
 *
 * Auto-skips when Docker or the agent image is unavailable. See sibling
 * `src/modules/container-bootstrap/e2e.test.ts` for the pattern this
 * file copies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import type { AgentGroup, Session } from '../../types.js';

// ---------------------------------------------------------------------------
// Mocks — set up before any imports that read DATA_DIR / GROUPS_DIR.
// The mitm-proxy observer now reads the bound port per-spawn from the
// proxy instance, so no static port mock is needed.
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

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    async ensureAgent() {}
    async applyContainerConfig() {
      return true;
    }
    async configureManualApproval() {}
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
  ensureContainerNetwork,
  initSnapshot,
  registerContainerLifecycleObserver,
  snapshotPath,
  type ExitContext,
} from '../container-bootstrap/index.js';
import { wakeContainer } from '../../container-runner.js';
import { startHostRpcServer, stopHostRpcServer } from '../host-rpc/server.js';

import { CredentialProxy, clearProxyInstance, setProxyInstance } from './credential-proxy.js';
import { groupDiscoveryDir, OAUTH_LOAD_REPORT_FILENAME } from './oauth/discovery-paths.js';
import { initTokenEngine, _resetTokenEngineForTests } from './token-substitute.js';
import { DEFAULT_SUBSTITUTE_CONFIG, asGroupScope } from './types.js';
import { registerCredentialProvider, _resetProviderRegistryForTests } from '../credentials/providers/registry.js';
import type { SubstitutingProvider } from './types.js';
import { defaultSubstitutes } from './defaults.js';
import type { Credential, CredentialScope, EngineCredentialResolver, GroupScope } from './types.js';
// Side-effect: registers the mitm-proxy observer (env + CA mount).
import './observer.js';
// Side-effects: register the host-rpc `/action` wakeup + the sync actions the
// probe exercises (get_credential, reload_auth_providers).
import '../sync-actions/index.js';
import './get-credential-action.js';
import './reload-providers-action.js';

// ---------------------------------------------------------------------------
// Skip predicates — same shape as the container-bootstrap e2e.
// ---------------------------------------------------------------------------

function imageAvailable(tag: string): boolean {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_IMAGE = imageAvailable(CONTAINER_IMAGE);
const RUN_E2E = HAVE_IMAGE;

// Egress lockdown is a sibling feature: its firewall is installed by an
// entrypoint block that only exists once that branch is composed in (the
// union). On the mitm branch alone, NANOCLAW_EGRESS_LOCKDOWN is a no-op, so the
// composition test below cannot pass — gate it on the enforcement actually
// being present in the entrypoint that the image is built from.
const HAS_EGRESS_LOCKDOWN = (() => {
  try {
    const entrypoint = fileURLToPath(new URL('../../../container/entrypoint.sh', import.meta.url));
    return fs.readFileSync(entrypoint, 'utf8').includes('NANOCLAW_EGRESS_LOCKDOWN');
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_GROUP_ID = 'ag-mitm-e2e';
const AGENT_GROUP_FOLDER = 'mitm-e2e';
const SESSION_ID = 'sess-mitm-e2e';
// The proxy resolves a container's source IP to its agent-group **folder**
// (the canonical credential scope), so substitutes are minted/stored under it.
const SCOPE: GroupScope = asGroupScope(AGENT_GROUP_FOLDER);
const PROVIDER_ID = 'test-provider';
const REAL_TOKEN = 'tkn_ThisIsTheRealTokenValueForE2eTestingAbCdEfGhIjKlMnOpQrSt';
const CREDENTIAL_PATH = 'oauth';

function mkAgentGroup(): AgentGroup {
  return {
    id: AGENT_GROUP_ID,
    name: 'mitm-e2e',
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

// In-memory resolver — returns a single known credential under
// (SCOPE, PROVIDER_ID, 'oauth'). Anything else resolves to null.
function makeStubResolver(): EngineCredentialResolver {
  return {
    resolve(credScope: CredentialScope, providerId: string, credentialId: string): Credential | null {
      if (
        (credScope as unknown as string) === (SCOPE as unknown as string) &&
        providerId === PROVIDER_ID &&
        credentialId === 'oauth'
      ) {
        return { value: REAL_TOKEN, updated_ts: Date.now() };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Probe — read verbatim from `./e2e-probe.ts` at suite-setup time and
// written into the snapshot's agent-runner index.ts. Lives in its own
// file so its data-gathering logic can be unit-tested independently
// (`./e2e-probe.test.ts`). When Bun runs it as the container entry,
// `import.meta.main` is true and the bottom block fires.
// ---------------------------------------------------------------------------

const PROBE_SOURCE = fs.readFileSync(new URL('./e2e-probe.ts', import.meta.url), 'utf-8');

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

let proxy: CredentialProxy | null = null;
let proxyServer: import('net').Server | null = null;
let boundProxyPort = 0;
let hostRpcStarted = false;
let prevHostRpcPortEnv: string | undefined;

// Unique id per call: the registry rejects duplicate ids and has no
// unregister-by-id, and the suite intentionally never clears it (that would
// drop the side-effect-registered mitm/ip/egress observers). A stale observer
// from an earlier test firing on a later exit is harmless — `resolve` is
// idempotent once its promise has settled.
let awaitExitSeq = 0;

function waitForExit(): Promise<ExitContext> {
  return new Promise((resolve) => {
    registerContainerLifecycleObserver(`test-await-exit-${awaitExitSeq++}`, {
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
  initSessionFolder(group.id, SESSION_ID);
}

function groupResultPath(): string {
  return path.join(TMP_GROUPS(), AGENT_GROUP_FOLDER, 'result.json');
}

function readProbeResult(): Record<string, unknown> {
  const p = groupResultPath();
  expect(fs.existsSync(p)).toBe(true);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_E2E)('mitm-proxy — live container', () => {
  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-e2e-'));
    setupCentralDb();
    initSnapshot();
    // Docker bridge network the container-runner attaches every spawn to.
    // Normally created by `src/index.ts` at host startup; the test boots
    // a subset of the host, so create it explicitly. Idempotent.
    ensureContainerNetwork();
    fs.writeFileSync(snapshotPath('agent-runner/src/index.ts'), PROBE_SOURCE);
    setupAgentGroup();

    // Wire the token engine with an in-memory resolver factory.
    _resetTokenEngineForTests();
    initTokenEngine(() => makeStubResolver());

    // Register the test provider in the credentials registry, then build
    // the proxy. `start()` runs an initial `rebuildIndex()` which picks
    // up the registration.
    _resetProviderRegistryForTests();
    const testProvider: SubstitutingProvider = {
      id: PROVIDER_ID,
      buildManifest: () => [],
      onManifestWritten: () => {},
      onManifestDeleted: () => {},
      substitutes: defaultSubstitutes({
        substituteConfig: DEFAULT_SUBSTITUTE_CONFIG,
        envBindings: [{ envName: 'TEST_TOKEN', credentialPath: CREDENTIAL_PATH }],
        // Transparent-mode probe target. The handler responds directly
        // (no upstreaming) — we just need to know the proxy intercepted.
        // Anchor for /^mitm-test\.local$/ resolves to "mitm-test.local".
        hostRules: [
          {
            hostPattern: /^mitm-test\.local$/,
            pathPattern: /^\//,
            handler: async (_clientReq, clientRes, targetHost, _targetPort, scope) => {
              clientRes.writeHead(200, { 'content-type': 'application/json' });
              clientRes.end(
                JSON.stringify({
                  intercepted: true,
                  host: targetHost,
                  scope: scope as unknown as string,
                }),
              );
            },
          },
        ],
      }),
    };
    registerCredentialProvider(testProvider);
    proxy = new CredentialProxy();
    setProxyInstance(proxy);

    // Bind on 0.0.0.0 so both `host.docker.internal` (from the container)
    // and host loopback (case 3 — host-side unknown-IP fetch) reach the
    // same server. Port defaults to 0 — OS-assigned, then the observer
    // reads `getBoundPort()` per spawn.
    proxyServer = await proxy.start({ host: '0.0.0.0' });
    boundProxyPort = proxy.getBoundPort();

    // Host-rpc server for the sync-action probe. Bind 0.0.0.0 (like the proxy)
    // so the container reaches it via host.docker.internal. startHostRpcServer
    // echoes back the *requested* port (it doesn't read the OS-assigned one),
    // so pin an explicit free port rather than asking for 0. Publish it through
    // NANOCLAW_HOST_RPC_PORT so container-runner injects the matching value into
    // the spawn (hostRpcPort() reads the env).
    prevHostRpcPortEnv = process.env.NANOCLAW_HOST_RPC_PORT;
    let rpcPort = 0;
    for (let port = 27400; port < 27500; port++) {
      try {
        await startHostRpcServer({ port, bind: '0.0.0.0' });
        rpcPort = port;
        break;
      } catch {
        /* port in use — try the next */
      }
    }
    if (rpcPort === 0) throw new Error('no free port for host-rpc server');
    process.env.NANOCLAW_HOST_RPC_PORT = String(rpcPort);
    hostRpcStarted = true;
  }, 60_000);

  afterAll(async () => {
    if (hostRpcStarted) {
      await stopHostRpcServer();
      hostRpcStarted = false;
    }
    if (prevHostRpcPortEnv === undefined) delete process.env.NANOCLAW_HOST_RPC_PORT;
    else process.env.NANOCLAW_HOST_RPC_PORT = prevHostRpcPortEnv;
    if (proxyServer) {
      await new Promise<void>((r) => proxyServer!.close(() => r()));
      proxyServer = null;
    }
    clearProxyInstance();
    _resetTokenEngineForTests();
    _resetProviderRegistryForTests();
    closeDb();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        try {
          execSync(`docker run --rm -v ${tmpRoot}:/cleanup alpine sh -c 'rm -rf /cleanup/*'`, { stdio: 'pipe' });
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* leave tmp dir */
        }
      }
    }
  });

  beforeEach(() => {
    // Don't clear the lifecycle observer registry — the mitm-proxy and
    // ip-observer registrations are side-effect-only at module import,
    // so a clear would leave us with no observers and no easy way back.
    // The two tests below are independent enough that residual state
    // from earlier exits doesn't matter.
    const prev = groupResultPath();
    if (fs.existsSync(prev)) fs.unlinkSync(prev);
  });

  it('substitute endpoint, reserved-env rejection, CA install, root-drop, external pass-through', async () => {
    const exited = waitForExit();
    const ok = await wakeContainer(mkSession());
    expect(ok).toBe(true);
    const exit = await exited;
    expect(exit.reason).toBe('normal');
    expect(exit.exitCode).toBe(0);

    const probe = readProbeResult() as {
      uid: number;
      hostUidEnv: string | null;
      httpProxyEnv: string;
      mitmCaPathEnv: string | null;
      caCertMount: { exists: boolean; path: string };
      certCount: number;
      substitute: { status: number; body: string };
      rejectProxy: { status: number; body: string };
      rejectPath: { status: number; body: string };
      external: { status: number; body: string };
      transparent: { status: number; body: string };
      blockedEgress: { status: number; code: number; body: string };
      nss: { dbExists: boolean; listOutput: string; mitmCaTrusted: boolean };
    };

    // ── (1) Substitute endpoint reachable + body shape ────────────────
    expect(probe.httpProxyEnv).toMatch(new RegExp(`:${boundProxyPort}$`));
    expect(probe.substitute.status).toBe(200);
    const subBody = JSON.parse(probe.substitute.body) as {
      substitute: string;
      providerId: string;
      credentialPath: string;
      envNames: string[];
    };
    expect(subBody.providerId).toBe(PROVIDER_ID);
    expect(subBody.credentialPath).toBe(CREDENTIAL_PATH);
    expect(subBody.envNames).toEqual(['TEST_TOKEN']);
    expect(typeof subBody.substitute).toBe('string');
    expect(subBody.substitute.length).toBe(REAL_TOKEN.length);
    expect(subBody.substitute).not.toBe(REAL_TOKEN);
    // Prefix preserved per DEFAULT_SUBSTITUTE_CONFIG (prefixLen=10).
    expect(subBody.substitute.slice(0, DEFAULT_SUBSTITUTE_CONFIG.prefixLen)).toBe(
      REAL_TOKEN.slice(0, DEFAULT_SUBSTITUTE_CONFIG.prefixLen),
    );
    // Suffix preserved (suffixLen=4).
    expect(subBody.substitute.slice(-DEFAULT_SUBSTITUTE_CONFIG.suffixLen)).toBe(
      REAL_TOKEN.slice(-DEFAULT_SUBSTITUTE_CONFIG.suffixLen),
    );

    // ── (2) Reserved env-var rejection ────────────────────────────────
    expect(probe.rejectProxy.status).toBe(400);
    expect(probe.rejectProxy.body).toMatch(/Reserved env var name/);
    expect(probe.rejectPath.status).toBe(400);
    expect(probe.rejectPath.body).toMatch(/Reserved env var name/);

    // ── (4) MITM CA mount + system-store install ─────────────────────
    expect(probe.mitmCaPathEnv).toBe('/usr/local/share/ca-certificates/nanoclaw-mitm.crt');
    expect(probe.caCertMount.exists).toBe(true);
    // Base image ships well over 100 CA certs from ca-certificates;
    // update-ca-certificates must have run without clobbering them.
    expect(probe.certCount).toBeGreaterThan(100);

    // ── (5) Root-drop path engaged ────────────────────────────────────
    // The mitm-proxy observer sets needsRootEntrypoint when the CA is
    // mounted. HOST_UID env reaches the container; entrypoint setpriv's
    // to it before exec-ing bun.
    const hostUid = process.getuid?.() ?? -1;
    if (hostUid >= 0) {
      expect(probe.hostUidEnv).toBe(String(hostUid));
      expect(probe.uid).toBe(hostUid);
    }

    // ── (5a) NSS browser trust (Chromium/Firefox) ─────────────────────
    // Entrypoint creates the NSS shared SQL DB at /home/node/.pki/nssdb
    // and imports the MITM CA with `certutil -A -t "C,,"`. Without this,
    // Chromium inside the container hits MITM'd HTTPS with
    // NET::ERR_CERT_AUTHORITY_INVALID.
    expect(probe.nss.dbExists).toBe(true);
    expect(probe.nss.mitmCaTrusted).toBe(true);
    expect(probe.nss.listOutput).toMatch(/nanoclaw-mitm-ca/);

    // ── (5b) Transparent (iptables DNAT) interception ─────────────────
    // The probe used curl --noproxy '*' so HTTP_PROXY/HTTPS_PROXY were
    // bypassed. The only way the connection reached our proxy is via the
    // iptables OUTPUT/DNAT rule installed by the entrypoint. A 200 with
    // the handler's intercepted=true body proves the full path:
    //   container syscall → iptables -t nat -A OUTPUT DNAT → host proxy
    //   → SNI parse (mitm-test.local) → forged cert (CA-signed) → MITM
    //   dispatcher → hostRule handler → response.
    expect(probe.transparent.status).toBe(200);
    const transparentBody = JSON.parse(probe.transparent.body) as {
      intercepted: boolean;
      host: string;
      scope: string;
    };
    expect(transparentBody.intercepted).toBe(true);
    expect(transparentBody.host).toBe('mitm-test.local');
    expect(transparentBody.scope).toBe(AGENT_GROUP_FOLDER);

    // ── (6) External HTTPS pass-through (CONNECT tunnel, not MITM) ────
    // Soft-skip when there's no outbound network; the other cases stand
    // on their own.
    if (probe.external.status === 0) {
      // Network unavailable — log via expect message and move on.
      // eslint-disable-next-line no-console
      console.warn('mitm-proxy e2e: skipping external HTTPS check (no outbound network)');
    } else {
      expect(probe.external.status).toBe(200);
      expect(probe.external.body.length).toBeGreaterThan(100);
      expect(probe.external.body).toMatch(/Example Domain/);
    }

    // ── (7) Open-egress baseline (no lockdown) ───────────────────────
    // Without the firewall, a direct (no-proxy) :80 connection to a
    // non-allowlisted host connects. The lockdown test below asserts this
    // exact probe is dropped — together they prove the firewall is the cause.
    // Soft-skip when there's no outbound network.
    if (probe.external.status !== 0) {
      expect(probe.blockedEgress.status).not.toBe(0);
    }
  }, 180_000);

  it.skipIf(!HAS_EGRESS_LOCKDOWN)(
    'egress lockdown composes with the mitm proxy: firewall enforced, proxy path intact',
    async () => {
      // Both features want the root entrypoint and both install iptables rules
      // (mitm: nat-table :443 DNAT → proxy; lockdown: filter-table OUTPUT
      // default-DROP). They compose only because the lockdown allowlist permits
      // exactly the proxy hop the DNAT redirects to (HTTPS_PROXY == DNAT target,
      // both set by the mitm observer). This test proves that composition live.
      const prev = process.env.NANOCLAW_EGRESS_LOCKDOWN;
      process.env.NANOCLAW_EGRESS_LOCKDOWN = 'true';
      try {
        const exited = waitForExit();
        const ok = await wakeContainer(mkSession());
        expect(ok).toBe(true);
        const exit = await exited;
        // The firewall must not break the agent's own startup / probe run.
        expect(exit.reason).toBe('normal');
        expect(exit.exitCode).toBe(0);

        const probe = readProbeResult() as {
          substitute: { status: number; body: string };
          transparent: { status: number; body: string };
          external: { status: number; body: string };
          blockedEgress: { status: number; code: number; body: string };
        };

        // Composition: the lockdown OUTPUT allowlist permits the proxy hop, so
        // both the explicit-proxy substitute endpoint AND the transparent :443
        // DNAT path still reach the proxy *through* the firewall.
        expect(probe.substitute.status).toBe(200);
        expect(probe.transparent.status).toBe(200);
        const tb = JSON.parse(probe.transparent.body) as { intercepted: boolean };
        expect(tb.intercepted).toBe(true);

        // External HTTPS still works — but only because it is tunneled via the
        // proxy (:443 DNAT → allowlisted proxy port), never direct egress.
        // Soft-skip when there's no outbound network.
        if (probe.external.status !== 0) {
          expect(probe.external.status).toBe(200);
        }

        // Firewall is actually enforcing: a direct (no-proxy) :80 connection to a
        // non-allowlisted destination is dropped → curl times out (status 0).
        expect(probe.blockedEgress.status).toBe(0);
        expect(probe.blockedEgress.code).not.toBe(0);
      } finally {
        if (prev === undefined) delete process.env.NANOCLAW_EGRESS_LOCKDOWN;
        else process.env.NANOCLAW_EGRESS_LOCKDOWN = prev;
      }
    },
    180_000,
  );

  it('get_credential + reload_auth_providers round-trip through the real container', async () => {
    // Declare a per-group provider so the reload has something to install. The
    // host reload handler reads this same path; the container only triggers it.
    const ACME_ID = 'acme-e2e';
    const discDir = groupDiscoveryDir(AGENT_GROUP_FOLDER);
    fs.mkdirSync(discDir, { recursive: true });
    fs.writeFileSync(
      path.join(discDir, `${ACME_ID}.json`),
      JSON.stringify({
        api_base_url: 'https://api.acme-e2e.test',
        _env_vars: { ACME_E2E_TOKEN: 'api_key' },
      }),
    );

    try {
      const exited = waitForExit();
      const ok = await wakeContainer(mkSession());
      expect(ok).toBe(true);
      const exit = await exited;
      expect(exit.reason).toBe('normal');
      expect(exit.exitCode).toBe(0);

      const probe = readProbeResult() as {
        syncGetCredential: {
          ok: boolean;
          substitute?: string;
          providerId?: string;
          credentialPath?: string;
          envNames?: string[];
          error?: string;
        };
        syncReload: { ok: boolean; registered?: string[]; rejected?: unknown[]; error?: string };
      };

      // ── get_credential: full sync-action round-trip through the container ──
      // Proves: agent-runner client → outbound.db (bind mount) → host-rpc
      // /action doorbell → session resolved from caller IP → host dispatch →
      // inbound.db (bind mount, journal_mode=DELETE cross-mount visibility) →
      // client read-back. The HTTP substitute endpoint never touches this path.
      expect(probe.syncGetCredential.ok, `get_credential error: ${probe.syncGetCredential.error}`).toBe(true);
      expect(probe.syncGetCredential.providerId).toBe(PROVIDER_ID);
      expect(probe.syncGetCredential.credentialPath).toBe(CREDENTIAL_PATH);
      const sub = probe.syncGetCredential.substitute as string;
      expect(typeof sub).toBe('string');
      expect(sub.length).toBe(REAL_TOKEN.length);
      expect(sub).not.toBe(REAL_TOKEN); // placeholder, not the real secret
      expect(sub.slice(0, DEFAULT_SUBSTITUTE_CONFIG.prefixLen)).toBe(
        REAL_TOKEN.slice(0, DEFAULT_SUBSTITUTE_CONFIG.prefixLen),
      );
      // Provider binding name + the name requested via the tool's envVar arg.
      expect(probe.syncGetCredential.envNames).toContain('TEST_TOKEN');
      expect(probe.syncGetCredential.envNames).toContain('SYNC_TOKEN');

      // ── reload_auth_providers: mid-session reload via the same transport ──
      expect(probe.syncReload.ok, `reload error: ${probe.syncReload.error}`).toBe(true);
      expect(probe.syncReload.registered).toContain(ACME_ID);

      // The host reload handler wrote the load report back into the group dir.
      const reportPath = path.join(discDir, OAUTH_LOAD_REPORT_FILENAME);
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as { registered: string[] };
      expect(report.registered).toContain(ACME_ID);
    } finally {
      fs.rmSync(discDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('rejects request from unknown IP (host-side fetch)', async () => {
    // The proxy is still bound; fire a direct request to the substitute
    // endpoint from the test host process. Host loopback is not in the
    // container-IP allocator, so validateCaller resolves to null → 403.
    const res = await fetch(`http://127.0.0.1:${boundProxyPort}/credentials/${PROVIDER_ID}/substitute?path=oauth`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toMatch(/unknown container/);
  });
});
