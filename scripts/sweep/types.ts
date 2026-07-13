/**
 * scripts/sweep/types.ts — shared types for the upstream-sweep toolkit.
 *
 * Boundary artifact between the scripted core and the agentic layer is the
 * sweep report (SweepReport); mutable state is the group-owned Ledger file
 * (no state branch — dissolved 2026-07-10).
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
}

export interface BranchScan {
  branch: string;
  kind: ScopeKind;
  mergeModel: MergeModel;
  parents: string[];
  /** true when merge-tree vs the branch's ACTUAL merge source(s) produced no conflicts. */
  clean: boolean;
  /** Conflicts vs the actual merge source(s) — what the merge stage will hit. */
  conflictFiles: string[];
  /** Largest clean first-parent upstream commit to merge (upstream-chain model only). */
  stopPoint: string | null;
  /** Merge source(s) already reachable from the branch (nothing to do). */
  upToDate: boolean;
  /** Informational upstream/main forecast for parents-model branches (cheap merge-tree). */
  upstreamInfo?: { clean: boolean; conflictFiles: string[] };
}

export interface SweepReport {
  schemaVersion: 1;
  generatedAt: string;
  repo: string;
  upstreamRef: string;
  upstreamTip: string;
  /** Base of the PoI-extraction range (exclusive). */
  rangeBase: string;
  branches: Record<string, BranchScan>;
  /** Non-inventory branches ignored by the scope rule (digest drift line only). */
  ignoredBranches: string[];
  pois: Poi[];
  warnings: string[];
}

/**
 * Group-owned ledger branch override. Absence of an entry = active.
 * lastMergedUpstream is NOT stored — it is derived as
 * `git merge-base <branch> upstream/main` (see ledger.derivedLastMerged).
 */
export interface LedgerBranch {
  status: 'active' | 'frozen' | 'excluded';
  frozenBy: string | null;
  pendingBehindFreeze: number;
  notes: string;
}

/**
 * The group-owned ledger file (--ledger, default <workspace>/sweep-ledger.json):
 * freeze/exclude overrides, open PoIs, last-sweep record. Plain JSON in the
 * group workspace — no state branch exists (dissolved 2026-07-10).
 */
export interface Ledger {
  schemaVersion: 1;
  lastSweep: { id: string; upstreamTip: string; result: 'clean' | 'partial' | 'blocked' } | null;
  branches: Record<string, LedgerBranch>;
  openPois: Array<
    Pick<Poi, 'id' | 'class' | 'type' | 'paths' | 'branches' | 'upstreamCommits'> & {
      state: 'open' | 'reported' | 'resolved';
      pr: string | null;
    }
  >;
}

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
  routing?: { keywords?: string[]; always_check_on?: string[] };
  prompt?: { template?: string; extra_context?: string };
  maintenance?: { owner?: string; last_verified?: string; verified_against?: string; notes?: string };
}

/** scripts/sweep/registry/routing.yaml. */
export interface RoutingConfig {
  weights: { owned: number; touch: number; symbol: number; keyword: number };
  threshold: number;
  top_k: number;
  /** PoI classes that ALWAYS also go to catch-all, even when entries matched. */
  catchAllAlwaysInclude?: string[];
  /** Scan tuning carried in routing.yaml (single-knob new-file threshold). */
  largeNewFileKb?: number;
  sensitiveSurfaces?: string[];
}

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

export interface RouteResult {
  poiId: string;
  featureId: string;
  score: number;
  components: { owned: number; touch: number; symbol: number; keyword: number; forced: boolean };
}

export interface RoutingOutcome {
  routes: RouteResult[];
  /** PoI ids that matched nothing above threshold (or only ALERTed entries). */
  catchAll: string[];
  /** featureId -> poiIds batched for one subagent invocation per (feature, sweep). */
  byFeature: Record<string, string[]>;
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

/** fork-registry/test-cases/*.yaml (replay harness). */
export interface ReplayCase {
  id: string;
  taxonomy: string;
  /** May carry prose ("branch (pre-sweep tip, tag ...)"); fork_base_commit is the real pin. */
  fork_branch: string;
  fork_base_commit: string;
  /** "<base>..<tip>" or { from, to } — refs resolvable in the repo. Absent for propagation cases. */
  upstream_range?: string | { from: string; to: string };
  /** Fork-internal propagation case: merge this ref into fork_base_commit instead of an upstream range. */
  merge_source?: string;
  /** Commit whose tree carries the canonical resolution (rerere seeding via `seed-rerere`). */
  resolution_ref?: string;
  expected: {
    /**
     * Mechanical labels: clean | conflict | up-to-date. Registry-taxonomy
     * labels are normalized (see replay.ts CLASSIFICATION_ALIASES);
     * 'excluded' cases are skipped (policy, not mechanics).
     */
    classification: string;
    conflicts?: string[];
    /**
     * Subset assertions: each object must match an actual PoI by type
     * (+ path containment). Plain strings are prose notes and are ignored.
     */
    pois?: Array<{ type: PoiType; paths?: string[] } | string>;
    stop_point?: string | null;
  };
}

export interface ReplayResult {
  caseId: string;
  pass: boolean;
  /** Case not mechanically replayable (e.g. expected classification 'excluded'). */
  skipped?: boolean;
  failures: string[];
  actual: { classification: string; conflicts: string[]; poiTypes: string[]; stopPoint: string | null };
}
