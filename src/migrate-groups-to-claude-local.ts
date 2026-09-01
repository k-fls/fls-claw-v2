/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Runs on every host startup and is idempotent.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';
import { COMPOSED_DOC_PREFIX } from './project-doc-compose.js';

/**
 * True when the file is a spawn-composed project document rather than
 * pre-cutover per-group content. Promoting one to `CLAUDE.local.md` would copy
 * the entire runtime contract into the group's memory, permanently.
 */
function isComposedDoc(filePath: string): boolean {
  let head: string;
  try {
    head = fs.readFileSync(filePath, 'utf-8').slice(0, COMPOSED_DOC_PREFIX.length);
    // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable means "do not touch it"
  } catch {
    return true;
  }
  return head === COMPOSED_DOC_PREFIX;
}

/**
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal) && !isComposedDoc(claudeMd)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}
