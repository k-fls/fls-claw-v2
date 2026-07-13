/**
 * scripts/sweep/validate.ts — the 6-rule registry validator
 * (feature-inventory design §5). Runs at the start of every sweep, before
 * routing. WARNs don't stop the sweep; an ALERT on an entry makes routing
 * fail closed (its PoIs go to catch-all).
 *
 *  1. owning branch exists                              -> ALERT
 *  2. every owned_paths glob matches >=1 file on branch -> ALERT
 *  3. test_anchors + design_docs exist                  -> ALERT
 *  4. key_symbols found via git grep -F                 -> WARN
 *  5. sweepable branch without a registry entry         -> ALERT
 *  6. verified_against != branch tip / stale last_verified -> WARN
 */
import { EXCLUDED_BRANCH_GLOBS, REGISTRY_REQUIRED_GLOBS } from './config.js';
import { git, listTreePaths, localBranches, refExists, revParse } from './git.js';
import { globMatchAny } from './globs.js';
import { editionAncestorBranches } from './scope.js';
import type { FeatureEntry, ValidationIssue, ValidationResult } from './types.js';

export interface ValidateOptions {
  /** Rule 6: WARN when last_verified is older than this many days and the tip moved. */
  staleDays?: number;
  now?: Date;
}

export async function validateRegistry(
  repo: string,
  features: FeatureEntry[],
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const push = (level: 'ALERT' | 'WARN', featureId: string | null, rule: number, message: string) =>
    issues.push({ level, featureId, rule, message });

  for (const e of features) {
    if (e.status === 'planned' || e.status === 'retired') continue;
    const branch = e.branch!;

    // Rule 1: owning branch exists.
    if (!(await refExists(repo, branch))) {
      push('ALERT', e.id, 1, `branch '${branch}' does not exist`);
      continue; // remaining rules need the branch
    }
    const files = await listTreePaths(repo, branch);

    // Rule 2: every owned_paths glob matches at least one file on the branch.
    for (const glob of e.owned_paths ?? []) {
      if (!files.some((f) => globMatchAny([glob], f))) {
        push('ALERT', e.id, 2, `owned_paths glob '${glob}' matches nothing on ${branch}`);
      }
    }

    // Rule 3: test_anchors + design_docs exist.
    for (const anchor of e.test_anchors ?? []) {
      if (!files.includes(anchor)) push('ALERT', e.id, 3, `test_anchor '${anchor}' missing on ${branch}`);
    }
    for (const doc of e.design_docs ?? []) {
      const [path, docBranch] = doc.includes('@') ? doc.split('@') : [doc, branch];
      const docFiles = docBranch === branch ? files : await listTreePaths(repo, docBranch);
      if (!docFiles.includes(path)) push('ALERT', e.id, 3, `design_doc '${doc}' missing`);
    }

    // Rule 4: key_symbols spot-check. Registry convention: "Sym — path" or
    // "SymA / SymB / SymC — path" (any one symbol present passes).
    for (const sym of e.key_symbols ?? []) {
      const names = sym
        .split(' — ')[0]
        .split(' -- ')[0]
        .split(' / ')
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) continue;
      let found = false;
      for (const name of names) {
        const res = await git(repo, ['grep', '-F', '--quiet', name, branch], { allowCodes: [1] });
        if (res.code === 0) {
          found = true;
          break;
        }
      }
      if (!found) push('WARN', e.id, 4, `key_symbol '${names.join(' / ')}' not found on ${branch}`);
    }

    // Rule 6: verification freshness.
    const tip = await revParse(repo, branch);
    const verifiedAgainst = e.maintenance?.verified_against;
    if (verifiedAgainst && verifiedAgainst !== tip) {
      push(
        'WARN',
        e.id,
        6,
        `verified_against ${verifiedAgainst.slice(0, 12)} != ${branch} tip ${tip.slice(0, 12)}; re-verify globs`,
      );
    }
    const lastVerified = e.maintenance?.last_verified;
    if (lastVerified) {
      const ageDays = ((opts.now ?? new Date()).getTime() - new Date(lastVerified).getTime()) / 86_400_000;
      if (ageDays > (opts.staleDays ?? 21)) {
        push('WARN', e.id, 6, `last_verified ${lastVerified} is ${Math.floor(ageDays)} days old`);
      }
    }
  }

  // Rule 5: reverse check — sweepable branches without a registry entry.
  const owned = new Set(features.filter((e) => e.branch).map((e) => e.branch!));
  const repoBranches = await localBranches(repo);
  for (const b of repoBranches) {
    if (!globMatchAny(REGISTRY_REQUIRED_GLOBS, b)) continue;
    if (globMatchAny(EXCLUDED_BRANCH_GLOBS, b)) continue;
    if (!owned.has(b)) push('ALERT', null, 5, `branch '${b}' has no registry entry`);
  }
  // Rule 5 extension (2026-07-14 scope rule): non-inventory branches that are
  // part of an edition composition are swept (merge source: main only) but
  // must be flagged until they get an inventory entry.
  for (const b of await editionAncestorBranches(repo, repoBranches)) {
    if (!owned.has(b)) {
      push('WARN', null, 5, `branch '${b}' is in an edition composition but has no inventory entry — add one`);
    }
  }

  const alertedFeatureIds = [
    ...new Set(issues.filter((i) => i.level === 'ALERT' && i.featureId).map((i) => i.featureId!)),
  ];
  return { issues, alertedFeatureIds, ok: !issues.some((i) => i.level === 'ALERT') };
}
