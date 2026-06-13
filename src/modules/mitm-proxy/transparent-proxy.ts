/**
 * Transparent TLS proxy for iptables-redirected connections.
 *
 * Wraps an HTTP server with first-byte detection:
 *   0x16 (TLS ClientHello) → parse SNI → check if host should be intercepted
 *     yes → TLS terminate → dispatch via shared MITM server
 *     no  → TCP passthrough
 *   anything else → delegate to the wrapped HTTP server (HTTP proxy / internal endpoints)
 */
import { Server } from 'http';
import { TLSSocket } from 'tls';
import { createServer as createNetServer, connect as netConnect, Socket, Server as NetServer } from 'net';
import { Duplex } from 'stream';

import { logger } from './logger.js';
import { parseSni, type MitmContext } from './mitm-ca.js';

// No import from credential-proxy.ts — callbacks are passed via options
// to avoid circular dependencies and enable isolated testing.

/** Returned from shouldIntercept to force MITM with an optional tap resolver. */
export interface InterceptResult {
  /** If non-null, passed to emitMitmConnection for socket-level tapping. */
  tapResolver?: unknown;
}

export interface TransparentProxyOptions {
  /** The HTTP server to delegate non-TLS connections to. */
  httpServer: Server;
  /** MITM context for cert generation. */
  mitmCtx: MitmContext;
  /** Should this hostname be TLS-terminated? null = passthrough, InterceptResult = MITM. */
  shouldIntercept(hostname: string, scope: import('./types.js').GroupScope, sourceIP: string): InterceptResult | null;
  /** Resolve scope from a container's source IP. Returns null for unknown IPs. */
  resolveScope(sourceIP: string): import('./types.js').GroupScope | null;
  /** Emit a TLS socket into the shared MITM dispatcher with connection metadata. */
  emitMitmConnection(
    socket: object,
    targetHost: string,
    targetPort: number,
    scope: import('./types.js').GroupScope,
    sourceIP?: string,
    tapResolver?: unknown,
  ): void;
}

/**
 * Create a net.Server that dispatches by first byte:
 * TLS → transparent interception, HTTP → delegate to httpServer.
 */
export function createTransparentServer(opts: TransparentProxyOptions): NetServer {
  const { httpServer, mitmCtx } = opts;

  return createNetServer((socket: Socket) => {
    logger.debug({ remoteIP: socket.remoteAddress }, 'Transparent: new connection');
    socket.once('data', (firstChunk: Buffer) => {
      logger.debug(
        {
          byte0: firstChunk[0],
          len: firstChunk.length,
          remoteIP: socket.remoteAddress,
        },
        'Transparent: first chunk',
      );
      if (firstChunk[0] !== 0x16) {
        // Not TLS — push data back and let HTTP server handle it
        socket.unshift(firstChunk);
        httpServer.emit('connection', socket);
        return;
      }

      // Pause immediately — no data listener is attached yet.
      // The Duplex wrapper will resume when the TLS layer pulls from it.
      socket.pause();

      // TLS ClientHello — parse SNI for hostname. Lowercase at the system
      // boundary; the pipeline (matching, bound-domain stamp + guard) assumes
      // lowercase domains.
      const hostname = parseSni(firstChunk)?.toLowerCase();
      if (!hostname) {
        logger.debug('Transparent: no SNI in ClientHello, dropping');
        socket.destroy();
        return;
      }
      logger.debug({ hostname, remoteIP: socket.remoteAddress }, 'Transparent: SNI parsed');

      // No source address → unidentifiable connection; drop it rather than
      // resolving scope / keying the container-rule tier off an empty IP.
      const sourceIP = socket.remoteAddress || null;
      const scope = sourceIP ? opts.resolveScope(sourceIP) : null;
      if (!sourceIP || !scope) {
        logger.warn(
          { remoteIP: socket.remoteAddress ?? '(none)', host: hostname },
          'Rejecting connection from unknown container',
        );
        socket.destroy();
        return;
      }

      const interceptResult = opts.shouldIntercept(hostname, scope, sourceIP);
      if (!interceptResult) {
        // No rules and no tap for this host — TCP passthrough (no TLS termination).
        // NOTE: DNS re-resolves the hostname on the host. Split-horizon DNS
        // (hostnames only resolvable in the container's network) won't work.
        // Using SO_ORIGINAL_DST from iptables would fix this but is overkill.
        logger.debug({ hostname, remoteIP: socket.remoteAddress }, 'Transparent: PASSTHROUGH (no intercept rule)');
        socket.resume();
        const upstream = netConnect(443, hostname, () => {
          upstream.write(firstChunk);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on('error', (err) => {
          logger.debug({ err, host: hostname }, 'Transparent passthrough error');
          socket.destroy();
        });
        socket.on('error', () => upstream.destroy());
        return;
      }

      // TLS-terminate with forged cert, then dispatch per-request via the
      // shared MITM dispatcher (avoids creating a new http.Server per connection).
      //
      // We can't feed the raw socket directly to TLSSocket after reading
      // from it — Node's TLS layer needs to see the ClientHello from a
      // fresh readable stream. Create a Duplex wrapper that replays the
      // first chunk, then proxies the rest.
      const hostCert = mitmCtx.getHostCert(hostname);

      let pushedFirst = false;
      const wrapper = new Duplex({
        read() {
          if (!pushedFirst) {
            pushedFirst = true;
            this.push(firstChunk);
            socket.on('data', (chunk) => {
              if (!this.push(chunk)) socket.pause();
            });
            socket.on('end', () => this.push(null));
            socket.on('error', (err) => this.destroy(err));
            // Safe to resume — data listener is now attached
            socket.resume();
          }
        },
        write(chunk, _enc, cb) {
          socket.write(chunk, cb);
        },
        final(cb) {
          socket.end(cb);
        },
        destroy(err, cb) {
          socket.destroy(err ?? undefined);
          cb(err);
        },
      });
      wrapper.on('error', () => socket.destroy());
      // Back-pressure: when wrapper is drained, resume socket
      wrapper.on('drain', () => socket.resume());

      const tlsSocket = new TLSSocket(wrapper as any, {
        isServer: true,
        key: hostCert.keyPem,
        cert: hostCert.certPem,
      });

      tlsSocket.on('secure', () => {
        logger.debug({ hostname }, 'Transparent: TLS handshake complete');
      });

      tlsSocket.on('error', (err) => {
        logger.debug({ err, hostname }, 'Transparent: TLS socket error');
        socket.destroy();
      });

      opts.emitMitmConnection(tlsSocket, hostname, 443, scope, socket.remoteAddress || '', interceptResult.tapResolver);
    });
  });
}
