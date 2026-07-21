/**
 * scripts/sweep/candidates.ts — inventory-candidate discovery with mechanical
 * inheritance derivation (PROPAGATION.md §13, D-045).
 *
 * DETECTION: branches (local or origin/*) matching the sweepable namespaces
 * (config REGISTRY_REQUIRED_GLOBS, minus scope exclusions) — plus branches the
 * D-033 edition-composition closure qualifies — that have NO inventory entry.
 * For each, a CANDIDATE record is derived. Candidates are NEVER merged or
 * planned for propagation — discovery and reporting only; the owner approves
 * the placement before an entry is created (agent duty, doctrine).
 *
 * INHERITANCE DERIVATION — mechanical, evidence-backed, both directions:
 *  - Ownership model: an established branch X (inventory + main_patched) OWNS
 *    the commits of its first-parent line that are neither upstream (reachable
 *    from the pinned trunk) nor on a DECLARED-ancestor's line — the inventory's
 *    own inheritance explains sharing; undeclared sharing does not. Two entries
 *    whose lines share an undeclared fork-era segment both "own" it, which is
 *    exactly the ambiguous-cut-point case. A candidate owns only commits on no
 *    other line at all.
 *  - Fork point: first commit on the candidate's first-parent line (newest
 *    first) that is not its own. Its trunk height is derived via heights.ts
 *    (may be -1 when below the pass chain).
 *  - Parent evidence, strongest first: (1) `cut-from` — the fork point is owned
 *    by exactly one branch; owned by several → ambiguous cut point (open
 *    question); (2) `merged-from` — P-own commits reachable from the candidate
 *    tip off its first-parent line and above the fork point (the D-033
 *    fork-era-reachability approach; upstream never qualifies); (3) `merge-base`
 *    — deepest merge-base among inventory branches, ALWAYS thin evidence
 *    (open question), never `clear` on its own.
 *  - Descendant evidence: `merged-into` — candidate-own commits reachable from
 *    D's tip off D's first-parent line; `cut-of` — D's line first-parent-
 *    contains the candidate (tip on D's line), or D's own segment overlaps the
 *    candidate's line unexplained by D's declared parents (direction is
 *    topologically undecidable — surfaced as an open question). A descendant
 *    finding flags `requiresEntryEdit`: D's existing entry needs its `parents`
 *    amended.
 *  - Confidence: `clear` ONLY when at least one parent is derived and NO open
 *    question exists (unambiguous cut, no merge-commit fork point, fork-era
 *    ancestry present, no both-direction evidence, proposed edges acyclic).
 *    Everything else is `unclear` and carries the SPECIFIC question(s) for the
 *    owner. Never guess; never `clear` on thin evidence.
 *
 * KNOWN LIMIT (documented in §13): "c cut from D" and "D cut from c" produce
 * identical DAGs; where both sides continued independently the driver applies
 * the established-branch prior (candidate cut from the inventory branch). The
 * owner reviews every candidate before an entry exists, so a wrong prior is
 * caught at approval time.
 *
 * ARTIFACTS: per-candidate `<workspace>/inventory-candidates/<slug>.yaml`
 * (throttle field `lastReportedTip` — re-report only when the tip moved, like
 * urging; a candidate whose branch gains an inventory entry is marked
 * `resolved` and reported once). Writing these + the pass `candidates.json` is
 * derived-REPORT state: the documented exception to plan purity (§13) —
 * reports, never git refs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';

import { EXCLUDED_BRANCH_GLOBS, REGISTRY_REQUIRED_GLOBS } from './config.js';
import { commitInfo, diffNameStatus, git, localBranches, remoteBranches, revParse } from './git.js';
import { globMatchAny } from './globs.js';
import { deriveCoverage, type Chain } from './heights.js';
import { editionCompositionBranches } from './scope.js';
import { slug } from './steps.js';
import type { FeatureEntry, SweepScope } from './types.js';

/** Standing instruction printed verbatim with every CANDIDATES section (§13). */
export const CANDIDATE_STANDING_INSTRUCTION =
  'Report these to the owner. clear → propose the derived placement for approval; unclear → ask the owner ' +
  'the open question. The inventory may only contain branches with proper/valid inheritance — never add an ' +
  'entry without it.';

/** Cap on the recorded changed-file list (the YAML notes the total when capped). */
export const CHANGED_FILES_CAP = 40;

export interface CandidateEvidence {
  kind: 'cut-from' | 'merged-from' | 'merged-into' | 'cut-of' | 'merge-base';
  sha: string;
  detail: string;
}

export interface ProposedParent {
  branch: string;
  evidence: CandidateEvidence[];
}

export interface ProposedDescendant {
  branch: string;
  evidence: CandidateEvidence[];
  /** D has an inventory entry whose `parents` needs amending (owner-approved). */
  requiresEntryEdit: boolean;
}

export interface CandidateRecord {
  branch: string;
  tip: string;
  /** The branch exists only as origin/<branch> (no local ref). */
  remoteOnly: boolean;
  /** Watermark12 of the pass that first discovered the candidate. */
  discovered: string;
  /** First-parent divergence point from the fork ancestry + its trunk height (-1 = below the chain). */
  forkPoint: { sha: string; height: number } | null;
  /** Candidate tip's derived trunk coverage height (heights.ts, -1 = none). */
  coverage: number;
  proposedParents: ProposedParent[];
  proposedDescendants: ProposedDescendant[];
  confidence: 'clear' | 'unclear';
  openQuestions: string[];
  /** Branch the changed-file list is diffed against (strongest parent, else trunk). */
  changedFilesVs: string | null;
  changedFiles: string[];
  /** Total changed files; > changedFiles.length when capped at CHANGED_FILES_CAP. */
  changedFilesTotal: number;
  /** Throttle: tip the candidate was last reported at (re-report only on movement). */
  lastReportedTip: string;
  resolved?: boolean;
  resolvedReason?: string;
}

const SWEEPABLE_STATUS = new Set(['in-progress', 'shipped', 'experimental']);

export interface DeriveCandidatesOptions {
  repo: string;
  /** The pass's pinned trunk chain (heights + fork-point bound + trunk tip). */
  chain: Chain;
  features: FeatureEntry[];
  scope: SweepScope;
}

/**
 * Derive all candidate records (pure w.r.t. git state — no writes; the
 * throttle/YAML side effects live in reconcileCandidates).
 */
export async function deriveCandidates(opts: DeriveCandidatesOptions): Promise<CandidateRecord[]> {
  const { repo, chain, features, scope } = opts;
  const local = await localBranches(repo);
  const origin = await remoteBranches(repo);
  const localSet = new Set(local);
  const excludeGlobs = [...EXCLUDED_BRANCH_GLOBS, ...(scope.exclude ?? [])];
  const excluded = (b: string) => globMatchAny(excludeGlobs, b);

  const all = [...new Set([...local, ...origin])]
    .filter((b) => b !== 'main' && b !== 'main_patched' && !excluded(b))
    .sort();
  const entryBranches = new Set(features.filter((f) => f.branch).map((f) => f.branch!));
  // D-033 machinery: composition members without an entry are candidates too
  // (they already draw the "add one" scope warning). Local-only: the closure
  // walks branches by name.
  const composition = new Set(await editionCompositionBranches(repo, local, { forkPoint: chain.base }));
  const candidates = all.filter(
    (b) => !entryBranches.has(b) && (globMatchAny(REGISTRY_REQUIRED_GLOBS, b) || composition.has(b)),
  );
  if (candidates.length === 0) return [];

  const readRef = (b: string): string => (localSet.has(b) ? b : `origin/${b}`);

  // Established members: sweepable inventory entries whose branch resolves,
  // plus main_patched (structural).
  const entryByBranch = new Map<string, FeatureEntry>();
  const inventory: string[] = [];
  for (const f of features) {
    if (!f.branch || !SWEEPABLE_STATUS.has(f.status) || excluded(f.branch)) continue;
    if (!localSet.has(f.branch) && !origin.includes(f.branch)) continue;
    if (entryByBranch.has(f.branch)) continue;
    inventory.push(f.branch);
    entryByBranch.set(f.branch, f);
  }
  const hasMp = localSet.has('main_patched') || origin.includes('main_patched');
  const established = [...(hasMp ? ['main_patched'] : []), ...inventory];
  const members = [...established, ...candidates];

  // --- memoized git reads, bounded at the pass fork point (chain.base) ---
  const bound = [`^${chain.base}`];
  const revList = async (args: string[]): Promise<string[]> =>
    (await git(repo, ['rev-list', ...args, ...bound])).stdout.split('\n').filter(Boolean);
  const fpMemo = new Map<string, string[]>();
  /** First-parent line of a member branch, NEWEST first, fork-era only. */
  const fpLine = async (b: string): Promise<string[]> => {
    let v = fpMemo.get(b);
    if (!v) {
      v = await revList(['--first-parent', readRef(b)]);
      fpMemo.set(b, v);
    }
    return v;
  };
  const fpSetMemo = new Map<string, Set<string>>();
  const fpSet = async (b: string): Promise<Set<string>> => {
    let v = fpSetMemo.get(b);
    if (!v) {
      v = new Set(await fpLine(b));
      fpSetMemo.set(b, v);
    }
    return v;
  };
  const reachMemo = new Map<string, Set<string>>();
  const reach = async (ref: string): Promise<Set<string>> => {
    let v = reachMemo.get(ref);
    if (!v) {
      v = new Set(await revList([ref]));
      reachMemo.set(ref, v);
    }
    return v;
  };
  // Fork-era trunk commits (the pinned watermark, never a live ref — §2/§8).
  const mainSet = await reach(chain.watermark);

  // Declared-ancestor closure per inventory branch (entry `parents`, roots
  // default to main_patched per the scope rules).
  const closureMemo = new Map<string, Set<string>>();
  const declaredClosure = (b: string): Set<string> => {
    let v = closureMemo.get(b);
    if (v) return v;
    v = new Set<string>();
    closureMemo.set(b, v); // break cycles defensively (scope.ts halts on real ones)
    const entry = entryByBranch.get(b);
    const parents = entry?.parents?.length ? entry.parents : hasMp && b !== 'main_patched' ? ['main_patched'] : [];
    for (const p of parents) {
      if (v.has(p) || p === b) continue;
      v.add(p);
      for (const a of declaredClosure(p)) v.add(a);
    }
    return v;
  };

  const ownMemo = new Map<string, Set<string>>();
  /** Ownership per the header model. `X` must be a member. */
  const own = async (x: string): Promise<Set<string>> => {
    let v = ownMemo.get(x);
    if (v) return v;
    const line = await fpSet(x);
    const excludeSets: Set<string>[] = [mainSet];
    if (established.includes(x)) {
      for (const a of declaredClosure(x)) if (members.includes(a)) excludeSets.push(await fpSet(a));
    } else {
      for (const y of members) if (y !== x) excludeSets.push(await fpSet(y));
    }
    v = new Set([...line].filter((s) => !excludeSets.some((set) => set.has(s))));
    ownMemo.set(x, v);
    return v;
  };

  const mergeBase = async (a: string, b: string): Promise<string | null> => {
    const res = await git(repo, ['merge-base', a, b], { allowCodes: [1, 128] });
    return res.code === 0 ? res.stdout.trim() : null;
  };
  const isAncestorOf = async (a: string, b: string): Promise<boolean> => {
    const res = await git(repo, ['merge-base', '--is-ancestor', a, b], { allowCodes: [1] });
    return res.code === 0;
  };
  const short = (s: string): string => s.slice(0, 12);

  const records: CandidateRecord[] = [];
  for (const cand of candidates) {
    const tip = await revParse(repo, readRef(cand));
    const line = await fpLine(cand); // newest first
    const ownC = await own(cand);
    const questions: string[] = [];
    const parents = new Map<string, CandidateEvidence[]>();
    const addParent = (branch: string, ev: CandidateEvidence): void => {
      (parents.get(branch) ?? parents.set(branch, []).get(branch)!).push(ev);
    };

    // --- fork point (first-parent divergence from the fork ancestry) ---
    let forkPoint: string | null = line.find((s) => !ownC.has(s)) ?? null;
    let preFork = false;
    if (!forkPoint) {
      // The whole fork-era line is the candidate's own: the divergence lies
      // below the pass fork point → pre-fork branch (no fork-era ancestry).
      forkPoint = await mergeBase(tip, chain.watermark);
      preFork = true;
      questions.push(
        forkPoint
          ? `no fork-era ancestry: diverged from upstream at ${short(forkPoint)}, below the fork point — pre-fork branch; does it belong in the inventory at all?`
          : `no common ancestry with the trunk — orphan history; owner input required`,
      );
    }

    if (ownC.size === 0) {
      questions.push(
        `candidate has no own fork-era commits (tip ${short(tip)} lies on existing history) — stale branch pointer, or a base branch others were cut from?`,
      );
    }

    // --- E1: cut-from (fork-point ownership) ---
    let cutOwner: string | null = null;
    if (forkPoint && !preFork) {
      if ((await commitInfo(repo, forkPoint)).parents.length > 1) {
        questions.push(`fork point ${short(forkPoint)} is a merge commit — cut point ambiguous; confirm the intended parent`);
      }
      const owners: string[] = [];
      for (const m of members) {
        if (m === cand) continue;
        if ((await own(m)).has(forkPoint)) owners.push(m);
      }
      if (owners.length === 1) {
        cutOwner = owners[0];
        addParent(cutOwner, {
          kind: 'cut-from',
          sha: forkPoint,
          detail: `fork point ${short(forkPoint)} is an own first-parent commit of '${cutOwner}'`,
        });
        if (!established.includes(cutOwner)) {
          questions.push(
            `cut from '${cutOwner}', which is itself only a candidate (no inventory entry yet) — placement depends on its approval`,
          );
        }
      } else if (owners.length > 1) {
        for (const o of owners) {
          addParent(o, {
            kind: 'cut-from',
            sha: forkPoint,
            detail: `fork point ${short(forkPoint)} lies on '${o}' first-parent line (shared, undeclared)`,
          });
        }
        questions.push(
          `cut point ambiguous between ${owners.map((o) => `'${o}'@${short(forkPoint!)}`).join(' and ')} — which parent?`,
        );
      } else if (mainSet.has(forkPoint)) {
        questions.push(
          `cut directly from the upstream trunk at ${short(forkPoint)} — no inventory branch owns the cut point; upstream-PR branch (merges main only) or missing parent?`,
        );
      }
      // owners.length === 0 && not on the trunk: unowned fork-era commit —
      // fall through to the merge-base fallback below.
    }

    // --- E2: merged-from (P's own commits reachable off the candidate's fp line,
    // above the fork point — inherited base content never qualifies) ---
    const reachC = await reach(readRef(cand));
    const fpC = await fpSet(cand);
    const inherited = forkPoint ? await reach(forkPoint) : new Set<string>();
    for (const p of members) {
      if (p === cand) continue;
      const hits = [...(await own(p))].filter((s) => reachC.has(s) && !fpC.has(s) && !inherited.has(s));
      if (hits.length === 0) continue;
      addParent(p, {
        kind: 'merged-from',
        sha: hits[0],
        detail: `${hits.length} '${p}'-own commit(s) reachable from the candidate tip off its first-parent line (e.g. ${short(hits[0])})`,
      });
      if (!established.includes(p)) {
        questions.push(`merged from '${p}', which is itself only a candidate (no inventory entry yet)`);
      }
    }

    // --- E3: deepest merge-base among inventory branches (thin evidence) ---
    if (parents.size === 0 && !preFork && established.length > 0) {
      const mbs: Array<{ branch: string; mb: string }> = [];
      for (const p of established) {
        const mb = await mergeBase(tip, await revParse(repo, readRef(p)));
        if (mb) mbs.push({ branch: p, mb });
      }
      // Keep the maximal (deepest) merge-bases: those no other mb strictly descends from.
      const maximal: Array<{ branch: string; mb: string }> = [];
      for (const a of mbs) {
        let dominated = false;
        for (const b of mbs) {
          if (a.mb !== b.mb && (await isAncestorOf(a.mb, b.mb))) {
            dominated = true;
            break;
          }
        }
        if (!dominated) maximal.push(a);
      }
      // Only fork-era merge-bases count: a trunk commit, the fork point itself
      // or anything below it is shared upstream ancestry, not placement evidence.
      const fresh: Array<{ branch: string; mb: string }> = [];
      for (const m of maximal) {
        if (mainSet.has(m.mb)) continue;
        if (await isAncestorOf(m.mb, chain.base)) continue;
        fresh.push(m);
      }
      if (fresh.length === 1) {
        addParent(fresh[0].branch, {
          kind: 'merge-base',
          sha: fresh[0].mb,
          detail: `deepest merge-base among inventory branches is with '${fresh[0].branch}' at ${short(fresh[0].mb)}`,
        });
        questions.push(
          `placement inferred only from the deepest merge-base ('${fresh[0].branch}' @ ${short(fresh[0].mb)}) — thin evidence; confirm the parent`,
        );
      } else if (fresh.length > 1) {
        for (const m of fresh) {
          addParent(m.branch, {
            kind: 'merge-base',
            sha: m.mb,
            detail: `merge-base with '${m.branch}' at ${short(m.mb)} (tied deepest)`,
          });
        }
        questions.push(
          `cut point ambiguous between ${fresh.map((m) => `'${m.branch}'@${short(m.mb)}`).join(' and ')} — which parent?`,
        );
      } else if (questions.length === 0) {
        questions.push(`no fork-era relationship to any inventory branch found — owner input required`);
      }
    }

    // --- descendants (the inverse direction) ---
    const descendants: ProposedDescendant[] = [];
    for (const d of members) {
      if (d === cand) continue;
      const evs: CandidateEvidence[] = [];
      const fpD = await fpSet(d);
      const reachD = await reach(readRef(d));
      const merged = [...ownC].filter((s) => reachD.has(s) && !fpD.has(s));
      if (merged.length > 0) {
        evs.push({
          kind: 'merged-into',
          sha: merged[0],
          detail: `${merged.length} candidate-own commit(s) reachable from '${d}' off its first-parent line (e.g. ${short(merged[0])}) — candidate merged into '${d}'`,
        });
      }
      if (!mainSet.has(tip) && fpD.has(tip)) {
        evs.push({
          kind: 'cut-of',
          sha: tip,
          detail: `'${d}' first-parent line contains the candidate tip — '${d}' builds directly on the candidate`,
        });
        questions.push(
          `'${d}' carries the candidate's entire line first-parent-wise — was '${d}' cut from '${cand}'? '${d}''s entry parents need amending if so`,
        );
      } else if (established.includes(d) && cutOwner !== null && cutOwner !== d && !declaredClosure(cutOwner).has(d)) {
        // Undeclared shared segment: D's own commits on the candidate's line —
        // but a D the cut parent DECLARES as ancestor is inherited legitimately
        // (the candidate carries its parent's whole line), never a finding.
        const shared = [...(await own(d))].filter((s) => fpC.has(s));
        if (shared.length > 0) {
          evs.push({
            kind: 'cut-of',
            sha: shared[0],
            detail: `'${d}' shares fork-era first-parent history with the candidate at ${short(shared[0])}, unexplained by '${d}''s declared parents`,
          });
          questions.push(
            `'${d}' shares fork-era first-parent history with the candidate (e.g. ${short(shared[0])}) unexplained by its declared parents — direction unclear (was '${d}' cut from '${cand}'?)`,
          );
        }
      }
      if (evs.length > 0) {
        descendants.push({ branch: d, evidence: evs, requiresEntryEdit: entryByBranch.has(d) });
      }
    }

    // --- acyclicity of the proposed edges ---
    const parentNames = [...parents.keys()];
    const descNames = new Set(descendants.map((d) => d.branch));
    for (const p of parentNames) {
      if (descNames.has(p)) {
        questions.push(`proposed edges create a cycle: '${p}' appears as both parent and descendant of the candidate`);
      }
      for (const d of descNames) {
        if (declaredClosure(p).has(d)) {
          questions.push(
            `proposed edges create a cycle: '${d}' → '${cand}' → '${p}' while '${p}' already inherits from '${d}'`,
          );
        }
      }
    }

    // --- heights + changed files ---
    const forkHeight = forkPoint ? (await deriveCoverage(repo, chain, forkPoint)).height : -1;
    const coverage = (await deriveCoverage(repo, chain, tip)).height;
    const kindRank = { 'cut-from': 0, 'merged-from': 1, 'merge-base': 2 } as const;
    const strongest =
      parentNames
        .map((b) => ({ b, rank: Math.min(...parents.get(b)!.map((e) => kindRank[e.kind as keyof typeof kindRank] ?? 3)) }))
        .sort((x, y) => x.rank - y.rank)[0]?.b ?? null;
    const diffBaseRef = strongest ? await revParse(repo, readRef(strongest)) : chain.watermark;
    const diffBase = await mergeBase(tip, diffBaseRef);
    const changed = diffBase ? (await diffNameStatus(repo, diffBase, tip)).map((c) => c.path) : [];

    records.push({
      branch: cand,
      tip,
      remoteOnly: !localSet.has(cand),
      discovered: '', // stamped by reconcileCandidates (pass watermark)
      forkPoint: forkPoint ? { sha: forkPoint, height: forkHeight } : null,
      coverage,
      proposedParents: parentNames.sort().map((b) => ({ branch: b, evidence: parents.get(b)! })),
      proposedDescendants: descendants,
      confidence: questions.length === 0 && parents.size > 0 ? 'clear' : 'unclear',
      openQuestions: [...new Set(questions)],
      changedFilesVs: strongest ?? (diffBase ? 'main' : null),
      changedFiles: changed.slice(0, CHANGED_FILES_CAP),
      changedFilesTotal: changed.length,
      lastReportedTip: tip,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Report reconciliation (YAML store + throttle) — derived-report state (§13).
// ---------------------------------------------------------------------------

export function candidatesDir(workspace: string): string {
  return join(workspace, 'inventory-candidates');
}

export function candidateYamlPath(workspace: string, branch: string): string {
  return join(candidatesDir(workspace), `${slug(branch)}.yaml`);
}

/** Read all stored candidate records (tolerates unparsable files: skipped). */
export function readCandidateFiles(workspace: string): CandidateRecord[] {
  const dir = candidatesDir(workspace);
  if (!existsSync(dir)) return [];
  const out: CandidateRecord[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    try {
      const doc = parse(readFileSync(join(dir, f), 'utf8')) as CandidateRecord | null;
      if (doc && typeof doc === 'object' && typeof doc.branch === 'string') out.push(doc);
    } catch {
      /* unreadable candidate file: skip (regenerated on next movement) */
    }
  }
  return out;
}

export interface CandidateEvent {
  record: CandidateRecord;
  event: 'discovered' | 'moved';
}

export interface CandidateReconcile {
  /** Candidates newly reported this pass (new, or tip moved past lastReportedTip). */
  events: CandidateEvent[];
  /** Stale candidate files marked resolved this pass (reported once). */
  resolved: Array<{ branch: string; reason: string }>;
  /** Every currently-detected candidate (throttled ones included). */
  all: CandidateRecord[];
}

/**
 * Apply the urging-style throttle (§13): write/refresh the per-candidate YAML
 * only for NEW candidates or ones whose tip moved past `lastReportedTip`;
 * quiet passes stay quiet. A stored candidate whose branch gained an inventory
 * entry (or vanished entirely) is marked `resolved` and reported once.
 */
export function reconcileCandidates(
  workspace: string,
  records: CandidateRecord[],
  entryBranches: Set<string>,
  watermark12: string,
): CandidateReconcile {
  const dir = candidatesDir(workspace);
  const existing = new Map(readCandidateFiles(workspace).map((r) => [r.branch, r]));
  const events: CandidateEvent[] = [];
  const writeRecord = (r: CandidateRecord): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(candidateYamlPath(workspace, r.branch), stringify(r));
  };
  for (const r of records) {
    const prev = existing.get(r.branch);
    if (prev && !prev.resolved && prev.lastReportedTip === r.tip) continue; // throttled
    const record: CandidateRecord = { ...r, discovered: prev?.discovered || watermark12, lastReportedTip: r.tip };
    writeRecord(record);
    events.push({ record, event: prev && !prev.resolved ? 'moved' : 'discovered' });
  }
  const current = new Set(records.map((r) => r.branch));
  const resolved: Array<{ branch: string; reason: string }> = [];
  for (const [branch, prev] of existing) {
    if (current.has(branch) || prev.resolved) continue;
    const reason = entryBranches.has(branch) ? 'inventory-entry-added' : 'branch-gone';
    writeRecord({ ...prev, resolved: true, resolvedReason: reason });
    resolved.push({ branch, reason });
  }
  return { events, resolved, all: records };
}

/** One-line placement (clear) or first open question (unclear) for a record. */
export function candidatePlacementLine(r: CandidateRecord): string {
  if (r.confidence === 'clear') {
    const placement = r.proposedParents
      .map((p) => `${p.evidence[0].kind} '${p.branch}' @ ${p.evidence[0].sha.slice(0, 12)}`)
      .join(', ');
    const edits = r.proposedDescendants.filter((d) => d.requiresEntryEdit).map((d) => d.branch);
    return placement + (edits.length ? ` (requires editing existing entr${edits.length > 1 ? 'ies' : 'y'} ${edits.map((e) => `'${e}'`).join(', ')})` : '');
  }
  return r.openQuestions[0] ?? 'unclear — no derivable placement';
}

/** The CANDIDATES section lines for plan/status output (§13). */
export function candidateSectionLines(
  reported: CandidateRecord[],
  resolved: Array<{ branch: string; reason: string }> = [],
): string[] {
  if (reported.length === 0 && resolved.length === 0) return [];
  const lines = ['CANDIDATES (D-045):'];
  for (const r of reported) lines.push(`  ${r.branch} [${r.confidence}] ${candidatePlacementLine(r)}`);
  for (const s of resolved) lines.push(`  ${s.branch} resolved (${s.reason})`);
  lines.push(`  ${CANDIDATE_STANDING_INSTRUCTION}`);
  return lines;
}
