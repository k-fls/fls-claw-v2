/**
 * SSH host-rpc endpoints.
 *
 * Four endpoints behind the host-rpc dispatcher (scope derived from
 * container IP):
 *
 *   POST /ssh/request-credential — generate key or notify user
 *   POST /ssh/connect            — establish ControlMaster, return usage
 *   POST /ssh/disconnect         — tear down ControlMaster
 *   GET  /ssh/connections        — list active connections for scope
 *
 * `routeSSHRequest` keeps the fork's IncomingMessage/ServerResponse
 * call shape so the v1 unit tests run unchanged. `makeSSHRpcHandler`
 * adapts that surface to v2's host-rpc handler contract (parsed JSON
 * body, return value → `{ ok:true, result }`).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { execFileSync } from 'child_process';
import { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../log.js';
import type { GroupScope, CredentialScope } from '../credentials/index.js';
import { asCredentialScope, asGroupScope } from '../credentials/index.js';
import { SSH_PROVIDER_ID, sshToCredential, sshFromCredential, isValidAlias } from './types.js';
import type { SSHCredentialMeta } from './types.js';
import { containerSocketPath, SSHManager, SSHError, SSHHostKeyMismatchError } from './manager.js';
import type { CredentialResolver } from './manager.js';
import { addPendingRequest } from './pending.js';
import { notifyUser as defaultNotifyUser } from './notify-user.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { ContainerScope } from '../container-bootstrap/index.js';

// ── Handler ───────────────────────────────────────────────────────

export interface SSHProxyDeps {
  sshManager: SSHManager;
  resolver: CredentialResolver;
  /** Agent group id of the container that issued the request. */
  requesterAgentGroupId: string;
  /** Session id of the container that issued the request. */
  requesterSessionId: string;
}

/**
 * Route an SSH-related request. Returns true if handled.
 */
export function routeSSHRequest(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): boolean {
  const url = req.url || '';

  if (url === '/ssh/request-credential' && req.method === 'POST') {
    handleRequestCredential(deps, req, res, scope).catch((err) => {
      log.error('SSH request-credential handler error', { err });
      sendJson(res, 500, {
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
    });
    return true;
  }

  if (url === '/ssh/connect' && req.method === 'POST') {
    handleConnect(deps, req, res, scope).catch((err) => {
      log.error('SSH connect handler error', { err });
      sendJson(res, 500, {
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
    });
    return true;
  }

  if (url === '/ssh/disconnect' && req.method === 'POST') {
    handleDisconnect(deps, req, res, scope).catch((err) => {
      log.error('SSH disconnect handler error', { err });
      sendJson(res, 500, {
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
    });
    return true;
  }

  if (url === '/ssh/connections' && req.method === 'GET') {
    const conns = deps.sshManager.listConnections(scope);
    sendJson(res, 200, {
      status: 'ok',
      connections: conns.map((c) => ({
        alias: c.alias,
        host: c.host,
        port: c.port,
        username: c.username,
      })),
    });
    return true;
  }

  return false;
}

// ── Endpoint handlers ─────────────────────────────────────────────

async function handleRequestCredential(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): Promise<void> {
  const body = await readBody(req);
  const { alias, mode, connection_host, connection_port, connection_username } = body;

  if (!alias || !isValidAlias(alias)) {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_alias',
      message: 'Invalid alias',
    });
    return;
  }
  if (mode !== 'generate' && mode !== 'ask') {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_mode',
      message: 'Mode must be generate or ask',
    });
    return;
  }

  const credScope = asCredentialScope(scope);

  // Check if credential already exists
  const existing = deps.resolver.resolve(credScope, SSH_PROVIDER_ID, alias);
  if (existing) {
    const parsed = sshFromCredential(existing);
    sendJson(res, 200, {
      status: 'ok',
      publicKey: parsed?.meta.publicKey || undefined,
    });
    return;
  }

  if (mode === 'generate') {
    if (!connection_username || !connection_host) {
      sendJson(res, 400, {
        status: 'error',
        code: 'missing_params',
        message: 'connection_host and connection_username required for generate mode',
      });
      return;
    }

    // Generate ed25519 keypair
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-keygen-'));
    const keyPath = path.join(tmpDir, 'key');
    try {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `nanoclaw-${alias}`], {
        timeout: 10000,
      });

      const privateKey = fs.readFileSync(keyPath, 'utf-8');
      const publicKey = fs.readFileSync(keyPath + '.pub', 'utf-8').trim();

      const meta: SSHCredentialMeta = {
        host: connection_host,
        port: connection_port || 22,
        username: connection_username,
        authType: 'key',
        publicKey,
        hostKey: null,
      };

      deps.resolver.store(SSH_PROVIDER_ID, credScope, alias, sshToCredential(privateKey, meta));
      log.info('ssh.credential_stored', { alias, scope, authType: 'key' });

      sendJson(res, 200, { status: 'ok', publicKey });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  // mode === 'ask': record pending request and notify user
  const { accepted, capReached } = addPendingRequest(scope, alias, deps.requesterSessionId);

  if (!accepted) {
    sendJson(res, 200, { status: 'suppressed' });
    return;
  }

  log.info('ssh.pending_request', { alias, scope });

  // Build notification message
  let connInfo = alias;
  if (connection_username && connection_host) {
    connInfo = `${connection_username}@${connection_host}`;
    if (connection_port && connection_port !== 22) connInfo += `:${connection_port}`;
    connInfo = `${alias} (${connInfo})`;
  }

  let msg = `SSH credential requested: *${connInfo}*\n`;
  msg += `Use \`/ssh add ${alias} ${connection_username || 'user'}@${connection_host || 'host'}\` to provide credentials.`;

  if (capReached) {
    msg +=
      '\n\n⚠️ SSH credential request limit reached (10). Further requests will be suppressed until pending entries are resolved or cleared with `/ssh clear-pending`.';
  }

  await notifyUser(deps, msg);
  sendJson(res, 200, { status: 'pending' });
}

async function handleConnect(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): Promise<void> {
  const body = await readBody(req);
  const { alias, timeout } = body;

  if (!alias || !isValidAlias(alias)) {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_alias',
      message: 'Invalid alias',
    });
    return;
  }

  try {
    const conn = await deps.sshManager.connect(scope, alias, {
      timeout,
      pinAllowed: true,
    });

    if (conn.hostKeyAction === 'pinned') {
      const fp = conn.hostKeyFingerprint || '(unknown)';
      await notifyUser(deps, `Host key for ${alias} (${conn.host}:${conn.port}) pinned: ${fp}`);
    }

    const containerSock = containerSocketPath(alias);
    const dest = `${conn.username}@${conn.host}`;
    const usage = [
      `SSH connection established for '${alias}' (${dest}:${conn.port}).`,
      `Usage:`,
      `  ssh -o ControlPath=${containerSock} _ [command]`,
      `  scp -o ControlPath=${containerSock} local.txt ${dest}:/remote/`,
      `  rsync -e "ssh -o ControlPath=${containerSock}" src/ ${dest}:/dest/`,
    ].join('\n');

    sendJson(res, 200, { status: 'ok', alias, usage });
  } catch (err) {
    if (err instanceof SSHHostKeyMismatchError) {
      const msg =
        `⚠️ HOST KEY MISMATCH for ${err.alias} (${err.host}:${err.port}).\n` +
        `Stored: ${err.storedFingerprint}\nScanned: ${err.scannedFingerprint}\n` +
        `Connection refused.\n` +
        `To pin the new key: \`/ssh reset-host ${err.alias} hostKey=${err.scannedFingerprint}\``;
      await notifyUser(deps, msg);
      log.warn('ssh.host_key_mismatch', {
        alias,
        storedFp: err.storedFingerprint,
        scannedFp: err.scannedFingerprint,
      });
      sendJson(res, 200, {
        status: 'error',
        code: 'host_key_mismatch',
        message: err.message,
      });
      return;
    }
    if (err instanceof SSHError) {
      sendJson(res, 200, {
        status: 'error',
        code: err.code,
        message: err.message,
      });
      return;
    }
    throw err;
  }
}

async function handleDisconnect(
  deps: SSHProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  scope: GroupScope,
): Promise<void> {
  const body = await readBody(req);
  const { alias } = body;

  if (!alias || !isValidAlias(alias)) {
    sendJson(res, 400, {
      status: 'error',
      code: 'invalid_alias',
      message: 'Invalid alias',
    });
    return;
  }

  await deps.sshManager.disconnect(scope, alias);
  sendJson(res, 200, { status: 'ok' });
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * DM the human approver of the requesting agent group: `pickApprover` →
 * `ensureUserDm` → `deliverDirect`. Best-effort.
 */
async function notifyUser(deps: SSHProxyDeps, message: string): Promise<void> {
  await defaultNotifyUser(deps.requesterAgentGroupId, message);
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
  });
}

// ── Host-rpc adapter ──────────────────────────────────────────────

interface HostRpcRequestLike {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly callerIP: string;
}

/**
 * Adapt the v1 `routeSSHRequest` shape to v2's host-rpc handler contract.
 * Synthesizes a minimal IncomingMessage/ServerResponse pair, drives the
 * handler, captures the response payload, and returns it (host-rpc wraps
 * in `{ ok:true, result }` on its end).
 *
 * Caller scope (ContainerScope = agent group id) is resolved into a
 * GroupScope via `getAgentGroup(id).folder` before dispatch — ssh-auth's
 * substrate uses the folder string everywhere.
 */
export function makeSSHRpcHandler(
  manager: SSHManager,
  resolver: CredentialResolver,
): (req: HostRpcRequestLike, scope: ContainerScope, sessionId: string) => Promise<unknown> {
  return async (req, containerScope, sessionId) => {
    const ag = getAgentGroup(containerScope as unknown as string);
    if (!ag) throw new Error(`agent group not found for scope ${containerScope}`);

    const groupScope = asGroupScope(ag.folder);
    const fakeReq = makeFakeReq(req);
    const fakeRes = makeFakeRes();

    const deps: SSHProxyDeps = {
      sshManager: manager,
      resolver,
      requesterAgentGroupId: ag.id,
      requesterSessionId: sessionId,
    };

    const handled = routeSSHRequest(deps, fakeReq, fakeRes, groupScope);
    if (!handled) {
      throw new Error(`Unknown SSH endpoint: ${req.method} ${req.path}`);
    }

    // Wait for fakeRes to receive its payload (handlers may be async).
    await fakeRes.done;
    return fakeRes.statusCode === 200 ? fakeRes.body : { ...(fakeRes.body as object), __status: fakeRes.statusCode };
  };
}

function makeFakeReq(req: HostRpcRequestLike): IncomingMessage {
  const payload = req.body == null ? '' : JSON.stringify(req.body);
  // Yield a Buffer (not a string) so the handler's `Buffer.concat(chunks)`
  // doesn't throw — Readable.from on a string iterable emits strings.
  const stream = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
  // The handlers read `req.url`, `req.method`, then iterate data/end via
  // `req.on(...)`. Readable.from supports the latter; we patch in the
  // url/method properties.
  Object.assign(stream, { url: req.path, method: req.method.toUpperCase() });
  return stream;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  done: Promise<void>;
}

function makeFakeRes(): FakeRes & ServerResponse {
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  // Minimal stub satisfying the writeHead/end calls in `sendJson` and any
  // header juggling the handlers do. We intentionally don't impl the full
  // ServerResponse surface — the handlers only call writeHead + end.
  const stub: Partial<ServerResponse> & FakeRes = {
    statusCode: 200,
    body: null,
    done,
    writeHead(status: number, _headers?: any): any {
      (stub as FakeRes).statusCode = status;
      return stub as unknown as ServerResponse;
    },
    end(payload?: any): any {
      try {
        (stub as FakeRes).body = typeof payload === 'string' ? JSON.parse(payload) : (payload ?? null);
      } catch {
        (stub as FakeRes).body = payload ?? null;
      }
      resolveDone();
      return stub as unknown as ServerResponse;
    },
  };
  return stub as FakeRes & ServerResponse;
}
