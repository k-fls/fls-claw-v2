/**
 * scripts/sweep/propagation-cases.test.ts — real-DAG regression anchors for the
 * propagation driver, mined from the fork + upstream (test-cases/propagation/).
 *
 * These run against the REAL repository the tests execute in. Every case is
 * guarded by a resolvability check (git cat-file -e on the pinned SHAs) and
 * skips LOUDLY (console.warn naming the case + vanished anchor) when the objects
 * are absent, so a green run can never quietly hide a pruned anchor. Assertions
 * use the PINNED chain (chain.txt) rather than live `upstream/main`, so they
 * stay stable if upstream advances.
 *
 * PIN-BY-PATCH (2026-07-20): a single-commit fork branch whose tip became
 * unreachable (owner rebase) is re-synthesizable from a `pins/<case>.patch`
 * (`git diff --binary main <tip>`): apply it to `main` in a detached temp
 * worktree and commit-tree → a commit with the EXACT tip tree and merge-base
 * `main`, so every probe reproduces. Multi-commit fork branches (p2/p4/p5/p6)
 * are NOT patch-pinned (a patch vs main would be huge); if they rebase, re-mine.
 *
 * Height convention: chain.txt line N == mining height N (1-based). For coverage
 * we build a Chain with 0-based `height` indices (the code's convention), so a
 * mining coverage of K maps to a derived 0-based height of K-1 (-1 == none).
 * For the p7 merge-point sweep we label heads with the 1-based mining heights so
 * the assertions read 61/62 exactly as the case file records them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { checkDeferred } from './deferred.js';
import { isAncestor, newStyleMergeTree } from './git.js';
import { deriveCoverage, type Chain } from './heights.js';
import { mergePointSweep, type EligibleLine } from './interval.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'test-cases', 'propagation');
const REPO = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: DIR, encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

const WATERMARK = '082f5c7ea99342fcb324ab78baacb0c4e6894029';
const BASE = 'cb6e3d117c127054ca5bc5a53645d794d93cc595';

function present(sha: string): boolean {
  try {
    execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
/**
 * LOUD skip: warn (naming the case + which anchors vanished) and return false so
 * a green run can never silently hide a pruned anchor. `anchors` is name -> sha.
 */
function ensure(caseId: string, anchors: Record<string, string>): boolean {
  const missing = Object.entries(anchors)
    .filter(([, s]) => !present(s))
    .map(([name, s]) => `${name}=${s.slice(0, 12)}`);
  if (missing.length) {
    console.warn(
      `[propagation-cases] SKIP ${caseId}: unreachable anchor(s): ${missing.join(', ')} — re-mine or add a pin patch`,
    );
    return false;
  }
  return true;
}

/**
 * Pin-by-patch synthesis: recreate a vanished single-commit tip by applying
 * `pins/<case>.patch` to `baseSha` in a detached temp worktree and commit-tree.
 * Loose objects only, no refs (enough for merge-tree probes this run). Memoized.
 */
const synthCache = new Map<string, string>();
function synthesizePinnedTip(repo: string, baseSha: string, patchAbsPath: string): string {
  const key = `${baseSha}:${patchAbsPath}`;
  const cached = synthCache.get(key);
  if (cached) return cached;
  const wt = mkdtempSync(join(tmpdir(), 'prop-pin-'));
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', wt, baseSha]);
    // D-027: a formatter hook can leave a checked-out worktree dirty — restore
    // to the pristine base before applying so the patch lands cleanly.
    try {
      execFileSync('git', ['-C', wt, 'checkout', '--', '.'], { stdio: 'ignore' });
    } catch {
      /* clean already */
    }
    execFileSync('git', ['-C', wt, 'apply', '--index', patchAbsPath]);
    const tree = execFileSync('git', ['-C', wt, 'write-tree'], { encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['-C', wt, 'commit-tree', tree, '-p', baseSha, '-m', 'synthesized pinned tip'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'pin',
        GIT_AUTHOR_EMAIL: 'pin@test.invalid',
        GIT_COMMITTER_NAME: 'pin',
        GIT_COMMITTER_EMAIL: 'pin@test.invalid',
      },
    }).trim();
    synthCache.set(key, commit);
    return commit;
  } finally {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * Resolve a case's fork tip: the pinned sha if still reachable, else synthesize
 * from its `pin_patch` (applied to `main`/BASE), else a LOUD skip (null).
 */
function resolveTip(caseId: string, sha: string, pinPatchRel: string | undefined): string | null {
  if (present(sha)) return sha;
  if (pinPatchRel) {
    const abs = join(DIR, pinPatchRel);
    if (existsSync(abs)) return synthesizePinnedTip(REPO, BASE, abs);
  }
  console.warn(
    `[propagation-cases] SKIP ${caseId}: pinned tip ${sha.slice(0, 12)} is unreachable and no usable pin patch — re-mine`,
  );
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function loadCase(file: string): any {
  return parse(readFileSync(join(DIR, 'cases', file), 'utf8'));
}
const chainShas = (): string[] => readFileSync(join(DIR, 'chain.txt'), 'utf8').split('\n').filter(Boolean);
/** sha at a 1-based mining height. */
const heightSha = (n: number): string => chainShas()[n - 1];
/** Pinned trunk chain with 0-based heights (never re-reads live upstream). */
const pinnedChain = (): Chain => ({
  watermark: WATERMARK,
  base: BASE,
  heads: chainShas().map((sha, i) => ({ sha, height: i })),
});

// The whole suite is a no-op unless the pinned fork DAG is present.
const AVAILABLE = present(BASE) && present(WATERMARK) && chainShas().length === 98;

describe.skipIf(!AVAILABLE)('propagation real-DAG cases (mined 2026-07-18)', () => {
  // p7 — largest-clean-height / linear conflict profile (§3, class 7). VERIFIED.
  // The fork tip was rebased unreachable 2026-07-20 → pin-by-patch fallback.
  const P7_HEIGHTS = [1, 30, 61, 62, 80, 98];
  it('p7: entry-model sweep merges at height 61; the case run starts at 62 and stacks to the sparse-line top (D-049 §2)', () => {
    const c = loadCase('p7-conflict-profile-role-grant.yaml');
    // Chain commits it probes must be present (loud); the fork tip resolves via
    // the pinned sha or, once rebased away, the pin patch.
    const chainAnchors = Object.fromEntries(P7_HEIGHTS.map((h) => [`h${h}`, heightSha(h)]));
    if (!ensure('p7', { ...chainAnchors, watermark: WATERMARK })) return;
    const branch = resolveTip('p7', c.tip as string, c.pin_patch as string | undefined);
    if (!branch) return;
    // Endpoints + one mid clean (30) + one mid conflict (80) — enough to prove
    // "largest clean == 61, smallest conflict above == 62" without probing all 98.
    const line: EligibleLine = {
      branch,
      parent: 'main',
      model: 'entry',
      coverage: -1,
      heads: P7_HEIGHTS.map((h) => ({ sha: heightSha(h), height: h })),
    };
    // Sanity: chain.txt indexing matches the case's pinned SHAs.
    expect(heightSha(61)).toBe(c.expected.largest_clean_sha);
    expect(heightSha(62)).toBe(c.expected.smallest_conflicting_sha);

    return mergePointSweep(REPO, branch, line).then((res) => {
      expect(res.mergePoint).toEqual({ sha: c.expected.largest_clean_sha, height: c.expected.largest_clean_height });
      // D-049 §2 stacking: the real profile conflicts on the SAME single path
      // from 62 to the watermark, so on this sparse line the run stacks over
      // all three conflicting candidate heads (62, 80, 98; below the cap of 5)
      // and the case head is the run's TOP. The run still STARTS at the
      // smallest conflicting height above the merge point.
      expect(res.firstConflict?.run[0]).toEqual({
        sha: c.expected.smallest_conflicting_sha,
        height: c.expected.smallest_conflicting_height_above,
      });
      expect(res.firstConflict?.run.map((h) => h.height)).toEqual([62, 80, 98]);
      expect(res.firstConflict?.head.height).toBe(98);
      expect(res.firstConflict?.head.sha).toBe(heightSha(98));
      // Constant single-path profile: the top's conflict set is the case's.
      expect(res.firstConflict?.conflictedPaths).toEqual(c.expected.case_conflicted_paths);
    });
  });

  it('p7: derived coverage is 0 (mining) i.e. -1 (0-based) — no pending chain commit merged', async () => {
    const c = loadCase('p7-conflict-profile-role-grant.yaml');
    const branch = resolveTip('p7', c.tip as string, c.pin_patch as string | undefined);
    if (!branch) return;
    expect((await deriveCoverage(REPO, pinnedChain(), branch)).height).toBe(-1);
  });

  it('p7 (FALLBACK): pin-by-patch synthesis reproduces the sweep even ignoring the live tip', () => {
    const c = loadCase('p7-conflict-profile-role-grant.yaml');
    const abs = c.pin_patch ? join(DIR, c.pin_patch as string) : null;
    if (!abs || !existsSync(abs)) {
      console.warn('[propagation-cases] SKIP p7-fallback: no pin patch present');
      return;
    }
    const heights = [1, 61, 62, 98];
    if (!ensure('p7-fallback', Object.fromEntries(heights.map((h) => [`h${h}`, heightSha(h)])))) return;
    // FORCE the synthesis path (ignore c.tip) so the fallback cannot rot while
    // the live sha still happens to exist.
    const branch = synthesizePinnedTip(REPO, BASE, abs);
    const line: EligibleLine = {
      branch,
      parent: 'main',
      model: 'entry',
      coverage: -1,
      heads: heights.map((h) => ({ sha: heightSha(h), height: h })),
    };
    return mergePointSweep(REPO, branch, line).then((res) => {
      expect(res.mergePoint).toEqual({ sha: c.expected.largest_clean_sha, height: 61 });
      // D-049 §2: run starts at 62 and stacks over the sparse line's other
      // conflicting head (98, same single-path conflict set).
      expect(res.firstConflict?.run[0]).toEqual({ sha: c.expected.smallest_conflicting_sha, height: 62 });
      expect(res.firstConflict?.run.map((h) => h.height)).toEqual([62, 98]);
      expect(res.firstConflict?.head.height).toBe(98);
      expect(res.firstConflict?.conflictedPaths).toEqual(c.expected.case_conflicted_paths);
    });
  });

  // p2 — DEFERRED positive (§5, class 2). VERIFIED. Uses the NEW window rule.
  it('p2: child defers to its HELD ancestor (same window height + intersecting paths)', async () => {
    const c = loadCase('p2-deferred-positive-hostrpc-egress.yaml');
    const parentTip = c.parent.tip as string;
    const childTip = c.child.tip as string;
    const h1 = c.heights[1].sha as string;
    if (!ensure('p2', { parentTip, childTip, h1 })) return;

    // The inventory edge is a real git ancestry (child carries the parent delta).
    expect(await isAncestor(REPO, parentTip, childTip)).toBe(true);
    // Both first-conflict at height 1 on the identical path set.
    const childProbe = await newStyleMergeTree(REPO, childTip, h1);
    expect(childProbe.clean).toBe(false);
    expect(childProbe.conflictFiles).toEqual(c.child.conflicted_paths);

    // The DIRECT parent is HELD (blocked) at height 1; the child conflicts at
    // height 1 -> MIN(1) <= 1 -> DEFERRED (paths no longer matter, D-057).
    const d = checkDeferred(1, [{ branch: c.parent.branch, height: 1 }]);
    expect(d.deferred).toBe(true);
    expect(d.blockedBy).toBe(c.parent.branch);
  });

  // p3 — same-commit DISJOINT (§5 negative). NOT-FOUND as an ancestor pair;
  // pinned as the sibling negative-result shape.
  it('p3 (NEGATIVE pin): a disjoint same-commit sibling does NOT defer', async () => {
    const c = loadCase('p3-same-commit-disjoint-telegram-sibling.yaml');
    const telegramTip = c.closest_shape.branch_b.tip as string;
    const h1 = c.heights[1].sha as string;
    if (!ensure('p3', { telegramTip, h1 })) return;

    const probe = await newStyleMergeTree(REPO, telegramTip, h1);
    expect(probe.clean).toBe(false);
    // Disjoint from the module family's {src/cli/resources/groups.ts}.
    expect(probe.conflictFiles).not.toContain('src/cli/resources/groups.ts');

    // module/host-rpc is a SIBLING, not a DIRECT parent of the telegram branch,
    // so under the direct-parent rule (D-057) it contributes NO blocked parent —
    // NOT deferred (telegram's own independent conflict). It is parent-ness, not
    // path disjointness, that prevents the defer now.
    const d = checkDeferred(1, []);
    expect(d.deferred).toBe(false);
    expect(d.blockedBy).toBeNull();
  });

  // p4 — multi-parent, differing parent coverage (§2/§4, class 4). VERIFIED.
  it('p4: parents carry radically different coverage (container-queue 87 vs host-rpc none)', async () => {
    const c = loadCase('p4-multi-parent-mitm.yaml');
    const byBranch = new Map<string, any>(c.parents.map((p: any) => [p.branch, p]));
    const cq = byBranch.get('module/container-queue');
    const hostRpc = byBranch.get('module/host-rpc');
    if (!ensure('p4', { cqTip: cq.tip, hostRpcTip: hostRpc.tip })) return;
    const chain = pinnedChain();
    // container-queue merged upstream directly: mining coverage 88 -> 0-based 87.
    expect((await deriveCoverage(REPO, chain, cq.tip)).height).toBe(87);
    // host-rpc carries no pending-chain coverage: mining 0 -> 0-based -1.
    expect((await deriveCoverage(REPO, chain, hostRpc.tip)).height).toBe(-1);
  });

  it('p4: per-parent probe verdicts (no-op skip / clean real merge / conflict)', async () => {
    const c = loadCase('p4-multi-parent-mitm.yaml');
    const child = c.child.tip as string;
    const childTree = c.child.current_tree as string;
    const byBranch = new Map<string, any>(c.parents.map((p: any) => [p.branch, p]));
    const helpers = byBranch.get('module/interactions-helpers');
    const creds = byBranch.get('module/credentials');
    const cq = byBranch.get('module/container-queue');
    if (!ensure('p4', { child, helpersTip: helpers.tip, credsTip: creds.tip, cqTip: cq.tip })) return;
    // no-op skip: ancestor parent -> result tree == child tree.
    const noop = await newStyleMergeTree(REPO, child, helpers.tip);
    expect(noop.clean).toBe(true);
    expect(noop.treeOid).toBe(childTree);
    // clean REAL merge: exit 0 but a DIFFERENT tree (skip detection needs trees).
    const clean = await newStyleMergeTree(REPO, child, creds.tip);
    expect(clean.clean).toBe(true);
    expect(clean.treeOid).toBe(creds.result_tree);
    expect(clean.treeOid).not.toBe(childTree);
    // upstream-carrying conflict.
    const conflict = await newStyleMergeTree(REPO, child, cq.tip);
    expect(conflict.clean).toBe(false);
  });

  // p5 — no-op skip (§6, class 5). VERIFIED. Compare TREES, not exit codes.
  it('p5: merge-tree result tree equals the recorded no-op trees', async () => {
    const c = loadCase('p5-noop-skip-mitm-interactions-helpers.yaml');
    if (!ensure('p5', { parentTip: c.parent.tip, childTip: c.child.tip })) return;
    const noop = await newStyleMergeTree(REPO, c.child.tip, c.parent.tip);
    expect(noop.clean).toBe(true);
    expect(noop.treeOid).toBe(c.result_tree);
    expect(c.result_tree).toBe(c.current_tree);
    // Additional verified no-op instances.
    for (const inst of c.additional_verified_instances as any[]) {
      const parentTip = (inst.parent as string).split(' ')[1].replace(/[()]/g, '');
      const childTip = (inst.child as string).split(' ')[1].replace(/[()]/g, '');
      if (!ensure('p5-additional', { parentTip, childTip })) continue;
      const probe = await newStyleMergeTree(REPO, childTip, parentTip);
      expect(probe.treeOid).toBe(inst.result_tree);
    }
  });

  // p6 — clean-through-held (§1 D-002, class 6). VERIFIED.
  it('p6: clean-through branches merge the whole range clean (stable result trees)', async () => {
    const c = loadCase('p6-clean-through-held-docs-notes.yaml');
    for (const b of c.clean_branches as any[]) {
      if (!ensure(`p6:${b.branch}`, { tip: b.tip, watermark: WATERMARK })) continue;
      const probe = await newStyleMergeTree(REPO, b.tip, WATERMARK);
      expect(probe.clean).toBe(true);
      expect(probe.treeOid).toBe(b.result_tree);
    }
  });

  // p1 — non-monotonic window (§3, class 1). NOT-FOUND; branch-tip advancement
  // is the only "conflicted historically, clean today" shape (staleness hazard).
  it('p1 (NEGATIVE pin): old tip conflicts at h1, current tip is clean there', async () => {
    const c = loadCase('p1-nonmonotonic-window-notfound.yaml');
    const oldTip = c.closest_shape.old_tip.sha as string;
    const curTip = c.closest_shape.current_tip.sha as string;
    const h1 = c.heights[1].sha as string;
    if (!ensure('p1', { oldTip, curTip, h1 })) return;
    const oldProbe = await newStyleMergeTree(REPO, oldTip, h1);
    expect(oldProbe.clean).toBe(false);
    expect(oldProbe.conflictFiles).toContain('src/cli/resources/groups.ts');
    const curProbe = await newStyleMergeTree(REPO, curTip, h1);
    expect(curProbe.clean).toBe(true); // current tip cleared the h1 conflict (staleness hazard)
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
