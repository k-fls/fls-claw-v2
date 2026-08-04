/**
 * scripts/sweep/types.ts — shared types for the upstream-sweep toolkit.
 *
 * The driver keeps NO durable local state: everything a pass produces lives in
 * the pass dir, and everything about origin is re-derived from origin. (A
 * group-owned `sweep-ledger.json` existed until 2026-08-04; it was deleted after
 * a 12-day-old copy was read back by a fresh session and reported as the current
 * sweep state while an open pass sat beside it.)
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

/** Pipeline classification (spec D-002): annotate = merge proceeds, gate = stops the branch. */
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
  /** Capped diff text for symbol_watch routing (filled by the route stage). */
  diffText?: string;
  /** Basenames of newly added files (symbol_watch routing input). */
  newBasenames?: string[];
}

/** How a branch participates in the sweep (2026-07-14 merge-source correction). */
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
   * D-045 (PROPAGATION.md §13): the branch has no local ref but exists as
   * `origin/<branch>` — in scope, planned from the origin commit; `run
   * --execute` creates the local branch at the origin tip before its first
   * mutation. Absent/false for locally-present branches.
   */
  materialize?: boolean;
}

/**
 * Per-branch merge status. D-058 RETIRED this as stored state for the
 * propagation driver: blockedness is DERIVED — cross-pass from the origin
 * fix/sweep refs at `sweep start` (an unmerged ref WITH an open PR ⇔ PR_ID),
 * within a pass from the journal (origin-blocked/held/defer rows); DEFERRED
 * is recomputed from the parents' PR_ID during derivation, never stored. The
 * three-state model and the invariant blocked(X) ⇔ merge_status(X) != NONE
 * (D-057) survive as the DERIVED view's semantics. This type
 * field remain ONLY as a non-authoritative legacy cache read by the old sweep
 * merge stage (merge.ts) — the propagation driver never reads or writes it.
 */
export type MergeStatus =
  | {
      state: 'PR_ID';
      /** The case that blocked the branch ('gate' for a §9 verify rollback hold). */
      caseId: string;
      /**
       * The conflicting head sha at hold time (null for gate holds). Dual duty:
       * the block height is re-derived from it against each pass's chain, and
       * completion = the branch tip contains it (the owner's PR merge landed).
       */
      headSha: string | null;
      /** Freeze-PR head branch on origin (urge comments target its PR). */
      fixBranch: string | null;
      /** Freeze-PR number on GitHub (urge posting + D-004 machine-block target). */
      prNumber: number | null;
    }
  | { state: 'DEFERRED' };

/** Inventory entry <id>.yaml (feature-inventory design §3; --inventory dir). */
export interface FeatureEntry {
  id: string;
  name: string;
  kind: 'module' | 'feat' | 'edition' | 'fix' | 'planned';
  status: 'planned' | 'in-progress' | 'shipped' | 'experimental' | 'absorbed' | 'retired';
  branch?: string;
  parents?: string[];
  dependents?: string[];
  summary?: string;
  owned_paths?: string[];
  touch_paths?: string[];
  key_symbols?: string[];
  symbol_watch?: string[];
  invariants?: string[];
  design_docs?: string[];
  test_anchors?: string[];
  overlap_hints?: string;
  /** Per-feature scope-guard override (§7 lever); beats the global default. */
  scope_guard?: ScopeGuardMode;
  /** Per-feature case-stacking cap override (D-049 §2 lever); beats routing.yaml `stack_cap`. */
  stack_cap?: number;
  routing?: { keywords?: string[]; always_check_on?: string[] };
  /**
   * `extra_context` carries recorded owner decisions (D-030 write-back);
   * `decided_paths` (D-048) optionally pins the paths a recorded decision
   * governs — `propagate publish` blocks (ERR05_DECIDED_ALREADY) a PR whose
   * conflicted paths hit either the explicit list or a path mentioned in the
   * `extra_context` text (PROPAGATION.md §14).
   */
  prompt?: { template?: string; extra_context?: string; decided_paths?: string[] };
  maintenance?: { owner?: string; last_verified?: string; verified_against?: string; notes?: string };
}

/** scripts/sweep/registry/routing.yaml — the two global driver levers. */
export interface RoutingConfig {
  /** Global default scope-guard mode (§7 lever); per-feature `scope_guard` overrides. */
  scopeGuardMode?: ScopeGuardMode;
  /** Global case-stacking cap (D-049 §2, `stack_cap`); per-feature `stack_cap` overrides. */
  stackCap?: number;
}

/**
 * Scope-guard mode (§7 lever, owner 2026-07-20). `same-files` (default): the
 * resolution may touch only the recomputed conflicted FILES. `conflict-hunks`
 * (strict, opt-in): within those files, changed line regions must lie inside
 * the automerge tree's conflict-marker regions.
 */
export type ScopeGuardMode = 'same-files' | 'conflict-hunks';

/**
 * scripts/sweep/registry/scope.yaml — committed scope POLICY (exclusions are
 * config, not state). Scope = inventory branches + main_patched (structural)
 * + non-inventory branches whose tip is an ancestor of any edition/* branch
 * (owner rule 2026-07-14: "agent ignores non-inventory branches, unless they
 * are present in any edition branch"). No include-glob mechanism anymore.
 */
export interface SweepScope {
  exclude?: string[];
  /** child -> parents edges not expressible in the registry (e.g. main_patched roots). */
  extra_edges?: Record<string, string[]>;
  /** Ordered branch list for the everything rebuild (verify stage). */
  recipe?: string[];
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
// Mechanical propagation driver (PROPAGATION.md, D-035..D-040). New flat
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
 * Tier ladder (§1, D-035). `deferred` is off-ladder (a conflict that belongs to
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
 * Reported conflict handed to the resolving agent (§3 step 4). The case unit is
 * a STACKED RUN (D-049 §2): the maximal run of consecutive conflicting heights
 * whose conflicted path sets intersect, capped (`stack_cap`). `head` is the
 * run's TOP commit — merging it resolves the whole run in one case/cold read;
 * DEFERRED windows and urge tracking are computed against it.
 */
export interface ConflictCase {
  /** The run's TOP head: sha is the commit to merge, height its trunk index. */
  head: Head;
  /** The stacked run, ascending by height; run[run.length - 1] === head. */
  run: Head[];
  /** Conflicted paths at the run TOP (the cumulative conflict set). */
  conflictedPaths: string[];
  /** Tree oid of the conflicted automerge (conflict markers), from new-style merge-tree. */
  automergeTree: string;
  reproduction: { command: string };
}

/** One parent's contribution to a branch's pass (`plan.json`). */
export interface ParentPlan {
  parent: string;
  model: 'entry' | 'parents';
  /** Chosen merge point = largest clean head (§3); null when even the oldest head conflicts. */
  mergePoint: Head | null;
  verdict: ParentVerdict;
  /** Reported conflict above the merge point (the smallest conflicting height). */
  case: ConflictCase | null;
  /** DEFERRED: the lowest blocked DIRECT parent this conflict defers behind (D-057). */
  deferredTo: string | null;
  /** DEFERRED: the height of X's own conflict (the run TOP) — the block-height this
   * branch contributes to its children's height-MIN when it is itself deferred (D-057). */
  deferHeight?: number;
  /** No-op reason when verdict is skip. */
  skipReason: string | null;
  /** Forced (empty) merge to honour the leaf/always_merge rule (§6). */
  forced?: boolean;
  /**
   * Annotate-class flag (§1, D-002): a CLEAN merge whose merged range passes
   * THROUGH a height at which a transitive ancestor is HELD. Never gates — the
   * pass report surfaces it. `null` unless it applies.
   */
  annotate?: { heldAncestor: string; height: number } | null;
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
  /** Effective case-stacking cap for this branch (D-049 §2 lever, resolved at derivation). */
  stackCap?: number;
  parents: ParentPlan[];
  /** Cheapest parent chain un-skipped to keep the leaf/always_merge invariant (§6). */
  unskipChain?: string[];
  /**
   * D-045 (§13): remote-only branch — probes/coverage in this plan read the
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
  /** Legal inventory parents (or `main` for entry/D-032b branches). */
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
  /** The case run's TOP head (D-049 §2). */
  head: Head;
  /** The stacked run (ascending). Optional only for pre-D-049 case files. */
  run?: Head[];
  tierFloor: Tier;
  conflictedPaths: string[];
  automergeTree: string;
  reproduction: { command: string };
  /** DEFERRED-check inputs (§5); firstConflictHeight = the run's TOP height. */
  deferredCheck: { firstConflictHeight: number; transitiveAncestors: string[] };
}

/** A HELD branch's registry record used for DEFERRED matching (§5). */
export interface HeldRecord {
  branch: string;
  height: number;
  conflictedPaths: string[];
  caseId: string;
}
