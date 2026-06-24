/**
 * Host-RPC HTTP server.
 *
 * Bound to a host interface reachable from the nanoclaw bridge but
 * intentionally NOT exposed to other host interfaces. The default bind
 * host is detected the same way the fork's credential proxy detects
 * its bind: `127.0.0.1` on macOS / WSL / Docker Desktop (where
 * `host.docker.internal` resolves to loopback in the VM), and the
 * `nanoclaw` bridge gateway on bare-metal Linux — the same address
 * `host.docker.internal` is remapped to there (see hostGatewayArgs).
 *
 * Authorization:
 *   The caller IP is resolved against the container-ip registry. If
 *   the IP doesn't belong to any registered container, the request is
 *   rejected with 403 BEFORE the handler runs — handlers always
 *   receive a resolved `ContainerScope`.
 *
 * Dispatch:
 *   Longest-prefix match. The matched handler receives the full path
 *   and method and decides sub-routing.
 *
 * Wire format:
 *   Request:  any method; Content-Type: application/json (optional)
 *   Body:     arbitrary JSON, capped at MAX_BODY (1 MiB)
 *   Response: { ok: true, result: <handler return> }      (200)
 *           | { ok: false, error: <message> }             (4xx/5xx)
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';

import { log } from '../../log.js';
import { lookupContainerIP, lookupContainerSession } from '../container-bootstrap/index.js';
// Leaf import (not the barrel): bind to the SAME address the proxy binds and
// containers reach via host.docker.internal — gatewayBindHost is the one source
// of truth, so host-rpc's bind and the proxy's bind can't drift. Binding the
// bridge gateway (not docker0, not 0.0.0.0) keeps the hop on the container's
// own bridge — no cross-bridge MASQUERADE — so the caller-IP gate below sees
// the real container IP. (host-rpc bug #9)
import { gatewayBindHost } from '../container-bootstrap/network.js';
import { matchHostRpc } from './registry.js';
import { hostRpcPort } from './port.js';
import type { HostRpcRequest } from './types.js';

const DEFAULT_PORT = hostRpcPort();
const MAX_BODY = 1024 * 1024; // 1 MiB

let server: Server | null = null;

const DEFAULT_BIND = process.env.NANOCLAW_HOST_RPC_BIND || gatewayBindHost();

function reply(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function clientIP(req: IncomingMessage): string | null {
  const addr = req.socket.remoteAddress || null;
  if (!addr) return null;
  // Strip IPv4-mapped IPv6 prefix (::ffff:172.29.0.2 → 172.29.0.2)
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** @internal — exported so tests can drive dispatch without binding a socket. */
export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const callerIP = clientIP(req);
  if (!callerIP) {
    reply(res, 400, { ok: false, error: 'no-caller-ip' });
    return;
  }
  const scope = lookupContainerIP(callerIP);
  const sessionId = lookupContainerSession(callerIP);
  if (!scope || !sessionId) {
    log.warn('host-rpc: unknown caller IP, rejecting', { callerIP, url: req.url });
    reply(res, 403, { ok: false, error: 'unknown-caller' });
    return;
  }

  const path = (req.url || '/').split('?')[0];
  const entry = matchHostRpc(path);
  if (!entry) {
    reply(res, 404, { ok: false, error: 'no-handler' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'body-too-large') {
      reply(res, 413, { ok: false, error: 'body-too-large' });
    } else {
      reply(res, 400, { ok: false, error: 'invalid-json' });
    }
    return;
  }

  const request: HostRpcRequest = {
    method: (req.method || 'GET').toUpperCase(),
    path,
    body,
    callerIP,
  };

  try {
    const result = await entry.handler(request, scope, sessionId);
    reply(res, 200, { ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('host-rpc handler threw', { prefix: entry.prefix, path, callerIP, err });
    reply(res, 500, { ok: false, error: message });
  }
}

export async function startHostRpcServer(opts?: {
  port?: number;
  bind?: string;
}): Promise<{ port: number; bind: string }> {
  if (server) {
    throw new Error('host-rpc server already running');
  }
  const port = opts?.port ?? DEFAULT_PORT;
  const bind = opts?.bind ?? DEFAULT_BIND;

  const s = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error('host-rpc unhandled error', { err });
      try {
        reply(res, 500, { ok: false, error: 'internal' });
      } catch {
        /* response already sent */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, bind, () => {
      s.removeListener('error', reject);
      resolve();
    });
  });

  server = s;
  currentAddress = { bind, port };
  log.info('host-rpc server listening', { bind, port });
  return { port, bind };
}

let currentAddress: { bind: string; port: number } | null = null;

/**
 * Address of the running host-rpc server, or null if not started yet.
 * Containers reach the server at `http://<bind>:<port>`; modules use
 * this to expose the URL to containers via an env var
 * (`CLAW_HOST_RPC_URL`).
 */
export function getHostRpcAddress(): { bind: string; port: number } | null {
  return currentAddress;
}

export async function stopHostRpcServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  currentAddress = null;
  await new Promise<void>((resolve) => {
    s.close(() => resolve());
  });
}

/** @internal — for tests. */
export function __isHostRpcServerRunning(): boolean {
  return server !== null;
}
