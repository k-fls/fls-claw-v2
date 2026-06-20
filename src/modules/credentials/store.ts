/**
 * Per-scope plaintext credential store (C7s).
 *
 * Each (CredentialScope, providerId) pair is one plaintext JSON file at
 *   ${XDG_CONFIG_HOME:-~/.config}/nanoclaw/credentials/{scope}/{providerId}.keys.json
 *
 * The file shape is a `Record<string, unknown>` whose top-level keys are
 * credential entry names (plus a reserved `v` version marker that the
 * pipeline skips). The shape of an entry is consumer-defined — OAuth uses
 * `{ value, ... }`, SSH uses `{ host, port, username, ... }`, etc.
 *
 * Secrets-at-rest is a **resolver-level** concern, not a store concern.
 * Following v1's shape: the file envelope is plaintext JSON; secret string
 * fields inside an entry (e.g. `.value`, `.refresh.value`) carry their own
 * `enc:aes-256-gcm:...` ciphertext applied by whatever layer writes them.
 * The store moves bytes; it does not decide what is secret.
 *
 * This keeps the manifest pipeline free of decrypt cost (it reads
 * metadata directly) and lets the future resolver cache encrypted-value
 * Credential objects, decrypting only at the resolver↔consumer edge.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { updateJsonFile } from '../../atomic-json.js';

import { onKeysFileDeleted, onKeysFileWritten } from './manifest.js';
import { invalidateScope } from './scope-invalidator.js';
import type { CredentialScope } from './types.js';
import { asCredentialScope } from './types.js';

/** Reserved top-level key in every keys file — version marker, not an entry. */
export const ENTRY_VERSION_KEY = 'v';

/** Current schema version written into every keys file. */
const SCHEMA_VERSION = 1;

// ── Paths ───────────────────────────────────────────────────────────────────

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return path.join(process.env.HOME || os.homedir(), '.config');
}

/** Root for all credential state. Resolved lazily — no I/O at import. */
export function credentialsDir(): string {
  return path.join(configHome(), 'nanoclaw', 'credentials');
}

/** Per-scope subdirectory. Pure path computation; does not create. */
export function scopeDir(scope: CredentialScope): string {
  return path.join(credentialsDir(), scope);
}

/**
 * Per-(scope, providerId) keys file path. Pure path computation.
 *
 * Name is `<providerId>.keys.json` — the same scheme v1 used
 * (`credentials/{scope}/{providerId}.keys.json`) and the counterpart to the
 * refs file `<providerId>.refs.json` (mitm-proxy/token-substitute). A v1 store
 * migrated in as-is is read directly; no rename needed.
 */
export function keysFilePath(scope: CredentialScope, providerId: string): string {
  return path.join(scopeDir(scope), `${providerId}.keys.json`);
}

// ── Read / write ────────────────────────────────────────────────────────────

/**
 * Read the keys file for (scope, providerId) as plaintext JSON.
 * Returns `{}` if the file does not exist. Does not create directories.
 *
 * Throws if the file exists but is not valid JSON — that indicates either
 * a corrupt store or an external writer, neither of which the caller can
 * safely paper over.
 */
export function readKeysFile(scope: CredentialScope, providerId: string): Record<string, unknown> {
  const file = keysFilePath(scope, providerId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Atomic read-modify-write on the keys file for (scope, providerId).
 * The mutator receives a `Record<credentialId, entry>` with the `v`
 * version marker stripped, mutates in place, then the helper restores
 * the version marker and writes the result back through `updateJsonFile`
 * (fd held open between read and write — no race window between two
 * concurrent writers in the same Node process).
 *
 * Fires the manifest pipeline hook and the scope invalidator on success.
 *
 * This is the preferred mutation path for credential entries. Use
 * `writeKeysFile` only when the entire file's contents are computed
 * from outside (e.g. test fixtures, regeneration flows).
 */
export function updateKeysFile(
  scope: CredentialScope,
  providerId: string,
  mutator: (entries: Record<string, unknown>) => void,
): void {
  const file = keysFilePath(scope, providerId);
  updateJsonFile<Record<string, unknown>>(file, (data) => {
    delete data[ENTRY_VERSION_KEY];
    mutator(data);
    data[ENTRY_VERSION_KEY] = SCHEMA_VERSION;
  });
  onKeysFileWritten(scope, providerId);
  invalidateScope(scope);
}

/**
 * Atomically write the keys file for (scope, providerId) as plaintext JSON,
 * then fire the manifest pipeline. Sets the schema version marker; creates
 * the scope directory recursively. File mode 0600.
 *
 * Auto-firing the pipeline keeps the on-disk manifest and grantee copies
 * consistent with the keys file by construction — callers cannot forget
 * to advertise a write. A future opt-out option can land here if a real
 * bulk-write path needs to defer manifest generation.
 *
 * Secret string fields inside entries (e.g. `.value`, `.refresh.value`)
 * must already carry their `enc:...` ciphertext when handed to this
 * function. The store does not encrypt.
 */
export function writeKeysFile(scope: CredentialScope, providerId: string, entries: Record<string, unknown>): void {
  const dir = scopeDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  const payload: Record<string, unknown> = { ...entries, [ENTRY_VERSION_KEY]: SCHEMA_VERSION };
  const serialized = JSON.stringify(payload);
  const file = keysFilePath(scope, providerId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, serialized, { mode: 0o600 });
  fs.renameSync(tmp, file);
  onKeysFileWritten(scope, providerId);
  invalidateScope(scope);
}

/**
 * Delete the keys file for (scope, providerId), then fire the manifest
 * pipeline's delete hook. Best-effort — no throw on ENOENT. The manifest
 * hook also fires when the file was already absent so a stale manifest
 * left behind by an aborted earlier delete still gets cleaned up.
 */
export function deleteKeysFile(scope: CredentialScope, providerId: string): void {
  try {
    fs.unlinkSync(keysFilePath(scope, providerId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  onKeysFileDeleted(scope, providerId);
  invalidateScope(scope);
}

/**
 * Delete the entire scope directory in one recursive rmSync, then fire
 * the manifest pipeline's whole-scope delete hook **once** (with
 * `providerId=undefined`). Matches v1 shape:
 *   - one rmSync of `credentials/{scope}/`
 *   - one onKeysFileDeleted(scope) — manifest pipeline removes manifests/
 *     and every grantee's granted/{scope}/ in a single pass
 *   - one invalidateScope(scope) — resolver caches evict once, not N times
 *
 * Best-effort — ENOENT and "scope dir absent" are no-ops; the hook still
 * fires so stale manifests/grantee copies left by an aborted earlier
 * delete get cleaned up.
 */
export function deleteScope(scope: CredentialScope): void {
  try {
    fs.rmSync(scopeDir(scope), { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  onKeysFileDeleted(scope);
  invalidateScope(scope);
}

// ── Listings ────────────────────────────────────────────────────────────────

/**
 * Top-level entry names in the keys file (skipping the `v` version marker).
 * Returns `[]` if the file does not exist.
 */
export function listEntries(scope: CredentialScope, providerId: string): string[] {
  const keys = readKeysFile(scope, providerId);
  return Object.keys(keys).filter((k) => k !== ENTRY_VERSION_KEY);
}

/** Provider ids with a keys file under `scope`. `[]` if scope has no directory. */
export function listProviderIds(scope: CredentialScope): string[] {
  const dir = scopeDir(scope);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    // Keys files only: `<providerId>.keys.json`. Skip the refs sidecar
    // (`<providerId>.refs.json`) and anything else in the scope dir.
    const m = /^(.+)\.keys\.json$/.exec(e.name);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Scopes with at least one entry on disk. `[]` if credentialsDir does not exist. */
export function listScopes(): CredentialScope[] {
  const root = credentialsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => asCredentialScope(e.name));
}
