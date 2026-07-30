/**
 * scripts/sweep/cut-points.ts — OWNER-APPROVED CUT-POINT EXCEPTIONS.
 *
 * Two measured problems the driver CANNOT solve from topology, because in both
 * cases the git graph is telling the literal truth and the literal truth is the
 * wrong answer.
 *
 * DUPLICATE — a rebase/cherry-pick COPY of another branch's commit.
 * -----------------------------------------------------------------
 * `3b8c5896` and `dc3cb7f6` are the same patch twice: identical patch-id
 * `25c7b6481c3a`, identical subject ("feat(host-rpc): host HTTP RPC endpoint
 * substrate with IP-based caller validation"), different commits. `dc3cb7f6` is
 * on `module/host-rpc`; `3b8c5896` is on `module/credentials` AND on
 * `module/runtime-updater` (which was cut from credentials). So excluding
 * `module/host-rpc` from a traversal does NOT remove `3b8c5896` — it is on
 * credentials' OWN first-parent line, and every count that reads that line
 * credits credentials with host-rpc's work. Measured on the live fork
 * (2026-07-29): 23 of 458 non-merge commits (5%) are duplicates of this shape.
 * No topological rule can see this: patch identity is not an edge.
 *
 * ABSORBED — the parent has already merged the branch down, remainder empty.
 * -------------------------------------------------------------------------
 * `module/crypto` is an ANCESTOR of `main_patched` (tip e4c82f34): its
 * `rev-list --count module/crypto ^main_patched` is 0. Measured on the live
 * server clone 2026-07-29: 5 of the 25 branches — `module/crypto`,
 * `module/command-gate`, `module/container-queue`, `module/interaction-status`,
 * `module/agent-group-contributions` — have an empty remainder.
 *
 * SHAPE (owner-approved): branch -> kind -> LIST. A branch may carry several
 * exceptions, of several kinds, and a NEW kind is a new key rather than a new
 * file layout. An unknown kind is reported and ignored, never fatal — an older
 * driver must not choke on a file a newer one wrote.
 *
 *     cut_point_exceptions:
 *       module/credentials:
 *         duplicate:
 *           - sha: 3b8c5896
 *             patch_id: 25c7b6481c3a
 *             twin: dc3cb7f6
 *             authored_on: module/host-rpc
 *             why: rebase copy; excluding module/host-rpc does not remove it
 *       module/crypto:
 *         absorbed:
 *           - into: main_patched
 *             as_of: e4c82f34
 *             why: parent merged this branch down; remainder is empty
 *
 * NEVER TRUSTED FOREVER. Every entry is a claim ABOUT GIT, and git moves. Each
 * one is RE-VERIFIED against the repo before it is applied — duplicates by
 * recomputing both patch-ids, absorbed by re-asking whether `as_of` still
 * contains the branch. A falsified entry is dropped with a STALE warning: a
 * stale exception must never silently suppress a real answer, which is the
 * whole hazard of hand-written exception lists.
 *
 * ABSENT vs MALFORMED, the ERR43_CHECKS_MALFORMED precedent (propagate.ts): an
 * ABSENT file is a deliberate skip and is silent — a repo with no exceptions
 * behaves exactly as before. A MALFORMED one is LOUD (ERR45), because a YAML
 * typo that silently disabled the file would put the driver straight back on
 * the wrong answers these entries exist to correct, with nothing said.
 *
 * NOT-APPLICABLE is a THIRD case, and it is quiet on purpose: an entry whose
 * `sha`/`twin`/`as_of` does not resolve in THIS repo (a fixture, a partial
 * clone) suppresses nothing, so it cannot cause a wrong answer. Only a claim
 * the repo actively CONTRADICTS is marked `stale` and reported loudly.
 */
import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { DEFAULT_CUT_POINT_EXCEPTIONS_FILE } from './config.js';
import { git } from './git.js';
import type { Issue } from './publish.js';

/** A rebase/cherry-pick copy carried by a branch that did not author it. */
export interface DuplicateException {
  /** The copy, on THIS branch's first-parent line. */
  sha: string;
  /** `git patch-id --stable` of the copy, abbreviated — re-verified, never trusted. */
  patch_id: string;
  /** The original, on `authored_on`. */
  twin: string;
  /** The branch that actually authored the patch. */
  authored_on: string;
  why: string;
}

/** A branch its parent has already merged down: the remainder is empty. */
export interface AbsorbedException {
  /** The branch that absorbed it (the parent). */
  into: string;
  /** The `into` commit at which the absorption was observed. */
  as_of: string;
  why: string;
}

/** The parsed file: kind -> branch -> entries. Empty maps = a file with no entries. */
export interface CutPointExceptions {
  duplicate: Map<string, DuplicateException[]>;
  absorbed: Map<string, AbsorbedException[]>;
  /** Kinds this build does not implement, `branch/kind` — reported, never applied. */
  unknownKinds: string[];
  /** Entries parsed across every known kind. */
  count: number;
}

/**
 * One entry that could not be applied. `stale: true` = the repo CONTRADICTS the
 * claim (patch-ids diverged, `as_of` no longer contains the branch) and the
 * operator must be told. `stale: false` = the entry simply does not apply to
 * this repo (the refs are absent), which suppresses nothing and stays quiet.
 */
export interface CutPointWarning {
  branch: string;
  kind: string;
  detail: string;
  stale: boolean;
}

/** Re-verified exceptions, ready to apply. Anything not here was dropped. */
export interface VerifiedCutPoints {
  /** branch -> FULL shas that must NOT count as that branch's own work. */
  duplicates: Map<string, Set<string>>;
  /**
   * branch -> absorbed records that still hold.
   *
   * NO DRIVER CONSUMER, DELIBERATELY. The cut-point derivation that would use
   * this — deciding a branch needs no cut because its parent already carries it
   * — is ANALYSIS, not driver code: nothing in propagate.ts/steps.ts asks the
   * question today. Schema, re-verification and reporting are implemented so an
   * entry is written, validated and surfaced; inventing a consumer for it would
   * mean inventing a decision the driver does not make.
   */
  absorbed: Map<string, AbsorbedException[]>;
  /** One line per applied entry, for the journal. */
  applied: string[];
  warnings: CutPointWarning[];
}

/** Required fields per kind. A missing one is MALFORMED, not a default. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  duplicate: ['sha', 'patch_id', 'twin', 'authored_on', 'why'],
  absorbed: ['into', 'as_of', 'why'],
};

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate the file's text. PURE — no git, no fs; the git-facing half is
 * `verifyCutPointExceptions`. Every structural violation is an ERROR rather than
 * a dropped entry: an exception that vanishes because its key was misspelled is
 * indistinguishable from one that was never written, and the whole point of the
 * file is that it does not fail silently.
 */
export function parseCutPointExceptions(
  raw: string,
  source: string,
): { exceptions?: CutPointExceptions; error?: string } {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    return { error: `${source}: YAML parse error: ${(err as Error).message}` };
  }
  // An empty document is an empty file, not a broken one (a commented-out file
  // parses to null) — it is the ABSENT case spelled in place.
  if (doc === null || doc === undefined) return { exceptions: emptyExceptions() };
  if (!isMapping(doc)) return { error: `${source}: not a mapping` };
  const root = doc.cut_point_exceptions;
  if (root === undefined || root === null) return { exceptions: emptyExceptions() };
  if (!isMapping(root)) return { error: `${source}: 'cut_point_exceptions' is not a mapping of branch -> kind -> list` };

  const out = emptyExceptions();
  for (const [branch, kinds] of Object.entries(root)) {
    if (!isMapping(kinds)) return { error: `${source}: '${branch}' is not a mapping of kind -> list` };
    for (const [kind, entries] of Object.entries(kinds)) {
      if (!Array.isArray(entries)) return { error: `${source}: '${branch}.${kind}' is not a list` };
      const required = REQUIRED_FIELDS[kind];
      if (!required) {
        // Forward compatibility: a kind added by a newer driver is REPORTED and
        // skipped. It is not malformed — it is a file this build cannot fully
        // read, and refusing it would make the config un-extendable.
        out.unknownKinds.push(`${branch}.${kind}`);
        continue;
      }
      for (const [i, entry] of entries.entries()) {
        const where = `${source}: '${branch}.${kind}[${i}]'`;
        if (!isMapping(entry)) return { error: `${where} is not a mapping` };
        for (const field of required) {
          const v = entry[field];
          if (typeof v !== 'string' || v.trim() === '') {
            return { error: `${where} is missing required string field '${field}'` };
          }
        }
        if (kind === 'duplicate') push(out.duplicate, branch, entry as unknown as DuplicateException);
        else push(out.absorbed, branch, entry as unknown as AbsorbedException);
        out.count++;
      }
    }
  }
  return { exceptions: out };
}

function emptyExceptions(): CutPointExceptions {
  return { duplicate: new Map(), absorbed: new Map(), unknownKinds: [], count: 0 };
}

function push<T>(m: Map<string, T[]>, key: string, value: T): void {
  const list = m.get(key) ?? [];
  list.push(value);
  m.set(key, list);
}

/**
 * Load the exceptions file: null when ABSENT — or malformed, which is why every
 * caller asks `malformedCutPointExceptionsIssue` FIRST. Exactly the
 * `loadChecksConfig` contract (propagate.ts), for exactly the reason recorded
 * there: null alone cannot tell "no file" from "broken file".
 */
export function loadCutPointExceptions(
  file: string = DEFAULT_CUT_POINT_EXCEPTIONS_FILE,
): CutPointExceptions | null {
  if (!file || !existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseCutPointExceptions(raw, file).exceptions ?? null;
}

/**
 * A MALFORMED exceptions file, told apart from an ABSENT one — the
 * ERR43_CHECKS_MALFORMED shape (propagate.ts), same reasoning: a single typo
 * must not disable the file in silence. Blame would then go straight back to
 * crediting `module/credentials` with `module/host-rpc`'s commit and say
 * nothing about it.
 */
export function malformedCutPointExceptionsIssue(
  file: string = DEFAULT_CUT_POINT_EXCEPTIONS_FILE,
): Issue | null {
  if (!file || !existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      id: 'ERR45_CUT_POINTS_MALFORMED',
      detail: `the cut-point exceptions file ${file} could not be read (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const { error } = parseCutPointExceptions(raw, file);
  if (!error) return null;
  return {
    id: 'ERR45_CUT_POINTS_MALFORMED',
    detail:
      `${error} — the owner-approved cut-point exceptions would ALL be skipped SILENTLY, ` +
      `putting blame back on the answers they exist to correct; fix the file and re-run`,
  };
}

/** Full sha of `ref`, or null when this repo simply does not have it. */
async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  const res = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowCodes: [1, 128] });
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

/**
 * `git patch-id --stable` of one commit — the CONTENT identity that makes two
 * rebase copies the same patch. `--stable` so the answer does not depend on the
 * order git happened to emit the file diffs in. Null for a merge commit (no
 * diff to hash) or a ref this repo cannot show, which is the not-applicable
 * case, not a contradiction.
 */
async function patchId(repo: string, ref: string): Promise<string | null> {
  const show = await git(repo, ['show', '--patch', '--no-color', ref], { allowCodes: [1, 128] });
  if (show.code !== 0 || show.stdout.trim() === '') return null;
  const res = await git(repo, ['patch-id', '--stable'], { input: show.stdout, allowCodes: [1] });
  const id = res.stdout.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40,}$/.test(id) ? id : null;
}

/**
 * RE-VERIFY every entry against the repo and return only what still holds.
 *
 * duplicate: recompute `git patch-id --stable` for BOTH `sha` and `twin`. They
 * must equal each other (that is what "duplicate" MEANS) and must still match
 * the recorded `patch_id` prefix (that is what pins the entry to the pair it was
 * written for). Either check failing = STALE: warn, do not apply. Applying a
 * stale duplicate would erase a commit from a branch's authored count that the
 * branch really did write — suppressing a real answer, which is worse than the
 * misattribution the exception was for.
 *
 * absorbed: the branch must have NO OWN WORK outside `into` —
 * `rev-list --count --no-merges <branch> ^<into>` is 0.
 *
 * D-062: this used to test `merge-base --is-ancestor <branch-tip> <as_of>`, which
 * a propagation pass falsifies by doing its job. Every pass merges the parent
 * DOWN into the branch, so the tip advances past `as_of` on the first merge and
 * the entry reads stale from then on. Live 2026-07-29: module/crypto was flagged
 * STALE at verify while its remainder under --no-merges was still 0 — the only
 * commit outside main_patched was the pass's own "Merge main_patched into
 * module/crypto (propagation)". Re-anchoring `as_of` cannot fix that; the next
 * pass falsifies the new value too. Absorption is about the branch's OWN
 * commits, so the count must ignore merges, and `as_of` becomes provenance (when
 * the owner measured it) rather than the thing tested.
 */
export async function verifyCutPointExceptions(
  repo: string,
  ex: CutPointExceptions | null,
): Promise<VerifiedCutPoints> {
  const v: VerifiedCutPoints = { duplicates: new Map(), absorbed: new Map(), applied: [], warnings: [] };
  if (!ex) return v;
  for (const kind of ex.unknownKinds) {
    const [branch, name] = kind.split('.');
    v.warnings.push({
      branch,
      kind: name,
      detail: `unknown exception kind '${name}' on ${branch} — this build does not implement it; ignored`,
      stale: false,
    });
  }

  for (const [branch, entries] of ex.duplicate) {
    for (const e of entries) {
      const sha = await resolveCommit(repo, e.sha);
      const twin = await resolveCommit(repo, e.twin);
      if (!sha || !twin) {
        v.warnings.push({
          branch,
          kind: 'duplicate',
          detail: `${!sha ? e.sha : e.twin} is not in this repo — duplicate exception not applicable here`,
          stale: false,
        });
        continue;
      }
      const [pidSha, pidTwin] = [await patchId(repo, sha), await patchId(repo, twin)];
      if (!pidSha || !pidTwin || pidSha !== pidTwin) {
        v.warnings.push({
          branch,
          kind: 'duplicate',
          detail:
            `STALE: ${e.sha} and ${e.twin} are no longer the same patch ` +
            `(${pidSha ?? 'no patch-id'} vs ${pidTwin ?? 'no patch-id'}) — exception NOT applied, ` +
            `${e.sha} counts as ${branch}'s own work again`,
          stale: true,
        });
        continue;
      }
      if (!pidSha.startsWith(e.patch_id)) {
        v.warnings.push({
          branch,
          kind: 'duplicate',
          detail:
            `STALE: recorded patch_id ${e.patch_id} does not match the recomputed ${pidSha} for ` +
            `${e.sha}/${e.twin} — the entry was written for a different pair; exception NOT applied`,
          stale: true,
        });
        continue;
      }
      // Keyed by FULL sha: the file abbreviates, blame reads `rev-list` output,
      // and the two must compare equal without either side guessing a width.
      const set = v.duplicates.get(branch) ?? new Set<string>();
      set.add(sha);
      v.duplicates.set(branch, set);
      v.applied.push(
        `duplicate: ${e.sha} on ${branch} is a copy of ${e.twin} (${e.authored_on}), patch-id ${e.patch_id} — ${e.why}`,
      );
    }
  }

  for (const [branch, entries] of ex.absorbed) {
    for (const e of entries) {
      const into = await resolveCommit(repo, e.into);
      const tip = await resolveCommit(repo, branch);
      if (!into || !tip) {
        v.warnings.push({
          branch,
          kind: 'absorbed',
          detail: `${!into ? e.into : branch} is not in this repo — absorbed exception not applicable here`,
          stale: false,
        });
        continue;
      }
      // The branch's OWN commits outside the parent. `--no-merges` is what makes
      // this survive propagation: the merges a pass creates ON this branch carry
      // the parent's content down, they are not work the branch authored.
      const own = await git(repo, ['rev-list', '--count', '--no-merges', tip, `^${into}`]);
      const remainder = Number(own.stdout.trim());
      if (!Number.isFinite(remainder) || remainder > 0) {
        v.warnings.push({
          branch,
          kind: 'absorbed',
          detail:
            `STALE: ${branch} has ${own.stdout.trim()} own commit(s) not in ${e.into} — its remainder is not ` +
            `empty; exception NOT applied`,
          stale: true,
        });
        continue;
      }
      push(v.absorbed, branch, e);
      v.applied.push(`absorbed: ${branch} has no own commits outside ${e.into} (measured ${e.as_of}) — ${e.why}`);
    }
  }
  return v;
}

/** The stale entries only — the ones an operator has to go fix. */
export function staleWarnings(v: VerifiedCutPoints): CutPointWarning[] {
  return v.warnings.filter((w) => w.stale);
}

/**
 * Load + verify in one step, for callers that just want the applicable set.
 * Returns an EMPTY (not null) result for an absent file, so callers never branch
 * on "is there a file" — they branch on "is there an exception", which is the
 * question they actually have.
 */
export async function resolveCutPointExceptions(
  repo: string,
  file: string = DEFAULT_CUT_POINT_EXCEPTIONS_FILE,
): Promise<VerifiedCutPoints> {
  return verifyCutPointExceptions(repo, loadCutPointExceptions(file));
}
