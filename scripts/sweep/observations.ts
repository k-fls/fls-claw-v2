/**
 * scripts/sweep/observations.ts — the driver's append-only observation channel.
 *
 * An observation is a fact worth surfacing to a human that BINDS NOTHING: no
 * driver command reads this file, and the sweep agent cannot — host ops create
 * it root-owned, write-only, append-only (mode 0222 + chattr +a) at the group
 * root. The driver APPENDS one JSON line per observation and never creates,
 * reads, truncates, or deletes the file: when it does not exist, observations
 * are dropped silently, so the file can only ever exist in its host-enforced
 * append-only form. Reading it is a host-side human action.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Lives at the workspace (group) root, beside rr-cache/ and propagation/. */
export const OBSERVATIONS_FILENAME = 'observations.jsonl';

/** Append one observation line; a missing file or any fs error drops it silently. */
export function appendObservation(workspace: string, entry: Record<string, unknown>): void {
  const file = join(workspace, OBSERVATIONS_FILENAME);
  try {
    if (!existsSync(file)) return;
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* observations bind nothing — never fail a pass over one */
  }
}
