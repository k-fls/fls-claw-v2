/**
 * OneCLI broker forward — proven end-to-end against a stub CONNECT MITM proxy
 * (no real OneCLI; the §3a forward mechanism is what's under test).
 *
 * Shape: a local TCP server accepts `CONNECT host:443`, replies 200, then
 * TLS-terminates (self-signed) and answers with an injected marker header +
 * body echoing the request line — i.e. it stands in for OneCLI's gateway. The
 * broker forwards a decrypted request through it and pipes the response back;
 * we assert the injected marker + echo arrived, proving the CONNECT-tunnel +
 * TLS (cert ignored) + HTTP-over-it + pipe path works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { asGroupScope } from '../modules/mitm-proxy/index.js';

import { createOneCliBroker } from './onecli-broker.js';

function makeReq(method: string, url: string): import('http').IncomingMessage {
  const r = Readable.from([]) as unknown as import('http').IncomingMessage;
  r.method = method;
  r.url = url;
  r.headers = { 'x-from': 'container' };
  return r;
}

function makeRes(): {
  res: import('http').ServerResponse;
  done: Promise<void>;
  status: () => number;
  body: () => string;
  headers: () => Record<string, unknown>;
} {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const st = { status: 0, headers: {} as Record<string, unknown>, chunks: [] as Buffer[] };
  const res = {
    headersSent: false,
    writeHead(code: number, headers?: Record<string, unknown>) {
      st.status = code;
      st.headers = headers ?? {};
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    write(c: Buffer | string) {
      st.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return true;
    },
    end(c?: Buffer | string) {
      if (c) st.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      resolveDone();
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
  } as unknown as import('http').ServerResponse;
  return {
    res,
    done,
    status: () => st.status,
    body: () => Buffer.concat(st.chunks).toString(),
    headers: () => st.headers,
  };
}

describe('OneCLI broker forward (stub CONNECT MITM proxy)', () => {
  let tlsServer: https.Server;
  let connectServer: net.Server;
  let port: number;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-broker-tls-'));
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=gateway',
    ]);

    // The "gateway": after CONNECT, it injects a marker and echoes the request.
    tlsServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
      res.writeHead(200, { 'x-injected': 'real-secret', 'content-type': 'text/plain' });
      res.end(`GATEWAY ${req.method} ${req.url} from=${req.headers['x-from']}`);
    });

    connectServer = net.createServer((sock) => {
      sock.once('data', () => {
        // Assume a CONNECT request; accept it and hand the socket to TLS.
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        tlsServer.emit('connection', sock);
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => connectServer.listen(0, '127.0.0.1', r));
    port = (connectServer.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => connectServer.close(() => r()));
    tlsServer.close();
  });

  it('forwards through the gateway and pipes back the injected response', async () => {
    const broker = createOneCliBroker(async () => ({ host: '127.0.0.1', port }));
    broker.onContainerRouted!('172.17.0.50', asGroupScope('grp'));

    const r = makeRes();
    await broker.tryForward(
      makeReq('GET', '/v1/thing'),
      r.res,
      'api.example.com',
      443,
      asGroupScope('grp'),
      '172.17.0.50',
    );
    await r.done;
    expect(r.status()).toBe(200);
    expect(r.headers()['x-injected']).toBe('real-secret');
    expect(r.body()).toBe('GATEWAY GET /v1/thing from=container');
  });

  it('fails closed when no per-container init ran (no forward config)', async () => {
    const broker = createOneCliBroker(async () => ({ host: '127.0.0.1', port }));
    // onContainerRouted NOT called for this ip
    await expect(
      broker.tryForward(makeReq('GET', '/x'), makeRes().res, 'api.example.com', 443, asGroupScope('grp'), '9.9.9.9'),
    ).rejects.toThrow(/no forward config/);
  });

  it('fails closed when the per-container init rejected (gateway down)', async () => {
    const broker = createOneCliBroker(async () => {
      throw new Error('gateway unreachable');
    });
    broker.onContainerRouted!('172.17.0.51', asGroupScope('grp'));
    await expect(
      broker.tryForward(
        makeReq('GET', '/x'),
        makeRes().res,
        'api.example.com',
        443,
        asGroupScope('grp'),
        '172.17.0.51',
      ),
    ).rejects.toThrow(/gateway unreachable/);
  });
});
