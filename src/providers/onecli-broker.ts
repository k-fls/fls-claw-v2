/**
 * OneCLI credential broker (C3) — the pipe-terminal broker that re-forwards a
 * decrypted request through OneCLI's per-agent gateway, which injects the real
 * secret. See `docs/fls/specs/onecli-broker.md` (§3, §3a, §5a, §8).
 *
 * Split in two so the forward mechanism is provable without a live OneCLI:
 *   - `forwardViaConnectProxy` — the transport: CONNECT-tunnel to the gateway,
 *     TLS to the target host (cert ignored per the §3a decision), speak HTTP
 *     over it, pipe the response back. Pure; tested against a stub CONNECT
 *     proxy.
 *   - `createOneCliBroker(resolveForwardConfig)` — the broker, with the
 *     per-agent gateway address injected. The default resolver (OneCLI SDK)
 *     is gateway-gated; tests inject a stub.
 *
 * Per-container init (eager, demand-driven): `onContainerRouted` resolves the
 * group's agent identifier, provisions the agent, and resolves the gateway
 * address, caching the (possibly in-flight) promise by IP. `tryForward` awaits
 * it and **fails closed** if it rejected — never silently passes through.
 */
import { request as httpRequest } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { connect as netConnect } from 'net';
import { connect as tlsConnect } from 'tls';

import type { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_URL } from '../config.js';
import { getAgentGroupByFolder } from '../db/index.js';
import { log } from '../log.js';
import { type CredentialBroker, registerCredentialBroker } from '../modules/mitm-proxy/index.js';
import { getOneCli } from '../onecli-client.js';

import { resolveAgentIdentifier } from './onecli-credential.js';

/** A gateway egress proxy address (per OneCLI agent). CA is ignored (§3a). */
export interface ForwardConfig {
  host: string;
  port: number;
}

/** Resolve the gateway forward config for a container (ip + scope folder). */
export type ForwardConfigResolver = (ip: string, folder: string) => Promise<ForwardConfig>;

/**
 * Forward a decrypted request to its target host through an HTTP CONNECT proxy
 * (the gateway), terminating TLS at the target via the proxy. The target cert
 * is **not** verified (§3a — the gateway MITM-terminates with its own CA, which
 * we deliberately don't manage). Streams the request body up and the response
 * back. Resolves when the response is fully piped; rejects on any transport
 * error so the caller can fail closed.
 */
export function forwardViaConnectProxy(
  proxy: ForwardConfig,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetHost: string,
  targetPort: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    // createConnection: open the CONNECT tunnel to the gateway, then TLS to the
    // target over it, and hand the TLS socket to the HTTP client (which then
    // speaks plain HTTP over the already-encrypted socket = HTTPS).
    const createConnection = (_opts: unknown, cb: (err: Error | null, sock?: NodeJS.ReadWriteStream) => void): void => {
      const raw = netConnect(proxy.port, proxy.host);
      raw.once('error', (e) => cb(e));
      raw.once('connect', () => {
        raw.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
      });
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        raw.removeListener('data', onData);
        const statusLine = buf.toString('latin1', 0, buf.indexOf('\r\n'));
        if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
          raw.destroy();
          cb(new Error(`gateway CONNECT failed: ${statusLine}`));
          return;
        }
        const tlsSock = tlsConnect({ socket: raw, servername: targetHost, rejectUnauthorized: false }, () =>
          cb(null, tlsSock),
        );
        tlsSock.once('error', (e) => cb(e));
      };
      raw.on('data', onData);
    };

    const upstream = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: targetHost },
        createConnection: createConnection as never,
      },
      (upRes) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
        }
        upRes.on('error', (e) => done(e));
        upRes.on('end', () => done());
        upRes.pipe(clientRes);
      },
    );
    upstream.on('error', (e) => done(e));
    clientReq.on('error', (e) => done(e));
    clientReq.pipe(upstream);
  });
}

/**
 * Build a OneCLI broker over an injected gateway-address resolver. Generic and
 * testable; the production resolver (OneCLI SDK) is wired by the boot caller.
 */
export function createOneCliBroker(resolveForwardConfig: ForwardConfigResolver): CredentialBroker {
  // Per-IP cached forward config (the in-flight or resolved promise). A pending
  // promise means init is still running; tryForward awaits it. A rejected one
  // means init failed → tryForward fails closed.
  const byIp = new Map<string, Promise<ForwardConfig>>();

  return {
    id: 'onecli',
    priority: 100,

    onContainerRouted(ip: string, scope): void {
      // scope is the GroupScope (folder). Kick off resolution eagerly; cache the
      // promise so a request arriving mid-init awaits it.
      const p = resolveForwardConfig(ip, scope as unknown as string);
      p.catch((err: unknown) => {
        log.error('onecli broker: forward-config init failed', { ip, err });
      });
      byIp.set(ip, p);
    },

    onContainerReleased(ip: string): void {
      byIp.delete(ip);
    },

    async tryForward(clientReq, clientRes, targetHost, targetPort, _scope, sourceIP): Promise<void> {
      const ip = sourceIP ?? '';
      // Await the eager init; if it never ran (e.g. proxy started late), there
      // is no config and we fail closed — never pass through.
      const pending = byIp.get(ip);
      if (!pending) {
        throw new Error(`onecli broker: no forward config for ip ${ip}`);
      }
      const cfg = await pending; // rejects → caller fails closed
      await forwardViaConnectProxy(cfg, clientReq, clientRes, targetHost, targetPort);
    },
  };
}

/** Parse a proxy URL (e.g. `http://host:3128`) into a {host,port}. */
function parseProxyAddress(raw: string): ForwardConfig {
  const u = new URL(raw);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { host: u.hostname, port };
}

/**
 * Production forward-config resolver (OneCLI SDK). For a container:
 *   1. resolve the group's agent identifier (own → granted-borrow → default
 *      `agentGroup.id`), `onecli-credential.ts`;
 *   2. `ensureAgent` (provision the per-group OneCLI agent — kept from the v2
 *      wiring; `applyContainerConfig` is NOT called, the MITM proxy owns
 *      egress);
 *   3. `getContainerConfig(agentId)` and read the **per-agent** egress proxy
 *      address from its env (the gateway may hand a different address per
 *      agent, §8). CA is ignored (§3a).
 *
 * Gateway-gated: exercised only against a live OneCLI (the env key + per-agent
 * address are the UNVERIFIED seam — the forward transport itself is proven by
 * `onecli-broker.test.ts` against a stub).
 */
function makeOneCliResolver(onecli: OneCLI): ForwardConfigResolver {
  return async (_ip, folder) => {
    const group = getAgentGroupByFolder(folder);
    const agentId = resolveAgentIdentifier(folder, group?.id ?? folder);
    await onecli.ensureAgent({ name: group?.name ?? folder, identifier: agentId });
    const cfg = await onecli.getContainerConfig({ agent: agentId });
    const env = cfg.env as Record<string, string>;
    const proxyUrl = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.https_proxy ?? env.http_proxy;
    if (!proxyUrl) {
      throw new Error(`onecli broker: no proxy address in container config for agent ${agentId}`);
    }
    return parseProxyAddress(proxyUrl);
  };
}

/**
 * Register the OneCLI broker at boot — only when OneCLI is configured
 * (`ONECLI_URL` present). With no OneCLI connection there is nothing to broker
 * to, so we don't register (a `broker_config` row naming `onecli` is then
 * inert). Per-container network work (`ensureAgent`/`getContainerConfig`) stays
 * demand-gated — it runs only in `onContainerRouted`, fired only for routed
 * containers. Pass `deps` in tests.
 */
export function registerOneCliBroker(deps?: { resolveForwardConfig?: ForwardConfigResolver }): void {
  if (!deps?.resolveForwardConfig && !ONECLI_URL) {
    log.info('onecli broker: ONECLI_URL not set — broker not registered');
    return;
  }
  const resolver = deps?.resolveForwardConfig ?? makeOneCliResolver(getOneCli());
  registerCredentialBroker(createOneCliBroker(resolver));
}
