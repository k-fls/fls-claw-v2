/**
 * scripts/sweep/steps.ts — step/case JSON artifacts and their FIRST-PRINCIPLES
 * re-verification (DRIVER.md §4.6).
 *
 * The driver is the only author of merge parameters, but the merge executor
 * NEVER trusts the file author: for every step it independently recomputes,
 * from git state + the pinned chain, that
 *   - the step is for THIS pass (watermark matches),
 *   - every parent is a legal inventory parent (or `main` for entry branches),
 *   - each merge row's landed PREFIX is legal (entry: trunk chain commits in
 *     ascending order; parents: pending, unabsorbed commits of that parent) and
 *     REPLAYS to exactly the claimed tree (interval.ts `replayPrefix` — same
 *     engine, first principles),
 *   - the head is the prefix's top and its sha matches its claimed height,
 *   - the height is within the chain (height <= watermark),
 *   - every required parent has arrived this pass (journal barrier),
 *   - skip claims are genuine no-ops (merge-tree result tree == branch tree),
 *   - the leaf / always_merge rule is honoured.
 * A forged or hand-edited step (wrong sha, illegal parent, out-of-range height,
 * bogus skip) fails verification, which is a HARD HALT (journaled). Passing
 * these checks is the ONLY thing that authorises a merge.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { deriveCoverage, heightOfSha, shaAtHeight, type Chain } from './heights.js';
import { git, isAncestor, newStyleMergeTree, revParse } from './git.js';
import { replayPrefix } from './interval.js';
import { computeSurface } from './surface.js';
import type { BranchPlan, CaseFile, StepFile, StepMerge } from './types.js';

export type { StepFile, CaseFile } from './types.js';

async function treeOf(repo: string, commit: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
}

/**
 * Sanitize a branch/parent name for use in a case id or path segment. Slashes
 * become `__`; every other character outside [A-Za-z0-9_-] becomes `_` (N5:
 * `resolve --case` validates against exactly this charset before any path
 * join, so generated ids must never contain dots or separators).
 */
export function slug(name: string): string {
  return name.replace(/\//g, '__').replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Case id = branch + PARENT + height + the conflict HEAD's sha8 (B8).
 *
 * Each part answers a collision that is fatal rather than cosmetic — a second
 * case sharing an id inherits the first's `resolved` disposition, drops out of
 * `openCases`, and can never be served:
 *  - the PARENT slug: a multi-parent branch whose two parents conflict at the
 *    SAME height would otherwise collide on branch+height;
 *  - the HEAD sha8: parents-model heads are the parent's own commits, so one
 *    height covers many of them. Resolving one conflict reopens the branch,
 *    the re-derivation walks on to the next stop, and that second case sits at
 *    the same branch+parent+height as the one just resolved.
 *
 * It is also the suffix `fixBranchName` puts on a conflict fix ref, so the ref
 * name is the case id under `fix/sweep/` and the two name one identity.
 */
export function caseId(branch: string, parent: string, height: number, headSha: string): string {
  return `${slug(branch)}--${slug(parent)}-h${height}-${headSha.slice(0, 8)}`;
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function readStepFile(path: string): StepFile {
  return JSON.parse(readFileSync(path, 'utf8')) as StepFile;
}

export function readCaseFile(path: string): CaseFile {
  return JSON.parse(readFileSync(path, 'utf8')) as CaseFile;
}

/**
 * The skip reasons the leaf / always_merge rule reads as BLOCKED: the branch
 * cannot merge yet, so an all-skip step is sanctioned (§6, `verifyStepFile`).
 *
 * `held` is deliberately absent: a branch whose merge_status is PR_ID is
 * short-circuited branch-level in `cmdRun` (journaled `skip held`, arrived,
 * next branch) and never reaches a step file at all.
 */
const BLOCKED_SKIP_REASONS = new Set(['conflict-pending', 'deferred', 'unskip-blocked', 'unskip-conflict']);

/**
 * The skip reasons that are the un-skip pass's INPUT: the parent genuinely has
 * nothing to give, which is exactly the premise the leaf / always_merge un-skip
 * acts on (it forces a chain, or rewrites these rows to an `unskip-*` abort).
 */
const UNSKIP_INPUT_SKIP_REASONS = new Set(['no-op', 'up-to-date']);

/**
 * THE WRITER POLICES ITS OWN VOCABULARY.
 *
 * The leaf / always_merge rule decides from skip reasons alone, so a reason it
 * has never heard of reads as "this branch merely no-op'd" and halts a branch
 * that is in fact blocked. The verifier stays a verifier: instead of teaching
 * it to guess, the AUTHOR refuses to emit an all-skip leaf step it cannot
 * account for: throw unless a BLOCKED reason is present — which sanctions the
 * step outright, so unknowns beside it cannot change the rule's answer — or
 * EVERY reason is un-skip input. One stray reason among no-ops is the whole
 * point: those rows reach the rule as a plain all-no-op and halt the branch.
 */
function assertClassifiedSkipReasons(branch: string, ruled: boolean, merges: StepMerge[]): void {
  if (!ruled || merges.length === 0) return;
  if (!merges.every((m) => m.action === 'skip')) return;
  const reasons = merges.map((m) => m.skipReason);
  if (reasons.some((r) => r !== null && BLOCKED_SKIP_REASONS.has(r))) return;
  const unclassified = reasons.filter((r) => r === null || !UNSKIP_INPUT_SKIP_REASONS.has(r));
  if (unclassified.length === 0) return;
  const offending = [...new Set(unclassified.map((r) => (r === null ? 'null' : r)))].join(', ');
  throw new Error(
    `${branch}: unclassified skip reason(s) on an all-skip leaf/always_merge step: ${offending} — ` +
      `classify each as blocked (${[...BLOCKED_SKIP_REASONS].join(', ')}) or as un-skip input ` +
      `(${[...UNSKIP_INPUT_SKIP_REASONS].join(', ')}) before it reaches the leaf rule`,
  );
}

/**
 * Derive the per-branch step contract from its plan row. A `merge`/forced verdict
 * becomes a `merge` step; every other verdict (skip / up-to-date / case / defer)
 * lands no merge from that parent this run (a `case` is emitted separately and
 * the branch halts on it).
 *
 * Every skip row NAMES its reason — the parent-level answer, not the merge
 * point's shape. `up-to-date` says so in the reason as well as the verdict, so
 * the file and the journal (which renders `skipReason ?? verdict`) read alike.
 */
export function buildStepFile(bp: BranchPlan, watermark: string): StepFile {
  const merges: StepMerge[] = bp.parents.map((pp) => ({
    parent: pp.parent,
    model: pp.model,
    action: pp.verdict === 'merge' ? 'merge' : 'skip',
    head: pp.verdict === 'merge' ? pp.mergePoint : null,
    ...(pp.verdict === 'merge' && !pp.forced && pp.prefix ? { prefix: pp.prefix, tree: pp.landTree } : {}),
    skipReason:
      pp.skipReason ??
      (pp.verdict === 'case'
        ? 'conflict-pending'
        : pp.verdict === 'defer'
          ? 'deferred'
          : pp.verdict === 'up-to-date'
            ? 'up-to-date'
            : null),
    forced: pp.forced,
  }));
  assertClassifiedSkipReasons(bp.branch, bp.isLeaf || bp.alwaysMerge, merges);
  const model = bp.parents[0]?.model ?? 'parents';
  const legalParents = model === 'entry' ? ['main'] : bp.parents.map((p) => p.parent);
  const requiredParents = model === 'entry' ? [] : bp.parents.map((p) => p.parent);
  return {
    schemaVersion: 1,
    branch: bp.branch,
    watermark,
    legalParents,
    requiredParents,
    isLeaf: bp.isLeaf,
    alwaysMerge: bp.alwaysMerge,
    merges,
  };
}

export interface StepVerifyContext {
  chain: Chain;
  /** Pinned current tip sha of the branch being verified. */
  branchTip: string;
  /** Inventory parents that have finished processing this pass (journal barrier). */
  arrivedParents: Set<string>;
  /** Whether the pass carries any upstream progress (leaf rule input, §6). */
  passHasProgress: boolean;
}

export interface StepVerifyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Re-verify a step file from first principles. Returns every violation found
 * (the caller hard-halts and journals on `ok === false`).
 */
export async function verifyStepFile(repo: string, step: StepFile, ctx: StepVerifyContext): Promise<StepVerifyResult> {
  const errors: string[] = [];
  const push = (m: string) => errors.push(`${step.branch}: ${m}`);

  if (step.schemaVersion !== 1) push(`unsupported schemaVersion ${step.schemaVersion}`);

  // The step must belong to THIS pass; a mismatch means git moved under us.
  if (step.watermark !== ctx.chain.watermark) {
    push(`watermark ${step.watermark.slice(0, 12)} != pass watermark ${ctx.chain.watermark.slice(0, 12)}`);
  }

  // Barrier: every required parent must have arrived this pass.
  for (const p of step.requiredParents) {
    if (!ctx.arrivedParents.has(p)) push(`barrier: required parent '${p}' has not arrived this pass`);
  }

  const legal = new Set(step.legalParents);
  const chainLen = ctx.chain.heads.length;
  const branchTree = await treeOf(repo, ctx.branchTip);
  let landedRealMerge = false;

  for (const m of step.merges) {
    // Parent legality (rejects a forged parent).
    if (!legal.has(m.parent)) {
      push(`illegal parent '${m.parent}' (legal: ${step.legalParents.join(', ') || 'none'})`);
      continue;
    }

    if (m.action === 'merge') {
      if (!m.head) {
        push(`merge from '${m.parent}' has no head`);
        continue;
      }
      const { sha, height } = m.head;

      if (m.forced) {
        // Forced (empty) merge for the leaf rule (§6): the head is the PARENT
        // TIP, whose derived coverage may be -1 (fork-only pass, no chain commit
        // is an ancestor). Skip the chain-range/coverage checks — only require
        // the head sha to be the parent tip (parent legality checked above).
        const parentTip = await revParse(repo, m.parent);
        if (sha !== parentTip) {
          push(`forced merge from '${m.parent}' head ${sha.slice(0, 12)} != parent tip ${parentTip.slice(0, 12)}`);
        } else {
          landedRealMerge = true;
        }
        continue;
      }

      // Upper bound only: height must not exceed the watermark. The lower bound
      // is model-specific — a parents-model fork-only head has derived coverage
      // -1 (no chain commit is an ancestor), which is legitimate; the entry
      // sha-check below rejects a negative height for the entry model.
      if (height >= chainLen) {
        push(`head height ${height} out of range (chain length ${chainLen}) — height > watermark`);
        continue;
      }
      // A non-forced merge lands a walked PREFIX; the head is its top.
      if (!m.prefix || m.prefix.length === 0 || !m.tree) {
        push(`merge from '${m.parent}' names no landed prefix/tree`);
        continue;
      }
      if (m.prefix[m.prefix.length - 1].sha !== sha) {
        push(`merge from '${m.parent}': head ${sha.slice(0, 12)} is not the prefix's top`);
        continue;
      }
      let membershipOk = true;
      if (m.model === 'entry') {
        // Every prefix commit must be a trunk chain commit, in ascending chain
        // order; the head's chain index must equal the claimed height.
        let prev = -1;
        for (const ps of m.prefix) {
          const idx = heightOfSha(ctx.chain, ps.sha);
          if (idx < 0) {
            push(`entry prefix sha ${ps.sha.slice(0, 12)} is not a trunk chain commit`);
            membershipOk = false;
            break;
          }
          if (idx <= prev) {
            push(`entry prefix sha ${ps.sha.slice(0, 12)} out of chain order`);
            membershipOk = false;
            break;
          }
          prev = idx;
        }
        if (membershipOk && heightOfSha(ctx.chain, sha) !== height) {
          push(`entry head sha ${sha.slice(0, 12)} chain index != claimed height ${height}`);
          membershipOk = false;
        }
      } else {
        // Parents model: every prefix commit must be PENDING for this branch —
        // reachable from the parent tip, not from the branch tip — and the
        // head's derived coverage must equal the claimed height.
        const parentTip = await revParse(repo, m.parent);
        for (const ps of m.prefix) {
          if (!(await isAncestor(repo, ps.sha, parentTip))) {
            push(`prefix sha ${ps.sha.slice(0, 12)} is not reachable from '${m.parent}'`);
            membershipOk = false;
            break;
          }
          if (await isAncestor(repo, ps.sha, ctx.branchTip)) {
            push(`prefix sha ${ps.sha.slice(0, 12)} is already absorbed by the branch`);
            membershipOk = false;
            break;
          }
        }
        if (membershipOk) {
          const cov = (await deriveCoverage(repo, ctx.chain, sha)).height;
          if (cov !== height) {
            push(`parents head ${sha.slice(0, 12)} derived coverage ${cov} != claimed height ${height}`);
            membershipOk = false;
          }
        }
      }
      if (!membershipOk) continue;

      // Replay the prefix from first principles (the same walk engine): every
      // step must fully advance with exactly the recorded auto-resolutions and
      // the landed tree must be exactly the claimed one. A real merge must
      // actually change the branch tree; a no-op should have been recorded as
      // `skip`.
      const anchor = m.model === 'entry' ? ctx.chain.watermark : await revParse(repo, m.parent);
      const surface = await computeSurface(repo, anchor, ctx.branchTip);
      const replay = await replayPrefix(repo, ctx.branchTip, m.prefix, surface, anchor);
      if (!replay.ok) {
        for (const e of replay.errors) push(`merge from '${m.parent}': ${e}`);
        continue;
      }
      if (replay.tree !== m.tree) {
        push(
          `merge from '${m.parent}': claimed tree ${m.tree.slice(0, 12)} != replayed tree ${replay.tree?.slice(0, 12) ?? 'none'}`,
        );
        continue;
      }
      if (replay.tree === branchTree) {
        push(`merge from '${m.parent}' at height ${height} is a no-op (should be skip)`);
        continue;
      }
      landedRealMerge = true;
    } else {
      // Skip claim: recompute the no-op via merge-tree. When a head is named,
      // the merge-tree result tree MUST equal the branch tree (genuine no-op).
      if (m.head) {
        const probe = await newStyleMergeTree(repo, step.branch, m.head.sha);
        if (!(probe.clean && probe.treeOid === branchTree) && !(await isAncestor(repo, m.head.sha, ctx.branchTip))) {
          push(`skip from '${m.parent}' claims no-op but merge-tree changes the branch tree`);
        }
      }
    }
  }

  // Leaf / always_merge rule (§6): when EVERY parent no-op'd in a pass that
  // carries progress, such a branch must land at least one real merge (a forced
  // empty merge counts). A branch that is BLOCKED — a conflict case pending, a
  // DEFERRED parent, an un-skip aborted because every chain to an entry passes
  // a merge_status-blocked hop ('unskip-blocked'), or an un-skip aborted
  // because a chain hop genuinely conflicts ('unskip-conflict', the §6
  // pre-probe) — is not no-op'ing and is exempt (it cannot merge yet).
  const blocked = step.merges.some(
    (m) => m.action === 'skip' && m.skipReason !== null && BLOCKED_SKIP_REASONS.has(m.skipReason),
  );
  if (
    (step.isLeaf || step.alwaysMerge) &&
    ctx.passHasProgress &&
    step.merges.length > 0 &&
    !landedRealMerge &&
    !blocked
  ) {
    push(`leaf/always_merge rule: no real merge landed although the pass carries progress`);
  }

  return { ok: errors.length === 0, errors };
}
