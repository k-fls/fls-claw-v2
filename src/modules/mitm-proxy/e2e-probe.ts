/**
 * Probe used by the mitm-proxy live-container e2e test
 * (`./e2e.test.ts`). At spawn time the test reads this file verbatim
 * and writes it into the snapshot at `agent-runner/src/index.ts`; the
 * container then runs `bun run /app/src/index.ts` and the
 * `import.meta.main` block at the bottom fires, writing a result JSON
 * into `/workspace/agent/result.json`.
 *
 * The data-gathering is split out into a pure `buildProbeResult(io)`
 * function so it can be unit-tested with synthetic IO in
 * `./e2e-probe.test.ts`. The bottom block only wires real IO and runs
 * when this file is the executable entry (Bun sets `import.meta.main`;
 * Vitest/Node leave it undefined, so importing the module for unit
 * tests is side-effect-free).
 */
import { execSync } from 'child_process';
import fs from 'fs';

const SUBSTITUTE_BASE = '/credentials/test-provider/substitute';
const CA_CERT_PATH = '/usr/local/share/ca-certificates/nanoclaw-mitm.crt';
const CA_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt';
const NSS_DB_DIR = '/home/node/.pki/nssdb';
const NSS_DB_FILE = `${NSS_DB_DIR}/cert9.db`;
const NSS_MITM_NICKNAME = 'nanoclaw-mitm-ca';
const CURL_BODY_FILE = '/tmp/out.body';
const RESULT_FILE = '/workspace/agent/result.json';

export interface CurlResult {
  /** 0 on curl success, curl's exit status otherwise. */
  code: number;
  /** HTTP status from `-w '%{http_code}'`, or 0 when curl failed before getting a response. */
  status: number;
  body: string;
}

export interface ProbeResult {
  uid: number;
  hostUidEnv: string | null;
  httpProxyEnv: string;
  mitmCaPathEnv: string | null;
  caCertMount: { exists: boolean; path: string };
  certCount: number;
  substitute: CurlResult;
  rejectProxy: CurlResult;
  rejectPath: CurlResult;
  external: CurlResult;
  /**
   * Transparent-mode probe: curl with --noproxy '*' to a made-up hostname
   * resolved to a literal IP via --resolve. HTTP_PROXY/HTTPS_PROXY are
   * NOT used; only the iptables OUTPUT/DNAT rule can route this to the
   * proxy. A 200 here proves the kernel-side DNAT path works end-to-end
   * (rule installed, packet rewritten, MITM cert verified against the
   * mounted CA, HostHandler invoked).
   */
  transparent: CurlResult;
  /**
   * Egress-lockdown probe: a direct (no-proxy) plain-HTTP connection to a
   * NON-allowlisted port (:80). The transparent DNAT only redirects :443, and
   * the lockdown firewall's OUTPUT allowlist permits only the proxy + host-rpc
   * ports — so a :80 connection to the internet is the cleanest signal of
   * whether the firewall is actually dropping:
   *   - lockdown ON  → OUTPUT default-DROP, no :80 rule → curl times out
   *     (`code` != 0, `status` 0).
   *   - lockdown OFF → open egress → curl connects (`status` != 0, e.g. 301).
   * Used to prove the firewall is live WITHOUT severing the proxy path (which
   * the substitute/transparent probes confirm still works).
   */
  blockedEgress: CurlResult;
  /**
   * NSS DB probe — verifies the entrypoint installed the MITM CA into
   * the Chromium/Firefox trust store at /home/node/.pki/nssdb. The DB
   * file must exist and `certutil -L` must list our nickname with the
   * "C,," (TLS-CA) trust string. Without this, Chromium running inside
   * the container hits MITM'd HTTPS with NET::ERR_CERT_AUTHORITY_INVALID.
   */
  nss: {
    dbExists: boolean;
    listOutput: string;
    /** True when `certutil -L` shows our nickname with C-flag trust. */
    mitmCaTrusted: boolean;
  };
  /**
   * Sync-action round-trip results (populated only in the real container by
   * `runSyncProbes`, not by `buildProbeResult`). These prove the
   * `get_credential` / `reload_auth_providers` path works through a real
   * container — i.e. the agent-runner client writes the request to the
   * bind-mounted `outbound.db`, the host-rpc `/action` doorbell resolves the
   * session from the caller IP, dispatches host-side, writes the result to the
   * bind-mounted `inbound.db`, and the client reads it back. The substitution
   * e2e above only covers the back-compat HTTP substitute endpoint, never this
   * transport. Optional because the unit test exercises `buildProbeResult` only.
   */
  syncGetCredential?: SyncGetCredentialResult;
  syncReload?: SyncReloadResult;
}

export interface SyncGetCredentialResult {
  ok: boolean;
  substitute?: string;
  providerId?: string;
  credentialPath?: string;
  envNames?: string[];
  error?: string;
}

export interface SyncReloadResult {
  ok: boolean;
  registered?: string[];
  rejected?: Array<{ id: string; reason: string }>;
  error?: string;
}

/**
 * IO surface the probe needs. Real impls in `realIO()`; the unit test
 * supplies fakes.
 */
export interface ProbeIO {
  /** Execute a shell command; throw on non-zero with `.status` on the error. */
  exec(cmd: string): string;
  /** Read a file as utf-8; throw if missing/unreadable. */
  readFile(path: string): string;
  fileExists(path: string): boolean;
  env: NodeJS.ProcessEnv;
  uid: number;
}

/**
 * Build a curl command line and run it. The probe writes the response
 * body to `/tmp/out.body` and prints the HTTP status code, so we get
 * both back in one shot.
 */
export function curlVia(io: ProbeIO, args: string[]): CurlResult {
  const cmd = ['curl', '-sS', '-o', CURL_BODY_FILE, '-w', "'%{http_code}'", ...args].join(' ');
  try {
    const out = io.exec(cmd);
    const status = parseInt(out.replace(/['"]/g, '').trim(), 10) || 0;
    let body = '';
    try {
      body = io.readFile(CURL_BODY_FILE);
    } catch {
      /* no body file — request failed before write */
    }
    return { code: 0, status, body };
  } catch (err: unknown) {
    let body = '';
    try {
      body = io.readFile(CURL_BODY_FILE);
    } catch {
      /* same */
    }
    const code = (err as { status?: number })?.status ?? -1;
    return { code, status: 0, body };
  }
}

/** Quote a string argument for the shell exactly once. */
function shq(s: string): string {
  // Single-quote and escape any embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildProbeResult(io: ProbeIO): ProbeResult {
  const proxy = io.env.HTTP_PROXY ?? '';
  const base = proxy + SUBSTITUTE_BASE;

  const substitute = curlVia(io, [shq(base + '?path=oauth')]);
  const rejectProxy = curlVia(io, [shq(base + '?path=oauth&envVar=HTTP_PROXY')]);
  const rejectPath = curlVia(io, [shq(base + '?path=oauth&envVar=PATH')]);

  const caCertMount = { exists: io.fileExists(CA_CERT_PATH), path: CA_CERT_PATH };

  let certCount = 0;
  try {
    const bundle = io.readFile(CA_BUNDLE_PATH);
    certCount = (bundle.match(/BEGIN CERTIFICATE/g) ?? []).length;
  } catch {
    /* bundle missing — leave count at 0 */
  }

  const external = curlVia(io, ['--max-time', '10', shq('https://example.com/')]);

  // Transparent-mode probe — must not use HTTP_PROXY/HTTPS_PROXY.
  // --noproxy '*' bypasses the env-var proxy entirely. --resolve pins
  // a fake hostname to a literal IP so curl sends SNI=mitm-test.local
  // (SNI is omitted for IP literals, which would dead-end at the
  // proxy's first-byte dispatch). The literal IP itself is meaningless
  // — the iptables DNAT rule rewrites destination on outbound :443
  // before the SYN leaves, redirecting the connection to the host
  // proxy regardless of where curl thinks it's connecting.
  const transparent = curlVia(io, [
    '--noproxy',
    "'*'",
    '--resolve',
    "'mitm-test.local:443:203.0.113.1'",
    '--max-time',
    '10',
    shq('https://mitm-test.local/transparent-probe'),
  ]);

  // Egress-lockdown probe — direct plain-HTTP to a non-allowlisted port (:80),
  // bypassing the proxy env entirely (--noproxy '*'). Neither the :443 DNAT nor
  // the lockdown OUTPUT allowlist covers this, so it succeeds only when egress
  // is open. Short timeout so the DROP case fails fast.
  const blockedEgress = curlVia(io, [
    '--noproxy',
    "'*'",
    '--max-time',
    '5',
    shq('http://example.com:80/blocked-egress-probe'),
  ]);

  // ── NSS DB probe (Chromium/Firefox browser trust) ─────────────────
  // `certutil -L -d sql:<dir>` prints one row per cert with the format
  //   <nickname>  <trust-flags>
  // where trust-flags is `<ssl>,<smime>,<codesign>` and "C" in the SSL
  // column means "trusted CA for SSL". A success row looks like:
  //   nanoclaw-mitm-ca                                             C,,
  const dbExists = io.fileExists(NSS_DB_FILE);
  let listOutput = '';
  let mitmCaTrusted = false;
  if (dbExists) {
    try {
      listOutput = io.exec(`certutil -L -d ${shq(`sql:${NSS_DB_DIR}`)}`);
      // Match the nickname followed by whitespace and a trust string whose
      // SSL column is C (alone or combined with c/T/P/u/w).
      const re = new RegExp(`^${NSS_MITM_NICKNAME}\\s+[CTPucwu]*C[CTPucwu]*,`, 'm');
      mitmCaTrusted = re.test(listOutput);
    } catch (err) {
      listOutput =
        (err as { stderr?: string; message?: string }).stderr ||
        (err as { message?: string }).message ||
        '<certutil failed>';
    }
  }

  return {
    uid: io.uid,
    hostUidEnv: io.env.HOST_UID ?? null,
    httpProxyEnv: proxy,
    mitmCaPathEnv: io.env.MITM_CA_PATH ?? null,
    caCertMount,
    certCount,
    substitute,
    rejectProxy,
    rejectPath,
    external,
    transparent,
    blockedEgress,
    nss: { dbExists, listOutput, mitmCaTrusted },
  };
}

/**
 * Drive the two sync actions through the **real** agent-runner client
 * (`./sync-action.js`) — the same code an agent's MCP tools call. This runs
 * only inside the container (Bun), so the bun:sqlite-backed DB modules are
 * pulled in via a dynamic import; a *variable* specifier keeps the host `tsc`
 * from trying to resolve a path that only exists in the agent-runner tree.
 * Each call is isolated so one failure still records a structured result.
 */
async function runSyncProbes(): Promise<{
  syncGetCredential: SyncGetCredentialResult;
  syncReload: SyncReloadResult;
}> {
  const moduleSpecifier = './sync-action.js';
  const { callSyncAction } = (await import(moduleSpecifier)) as {
    callSyncAction: (
      action: string,
      payload?: Record<string, unknown>,
      opts?: { timeoutMs?: number },
    ) => Promise<unknown>;
  };

  let syncGetCredential: SyncGetCredentialResult;
  try {
    const r = (await callSyncAction(
      'get_credential',
      { providerId: 'test-provider', credentialPath: 'oauth', envVar: 'SYNC_TOKEN' },
      { timeoutMs: 20_000 },
    )) as Omit<SyncGetCredentialResult, 'ok'>;
    syncGetCredential = { ok: true, ...r };
  } catch (err) {
    syncGetCredential = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let syncReload: SyncReloadResult;
  try {
    const r = (await callSyncAction('reload_auth_providers', {}, { timeoutMs: 20_000 })) as Omit<
      SyncReloadResult,
      'ok'
    >;
    syncReload = { ok: true, ...r };
  } catch (err) {
    syncReload = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { syncGetCredential, syncReload };
}

export function realIO(): ProbeIO {
  return {
    exec(cmd) {
      return execSync(cmd, { encoding: 'utf-8', timeout: 15_000 });
    },
    readFile(p) {
      return fs.readFileSync(p, 'utf-8');
    },
    fileExists(p) {
      return fs.existsSync(p);
    },
    env: process.env,
    uid: process.getuid?.() ?? -1,
  };
}

// Bun sets `import.meta.main` true when this file is the entry; Node /
// Vitest leave it undefined so unit tests can `import` from this
// module without firing the side effect.
if ((import.meta as unknown as { main?: boolean }).main) {
  void (async () => {
    const result = buildProbeResult(realIO());
    let sync: { syncGetCredential: SyncGetCredentialResult; syncReload: SyncReloadResult } = {
      syncGetCredential: { ok: false, error: 'probe did not run' },
      syncReload: { ok: false, error: 'probe did not run' },
    };
    try {
      sync = await runSyncProbes();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sync = { syncGetCredential: { ok: false, error: message }, syncReload: { ok: false, error: message } };
    }
    // Always write a result and exit 0 — a sync-probe failure is captured in the
    // payload, never left to hang the container (which would fail the e2e on
    // exitCode rather than on the specific assertion).
    fs.writeFileSync(RESULT_FILE, JSON.stringify({ ...result, ...sync }));
    process.exit(0);
  })();
}
