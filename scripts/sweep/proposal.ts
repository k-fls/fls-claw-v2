/**
 * scripts/sweep/proposal.ts — whose head is this, and what should happen to it.
 *
 * An open pull request on a `fix/sweep/*` ref is a PROPOSAL, and what the
 * driver may do to it turns on ONE question: is every commit on it the
 * driver's? Force-pushing over commits somebody else put there is the single
 * destructive operation available here. DELETING a ref is not destructive —
 * GitHub closes the PR and keeps its commits, restorable — so an unusable head
 * is deleted and reported, never force-rebuilt.
 */
import { git } from './git.js';
import type { ConflictRelation } from './conflict-identity.js';

/**
 * The driver's commit identity: fixed name, email and dates so re-running a
 * publish rebuilds the SAME sha for the same tree and parents (a retried push
 * stays a no-op instead of a non-fast-forward) — and so a head can be
 * recognised as the driver's from the objects alone.
 */
export const DRIVER_COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'sweep-driver',
  GIT_AUTHOR_EMAIL: 'sweep-driver@localhost',
  GIT_COMMITTER_NAME: 'sweep-driver',
  GIT_COMMITTER_EMAIL: 'sweep-driver@localhost',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const DRIVER_EPOCH = Math.floor(Date.parse(DRIVER_COMMIT_ENV.GIT_AUTHOR_DATE) / 1000);
/** ASCII unit separator: it cannot occur in a name, an address or a timestamp. */
const UNIT = '\u001f';

/**
 * THE DRIVER-SHAPE TEST: walk the FIRST-PARENT line from `head` down to the PR
 * base and require every commit on it to carry the driver's identity —
 * authorship, committership and both dates, all pinned. Anything else on that
 * walk is someone else's push.
 *
 * It is the COMMITS, never the ref name and never the GitHub author: a name is
 * a string the driver minted, and the API's author field is whoever's token
 * pushed, which is the same token for both sides here.
 *
 * An EMPTY walk (the head is already contained in the base) is not a driver
 * head either — there is nothing to attribute, and nothing to rebuild.
 */
export async function driverShaped(repo: string, head: string, base: string): Promise<boolean> {
  const fmt = ['%an', '%ae', '%at', '%cn', '%ce', '%ct'].join('%x1f');
  const res = await git(repo, ['log', '--first-parent', `--format=${fmt}`, head, `^${base}`]);
  const lines = res.stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const [an, ae, at, cn, ce, ct] = line.split(UNIT);
    return (
      an === DRIVER_COMMIT_ENV.GIT_AUTHOR_NAME &&
      ae === DRIVER_COMMIT_ENV.GIT_AUTHOR_EMAIL &&
      cn === DRIVER_COMMIT_ENV.GIT_COMMITTER_NAME &&
      ce === DRIVER_COMMIT_ENV.GIT_COMMITTER_EMAIL &&
      Number(at) === DRIVER_EPOCH &&
      Number(ct) === DRIVER_EPOCH
    );
  });
}

/** What the driver does with an open proposal this pass. */
export type ProposalAction =
  /** The ref is deleted; GitHub closes the PR and keeps its commits. */
  | 'delete'
  /** The same question against a moved base: re-push the exhibit, keep the PR and its body. */
  | 'rebase'
  /** A different question: re-push the exhibit; the body no longer describes it. */
  | 'rebuild'
  /** An approved answer that still merges and still passes: land it, verify-gated. */
  | 'land'
  /** Somebody else's PR that is still fine: touch nothing at all. */
  | 'leave'
  /** Somebody else's PR that no longer merges or no longer passes: draft it once, report it. */
  | 'draft-and-report'
  /** Nothing to do: the proposal stands as it is and the branch stays blocked. */
  | 'hold';

export interface ProposalState {
  /** Whose commits the head carries (`driverShaped`). */
  shape: 'driver' | 'owner';
  /**
   * How the conflict the head EXHIBITS relates to the conflict there is now, or
   * null when the head carries no markers — an ANSWER rather than an exhibit.
   */
  relation: ConflictRelation | null;
  /** The head still merges into the current target (a local merge-tree probe). */
  mergeable: boolean;
  /** The driver's own checks gate passes on the merged tree. */
  checksGreen: boolean;
  /** A submitted review approved it. */
  approved: boolean;
  /** The target moved since the head was built. */
  baseMoved: boolean;
  /**
   * THE RED IS THE PULL REQUEST'S SUBJECT MATTER. A gate-fix hold that could not
   * be fixed inside the case's named files documents the failure instead of
   * repairing it, so the checks it fails are the ones it was opened about.
   *
   * Read off the head's own body — the failures it records — and never assumed
   * from the ref name: a head that documents one failure and now fails a
   * different one is a stale answer like any other.
   */
  documentsItsRed: boolean;
}

/**
 * THE DISPOSITION, BY CONSEQUENCE AND NEVER BY CAUSE. Why a head stopped being
 * usable does not change what to do about it; whether it is ours does.
 *
 * An OWNER-shaped head is never rebuilt and never deleted. Force-pushing over
 * someone else's commits is the one destructive act here, so a PR that no
 * longer merges or no longer passes is drafted once — the draft flag is the
 * "already told you" marker, so a PR the owner opened as a draft is never
 * converted and never commented on — and the REPORT is what carries it every
 * pass thereafter.
 *
 * A DRIVER-shaped exhibit follows the conflict it poses: gone, and the question
 * is gone with it; the same, and only the base under it needs moving; anything
 * else, and the exhibit has to be rebuilt because the body describes a question
 * nobody is being asked.
 *
 * A DRIVER-shaped ANSWER that no longer merges or no longer passes is deleted
 * rather than rebuilt: the resolution it carries is not salvageable against the
 * current tree, and a fresh case derives the real question again.
 *
 * EXCEPT WHERE THE RED IS THE ANSWER. A diagnosis is a hold that documents a
 * failure nobody could fix in the case's scope, so it fails the checks it was
 * opened about — by construction, and for as long as the defect stands. Deleting
 * it for that red closes the review thread where the decision lives and buys the
 * owner a new pull request number for the same finding every pass, forever. It
 * still has to MERGE, and the red still has to be the one it documents: a
 * diagnosis that fails something else is a stale answer like any other.
 */
export function disposeProposal(state: ProposalState): ProposalAction {
  const usable = state.mergeable && state.checksGreen;
  if (state.shape === 'owner') return usable ? 'leave' : 'draft-and-report';
  if (state.relation === null) {
    if (state.mergeable && !state.checksGreen && state.documentsItsRed) return 'hold';
    if (!usable) return 'delete';
    if (state.approved) return 'land';
    return state.baseMoved ? 'rebase' : 'hold';
  }
  if (state.relation === 'healed') return 'delete';
  if (state.relation === 'same') return state.baseMoved ? 'rebase' : 'hold';
  return 'rebuild';
}
