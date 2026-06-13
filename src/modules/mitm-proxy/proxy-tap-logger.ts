/**
 * JSONL logger for proxy traffic — logs HTTP request/response URLs, headers, and bodies.
 *
 * Activated by two env vars:
 *   PROXY_TAP_DOMAIN  — hostname filter (substring match, e.g. "anthropic.com")
 *   PROXY_TAP_PATH    — path regex filter (e.g. "/v1/messages")
 *
 * Writes to data/proxy-tap.jsonl. Each line is a JSON object:
 *   { ts, scope, host, direction, method?, url?, statusCode?, headers }
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { ProxyTapFilter, ProxyTapResult, ProxyTapCallback, ProxyTapEvent } from './credential-proxy.js';
import { logger } from './logger.js';
import type { CredentialProxy } from './credential-proxy.js';

export const LOG_FILE = path.join(DATA_DIR, 'proxy-tap.jsonl');

// ---------------------------------------------------------------------------
// Active tap state (for status reporting via /tap command)
// ---------------------------------------------------------------------------

let _activeTap: { domain: string; path: string } | null = null;

/** Returns the current tap filter config, or null if inactive. */
export function getActiveTap(): { domain: string; path: string } | null {
  return _activeTap;
}

/** Clear the active tap state. */
export function clearActiveTap(): void {
  _activeTap = null;
}

// ---------------------------------------------------------------------------
// Tap log reading (for /tap list command)
// ---------------------------------------------------------------------------

/**
 * Redact long alphanumeric+separator tokens in a string.
 * Any sequence of [a-zA-Z0-9_\-./+=] longer than 15 chars becomes
 * first-5 + "…" + last-5.
 */
function redactLongTokens(s: string): string {
  return s.replace(/[a-zA-Z0-9_\-./+=]{16,}/g, (m) => m.slice(0, 5) + '…' + m.slice(-5));
}

/** Format a single tap log entry for display. */
function formatTapEntry(line: string): string | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const ts = String(entry.ts ?? '')
    .replace(/T/, ' ')
    .replace(/\.\d+Z$/, 'Z');
  const cid = entry.connId ? String(entry.connId).slice(0, 8) : '';
  const dir = entry.direction === 'outbound' ? '→' : '←';
  const scope = entry.scope ? ` [${entry.scope}]` : '';

  // Body entry
  if (entry.type === 'body') {
    let body = '';
    if (typeof entry.body === 'string') {
      try {
        body = Buffer.from(entry.body, 'base64').toString('utf-8');
      } catch {
        body = entry.body;
      }
    }
    body = redactLongTokens(body);
    // Truncate long bodies for display
    if (body.length > 300) body = body.slice(0, 300) + '…';
    const label = entry.method ? `${entry.method} ${entry.url ?? ''}` : `${entry.statusCode ?? ''}`;
    return `${ts} ${cid} ${dir}${scope} BODY ${label}\n${body}`;
  }

  // Header entry
  const method = entry.method ? `${entry.method} ` : '';
  const url = entry.url ?? '';
  const status = entry.statusCode != null ? `${entry.statusCode} ` : '';
  const host = entry.host ?? '';

  let headerStr = '';
  if (entry.headers && typeof entry.headers === 'object') {
    const hdrs = entry.headers as Record<string, string>;
    headerStr = Object.entries(hdrs)
      .map(([k, v]) => `  ${k}: ${redactLongTokens(v)}`)
      .join('\n');
  }

  return `${ts} ${cid} ${dir}${scope} ${method}${status}${url} (${host})${headerStr ? '\n' + headerStr : ''}`;
}

/**
 * Read tap log entries.
 * @param mode      'head' or 'tail' (default: 'tail')
 * @param count     Number of entries (default: 5)
 * @param showBody  Include body entries (default: false)
 */
export function readTapLog(
  mode: 'head' | 'tail' = 'tail',
  count = 5,
  showBody = false,
  file: string = LOG_FILE,
): string {
  if (!fs.existsSync(file)) return 'No tap log file.';

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n').filter((l) => {
    if (!l.trim()) return false;
    if (!showBody) {
      try {
        if (JSON.parse(l).type === 'body') return false;
      } catch {}
    }
    return true;
  });
  if (lines.length === 0) return 'Tap log is empty.';

  const selected = mode === 'head' ? lines.slice(0, count) : lines.slice(-count);

  const formatted = selected.map(formatTapEntry).filter((e): e is string => e !== null);

  if (formatted.length === 0) return 'No parseable entries.';

  const label =
    mode === 'head' ? `First ${formatted.length} of ${lines.length}` : `Last ${formatted.length} of ${lines.length}`;
  return `${label} entries:\n\n${formatted.join('\n\n')}`;
}

// Simple incremental HTTP parser for extracting request/response lines + headers
// from raw bytes. Accumulates chunks until headers are complete, emits once.

interface ParsedHead {
  /** 'request' or 'response' */
  kind: 'request' | 'response';
  /** e.g. "GET /v1/messages HTTP/1.1" or "HTTP/1.1 200 OK" */
  startLine: string;
  /** Parsed headers as key-value pairs (last value wins for duplicates). */
  headers: Record<string, string>;
  // Extracted fields for convenience:
  method?: string;
  url?: string;
  statusCode?: number;
}

function parseHead(raw: string): ParsedHead | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;

  const headerBlock = raw.slice(0, headerEnd);
  const lines = headerBlock.split('\r\n');
  const startLine = lines[0];
  if (!startLine) return null;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon > 0) {
      headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
    }
  }

  // Request: "METHOD /path HTTP/1.1"
  const reqMatch = startLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\//);
  if (reqMatch) {
    return {
      kind: 'request',
      startLine,
      headers,
      method: reqMatch[1],
      url: reqMatch[2],
    };
  }

  // Response: "HTTP/1.1 STATUS REASON"
  const resMatch = startLine.match(/^HTTP\/\S+\s+(\d+)/);
  if (resMatch) {
    return {
      kind: 'response',
      startLine,
      headers,
      statusCode: parseInt(resMatch[1], 10),
    };
  }

  return null;
}

/** Max body size to capture (prevent unbounded memory for large streaming responses). */
const MAX_BODY_CAPTURE = 64 * 1024; // 64 KB

/** Max bytes to accumulate before declaring non-HTTP. */
const NON_HTTP_THRESHOLD = 8 * 1024; // 8 KB

// ---------------------------------------------------------------------------
// TapControl — communication channel between dispatcher and tap callback
// ---------------------------------------------------------------------------

/**
 * Called by the mitmDispatcher after matching a request to a HostRule.
 * The tap callback uses this to decide whether to emit or discard.
 * @param providerId — matched provider, or null if no rule matched.
 */
export type TapExclusionCheck = (providerId: string | null) => void;

/**
 * Create a ProxyTapCallback that parses HTTP heads + bodies and writes JSONL.
 *
 * Emission is deferred until the dispatcher resolves TapControl (sets the
 * matched provider). If the provider is in excludeProviders, nothing is logged.
 * Non-HTTP streams get a connection-only entry — no data capture.
 */
function createTapCallback(
  fd: number,
  host: string,
  scope: string,
  pathRe: RegExp,
  excludeProviders: ReadonlySet<string>,
): { callback: ProxyTapCallback; checkExclusion: TapExclusionCheck } {
  const connId = crypto.randomUUID();

  // Per-direction state
  const bufs: Record<string, Buffer[]> = { inbound: [], outbound: [] };
  const headParsed: Record<string, ParsedHead | null> = {
    inbound: null,
    outbound: null,
  };
  const headEmitted: Record<string, boolean> = {
    inbound: false,
    outbound: false,
  };
  const bodyBufs: Record<string, Buffer[]> = { inbound: [], outbound: [] };
  const bodyLen: Record<string, number> = { inbound: 0, outbound: 0 };
  const expectedLen: Record<string, number> = { inbound: -1, outbound: -1 };
  const bodyEmitted: Record<string, boolean> = {
    inbound: false,
    outbound: false,
  };
  let pathMatched = false;
  let excluded = false;
  let nonHttp = false;
  let flushed = false;

  function isExcluded(): boolean {
    return excluded || nonHttp;
  }

  function emitHead(direction: string, parsed: ParsedHead) {
    const entry = {
      ts: new Date().toISOString(),
      connId,
      scope,
      host,
      direction,
      ...(parsed.method && { method: parsed.method }),
      ...(parsed.url && { url: parsed.url }),
      ...(parsed.statusCode != null && { statusCode: parsed.statusCode }),
      headers: parsed.headers,
    };
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    } catch {}
  }

  function emitBody(direction: string, parsed: ParsedHead, rawBody: Buffer) {
    const isChunked = parsed.headers['transfer-encoding'] === 'chunked';

    // Strip chunked framing if present (hex-length\r\n...data...\r\n)
    let bodyBuf = rawBody;
    if (isChunked) {
      try {
        const dechunked: Buffer[] = [];
        let pos = 0;
        const raw = rawBody;
        while (pos < raw.length) {
          const lineEnd = raw.indexOf('\r\n', pos);
          if (lineEnd < 0) break;
          const chunkSize = parseInt(raw.subarray(pos, lineEnd).toString('ascii'), 16);
          if (chunkSize === 0) break;
          pos = lineEnd + 2;
          if (pos + chunkSize > raw.length) {
            dechunked.push(raw.subarray(pos));
            break;
          }
          dechunked.push(raw.subarray(pos, pos + chunkSize));
          pos = pos + chunkSize + 2; // skip trailing \r\n
        }
        bodyBuf = Buffer.concat(dechunked);
      } catch {
        // Fall through with raw body
      }
    }

    const body = bodyBuf.toString('base64');

    const entry = {
      ts: new Date().toISOString(),
      connId,
      scope,
      host,
      direction,
      type: 'body' as const,
      ...(parsed.method && { method: parsed.method }),
      ...(parsed.url && { url: parsed.url }),
      ...(parsed.statusCode != null && { statusCode: parsed.statusCode }),
      body,
    };
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    } catch {}
  }

  function emitConnectionOnly() {
    const entry = {
      ts: new Date().toISOString(),
      connId,
      scope,
      host,
      type: 'connection' as const,
    };
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    } catch {}
  }

  /** Called by the dispatcher with the matched provider ID. Idempotent. */
  function checkExclusion(providerId: string | null): void {
    if (flushed) return;
    flushed = true;
    if (providerId && excludeProviders.has(providerId)) {
      excluded = true;
      return;
    }
    // Emit any buffered heads + bodies
    for (const dir of ['inbound', 'outbound']) {
      if (headParsed[dir] && pathMatched && !headEmitted[dir]) {
        headEmitted[dir] = true;
        emitHead(dir, headParsed[dir]!);
      }
      if (
        headParsed[dir] &&
        pathMatched &&
        !bodyEmitted[dir] &&
        bodyLen[dir] > 0 &&
        expectedLen[dir] >= 0 &&
        bodyLen[dir] >= expectedLen[dir]
      ) {
        bodyEmitted[dir] = true;
        emitBody(dir, headParsed[dir]!, Buffer.concat(bodyBufs[dir]));
      }
    }
  }

  const callback = (event: ProxyTapEvent) => {
    const { direction, chunk } = event;

    if (direction === 'close') {
      // Non-HTTP stream that never parsed — emit connection-only
      if (!headParsed.inbound && !headParsed.outbound) {
        if (!isExcluded()) emitConnectionOnly();
        return;
      }
      // Dispatcher never resolved (e.g. non-HTTP after MITM) — default to capture
      if (!flushed && !isExcluded()) {
        for (const dir of ['inbound', 'outbound']) {
          if (headParsed[dir] && !headEmitted[dir] && pathMatched) {
            headEmitted[dir] = true;
            emitHead(dir, headParsed[dir]!);
          }
        }
      }
      // Flush remaining body
      for (const dir of ['inbound', 'outbound']) {
        if (headParsed[dir] && !bodyEmitted[dir] && bodyLen[dir] > 0 && pathMatched && !isExcluded()) {
          bodyEmitted[dir] = true;
          emitBody(dir, headParsed[dir]!, Buffer.concat(bodyBufs[dir]));
        }
      }
      return;
    }

    if (isExcluded()) return;

    // Phase 1: accumulate until headers are complete
    if (!headParsed[direction]) {
      // Ensure we have a real Buffer (not a string masquerading as one)
      const safeChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string, 'latin1');
      bufs[direction].push(safeChunk);
      const totalBufLen = bufs[direction].reduce((a, b) => a + b.length, 0);

      // Non-HTTP detection: too many bytes without finding headers
      if (totalBufLen > NON_HTTP_THRESHOLD) {
        nonHttp = true;
        bufs[direction] = []; // free buffers
        emitConnectionOnly();
        return;
      }

      const fullBuf = Buffer.concat(bufs[direction]);
      const raw = fullBuf.toString('latin1');
      const parsed = parseHead(raw);
      if (!parsed) return; // headers not yet complete

      headParsed[direction] = parsed;

      // Extract body portion from the same buffer before freeing
      const headerEndByte = fullBuf.indexOf('\r\n\r\n');
      if (headerEndByte >= 0) {
        const bodyStart = headerEndByte + 4;
        if (bodyStart < fullBuf.length) {
          const bodyChunk = fullBuf.subarray(bodyStart);
          bodyBufs[direction].push(Buffer.from(bodyChunk));
          bodyLen[direction] += bodyChunk.length;
        }
      }
      bufs[direction] = []; // free header buffers

      // Apply path filter on the request
      if (parsed.kind === 'request') {
        pathMatched = !parsed.url || pathRe.test(parsed.url);
      }

      // If dispatcher already resolved, emit immediately; otherwise defer
      if (flushed) {
        if (pathMatched && !headEmitted[direction]) {
          headEmitted[direction] = true;
          emitHead(direction, parsed);
        }
      }
      // else: flush() will emit when the dispatcher calls it

      // Determine expected body length from content-length header
      const cl = parsed.headers['content-length'];
      if (cl) {
        expectedLen[direction] = parseInt(cl, 10);
      }

      // Check if body is already complete
      if (expectedLen[direction] >= 0 && bodyLen[direction] >= expectedLen[direction] && pathMatched && flushed) {
        bodyEmitted[direction] = true;
        emitBody(direction, parsed, Buffer.concat(bodyBufs[direction]));
      }
      return;
    }

    // Phase 2: accumulate body chunks
    if (bodyEmitted[direction]) return;
    if (bodyLen[direction] >= MAX_BODY_CAPTURE) {
      if (pathMatched && flushed) {
        bodyEmitted[direction] = true;
        emitBody(direction, headParsed[direction]!, Buffer.concat(bodyBufs[direction]));
      }
      return;
    }

    const safeBodyChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string, 'latin1');
    bodyBufs[direction].push(safeBodyChunk);
    bodyLen[direction] += safeBodyChunk.length;

    // Emit body when content-length is reached
    if (expectedLen[direction] >= 0 && bodyLen[direction] >= expectedLen[direction] && pathMatched && flushed) {
      bodyEmitted[direction] = true;
      emitBody(direction, headParsed[direction]!, Buffer.concat(bodyBufs[direction]));
    }
  };

  return { callback, checkExclusion };
}

/**
 * Build a ProxyTapFilter that logs to a JSONL file.
 * @param domainPattern     Regex matching target hostnames
 * @param pathPattern       Regex matching request paths
 * @param logFile           Output file path (appended)
 * @param excludeProviders  Provider IDs to exclude from logging (default: empty)
 * @param excludeHosts      Hostname regexes never tapped, regardless of the
 *                          provider that matches them. Used to drop the agent
 *                          runtime's own model endpoint (e.g. api.anthropic.com
 *                          or a configured Ollama host) — traffic that may
 *                          match no credential-provider rule, so provider-id
 *                          exclusion can't reach it. (default: none)
 */
export function createTapFilter(
  domainPattern: RegExp,
  pathPattern: RegExp,
  logFile: string,
  excludeProviders: ReadonlySet<string> = new Set(),
  excludeHosts: readonly RegExp[] = [],
): ProxyTapFilter {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');

  _activeTap = { domain: domainPattern.source, path: pathPattern.source };

  logger.info(
    {
      domain: domainPattern.source,
      path: pathPattern.source,
      logFile,
      excludeProviders: [...excludeProviders],
      excludeHosts: excludeHosts.map((re) => re.source),
    },
    'Proxy tap logger activated',
  );

  return (hostname: string, _scope: string) => {
    if (excludeHosts.some((re) => re.test(hostname))) return null;
    if (!domainPattern.test(hostname)) return null;
    return (targetHost: string, connScope: string) => {
      const { callback, checkExclusion } = createTapCallback(fd, targetHost, connScope, pathPattern, excludeProviders);
      return { callback, checkExclusion };
    };
  };
}

/**
 * Build a ProxyTapFilter from env vars. Returns null if not configured.
 *
 * Env vars:
 *   PROXY_TAP_DOMAIN  — hostname regex (e.g. "anthropic\\.com")
 *   PROXY_TAP_PATH    — request path regex (e.g. "/v1/messages")
 *   PROXY_TAP_EXCLUDE — comma-separated provider IDs to exclude
 */
export function createTapFilterFromEnv(proxy: CredentialProxy): ProxyTapFilter | null {
  const domain = process.env.PROXY_TAP_DOMAIN;
  const pathPattern = process.env.PROXY_TAP_PATH;
  if (!domain || !pathPattern) return null;

  const { excluded: excludeProviders, unknown } = proxy.parseTapExclude(process.env.PROXY_TAP_EXCLUDE);
  if (unknown.length > 0) {
    logger.warn({ unknown }, 'PROXY_TAP_EXCLUDE contains unknown provider IDs');
  }

  return createTapFilter(new RegExp(domain), new RegExp(pathPattern), LOG_FILE, excludeProviders);
}
