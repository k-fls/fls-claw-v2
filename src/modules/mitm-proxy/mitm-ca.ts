/**
 * MITM certificate infrastructure for credential-proxy.ts.
 *
 * CA management, on-demand host cert generation (LRU-cached), and SNI parsing.
 * Uses node-forge. The CA cert is persisted to disk so containers trust it
 * across restarts.
 */
import fs from 'fs';
import path from 'path';
import forge from 'node-forge';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// CA certificate management
// ---------------------------------------------------------------------------

interface CaBundle {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  keyPem: string;
  certPem: string;
}

function getDefaultCaDir(): string {
  const home = process.env.HOME || '/tmp';
  return path.join(home, '.config', 'nanoclaw', 'mitm-ca');
}

function loadOrCreateCa(caDir: string): CaBundle {
  const keyPath = path.join(caDir, 'ca.key');
  const certPath = path.join(caDir, 'ca.crt');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const keyPem = fs.readFileSync(keyPath, 'utf-8');
    const certPem = fs.readFileSync(certPath, 'utf-8');
    return {
      key: forge.pki.privateKeyFromPem(keyPem),
      cert: forge.pki.certificateFromPem(certPem),
      keyPem,
      certPem,
    };
  }

  logger.info({ caDir }, 'Generating MITM CA certificate');
  fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'NanoClaw MITM CA' },
    { name: 'organizationName', value: 'NanoClaw' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      cRLSign: true,
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certPem, { mode: 0o644 });

  return { key: keys.privateKey, cert, keyPem, certPem };
}

// ---------------------------------------------------------------------------
// LRU cert cache
// ---------------------------------------------------------------------------

class CertLruCache {
  private cache = new Map<string, { keyPem: string; certPem: string }>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(hostname: string): { keyPem: string; certPem: string } | undefined {
    const entry = this.cache.get(hostname);
    if (entry) {
      this.cache.delete(hostname);
      this.cache.set(hostname, entry);
    }
    return entry;
  }

  set(hostname: string, entry: { keyPem: string; certPem: string }): void {
    if (this.cache.has(hostname)) {
      this.cache.delete(hostname);
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(hostname, entry);
  }

  get size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Host cert generation
// ---------------------------------------------------------------------------

function generateHostCert(hostname: string, ca: CaBundle): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Clear the high bit of the first random byte so the ASN.1 INTEGER
  // is always positive without needing a leading 0x00 pad byte.
  // Unconditional '00' prefix causes "illegal padding" errors on strict
  // DER parsers (OpenSSL 3.x / Node 21+) when the next byte is < 0x80.
  const rnd = forge.random.getBytesSync(16);
  const masked = String.fromCharCode(rnd.charCodeAt(0) & 0x7f) + rnd.slice(1);
  cert.serialNumber = forge.util.bytesToHex(masked);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: 'subjectAltName',
      altNames: [/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname }],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

// ---------------------------------------------------------------------------
// Shared MITM context (used by credential-proxy for transparent mode)
// ---------------------------------------------------------------------------

export interface MitmContext {
  /** Get or generate a TLS cert for a hostname (LRU-cached). */
  getHostCert(hostname: string): { keyPem: string; certPem: string };
  /** CA cert PEM (for mounting into containers). */
  caCertPem: string;
}

/**
 * Create a MITM context with CA and cert cache, without starting a server.
 * Used by credential-proxy.ts to handle transparent TLS connections.
 */
export function createMitmContext(caDir?: string, certCacheSize = 100): MitmContext {
  const ca = loadOrCreateCa(caDir || getDefaultCaDir());
  const certCache = new CertLruCache(certCacheSize);

  return {
    getHostCert(hostname: string) {
      let cached = certCache.get(hostname);
      if (!cached) {
        cached = generateHostCert(hostname, ca);
        certCache.set(hostname, cached);
        logger.debug({ hostname, cacheSize: certCache.size }, 'Generated host cert');
      }
      return cached;
    },
    caCertPem: ca.certPem,
  };
}

// ---------------------------------------------------------------------------
// SNI parsing for transparent mode
// ---------------------------------------------------------------------------

/**
 * Parse the Server Name Indication (SNI) from a TLS ClientHello message.
 * Returns the hostname or null if not found / not a TLS handshake.
 */
export function parseSni(buf: Buffer): string | null {
  // Minimum TLS record: type(1) + version(2) + length(2) + handshake_type(1) = 6
  if (buf.length < 6) return null;
  // ContentType: Handshake = 0x16
  if (buf[0] !== 0x16) return null;

  // Record length
  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) return null;

  // HandshakeType: ClientHello = 0x01
  if (buf[5] !== 0x01) return null;

  // Skip: handshake_type(1) + length(3) + client_version(2) + random(32) = 38
  let offset = 5 + 1 + 3 + 2 + 32;
  if (offset + 1 > buf.length) return null;

  // Session ID (variable length)
  const sessionIdLen = buf[offset];
  offset += 1 + sessionIdLen;
  if (offset + 2 > buf.length) return null;

  // Cipher suites (variable length)
  const cipherSuitesLen = buf.readUInt16BE(offset);
  offset += 2 + cipherSuitesLen;
  if (offset + 1 > buf.length) return null;

  // Compression methods (variable length)
  const compressionLen = buf[offset];
  offset += 1 + compressionLen;
  if (offset + 2 > buf.length) return null;

  // Extensions length
  const extensionsLen = buf.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLen;
  if (extensionsEnd > buf.length) return null;

  // Walk extensions
  while (offset + 4 <= extensionsEnd) {
    const extType = buf.readUInt16BE(offset);
    const extLen = buf.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + extLen > extensionsEnd) return null;

    if (extType === 0x0000) {
      // SNI extension — server_name_list
      if (extLen < 2) return null;
      const listLen = buf.readUInt16BE(offset);
      let pos = offset + 2;
      const listEnd = offset + 2 + listLen;
      while (pos + 3 <= listEnd) {
        const nameType = buf[pos];
        const nameLen = buf.readUInt16BE(pos + 1);
        pos += 3;
        if (pos + nameLen > listEnd) return null;
        if (nameType === 0) {
          // host_name type
          return buf.subarray(pos, pos + nameLen).toString('ascii');
        }
        pos += nameLen;
      }
      return null;
    }

    offset += extLen;
  }

  return null;
}

// ---------------------------------------------------------------------------
/** Path to the CA certificate (for mounting into containers) */
export function getMitmCaCertPath(caDir?: string): string {
  return path.join(caDir || getDefaultCaDir(), 'ca.crt');
}
