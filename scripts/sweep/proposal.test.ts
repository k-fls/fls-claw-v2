import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { initFixtureRepo, type FixtureRepo } from './fixtures.js';
import { DRIVER_COMMIT_ENV, disposeProposal, driverShaped, type ProposalState } from './proposal.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('driverShaped — the walk from the head down to the base', () => {
  /** base branch + a driver head on top of it, in a throwaway repo. */
  function repoWithHead(): { repo: FixtureRepo; base: string; tree: string } {
    const repo = initFixtureRepo();
    cleanups.push(() => repo.destroy());
    repo.commit('base', { 'src/a.ts': 'a\n' });
    const base = repo.sha('main');
    return { repo, base, tree: repo.git('rev-parse', 'main^{tree}') };
  }

  /**
   * commit-tree under the driver's pinned identity — the same environment
   * `deterministicCommit` uses, which is exactly what the walk reads back.
   */
  function commitAsDriver(repo: FixtureRepo, tree: string, parents: string[], message: string): string {
    return execFileSync(
      'git',
      ['-C', repo.dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message],
      { encoding: 'utf8', env: { ...process.env, ...DRIVER_COMMIT_ENV } },
    ).trim();
  }

  it('a head every commit of which is the driver’s is driver-shaped', async () => {
    const { repo, base, tree } = repoWithHead();
    const head = commitAsDriver(repo, tree, [base], 'Pristine conflict for a case');
    expect(await driverShaped(repo.dir, head, base)).toBe(true);
  });

  it('one foreign commit anywhere on the walk disqualifies the whole head', async () => {
    // This is the guard on the only destructive operation available here.
    const { repo, base, tree } = repoWithHead();
    const ours = commitAsDriver(repo, tree, [base], 'Pristine conflict for a case');
    repo.checkout('fixref', { create: true, at: ours });
    repo.commit('owner: my own edit', { 'src/a.ts': 'owner\n' });
    expect(await driverShaped(repo.dir, repo.sha('fixref'), base)).toBe(false);
    // …and the driver commit UNDER it is still ours when asked on its own.
    expect(await driverShaped(repo.dir, ours, base)).toBe(true);
  });

  it('only the FIRST-PARENT line is walked — the merged-in side is not ours to judge', async () => {
    const { repo, base, tree } = repoWithHead();
    repo.checkout('theirs', { create: true, at: base });
    const conflictHead = repo.commit('upstream: their edit', { 'src/a.ts': 'theirs\n' });
    const head = commitAsDriver(repo, tree, [base, conflictHead], 'Pristine conflict for a case');
    expect(await driverShaped(repo.dir, head, base)).toBe(true);
  });

  it('a head already contained in the base is not a driver head', async () => {
    // Nothing to attribute and nothing to rebuild.
    const { repo, base } = repoWithHead();
    expect(await driverShaped(repo.dir, base, base)).toBe(false);
  });

  it('an ordinary branch commit is not the driver’s', async () => {
    const { repo, base } = repoWithHead();
    repo.checkout('owner-ref', { create: true, at: base });
    repo.commit('owner: a fix of my own', { 'src/a.ts': 'mine\n' });
    expect(await driverShaped(repo.dir, repo.sha('owner-ref'), base)).toBe(false);
  });
});

describe('disposeProposal — the disposition table, by consequence', () => {
  const state = (over: Partial<ProposalState>): ProposalState => ({
    shape: 'driver',
    relation: null,
    mergeable: true,
    checksGreen: true,
    approved: false,
    baseMoved: false,
    ...over,
  });

  it('driver, conflict healed → delete the ref', () => {
    expect(disposeProposal(state({ relation: 'healed' }))).toBe('delete');
  });

  it('driver, same conflict → rebase only when the base moved', () => {
    expect(disposeProposal(state({ relation: 'same', baseMoved: true }))).toBe('rebase');
    expect(disposeProposal(state({ relation: 'same', baseMoved: false }))).toBe('hold');
  });

  it('driver, conflict changed or superset → rebuild', () => {
    expect(disposeProposal(state({ relation: 'superset' }))).toBe('rebuild');
    expect(disposeProposal(state({ relation: 'different' }))).toBe('rebuild');
    // The base having moved does not soften it: the question itself changed.
    expect(disposeProposal(state({ relation: 'different', baseMoved: true }))).toBe('rebuild');
  });

  it('driver, an answer that merges and passes → land it when approved, else follow the base', () => {
    expect(disposeProposal(state({ approved: true }))).toBe('land');
    expect(disposeProposal(state({ approved: false, baseMoved: true }))).toBe('rebase');
    expect(disposeProposal(state({ approved: false, baseMoved: false }))).toBe('hold');
  });

  it('driver, an answer that no longer merges or no longer passes → delete the ref', () => {
    // Not rebuilt: the resolution it carries cannot be salvaged against this
    // tree, and a fresh case asks the real question again.
    expect(disposeProposal(state({ mergeable: false }))).toBe('delete');
    expect(disposeProposal(state({ checksGreen: false }))).toBe('delete');
    expect(disposeProposal(state({ mergeable: false, approved: true }))).toBe('delete');
  });

  it('an OWNER head that merges and passes is left completely alone', () => {
    expect(disposeProposal(state({ shape: 'owner' }))).toBe('leave');
    expect(disposeProposal(state({ shape: 'owner', baseMoved: true }))).toBe('leave');
    // Even when it is exhibiting a conflict of some kind — it is not ours.
    expect(disposeProposal(state({ shape: 'owner', relation: 'different' }))).toBe('leave');
  });

  it('an OWNER head that no longer merges or no longer passes is drafted and reported — never rewritten', () => {
    expect(disposeProposal(state({ shape: 'owner', mergeable: false }))).toBe('draft-and-report');
    expect(disposeProposal(state({ shape: 'owner', checksGreen: false }))).toBe('draft-and-report');
    // No input produces a destructive action on an owner head.
    for (const relation of [null, 'healed', 'same', 'superset', 'different'] as const) {
      for (const mergeable of [true, false]) {
        for (const checksGreen of [true, false]) {
          for (const baseMoved of [true, false]) {
            const action = disposeProposal(state({ shape: 'owner', relation, mergeable, checksGreen, baseMoved }));
            expect(['leave', 'draft-and-report']).toContain(action);
          }
        }
      }
    }
  });
});
