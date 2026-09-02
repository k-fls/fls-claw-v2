/**
 * scripts/sweep/types.ts — shared types for the upstream-sweep toolkit.
 *
 * The driver keeps NO durable local state: everything a pass produces lives in
 * the pass dir, and everything about origin is re-derived from origin.
 */

/** PoI routing classes (feature-inventory design §4) plus pipeline extensions. */
export type PoiType =
  | 'new-top-level-dir'
  | 'new-skill'
  | 'large-new-file'
  | 'sensitive-surface-touch'
  | 'dep-change'
  | 'merge-conflict'
  | 'rerere-replay'
  | 'test-fail'
  | 'generic-diff';

/** Pipeline classification (DRIVER.md §8.1): annotate = merge proceeds, gate = stops the branch. */
export type PoiClass = 'annotate' | 'gate';

export interface Poi {
  id: string;
  class: PoiClass;
  type: PoiType;
  /** Paths involved (changed/conflicted files). */
  paths: string[];
  /** Upstream first-parent commits that introduced the change. */
  upstreamCommits: string[];
  /** Commit subjects, for keyword routing. */
  commitSubjects: string[];
  /** Affected fork branches (conflict/gate PoIs). */
  branches: string[];
  /** Free-text detail (e.g. file size, sensitive rule hit). */
  detail?: string;
  /** Capped diff text for keyword routing (filled by the route stage). */
  diffText?: string;
  /** Basenames of newly added files (routing input). */
  newBasenames?: string[];
}

/** How a branch participates in the sweep. */
export type ScopeKind = 'structural' | 'inventory' | 'edition-ancestor';

/**
 * Merge model per branch: only main (ff) and `upstream-chain` branches
 * (main_patched + edition-ancestor upstream-PR candidates) touch upstream
 * directly; every inventory branch merges its DAG `parents` tips instead —
 * conflicts resolve once at the topmost affected branch, descendants inherit
 * via parent merges.
 */
export type MergeModel = 'upstream-chain' | 'parents';

export interface ScopeEntry {
  branch: string;
  kind: ScopeKind;
  mergeModel: MergeModel;
  /** DAG parents (merge sources) for mergeModel 'parents'; empty otherwise. */
  parents: string[];
  /**
   * DRIVER.md §4.7: the branch has no local ref but exists as
   * `origin/<branch>` — in scope, planned from the origin commit; `run
   * --execute` creates the local branch at the origin tip before its first
   * mutation. Absent/false for locally-present branches.
   */
  materialize?: boolean;
}

/**
 * Inventory entry <id>.yaml (scripts/sweep/inventory/, config tracked in the
 * fork repo). The inventory is CONFIGURATION ONLY — owner-authored
 * declarations of intent, never written by the driver. An entry with a
 * `branch` is swept; one without is planned/observational. Removing a feature
 * = deleting its entry. `parseFeatureEntry` (registry.ts) enforces this
 * schema STRICTLY — an unknown key is an entry error, and `sweep start`
 * fails hard on entry errors.
 */
export interface FeatureEntry {
  id: string;
  name: string;
  kind: 'module' | 'feat' | 'edition' | 'fix' | 'planned';
  branch?: string;
  parents?: string[];
  dependents?: string[];
  summary?: string;
  owned_paths?: string[];
  key_symbols?: string[];
  design_docs?: string[];
  test_anchors?: string[];
  /** Per-feature scope-guard override (§7 lever); beats the global default. */
  scope_guard?: ScopeGuardMode;
  /** Tier floor (§1): 'judged' floors every merge of this branch at JUDGED. */
  tier_floor?: 'judged';
  /** Leaf/always_merge rule (§6): force an (empty) merge even when parents no-op. */
  always_merge?: boolean;
  routing?: { keywords?: string[]; always_check_on?: string[] };
}

/** scripts/sweep/registry/routing.yaml — the global driver lever. */
export interface RoutingConfig {
  /** Global default scope-guard mode (§7 lever); per-feature `scope_guard` overrides. */
  scopeGuardMode?: ScopeGuardMode;
}

/**
 * Scope-guard mode (§7 lever). `same-files` (default): the
 * resolution may touch only the recomputed conflicted FILES. `conflict-hunks`
 * (strict, opt-in): within those files, changed line regions must lie inside
 * the automerge tree's conflict-marker regions.
 */
export type ScopeGuardMode = 'same-files' | 'conflict-hunks';

/**
 * scripts/sweep/registry/scope.yaml — committed scope POLICY (exclusions are
 * config, not state). Scope = inventory branches + main_patched (structural)
 * + non-inventory branches whose tip is an ancestor of any edition/* branch
 * (the standing scope rule: "agent ignores non-inventory branches, unless
 * they are present in any edition branch"). There is no include-glob
 * mechanism: inclusion is derived from the inventory and the edition
 * composition; only exclusions are globs.
 */
export interface SweepScope {
  exclude?: string[];
  /** child -> parents edges not expressible in the registry (e.g. main_patched roots). */
  extra_edges?: Record<string, string[]>;
}

export interface ValidationIssue {
  level: 'ALERT' | 'WARN';
  featureId: string | null;
  rule: number;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** Entries with at least one ALERT — routing fails closed for these. */
  alertedFeatureIds: string[];
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Mechanical propagation driver (DRIVER.md §12.1). Flat
// modules: heights / interval / tiers / plan / deferred / scope-guard / steps /
// propagate. These are the shared data-model + JSON artifact schemas; the
// per-module computational result types stay local to their modules.
// ---------------------------------------------------------------------------

/**
 * A merge head: a `{sha, height}` pair. `height` is an index into the pinned
 * trunk first-parent chain (§2). For entry-point branches the sha IS a trunk
 * commit at that index; for parents-model branches the sha is a parent-branch
 * commit whose DERIVED coverage equals `height` (§4). All barrier / DEFERRED /
 * merge-point comparisons use `height`; the sha is an integrity check.
 */
export interface Head {
  sha: string;
  height: number;
}

/**
 * Tier ladder (§1). `deferred` is off-ladder (a conflict that belongs to
 * a HELD ancestor). Ladder severity: clean < mechanical < judged < held.
 */
export type Tier = 'clean' | 'mechanical' | 'judged' | 'held' | 'deferred';

/**
 * Per-parent verdict inside a branch plan:
 *  - `up-to-date`: nothing above the branch's coverage to merge.
 *  - `merge`: a clean merge lands (up to the merge point); a `case` may still be
 *    attached for the conflict above it.
 *  - `skip`: no-op (merge-tree result tree == branch tree).
 *  - `case`: an own conflict is pending judgment and no clean prefix merges now.
 *  - `defer`: DEFERRED to a HELD ancestor (frozen, NO PR — §5).
 */
export type ParentVerdict = 'merge' | 'skip' | 'defer' | 'up-to-date' | 'case';

/**
 * Reported conflict handed to the resolving agent (§3 step 4). The case is
 * EXACTLY ONE COMMIT (DRIVER.md §4.4): the walk's stop — the first candidate
 * whose in-surface conflict the driver cannot resolve itself. DEFERRED windows
 * and urge tracking are computed against it. Nothing above the stop belongs to
 * the case: it was never probed in combination with what the branch is taking,
 * so it stays out of the branch and out of the fix ref.
 */
export interface ConflictCase {
  /** The stop commit: sha is the commit to merge, height its trunk projection. */
  head: Head;
  /** The unresolved IN-SURFACE conflicted paths — the case's whole question. */
  conflictedPaths: string[];
  /**
   * The exhibit tree: the automerge with every auto-resolvable member already
   * resolved, so conflict markers exist ONLY at `conflictedPaths`.
   */
  automergeTree: string;
  reproduction: { command: string };
}

/** One landed step of a walk prefix, as a step file records it (steps.ts). */
export interface WalkPrefixStep {
  sha: string;
  /** Conflicted paths the step resolved itself (sorted; empty on a clean step). */
  autoResolved: string[];
}

/** One parent's contribution to a branch's pass (`plan.json`). */
export interface ParentPlan {
  parent: string;
  model: 'entry' | 'parents';
  /** The landed prefix's TOP candidate (§3); null when nothing lands. */
  mergePoint: Head | null;
  /** The landed walk prefix, in walk order (verdict `merge`). */
  prefix?: WalkPrefixStep[];
  /** The tree the prefix lands (reconciliation applied) — the merge commit's tree. */
  landTree?: string;
  verdict: ParentVerdict;
  /** Reported conflict at the walk's stop (the commit above the landed prefix). */
  case: ConflictCase | null;
  /** DEFERRED: the lowest blocked DIRECT parent this conflict defers behind. */
  deferredTo: string | null;
  /** DEFERRED: the height of X's own conflict (the walk's stop) — the block-height
   * this branch contributes to its children's height-MIN when it is itself deferred. */
  deferHeight?: number;
  /** No-op reason when verdict is skip. */
  skipReason: string | null;
  /** Forced (empty) merge to honour the leaf/always_merge rule (§6). */
  forced?: boolean;
}

/** A branch's whole-pass plan row (`plan.json`). */
export interface BranchPlan {
  branch: string;
  kind: ScopeKind;
  tierFloor: Tier;
  isLeaf: boolean;
  alwaysMerge: boolean;
  /** Transitive inventory ancestors (for DEFERRED matching). */
  ancestors: string[];
  parents: ParentPlan[];
  /** Cheapest parent chain un-skipped to keep the leaf/always_merge invariant (§6). */
  unskipChain?: string[];
  /**
   * §13: remote-only branch — probes/coverage in this plan read the
   * `origin/<branch>` commit; `run --execute` materializes the local ref
   * before the branch's first mutation. `plan` and dry-run `run` never write refs.
   */
  materialize?: boolean;
}

/** Whole-pass plan artifact (`plan.json`) — pure derivation, idempotent (§7). */
export interface PropagationPlan {
  schemaVersion: 1;
  watermark: string;
  watermark12: string;
  forkPoint: string | null;
  chainLength: number;
  order: string[];
  branches: BranchPlan[];
  warnings: string[];
}

/** One parent-merge inside a per-branch step contract. */
export interface StepMerge {
  parent: string;
  model: 'entry' | 'parents';
  action: 'merge' | 'skip';
  head: Head | null;
  /** The landed walk prefix (non-forced merges); the verifier replays it. */
  prefix?: WalkPrefixStep[];
  /** The tree the prefix lands — what the merge commit will carry. */
  tree?: string;
  skipReason: string | null;
  /** Forced (empty) merge for the leaf/always_merge rule (§6). */
  forced?: boolean;
}

/**
 * Per-branch merge contract (`step-<branch>.json`). The executor re-verifies
 * every field from first principles (§7, steps.ts) — it never trusts the author.
 */
export interface StepFile {
  schemaVersion: 1;
  branch: string;
  watermark: string;
  /** Legal inventory parents (or `main` for entry-point branches). */
  legalParents: string[];
  /** Inventory parents that must have arrived this pass (journal barrier). */
  requiredParents: string[];
  isLeaf: boolean;
  alwaysMerge: boolean;
  merges: StepMerge[];
}

/** Reported-conflict contract (`case-<branch>-<height>.json`). */
export interface CaseFile {
  schemaVersion: 1;
  id: string;
  branch: string;
  parent: string;
  /** The stop commit (DRIVER.md §4.4) — the single commit the case is about. */
  head: Head;
  tierFloor: Tier;
  conflictedPaths: string[];
  /**
   * Paths a PUBLISHED resolution reached beyond its conflict set, re-seeded so a
   * revision holds the whole of what it is revising (§5.3).
   *
   * Kept OUT of `conflictedPaths` deliberately: that field is the conflict
   * itself and the staleness check recomputes it (`ERR02_CASE_STALE`), so a path
   * that is pending-but-not-conflicting there reads as the case having drifted.
   * Pending and in scope, not conflicted.
   */
  carriedPaths?: string[];
  automergeTree: string;
  reproduction: { command: string };
  /** DEFERRED-check inputs (§5); firstConflictHeight = the stop commit's height. */
  deferredCheck: { firstConflictHeight: number; transitiveAncestors: string[] };
}

/**
 * THE BOTTOM OF THE CUT LATTICE: a branch under repair says "this branch is
 * red", not "red above height k", so it has no clean prefix to hand down and
 * nothing from it is eligible for anything below it. The same value covers a
 * block nobody could measure — an unmeasurable block is a total one, not an
 * absent one. It compares below every real height, so a freeze needs no special
 * case anywhere a cut is applied.
 */
export const WHOLE_RANGE_BLOCK = Number.NEGATIVE_INFINITY;

/** A blocked branch's cut, used for the eligible-line trim and DEFERRED matching (§5). */
export interface HeldRecord {
  branch: string;
  /** The cut coordinate, or `WHOLE_RANGE_BLOCK` for a branch under repair. */
  height: number;
  conflictedPaths: string[];
  caseId: string;
}
