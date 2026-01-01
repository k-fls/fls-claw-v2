import path from 'path';

import { GROUPS_DIR } from './config.js';

/**
 * Aligned with the runtime label grammar (`labelValueLegal` in
 * `drivers/types.ts`): at most 63 bytes, alphanumeric at BOTH ends. The folder
 * rides sessions verbatim as the admission join label (D9), so a folder this
 * pattern admits but the label grammar refuses would create groups that can
 * never spawn. Narrower than the label grammar on charset (no dots) — folders
 * are also directory names.
 */
const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(
      `Invalid group folder "${folder}" — at most 63 characters of [A-Za-z0-9_-], ` +
        `alphanumeric at both ends (the folder is carried verbatim as a runtime label)`,
    );
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}
