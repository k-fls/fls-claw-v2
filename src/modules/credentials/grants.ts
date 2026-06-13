/**
 * Persistent grant/borrow state — filesystem only, no DB tables (C7s).
 *
 * Layout:
 *
 *   groups/{grantorFolder}/credentials/grantees.json
 *     — JSON array of grantee folder strings. Plaintext: folder names
 *       are not secrets, and the file is co-located with the agent
 *       group's workspace.
 *
 *   groups/{granteeFolder}/credentials/borrowed
 *     — relative symlink → `granted/{grantorFolder}`. The symlink IS
 *       the borrow-source record; no separate file. Reading the link
 *       and parsing the prefix is how `getBorrowSource` works.
 *
 *   groups/{granteeFolder}/credentials/granted/{grantorFolder}/...
 *     — distributed copies of the grantor's manifests, written by the
 *       manifest pipeline. Created by `setBorrowSource` so the
 *       symlink target always exists even before the first manifest.
 *
 * Every folder string passed in is validated via `assertValidGroupFolder`
 * from `src/group-folder.ts` before any path is composed.
 */
import fs from 'fs';
import path from 'path';

import { updateJsonFile } from '../../atomic-json.js';
import { assertValidGroupFolder, resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';

/** Shape of `grantees.json`. Wrapped in an object so `updateJsonFile` (which
 *  requires a top-level object) can perform an atomic read-modify-write. */
interface GranteesFile {
  grantees?: string[];
}

// ── Paths ───────────────────────────────────────────────────────────────────

function credentialsBase(folder: string): string {
  return path.join(resolveGroupFolderPath(folder), 'credentials');
}

function granteesFile(grantorFolder: string): string {
  return path.join(credentialsBase(grantorFolder), 'grantees.json');
}

function borrowedLink(granteeFolder: string): string {
  return path.join(credentialsBase(granteeFolder), 'borrowed');
}

/** Path to the per-grantor distribution dir under a grantee's workspace. */
export function grantedDir(granteeFolder: string, grantorFolder: string): string {
  assertValidGroupFolder(granteeFolder);
  assertValidGroupFolder(grantorFolder);
  return path.join(credentialsBase(granteeFolder), 'granted', grantorFolder);
}

// ── Grantee set (grantor-side) ──────────────────────────────────────────────

/**
 * Single read-modify-write entry point for `grantees.json`. The mutator
 * receives the current grantee list and returns the next one; the
 * surrounding code dedups + sorts the result and atomically writes it
 * through `updateJsonFile` (fd held open across read+write).
 *
 * `addGrantee` and `removeGrantee` are thin wrappers — both share this
 * implementation so concurrent edits cannot race each other under one
 * Node process.
 */
function mutateGrantees(grantorFolder: string, mutator: (current: string[]) => string[]): void {
  const file = granteesFile(grantorFolder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  updateJsonFile<GranteesFile>(file, (data) => {
    const current = Array.isArray(data.grantees) ? data.grantees.filter((s): s is string => typeof s === 'string') : [];
    const next = Array.from(new Set(mutator(current))).sort();
    data.grantees = next;
  });
}

function readGrantees(grantorFolder: string): string[] {
  const file = granteesFile(grantorFolder);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const list = (parsed as GranteesFile).grantees;
    if (!Array.isArray(list)) return [];
    return list.filter((s): s is string => typeof s === 'string');
  } catch {
    log.warn('grants: grantees.json malformed — treating as empty', { grantorFolder });
    return [];
  }
}

export function listGrantees(grantorFolder: string): string[] {
  assertValidGroupFolder(grantorFolder);
  return readGrantees(grantorFolder);
}

export function isGrantee(grantorFolder: string, granteeFolder: string): boolean {
  assertValidGroupFolder(grantorFolder);
  assertValidGroupFolder(granteeFolder);
  return readGrantees(grantorFolder).includes(granteeFolder);
}

export function addGrantee(grantorFolder: string, granteeFolder: string): void {
  assertValidGroupFolder(grantorFolder);
  assertValidGroupFolder(granteeFolder);
  mutateGrantees(grantorFolder, (cur) => (cur.includes(granteeFolder) ? cur : [...cur, granteeFolder]));
}

export function removeGrantee(grantorFolder: string, granteeFolder: string): void {
  assertValidGroupFolder(grantorFolder);
  assertValidGroupFolder(granteeFolder);
  mutateGrantees(grantorFolder, (cur) => cur.filter((g) => g !== granteeFolder));
}

// ── Borrow source (grantee-side) ────────────────────────────────────────────

const BORROW_TARGET_PATTERN = /^granted\/([^/]+)\/?$/;

/**
 * Read the borrow source for `granteeFolder`. Returns the grantor's folder
 * string, or `null` when:
 *   - the `borrowed` link is absent
 *   - the path exists but is not a symlink
 *   - the symlink target doesn't match `granted/{folder}` shape
 */
export function getBorrowSource(granteeFolder: string): string | null {
  assertValidGroupFolder(granteeFolder);
  let target: string;
  try {
    target = fs.readlinkSync(borrowedLink(granteeFolder));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EINVAL') return null;
    throw err;
  }
  const m = BORROW_TARGET_PATTERN.exec(target);
  if (!m) return null;
  return m[1];
}

/**
 * Set the borrow source for `granteeFolder` → `grantorFolder`. Creates the
 * `granted/{grantorFolder}/` directory so the symlink never dangles, then
 * atomically replaces any existing link.
 */
export function setBorrowSource(granteeFolder: string, grantorFolder: string): void {
  assertValidGroupFolder(granteeFolder);
  assertValidGroupFolder(grantorFolder);
  const credsDir = credentialsBase(granteeFolder);
  fs.mkdirSync(credsDir, { recursive: true });
  // Pre-create the symlink target so the borrow is never dangling even if
  // no manifests have been distributed yet.
  fs.mkdirSync(grantedDir(granteeFolder, grantorFolder), { recursive: true });
  const link = borrowedLink(granteeFolder);
  try {
    fs.unlinkSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.symlinkSync(`granted/${grantorFolder}`, link);
}

/** Clear the borrow source. No-op when there is no `borrowed` link. */
export function clearBorrowSource(granteeFolder: string): void {
  assertValidGroupFolder(granteeFolder);
  try {
    fs.unlinkSync(borrowedLink(granteeFolder));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ── Access check ────────────────────────────────────────────────────────────

/**
 * Bilateral grant check: does `borrowerFolder` have permission to read
 * credentials stored under `grantorFolder`?
 *
 * Returns true iff:
 *   - own scope (borrower === grantor), OR
 *   - the borrower has set `grantor` as its borrow source AND the grantor
 *     has listed the borrower in its grantees set.
 *
 * Either side missing flips the answer to false — neither a unilateral
 * grantor declaration nor a unilateral borrow claim is enough. v1's
 * equivalent lives in `provision.ts:createAccessCheck`; centralizing it
 * here lets ssh-auth, the resolver, and oauth all consume the same rule
 * instead of re-implementing it.
 */
export function canAccess(borrowerFolder: string, grantorFolder: string): boolean {
  if (borrowerFolder === grantorFolder) return true;
  if (getBorrowSource(borrowerFolder) !== grantorFolder) return false;
  if (!isGrantee(grantorFolder, borrowerFolder)) {
    log.warn('canAccess denied: borrower claims grantor but grantor does not list borrower', {
      borrower: borrowerFolder,
      grantor: grantorFolder,
    });
    return false;
  }
  return true;
}
