/**
 * scripts/sweep/steps.ts — step/case JSON artifacts and their FIRST-PRINCIPLES
 * re-verification (PROPAGATION.md §7).
 *
 * The driver is the only author of merge parameters, but the merge executor
 * NEVER trusts the file author: for every step it independently recomputes,
 * from git state + the pinned chain, that
 *   - the step is for THIS pass (watermark matches),
 *   - every parent is a legal inventory parent (or `main` for entry branches),
 *   - each head's sha matches its claimed height and lies on the parent's
 *     eligible line (entry: the trunk chain; parents: the parent's first-parent
 *     line with derived coverage),
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

import { deriveCoverage, shaAtHeight, type Chain } from './heights.js';
import { firstParentChain, git, isAncestor, newStyleMergeTree, revParse } from './git.js';
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
 * Case id = branch + PARENT + height (B8). The parent slug is essential: a
 * multi-parent branch whose two parents conflict at the SAME height would
 * otherwise collide on branch+height, and the double-resolve guard would make
 * the second case unresolvable for the whole pass (deadlock).
 */
export function caseId(branch: string, parent: string, height: number): string {
  return `${slug(branch)}--${slug(parent)}-h${height}`;
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
 * Derive the per-branch step contract from its plan row. A `merge`/forced verdict
 * becomes a `merge` step; every other verdict (skip / up-to-date / case / defer)
 * lands no merge from that parent this run (a `case` is emitted separately and
 * the branch halts on it).
 */
export function buildStepFile(bp: BranchPlan, watermark: string): StepFile {
  const merges: StepMerge[] = bp.parents.map((pp) => ({
    parent: pp.parent,
    model: pp.model,
    action: pp.verdict === 'merge' ? 'merge' : 'skip',
    head: pp.verdict === 'merge' ? pp.mergePoint : null,
    skipReason:
      pp.skipReason ?? (pp.verdict === 'case' ? 'conflict-pending' : pp.verdict === 'defer' ? 'deferred' : null),
    forced: pp.forced,
  }));
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
      if (m.model === 'entry') {
        // Head sha must be the trunk commit at that exact height (forged sha/height).
        const expected = shaAtHeight(ctx.chain, height);
        if (expected !== sha) {
          push(
            `entry head sha ${sha.slice(0, 12)} != trunk commit at height ${height} (${expected?.slice(0, 12) ?? 'none'})`,
          );
          continue;
        }
      } else {
        // Parents model: head must be on the parent's first-parent line AND its
        // derived coverage must equal the claimed height.
        const parentTip = await revParse(repo, m.parent);
        const line = await firstParentChain(repo, parentTip, ctx.chain.base);
        if (!line.includes(sha)) {
          push(`parents head sha ${sha.slice(0, 12)} is not on '${m.parent}' first-parent line`);
          continue;
        }
        const cov = (await deriveCoverage(repo, ctx.chain, sha)).height;
        if (cov !== height) {
          push(`parents head ${sha.slice(0, 12)} derived coverage ${cov} != claimed height ${height}`);
          continue;
        }
      }

      // A real merge must actually change the branch tree; a no-op should have
      // been recorded as `skip`.
      const probe = await newStyleMergeTree(repo, step.branch, sha);
      if (probe.clean && probe.treeOid === branchTree) {
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
    (m) =>
      m.action === 'skip' &&
      (m.skipReason === 'conflict-pending' ||
        m.skipReason === 'deferred' ||
        m.skipReason === 'unskip-blocked' ||
        m.skipReason === 'unskip-conflict'),
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
