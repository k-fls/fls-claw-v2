import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Mock pending module
const mockAddPending = vi.fn((..._args: any[]) => ({ accepted: true, capReached: false }));
vi.mock('./pending.js', () => ({
  addPendingRequest: (...args: any[]) => mockAddPending(...args),
}));

// Mock notify-user so we can assert on DM-out events
const mockNotifyUser = vi.fn(async (..._args: any[]) => {});
vi.mock('./notify-user.js', () => ({
  notifyUser: (...args: any[]) => mockNotifyUser(...args),
}));

// Mock manager
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockListConnections = vi.fn((): any[] => []);

vi.mock('./manager.js', () => ({
  SSHManager: vi.fn(),
  SSHError: class SSHError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'SSHError';
    }
  },
  SSHHostKeyMismatchError: class SSHHostKeyMismatchError extends Error {
    code = 'host_key_mismatch';
    alias: string;
    host: string;
    port: number;
    storedFingerprint: string;
    scannedFingerprint: string;
    constructor(alias: string, host: string, port: number, stored: string, scanned: string) {
      super(`Host key mismatch for '${alias}'`);
      this.alias = alias;
      this.host = host;
      this.port = port;
      this.storedFingerprint = stored;
      this.scannedFingerprint = scanned;
      this.name = 'SSHHostKeyMismatchError';
    }
  },
  containerSocketPath: (alias: string) => `/ssh-sockets/${alias}.sock`,
}));

import { routeSSHRequest } from './rpc.js';
import type { SSHProxyDeps } from './rpc.js';
import { sshToCredential } from './types.js';
import type { SSHCredentialMeta } from './types.js';
import type { Credential, CredentialScope, GroupScope } from '../credentials/index.js';
import type { CredentialResolver } from './manager.js';
import { asCredentialScope, asGroupScope } from '../credentials/index.js';

// ── Test helpers ─────────────────────────────────────────────────

const scope = asGroupScope('test-group');
const AG_ID = 'ag-1';
const SESSION_ID = 'sid-1';

function makeResolver(store: Record<string, Credential | null> = {}): CredentialResolver {
  return {
    store: vi.fn((providerId, scope, id, cred) => {
      store[`${scope as string}/${providerId}/${id}`] = cred;
    }),
    resolve: vi.fn((scope, providerId, id) => {
      return store[`${scope as string}/${providerId}/${id}`] ?? null;
    }),
    delete: vi.fn(),
  };
}

function makeDeps(overrides: Partial<SSHProxyDeps> = {}): SSHProxyDeps {
  return {
    sshManager: {
      connect: mockConnect,
      disconnect: mockDisconnect,
      listConnections: mockListConnections,
    } as any,
    resolver: makeResolver(),
    requesterAgentGroupId: AG_ID,
    requesterSessionId: SESSION_ID,
    ...overrides,
  };
}

/** Fire an HTTP request at the routeSSHRequest handler via a temp server. */
function request(
  deps: SSHProxyDeps,
  method: string,
  url: string,
  body?: object,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!routeSSHRequest(deps, req, res, scope)) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const opts: http.RequestOptions = {
        hostname: '127.0.0.1',
        port,
        method,
        path: url,
        headers: body ? { 'content-type': 'application/json' } : undefined,
      };
      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(raw),
            });
          } catch {
            resolve({ status: res.statusCode!, body: { raw } });
          }
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('routeSSHRequest', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockListConnections.mockReset().mockReturnValue([]);
    mockAddPending.mockReset().mockReturnValue({ accepted: true, capReached: false });
    mockNotifyUser.mockReset().mockResolvedValue(undefined);
  });

  // ── /ssh/request-credential ──────────────────────────────────

  describe('POST /ssh/request-credential', () => {
    it('returns ok when credential already exists', async () => {
      const meta: SSHCredentialMeta = {
        host: 'h',
        port: 22,
        username: 'u',
        authType: 'key',
        publicKey: 'ssh-ed25519 AAAA',
        hostKey: null,
      };
      const store: Record<string, Credential | null> = {};
      const resolver = makeResolver(store);
      const credScope = asCredentialScope('test-group');
      store[`${credScope as string}/ssh/db`] = sshToCredential('secret', meta);
      const deps = makeDeps({ resolver });

      const res = await request(deps, 'POST', '/ssh/request-credential', {
        alias: 'db',
        mode: 'ask',
        connection_host: 'h',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.publicKey).toBe('ssh-ed25519 AAAA');
    });

    it('records pending with requester identity and DMs the user', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/request-credential', {
        alias: 'db',
        mode: 'ask',
        connection_host: 'h',
        connection_username: 'u',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(mockAddPending).toHaveBeenCalledWith(scope, 'db', SESSION_ID);
      expect(mockNotifyUser).toHaveBeenCalledWith(AG_ID, expect.stringContaining('/ssh add db'));
    });

    it('returns suppressed when pending is rejected', async () => {
      mockAddPending.mockReturnValue({ accepted: false, capReached: false });
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/request-credential', {
        alias: 'db',
        mode: 'ask',
        connection_host: 'h',
      });
      expect(res.body.status).toBe('suppressed');
      expect(mockNotifyUser).not.toHaveBeenCalled();
    });

    it('appends cap-reached warning to the user DM', async () => {
      mockAddPending.mockReturnValue({ accepted: true, capReached: true });
      const deps = makeDeps();
      await request(deps, 'POST', '/ssh/request-credential', {
        alias: 'db',
        mode: 'ask',
        connection_host: 'h',
      });
      expect(mockNotifyUser).toHaveBeenCalledWith(
        AG_ID,
        expect.stringContaining('SSH credential request limit reached'),
      );
    });

    it('rejects invalid alias', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/request-credential', {
        alias: '',
        mode: 'ask',
        connection_host: 'h',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_alias');
    });

    it('rejects invalid mode', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/request-credential', {
        alias: 'db',
        mode: 'bad',
        connection_host: 'h',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_mode');
    });

    it('rejects generate mode without required params', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/request-credential', {
        alias: 'db',
        mode: 'generate',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('missing_params');
    });
  });

  // ── /ssh/connect ─────────────────────────────────────────────

  describe('POST /ssh/connect', () => {
    it('returns usage on successful connect', async () => {
      mockConnect.mockResolvedValue({
        alias: 'db',
        host: '10.0.0.5',
        port: 22,
        username: 'deploy',
        socketPath: '/tmp/x.sock',
        scope,
        hostKeyAction: 'matched',
        hostKeyFingerprint: 'SHA256:abc',
      });
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/connect', { alias: 'db' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.usage).toContain('deploy@10.0.0.5');
      expect(res.body.usage).toContain('ControlPath=/ssh-sockets/db.sock');
    });

    it('DMs the user when host key pinned via TOFU', async () => {
      mockConnect.mockResolvedValue({
        alias: 'db',
        host: 'h',
        port: 22,
        username: 'u',
        socketPath: '/tmp/x.sock',
        scope,
        hostKeyAction: 'pinned',
        hostKeyFingerprint: 'SHA256:pinned-fp',
      });
      const deps = makeDeps();

      await request(deps, 'POST', '/ssh/connect', { alias: 'db' });
      expect(mockNotifyUser).toHaveBeenCalledWith(AG_ID, expect.stringContaining('SHA256:pinned-fp'));
    });

    it('returns error on host key mismatch and DMs the user', async () => {
      const { SSHHostKeyMismatchError: MockMismatch } = await import('./manager.js');
      mockConnect.mockRejectedValue(new MockMismatch('db', 'h', 22, 'SHA256:stored', 'SHA256:scanned'));
      const deps = makeDeps();

      const res = await request(deps, 'POST', '/ssh/connect', { alias: 'db' });
      expect(res.body.code).toBe('host_key_mismatch');
      expect(mockNotifyUser).toHaveBeenCalledWith(AG_ID, expect.stringContaining('HOST KEY MISMATCH'));
    });

    it('returns error for generic SSHError', async () => {
      const { SSHError: MockSSHError } = await import('./manager.js');
      mockConnect.mockRejectedValue(new MockSSHError('timeout', 'timed out'));
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/connect', { alias: 'db' });
      expect(res.body.code).toBe('timeout');
    });

    it('rejects invalid alias', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/connect', { alias: '!!!' });
      expect(res.status).toBe(400);
    });
  });

  // ── /ssh/disconnect ──────────────────────────────────────────

  describe('POST /ssh/disconnect', () => {
    it('disconnects and returns ok', async () => {
      mockDisconnect.mockResolvedValue(undefined);
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/disconnect', { alias: 'db' });
      expect(res.body.status).toBe('ok');
      expect(mockDisconnect).toHaveBeenCalledWith(scope, 'db');
    });

    it('rejects invalid alias', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'POST', '/ssh/disconnect', { alias: '' });
      expect(res.status).toBe(400);
    });
  });

  // ── /ssh/connections ─────────────────────────────────────────

  describe('GET /ssh/connections', () => {
    it('returns active connections', async () => {
      mockListConnections.mockReturnValue([
        {
          alias: 'db',
          host: 'h',
          port: 22,
          username: 'u',
          socketPath: '/tmp/s',
          scope: 'test' as any,
          hostKeyAction: 'accepted',
        },
      ]);
      const deps = makeDeps();
      const res = await request(deps, 'GET', '/ssh/connections');
      expect(res.body.status).toBe('ok');
      expect(res.body.connections).toHaveLength(1);
      expect(res.body.connections[0].alias).toBe('db');
    });

    it('returns empty list when no connections', async () => {
      const deps = makeDeps();
      const res = await request(deps, 'GET', '/ssh/connections');
      expect(res.body.connections).toEqual([]);
    });
  });

  // ── Routing ──────────────────────────────────────────────────

  describe('routing', () => {
    it('returns false for unknown paths', () => {
      const deps = makeDeps();
      const req = { url: '/other', method: 'GET' } as any;
      const res = {} as any;
      expect(routeSSHRequest(deps, req, res, scope)).toBe(false);
    });
  });
});
