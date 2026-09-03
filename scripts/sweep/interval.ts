/**
 * scripts/sweep/interval.ts — eligible-line construction (§4) and the pending
 * walk (§3/§4.3).
 *
 * Candidates are enumerated at COMMIT GRAIN over the whole pending DAG and
 * probed oldest -> newest by a hypothetical tip that ADVANCES on every step,
 * so each probe sees exactly the ancestry the landed segment will have. The
 * walk stops at the first conflict it cannot resolve itself; the case is that
 * single commit and the landed prefix is everything below it. Conflict-ness is
 * NOT monotonic along a line, and the walk never assumes it is: it decides
 * step by step, never by bisection.
 *
 * The line is walked by POSITION, not by height: candidates are shas, the cut
 * is a containment test, and a `{sha, height}` is minted only where a commit
 * becomes load-bearing (the landed prefix's top, the case head — plan.ts).
 *
 * All probes are new-style `git merge-tree` (git.ts) — never single-base
 * `--merge-base=`, never cherry-pick.
 */
import { deriveCoverage, shaAtHeight, type Chain } from './heights.js';
import {
  ancestryPath,
  blobOidAt,
  git,
  newStyleMergeTree,
  overlayTreePaths,
  pathBlobRevisions,
  pendingCommits,
  revParse,
} from './git.js';
import { inSurface, type Surface } from './surface.js';
import type { WalkPrefixStep } from './types.js';

export interface EligibleLine {
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  /**
   * Candidate commit shas the branch has not absorbed, oldest -> newest. Order
   * is the position in this array; nothing here carries a height.
   */
  heads: string[];
  /**
   * Set when the trim actually removed candidates: there IS content waiting for
   * this branch and it is held back by an unresolved conflict above.
   *
   * "Nothing to take" and "something to take, blocked upstream" are different
   * facts and the pass must not report them the same way — the second is what
   * the owner is waiting on, and what the urge comments count.
   */
  trimmedAt?: number;
}

export interface BuildEligibleLineArgs {
  repo: string;
  branch: string;
  /** Concrete tip sha of the branch (pinned by the caller for the pass). */
  branchTip: string;
  parent: string;
  /**
   * Ref to READ the parent's tip from (§13): defaults to the parent's
   * branch name; a remote-only (materialize) parent is read as
   * `origin/<parent>` — plan-time probes never require a local ref.
   */
  parentRef?: string;
  model: 'entry' | 'parents';
  chain: Chain;
  /**
   * THE CUT (DRIVER.md §5.2): the trunk coordinate this branch's window closes
   * at — the minimum over its parents' cuts. Nothing at or above it is
   * eligible: that content cannot integrate until the proposal above is
   * resolved, and merging it anyway advances the branch onto a state the trunk
   * has never seen, which the integration rebuild then reports as the branch's
   * own conflict.
   *
   * `-Infinity` closes the whole range — a branch under repair is red, not
   * red-above-height-k, so no prefix of it is proven clean.
   *
   * Omitted = nothing above this branch is blocked = the full line is eligible.
   */
  blockedAtHeight?: number;
}

/**
 * THE CUT AS CONTAINMENT (§5.2). A pending commit is withheld exactly when it
 * CONTAINS the trunk commit at the cut:
 *
 *     withheld(c)  <=>  chain[trim] is an ancestor-or-equal of c
 *
 * That is a statement about content, so it needs no height and no order. The
 * blocked parent's own TIP is caught by it — precisely the state that cannot
 * integrate — while a parent's fork-only work, which contains nothing at the
 * cut, flows.
 *
 * THE WITHHELD SET IS CLOSED UNDER DESCENT within the pending set: containment
 * is inherited, so a descendant of a withheld commit is withheld too. The
 * eligible set is therefore ANCESTOR-CLOSED — an eligible commit has no
 * withheld pending ancestor — and skipping a withheld commit IS trimming.
 * Nothing above it can slip through, with no bookkeeping.
 *
 * `A..B` EXCLUDES A, so the cut commit is added back when it is itself pending;
 * omitting it lands the branch exactly at the blocked coordinate.
 *
 * A cut BELOW the chain (`WHOLE_RANGE_BLOCK`, or a conflict that derives -1)
 * has no chain commit to contain, and every pending commit is above it:
 * everything is withheld. A cut past the watermark has no chain commit either
 * and nothing is above it: nothing is withheld.
 */
export async function withheldByCut(
  repo: string,
  chain: Chain,
  trim: number,
  sourceTip: string,
  pending: Set<string>,
): Promise<Set<string>> {
  if (trim === Infinity) return new Set();
  const cutSha = shaAtHeight(chain, trim);
  if (cutSha === null) return trim < 0 ? new Set(pending) : new Set();
  const withheld = new Set<string>();
  for (const sha of await ancestryPath(repo, cutSha, sourceTip)) if (pending.has(sha)) withheld.add(sha);
  if (pending.has(cutSha)) withheld.add(cutSha);
  return withheld;
}

/**
 * Eligible line for one (branch, parent) pair (§4):
 *  - entry model: candidates are the trunk chain commits above the branch's
 *    coverage (the shas ARE trunk commits, so the chain index is exact and the
 *    cut is an index comparison — free).
 *  - parents model: candidates are the parent's WHOLE PENDING DAG — every
 *    commit reachable from the parent tip and not from the branch tip, merges
 *    included, in topological order. A parent that advanced by one big
 *    propagation merge still has every commit that merge dragged in offered
 *    individually, so the walk can stop at the finest cut that exists instead
 *    of taking the whole merge or nothing. Merges stay candidates in their own
 *    right: an author's recorded integration tree can exist in no non-merge
 *    commit, and only taking the merge itself can land it.
 *
 * ENUMERATION IS AT COMMIT GRAIN and ABSORPTION IS ANCESTRY, NOT HEIGHT. The
 * walk excludes what the branch already contains (`^branchTip`), which is the
 * exact bound of the unabsorbed window; heights repeat across fork-side
 * commits and are minted only where a commit is load-bearing. This is also
 * what carries fork-only parent content down: a parent whose only new work is
 * fork-side has that work enumerated as ordinary candidates, so a fork fix
 * merged into a parent reaches descendants without waiting for upstream to
 * advance.
 */
export async function buildEligibleLine(args: BuildEligibleLineArgs): Promise<EligibleLine> {
  const { repo, branch, branchTip, parent, model, chain } = args;
  const trim = args.blockedAtHeight ?? Infinity;

  if (model === 'entry') {
    const coverage = (await deriveCoverage(repo, chain, branchTip)).height;
    const above = chain.heads.filter((h) => h.height > coverage);
    const eligible = above.filter((h) => h.height < trim);
    const heads = eligible.map((h) => h.sha);
    return { branch, parent, model, heads, ...(heads.length < above.length ? { trimmedAt: trim } : {}) };
  }

  // parents model: the whole pending DAG of the parent, oldest -> newest,
  // over exactly what the branch has not absorbed.
  const parentTip = await revParse(repo, args.parentRef ?? parent);
  const lineShas = await pendingCommits(repo, parentTip, branchTip);
  const withheld = await withheldByCut(repo, chain, trim, parentTip, new Set(lineShas));
  const heads = lineShas.filter((sha) => !withheld.has(sha));
  return { branch, parent, model, heads, ...(withheld.size > 0 ? { trimmedAt: trim } : {}) };
}

function reproCommand(branch: string, headSha: string): { command: string } {
  return { command: `git merge-tree --write-tree --name-only ${branch} ${headSha}` };
}

// ---------------------------------------------------------------------------
// The pending walk (§4.3): probe candidates oldest -> newest with a
// hypothetical tip that ADVANCES on every step, auto-resolving what is not the
// owner's question, and stopping at the first conflict that is.
// ---------------------------------------------------------------------------

/** One landed walk step: the candidate, the tree it left, what it auto-resolved. */
export interface WalkStep {
  sha: string;
  /** The hypothetical tip's tree AFTER this step (auto-resolutions applied). */
  tree: string;
  /** Conflicted paths this step resolved itself (sorted; empty on a clean step). */
  autoResolved: string[];
}

export interface WalkConflict {
  /** The stop commit — the single candidate the case is about. */
  head: string;
  /** The unresolved IN-SURFACE conflicted paths — the case's whole question. */
  conflictedPaths: string[];
  /**
   * The exhibit tree: the automerge with every auto-resolvable member already
   * resolved, so markers exist ONLY at `conflictedPaths`.
   */
  automergeTree: string;
  reproduction: { command: string };
}

export interface WalkResult {
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  /** No candidates — nothing to take from this parent. */
  upToDate: boolean;
  /** The landed prefix, in walk order (every candidate below the stop). */
  steps: WalkStep[];
  /**
   * The tree the branch lands at (the last step's tree, plus the final
   * reconciliation when the walk absorbed the source anchor); null when no
   * step landed.
   */
  landTree: string | null;
  /** Paths the final reconciliation took from the source anchor (sorted). */
  reconciled: string[];
  conflict: WalkConflict | null;
  probeCount: number;
}

/**
 * The paths a merge commit's author DECIDED — where the recorded tree differs
 * from the automerge of its own first two parents. Input to the equivalence
 * rule below; null for a non-merge commit.
 */
async function decidedPaths(repo: string, commit: string): Promise<Set<string> | null> {
  const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', commit])).stdout.trim().split(/\s+/).slice(1);
  if (parents.length < 2) return null;
  const mt = await newStyleMergeTree(repo, parents[0], parents[1]);
  const diff = await git(repo, ['diff', '--name-only', mt.treeOid, `${commit}^{tree}`], { allowCodes: [1] });
  return new Set(diff.stdout.split('\n').filter(Boolean));
}

/**
 * A WALK STEP NEVER MOVES A PATH BACKWARDS. An auto-resolution may take the
 * incoming side only where the incoming side stands AHEAD of what the walk
 * already holds there — never an ancestor of it, never an unrelated older
 * revision.
 *
 * Blobs carry no parents, so "ahead" is decided by the path's REVISION SET in
 * the candidate's own ancestry (`pathBlobRevisions`): the incoming side is
 * ahead exactly when the held blob is one of the revisions the candidate has
 * already moved past (or the two sides agree, or the walk holds nothing there).
 * When it is not — when the candidate is an INTERMEDIATE commit of a line whose
 * newer answer the branch already carries — the held side stays, and the newer
 * content survives the step.
 *
 * Absent this test the incoming rule reads "the branch has nothing of its own
 * here" off the SURFACE alone, which is a statement about the merge base, not
 * about what the branch holds now: a branch that took a source's final answer
 * at a path is out-of-surface there and would hand it back to any older
 * revision of the same path that the line still offers as a candidate.
 */
async function incomingIsAhead(repo: string, hyp: string, candidate: string, path: string): Promise<boolean> {
  const held = await blobOidAt(repo, hyp, path);
  if (held === null) return true; // nothing held here — nothing to lose
  if ((await blobOidAt(repo, candidate, path)) === held) return true; // same content either way
  return (await pathBlobRevisions(repo, candidate, path)).has(held);
}

/**
 * One step of the walk engine, shared by `pendingWalk` and `replayPrefix` so
 * derivation and re-verification cannot disagree about what a step does.
 *
 * Probe `merge-tree(hyp, C)`; on conflict, partition the conflicted paths:
 *  - OUT-OF-SURFACE members auto-resolve without asking: the branch has nothing
 *    of its own there, so the collision is between two states the source's
 *    author already integrated — at a merge commit those blobs ARE the author's
 *    own integration. The side taken is the INCOMING one (`tree(C)`'s blob, or
 *    its absence) where it stands ahead of what the walk holds, and the HELD one
 *    otherwise (`incomingIsAhead`), so an intermediate candidate can never hand
 *    a path back to an older revision.
 *  - IN-SURFACE members auto-resolve BY EQUIVALENCE, where the question is
 *    already answered and both endpoints hold the same answer:
 *      - the branch tip and the SOURCE ANCHOR agree on the path — the source's
 *        author, whatever route their history took, ended where the branch
 *        already is, so an intermediate commit's disagreement is history
 *        noise, not a question (without this, a sibling commit a later merge
 *        in the same window resolves raises a case on an edge whose
 *        endpoint-level merge is clean);
 *      - at a MERGE commit, the branch already carries the author's DECISION
 *        (`tree(branchTip)` equals `tree(C)` at a path the author decided).
 *    Either way the resolution is content the branch ALREADY HAS or the author
 *    recorded — never new content, so a cut above the line cannot leak
 *    through it.
 *  - anything left is the owner's question: the step STOPS.
 */
export async function walkStep(
  repo: string,
  hyp: string,
  candidate: string,
  surface: Surface,
  branchTipSha: string,
  sourceAnchor: string,
): Promise<
  | { kind: 'advance'; tree: string; autoResolved: string[] }
  | { kind: 'stop'; conflict: WalkConflict }
> {
  const probe = await newStyleMergeTree(repo, hyp, candidate);
  if (probe.clean) return { kind: 'advance', tree: probe.treeOid, autoResolved: [] };
  const inS = probe.conflictFiles.filter((p) => inSurface(surface, p));
  const outS = probe.conflictFiles.filter((p) => !inSurface(surface, p));
  const decided = inS.length > 0 ? await decidedPaths(repo, candidate) : null;
  /** In-surface members settled by equivalence -> the side to take the blob from. */
  const agreed = new Map<string, string>();
  for (const p of inS) {
    const branchBlob = await blobOidAt(repo, branchTipSha, p);
    if ((await blobOidAt(repo, sourceAnchor, p)) === branchBlob) {
      agreed.set(p, branchTipSha); // both endpoints agree — take the shared answer
      continue;
    }
    if (decided?.has(p) && branchBlob !== null && branchBlob === (await blobOidAt(repo, candidate, p))) {
      agreed.set(p, candidate); // the branch already carries the author's decision
    }
  }
  /** Out-of-surface members split by direction: the incoming side, or the held one. */
  const takeIncoming: string[] = [];
  const keepHeld: string[] = [];
  for (const p of outS) ((await incomingIsAhead(repo, hyp, candidate, p)) ? takeIncoming : keepHeld).push(p);
  const autoResolved = [...outS, ...agreed.keys()].sort();
  const remaining = inS.filter((p) => !agreed.has(p));
  let resolvedTree = probe.treeOid;
  if (takeIncoming.length > 0) resolvedTree = await overlayTreePaths(repo, resolvedTree, candidate, takeIncoming);
  if (keepHeld.length > 0) resolvedTree = await overlayTreePaths(repo, resolvedTree, hyp, keepHeld);
  for (const [p, from] of agreed) {
    resolvedTree = await overlayTreePaths(repo, resolvedTree, from, [p]);
  }
  if (remaining.length === 0) return { kind: 'advance', tree: resolvedTree, autoResolved };
  return {
    kind: 'stop',
    conflict: {
      head: candidate,
      conflictedPaths: remaining,
      automergeTree: resolvedTree,
      reproduction: reproCommand(hyp, candidate),
    },
  };
}

/** Advance the hypothetical tip: a ref-less merge commit carrying real ancestry. */
async function advanceHyp(repo: string, hyp: string, candidate: string, tree: string): Promise<string> {
  const res = await git(repo, ['commit-tree', tree, '-p', hyp, '-p', candidate, '-m', `walk: absorb ${candidate}`]);
  return res.stdout.trim();
}

/**
 * The FINAL RECONCILIATION: when the walk absorbed the source anchor itself,
 * out-of-surface paths that still differ from the anchor take the anchor's
 * blobs. Mid-walk auto-resolutions can leave such residue; the author of the
 * source already integrated those paths, so the endpoint must agree with them.
 * Returns the reconciled tree and the paths taken (sorted).
 */
export async function reconcileToAnchor(
  repo: string,
  tree: string,
  anchor: string,
  surface: Surface,
): Promise<{ tree: string; reconciled: string[] }> {
  const diff = await git(repo, ['diff', '--name-only', tree, `${anchor}^{tree}`], { allowCodes: [1] });
  const paths = diff.stdout
    .split('\n')
    .filter(Boolean)
    .filter((p) => !inSurface(surface, p))
    .sort();
  if (paths.length === 0) return { tree, reconciled: [] };
  return { tree: await overlayTreePaths(repo, tree, anchor, paths), reconciled: paths };
}

/**
 * Walk one eligible line (§4.3). THE HYPOTHETICAL TIP ADVANCES ON EVERY STEP,
 * clean ones included: probing every candidate against the unmoved branch tip
 * reports conflicts the executed sequence never meets, even on a linear chain
 * — each probe after the first would merge a candidate against a tip that is
 * missing what the walk already took. The advance is a ref-less commit-tree,
 * so the probes see exactly the ancestry the landed segment will have.
 *
 * The walk stops at the FIRST conflict the engine cannot resolve itself
 * (`walkStep`); the case is that single candidate, and everything below it is
 * the landed prefix. What lands is exactly what was probed in sequence, and
 * what is asked is exactly one commit's in-surface question — nothing above
 * the stop is probed, landed or exhibited.
 */
const WALK_MEMO_CAP = 256;
const walkMemo = new Map<string, WalkResult>();

export async function pendingWalk(
  repo: string,
  branchTip: string,
  line: EligibleLine,
  surface: Surface,
  sourceAnchor: string,
): Promise<WalkResult> {
  const { branch, parent, model, heads } = line;
  const base = { branch, parent, model } as const;
  if (heads.length === 0) {
    return { ...base, upToDate: true, steps: [], landTree: null, reconciled: [], conflict: null, probeCount: 0 };
  }
  const tipSha = await revParse(repo, branchTip);
  // The walk is a pure function of the object graph reachable from the tip,
  // the candidates and the anchor, so identical inputs give identical answers
  // and a run that re-derives one branch several times (verify, emission, the
  // moved-tip re-derivation of its siblings) pays for the walk once.
  const memoKey = [repo, tipSha, sourceAnchor, heads.join(',')].join('\0');
  const memoized = walkMemo.get(memoKey);
  if (memoized) return { ...memoized, ...base };
  let hyp = tipSha;
  const steps: WalkStep[] = [];
  let conflict: WalkConflict | null = null;
  let probeCount = 0;
  for (const candidate of heads) {
    probeCount++;
    const step = await walkStep(repo, hyp, candidate, surface, tipSha, sourceAnchor);
    if (step.kind === 'stop') {
      conflict = step.conflict;
      break;
    }
    steps.push({ sha: candidate, tree: step.tree, autoResolved: step.autoResolved });
    hyp = await advanceHyp(repo, hyp, candidate, step.tree);
  }
  let landTree = steps.length > 0 ? steps[steps.length - 1].tree : null;
  let reconciled: string[] = [];
  if (landTree !== null && conflict === null && steps[steps.length - 1].sha === sourceAnchor) {
    const rec = await reconcileToAnchor(repo, landTree, sourceAnchor, surface);
    landTree = rec.tree;
    reconciled = rec.reconciled;
  }
  const result: WalkResult = { ...base, upToDate: false, steps, landTree, reconciled, conflict, probeCount };
  if (walkMemo.size >= WALK_MEMO_CAP) walkMemo.clear();
  walkMemo.set(memoKey, result);
  return result;
}

/**
 * Re-verify a recorded prefix FROM FIRST PRINCIPLES (steps.ts): replay the
 * walk engine over exactly the recorded candidates and require every step to
 * fully advance with exactly the recorded auto-resolutions. The replay never
 * searches — it probes nothing beyond the prefix — so verification costs what
 * the landing costs and trusts nothing the file claims.
 */
export async function replayPrefix(
  repo: string,
  branchTip: string,
  prefix: readonly WalkPrefixStep[],
  surface: Surface,
  sourceAnchor: string,
): Promise<{ ok: boolean; tree: string | null; errors: string[] }> {
  const errors: string[] = [];
  const tipSha = await revParse(repo, branchTip);
  let hyp = tipSha;
  let tree: string | null = null;
  for (const p of prefix) {
    const step = await walkStep(repo, hyp, p.sha, surface, tipSha, sourceAnchor);
    if (step.kind === 'stop') {
      errors.push(
        `prefix step ${p.sha.slice(0, 12)} does not fully resolve (unresolved: ${step.conflict.conflictedPaths.join(', ')})`,
      );
      return { ok: false, tree: null, errors };
    }
    const recorded = [...p.autoResolved].sort().join(',');
    const recomputed = [...step.autoResolved].sort().join(',');
    if (recorded !== recomputed) {
      errors.push(
        `prefix step ${p.sha.slice(0, 12)} auto-resolution mismatch: recorded [${recorded}] != recomputed [${recomputed}]`,
      );
      return { ok: false, tree: null, errors };
    }
    tree = step.tree;
    hyp = await advanceHyp(repo, hyp, p.sha, step.tree);
  }
  if (tree !== null && prefix.length > 0 && prefix[prefix.length - 1].sha === sourceAnchor) {
    tree = (await reconcileToAnchor(repo, tree, sourceAnchor, surface)).tree;
  }
  return { ok: true, tree, errors };
}
