/**
 * scripts/sweep/surface.ts — the SURFACE of a (branch, source) edge (DRIVER.md
 * §4.3): the paths where the branch's content is its OWN — where the branch
 * differs from the merge base it shares with the source — closed under the
 * source's renames.
 *
 * A conflict is a question for the owner only where BOTH sides have something
 * to say. At a path outside the surface the branch says nothing: the collision
 * is between two upstream states the source's author already integrated, so the
 * driver resolves it to the incoming side and asks nobody (the walk, interval.ts).
 *
 * RENAME DETECTION IS LOAD-BEARING, twice, because the merge machinery is
 * rename-aware while a naive surface would not be:
 *  - the branch-side diff runs with rename detection and marks BOTH names of a
 *    rename, so fork content that travelled under a branch-side rename is still
 *    the branch's own at either name;
 *  - the surface is CLOSED under source-side renames between the merge base and
 *    the source tip: when the source renames a path the branch edited, the
 *    conflict lands at the name the SOURCE now uses, and a surface that did not
 *    follow the rename reads that conflict as out-of-surface — which
 *    auto-resolves it to the incoming side and silently deletes fork content.
 */
import { diffNameStatusRenamed, mergeBase } from './git.js';

export interface Surface {
  /**
   * The branch's own paths, rename-closed — or null when the pair shares no
   * merge base. With no base there is no "what the branch changed" to measure,
   * so the surface FAILS TOWARD ASKING: every path is in it and no conflict
   * auto-resolves.
   */
  paths: Set<string> | null;
}

export function inSurface(surface: Surface, path: string): boolean {
  return surface.paths === null || surface.paths.has(path);
}

/**
 * Compute the surface of `(sourceAnchor, branchTip)`. `sourceAnchor` is the
 * commit whose content the walk will absorb (the parent tip; the watermark for
 * an entry line) — it fixes ONE merge base and ONE rename map for the whole
 * walk, so every step of the walk and every re-verification of it filters
 * through the same set. Anchoring per-step instead would let the walk's own
 * auto-resolutions leak paths INTO the surface.
 */
export async function computeSurface(repo: string, sourceAnchor: string, branchTip: string): Promise<Surface> {
  const base = await mergeBase(repo, sourceAnchor, branchTip);
  if (base === null) return { paths: null };
  const paths = new Set<string>();
  for (const c of await diffNameStatusRenamed(repo, base, branchTip)) {
    paths.add(c.path);
    if (c.oldPath) paths.add(c.oldPath);
  }
  // Source-side rename closure: one diff base -> sourceAnchor names every
  // rename the merge machinery will follow, so a single application closes the
  // set (rename chains longer than one step collapse inside that one diff).
  for (const c of await diffNameStatusRenamed(repo, base, sourceAnchor)) {
    if (!c.oldPath) continue;
    if (paths.has(c.oldPath)) paths.add(c.path);
    else if (paths.has(c.path)) paths.add(c.oldPath);
  }
  return { paths };
}
