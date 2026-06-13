/**
 * Unit tests for the mitm-proxy e2e probe. Exercises
 * `buildProbeResult` and `curlVia` with synthetic IO so the data-
 * gathering logic is covered without needing a Docker container.
 *
 * The live-container test (`./e2e.test.ts`) only checks that the
 * compiled+wired probe produces *some* result and the *content* lines
 * up with the proxy's responses — the shape and per-field plumbing is
 * what's pinned here.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildProbeResult, curlVia, type ProbeIO } from './e2e-probe.js';

/** Build a configurable in-memory IO. */
function mkIO(opts: {
  files?: Record<string, string>;
  /** Hook called for each `exec(cmd)` — returns stdout, or throws to simulate non-zero exit. */
  exec?: (cmd: string) => string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
}): ProbeIO {
  const files = { ...(opts.files ?? {}) };
  return {
    exec: opts.exec ?? (() => ''),
    readFile(p) {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    fileExists(p) {
      return p in files;
    },
    env: opts.env ?? {},
    uid: opts.uid ?? 1000,
  };
}

describe('curlVia', () => {
  it('parses HTTP status from the -w trailer and reads the body file', () => {
    const exec = vi.fn().mockImplementation((cmd: string) => {
      expect(cmd).toMatch(/^curl /);
      // Our curlVia helper writes the body to /tmp/out.body and prints status.
      return "'200'";
    });
    const io = mkIO({
      exec,
      files: { '/tmp/out.body': '{"ok":true}' },
    });

    const r = curlVia(io, ["'https://example/x'"]);
    expect(r).toEqual({ code: 0, status: 200, body: '{"ok":true}' });
    expect(exec).toHaveBeenCalledOnce();
  });

  it('reports curl failure via .code and still surfaces partial body when present', () => {
    const exec = vi.fn().mockImplementation(() => {
      const err = new Error('curl exited 7') as Error & { status: number };
      err.status = 7;
      throw err;
    });
    const io = mkIO({
      exec,
      files: { '/tmp/out.body': 'partial' },
    });

    const r = curlVia(io, ["'https://nope/'"]);
    expect(r).toEqual({ code: 7, status: 0, body: 'partial' });
  });

  it('returns empty body when the body file is missing', () => {
    const exec = vi.fn().mockReturnValue("'500'");
    const io = mkIO({ exec });
    const r = curlVia(io, ["'https://x/'"]);
    expect(r).toEqual({ code: 0, status: 500, body: '' });
  });

  it('strips surrounding quotes from the http_code trailer', () => {
    const exec = vi.fn().mockReturnValue('"404"');
    const io = mkIO({ exec, files: { '/tmp/out.body': 'nope' } });
    expect(curlVia(io, ['x']).status).toBe(404);
  });
});

describe('buildProbeResult', () => {
  // ── Programmable exec: routes each curl by URL fragment so we can pin
  // ── exactly what each of the four requests gets back.
  function mkExec(responses: {
    substitute?: { status: number; body: string };
    rejectProxy?: { status: number; body: string };
    rejectPath?: { status: number; body: string };
    external?: { status: number; body: string } | { fail: true };
    transparent?: { status: number; body: string } | { fail: true };
    blockedEgress?: { status: number; body: string } | { fail: true };
  }) {
    return (cmd: string) => {
      // The NSS-DB probe runs `certutil -L`. It returns the cert-list
      // text directly (not via /tmp/out.body) and is exercised in a
      // dedicated test below; here, simulate the "DB missing" case so
      // existing curl-focused assertions stay unchanged.
      if (cmd.startsWith('certutil ')) {
        return '';
      }
      // Each curl writes to /tmp/out.body. We use closure on `files` to
      // simulate that by stashing the body in the read-side state.
      const url = cmd.match(/'([^']+)'/g)?.slice(-1)[0] ?? '';
      let resp: { status: number; body: string } | undefined;

      if (url.includes('envVar=HTTP_PROXY')) resp = responses.rejectProxy;
      else if (url.includes('envVar=PATH')) resp = responses.rejectPath;
      else if (url.includes('mitm-test.local')) {
        if (responses.transparent && 'fail' in responses.transparent) {
          const err = new Error('connect refused') as Error & { status: number };
          err.status = 7;
          throw err;
        }
        resp = responses.transparent as { status: number; body: string } | undefined;
      } else if (url.includes('blocked-egress')) {
        if (responses.blockedEgress && 'fail' in responses.blockedEgress) {
          const err = new Error('timed out') as Error & { status: number };
          err.status = 28;
          throw err;
        }
        resp = responses.blockedEgress as { status: number; body: string } | undefined;
      } else if (url.includes('example.com')) {
        if (responses.external && 'fail' in responses.external) {
          const err = new Error('connect refused') as Error & { status: number };
          err.status = 6;
          throw err;
        }
        resp = responses.external as { status: number; body: string } | undefined;
      } else resp = responses.substitute;

      if (!resp) {
        const err = new Error('no canned response') as Error & { status: number };
        err.status = 22;
        throw err;
      }

      // The probe re-reads /tmp/out.body via the IO. We have to write it
      // into the files map *between* exec and readFile, but our IO closure
      // captures `files` at construct time. Test harness handles this by
      // having `mkIO` and `mkExec` share state via the wrapper below.
      currentBodyByCommand = resp.body;
      return `'${resp.status}'`;
    };
  }

  let currentBodyByCommand = '';

  // Build an IO that lazily yields the current body for /tmp/out.body so
  // each curlVia call sees the body its exec just produced.
  function mkProgrammableIO(opts: {
    exec: (cmd: string) => string;
    files?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    uid?: number;
  }): ProbeIO {
    const staticFiles = opts.files ?? {};
    return {
      exec(cmd) {
        return opts.exec(cmd);
      },
      readFile(p) {
        if (p === '/tmp/out.body') return currentBodyByCommand;
        if (p in staticFiles) return staticFiles[p];
        const err = new Error(`ENOENT: ${p}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      },
      fileExists(p) {
        return p === '/tmp/out.body' || p in staticFiles;
      },
      env: opts.env ?? {},
      uid: opts.uid ?? 1000,
    };
  }

  it('aggregates the four curl responses + env + CA mount into the result shape', () => {
    const io = mkProgrammableIO({
      exec: mkExec({
        substitute: {
          status: 200,
          body: JSON.stringify({
            substitute: 'sub_abc',
            providerId: 'test-provider',
            credentialPath: 'oauth',
            envNames: ['TEST_TOKEN'],
          }),
        },
        rejectProxy: { status: 400, body: '{"error":"Reserved env var name: \'HTTP_PROXY\'"}' },
        rejectPath: { status: 400, body: '{"error":"Reserved env var name: \'PATH\'"}' },
        external: { status: 200, body: '<html>Example Domain</html>' },
        transparent: { status: 200, body: '{"intercepted":true,"host":"mitm-test.local"}' },
        blockedEgress: { status: 301, body: '' },
      }),
      files: {
        '/usr/local/share/ca-certificates/nanoclaw-mitm.crt': '-----BEGIN CERTIFICATE-----...',
        '/etc/ssl/certs/ca-certificates.crt':
          '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n' +
          '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n' +
          '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----\n',
      },
      env: {
        HTTP_PROXY: 'http://host.docker.internal:18999',
        HOST_UID: '4242',
        MITM_CA_PATH: '/usr/local/share/ca-certificates/nanoclaw-mitm.crt',
      },
      uid: 4242,
    });

    const r = buildProbeResult(io);

    expect(r.httpProxyEnv).toBe('http://host.docker.internal:18999');
    expect(r.mitmCaPathEnv).toBe('/usr/local/share/ca-certificates/nanoclaw-mitm.crt');
    expect(r.hostUidEnv).toBe('4242');
    expect(r.uid).toBe(4242);

    expect(r.caCertMount).toEqual({
      exists: true,
      path: '/usr/local/share/ca-certificates/nanoclaw-mitm.crt',
    });
    expect(r.certCount).toBe(3);

    expect(r.substitute.status).toBe(200);
    expect(JSON.parse(r.substitute.body).substitute).toBe('sub_abc');

    expect(r.rejectProxy.status).toBe(400);
    expect(r.rejectProxy.body).toMatch(/Reserved env var name/);
    expect(r.rejectPath.status).toBe(400);
    expect(r.rejectPath.body).toMatch(/Reserved env var name/);

    expect(r.external.status).toBe(200);
    expect(r.external.body).toMatch(/Example Domain/);

    expect(r.transparent.status).toBe(200);
    expect(JSON.parse(r.transparent.body)).toEqual({
      intercepted: true,
      host: 'mitm-test.local',
    });

    expect(r.blockedEgress.status).toBe(301);
  });

  it('routes each curl request by the request URL (substitute, envVar=HTTP_PROXY, envVar=PATH, external)', () => {
    const seen: string[] = [];
    const io = mkProgrammableIO({
      exec(cmd) {
        seen.push(cmd);
        currentBodyByCommand = '';
        if (cmd.includes('envVar=HTTP_PROXY')) return "'400'";
        if (cmd.includes('envVar=PATH')) return "'400'";
        return "'200'";
      },
      env: { HTTP_PROXY: 'http://h:1' },
    });

    buildProbeResult(io);

    // Order is fixed: substitute, rejectProxy, rejectPath, external,
    // transparent, blockedEgress.
    expect(seen).toHaveLength(6);
    expect(seen[0]).toContain('/credentials/test-provider/substitute?path=oauth');
    expect(seen[0]).not.toContain('envVar=');
    expect(seen[1]).toContain('envVar=HTTP_PROXY');
    expect(seen[2]).toContain('envVar=PATH');
    expect(seen[3]).toContain('https://example.com/');
    expect(seen[3]).toContain('--max-time 10');
    expect(seen[4]).toContain('https://mitm-test.local/transparent-probe');
    expect(seen[4]).toContain("--noproxy '*'");
    expect(seen[4]).toContain("--resolve 'mitm-test.local:443:203.0.113.1'");
    expect(seen[5]).toContain('http://example.com:80/blocked-egress-probe');
    expect(seen[5]).toContain("--noproxy '*'");
    expect(seen[5]).toContain('--max-time 5');
  });

  it('treats a curl failure on the external request as code=non-zero, status=0 (soft-fail)', () => {
    const io = mkProgrammableIO({
      exec: mkExec({
        substitute: { status: 200, body: '{}' },
        rejectProxy: { status: 400, body: '' },
        rejectPath: { status: 400, body: '' },
        external: { fail: true },
        transparent: { fail: true },
        blockedEgress: { fail: true },
      }),
      env: { HTTP_PROXY: 'http://h:1' },
    });

    const r = buildProbeResult(io);
    expect(r.external.status).toBe(0);
    expect(r.external.code).toBe(6);
    expect(r.transparent.status).toBe(0);
    expect(r.transparent.code).toBe(7);
    // Lockdown DROP looks like a curl timeout: code != 0, status 0.
    expect(r.blockedEgress.status).toBe(0);
    expect(r.blockedEgress.code).toBe(28);
  });

  it('reports certCount=0 when the system CA bundle is missing', () => {
    const io = mkProgrammableIO({
      exec(cmd) {
        currentBodyByCommand = '';
        if (cmd.includes('envVar=')) return "'400'";
        return "'200'";
      },
      env: {},
    });

    const r = buildProbeResult(io);
    expect(r.certCount).toBe(0);
    expect(r.caCertMount.exists).toBe(false);
  });

  describe('nss probe', () => {
    it('reports dbExists=false when the NSS DB file is missing', () => {
      const io = mkProgrammableIO({
        exec(cmd) {
          currentBodyByCommand = '';
          if (cmd.startsWith('certutil ')) {
            throw new Error('certutil should not be called when DB is missing');
          }
          if (cmd.includes('envVar=')) return "'400'";
          return "'200'";
        },
        env: {},
      });

      const r = buildProbeResult(io);
      expect(r.nss.dbExists).toBe(false);
      expect(r.nss.listOutput).toBe('');
      expect(r.nss.mitmCaTrusted).toBe(false);
    });

    it('parses certutil -L output and detects the trusted MITM CA', () => {
      const certutilOutput =
        '\nCertificate Nickname                                         Trust Attributes\n' +
        '                                                             SSL,S/MIME,JAR/XPI\n\n' +
        'nanoclaw-mitm-ca                                             C,,\n';

      const io = mkProgrammableIO({
        exec(cmd) {
          currentBodyByCommand = '';
          if (cmd.startsWith('certutil ')) {
            expect(cmd).toContain("'sql:/home/node/.pki/nssdb'");
            return certutilOutput;
          }
          if (cmd.includes('envVar=')) return "'400'";
          return "'200'";
        },
        files: { '/home/node/.pki/nssdb/cert9.db': '<sqlite-blob>' },
        env: {},
      });

      const r = buildProbeResult(io);
      expect(r.nss.dbExists).toBe(true);
      expect(r.nss.listOutput).toBe(certutilOutput);
      expect(r.nss.mitmCaTrusted).toBe(true);
    });

    it('reports mitmCaTrusted=false when the nickname is missing from the listing', () => {
      const io = mkProgrammableIO({
        exec(cmd) {
          currentBodyByCommand = '';
          if (cmd.startsWith('certutil ')) {
            return 'some-other-cert                                              CT,,\n';
          }
          if (cmd.includes('envVar=')) return "'400'";
          return "'200'";
        },
        files: { '/home/node/.pki/nssdb/cert9.db': '<sqlite-blob>' },
        env: {},
      });

      const r = buildProbeResult(io);
      expect(r.nss.dbExists).toBe(true);
      expect(r.nss.mitmCaTrusted).toBe(false);
    });

    it('captures error output when certutil throws', () => {
      const io = mkProgrammableIO({
        exec(cmd) {
          currentBodyByCommand = '';
          if (cmd.startsWith('certutil ')) {
            const err = new Error('NSS error: SEC_ERROR_BAD_DATABASE') as Error & {
              status: number;
            };
            err.status = 255;
            throw err;
          }
          if (cmd.includes('envVar=')) return "'400'";
          return "'200'";
        },
        files: { '/home/node/.pki/nssdb/cert9.db': '<corrupt>' },
        env: {},
      });

      const r = buildProbeResult(io);
      expect(r.nss.dbExists).toBe(true);
      expect(r.nss.listOutput).toMatch(/SEC_ERROR_BAD_DATABASE/);
      expect(r.nss.mitmCaTrusted).toBe(false);
    });
  });

  it('passes through empty HTTP_PROXY env as ""', () => {
    const io = mkProgrammableIO({
      exec(cmd) {
        // The base URL prefix becomes just the substitute path when HTTP_PROXY is empty.
        if (!cmd.includes('envVar=') && !cmd.includes('example.com')) {
          expect(cmd).toContain("'/credentials/test-provider/substitute?path=oauth'");
        }
        currentBodyByCommand = '';
        return "'200'";
      },
      env: {},
    });

    const r = buildProbeResult(io);
    expect(r.httpProxyEnv).toBe('');
    expect(r.mitmCaPathEnv).toBeNull();
    expect(r.hostUidEnv).toBeNull();
  });
});
