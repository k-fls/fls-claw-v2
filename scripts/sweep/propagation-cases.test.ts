/**
 * scripts/sweep/propagation-cases.test.ts — real-DAG regression anchors for the
 * propagation driver, mined from the fork + upstream (test-cases/propagation/).
 *
 * These run against the REAL repository the tests execute in. Every case is
 * guarded by a resolvability check (git cat-file -e on the pinned SHAs) and
 * SKIPS cleanly when the objects are absent, so fixtures-only environments stay
 * green. Assertions use the PINNED chain (chain.txt) rather than live
 * `upstream/main`, so they stay stable if upstream advances.
 *
 * Height convention: chain.txt line N == mining height N (1-based). For coverage
 * we build a Chain with 0-based `height` indices (the code's convention), so a
 * mining coverage of K maps to a derived 0-based height of K-1 (-1 == none).
 * For the p7 merge-point sweep we label heads with the 1-based mining heights so
 * the assertions read 61/62 exactly as the case file records them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { checkDeferred } from './deferred.js';
import { isAncestor, newStyleMergeTree } from './git.js';
import { deriveCoverage, type Chain } from './heights.js';
import { mergePointSweep, type EligibleLine } from './interval.js';
import type { HeldRecord } from './types.js';

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
function have(...shas: string[]): boolean {
  return shas.every(present);
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
  it('p7: entry-model sweep merges at height 61, reports the height-62 conflict', () => {
    const c = loadCase('p7-conflict-profile-role-grant.yaml');
    const branch = c.tip as string; // fix/main/role-grant-scope-clarity tip
    if (!have(branch, WATERMARK)) return;
    // Endpoints + one mid clean (30) + one mid conflict (80) — enough to prove
    // "largest clean == 61, smallest conflict above == 62" without probing all 98.
    const labelHeights = [1, 30, 61, 62, 80, 98];
    const line: EligibleLine = {
      branch,
      parent: 'main',
      model: 'entry',
      coverage: -1,
      heads: labelHeights.map((h) => ({ sha: heightSha(h), height: h })),
    };
    // Sanity: chain.txt indexing matches the case's pinned SHAs.
    expect(heightSha(61)).toBe(c.expected.largest_clean_sha);
    expect(heightSha(62)).toBe(c.expected.smallest_conflicting_sha);

    return mergePointSweep(REPO, branch, line).then((res) => {
      expect(res.mergePoint).toEqual({ sha: c.expected.largest_clean_sha, height: c.expected.largest_clean_height });
      expect(res.firstConflict?.head.height).toBe(c.expected.smallest_conflicting_height_above);
      expect(res.firstConflict?.head.sha).toBe(c.expected.smallest_conflicting_sha);
      expect(res.firstConflict?.conflictedPaths).toEqual(c.expected.case_conflicted_paths);
    });
  });

  it('p7: derived coverage is 0 (mining) i.e. -1 (0-based) — no pending chain commit merged', async () => {
    const c = loadCase('p7-conflict-profile-role-grant.yaml');
    if (!have(c.tip)) return;
    expect((await deriveCoverage(REPO, pinnedChain(), c.tip)).height).toBe(-1);
  });

  // p2 — DEFERRED positive (§5, class 2). VERIFIED. Uses the NEW window rule.
  it('p2: child defers to its HELD ancestor (same window height + intersecting paths)', async () => {
    const c = loadCase('p2-deferred-positive-hostrpc-egress.yaml');
    const parentTip = c.parent.tip as string;
    const childTip = c.child.tip as string;
    const h1 = c.heights[1].sha as string;
    if (!have(parentTip, childTip, h1)) return;

    // The inventory edge is a real git ancestry (child carries the parent delta).
    expect(await isAncestor(REPO, parentTip, childTip)).toBe(true);
    // Both first-conflict at height 1 on the identical path set.
    const childProbe = await newStyleMergeTree(REPO, childTip, h1);
    expect(childProbe.clean).toBe(false);
    expect(childProbe.conflictFiles).toEqual(c.child.conflicted_paths);

    // The parent is HELD at height 1 on S_P; the child conflicts at N'=1 with
    // floor 0 (coverage 0). Window (0, 1] contains 1 -> DEFERRED (intersecting).
    const held: HeldRecord[] = [
      { branch: c.parent.branch, height: 1, conflictedPaths: c.parent.conflicted_paths, caseId: 'p2' },
    ];
    const d = checkDeferred(1, 0, childProbe.conflictFiles, [c.parent.branch], held);
    expect(d.deferred).toBe(true);
    expect(d.ancestor?.branch).toBe(c.parent.branch);
  });

  // p3 — same-commit DISJOINT (§5 negative). NOT-FOUND as an ancestor pair;
  // pinned as the sibling negative-result shape.
  it('p3 (NEGATIVE pin): a disjoint same-commit sibling does NOT defer', async () => {
    const c = loadCase('p3-same-commit-disjoint-telegram-sibling.yaml');
    const telegramTip = c.closest_shape.branch_b.tip as string;
    const h1 = c.heights[1].sha as string;
    if (!have(telegramTip, h1)) return;

    const probe = await newStyleMergeTree(REPO, telegramTip, h1);
    expect(probe.clean).toBe(false);
    // Disjoint from the module family's {src/cli/resources/groups.ts}.
    expect(probe.conflictFiles).not.toContain('src/cli/resources/groups.ts');

    // Synthesize the ancestor HELD state (host-rpc @ h1 on groups.ts); the
    // telegram probe shares the height but has DISJOINT paths -> NOT deferred.
    const held: HeldRecord[] = [
      { branch: 'module/host-rpc', height: 1, conflictedPaths: ['src/cli/resources/groups.ts'], caseId: 'p3' },
    ];
    const d = checkDeferred(1, 0, probe.conflictFiles, ['module/host-rpc'], held);
    expect(d.deferred).toBe(false);
  });

  // p4 — multi-parent, differing parent coverage (§2/§4, class 4). VERIFIED.
  it('p4: parents carry radically different coverage (container-queue 87 vs host-rpc none)', async () => {
    const c = loadCase('p4-multi-parent-mitm.yaml');
    const byBranch = new Map<string, any>(c.parents.map((p: any) => [p.branch, p]));
    const cq = byBranch.get('module/container-queue');
    const hostRpc = byBranch.get('module/host-rpc');
    if (!have(cq.tip, hostRpc.tip)) return;
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
    if (!have(child, helpers.tip, creds.tip, cq.tip)) return;
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
    if (!have(c.parent.tip, c.child.tip)) return;
    const noop = await newStyleMergeTree(REPO, c.child.tip, c.parent.tip);
    expect(noop.clean).toBe(true);
    expect(noop.treeOid).toBe(c.result_tree);
    expect(c.result_tree).toBe(c.current_tree);
    // Additional verified no-op instances.
    for (const inst of c.additional_verified_instances as any[]) {
      const parentTip = (inst.parent as string).split(' ')[1].replace(/[()]/g, '');
      const childTip = (inst.child as string).split(' ')[1].replace(/[()]/g, '');
      if (!have(parentTip, childTip)) continue;
      const probe = await newStyleMergeTree(REPO, childTip, parentTip);
      expect(probe.treeOid).toBe(inst.result_tree);
    }
  });

  // p6 — clean-through-held (§1 D-002, class 6). VERIFIED.
  it('p6: clean-through branches merge the whole range clean (stable result trees)', async () => {
    const c = loadCase('p6-clean-through-held-docs-notes.yaml');
    for (const b of c.clean_branches as any[]) {
      if (!have(b.tip, WATERMARK)) continue;
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
    if (!have(oldTip, curTip, h1)) return;
    const oldProbe = await newStyleMergeTree(REPO, oldTip, h1);
    expect(oldProbe.clean).toBe(false);
    expect(oldProbe.conflictFiles).toContain('src/cli/resources/groups.ts');
    const curProbe = await newStyleMergeTree(REPO, curTip, h1);
    expect(curProbe.clean).toBe(true); // current tip cleared the h1 conflict (staleness hazard)
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
