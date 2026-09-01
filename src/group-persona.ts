/**
 * Provider-neutral per-group persona ("instructions prepend").
 *
 * Each provider's project-doc composer inlines this content at the TOP of the
 * doc it generates every spawn — `CLAUDE.md` via `project-doc-compose.ts`,
 * `AGENTS.md` via `providers/codex-agents-md.ts` — so a persona lands at
 * system-prompt tier rather than in a recall-tier memory file.
 *
 * Single owner of the filename and read semantics, so no composer hardcodes the
 * path independently. Absent file ⇒ null ⇒ no-op.
 */
import fs from 'fs';
import path from 'path';

/** Per-group host file holding the persona prepend. Never regenerated — persistent. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Read a group's persona prepend from its host dir, or null if absent/empty.
 * `groupDir` is the per-group host directory (`GROUPS_DIR/<folder>`).
 */
export function readGroupPersona(groupDir: string): string | null {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf-8').trim();
  return content.length > 0 ? content : null;
}
