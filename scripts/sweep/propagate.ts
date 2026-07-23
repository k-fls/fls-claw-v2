/**
 * scripts/sweep/propagate.ts — mechanical propagation driver CLI
 * (PROPAGATION.md §8, D-035..D-040).
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/propagate.ts <plan|run|resolve|verify|status> [flags]
 *
 * Subcommands:
 *   plan                          OPEN a pass: pin watermark + fork point, derive coverage,
 *                                 emit plan-initial.json + plan.json (only plan opens a pass)
 *   run                           attach to the open pass; CLEAN merges + skips + DEFERRED;
 *                                 halt at the first case PER BRANCH; emit case files (MUTATES)
 *   resolve --case ID --tier T    re-verify the case from git+registry, scope-guard + cold-read
 *                                 gate, then merge (MECHANICAL), prepare PR materials (JUDGED),
 *                                 or freeze (HELD, --tier held direct)                 (MUTATES)
 *   publish --case ID             §14 (D-048/D-049, unified per D-057): the ONLY sanctioned
 *                                 PR-creation path — verify the case, run the check battery +
 *                                 pre-PR height check (machine-readable {ok, issues, pr?}), and
 *                                 with --execute push the fix/sweep ref (git push) at the REAL
 *                                 head and create the PR via the GitHub API. HELD with a
 *                                 marker-clean resolution: ACTIVE PR at the resolved merge
 *                                 commit (owner reviews & merges); HELD without one: DRAFT PR
 *                                 from the pristine conflict; JUDGED: non-draft at the merge
 *                                 commit                                               (MUTATES)
 *   push                          §14.4 (D-049): verify-gated pass publication — push target
 *                                 branches (flips JUDGED PRs to merged), closure checks, post
 *                                 urge comments + D-004 machine-block refresh           (MUTATES)
 *   verify                        §9 gate: everything-rebuild + CI commands, leave-one-out
 *                                 attribution; red -> rollback offender + HELD(gate)   (MUTATES)
 *   unfreeze --branch <b>         manually clear a branch's block for THIS pass (journaled;
 *                                 origin re-derives at the next start, D-058)          (MUTATES)
 *   status                        human-readable pass state from journal + ledger
 *
 * Flags:
 *   --repo <path>            repo to operate on                (default: cwd)
 *   --workspace <dir>        artifacts root = GROUP ROOT       (default: parent of --repo; MUST be outside any git work tree, D-055)
 *   --ledger <file>          group-owned ledger JSON           (default: <workspace>/sweep-ledger.json)
 *   --pass <watermark12>     attach to a specific pass         (default: latest OPEN pass)
 *   --inventory <dir>        live feature inventory            (default: latest bootstrap snapshot)
 *   --scope-config <file>    scope policy                      (default: registry/scope.yaml)
 *   --routing-config <file>  router/scan tuning                (default: registry/routing.yaml)
 *   --upstream <ref>         upstream ref (plan only)          (default: upstream/main)
 *   --base <ref>             trunk-chain fork point (plan only)(default: FORK_POINT else merge-base)
 *   --execute                perform mutations (run/resolve/verify); without it, dry-run
 *   --case <id>              resolve/publish: the case id
 *   --tier <mechanical|judged|held>  resolve: the agent's claimed tier (held = direct freeze)
 *   --resolved-ref <ref>     resolve: commit carrying the agent's resolution (tree source)
 *   --token-file <path>      every networked subcommand (publish/push, and sweep start's
 *                            origin PR checks — D-049/D-058): file holding the substitute
 *                            GitHub token (the agent writes the get_credential output there
 *                            once per session; the credential proxy swaps the Authorization
 *                            header on the wire)
 *   --branch <name>          unfreeze: the branch to clear
 *   --recipe <a,b,c>         verify: everything-rebuild recipe (default: scope.yaml recipe)
 *   --commands-file <file>   verify: CI command list JSON [{cmd,cwd?}] (test injection)
 *   --out <file>             write the subcommand's JSON artifact to a file
 *
 * Artifacts live under <workspace>/propagation/pass-<watermark12>/:
 *   plan-initial.json (immutable opening snapshot), plan.json (working), step files,
 *   case-<id>/case.json (+ coldread-request.md, pr/materials.md), journal.jsonl
 *   (append-only). case.json is a POINTER only — resolve re-derives everything from
 *   git+registry (§7 trust boundary). The driver NEVER generates PR prose (D-048): the
 *   agent writes pr/title.txt + pr/body.md from studying the case. `publish`, `push`
 *   and `sweep start` are the only subcommands that touch the network (git push/fetch +
 *   GitHub REST — §14/§14.4, D-049/D-058); refs move via git push ONLY, and any push
 *   failure is a hard halt reported to the owner (D-046 case 2), never worked around.
 *
 *   D-058: NOTHING is published before `finish` — report-pr records intent only, and
 *   finish's single post-verify publish phase creates every PR (judged + held). The
 *   blocked (merge_status) picture is derived from ORIGIN at `sweep start`, never from
 *   local state: the ledger's merge_status field is dead to this driver.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join, resolve as pathResolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
  DEFAULT_STACK_CAP,
  DEFAULT_UPSTREAM_REF,
  FORK_POINT,
  LEDGER_FILENAME,
  RR_CACHE_DIRNAME,
  VERIFY_COMMANDS,
} from './config.js';
import {
  addTempWorktree,
  commitInfo,
  commitTreeMerge,
  git,
  gitPush,
  isAncestor,
  localBranchExists,
  newStyleMergeTree,
  resetBranchRef,
  revParse,
  refExists,
  worktreeBranches,
} from './git.js';
import {
  CANDIDATE_STANDING_INSTRUCTION,
  candidateSectionLines,
  deriveCandidates,
  readCandidateFiles,
  reconcileCandidates,
} from './candidates.js';
import { readLedger, writeLedger, defaultLedgerBranch } from './ledger.js';
import { installRrCache } from './merge.js';
import { loadRegistry } from './registry.js';
import { resolveScope } from './scope.js';
import { scopeGuard } from './scope-guard.js';
import {
  advisoryTextIssues,
  checkBaseHeight,
  classifyComments,
  classifyReviewTrigger,
  createPullRequest,
  decidedAlready,
  getOpenPrByHead,
  getPrsByHead,
  getPullRequest,
  ghExpect,
  haltIdFor,
  isBlocking,
  listIssueComments,
  listReviewComments,
  listReviews,
  maxRealReviewId,
  parseGithubSlug,
  postSweepAddressed,
  realGithubTransport,
  renderMachineBlock,
  renderSweepAddressed,
  reopenPullRequest,
  stripSweepAddressed,
  withMachineBlock,
  type GithubTransport,
  type Issue,
  type PrByHead,
  type PrComment,
  type PrReview,
} from './publish.js';
import { buildStepFile, caseId, readCaseFile, slug, verifyStepFile, writeJsonFile } from './steps.js';
import { applyFloor, isClaimableTier, tierFloor } from './tiers.js';
import {
  allParentsSkipped,
  deriveBranch,
  derivePlan,
  findLeaves,
  plansDiffer,
  shortestUnskipChain,
  transitiveAncestors,
} from './plan.js';
import { deriveCoverage, enumerateChain, type Chain } from './heights.js';
import { verifyEverything, type VerifyCommand } from './verify.js';
import type {
  BranchPlan,
  CaseFile,
  ColdReadVerdict,
  FeatureEntry,
  Head,
  HeldRecord,
  PropagationPlan,
  ScopeGuardMode,
  Tier,
} from './types.js';

interface Cli {
  cmd: string;
  repo: string;
  workspace: string;
  ledgerPath?: string;
  pass?: string;
  /**
   * Live inventory dir. Omitted (undefined) falls back to the committed
   * bootstrap snapshot via loadRegistry — NEVER to an empty inventory: the
   * old `null` default meant "explicitly no inventory", silently collapsing
   * the scope to main_patched alone (2026-07-20 test-drive finding #2).
   */
  inventory?: string;
  scopeFile?: string;
  routingFile?: string;
  upstream: string;
  base?: string;
  execute: boolean;
  caseId?: string;
  tier?: string;
  resolvedRef?: string;
  /**
   * publish: file holding the substitute GitHub token (§14, D-048). The agent
   * writes the get_credential output there once per session; the credential
   * proxy swaps the Authorization header for api.github.com on the wire.
   * $GITHUB_TOKEN is deliberately NOT read (untrustworthy in the container).
   */
  tokenFile?: string;
  branch?: string;
  recipe?: string[];
  commandsFile?: string;
  out?: string;
  /**
   * D-054: set on a nested invocation (a state-machine command driving a flag
   * command internally — next-case→run, finish→verify/publish/push/report). When
   * true, `emit` is a no-op and cmdReport skips its `--out` write, so ONLY the
   * outer state-machine command produces a result line. The nested call still
   * does its work, journals, and prints its own SWEEP-STEP progress.
   */
  internal?: boolean;
}

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/propagate.ts <plan|run|resolve|publish|push|verify|unfreeze|status|report> [--repo <path>] [--workspace <dir>] [--ledger <file>] [--pass <wm12>] [--execute] [--case <id>] [--tier <t>] [--token-file <path>] [--branch <b>] [flags]';

function parseCli(argv: string[]): Cli {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.error(USAGE);
    process.exit(2);
  }
  const cli: Cli = {
    cmd,
    repo: process.cwd(),
    workspace: process.cwd(),
    upstream: DEFAULT_UPSTREAM_REF,
    execute: false,
  };
  let workspaceExplicit = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const need = (): string => {
      const v = rest[++i];
      if (v === undefined) {
        console.error(`Missing value for ${flag}\n${USAGE}`);
        process.exit(2);
      }
      return v;
    };
    switch (flag) {
      case '--repo':
        cli.repo = need();
        break;
      case '--workspace':
        cli.workspace = pathResolve(need());
        workspaceExplicit = true;
        break;
      case '--ledger':
        cli.ledgerPath = pathResolve(need());
        break;
      case '--pass':
        cli.pass = need();
        break;
      case '--inventory':
        cli.inventory = pathResolve(need());
        break;
      case '--scope-config':
        cli.scopeFile = need();
        break;
      case '--routing-config':
        cli.routingFile = need();
        break;
      case '--upstream':
        cli.upstream = need();
        break;
      case '--base':
        cli.base = need();
        break;
      case '--execute':
        cli.execute = true;
        break;
      case '--case':
        cli.caseId = need();
        break;
      case '--tier':
        cli.tier = need();
        break;
      case '--resolved-ref':
        cli.resolvedRef = need();
        break;
      case '--token-file':
        cli.tokenFile = pathResolve(need());
        break;
      case '--branch':
        cli.branch = need();
        break;
      case '--recipe':
        cli.recipe = need().split(',').filter(Boolean);
        break;
      case '--commands-file':
        cli.commandsFile = need();
        break;
      case '--out':
        cli.out = need();
        break;
      default:
        console.error(`Unknown flag ${flag}\n${USAGE}`);
        process.exit(2);
    }
  }
  // D-055 (C-1): the canonical workspace is the GROUP ROOT — the parent of the
  // git clone (`repo/`), where the DURABLE `sweep-ledger.json` + `rr-cache` live.
  // When `--workspace` is not given, derive it from `--repo` so the pass, ledger
  // and rr-cache never land INSIDE the clone (the 2026-07-22 split that killed
  // rerere and diverged the freeze ledger). An explicit `--workspace` is honored
  // but `sweep start` refuses one inside a git working tree (see cmdSweepStart).
  if (!workspaceExplicit) cli.workspace = dirname(pathResolve(cli.repo));
  return cli;
}

// --------------------------------------------------------------------------
// Pass directory + journal (append-only).
// --------------------------------------------------------------------------

export function passDir(workspace: string, watermark12: string): string {
  return join(workspace, 'propagation', `pass-${watermark12}`);
}

export interface JournalEntry {
  ts: string;
  action: string;
  [k: string]: unknown;
}

export function appendJournal(dir: string, entry: Omit<JournalEntry, 'ts'>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function readJournal(dir: string): JournalEntry[] {
  const path = join(dir, 'journal.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEntry);
}

/**
 * Branches that finished processing this pass (barrier arrival — journal),
 * MINUS any branch whose latest `reopened` (a resolve reopened it, §8) is more
 * recent than its latest `arrived` — those must be re-processed by the next run.
 */
export function arrivedSet(journal: JournalEntry[]): Set<string> {
  const lastArrived = new Map<string, number>();
  const lastReopened = new Map<string, number>();
  journal.forEach((e, i) => {
    if (typeof e.branch !== 'string') return;
    if (e.action === 'arrived') lastArrived.set(e.branch, i);
    else if (e.action === 'reopened') lastReopened.set(e.branch, i);
  });
  const out = new Set<string>();
  for (const [branch, ai] of lastArrived) {
    if (ai > (lastReopened.get(branch) ?? -1)) out.add(branch);
  }
  return out;
}

// --------------------------------------------------------------------------
// Base resolution + plan derivation wiring.
// --------------------------------------------------------------------------

async function resolveBase(cli: Cli): Promise<string> {
  if (cli.base) return cli.base;
  if (await refExists(cli.repo, FORK_POINT)) return FORK_POINT;
  const anchor = (await refExists(cli.repo, 'main_patched')) ? 'main_patched' : 'main';
  return (await git(cli.repo, ['merge-base', anchor, cli.upstream])).stdout.trim();
}

export interface PassCtx {
  base: string;
  chain: Chain;
  dir: string;
  watermark: string;
  watermark12: string;
}

/** OPEN a pass (plan only): resolve the watermark fresh and pin the fork point. */
async function openPass(cli: Cli): Promise<PassCtx> {
  const watermark = await revParse(cli.repo, cli.upstream);
  const watermark12 = watermark.slice(0, 12);
  const dir = passDir(cli.workspace, watermark12);
  const base = await resolveBase(cli);
  const chain = await enumerateChain(cli.repo, watermark, base); // pin by SHA
  return { base, chain, dir, watermark, watermark12 };
}

function listPassDirs(workspace: string): string[] {
  const root = join(workspace, 'propagation');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d.startsWith('pass-'))
    .map((d) => join(root, d));
}

/**
 * ATTACH to an existing pass (run/resolve/verify/status). Never re-resolves
 * upstream refs — the watermark + fork point come from `plan-initial.json`, so a
 * mid-pass `git fetch` cannot silently open a new pass or orphan the journal
 * (§8 pass pinning). `--pass <wm12>` selects explicitly; otherwise the latest
 * OPEN pass (has plan-initial.json, no `pass-complete`).
 */
async function attachPass(cli: Cli): Promise<PassCtx> {
  let dir: string;
  if (cli.pass) {
    dir = passDir(cli.workspace, cli.pass);
  } else {
    const open = listPassDirs(cli.workspace).filter(
      (d) => existsSync(join(d, 'plan-initial.json')) && !readJournal(d).some((e) => e.action === 'pass-complete'),
    );
    if (open.length === 0) throw new Error('no open pass — run `propagate plan` first (or pass --pass <watermark12>)');
    open.sort(
      (a, b) => statSync(join(a, 'plan-initial.json')).mtimeMs - statSync(join(b, 'plan-initial.json')).mtimeMs,
    );
    dir = open[open.length - 1];
  }
  const initialPath = join(dir, 'plan-initial.json');
  if (!existsSync(initialPath))
    throw new Error(`pass ${dir} has no plan-initial.json (open it with \`propagate plan\`)`);
  const initial = JSON.parse(readFileSync(initialPath, 'utf8')) as PropagationPlan;
  const watermark = initial.watermark;
  const base = initial.forkPoint ?? (await resolveBase(cli));
  const chain = await enumerateChain(cli.repo, watermark, base); // pin by SHA, never re-resolve upstream
  return { base, chain, dir, watermark, watermark12: initial.watermark12 };
}

async function passContext(cli: Cli): Promise<PassCtx> {
  return cli.cmd === 'plan' ? openPass(cli) : attachPass(cli);
}

function ledgerPathOf(cli: Cli): string {
  return cli.ledgerPath ?? join(cli.workspace, LEDGER_FILENAME);
}

/**
 * Blocked state (D-058): merge_status is NO LONGER stored anywhere local — it
 * is DERIVED. Cross-pass authority is ORIGIN: `sweep start` reconstructs the
 * PR_ID set from the origin `fix/sweep/*` refs (an unmerged ref WITH an open
 * PR ⇔ blocked) and journals one `origin-blocked` row per blocked branch into
 * the fresh pass dir. Within a pass the journal is the working view:
 * `origin-blocked` rows + this-pass `held` dispositions are PR_ID; `defer`
 * rows are DEFERRED while a direct parent is still blocked; a manual
 * `unfrozen` row clears a branch for the rest of the pass. The ledger's
 * `merge_status` field survives only as a non-authoritative legacy cache for
 * the old sweep merge stage — the propagation driver never reads or writes it.
 */
interface BlockedRow {
  branch: string;
  /** Blocking case id ('origin:<ref>' for start-derived rows, 'gate*' for §9 holds). */
  caseId: string;
  /**
   * Height-bearing sha: for an origin row the fix/sweep REF HEAD (it contains
   * the conflict head as a parent, so deriveCoverage lands on the conflict
   * height); for a this-pass hold the case's conflict head. Null for gate holds.
   */
  headSha: string | null;
  /** fix/sweep head branch on origin (urge target); null until a PR exists. */
  fixBranch: string | null;
  prNumber: number | null;
  /**
   * The PR's effective sweep-addressed id at classification time (D-059; null
   * when unknown/no marker). Urge comments re-assert it so every driver
   * comment carries the marker (the content-based bot exclusion).
   */
  markerId: number | null;
}

/**
 * PR_ID rows derived from the pass journal, keyed branch → ALL of its rows
 * (last-writer-wins per branch+caseId): a multi-parent branch can carry
 * SEVERAL concurrent blocks (one per held case / origin fix ref), and every
 * one matters — collapsing to one row weakened the descendants' DEFER
 * height-MIN when the survivor was the HIGHER block (finding #4).
 * `origin-blocked` (start) and `held` (this pass) add a row, a later manual
 * `unfrozen` clears the branch's rows, and a `pr-published` (mode held)
 * enriches its case's row with the fix branch + PR number.
 */
function blockedRows(journal: JournalEntry[]): Map<string, BlockedRow[]> {
  const cases = journaledCases(journal);
  const out = new Map<string, BlockedRow[]>();
  const put = (row: BlockedRow): void => {
    const rows = out.get(row.branch) ?? [];
    const i = rows.findIndex((r) => r.caseId === row.caseId);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    out.set(row.branch, rows);
  };
  for (const e of journal) {
    if (typeof e.branch !== 'string') continue;
    if (e.action === 'origin-blocked') {
      put({
        branch: e.branch,
        caseId: typeof e.caseId === 'string' ? e.caseId : 'origin',
        headSha: typeof e.headSha === 'string' ? e.headSha : null,
        fixBranch: typeof e.fixBranch === 'string' ? e.fixBranch : null,
        prNumber: typeof e.prNumber === 'number' ? e.prNumber : null,
        markerId: typeof e.markerId === 'number' ? e.markerId : null,
      });
    } else if (e.action === 'held') {
      const jc = typeof e.caseId === 'string' ? cases.get(e.caseId) : undefined;
      put({
        branch: e.branch,
        caseId: typeof e.caseId === 'string' ? e.caseId : 'held',
        headSha: jc?.head.sha ?? null,
        fixBranch: null, // no PR until `finish` publishes (D-058)
        prNumber: null,
        markerId: null,
      });
    } else if (e.action === 'pr-published' && e.mode === 'held') {
      const row = (out.get(e.branch) ?? []).find((r) => r.caseId === e.caseId);
      if (row) {
        row.fixBranch = typeof e.fixBranch === 'string' ? e.fixBranch : row.fixBranch;
        row.prNumber = typeof e.number === 'number' ? e.number : row.prNumber;
      }
    } else if (e.action === 'unfrozen') {
      out.delete(e.branch);
    }
  }
  return out;
}

/**
 * The pass's merge_status view (branch → PR_ID | DEFERRED; absence = NONE),
 * derived from the journal alone (D-058):
 *  - PR_ID: `blockedRows` (origin-derived rows + this-pass holds).
 *  - DEFERRED: branches with a journaled `defer` this pass, kept only while a
 *    DIRECT parent (registry edges) is still blocked — the D-057 STAY rule as
 *    a fixpoint over the journal instead of a stored flag, so a cleared
 *    parent releases its whole deferred chain on the next derivation. Across
 *    passes nothing is stored: DEFERRED is simply recomputed from the
 *    parents' PR_ID during derivation (the BECOME height-MIN rule re-runs).
 */
function passStatusView(cli: Cli, journal: JournalEntry[]): Map<string, 'PR_ID' | 'DEFERRED'> {
  const pr = blockedRows(journal);
  const parentsOf = directParentEdges(cli);
  // A manual `unfrozen` clears a DEFERRED branch too (finding #2a): `defer`
  // rows OLDER than the branch's latest `unfrozen` are dropped, so an
  // unfreeze actually takes effect for DEFERRED (not just PR_ID). A later
  // re-defer (a fresh `defer` row after the unfreeze) re-blocks normally.
  const lastUnfrozen = new Map<string, number>();
  journal.forEach((e, i) => {
    if (e.action === 'unfrozen' && typeof e.branch === 'string') lastUnfrozen.set(e.branch, i);
  });
  const deferred = new Set(
    journal
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e, i }) =>
          e.action === 'defer' && typeof e.branch === 'string' && i > (lastUnfrozen.get(e.branch as string) ?? -1),
      )
      .map(({ e }) => e.branch as string)
      .filter((b) => !pr.has(b)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of [...deferred]) {
      const parents = parentsOf.get(b) ?? [];
      if (!parents.some((p) => pr.has(p) || deferred.has(p))) {
        deferred.delete(b);
        changed = true;
      }
    }
  }
  const out = new Map<string, 'PR_ID' | 'DEFERRED'>();
  for (const b of pr.keys()) out.set(b, 'PR_ID');
  for (const b of deferred) out.set(b, 'DEFERRED');
  return out;
}

/** PR_ID-blocked branches (own open PR / §9 gate hold): empty intervals + run skips. */
function prBlockedBranches(journal: JournalEntry[]): Set<string> {
  return new Set(blockedRows(journal).keys());
}

/**
 * LIVE block-height records for the PR_ID branches (D-057 heights, D-058
 * source): no height is stored anywhere — heights are pass-relative (the
 * chain's fork point moves as branches absorb upstream), so each blocked
 * branch's height is RE-DERIVED against THIS pass's pinned chain from the
 * row's sha: an origin row's fix/sweep ref head CONTAINS the conflict head
 * (it is a parent of the driver-built PR-head commit) and nothing above it,
 * so its coverage IS the conflict height; a this-pass hold carries the
 * conflict head itself. Rows without a sha (gate holds) or whose sha fell
 * below the chain cannot be height-matched and degrade to an ordinary case
 * for descendants — the safe direction (extra review, never less). DEFERRED
 * branches are not here: their heights are re-probed live during derivation.
 */
async function prBlockedRecords(cli: Cli, journal: JournalEntry[], chain: Chain): Promise<HeldRecord[]> {
  const out: HeldRecord[] = [];
  for (const [branch, rows] of blockedRows(journal)) {
    // Multiple concurrent blocks per branch (finding #4): contribute the
    // MINIMUM height-matched block — the safest DEFER for descendants (a
    // higher survivor would let a child below it wrongly take its own case).
    let best: HeldRecord | null = null;
    for (const row of rows) {
      if (!row.headSha) continue;
      if (!(await refExists(cli.repo, row.headSha))) continue;
      const height = (await deriveCoverage(cli.repo, chain, row.headSha)).height;
      if (height < 0) continue; // below this pass's chain — degrades to an ordinary case
      if (!best || height < best.height) best = { branch, height, conflictedPaths: [], caseId: row.caseId };
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Direct-parent edges from the registry (features + scope extra_edges): the
 * DEFERRED stay-condition is a function of the DIRECT parents, never a stored
 * flag or a journaled defer pointer (D-057).
 */
function directParentEdges(cli: Cli): Map<string, string[]> {
  const registry = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile, routingFile: cli.routingFile });
  const parentsOf = new Map<string, string[]>();
  for (const f of registry.features) if (f.branch && f.parents?.length) parentsOf.set(f.branch, [...f.parents]);
  for (const [child, ps] of Object.entries(registry.scope.extra_edges ?? {})) {
    parentsOf.set(child, [...(parentsOf.get(child) ?? []), ...ps]);
  }
  return parentsOf;
}

/** A pending urge for a still-PR_ID-blocked branch (§8; posted by `push`, D-049). */
interface PendingUrge {
  branch: string;
  /** The pending run's top = the newest pending trunk head (a blocked branch lands no merges). */
  head: string;
  pending: Head[];
  fixBranch: string;
  prNumber: number | null;
  /** The blocking case id (merge_status PR_ID caseId, D-057). */
  caseId: string;
  /** Current sweep-addressed id re-asserted by the urge comment (D-059). */
  markerId: number | null;
}

/**
 * URGING detection (§8, pure): for each PR_ID-blocked branch, if the newest
 * pending trunk head beyond its coverage on the PINNED chain differs from
 * `lastUrgedHead`, an urge is DUE. One urge per NEW head, not per pass.
 * `plan`/`run` only report these; POSTING (PR comment + D-004 machine-block
 * refresh + `lastUrgedHead` advance) lives exclusively in the networked
 * `push` stage (D-049 — the driver posts, never prepares gh commands).
 * Blocked rows come from the journal (D-058: origin-derived at start);
 * `lastUrgedHead` stays a non-authoritative ledger cache — losing it merely
 * re-urges once.
 */
async function detectUrges(cli: Cli, ctx: PassCtx, journal: JournalEntry[]): Promise<PendingUrge[]> {
  const ledger = readLedger(ledgerPathOf(cli));
  const due: PendingUrge[] = [];
  for (const row of [...blockedRows(journal).values()].flat()) {
    // Rows without a fix branch have no owner-facing PR to nudge: gate holds,
    // and this-pass holds whose PR is only created at `finish` (D-058) — those
    // become origin-derived rows (with a PR) by the next pass.
    if (!row.fixBranch) continue;
    if (!(await refExists(cli.repo, row.branch))) continue;
    const tip = await revParse(cli.repo, row.branch);
    const coverage = (await deriveCoverage(cli.repo, ctx.chain, tip)).height;
    const pending = ctx.chain.heads.filter((h) => h.height > coverage);
    if (pending.length === 0) continue;
    const newest = pending[pending.length - 1];
    if (newest.sha === ledger.branches[row.branch]?.lastUrgedHead) continue; // already urged about this head
    due.push({
      branch: row.branch,
      head: newest.sha,
      pending,
      fixBranch: row.fixBranch,
      prNumber: row.prNumber,
      caseId: row.caseId,
      markerId: row.markerId,
    });
  }
  return due;
}

/** Compose the urge-comment body for a due urge (driver facts only). */
async function urgeCommentBody(cli: Cli, urge: PendingUrge): Promise<string> {
  const newestList = urge.pending.slice(-10);
  const lines: string[] = [];
  for (const h of newestList) {
    const info = await commitInfo(cli.repo, h.sha);
    lines.push(`- h${h.height} ${h.sha.slice(0, 12)} ${info.subject}`);
  }
  return [
    `# Urge — ${urge.branch} still blocked (${urge.caseId})`,
    '',
    `${urge.pending.length} upstream commit(s) now pending beyond this branch's coverage since the hold.`,
    `Newest ${newestList.length}:`,
    ...lines,
    '',
    `Resolving this PR unblocks \`${urge.branch}\` and everything downstream.`,
    '',
    // D-059: every driver comment carries the sweep-addressed marker (the
    // content-based bot exclusion — same PAT as the human). The urge RE-ASSERTS
    // the current value; classification takes the MAX, so this never regresses.
    renderSweepAddressed(urge.markerId ?? 0),
  ].join('\n');
}

async function derive(
  cli: Cli,
  held: HeldRecord[],
  ctx: PassCtx,
  statusView: Map<string, 'PR_ID' | 'DEFERRED'>,
): Promise<PropagationPlan> {
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  return derivePlan({
    repo: cli.repo,
    // Enumerate from the PINNED watermark sha, never the live upstream ref, so a
    // mid-pass fetch cannot change the chain under us (§8 pass pinning).
    upstreamRef: ctx.watermark,
    base: ctx.base,
    features: registry.features,
    scope: registry.scope,
    held,
    mergeStatusOf: statusView,
    stackCap: registry.routing.stackCap, // D-049 §2 lever (per-feature override in derivePlan)
  });
}

// --------------------------------------------------------------------------
// pre-ref journaling (§9 rollback target) — once per branch per pass.
// --------------------------------------------------------------------------

async function recordPreRef(cli: Cli, dir: string, preReffed: Set<string>, branch: string): Promise<void> {
  if (preReffed.has(branch)) return;
  const ref = await revParse(cli.repo, branch);
  appendJournal(dir, { action: 'pre-ref', branch, ref });
  preReffed.add(branch);
}

function preReffedSet(journal: JournalEntry[]): Set<string> {
  return new Set(journal.filter((e) => e.action === 'pre-ref').map((e) => e.branch as string));
}

function lastPreRef(journal: JournalEntry[], branch: string): string | null {
  let ref: string | null = null;
  for (const e of journal) if (e.action === 'pre-ref' && e.branch === branch) ref = e.ref as string;
  return ref;
}

/** Branches with an OPEN case this pass (a `case` not yet `resolved`/`held`). */
function openCaseBranches(journal: JournalEntry[]): Set<string> {
  const branchOf = new Map<string, string>(); // caseId -> branch
  const closed = new Set<string>();
  for (const e of journal) {
    if (e.action === 'case' && typeof e.caseId === 'string' && typeof e.branch === 'string') {
      branchOf.set(e.caseId, e.branch);
    } else if ((e.action === 'resolved' || e.action === 'held') && typeof e.caseId === 'string') {
      closed.add(e.caseId);
    }
  }
  const out = new Set<string>();
  for (const [caseId, branch] of branchOf) if (!closed.has(caseId)) out.add(branch);
  return out;
}

/**
 * D-051 — the verify recipe = THIS PASS'S PUBLISHABLE RESULT: the branches that
 * ADVANCED this pass (a `pre-ref` was journaled, i.e. they were mutated),
 * ordered by the plan's DAG order (parents before children), MINUS any branch
 * that is held/frozen (`held`) or carries an OPEN case. Held/frozen branches are
 * frozen-by-design and UNPUBLISHED — they carry unresolved conflicts that, when
 * merged onto a bare base, recreate historical stack conflicts and wrongly abort
 * the build (the root bug: a permanently-held module branch could never let the
 * gate go green). They are validated by their own fix/case flow, never here.
 * Branches missing from `order` (should not happen for a real plan) trail in
 * pre-ref order so nothing publishable is silently dropped.
 */
export function publishableRecipe(journal: JournalEntry[], order: string[], held: Set<string>): string[] {
  const advanced = preReffedSet(journal);
  const openCases = openCaseBranches(journal);
  const publishable = new Set([...advanced].filter((b) => !held.has(b) && !openCases.has(b)));
  const ordered = order.filter((b) => publishable.has(b));
  const inOrder = new Set(ordered);
  const trailing = [...publishable].filter((b) => !inOrder.has(b));
  return [...ordered, ...trailing];
}

// --------------------------------------------------------------------------
// Journaled ref mutations (reuse merge.ts's commit-tree + update-ref technique).
// --------------------------------------------------------------------------

async function treeOf(repo: string, commit: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
}

/** A journaled hard halt (protected-ref refusal, dirty/aborted merge, …). */
class DriverHalt extends Error {
  constructor(
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Namespaces the driver never moves, regardless of step/case/flag input (§8/N1).
 * `main_patched` is deliberately NOT here (N7): it is a legitimate driver merge
 * TARGET — the structural upstream entry point (§2) — and must accept pass
 * merges, resolutions and §9 gate rollbacks. It is guarded by the scope check
 * below instead: movable only when the pass's resolved scope contains it (which
 * scope.ts grants exactly when the branch exists and is not excluded).
 */
const PROTECTED_REF_RE = /^(main|everything.*|design\/.*|maint\/.*|test\/.*)$/;

/**
 * Protected-ref guard — the single choke point (N1, defense-in-depth per §12):
 * refuse to move a protected namespace or any branch OUTSIDE the pass's resolved
 * scope. `fix/sweep/*` creation is scope-exempt (it is new) but still
 * namespace-checked. Throws DriverHalt → the command journals it and halts.
 */
function guardRef(branch: string, scope: Set<string>, opts: { fixSweep?: boolean } = {}): void {
  if (PROTECTED_REF_RE.test(branch)) {
    throw new DriverHalt('protected-ref', `refuse to move protected ref '${branch}'`);
  }
  if (opts.fixSweep && /^fix\/sweep\//.test(branch)) return;
  if (!scope.has(branch)) {
    throw new DriverHalt('out-of-scope', `refuse to move '${branch}' — outside the pass's resolved scope`);
  }
}

/**
 * The pass's resolved scope (branch set) from its plan snapshot. Used ONLY by
 * the §9 rollback guard in cmdVerify: there the offender comes from the verify
 * recipe (registry config / pinned flag, §12), not from the plan, so plan.json
 * cannot steer WHICH branch rolls back — it can only forbid the write. The
 * resolve flow derives its scope from the registry instead (N2, reverifyCase):
 * there plan.json IS attacker-relevant and must not extend the scope.
 */
function passScope(dir: string): Set<string> {
  const p = join(dir, 'plan.json');
  const src = existsSync(p) ? p : join(dir, 'plan-initial.json');
  if (!existsSync(src)) return new Set();
  const plan = JSON.parse(readFileSync(src, 'utf8')) as PropagationPlan;
  return new Set(plan.branches.map((b) => b.branch));
}

/** The pass plan's DAG order (parents before children) — verify recipe order (D-051). */
function passOrder(dir: string): string[] {
  const p = join(dir, 'plan.json');
  const src = existsSync(p) ? p : join(dir, 'plan-initial.json');
  if (!existsSync(src)) return [];
  const plan = JSON.parse(readFileSync(src, 'utf8')) as PropagationPlan;
  return plan.order ?? [];
}

/**
 * D-051 — the verify rebuild base per the §3 merge-source model: module & feat
 * branches root at `main_patched` (the fork trunk), NOT bare `main` — merging
 * them onto `main` recreates the fork-content conflicts they were merged past
 * and aborts the build. `main_patched` ⊇ `main`, so upstream-chain-from-main
 * branches (compositions/docs) still integrate cleanly in this THROWAWAY target;
 * the §3 push-time purity rule (those must not absorb fork content) is enforced
 * at merge/push against the real refs, never against this discarded rebuild.
 */
async function verifyBaseRef(cli: Cli): Promise<string> {
  return (await refExists(cli.repo, 'main_patched')) ? 'main_patched' : 'main';
}

/**
 * N1 — checked-out-branch safety shared by ALL ref writers (journaledMerge,
 * journaledResolvedMerge, the §9 rollback). A branch checked out in a worktree
 * must never be moved by raw plumbing without also updating that worktree:
 * `update-ref` alone silently desyncs its index/working tree (they keep the old
 * commit while the ref moves). Contract: call this BEFORE the ref write — it
 * refuses a DIRTY worktree (DriverHalt, journaled by the caller) — and when it
 * returns a path, hard-reset that worktree to the new commit AFTER the write.
 * The `git reset --hard` is safe ONLY because this dirty check just passed.
 */
async function checkedOutWorktree(repo: string, branch: string): Promise<string | null> {
  const wt = (await worktreeBranches(repo)).get(branch);
  if (!wt) return null;
  const status = await git(repo, ['status', '--porcelain'], { cwd: wt });
  if (status.stdout.trim() !== '') {
    throw new DriverHalt('dirty-worktree', `worktree for '${branch}' (${wt}) is dirty — refusing to move its ref`);
  }
  return wt;
}

async function journaledMerge(
  repo: string,
  branch: string,
  headSha: string,
  message: string,
  scope: Set<string>,
): Promise<string> {
  guardRef(branch, scope);
  const wt = await checkedOutWorktree(repo, branch); // B6/N1: dirty -> DriverHalt
  if (wt) {
    // Checked out CLEAN: use a real `git merge` in that worktree so its
    // index/working tree advance with the ref; never strand it mid-merge.
    const res = await git(repo, ['merge', '--no-edit', '-m', message, headSha], { cwd: wt, allowCodes: [1] });
    if (res.code !== 0) {
      await git(repo, ['merge', '--abort'], { cwd: wt, allowCodes: [1, 128] });
      throw new DriverHalt('merge-failed', `merge into checked-out '${branch}' hit a surprise conflict — aborted`);
    }
    return revParse(repo, branch);
  }
  try {
    return await commitTreeMerge(repo, branch, headSha, message);
  } catch (e) {
    // D-047/B11 backstop: cmdRun re-probes cleanliness against the LIVE tip
    // immediately before every parent merge (§3 execution re-probe), so a
    // conflicted tree is unreachable here in normal operation. Anything that
    // still throws (racing ref movement, update-ref CAS refusal) must surface
    // as a journaled per-branch halt — never escape as a bare Error and abort
    // the whole run (the 2026-07-21 crash mode).
    throw new DriverHalt(
      'merge-failed',
      `merge into '${branch}' failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * D-045 Feature A (§13) — one journaled origin-sync step per in-scope branch,
 * run by `run --execute` BEFORE the branch's first mutation this pass. The
 * driver never operates on refs/remotes directly: it reconciles the LOCAL
 * branch with `origin/<branch>` through the guardRef choke point, then all
 * merges target the local ref. Four states:
 *  - no local ref            → create the local branch at the origin tip
 *                              (journal `branch-materialized`; the §9 rollback
 *                              target is the creation point);
 *  - local strictly BEHIND   → fast-forward to origin (journal `branch-synced`;
 *                              checked-out worktrees use the N1 dirty-guard +
 *                              reset pattern);
 *  - local AHEAD of origin   → unpushed driver work: no action, no noise;
 *  - DIVERGED                → DriverHalt('sync-diverged') — external history
 *                              the driver cannot reconcile; the caller journals
 *                              it, skips the branch this pass and continues
 *                              with the others (owner escalation, doctrine).
 * `plan` and dry-run `run` never reach this function (no ref writes).
 */
async function syncBranchWithOrigin(
  cli: Cli,
  dir: string,
  branch: string,
  scope: Set<string>,
  preReffed: Set<string>,
): Promise<'no-origin' | 'up-to-date' | 'materialized' | 'synced' | 'ahead'> {
  const originRef = `origin/${branch}`;
  if (!(await refExists(cli.repo, originRef))) return 'no-origin';
  const originTip = await revParse(cli.repo, originRef);
  if (!(await localBranchExists(cli.repo, branch))) {
    guardRef(branch, scope);
    // CAS with the zero-oid ('' old value): the ref must not exist yet.
    await git(cli.repo, ['update-ref', `refs/heads/${branch}`, originTip, '']);
    appendJournal(dir, { action: 'branch-materialized', branch, tip: originTip });
    await recordPreRef(cli, dir, preReffed, branch); // §9 rollback target = creation point
    return 'materialized';
  }
  const localTip = await revParse(cli.repo, branch);
  if (localTip === originTip) return 'up-to-date';
  if (await isAncestor(cli.repo, originTip, localTip)) return 'ahead'; // unpushed driver work
  if (await isAncestor(cli.repo, localTip, originTip)) {
    guardRef(branch, scope);
    await recordPreRef(cli, dir, preReffed, branch); // pre-pass tip BEFORE the ff (§8)
    const wt = await checkedOutWorktree(cli.repo, branch); // dirty -> DriverHalt (N1)
    await git(cli.repo, ['update-ref', `refs/heads/${branch}`, originTip, localTip]);
    if (wt) await git(cli.repo, ['reset', '--hard', originTip], { cwd: wt }); // clean-verified above
    appendJournal(dir, { action: 'branch-synced', branch, from: localTip, to: originTip });
    return 'synced';
  }
  throw new DriverHalt(
    'sync-diverged',
    `'${branch}': local ${localTip.slice(0, 12)} and origin ${originTip.slice(0, 12)} have DIVERGED — ` +
      `external history the driver cannot reconcile; skipping the branch this pass (owner escalation)`,
  );
}

/** Commit a merge whose tree is the AGENT-RESOLVED tree (scope-guarded). */
async function journaledResolvedMerge(
  repo: string,
  branch: string,
  headSha: string,
  resolvedTree: string,
  message: string,
  scope: Set<string>,
): Promise<string> {
  guardRef(branch, scope);
  // N1: same checked-out safety as journaledMerge — a resolved-tree merge is
  // written via plumbing, so a clean checked-out worktree must FOLLOW the ref.
  const wt = await checkedOutWorktree(repo, branch);
  const tip = await revParse(repo, branch);
  const theirs = await revParse(repo, headSha);
  const commit = (await git(repo, ['commit-tree', resolvedTree, '-p', tip, '-p', theirs, '-m', message])).stdout.trim();
  await git(repo, ['update-ref', `refs/heads/${branch}`, commit, tip]);
  if (wt) await git(repo, ['reset', '--hard', commit], { cwd: wt }); // clean-verified above
  return commit;
}

// --------------------------------------------------------------------------
// Case artifacts.
// --------------------------------------------------------------------------

/**
 * The three BOUNDED cold-reader questions (D-050 — the owner: "make this cold
 * read very focused. It should not go researching the universe"). The old
 * open-ended Q4 ("follow-on invariants — tests, types, call sites") is deleted:
 * typecheck/tests are the verify gate's job (§9), not the reader's.
 */
const COLD_READ_QUESTIONS = [
  "1. Within the conflicted hunks, is each side's behaviour preserved or its loss explicitly justified? Name anything silently lost.",
  '2. Is every change in the resolution diff explained by the conflict — no content from outside the two sides/base? Name any unexplained hunk.',
  '3. Does the resolution contradict any record included in this request?',
];

/** D-050 preamble: the reader judges from the request ONLY — never researches. */
const COLD_READ_PREAMBLE = [
  'Judge ONLY from the materials in this request. Do NOT explore the repository or search',
  'beyond them. If something cannot be judged from the request, answer',
  'UNVERIFIABLE-FROM-REQUEST for that point instead of researching — the driver will treat',
  'it as a reject reason only if it concerns questions 1-3.',
];

/** Cap for embedded inventory extra_context excerpts (cold-read case context). */
const CONTEXT_EXCERPT_CAP = 2000;

/**
 * Per-side one-line histories over the conflicted paths: what each side did to
 * the disputed files since their merge base (`git log --oneline`, capped).
 * Driver-derived facts used by the case context block (§7, D-048) and
 * pr/materials.md.
 */
async function perSideLog(
  repo: string,
  branchTip: string,
  headSha: string,
  paths: string[],
): Promise<{ ours: string; theirs: string }> {
  const base = (await git(repo, ['merge-base', branchTip, headSha])).stdout.trim();
  const log = async (to: string): Promise<string> =>
    (await git(repo, ['log', '--oneline', '-20', `${base}..${to}`, '--', ...paths])).stdout.trimEnd() || '(no commits)';
  return { ours: await log(branchTip), theirs: await log(headSha) };
}

/**
 * Relevant inventory context for a case (D-048; used by BOTH cold reads): the
 * branch's and parent's entries plus any entry whose owned_paths or
 * extra_context mention a conflicted path — summary, owned_paths and the
 * recorded-decision excerpts, capped. Driver-authored from the registry, so
 * the resolving agent still cannot frame the question.
 */
function inventoryContextLines(features: FeatureEntry[], branch: string, parent: string, paths: string[]): string[] {
  const relevant = features.filter(
    (f) =>
      f.branch === branch ||
      f.branch === parent ||
      (f.owned_paths ?? []).some((glob) => paths.some((p) => p.startsWith(glob.replace(/\*.*$/, '')))) ||
      (f.prompt?.extra_context ? paths.some((p) => f.prompt!.extra_context!.includes(p)) : false),
  );
  if (relevant.length === 0) return ['(no matching inventory entries)'];
  const lines: string[] = [];
  for (const f of relevant) {
    lines.push(`- entry '${f.id}'${f.branch ? ` (branch ${f.branch})` : ''}: ${f.summary ?? f.name}`);
    if (f.owned_paths?.length) lines.push(`  owned_paths: ${f.owned_paths.join(', ')}`);
    const ctx = f.prompt?.extra_context?.trim();
    if (ctx)
      lines.push(
        `  extra_context: ${ctx.length > CONTEXT_EXCERPT_CAP ? `${ctx.slice(0, CONTEXT_EXCERPT_CAP)}…` : ctx}`,
      );
    if (f.prompt?.decided_paths?.length) lines.push(`  decided_paths: ${f.prompt.decided_paths.join(', ')}`);
  }
  return lines;
}

/**
 * The driver-derived case context block (D-048 fix for the 2026-07-21
 * context-starvation reject): the branch's inventory entry summary +
 * owned_paths + relevant extra_context excerpts, and per-side `git log
 * --oneline` over the conflicted paths, so the cold reader can answer
 * ownership questions instead of defaulting to reject. Driver-authored inputs
 * only — the resolving agent still cannot frame the question.
 */
async function caseContextLines(
  cli: Cli,
  c: { branch: string; parent: string; head: { sha: string }; conflictedPaths: string[] },
): Promise<string[]> {
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const tip = await revParse(cli.repo, c.branch);
  const sides = await perSideLog(cli.repo, tip, c.head.sha, c.conflictedPaths);
  return [
    '## Case context (driver-derived — D-048)',
    '',
    '### Inventory',
    ...inventoryContextLines(registry.features, c.branch, c.parent, c.conflictedPaths),
    '',
    `### ours (\`${c.branch}\`) — \`git log --oneline\` over the conflicted paths since the merge base`,
    '```',
    sides.ours,
    '```',
    '',
    `### theirs (\`${c.parent}\` head) — same range on the other side`,
    '```',
    sides.theirs,
    '```',
  ];
}

/**
 * The cold-read request (§7, D-031/D-050): conflict hunks + resolution diff +
 * the driver-derived case context (D-048 — inventory summary/owned_paths/
 * recorded decisions + per-side histories, so the reader can answer ownership
 * questions instead of defaulting to reject) + the judge-from-the-request-only
 * preamble + the three bounded cold-reader questions — NOTHING
 * agent-authored, so the resolving agent cannot frame the question. Written
 * twice: at case emission with the conflict hunks only (`resolutionDiff ===
 * null` — no resolution exists yet), then REGENERATED by every `resolve
 * --execute` attempt, before the verdict is consumed, with the resolution diff
 * (`git diff <automerge-tree> <resolved-tree>`) recomputed for THIS
 * resolution. The verdict freshness binding (resolvedTree) ensures a verdict
 * can only ever attest to the resolution the regenerated request shows.
 */
function coldReadRequest(
  c: { id: string; branch: string; parent: string; head: { height: number }; conflictedPaths: string[] },
  conflictDiff: string,
  resolutionDiff: string | null,
  contextLines: string[],
): string {
  return [
    `# Cold-read request — ${c.id}`,
    '',
    ...COLD_READ_PREAMBLE,
    '',
    `Branch: ${c.branch}   Parent: ${c.parent}   Height: ${c.head.height}`,
    `Conflicted paths: ${c.conflictedPaths.join(', ')}`,
    '',
    ...contextLines,
    '',
    '## Conflict hunks (branch tip -> automerge tree)',
    '```diff',
    conflictDiff,
    '```',
    '',
    '## Resolution diff (automerge tree -> resolved tree)',
    ...(resolutionDiff === null
      ? ['_No resolution attempt yet — `resolve` regenerates this file with the diff before requiring a verdict (§7)._']
      : ['```diff', resolutionDiff, '```']),
    '',
    '## Cold-reader questions',
    ...COLD_READ_QUESTIONS,
    '',
    '## Verdict',
    '',
    'Write `coldread-verdict.json` next to this file:',
    '```json',
    '{"verdict": "confirm|reject",',
    ' "answers": {"q1": "...", "q2": "...", "q3": "..."},',
    ' "notes": "...",',
    ' "feedback": "1-2 lines for the resolving agent: why the reject / what is off (omit when nothing is)",',
    ' "resolvedTree": "<tree OID of the resolution this verdict attests to>"}',
    '```',
    'An `UNVERIFIABLE-FROM-REQUEST` answer on any of q1-q3 is treated as a reject (fail-closed, D-050).',
  ].join('\n');
}

/**
 * D-052 FIX 2: every verdict error names the artifact to WRITE and forbids
 * deleting the request. The 2026-07-22 clean-run loop came from an agent told
 * "stale" deleting `coldread-request.md` (the wrong file — the stale one was the
 * VERDICT) and regenerating it, so the tree mismatch never cleared and the
 * delete/regenerate/re-read cycle ran unbounded. Naming the right file in the
 * message kills that ambiguity at the source.
 */
const COLDREAD_VERDICT_GUIDANCE =
  "Write coldread-verdict.json (attesting THIS resolution's tree). The driver regenerates " +
  'coldread-request.md automatically on every `resolve --execute`; NEVER delete coldread-request.md yourself.';

/**
 * D-052 FIX 3: anti-thrash cap (defense in depth, mirroring the kind-2 repro
 * cap). A resolution whose tree keeps CHANGING between attempts never
 * converges under cold read; beyond this many DISTINCT resolution trees the
 * driver stops retrying the case and force-freezes it HELD for the owner
 * rather than looping. Kept small — a genuine resolve converges in one or two.
 */
const RESOLVE_COLDREAD_CAP = 3;

/**
 * D-057: cold-read REJECTIONS per case before the driver stops retrying and
 * escalates to HELD (published via the unified active/draft path with the
 * warning prefix below). Tightens the distinct-tree cap above: two content
 * rejections mean the owner should look, not the agent loop.
 */
const COLDREAD_REJECT_LIMIT = 2;

/** Bound on the cold reviewer's 1-2 line `feedback` (D-057). */
const COLDREAD_FEEDBACK_CAP = 400;

/** PR-description warning prefixes for HELD escalations (owner-facing). */
const ESCALATE_REJECTED_2X = '[AUTO-ESCALATED: cold read rejected 2x]';
const ESCALATE_SCOPE = '[AUTO-ESCALATED: scope exceeded]';
const ESCALATE_CAP = '[AUTO-ESCALATED: resolution did not converge]';

/** A HELD escalation carried from freeze to publish (D-057): prefix tag + the
 * cold reviewer's short feedback, prepended to the PR description. */
interface HeldEscalation {
  tag: string;
  feedback: string | null;
}

/** Bounded reviewer feedback out of a verdict-ish object (D-057). */
function boundedFeedback(v: { feedback?: unknown }): string | null {
  return typeof v.feedback === 'string' && v.feedback.trim() !== ''
    ? v.feedback.trim().slice(0, COLDREAD_FEEDBACK_CAP)
    : null;
}

/**
 * Cold-read REJECTIONS of the RESOLUTION journaled for a case (fail-closed
 * UNVERIFIABLE counts). A `defect: 'description'` rejection means the
 * resolution is SOUND and only the PR prose is wrong — that is a rewrite
 * instruction, NEVER a code-reject strike toward COLDREAD_REJECT_LIMIT, so it
 * is excluded here (D-057 #4: only resolution rejections escalate to HELD).
 */
function coldReadRejectionCount(journal: JournalEntry[], caseId: string): number {
  return journal.filter(
    (e) => e.action === 'coldread' && e.caseId === caseId && e.rejected === true && e.defect !== 'description',
  ).length;
}

/**
 * The CLEAN-PREFIX tree (owner directive 2026-07-22, D-057): the automerge tree
 * with every conflicted path reset to its `baseTip` (ours) blob — i.e. all of
 * the merge that landed cleanly, and NONE of the conflict. Committing THIS as
 * the case worktree's HEAD (see `createCaseWorktree`) makes the conflicted paths
 * the ONLY pending change in the worktree: `git status` = exactly the conflict,
 * so the agent reviews only the conflicting delta, never the ~750-file
 * accumulated merge (the per-case context blowup, handover §3.1).
 *
 * Built in a throwaway index (never the repo index): read the automerge tree,
 * then for each conflicted path splice in the baseTip version — its blob when
 * baseTip has it, a removal when it does not (a path added on `theirs`). The
 * non-conflicted entries are left exactly as the automerge tree has them, so
 * the prefix tree equals the automerge tree everywhere OUTSIDE the conflict.
 */
async function cleanPrefixTree(
  repo: string,
  automergeTree: string,
  baseTip: string,
  conflictedPaths: string[],
): Promise<string> {
  const idxFile = join(mkdtempSync(join(tmpdir(), 'sweep-idx-')), 'index');
  const env = { GIT_INDEX_FILE: idxFile };
  try {
    await git(repo, ['read-tree', automergeTree], { env });
    for (const p of conflictedPaths) {
      const ls = await git(repo, ['ls-tree', baseTip, '--', p], { allowCodes: [1, 128] });
      const line = ls.code === 0 ? ls.stdout.trim() : '';
      if (line) {
        // "<mode> <type> <sha>\t<path>" — splice baseTip's blob into the index.
        const [meta] = line.split('\t');
        const [mode, , sha] = meta.split(/\s+/);
        await git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${p}`], { env });
      } else {
        // Added on `theirs` (absent in baseTip): the clean prefix does not carry
        // it — its whole content is the conflict, so it stays a pending add.
        await git(repo, ['update-index', '--force-remove', p], { env });
      }
    }
    return (await git(repo, ['write-tree'], { env })).stdout.trim();
  } finally {
    rmSync(dirname(idxFile), { recursive: true, force: true });
  }
}

/**
 * Driver-created resolution worktree (SPEC 1; D-057 pending-diff shape): a
 * detached worktree at <passdir>/<caseid>/worktree whose HEAD is the CLEAN
 * PREFIX commit (all of the merge that landed cleanly — `cleanPrefixTree`),
 * parented on the branch tip; the conflicted paths are then written into the
 * WORKING TREE (unstaged) with their automerge (conflict-marker) content. The
 * result: `git status` shows ONLY the conflicted paths as pending, so the agent
 * resolves just that delta — not the whole accumulated merge (handover §3.1,
 * owner directive: "commit all before the conflict; the agent reviews ONLY the
 * pending files"). The on-disk bytes and the `add -A; write-tree` snapshot are
 * IDENTICAL to a full automerge-tree checkout (prefix == automerge outside the
 * conflict; the conflicted files are overwritten back to automerge content), so
 * the empty-resolution check, scope guard and cold-read diff (all vs
 * `automergeTree`) are unaffected — only what is committed vs pending changes.
 * Best-effort — on failure journal a warning and continue (the case is still
 * resolvable via an agent-made worktree).
 *
 * D-059 (reissue): `contentSource` overrides WHERE the pending files' on-disk
 * content comes from (default: the automerge tree — the fresh conflict with
 * markers). A REISSUE case passes the origin fix/sweep ref head so the agent
 * edits the PRIOR RESOLUTION (revises it per the owner's PR comments) instead
 * of re-resolving the raw conflict. Everything else (prefix HEAD, pending
 * status, snapshot/scope-guard vs automergeTree) is identical.
 */
async function createCaseWorktree(
  cli: Cli,
  dir: string,
  caseFile: CaseFile,
  baseTip: string,
  contentSource?: string,
): Promise<void> {
  const wtPath = join(dir, caseFile.id, 'worktree');
  try {
    const prefixTree = await cleanPrefixTree(cli.repo, caseFile.automergeTree, baseTip, caseFile.conflictedPaths);
    const prefixCommit = (
      await git(cli.repo, [
        'commit-tree',
        prefixTree,
        '-p',
        baseTip,
        '-m',
        `clean prefix for ${caseFile.id} — conflict pending in: ${caseFile.conflictedPaths.join(', ')}`,
      ])
    ).stdout.trim();
    // Idempotent (D-057): a case RE-EMITTED after a reopen may leave a stale
    // worktree registration and/or dir at this path — `worktree add` then fails
    // with "missing but already registered" or "already exists", stranding the
    // case with no worktree. Clear both (registration via remove+prune, dir via
    // rm) before re-adding so re-emission always yields a fresh worktree.
    await git(cli.repo, ['worktree', 'remove', '--force', wtPath], { allowCodes: [1, 128] });
    await git(cli.repo, ['worktree', 'prune'], { allowCodes: [1, 128] });
    rmSync(wtPath, { recursive: true, force: true });
    await git(cli.repo, ['worktree', 'add', '--detach', wtPath, prefixCommit]);
    // Materialize the conflicted paths as PENDING working-tree changes: write the
    // automerge (marker) blob to disk without staging, or delete the file when the
    // automerge tree dropped it (delete/modify conflict), so `git status` = exactly
    // the conflict. The index still holds the prefix (ours) version — hence pending.
    const source = contentSource ?? caseFile.automergeTree;
    for (const p of caseFile.conflictedPaths) {
      const abs = join(wtPath, p);
      const blob = await git(cli.repo, ['cat-file', '-p', `${source}:${p}`], { allowCodes: [128] });
      if (blob.code === 0) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, blob.stdout);
      } else {
        rmSync(abs, { force: true });
      }
    }
    // Shared rerere (D-006, D-049 §4): install the workspace rr-cache into the
    // shared .git so rerere-enabled operations in the case worktree see the
    // recorded resolutions. Best-effort, like the worktree itself.
    const seeded = await installRrCache(cli.repo, join(cli.workspace, RR_CACHE_DIRNAME));
    appendJournal(dir, {
      action: 'case-worktree',
      caseId: caseFile.id,
      path: wtPath,
      rerereSeeded: seeded,
      pendingPaths: caseFile.conflictedPaths,
      ...(contentSource ? { contentSource } : {}),
    });
  } catch (e) {
    appendJournal(dir, {
      action: 'warning',
      caseId: caseFile.id,
      message: `case worktree creation failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** Remove a case's resolution worktree (journaled) once it is resolved/held. */
async function removeCaseWorktree(cli: Cli, dir: string, caseId: string): Promise<void> {
  const wtPath = join(dir, caseId, 'worktree');
  if (!existsSync(wtPath)) return;
  await git(cli.repo, ['worktree', 'remove', '--force', wtPath], { allowCodes: [1, 128] });
  appendJournal(dir, { action: 'worktree-removed', caseId });
}

// --------------------------------------------------------------------------
// Subcommands.
// --------------------------------------------------------------------------

/**
 * D-054: the single machine-readable guidance line for a state-machine command
 * (SWEEP-STATE-MACHINE.md §2), written to STDOUT with the exact prefix
 * `SWEEP-RESULT: ` (compact one-line JSON) — mirrors `progress`. The five
 * commands (+ abort) call this DIRECTLY, so exactly ONE line is produced per
 * command; the two-prefix contract is then unambiguous for a backgrounded
 * next-case/finish: `SWEEP-STEP:` = relay, `SWEEP-RESULT:` = parse + act,
 * anything else = ignore (no "last JSON wins" guessing). `--out` still gets the
 * pretty JSON for file/machine consumers (and the existing test fixtures).
 */
function result(cli: Cli, artifact: unknown): void {
  process.stdout.write(`SWEEP-RESULT: ${JSON.stringify(artifact)}\n`);
  if (cli.out) writeFileSync(cli.out, JSON.stringify(artifact, null, 2) + '\n');
}

function emit(cli: Cli, artifact: unknown): void {
  // D-054: a flag command run INTERNALLY by a state-machine command
  // (next-case→run, finish→verify/publish/push) produces no output — only the
  // outer command emits its single SWEEP-RESULT line.
  if (cli.internal) return;
  const json = JSON.stringify(artifact, null, 2);
  if (cli.out) {
    writeFileSync(cli.out, json + '\n');
    console.log(`wrote ${cli.out}`);
  } else {
    console.log(json);
  }
}

/**
 * D-054 observability: a MAJOR-STEP progress line for a running sweep, written to
 * STDOUT with the exact prefix `SWEEP-STEP: ` and flushed immediately (never
 * buffered to exit — `process.stdout.write` emits at the call site so the owner
 * sees the sweep advance live while a long next-case/finish runs in the
 * background). Distinct from the single `SWEEP-RESULT:` line (see `result`): the
 * two prefixes cleanly separate live progress (statements the agent relays) from
 * the one JSON result the agent parses and acts on. MAJOR transitions ONLY
 * (~a dozen lines per pass), never per-action/per-file: batch clean merges into
 * one summary line, keep it low-frequency.
 */
function progress(msg: string): void {
  process.stdout.write(`SWEEP-STEP: ${msg}\n`);
}

export async function cmdPlan(cli: Cli): Promise<number> {
  // Only `plan` opens a pass. The opening snapshot (plan-initial.json) is
  // immutable; the equivalence "halt loudly" check lives in `run`, not here —
  // a pass with journal activity legitimately derives differently now (§8).
  const ctx = await openPass(cli);
  const dir = ctx.dir;
  // Blocked state is journal-derived (D-058): `sweep start` reconstructs the
  // PR_ID set from origin and journals `origin-blocked` rows BEFORE plan runs;
  // there is no local reconcile step anymore — origin is the authority.
  const journal = readJournal(dir);
  // Urges are only DETECTED here; posting is `push`'s job (D-049, §14.4).
  const dueUrges = await detectUrges(cli, ctx, journal);
  if (dueUrges.length) {
    console.error(`urges due (post via \`propagate push --execute\`): ${dueUrges.map((u) => u.branch).join(', ')}`);
  }
  const plan = await derive(cli, await prBlockedRecords(cli, journal, ctx.chain), ctx, passStatusView(cli, journal));

  const initialPath = join(dir, 'plan-initial.json');
  if (!existsSync(initialPath)) {
    writeJsonFile(initialPath, plan);
    console.error(`pass opened: ${dir} (watermark ${plan.watermark12}, ${plan.branches.length} branches)`);
  } else {
    const initial = JSON.parse(readFileSync(initialPath, 'utf8')) as PropagationPlan;
    const touched = new Set([
      ...arrivedSet(journal),
      ...journal.filter((e) => e.action === 'reopened').map((e) => e.branch as string),
    ]);
    const drift = plansDiffer(initial, plan, touched);
    console.error(
      drift.length
        ? `pass already open; ${drift.length} branch(es) differ from the opening snapshot (post-activity is expected): ${drift.join(', ')}`
        : `pass already open; derivation matches the opening snapshot`,
    );
  }
  writeJsonFile(join(dir, 'plan.json'), plan);

  // D-045 Feature B (§13): candidate discovery. Writing the per-candidate YAML
  // + candidates.json + journal `candidate` entries from `plan` is the
  // documented exception to plan purity — derived REPORT state, never git refs.
  // Candidates are never planned or merged; the printed section is the agent's
  // relay duty to the owner (doctrine).
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const candidateRecords = await deriveCandidates({
    repo: cli.repo,
    chain: ctx.chain,
    features: registry.features,
    scope: registry.scope,
  });
  const entryBranches = new Set(registry.features.filter((f) => f.branch).map((f) => f.branch!));
  const rec = reconcileCandidates(cli.workspace, candidateRecords, entryBranches, ctx.watermark12);
  for (const { record, event } of rec.events) {
    appendJournal(dir, {
      action: 'candidate',
      event,
      branch: record.branch,
      tip: record.tip,
      confidence: record.confidence,
    });
  }
  for (const r of rec.resolved) {
    appendJournal(dir, { action: 'candidate', event: 'resolved', branch: r.branch, reason: r.reason });
  }
  writeJsonFile(join(dir, 'candidates.json'), {
    schemaVersion: 1,
    watermark12: ctx.watermark12,
    candidates: rec.all,
    newlyReported: rec.events.map((e) => e.record.branch),
    resolved: rec.resolved,
    standingInstruction: CANDIDATE_STANDING_INSTRUCTION,
  });
  for (const line of candidateSectionLines(
    rec.events.map((e) => e.record),
    rec.resolved,
  ))
    console.error(line);

  emit(cli, plan);
  return 0;
}

export async function cmdRun(cli: Cli): Promise<number> {
  const ctx = await passContext(cli); // attaches to the open pass
  const { chain, dir } = ctx;

  // DRY-RUN PURITY (N4): without --execute, NO state changes of ANY kind — no
  // urge artifacts, no ledger/journal writes, no merges. Report what WOULD
  // happen (detect-only) and return.
  if (!cli.execute) {
    const journal0 = readJournal(dir);
    const plan0 = await derive(cli, await prBlockedRecords(cli, journal0, ctx.chain), ctx, passStatusView(cli, journal0));
    const wouldUrge = (await detectUrges(cli, ctx, journal0)).map((u) => ({ branch: u.branch, head: u.head }));
    console.error('DRY-RUN (no --execute): no state changes; reporting the plan + would-urge');
    emit(cli, { dryRun: true, plan: plan0, wouldUrge });
    return 0;
  }

  // EXECUTE. Repo-wide rerere first (D-050, owner (b) 2026-07-22): BEFORE the
  // first mutation, idempotently enable rerere in the agent clone so every
  // merge — driver or case worktree — records/replays resolutions. Journaled
  // once, only when the value actually changes.
  const rr = await git(cli.repo, ['config', '--get', 'rerere.enabled'], { allowCodes: [1] });
  if (rr.stdout.trim() !== 'true') {
    await git(cli.repo, ['config', 'rerere.enabled', 'true']);
    appendJournal(dir, { action: 'rerere-enabled', repo: cli.repo });
  }
  // Blocked state is journal-derived (D-058): the origin-derived PR_ID rows
  // were journaled by `sweep start`; there is no local reconcile step. Urges
  // are only DETECTED (posting is `push`'s job — D-049, §14.4).
  {
    const due = await detectUrges(cli, ctx, readJournal(dir));
    if (due.length) {
      console.error(`urges due (post via \`propagate push --execute\`): ${due.map((u) => u.branch).join(', ')}`);
    }
  }
  // B5i crash-heal BEFORE reading pass state: close ref-updated-but-journal-
  // missing cases (synthetic `resolved` + `reopened`) so the loop below
  // re-derives the branch instead of leaving it open forever.
  await crashHeal(cli, dir, readJournal(dir));
  const journal = readJournal(dir);
  const statusView = passStatusView(cli, journal);
  const blockedSet = new Set(statusView.keys()); // merge_status != NONE (PR_ID ∪ DEFERRED)
  const held = await prBlockedRecords(cli, journal, ctx.chain); // PR_ID block heights, live-derived (§5/N3 → D-058)
  const plan = await derive(cli, held, ctx, statusView);
  const passHasProgress = plan.chainLength > 0;
  const scope = new Set(plan.branches.map((b) => b.branch));

  // Plan-equivalence guard (§8): the live re-derivation must match the pass's
  // LAST written plan for branches not yet processed and not reopened this pass
  // — a mismatch means git moved under us. (Arrived/reopened/frozen branches
  // legitimately differ.) Then update the working plan.json.
  const arrived = arrivedSet(journal);
  const reopened = new Set(journal.filter((e) => e.action === 'reopened').map((e) => e.branch as string));
  // Branches this pass already materialized/ff-synced from origin (§13): their
  // tips legitimately moved relative to the last written plan.
  const syncedBranches = new Set(
    journal
      .filter((e) => e.action === 'branch-materialized' || e.action === 'branch-synced')
      .map((e) => e.branch as string),
  );
  // D-047/B11: branches the DRIVER itself already mutated or demoted this pass
  // (a journaled `merge` or `case`) legitimately derive differently from the
  // last written plan — the §3 execution re-probe's merge→case/skip demotion
  // is a sanctioned transition, and a crash between the journal entry and the
  // branch's `arrived` must not read as "git moved under us" (same rationale
  // as the branch-synced exclusion above).
  const driverTouched = new Set(
    journal
      .filter((e) => (e.action === 'merge' || e.action === 'case') && typeof e.branch === 'string')
      .map((e) => e.branch as string),
  );
  const planPath = join(dir, 'plan.json');
  if (existsSync(planPath)) {
    const prev = JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan;
    // merge_status transitions are sanctioned derivation changes (D-058): a
    // branch manually unfrozen this pass legitimately derives differently
    // from the last written plan.
    const statusCleared = new Set(
      journal
        .filter((e) => e.action === 'unfrozen' && typeof e.branch === 'string')
        .map((e) => e.branch as string),
    );
    const exclude = new Set([...arrived, ...reopened, ...blockedSet, ...statusCleared, ...syncedBranches, ...driverTouched]);
    const drift = plansDiffer(prev, plan, exclude);
    if (drift.length) {
      // §14 (D-048): DriverHalt reasons surface under the machine-readable id
      // scheme in CLI output; the human text stays in `detail`/the journal.
      const detail = `git moved under us — plan drift for not-yet-processed branch(es): ${drift.join(', ')}`;
      appendJournal(dir, { action: 'halt', reason: 'plan-drift', id: 'ERR24_PLAN_DRIFT', branches: drift });
      console.error(`HALT [ERR24_PLAN_DRIFT]: ${detail}`);
      emit(cli, { ok: false, issues: [{ id: 'ERR24_PLAN_DRIFT', detail }] });
      return 1;
    }
  }
  writeJsonFile(planPath, plan);

  // Reconstruct the DAG edges + entry set from the snapshot (for live un-skip).
  const edges: Record<string, string[]> = {};
  for (const b of plan.branches) {
    const ps = b.parents.filter((p) => p.model === 'parents').map((p) => p.parent);
    if (ps.length) edges[b.branch] = ps;
  }
  const entrySet = new Set(
    plan.branches.filter((b) => (b.parents[0]?.model ?? 'entry') === 'entry').map((b) => b.branch),
  );
  const heldSet = new Set([...statusView.entries()].filter(([, s]) => s === 'PR_ID').map(([b]) => b));
  const preReffed = preReffedSet(journal);

  // D-057 block-height map for the LIVE execution path (mirrors derivePlan): every
  // blocked branch (merge_status != NONE) with its block-height, seeded from the
  // blocked set and GROWN as branches defer in DAG order — deriveLive and the §3
  // re-probe use it for the height-MIN DEFER over blocked DIRECT parents. Without
  // it the live re-derivation loses the defer that plan.json computed. PR_ID
  // heights come re-derived from the stored head sha (`held`); DEFERRED branches
  // that ALREADY ARRIVED this pass (they will not be re-processed below) seed
  // from their live-probed plan rows — heights are never read from merge_status.
  const blockHeightOf = new Map<string, number>();
  for (const h of held) blockHeightOf.set(h.branch, h.height);
  for (const bp of plan.branches) {
    if (!arrived.has(bp.branch) || statusView.get(bp.branch) !== 'DEFERRED') continue;
    const hs = bp.parents.filter((pp) => pp.verdict === 'defer' && pp.deferHeight !== undefined).map((pp) => pp.deferHeight!);
    if (hs.length && !blockHeightOf.has(bp.branch)) blockHeightOf.set(bp.branch, Math.min(...hs));
  }
  const recordDefer = (branch: string, deferHeight?: number): void => {
    if (deferHeight !== undefined) blockHeightOf.set(branch, Math.min(deferHeight, blockHeightOf.get(branch) ?? Infinity));
  };

  let gated = false;
  const diverged: string[] = [];
  const mergeFailed: string[] = [];
  /** §14 (D-048): this run's per-branch halts under the ERR2x id scheme (CLI output). */
  const issues: Issue[] = [];

  try {
    for (const snap of plan.branches) {
      if (arrived.has(snap.branch)) continue; // already processed this pass (resume)

      // D-045 Feature A (§13): reconcile the local branch with origin BEFORE its
      // first mutation this pass. DIVERGED hard-halts THIS branch only (journaled,
      // skipped, reported) — siblings keep processing; any other DriverHalt
      // (dirty worktree, protected ref) still halts the whole run below.
      try {
        await syncBranchWithOrigin(cli, dir, snap.branch, scope, preReffed);
      } catch (e) {
        if (e instanceof DriverHalt && e.reason === 'sync-diverged') {
          appendJournal(dir, {
            action: 'halt',
            branch: snap.branch,
            reason: e.reason,
            id: 'ERR20_BRANCH_DIVERGED',
            message: e.message,
          });
          appendJournal(dir, { action: 'skip', branch: snap.branch, reason: 'diverged' });
          appendJournal(dir, { action: 'arrived', branch: snap.branch });
          arrived.add(snap.branch);
          diverged.push(snap.branch);
          issues.push({ id: 'ERR20_BRANCH_DIVERGED', detail: e.message });
          console.error(`DIVERGED [ERR20_BRANCH_DIVERGED] (branch skipped): ${e.message}`);
          continue;
        }
        throw e;
      }

      // Live merge_status dispatch (D-058; the JOURNAL is re-read per branch so
      // a mid-loop hold/defer of an earlier sibling is visible).
      const viewNow = passStatusView(cli, readJournal(dir));
      const stNow = viewNow.get(snap.branch) ?? null;

      // PR_ID (held, awaiting the owner) arrives with an EMPTY interval —
      // descendants may proceed and DEFERRED re-evaluates, but we do not
      // re-emit its own case (the block clears only when the owner's PR merge
      // lands on origin — the next `start` derives it unblocked).
      if (heldSet.has(snap.branch) || stNow === 'PR_ID') {
        appendJournal(dir, { action: 'skip', branch: snap.branch, reason: 'held' });
        appendJournal(dir, { action: 'arrived', branch: snap.branch });
        arrived.add(snap.branch);
        continue;
      }

      // Re-derive THIS branch against LIVE tips so a child sees its parents'
      // just-merged tips (breadth-wise cascade, like merge.ts probes live sources).
      // The same derivation is reused by the §3 execution re-probe below when a
      // per-parent verdict goes stale mid-branch (D-047/B11).
      const model: 'entry' | 'parents' = snap.parents[0]?.model ?? 'entry';
      const deriveLive = (mergeBlocked?: { state: 'DEFERRED'; behind: string }): Promise<BranchPlan> =>
        deriveBranch({
          repo: cli.repo,
          branch: snap.branch,
          kind: snap.kind,
          model,
          parents: snap.parents.map((p) => p.parent),
          chain,
          ancestors: snap.ancestors,
          tierFloor: snap.tierFloor,
          isLeaf: snap.isLeaf,
          alwaysMerge: snap.alwaysMerge,
          held,
          blockHeightOf,
          stackCap: snap.stackCap, // effective cap resolved at plan derivation (D-049 §2)
          mergeBlocked,
        });

      // DEFERRED (D-057 STAY, D-058 source): sticky while ANY direct parent is
      // still blocked — the branch takes nothing this pass; its own conflict
      // height is re-probed live so its children's height-MIN keeps working.
      // The journal-fixpoint view (`passStatusView`) already dropped branches
      // whose parents all cleared, so a DEFERRED verdict here always has a
      // blocked parent; a cleared branch simply derives fresh below.
      if (stNow === 'DEFERRED') {
        const blockedParents = snap.parents.map((p) => p.parent).filter((p) => viewNow.has(p));
        if (blockedParents.length > 0) {
          const behind = blockedParents.reduce((lo, p) =>
            (blockHeightOf.get(p) ?? Infinity) < (blockHeightOf.get(lo) ?? Infinity) ? p : lo,
          );
          const bpSticky = await deriveLive({ state: 'DEFERRED', behind });
          for (const pp of bpSticky.parents) {
            if (pp.verdict !== 'defer') continue;
            appendJournal(dir, { action: 'defer', branch: snap.branch, parent: pp.parent, deferredTo: pp.deferredTo });
            recordDefer(snap.branch, pp.deferHeight);
          }
          appendJournal(dir, { action: 'skip', branch: snap.branch, reason: 'deferred' });
          appendJournal(dir, { action: 'arrived', branch: snap.branch });
          arrived.add(snap.branch);
          continue;
        }
      }

      const bp = await deriveLive();

      // Leaf / always_merge un-skip (§6): if every parent no-op'd in a pass that
      // carries progress, force (empty) merges along the cheapest parent chain.
      // D-057: the chain must not merge into/through a branch whose merge_status
      // != NONE (PR_ID | DEFERRED) — blocked branches are excluded from the
      // LIVE search here (statuses may have changed mid-pass), so a blocked
      // intermediate aborts the un-skip instead of being force-merged past its
      // block. No unblocked chain = the leaf stays skipped this pass.
      if ((bp.isLeaf || bp.alwaysMerge) && passHasProgress && allParentsSkipped(bp)) {
        const blockedLive = new Set(passStatusView(cli, readJournal(dir)).keys());
        const uchain = shortestUnskipChain(bp.branch, edges, entrySet, blockedLive);
        if (uchain.length < 2 && shortestUnskipChain(bp.branch, edges, entrySet).length >= 2) {
          // An entry IS reachable, but only through blocked hops: the un-skip
          // is ABORTED (never force-merge past a block). Mark the rows so the
          // step verifier's leaf rule knows this all-skip is sanctioned.
          for (const pp of bp.parents) {
            if (pp.verdict === 'skip' || pp.verdict === 'up-to-date') pp.skipReason = 'unskip-blocked';
          }
        }
        if (uchain.length >= 2) {
          bp.unskipChain = uchain;
          // Force the upstream hops (all but the leaf's own), top-down.
          for (let i = uchain.length - 2; i >= 1; i--) {
            const child = uchain[i];
            const parent = uchain[i + 1];
            const pt = await revParse(cli.repo, parent);
            await recordPreRef(cli, dir, preReffed, child);
            const nr = await journaledMerge(
              cli.repo,
              child,
              pt,
              `Merge ${parent} into ${child} (propagation, forced no-op)`,
              scope,
            );
            appendJournal(dir, { action: 'merge', branch: child, parent, forced: true, newRef: nr });
          }
          // Mark the leaf's direct-parent merge forced.
          const parent = uchain[1];
          const pt = await revParse(cli.repo, parent);
          const height = (await deriveCoverage(cli.repo, chain, pt)).height;
          const pp = bp.parents.find((p) => p.parent === parent);
          if (pp) {
            pp.verdict = 'merge';
            pp.forced = true;
            pp.mergePoint = { sha: pt, height };
            pp.skipReason = null;
          }
        }
      }

      const step = buildStepFile(bp, plan.watermark);
      writeJsonFile(join(dir, `step-${bp.branch.replace(/\//g, '__')}.json`), step);

      const branchTip = await revParse(cli.repo, bp.branch);
      const verdict = await verifyStepFile(cli.repo, step, {
        chain,
        branchTip,
        arrivedParents: arrived,
        passHasProgress,
      });
      if (!verdict.ok) {
        appendJournal(dir, {
          action: 'halt',
          branch: bp.branch,
          reason: 'step-verification-failed',
          errors: verdict.errors,
        });
        console.error(`HALT: step verification failed for ${bp.branch}:\n  ${verdict.errors.join('\n  ')}`);
        return 1;
      }

      /**
       * Emit a case, RECOMPUTING the automerge tree + conflicted paths against the
       * branch's CURRENT tip (after any clean-prefix merge this iteration) so the
       * recorded values match what resolve re-derives — the sha-labelled automerge
       * tree (§3 determinism) depends on the ours tip, which the prefix merge
       * advanced. If the conflict has HEALED post-merge, emit no case. Returns
       * whether a case was emitted (i.e. the branch gates).
       */
      const emitCase = async (pp: (typeof bp.parents)[number]): Promise<boolean> => {
        const nowTip = await revParse(cli.repo, bp.branch);
        const probe = await newStyleMergeTree(cli.repo, nowTip, pp.case!.head.sha);
        if (probe.clean) {
          appendJournal(dir, { action: 'case-healed', branch: bp.branch, parent: pp.parent, head: pp.case!.head });
          return false;
        }
        const caseFile: CaseFile = {
          schemaVersion: 1,
          id: caseId(bp.branch, pp.parent, pp.case!.head.height), // B8: branch+PARENT+height (run TOP)
          branch: bp.branch,
          parent: pp.parent,
          head: pp.case!.head, // the run's TOP commit (D-049 §2)
          run: pp.case!.run,
          tierFloor: bp.tierFloor,
          conflictedPaths: probe.conflictFiles,
          automergeTree: probe.treeOid,
          reproduction: pp.case!.reproduction,
          deferredCheck: { firstConflictHeight: pp.case!.head.height, transitiveAncestors: bp.ancestors },
        };
        const caseDir = join(dir, caseFile.id);
        writeJsonFile(join(caseDir, 'case.json'), caseFile);
        const diffText = await git(
          cli.repo,
          ['diff', nowTip, caseFile.automergeTree, '--', ...caseFile.conflictedPaths],
          {
            allowCodes: [1],
          },
        );
        writeFileSync(
          join(caseDir, 'coldread-request.md'),
          // Resolution diff added at resolve (§7); D-048 context block included
          // from emission so the reader is never context-starved.
          coldReadRequest(caseFile, diffText.stdout.slice(0, 60000), null, await caseContextLines(cli, caseFile)),
        );
        appendJournal(dir, {
          action: 'case',
          branch: bp.branch,
          parent: pp.parent,
          caseId: caseFile.id,
          head: caseFile.head, // sha recorded for the B5i crash-heal ancestry check
          height: caseFile.head.height,
          run: caseFile.run, // the stacked run (D-049 §2)
          conflictedPaths: caseFile.conflictedPaths,
        });
        await createCaseWorktree(cli, dir, caseFile, nowTip); // SPEC 1: agent resolves here
        return true;
      };

      let branchGated = false;
      try {
        for (let pi = 0; pi < bp.parents.length; pi++) {
          let pp = bp.parents[pi];
          if (branchGated) break; // halt at first case needing judgment per branch
          // Execution re-probe (§3/§8, D-047/B11): each per-parent verdict above
          // was probed against the branch tip AT DERIVATION, but parents merge
          // SEQUENTIALLY — once an earlier parent's merge advances the tip, a
          // later parent's clean `merge` verdict is stale (executing it blind is
          // what crashed the 2026-07-21 sweep). Re-probe against the CURRENT tip
          // (pinned SHAs, §3 determinism); on staleness re-derive the parent row
          // live and demote as found: conflicted → case (conflict set + automerge
          // tree recomputed from the current tip), tree-equal → skip (§6 no-op).
          // Forced (empty) merges are exempt: they exist only when every parent
          // no-op'd, so the tip has not moved (§6).
          if (pp.verdict === 'merge' && !pp.forced && pp.mergePoint) {
            const nowTip = await revParse(cli.repo, bp.branch);
            const reprobe = await newStyleMergeTree(cli.repo, nowTip, pp.mergePoint.sha);
            if (!reprobe.clean || reprobe.treeOid === (await treeOf(cli.repo, nowTip))) {
              const repp = (await deriveLive()).parents.find((p) => p.parent === pp.parent);
              if (repp) {
                appendJournal(dir, {
                  action: 'demoted',
                  branch: bp.branch,
                  parent: pp.parent,
                  from: 'merge',
                  to: repp.verdict,
                  staleHead: pp.mergePoint,
                  conflictedPaths: reprobe.clean ? [] : reprobe.conflictFiles,
                });
                bp.parents[pi] = repp;
                pp = repp; // dispatch the FRESH verdict below (merge/case/defer/skip)
              }
            }
          }
          if (pp.verdict === 'merge') {
            const label = pp.model === 'entry' ? `main@height${pp.mergePoint!.height}` : pp.parent;
            const msg = `Merge ${label} into ${bp.branch} (propagation${pp.forced ? ', forced no-op' : ''})`;
            await recordPreRef(cli, dir, preReffed, bp.branch);
            const newRef = await journaledMerge(cli.repo, bp.branch, pp.mergePoint!.sha, msg, scope);
            appendJournal(dir, {
              action: 'merge',
              branch: bp.branch,
              parent: pp.parent,
              head: pp.mergePoint,
              forced: pp.forced ?? false,
              newRef,
            });
            // Annotate-class (§1, D-002): a CLEAN merge passing THROUGH a height a
            // transitive ancestor is HELD on — never gates, surfaced in the report.
            if (pp.annotate) {
              appendJournal(dir, {
                action: 'annotate',
                branch: bp.branch,
                parent: pp.parent,
                heldAncestor: pp.annotate.heldAncestor,
                height: pp.annotate.height,
              });
            }
            // A clean prefix can merge while the conflict ABOVE it is DEFERRED to a
            // blocked DIRECT parent (§5): record the defer pointer — the journaled
            // `defer` row IS the DEFERRED state (D-058), so blocked(X) holds in the
            // derived view from this moment.
            if (pp.deferredTo) {
              appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
              recordDefer(bp.branch, pp.deferHeight);
            }
            // A clean merge up to the merge point can still leave a conflict ABOVE
            // it (§3 step 4): emit the case (recomputed post-merge) and halt.
            if (pp.case && (await emitCase(pp))) {
              branchGated = true;
              gated = true;
            }
          } else if (pp.verdict === 'defer') {
            // BECOME DEFERRED (D-057): the journaled `defer` row is the state
            // (D-058) — the branch is blocked in the derived view from now on.
            appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
            recordDefer(bp.branch, pp.deferHeight);
          } else if (pp.verdict === 'case') {
            if (await emitCase(pp)) {
              branchGated = true;
              gated = true;
            }
          } else {
            appendJournal(dir, {
              action: 'skip',
              branch: bp.branch,
              parent: pp.parent,
              reason: pp.skipReason ?? pp.verdict,
            });
          }
        }
      } catch (e) {
        // D-047/B11: a merge write that STILL fails (journaledMerge's backstop —
        // racing ref movement, CAS refusal; a conflicted tree is unreachable
        // after the re-probe above) halts THIS branch only, journaled, like
        // sync-diverged — siblings keep processing and the branch arrives for the
        // barrier with whatever prefix landed. Every other DriverHalt (dirty
        // worktree, protected ref) still halts the whole run below.
        if (!(e instanceof DriverHalt) || e.reason !== 'merge-failed') throw e;
        appendJournal(dir, {
          action: 'halt',
          branch: bp.branch,
          reason: e.reason,
          id: 'ERR21_MERGE_FAILED',
          message: e.message,
        });
        mergeFailed.push(bp.branch);
        issues.push({ id: 'ERR21_MERGE_FAILED', detail: e.message });
        console.error(`MERGE FAILED [ERR21_MERGE_FAILED] (branch halted, siblings continue): ${e.message}`);
      }
      appendJournal(dir, { action: 'arrived', branch: bp.branch });
      arrived.add(bp.branch);
    }
  } catch (e) {
    if (e instanceof DriverHalt) {
      const id = haltIdFor(e.reason);
      appendJournal(dir, { action: 'halt', reason: e.reason, ...(id ? { id } : {}), message: e.message });
      console.error(`HALT${id ? ` [${id}]` : ''}: ${e.reason} — ${e.message}`);
      if (id) emit(cli, { ok: false, issues: [{ id, detail: e.message }] });
      return 1;
    }
    throw e;
  }

  // pass-complete only when no open cases AND the §9 gate is green for the
  // current set of merges (a green `verify` journal entry after the last merge).
  // "Open cases" covers MORE than this run's own gating (D-059): a REISSUE case
  // journaled at `start` (undispositioned, never emitted by run — its branch is
  // PR_ID) must keep the pass open, or run would seal a pass with a case still
  // to serve and report-*/finish could no longer attach.
  let sealed = false;
  let missing: string | null = null;
  if (gated || openCases(readJournal(dir)).length > 0) {
    missing = 'open cases remain';
  } else {
    const after = readJournal(dir);
    if (canComplete(after)) {
      appendJournal(dir, { action: 'pass-complete', watermark: plan.watermark });
      sealed = true;
    } else {
      missing = 'no green `verify` entry for the current merges — run `propagate verify --execute`';
    }
  }
  if (diverged.length) console.error(`diverged branches skipped this pass (owner escalation): ${diverged.join(', ')}`);
  if (mergeFailed.length)
    console.error(`merge-failed branches halted this pass (journaled, D-047/B11): ${mergeFailed.join(', ')}`);
  console.error(sealed ? 'run complete — pass sealed (pass-complete)' : `run complete — ${missing}`);
  emit(cli, { watermark12: plan.watermark12, gated, sealed, missing, passDir: dir, diverged, mergeFailed, issues });
  return 0;
}

/**
 * Pass can be sealed `pass-complete` when every merge/resolved this pass is
 * followed by a green `verify` journal entry (§9). A pass that merged nothing
 * needs no gate.
 */
function canComplete(journal: JournalEntry[]): boolean {
  let lastMut = -1;
  let lastGreenVerify = -1;
  journal.forEach((e, i) => {
    if (e.action === 'merge' || e.action === 'resolved') lastMut = i;
    else if (e.action === 'verify' && e.ok === true) lastGreenVerify = i;
  });
  if (lastMut === -1) return true; // nothing merged -> nothing to gate
  return lastGreenVerify > lastMut;
}

/** child -> parents-model parents, from a plan snapshot (for descendant reopen). */
function planEdges(plan: PropagationPlan): Record<string, string[]> {
  const edges: Record<string, string[]> = {};
  for (const b of plan.branches) {
    const ps = b.parents.filter((p) => p.model === 'parents').map((p) => p.parent);
    if (ps.length) edges[b.branch] = ps;
  }
  return edges;
}

/** Transitive inventory descendants of `branch` over child->parents edges. */
function transitiveDescendants(edges: Record<string, string[]>, branch: string): string[] {
  const children: Record<string, string[]> = {};
  for (const [child, parents] of Object.entries(edges)) {
    for (const p of parents) (children[p] ??= []).push(child);
  }
  const out = new Set<string>();
  const stack = [branch];
  while (stack.length) {
    const b = stack.pop()!;
    for (const c of children[b] ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return [...out];
}

/**
 * Reopen the branch AND its transitive descendants (§8 same-pass continuation):
 * a later `run` re-processes them so heights above a resolved conflict, and the
 * resolution itself, propagate without waiting for a new watermark.
 */
function reopen(dir: string, targets: string[]): void {
  for (const b of targets) appendJournal(dir, { action: 'reopened', branch: b });
}

/**
 * B5i crash-heal: a crash between journaledResolvedMerge's ref-update and the
 * `resolved` journal append leaves the ref MOVED but the case OPEN — the
 * double-resolve guard then (correctly) refuses a retried resolve, and without
 * this heal the case would stay open forever with descendants never reopened
 * (N4 liveness). Detection: an open `case` journal entry whose branch tip
 * already CONTAINS the case head. Heal: journal a synthetic `resolved` (reason
 * `crash-heal`) plus `reopened` for the branch and its descendants, so the
 * pass converges. Trusting the journaled head sha is safe under the derived-
 * state model: a forged head can at worst close a case spuriously — the reopen
 * makes `run` re-derive the branch from git, and a still-live conflict simply
 * re-emits a fresh case; nothing merges here.
 */
async function crashHeal(cli: Cli, dir: string, journal: JournalEntry[]): Promise<string[]> {
  const closed = new Set(
    journal.filter((e) => e.action === 'resolved' || e.action === 'held').map((e) => e.caseId as string),
  );
  const planPath = join(dir, 'plan.json');
  const edges = existsSync(planPath) ? planEdges(JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan) : {};
  const healed: string[] = [];
  for (const e of journal) {
    if (e.action !== 'case' || closed.has(e.caseId as string)) continue;
    const head = e.head as { sha?: string } | undefined;
    if (!head?.sha || typeof e.branch !== 'string') continue; // pre-head-journaling entries: not healable
    if (!(await refExists(cli.repo, e.branch))) continue;
    const tip = await revParse(cli.repo, e.branch);
    if (!(await isAncestor(cli.repo, head.sha, tip))) continue; // case genuinely open
    appendJournal(dir, {
      action: 'resolved',
      branch: e.branch,
      caseId: e.caseId,
      reason: 'crash-heal',
      notes: ['ref already contained the case head with no resolved entry — healed synthetically (B5i)'],
    });
    reopen(dir, [e.branch, ...transitiveDescendants(edges, e.branch)]);
    closed.add(e.caseId as string);
    healed.push(e.caseId as string);
  }
  return healed;
}

/**
 * The re-derived (from git + registry) authority for a case — everything the
 * driver acts on. `case-*.json` is only a POINTER; these values come from
 * merge-tree + the eligible line + the registry, NEVER the file (§7).
 */
interface ResolvedCase {
  id: string;
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  /** The case run's TOP head (D-049 §2). */
  head: { sha: string; height: number };
  /** The stacked run (ascending); run[run.length - 1] === head. */
  run: Head[];
  conflictedPaths: string[];
  automergeTree: string;
  reproduction: { command: string };
  tierFloor: Tier;
  /** Effective scope-guard mode, re-derived from config (per-feature > global). */
  scopeGuardMode: ScopeGuardMode;
  /** Trunk heights above the head still pending (PR "behind freeze" count). */
  pendingAbove: number;
  /** Pass scope (branch set) re-derived from the registry + scope config (N2). */
  scope: Set<string>;
  /** Transitive inventory descendants from the registry edges (reopen targets, N2). */
  descendants: string[];
}

/**
 * Case re-verification at resolve (§7 trust boundary). `case-*.json` is
 * agent-writable, so treat it as a pointer and re-derive from git + registry:
 * the head must be the branch's live first-conflict against the named parent;
 * the automerge tree, conflicted paths and tier floor are RECOMPUTED (recorded
 * values only cross-checked for drift); the case must be an OPEN journal case
 * with no later resolved/held; and the branch tip must not already contain the
 * head (double-resolve). Any failure = hard halt.
 */
async function reverifyCase(
  cli: Cli,
  ctx: PassCtx,
  dir: string,
  caseFile: CaseFile,
  journal: JournalEntry[],
): Promise<{ ok: boolean; errors: string[]; rc?: ResolvedCase }> {
  const errors: string[] = [];

  // (4) open-case journal check + (5a) no prior resolved/held for this id.
  if (!journal.some((e) => e.action === 'case' && e.caseId === caseFile.id)) {
    errors.push(`case '${caseFile.id}' has no open 'case' journal entry (never reported this pass)`);
  }
  if (journal.some((e) => (e.action === 'resolved' || e.action === 'held') && e.caseId === caseFile.id)) {
    errors.push(`case '${caseFile.id}' already resolved/held this pass (double-resolve)`);
  }

  // (3) re-derive tier floor AND scope-guard mode from config (ignore the file's).
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const feat = registry.features.find((f) => f.branch === caseFile.branch) as
    | (FeatureEntry & { tier_floor?: string; always_merge?: boolean })
    | undefined;
  const floor = tierFloor(caseFile.branch, feat);
  const scopeGuardMode: ScopeGuardMode = feat?.scope_guard ?? registry.routing.scopeGuardMode ?? 'same-files';
  // D-049 §2 lever, re-derived from config exactly like the tier floor above.
  const stackCap = feat?.stack_cap ?? registry.routing.stackCap ?? DEFAULT_STACK_CAP;

  // (N2) AUTHORITY for parent legality + pass scope: the branch's kind/model/
  // parents/ancestors and the pass's scope set are re-derived from the
  // REGISTRY + scope config (exactly like the tier floor above), NEVER from
  // plan.json — the plan is agent-writable, so a forged parent edge or an
  // extra branch smuggled into the snapshot must not extend what resolve may
  // merge or move. plan.json is kept only as a drift cross-check below.
  const scopeResult = await resolveScope(cli.repo, registry.features, registry.scope, { includeRemote: true });
  const entry = scopeResult.ordered.find((e) => e.branch === caseFile.branch);
  if (!entry) {
    return {
      ok: false,
      errors: [...errors, `branch '${caseFile.branch}' is not in the registry-derived pass scope (N2)`],
    };
  }
  const model: 'entry' | 'parents' = entry.mergeModel === 'upstream-chain' ? 'entry' : 'parents';
  const parents = model === 'entry' ? ['main'] : entry.parents;
  const ancestors = transitiveAncestors(scopeResult.edges)[caseFile.branch] ?? [];
  const inventoryBranches = scopeResult.ordered.filter((e) => e.mergeModel === 'parents').map((e) => e.branch);
  const isLeaf = model === 'parents' && findLeaves(inventoryBranches, scopeResult.edges).has(caseFile.branch);
  const scope = new Set(scopeResult.ordered.map((e) => e.branch));
  const descendants = transitiveDescendants(scopeResult.edges, caseFile.branch);

  // Drift cross-check against the plan snapshot (report-only source, like the
  // recorded-vs-recomputed checks below): a mismatch means the plan was edited
  // or the registry changed mid-pass — either way, halt loudly.
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) return { ok: false, errors: [...errors, 'no plan.json in the pass dir'] };
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan;
  const snap = plan.branches.find((b) => b.branch === caseFile.branch);
  if (!snap) {
    errors.push(`plan drift: branch '${caseFile.branch}' missing from plan.json (registry-derived scope has it)`);
  } else {
    const snapModel = snap.parents[0]?.model ?? 'entry';
    const snapParents = snap.parents.map((p) => p.parent);
    if (snapModel !== model || JSON.stringify([...snapParents].sort()) !== JSON.stringify([...parents].sort()))
      errors.push(
        `plan drift: plan parents [${snapParents.join(', ')}] (${snapModel}) != registry parents [${parents.join(', ')}] (${model})`,
      );
    if (snap.kind !== entry.kind) errors.push(`plan drift: plan kind '${snap.kind}' != registry kind '${entry.kind}'`);
    if (JSON.stringify([...snap.ancestors].sort()) !== JSON.stringify([...ancestors].sort()))
      errors.push(
        `plan drift: plan ancestors [${snap.ancestors.join(', ')}] != registry ancestors [${ancestors.join(', ')}]`,
      );
  }

  const branchTip = await revParse(cli.repo, caseFile.branch);

  // (1)+(2) re-derive the branch LIVE and locate the named parent's conflict.
  const bp = await deriveBranch({
    repo: cli.repo,
    branch: caseFile.branch,
    kind: entry.kind,
    model,
    parents,
    chain: ctx.chain,
    ancestors,
    tierFloor: floor,
    isLeaf,
    alwaysMerge: feat?.always_merge === true,
    held: await prBlockedRecords(cli, journal, ctx.chain),
    stackCap,
  });
  const pp = bp.parents.find((p) => p.parent === caseFile.parent);
  if (!pp)
    return {
      ok: false,
      errors: [...errors, `parent '${caseFile.parent}' is not a legal parent of '${caseFile.branch}'`],
    };
  if (!pp.case) {
    // Distinguish the §7 double-resolve guard from an ordinary drift: when the
    // tip already CONTAINS the recorded head, this is a crash-replay (B5i — the
    // merge landed but the `resolved` entry is missing; `run` heals it), not a
    // healed conflict.
    const doubleResolve =
      typeof caseFile.head?.sha === 'string' && (await isAncestor(cli.repo, caseFile.head.sha, branchTip));
    return {
      ok: false,
      errors: [
        ...errors,
        doubleResolve
          ? `branch tip already contains recorded head ${caseFile.head.sha.slice(0, 12)} (double-resolve guard / crash-replay — a later \`run\` heals this, B5i)`
          : `no live conflict for '${caseFile.branch}' <- '${caseFile.parent}' (head off the eligible line, or clean now)`,
      ],
    };
  }
  const rc = pp.case;

  // Cross-check recorded vs recomputed — drift = tampering or git movement.
  if (rc.head.sha !== caseFile.head.sha)
    errors.push(`head drift: recorded ${caseFile.head.sha.slice(0, 12)} != recomputed ${rc.head.sha.slice(0, 12)}`);
  if (JSON.stringify(rc.conflictedPaths) !== JSON.stringify(caseFile.conflictedPaths))
    errors.push(`conflicted-paths drift: recorded [${caseFile.conflictedPaths}] != recomputed [${rc.conflictedPaths}]`);
  if (rc.automergeTree !== caseFile.automergeTree)
    errors.push(
      `automerge-tree drift: recorded ${caseFile.automergeTree.slice(0, 12)} != recomputed ${rc.automergeTree.slice(0, 12)}`,
    );
  if (floor !== caseFile.tierFloor)
    errors.push(`tier-floor drift: recorded ${caseFile.tierFloor} != recomputed ${floor}`);

  // (5b) double-resolve guard: branch tip already contains the (recomputed) head.
  if (await isAncestor(cli.repo, rc.head.sha, branchTip)) {
    errors.push(`branch tip already contains head ${rc.head.sha.slice(0, 12)} (double-resolve / crash-replay)`);
  }

  const pendingAbove = Math.max(0, ctx.chain.heads.length - 1 - rc.head.height);
  return {
    ok: errors.length === 0,
    errors,
    rc: {
      id: caseFile.id,
      branch: caseFile.branch,
      parent: caseFile.parent,
      model,
      head: rc.head,
      run: rc.run,
      conflictedPaths: rc.conflictedPaths,
      automergeTree: rc.automergeTree,
      reproduction: rc.reproduction,
      tierFloor: floor,
      scopeGuardMode,
      pendingAbove,
      scope,
      descendants,
    },
  };
}

/**
 * D-059 — re-verification for a REISSUE case (a revision of a published-and-
 * commented resolution). `reverifyCase` cannot apply: it re-derives the case
 * from the live plan sweep, but a reissue branch is PR_ID-blocked (empty
 * interval — the sweep never probes it) and the recorded head may sit below a
 * since-advanced upstream run top. The trust anchor here is the JOURNAL row
 * the DRIVER wrote at `start` from the origin fix ref (agent-unwritable), and
 * the conflict is re-probed DIRECTLY against the live branch tip — the same
 * staleness model as `publishHead`'s held path. case.json stays a pointer:
 * conflict set + automerge tree are RECOMPUTED, recorded values cross-checked.
 */
async function reverifyReissueCase(
  cli: Cli,
  ctx: PassCtx,
  caseFile: CaseFile,
  journal: JournalEntry[],
  caseRow: JournalEntry,
): Promise<{ ok: boolean; errors: string[]; rc?: ResolvedCase }> {
  const errors: string[] = [];
  if (journal.some((e) => (e.action === 'resolved' || e.action === 'held') && e.caseId === caseFile.id)) {
    errors.push(`case '${caseFile.id}' already resolved/held this pass (double-resolve)`);
  }
  const rowHead = caseRow.head as { sha: string; height: number } | undefined;
  if (!rowHead?.sha || typeof caseRow.parent !== 'string') {
    return { ok: false, errors: [...errors, `reissue journal row for '${caseFile.id}' is malformed`] };
  }
  if (caseFile.head.sha !== rowHead.sha || caseFile.parent !== caseRow.parent) {
    errors.push(
      `case.json drift: head/parent differ from the driver-journaled reissue row (${rowHead.sha.slice(0, 12)}, '${caseRow.parent}')`,
    );
  }

  // Registry-derived floor/scope/descendants — same authority as reverifyCase.
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const feat = registry.features.find((f) => f.branch === caseFile.branch) as
    | (FeatureEntry & { tier_floor?: string })
    | undefined;
  const floor = tierFloor(caseFile.branch, feat);
  const scopeGuardMode: ScopeGuardMode = feat?.scope_guard ?? registry.routing.scopeGuardMode ?? 'same-files';
  const scopeResult = await resolveScope(cli.repo, registry.features, registry.scope, { includeRemote: true });
  const entry = scopeResult.ordered.find((e) => e.branch === caseFile.branch);
  if (!entry) {
    return {
      ok: false,
      errors: [...errors, `branch '${caseFile.branch}' is not in the registry-derived pass scope (N2)`],
    };
  }
  const model: 'entry' | 'parents' = entry.mergeModel === 'upstream-chain' ? 'entry' : 'parents';
  const scope = new Set(scopeResult.ordered.map((e) => e.branch));
  const descendants = transitiveDescendants(scopeResult.edges, caseFile.branch);

  // Direct live-conflict re-probe (git is the authority).
  if (!(await refExists(cli.repo, caseFile.branch))) {
    return { ok: false, errors: [...errors, `branch '${caseFile.branch}' no longer exists`] };
  }
  const tip = await revParse(cli.repo, caseFile.branch);
  if (await isAncestor(cli.repo, rowHead.sha, tip)) {
    return {
      ok: false,
      errors: [...errors, `branch tip already contains head ${rowHead.sha.slice(0, 12)} — the resolution landed`],
    };
  }
  const probe = await newStyleMergeTree(cli.repo, tip, rowHead.sha);
  if (probe.clean) {
    return {
      ok: false,
      errors: [...errors, `no live conflict for '${caseFile.branch}' <- ${rowHead.sha.slice(0, 12)} (healed)`],
    };
  }
  if (!samePathSet(probe.conflictFiles, caseFile.conflictedPaths)) {
    errors.push(
      `conflicted-paths drift: recorded [${caseFile.conflictedPaths.join(', ')}] != recomputed [${probe.conflictFiles.join(', ')}]`,
    );
  }

  const pendingAbove = Math.max(0, ctx.chain.heads.length - 1 - rowHead.height);
  return {
    ok: errors.length === 0,
    errors,
    rc: {
      id: caseFile.id,
      branch: caseFile.branch,
      parent: caseFile.parent,
      model,
      head: rowHead,
      run: [rowHead],
      conflictedPaths: probe.conflictFiles,
      automergeTree: probe.treeOid,
      reproduction: caseFile.reproduction,
      tierFloor: floor,
      scopeGuardMode,
      pendingAbove,
      scope,
      descendants,
    },
  };
}

/**
 * Freeze a branch HELD: prepare the PR materials (D-048) and journal `held` —
 * the journaled disposition IS the blocked state for the rest of the pass
 * (D-058: blockedRows/passStatusView read it; nothing is written to the
 * ledger, and NOTHING is pushed or published here — the PR is created at
 * `finish`, after verify). The journal entry records what the UNIFIED publish
 * needs (D-057):
 *  - `resolution`: the agent's last resolution tree + whether it is
 *    MARKER-CLEAN — the publish decision key (marker-clean → ACTIVE PR at the
 *    resolved merge commit; otherwise → DRAFT PR from the pristine conflict).
 *    Null when no resolution attempt exists (--tier held, gate holds).
 *  - `escalation`: warning-prefix tag + cold-reviewer feedback for escalated
 *    holds (scope-exceeded / rejected-2x / cap) — prepended to the PR body.
 */
async function freezeHeld(
  cli: Cli,
  dir: string,
  rc: ResolvedCase,
  notes: string[],
  opts: { resolvedTree?: string | null; escalation?: HeldEscalation | null } = {},
): Promise<void> {
  await prepareCaseMaterials(cli, dir, rc, 'held');
  let resolution: { tree: string; markerClean: boolean; baseTip: string } | null = null;
  if (opts.resolvedTree && opts.resolvedTree !== rc.automergeTree) {
    // markerClean scans EVERY file the resolution changed vs the automerge tree
    // (conflicted paths UNION any extra changed files, e.g. a scope-exceeded
    // resolution's additions): a marker anywhere in the shipped tree must force
    // the DRAFT pristine-conflict publish, never an ACTIVE PR.
    const changed = (await git(cli.repo, ['diff', '--name-only', rc.automergeTree, opts.resolvedTree], { allowCodes: [1] })).stdout
      .split('\n')
      .filter(Boolean);
    const scanPaths = [...new Set([...rc.conflictedPaths, ...changed])];
    const markers = await unresolvedMarkers(cli.repo, opts.resolvedTree, scanPaths);
    // baseTip = the branch tip this resolution was snapshotted against; the
    // publish re-checks it and re-merges (or degrades to the DRAFT) when the
    // tip has moved since the freeze — shipping the frozen tree as-is would
    // silently revert every post-freeze commit on the branch.
    const baseTip = await revParse(cli.repo, rc.branch);
    resolution = { tree: opts.resolvedTree, markerClean: markers.length === 0, baseTip };
  }
  appendJournal(dir, {
    action: 'held',
    branch: rc.branch,
    caseId: rc.id,
    height: rc.head.height,
    headSha: rc.head.sha, // conflict head — the derived block height's anchor (D-058)
    conflictedPaths: rc.conflictedPaths,
    notes,
    resolution,
    escalation: opts.escalation ?? null,
  });
}

/**
 * N5: the shape every generated case id has (`slug(branch)--slug(parent)-h<n>`,
 * steps.ts). `--case` is joined into paths under the pass dir, so anything
 * outside the slug charset — path separators, dots, `..` traversal — is
 * refused BEFORE any path join. slug() maps all other characters to `_`, so a
 * genuine id always matches.
 */
const CASE_ID_RE = /^[A-Za-z0-9_-]+-h-?\d+$/;

export async function cmdResolve(cli: Cli): Promise<number> {
  if (!cli.caseId || !cli.tier) {
    console.error('resolve: --case <id> and --tier <mechanical|judged|held> are required');
    return 2;
  }
  if (!CASE_ID_RE.test(cli.caseId)) {
    console.error(
      `resolve [ERR25_BAD_CASE_ID]: --case '${cli.caseId}' does not match the generated case-id shape (N5) — refused`,
    );
    return 2;
  }
  const ctx = await passContext(cli);
  const dir = ctx.dir;
  const caseDir = join(dir, cli.caseId);
  const casePath = join(caseDir, 'case.json');
  if (!existsSync(casePath)) {
    console.error(`resolve: case file not found: ${casePath}`);
    return 2;
  }
  const caseFile = readCaseFile(casePath);
  const journal = readJournal(dir);

  // §7 case re-verification (trust boundary): treat case.json as a pointer.
  const rv = await reverifyCase(cli, ctx, dir, caseFile, journal);
  if (!rv.ok) {
    // N7: dry-run stays write-free — report the failure without journaling.
    if (cli.execute) {
      appendJournal(dir, {
        action: 'halt',
        branch: caseFile.branch,
        caseId: caseFile.id,
        reason: 'case-reverification-failed',
        errors: rv.errors,
      });
    }
    console.error(`HALT: case re-verification failed for ${caseFile.id}:\n  ${rv.errors.join('\n  ')}`);
    return 1;
  }
  const rc = rv.rc!;

  // Reopen targets = the branch + its transitive descendants (registry-derived, N2).
  const reopenTargets = [rc.branch, ...rc.descendants];
  const preReffed = preReffedSet(journal);
  const scope = rc.scope; // registry-derived pass scope (N2), never plan.json's

  try {
    // Direct HELD freeze path (§8): "cannot resolve" — no resolution commit, no
    // scope guard, no cold-read gate; prepare the real-diff draft PR and freeze.
    if (cli.tier === 'held') {
      if (!cli.execute) {
        console.error('DRY-RUN (no --execute): would freeze HELD and reopen descendants');
        emit(cli, { case: rc.id, tier: 'held', reopen: reopenTargets });
        return 0;
      }
      await freezeHeld(cli, dir, rc, ['agent declared cannot-resolve (--tier held)']);
      await removeCaseWorktree(cli, dir, rc.id);
      reopen(dir, reopenTargets);
      console.error(`held ${rc.id} (direct); branch frozen, real-diff draft PR prepared`);
      emit(cli, { case: rc.id, tier: 'held', reopen: reopenTargets });
      return 0;
    }

    if (!isClaimableTier(cli.tier)) {
      console.error(`resolve: --tier must be 'mechanical', 'judged' or 'held' (got '${cli.tier}')`);
      return 2;
    }
    if (!cli.resolvedRef) {
      console.error('resolve: --resolved-ref <ref> (the agent resolution commit) is required');
      return 2;
    }
    const resolvedTree = await treeOf(cli.repo, cli.resolvedRef);
    const verdictPath = join(caseDir, 'coldread-verdict.json');

    // §7 spec promise: the cold-read request contains conflict hunks AND the
    // resolution diff. REGENERATE it here — BEFORE the verdict is required —
    // from the recomputed automerge tree and THIS resolution's tree, so the
    // cold reader always sees the diff its verdict will attest to (a verdict
    // predating this tree is rejected by the freshness binding below anyway).
    // Execute-gated so a dry-run resolve stays write-free (N7).
    if (cli.execute) {
      // D-052 FIX 3 (anti-thrash cap): count the DISTINCT resolution trees this
      // case has been cold-read against (journaled `coldread-attempt`). A case
      // whose resolution keeps changing never converges — beyond the cap we
      // STOP retrying and force it HELD for the owner instead of looping (the
      // 2026-07-22 unbounded cycle). Checked BEFORE regenerating anything.
      const priorTrees = new Set(
        journal
          .filter((e) => e.action === 'coldread-attempt' && e.caseId === rc.id && typeof e.resolvedTree === 'string')
          .map((e) => e.resolvedTree as string),
      );
      const distinctTrees = new Set([...priorTrees, resolvedTree]);
      if (distinctTrees.size > RESOLVE_COLDREAD_CAP) {
        const reason =
          `resolution cold-read did not converge in ${RESOLVE_COLDREAD_CAP} attempts ` +
          `(${distinctTrees.size} distinct resolution trees) — owner review`;
        appendJournal(dir, {
          action: 'resolve-not-converged',
          id: 'ERR26_RESOLVE_NOT_CONVERGED',
          branch: rc.branch,
          caseId: rc.id,
          distinctTrees: [...distinctTrees],
        });
        await freezeHeld(cli, dir, rc, [reason], {
          resolvedTree,
          escalation: { tag: ESCALATE_CAP, feedback: null },
        });
        await removeCaseWorktree(cli, dir, rc.id);
        reopen(dir, reopenTargets);
        console.error(`held ${rc.id} [ERR26_RESOLVE_NOT_CONVERGED]: ${reason}`);
        emit(cli, { case: rc.id, tier: 'held', notes: [reason], reopen: reopenTargets });
        return 0;
      }
      if (!priorTrees.has(resolvedTree)) {
        appendJournal(dir, { action: 'coldread-attempt', branch: rc.branch, caseId: rc.id, resolvedTree });
      }

      // D-052 FIX 1 (root cause): a verdict on disk that attests to a DIFFERENT
      // resolution tree than THIS --resolved-ref is stale the moment the agent
      // re-resolves (amend / different --resolved-ref). Retire it to
      // coldread-verdict.stale.json (RENAMED, not destroyed — a mis-passed
      // --resolved-ref stays recoverable) and journal it, so the "missing
      // verdict; produce it" path below fires cleanly for the NEW tree instead
      // of the "stale" rejection the agent could not diagnose (it deleted the
      // REQUEST — the wrong file — and looped). A verdict whose tree MATCHES is
      // left untouched, so an idempotent re-run still confirms in one shot.
      if (existsSync(verdictPath)) {
        let priorTree: unknown;
        try {
          priorTree = (JSON.parse(readFileSync(verdictPath, 'utf8')) as Partial<ColdReadVerdict>).resolvedTree;
        } catch {
          priorTree = undefined; // unparseable -> treat as stale, retire it
        }
        if (priorTree !== resolvedTree) {
          renameSync(verdictPath, join(caseDir, 'coldread-verdict.stale.json'));
          appendJournal(dir, {
            action: 'stale-verdict-cleared',
            id: 'WARN05_STALE_VERDICT_CLEARED',
            branch: rc.branch,
            caseId: rc.id,
            staleTree: typeof priorTree === 'string' ? priorTree : null,
            resolvedTree,
          });
          console.error(
            `WARN05_STALE_VERDICT_CLEARED: retired stale coldread-verdict.json (attested ${String(priorTree).slice(0, 12)} != this resolution's tree ${resolvedTree.slice(0, 12)}) -> coldread-verdict.stale.json`,
          );
        }
      }

      const tipNow = await revParse(cli.repo, rc.branch);
      const conflictDiff = await git(cli.repo, ['diff', tipNow, rc.automergeTree, '--', ...rc.conflictedPaths], {
        allowCodes: [1],
      });
      const resolutionDiff = await git(cli.repo, ['diff', rc.automergeTree, resolvedTree], { allowCodes: [1] });
      writeFileSync(
        join(caseDir, 'coldread-request.md'),
        coldReadRequest(
          rc,
          conflictDiff.stdout.slice(0, 60000),
          resolutionDiff.stdout.slice(0, 60000),
          await caseContextLines(cli, rc), // D-048: driver-derived context, regenerated fresh
        ),
      );
    }

    // Cold-read verdict VALIDATION (§7, D2): shape + freshness before it can gate.
    if (!existsSync(verdictPath)) {
      console.error(
        `resolve: cold-read verdict missing (${verdictPath}); produce it before resolving. ${COLDREAD_VERDICT_GUIDANCE}`,
      );
      return 2;
    }
    const coldread = JSON.parse(readFileSync(verdictPath, 'utf8')) as Partial<ColdReadVerdict> & {
      verdict?: string;
      reason?: string;
    };
    // D-055 INVARIANT: a COLD-READ INFRA FAILURE must be reported and HALT — it
    // must NEVER become a HELD (or a reject, or the confirm/reject "invalid
    // verdict" return-2). A verdict file whose shape is `error` (D-054) OR whose
    // notes/reason read as a `claude -p` failure (a pre-D-054 leftover that
    // fail-closed to `reject` — the 2026-07-22 bug journaled `held … "cold-read
    // rejected -> HELD: claude -p failed (status 1) …"`) is a tooling failure:
    // hard-halt (ERR35), report to the owner (D-046 case 2), leave the case
    // retryable. Only a cold read that actually RAN and judged rejects → HELD.
    if (coldReadInfraFailure(coldread)) {
      const reason =
        coldread.reason ??
        (typeof coldread.notes === 'string' && coldread.notes.trim() ? coldread.notes : 'unknown');
      const detail = `cold-read tooling unavailable: ${reason} — report to owner (D-046 case 2) and stop; NOT a content decision`;
      if (cli.execute) {
        appendJournal(dir, {
          action: 'halt',
          reason: 'coldread-unavailable',
          id: 'ERR35_COLDREAD_UNAVAILABLE',
          caseId: rc.id,
          branch: rc.branch,
          phase: 'resolve',
          message: detail,
        });
      }
      console.error(`resolve HALT [ERR35_COLDREAD_UNAVAILABLE]: ${detail}`);
      emit(cli, { case: rc.id, halt: 'coldread-unavailable', issues: [{ id: 'ERR35_COLDREAD_UNAVAILABLE', detail }] });
      return 1;
    }
    if (coldread.verdict !== 'confirm' && coldread.verdict !== 'reject') {
      console.error(
        `resolve: invalid cold-read verdict (must be 'confirm' or 'reject', got ${JSON.stringify(coldread.verdict)})`,
      );
      return 2;
    }
    if (typeof coldread.notes !== 'string' || coldread.notes.trim() === '') {
      console.error('resolve: cold-read verdict must carry non-empty notes');
      return 2;
    }
    if (coldread.resolvedTree !== resolvedTree) {
      // Reachable only on a dry-run resolve (--execute clears a stale verdict
      // above, D-052 FIX 1); still name the right artifact so the agent never
      // goes after the request.
      console.error(
        `resolve: cold-read verdict is stale — resolvedTree ${String(coldread.resolvedTree).slice(0, 12)} != this resolution's tree ${resolvedTree.slice(0, 12)}. ${COLDREAD_VERDICT_GUIDANCE}`,
      );
      return 2;
    }
    if (coldread.answers !== undefined && (typeof coldread.answers !== 'object' || coldread.answers === null)) {
      console.error('resolve: cold-read verdict answers must be an object of per-question strings (q1..q3)');
      return 2;
    }
    // D-050 fail-closed: UNVERIFIABLE-FROM-REQUEST on any of Q1-Q3 is a reject
    // reason even under an overall confirm — the reader could not judge that
    // point from the request, and researching beyond the request is forbidden.
    const unverifiable = (['q1', 'q2', 'q3'] as const).filter((q) =>
      /UNVERIFIABLE-FROM-REQUEST/i.test(String(coldread.answers?.[q] ?? '')),
    );
    const coldreadRejected = coldread.verdict === 'reject' || unverifiable.length > 0;
    const feedback = boundedFeedback(coldread);

    // Scope guard (§7 → D-057 #3): recomputed automerge/paths + config-derived
    // mode. A violation is NOT an instant hold any more — the verdict above
    // already judged THE RESOLUTION, so: cold read agrees + scope exceeded →
    // HELD publishing the resolution (active PR, escalated); cold read rejects
    // → the rejection path below (retry once, escalate on the 2nd).
    const guard = await scopeGuard(cli.repo, rc.automergeTree, resolvedTree, rc.conflictedPaths, rc.scopeGuardMode);
    const scopeExceeded = !guard.ok;
    const badPaths = [...guard.extraPaths, ...guard.hunkViolations.map((p) => `${p} (out-of-hunk)`)];
    const notes: string[] = [];

    if (!cli.execute) {
      const priorRejections = coldReadRejectionCount(journal, rc.id);
      const wouldEscalate = coldreadRejected && priorRejections + 1 >= COLDREAD_REJECT_LIMIT;
      const tier: Tier =
        wouldEscalate || (!coldreadRejected && scopeExceeded)
          ? 'held'
          : applyFloor(cli.tier, rc.tierFloor === 'judged' ? 'judged' : 'clean');
      console.error('DRY-RUN (no --execute): resolve decision follows');
      emit(cli, {
        case: rc.id,
        claimed: cli.tier,
        tier,
        rejected: coldreadRejected,
        scopeGuard: guard,
        coldread,
        reopen: reopenTargets,
      });
      return 0;
    }

    // Audit every consumed verdict (the #4 rejection counter reads these).
    appendJournal(dir, {
      action: 'coldread',
      caseId: rc.id,
      branch: rc.branch,
      phase: 'resolve',
      verdict: coldread.verdict,
      unverifiable,
      rejected: coldreadRejected,
      feedback,
    });

    // Cold-read rejection (incl. the D-050 fail-closed UNVERIFIABLE path):
    // FIRST rejection → no freeze; surface the reviewer's feedback so the agent
    // can revise and re-resolve. SECOND rejection → stop retrying, HELD via the
    // unified publish with the escalation prefix (D-057 #4).
    if (coldreadRejected) {
      const rejections = coldReadRejectionCount(readJournal(dir), rc.id);
      const rejectNote =
        coldread.verdict === 'reject'
          ? `cold-read rejected: ${coldread.notes}`
          : `cold-read UNVERIFIABLE-FROM-REQUEST on ${unverifiable.join(', ')} (fail-closed): ${coldread.notes}`;
      if (rejections >= COLDREAD_REJECT_LIMIT) {
        notes.push(`${rejectNote} — rejected ${rejections}x, escalated to HELD`);
        await freezeHeld(cli, dir, rc, notes, {
          resolvedTree,
          escalation: { tag: ESCALATE_REJECTED_2X, feedback },
        });
        await removeCaseWorktree(cli, dir, rc.id);
        reopen(dir, reopenTargets);
        console.error(`held ${rc.id}: cold-read rejected ${rejections}x (escalated)`);
        emit(cli, { case: rc.id, tier: 'held', escalated: true, notes, feedback, reopen: reopenTargets });
        return 0;
      }
      const instruction = `cold read rejected — revise the resolution and re-run resolve${feedback ? `: ${feedback}` : ''}`;
      console.error(`resolve: ${instruction}`);
      emit(cli, {
        case: rc.id,
        rejected: true,
        instruction,
        feedback,
        coldread: { verdict: coldread.verdict, notes: coldread.notes },
      });
      return 1;
    }

    // Cold read agrees + scope exceeded (#3): HELD publishing THE RESOLUTION —
    // the unified publish ships it as an ACTIVE PR (owner reviews & merges),
    // prefixed with the scope escalation naming the extra files.
    if (scopeExceeded) {
      notes.push(`scope-guard violation [${guard.mode}]: out-of-scope [${badPaths}] -> HELD (resolution published for owner review)`);
      appendJournal(dir, {
        action: 'scope-violation',
        branch: rc.branch,
        caseId: rc.id,
        mode: guard.mode,
        extraPaths: guard.extraPaths,
        hunkViolations: guard.hunkViolations,
      });
      const scopeFeedback = [feedback, `resolution touches beyond the conflicted files: ${badPaths.join(', ')}`]
        .filter(Boolean)
        .join(' — ')
        .slice(0, COLDREAD_FEEDBACK_CAP);
      await freezeHeld(cli, dir, rc, notes, {
        resolvedTree,
        escalation: { tag: ESCALATE_SCOPE, feedback: scopeFeedback },
      });
      await removeCaseWorktree(cli, dir, rc.id);
      reopen(dir, reopenTargets);
      console.error(`held ${rc.id}: scope-guard violation [${guard.mode}] (${badPaths.join(', ')}) — resolution kept for owner review`);
      emit(cli, { case: rc.id, tier: 'held', scopeGuard: guard, notes, reopen: reopenTargets });
      return 0;
    }

    // MECHANICAL/JUDGED: floor-raised, merge the RESOLVED tree at the recomputed head.
    const tier: Tier = applyFloor(cli.tier, rc.tierFloor === 'judged' ? 'judged' : 'clean');
    const msg = `Merge ${rc.parent} into ${rc.branch} (propagation, ${tier} resolution of ${rc.id})`;
    await recordPreRef(cli, dir, preReffed, rc.branch);
    const mergeCommit = await journaledResolvedMerge(cli.repo, rc.branch, rc.head.sha, resolvedTree, msg, scope);
    // §7: the resolved entry carries the confirming verdict's content, so the
    // audit trail shows WHAT the cold reader attested, not just that it did.
    appendJournal(dir, {
      action: 'resolved',
      branch: rc.branch,
      caseId: rc.id,
      tier,
      mergeCommit,
      notes,
      coldread: { verdict: coldread.verdict, notes: coldread.notes },
    });
    // The resolve LANDED. Blockedness is derived (D-058): a still-blocked
    // defer this pass keeps the branch DEFERRED via its journaled `defer`
    // rows + the fixpoint view — no stored flag to settle.
    if (tier === 'judged') await prepareCaseMaterials(cli, dir, rc, tier);
    await removeCaseWorktree(cli, dir, rc.id);
    reopen(dir, reopenTargets);
    console.error(`resolved ${rc.id} as ${tier}; merge commit ${mergeCommit.slice(0, 12)}`);
    emit(cli, { case: rc.id, tier, mergeCommit, scopeGuard: guard, reopen: reopenTargets });
    return 0;
  } catch (e) {
    if (e instanceof DriverHalt) {
      const id = haltIdFor(e.reason);
      appendJournal(dir, {
        action: 'halt',
        branch: rc.branch,
        caseId: rc.id,
        reason: e.reason,
        ...(id ? { id } : {}),
        message: e.message,
      });
      console.error(`HALT${id ? ` [${id}]` : ''}: ${e.reason} — ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/**
 * The deterministic fix/sweep branch name for a case (naming rule of §8:
 * branch+PARENT+height so two parents of one branch conflicting at the same
 * height cannot collide — B8). Derived ONLY from the case identity + its head
 * sha — no wall clock — so a retried publish (e.g. a JUDGED publish re-run
 * after a crash, days later) computes the SAME name instead of pushing an
 * orphan ref. The head sha disambiguates re-occurrences of the same
 * branch/parent/height across watermarks. (The HELD path additionally PINS
 * the name in merge_status.fixBranch at freeze time and prefers that.)
 */
function fixBranchName(rc: Pick<ResolvedCase, 'branch' | 'parent' | 'head'>): string {
  return `fix/sweep/${slug(rc.branch)}--${slug(rc.parent)}-h${rc.head.height}-${rc.head.sha.slice(0, 8)}`;
}

/**
 * Prepare the case's PR MATERIALS (§14, D-048) — structured driver facts ONLY:
 * conflicted paths, the case run, per-side one-line histories over those
 * paths, the reproduction command. The driver NEVER generates PR prose (the
 * retired template body/title could not pass the agent's own text gate —
 * 2026-07-21 forensic finding): the agent studies the case (worktree + these
 * materials) and writes pr/title.txt + pr/body.md itself, then runs
 * `propagate publish --case <id>` — the ONLY sanctioned PR-creation path.
 * No fix/sweep ref is created here either: publish pushes the ref at the REAL
 * head (D-049 — HELD: the run's top commit; JUDGED: the merge commit). Returns
 * the deterministic fix branch NAME for ledger/urge bookkeeping.
 */
async function prepareCaseMaterials(cli: Cli, dir: string, rc: ResolvedCase, tier: Tier): Promise<string> {
  const fixBranch = fixBranchName(rc);
  const prDir = join(dir, rc.id, 'pr');
  mkdirSync(prDir, { recursive: true });
  const tip = await revParse(cli.repo, rc.branch);
  const sides = await perSideLog(cli.repo, tip, rc.head.sha, rc.conflictedPaths);
  const materials = [
    `# Case materials — ${rc.id} (${tier})`,
    '',
    'RESOLVE ONLY THE PENDING FILES. The driver committed everything that merged',
    'cleanly (the clean prefix) and left ONLY the conflicted paths below pending —',
    '`git status` shows exactly them. Those pending files are your EDIT scope: change',
    'nothing outside them. To resolve correctly you must UNDERSTAND BOTH SIDES, so you',
    'SHOULD read what the conflict hunks directly implicate — the two versions of the',
    'conflicted code, and the definitions / call sites / relevant tests of the symbols',
    'IN the hunks — targeted (each file once, use offset/limit), never re-reading. That',
    'is understanding this delta, NOT exploring the repo: no whole-tree reads, no broad',
    '`git log`/history/decision-log spelunking, no unrelated branches, no "study until it',
    'clicks." If a bounded look at the implicated code is not enough to decide, that is a',
    '`--tier held` (escalate) — never an ever-widening search.',
    '',
    '## Conflicted paths (the pending files — your edit scope)',
    ...rc.conflictedPaths.map((p) => `- ${p}`),
    '',
    `Branch: ${rc.branch}   Parent: ${rc.parent}   Head: ${rc.head.sha.slice(0, 12)} (height ${rc.head.height})`,
    `Case run (D-049 §2, ${rc.run.length} height(s)): ${rc.run.map((h) => `h${h.height} ${h.sha.slice(0, 12)}`).join(', ')}`,
    `Pending upstream commits above this point: ${rc.pendingAbove}`,
    '',
    `## Reproduction`,
    '```',
    rc.reproduction.command,
    '```',
    '',
    `## ours (\`${rc.branch}\`) — \`git log --oneline\` over the conflicted paths since the merge base`,
    '```',
    sides.ours,
    '```',
    '',
    `## theirs (\`${rc.parent}\` head) — same range on the other side`,
    '```',
    sides.theirs,
    '```',
    '',
    'Write pr/title.txt and pr/body.md YOURSELF from studying the case, then run',
    `\`propagate publish --case ${rc.id}\` (PROPAGATION.md §14, D-048).`,
  ].join('\n');
  writeFileSync(join(prDir, 'materials.md'), materials + '\n');
  return fixBranch;
}

// --------------------------------------------------------------------------
// publish — the ONLY sanctioned PR-creation path (§14, D-048).
// --------------------------------------------------------------------------

/**
 * owner/repo parsed from the CONFIGURED origin URL (`git config
 * remote.origin.url` — `git remote get-url` would apply url.*.insteadOf
 * rewrites, which fixtures use to make a github-shaped URL locally pushable).
 */
async function originSlug(cli: Cli): Promise<{ owner: string; repo: string } | null> {
  const raw = await git(cli.repo, ['config', '--get', 'remote.origin.url'], { allowCodes: [1] });
  if (raw.code === 0 && raw.stdout.trim()) return parseGithubSlug(raw.stdout);
  const rewritten = await git(cli.repo, ['remote', 'get-url', 'origin'], { allowCodes: [1, 2, 128] });
  return rewritten.code === 0 ? parseGithubSlug(rewritten.stdout) : null;
}

/** The latest held/resolved disposition for a case id, or null while it is open. */
function lastDisposition(journal: JournalEntry[], caseId: string): JournalEntry | null {
  let last: JournalEntry | null = null;
  for (const e of journal) {
    if ((e.action === 'held' || e.action === 'resolved') && e.caseId === caseId) last = e;
  }
  return last;
}

function samePathSet(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** A journaled case, read from its LAST `case` entry (+ first index for DAG order). */
interface JournaledCase {
  caseId: string;
  branch: string;
  parent: string;
  head: { sha: string; height: number };
  conflictedPaths: string[];
  /** Index of the case's FIRST journal entry — run emits in DAG order, so this IS the DAG order. */
  firstIndex: number;
}

function journaledCases(journal: JournalEntry[]): Map<string, JournaledCase> {
  const out = new Map<string, JournaledCase>();
  journal.forEach((e, i) => {
    if (e.action !== 'case' || typeof e.caseId !== 'string') return;
    const head = e.head as { sha: string; height: number } | undefined;
    if (!head?.sha || typeof e.branch !== 'string' || typeof e.parent !== 'string') return;
    const prev = out.get(e.caseId);
    out.set(e.caseId, {
      caseId: e.caseId,
      branch: e.branch,
      parent: e.parent,
      head,
      conflictedPaths: (e.conflictedPaths as string[]) ?? [],
      firstIndex: prev?.firstIndex ?? i,
    });
  });
  return out;
}

/**
 * Deterministic driver-built commit (D-057 publish heads): fixed identity and
 * dates so re-running publish rebuilds the SAME sha for the same tree/parents
 * — a retried push stays a no-op instead of a non-fast-forward.
 */
const DRIVER_COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'sweep-driver',
  GIT_AUTHOR_EMAIL: 'sweep-driver@localhost',
  GIT_COMMITTER_NAME: 'sweep-driver',
  GIT_COMMITTER_EMAIL: 'sweep-driver@localhost',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

async function deterministicCommit(repo: string, tree: string, parents: string[], message: string): Promise<string> {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
  return (await git(repo, args, { env: DRIVER_COMMIT_ENV })).stdout.trim();
}

/**
 * The REAL commit a case's PR head is pushed at — the UNIFIED publish (§14,
 * D-049 → D-057). Decision key for a HELD case: does a MARKER-CLEAN resolution
 * exist (recorded on the `held` journal entry)?
 *
 *  - MARKER-CLEAN resolution → ACTIVE (non-draft) PR at the RESOLVED MERGE
 *    COMMIT (driver-built: resolution tree, parents = branch tip + conflict
 *    head). The owner reviews & MERGES it — the driver never auto-merges a
 *    held case (that stays JUDGED); merging it lands the conflict head, which
 *    is exactly what PR_ID completion watches for.
 *  - No marker-clean resolution (markers remain / --tier held) → DRAFT PR from
 *    the PRISTINE conflict: a clean-prefix commit on the branch tip plus a
 *    conflict commit whose tree is the automerge tree (markers in place, NO
 *    agent edits — the owner resolves fresh) parented on the conflict head.
 *
 * JUDGED — the resolved merge commit (must still be on the branch). Returns an
 * ERR01/ERR02 issue instead when the case has no publishable disposition or
 * its live state moved (staleness re-verification — the journal is a pointer,
 * git is the authority, same trust model as reverifyCase). Escalated holds
 * also carry their warning prefix + reviewer feedback out to the PR body.
 */
async function publishHead(
  cli: Cli,
  dir: string,
  journal: JournalEntry[],
  jc: JournaledCase,
): Promise<{
  headSha?: string;
  mode?: 'held' | 'judged';
  draft?: boolean;
  escalation?: HeldEscalation | null;
  issue?: Issue;
}> {
  const disposition = lastDisposition(journal, jc.caseId);
  if (!disposition) {
    return {
      issue: {
        id: 'ERR01_CASE_NOT_OPEN',
        detail: `case '${jc.caseId}' is still unresolved — resolve or freeze it first (publish covers held + judged cases only)`,
      },
    };
  }
  if (!(await refExists(cli.repo, jc.branch))) {
    return { issue: { id: 'ERR02_CASE_STALE', detail: `branch '${jc.branch}' no longer exists` } };
  }
  const tip = await revParse(cli.repo, jc.branch);
  if (disposition.action === 'held') {
    if (await isAncestor(cli.repo, jc.head.sha, tip)) {
      return {
        issue: {
          id: 'ERR02_CASE_STALE',
          detail: `branch tip already contains held head ${jc.head.sha.slice(0, 12)} — the resolution landed; no freeze PR to publish`,
        },
      };
    }
    const probe = await newStyleMergeTree(cli.repo, tip, jc.head.sha);
    if (probe.clean) {
      return {
        issue: {
          id: 'ERR02_CASE_STALE',
          detail: `no live conflict for '${jc.branch}' <- ${jc.head.sha.slice(0, 12)} — healed`,
        },
      };
    }
    if (!samePathSet(probe.conflictFiles, jc.conflictedPaths)) {
      return {
        issue: {
          id: 'ERR02_CASE_STALE',
          detail: `conflict set drifted: recorded [${jc.conflictedPaths.join(', ')}] != live [${probe.conflictFiles.join(', ')}]`,
        },
      };
    }
    const rawEsc = disposition.escalation as HeldEscalation | null | undefined;
    const escalation = rawEsc && typeof rawEsc.tag === 'string' ? rawEsc : null;
    const resolution = disposition.resolution as
      | { tree: string; markerClean: boolean; baseTip?: string }
      | null
      | undefined;
    const hasCleanResolution = resolution?.markerClean === true && typeof resolution.tree === 'string';
    const treePresent =
      hasCleanResolution &&
      (await git(cli.repo, ['rev-parse', '--verify', `${resolution!.tree}^{tree}`], { allowCodes: [128] })).code === 0;
    if (hasCleanResolution && !treePresent && cli.execute) {
      // The recorded CONFIRMED resolution is being dropped — make it visible
      // (journaled warning), never a silent ACTIVE→DRAFT degrade.
      appendJournal(dir, {
        action: 'resolution-degraded',
        id: 'WARN06_RESOLUTION_TREE_MISSING',
        branch: jc.branch,
        caseId: jc.caseId,
        tree: resolution!.tree,
        detail:
          `recorded marker-clean resolution tree ${resolution!.tree.slice(0, 12)} is missing from the object store ` +
          `(GC'd?) — publishing the pristine-conflict DRAFT instead of the confirmed resolution`,
      });
    }
    if (hasCleanResolution && treePresent) {
      // MOVED-TIP GUARD: the resolution tree was snapshotted against the
      // freeze-time tip (`baseTip`). If the branch tip has since advanced
      // (e.g. an origin sync touched non-conflicted files), committing the
      // frozen tree onto the NEW tip would silently revert those commits.
      // Re-merge the frozen resolution against the current tip when that is
      // clean; otherwise degrade to the pristine-conflict DRAFT (journaled).
      const frozenTip = typeof resolution!.baseTip === 'string' ? resolution!.baseTip : null;
      let shipTree: string | null = resolution!.tree;
      if (frozenTip && frozenTip !== tip) {
        const frozenResolved = await deterministicCommit(
          cli.repo,
          resolution!.tree,
          [frozenTip, jc.head.sha],
          `Frozen resolution of ${jc.caseId} (moved-tip re-merge probe)`,
        );
        const remerge = await newStyleMergeTree(cli.repo, tip, frozenResolved);
        if (remerge.clean) {
          shipTree = remerge.treeOid;
          if (cli.execute) {
            appendJournal(dir, {
              action: 'resolution-rebased',
              branch: jc.branch,
              caseId: jc.caseId,
              from: resolution!.tree,
              to: shipTree,
              tipMoved: { from: frozenTip, to: tip },
            });
          }
        } else {
          shipTree = null;
          if (cli.execute) {
            appendJournal(dir, {
              action: 'resolution-degraded',
              id: 'WARN07_RESOLUTION_TIP_MOVED',
              branch: jc.branch,
              caseId: jc.caseId,
              conflictedPaths: remerge.conflictFiles,
              detail:
                `branch tip moved since the freeze (${frozenTip.slice(0, 12)} -> ${tip.slice(0, 12)}) and the frozen ` +
                `resolution does not re-merge cleanly — publishing the pristine-conflict DRAFT instead`,
            });
          }
        }
      }
      if (shipTree) {
        // ACTIVE: the resolved merge commit — owner reviews & merges.
        const headSha = await deterministicCommit(
          cli.repo,
          shipTree,
          [tip, jc.head.sha],
          `Resolution of ${jc.caseId} for owner review (merges ${jc.head.sha.slice(0, 12)} into ${jc.branch})`,
        );
        return { headSha, mode: 'held', draft: false, escalation };
      }
    }
    // DRAFT: the pristine conflict — clean prefix + the original
    // upstream-vs-ours conflict re-materialized, no agent edits.
    const prefixTree = await cleanPrefixTree(cli.repo, probe.treeOid, tip, probe.conflictFiles);
    const prefixCommit = await deterministicCommit(cli.repo, prefixTree, [tip], `Clean prefix for ${jc.caseId}`);
    const headSha = await deterministicCommit(
      cli.repo,
      probe.treeOid,
      [prefixCommit, jc.head.sha],
      `Pristine conflict for ${jc.caseId} (conflict markers in place — resolve fresh)`,
    );
    return { headSha, mode: 'held', draft: true, escalation };
  }
  // resolved
  const tier = disposition.tier as string | undefined;
  if (tier !== 'judged') {
    return {
      issue: {
        id: 'ERR01_CASE_NOT_OPEN',
        detail: `case '${jc.caseId}' resolved as '${tier ?? disposition.reason ?? 'unknown'}' — only JUDGED resolutions and HELD freezes get a PR`,
      },
    };
  }
  const mergeCommit = disposition.mergeCommit as string | undefined;
  if (!mergeCommit || !(await refExists(cli.repo, mergeCommit)) || !(await isAncestor(cli.repo, mergeCommit, tip))) {
    return {
      issue: {
        id: 'ERR02_CASE_STALE',
        detail: `judged merge commit ${mergeCommit?.slice(0, 12) ?? '(missing)'} is not on '${jc.branch}' anymore`,
      },
    };
  }
  return { headSha: mergeCommit, mode: 'judged', draft: false, escalation: null };
}

/**
 * ERR06_DUPLICATE_CASE (§14): another open case (no disposition, or held) or an
 * already-published PR shares this case's conflict signature — same conflicted
 * path SET plus the same head sha, or byte-identical conflict blobs (the
 * automerge-side content at every conflicted path — two branches carrying the
 * same fork edit against the same upstream rewrite produce identical marker
 * blobs). D-050 loosening (the missed #60 near-duplicate — a 6-path subset of
 * a 7-path sibling): a case whose path set is a SUBSET of a sibling's (either
 * direction) is also a duplicate when the conflict blobs on the SHARED paths
 * match. Duplicates consolidate into the TOPMOST case by DAG order (run
 * journals cases in DAG order, so first-journaled = topmost); the topmost case
 * itself publishes. Three of the six 2026-07-21 freeze PRs were byte-identical
 * duplicates.
 */
/**
 * ERR06 with a machine-readable pointer when the matched sibling's PR is
 * ALREADY PUBLISHED — `finish`'s held phase skips such a case (journaled
 * `held-duplicate`) instead of wedging on an unpublishable duplicate
 * (finding #3); absent for the still-open topmost-sibling arm, which remains
 * a consolidate-first error.
 */
interface DuplicateIssue extends Issue {
  duplicateOf?: { caseId: string; url: string; number: number };
}

async function duplicateCaseIssue(
  cli: Cli,
  journal: JournalEntry[],
  cases: Map<string, JournaledCase>,
  self: JournaledCase,
): Promise<DuplicateIssue | null> {
  const published = new Map<string, JournalEntry>();
  for (const e of journal) if (e.action === 'pr-published' && typeof e.caseId === 'string') published.set(e.caseId, e);

  /**
   * Label-normalized conflict-blob content of `paths` inside `tree` (null for
   * a path absent there). merge-tree stamps the side commit OIDs into the
   * conflict markers (`<<<<<<< <sha>` / `>>>>>>> <sha>`), so raw blob oids
   * differ across sibling branches even when the conflict is byte-identical —
   * strip the marker labels before comparing (D-050).
   */
  const conflictBlobs = async (tree: string, paths: string[]): Promise<Array<string | null>> => {
    const out: Array<string | null> = [];
    for (const p of [...paths].sort()) {
      const res = await git(cli.repo, ['cat-file', 'blob', `${tree}:${p}`], { allowCodes: [128] });
      out.push(res.code === 0 ? res.stdout.replace(/^([<>]{7}) .*$/gm, '$1') : null);
    }
    return out;
  };

  const selfProbe = await (async () => {
    try {
      const tip = await revParse(cli.repo, self.branch);
      const probe = await newStyleMergeTree(cli.repo, tip, self.head.sha);
      return probe.clean ? null : probe.treeOid;
    } catch {
      return null;
    }
  })();

  const signatureMatches = async (other: JournaledCase): Promise<boolean> => {
    // Path-set relation: equal, or one a SUBSET of the other (D-050). The
    // shared set is the smaller one; blob comparison runs over it.
    const otherSet = new Set(other.conflictedPaths);
    const selfSet = new Set(self.conflictedPaths);
    const selfInOther = self.conflictedPaths.every((p) => otherSet.has(p));
    const otherInSelf = other.conflictedPaths.every((p) => selfSet.has(p));
    if (!selfInOther && !otherInSelf) return false;
    // The same-head shortcut is sound only for EQUAL sets (a proper subset
    // sibling has different ours-side content, so its blobs must be compared).
    if (selfInOther && otherInSelf && other.head.sha === self.head.sha) return true;
    // Identical-conflict-blob comparison over the shared paths (best-effort —
    // an unreconstructible sibling simply does not match).
    if (!selfProbe) return false;
    const sharedPaths = selfInOther ? self.conflictedPaths : other.conflictedPaths;
    try {
      const tip = await revParse(cli.repo, other.branch);
      const probe = await newStyleMergeTree(cli.repo, tip, other.head.sha);
      if (probe.clean) return false;
      const a = await conflictBlobs(selfProbe, sharedPaths);
      const b = await conflictBlobs(probe.treeOid, sharedPaths);
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  };

  for (const other of cases.values()) {
    if (other.caseId === self.caseId) continue;
    const disposition = lastDisposition(journal, other.caseId);
    const isOpen = disposition === null || disposition.action === 'held';
    const isPublished = published.has(other.caseId);
    if (!isOpen && !isPublished) continue;
    if (!(await signatureMatches(other))) continue;
    if (isPublished) {
      const pr = published.get(other.caseId)!;
      return {
        id: 'ERR06_DUPLICATE_CASE',
        detail: `conflict signature already published as PR #${pr.number} (${pr.url}) for case '${other.caseId}' — consolidate, do not open a second PR`,
        duplicateOf: { caseId: other.caseId, url: String(pr.url ?? ''), number: Number(pr.number ?? 0) },
      };
    }
    if (other.firstIndex < self.firstIndex) {
      return {
        id: 'ERR06_DUPLICATE_CASE',
        detail: `duplicate of case '${other.caseId}' (topmost by DAG order) — publish/resolve THAT case; this one inherits the resolution`,
      };
    }
  }
  return null;
}

/**
 * `propagate publish --case <id>` (§14, D-048/D-049; unified per D-057) — the
 * ONLY sanctioned PR-creation path. The agent writes pr/title.txt + pr/body.md
 * itself from studying the case; this subcommand re-verifies the case,
 * determines the REAL PR head via `publishHead` (HELD with a marker-clean
 * resolution: the resolved merge commit, ACTIVE PR; HELD without one: the
 * pristine-conflict commit, DRAFT PR; JUDGED: the merge commit, non-draft),
 * runs the check battery incl. the pre-PR height check (ERR14) and emits ONE
 * machine-readable JSON object {ok, issues:[{id, detail}], pr?} on stdout.
 * Blocking ERR* ids stop the publish; WARN* ids ship as advisories. With
 * --execute (and all-clear) it PUSHES the fix/sweep ref via `git push`
 * (ERR15 on failure — a D-046 case-2 owner report, never worked around) and
 * creates the PR via the GitHub API (HELD PRs carry the D-004 machine block,
 * escalated holds the warning prefix + reviewer feedback); without --execute
 * it is a dry-run — full battery, but NO pushes and NO network calls of any
 * kind. Text checks are MECHANICAL only (ERR08 + lint WARNs + ERR05/ERR06);
 * the PR-text cold read is retired (D-050).
 */
export async function cmdPublish(cli: Cli, makeTransport?: (token: string) => GithubTransport): Promise<number> {
  if (!cli.caseId) {
    console.error('publish: --case <id> is required');
    return 2;
  }
  if (!CASE_ID_RE.test(cli.caseId)) {
    emit(cli, {
      ok: false,
      issues: [
        {
          id: 'ERR25_BAD_CASE_ID',
          detail: `--case '${cli.caseId}' does not match the generated case-id shape (N5) — refused`,
        },
      ],
    });
    return 2;
  }
  const ctx = await passContext(cli);
  const dir = ctx.dir;
  const journal = readJournal(dir);
  const cases = journaledCases(journal);
  const jc = cases.get(cli.caseId);
  if (!jc) {
    emit(cli, {
      ok: false,
      issues: [
        { id: 'ERR01_CASE_NOT_OPEN', detail: `case '${cli.caseId}' was never journaled this pass (no 'case' entry)` },
      ],
    });
    return 1;
  }

  // (1)+(2) disposition + live-state re-verification (ERR01/ERR02), then the
  // REAL head (D-049) + the pre-PR height check (ERR14).
  const src = await publishHead(cli, dir, journal, jc);
  if (src.issue) {
    emit(cli, { ok: false, issues: [src.issue] });
    return 1;
  }
  const mode = src.mode!;
  const headSha = src.headSha!;
  const issues: Issue[] = [];
  const push = (i: Issue | null): void => {
    if (i) issues.push(i);
  };
  push(await checkBaseHeight(cli.repo, jc.branch, mode, headSha));

  // (4) "should this PR exist": recorded decisions (ERR05) + duplicates (ERR06)
  // + already-published (ERR07, journal side).
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  push(decidedAlready(registry.features, jc.branch, jc.conflictedPaths));
  push(await duplicateCaseIssue(cli, journal, cases, jc));
  const priorPr = journal.filter((e) => e.action === 'pr-published' && e.caseId === jc.caseId).pop();
  if (priorPr) {
    push({
      id: 'ERR07_PR_EXISTS',
      detail: `PR #${priorPr.number} already published for this case: ${priorPr.url}`,
    });
  }

  // (5) agent-written text (ERR08) + MECHANICAL text checks only — the lint
  // WARNs below and the ERR05/ERR06 adequacy gates above. The two-round
  // PR-text cold read (ERR09/ERR10/WARN04) is RETIRED (D-050: zero unique
  // catches ever; ~300k tokens/~19 min burned in one batch); the D-031
  // catch-list survives as WRITING RULES the agent follows (doctrine).
  const prDir = join(dir, jc.caseId, 'pr');
  const titlePath = join(prDir, 'title.txt');
  const bodyPath = join(prDir, 'body.md');
  const title = existsSync(titlePath) ? readFileSync(titlePath, 'utf8').trim() : '';
  const body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8').trim() : '';
  if (title === '' || body === '') {
    push({
      id: 'ERR08_TEXT_MISSING',
      detail: `write ${titlePath} and ${bodyPath} YOURSELF from studying the case (worktree + pr/materials.md) — the driver never generates PR prose (D-048)`,
    });
  } else {
    issues.push(...advisoryTextIssues(title, body, jc.conflictedPaths));
  }

  // (6) throttle advisory (WARN03) + execute-only environment checks.
  const publishedCount = journal.filter((e) => e.action === 'pr-published').length;
  if (publishedCount >= 8) {
    issues.push({
      id: 'WARN03_MANY_PRS',
      detail: `${publishedCount} PRs already published this pass — is this sweep really producing ${publishedCount + 1} distinct owner decisions?`,
    });
  }
  let token: string | null = null;
  let slugParts: { owner: string; repo: string } | null = null;
  if (cli.execute) {
    if (cli.tokenFile && existsSync(cli.tokenFile)) token = readFileSync(cli.tokenFile, 'utf8').trim() || null;
    if (!token) {
      push({
        id: 'ERR11_TOKEN_MISSING',
        detail:
          'publish --execute needs the substitute GitHub token: write the get_credential output to a file once per session and pass --token-file <path> (never $GITHUB_TOKEN — the proxy swaps the Authorization header on the wire)',
      });
    }
    slugParts = await originSlug(cli);
    if (!slugParts) {
      push({
        id: 'ERR12_ORIGIN_UNRESOLVED',
        detail: 'cannot derive owner/repo from the origin remote URL',
      });
    }
  }

  // Deterministic fix branch (D-057 naming, D-058: no pinned copy anywhere —
  // the name derives from the case identity alone, so a retried publish and
  // the next pass's origin scan agree on it). A REISSUE case (D-059) prefers
  // the ORIGIN ref name the driver recorded at start (it IS the existing PR's
  // head branch — the identity-derived name must and does match it).
  const caseRow = journal.find((e) => e.action === 'case' && e.caseId === jc.caseId) ?? null;
  const reissue = caseRow?.reissue === true;
  const fixBranch =
    reissue && typeof caseRow!.fixBranch === 'string' ? (caseRow!.fixBranch as string) : fixBranchName(jc);

  if (issues.some((i) => isBlocking(i.id))) {
    emit(cli, { ok: false, issues });
    return 1;
  }

  // Active-vs-draft is the unified publish decision (D-057): a HELD case with
  // a MARKER-CLEAN resolution ships an ACTIVE (non-draft) PR at the resolved
  // merge commit — the owner reviews & merges (never the driver); only the
  // pristine-conflict exhibit is a draft. JUDGED stays non-draft history.
  const draft = src.draft === true;
  const escalation = src.escalation ?? null;
  const headInfo = { commit: headSha, mode, draft };
  if (!cli.execute) {
    // DRY-RUN: full battery ran, but NO pushes and NO network calls — the
    // transport is never even constructed (§14).
    console.error(
      `DRY-RUN (no --execute): all checks green — would push ${fixBranch} at ${headSha.slice(0, 12)} and publish ${draft ? 'draft ' : ''}PR for ${jc.caseId} (${mode})`,
    );
    emit(cli, { ok: true, dryRun: true, issues, head: headInfo, wouldCreate: { fixBranch, base: jc.branch, draft } });
    return 0;
  }

  // EXECUTE: ERR07 (API side) first — an open PR by head branch name means an
  // earlier publish already landed. For a REISSUE (D-059) the KNOWN PR's LIVE
  // state is re-checked first: the owner may have merged/closed it MID-PASS —
  // then the republish is SKIPPED (journaled), never a clobber of the owner's
  // action and never a second PR (the next start re-derives the truth).
  const transport = (makeTransport ?? realGithubTransport)(token!);
  let reissueTarget: { url: string; number: number } | null = null;
  try {
    if (reissue && typeof caseRow!.prNumber === 'number') {
      const live = await getPullRequest(transport, slugParts!, caseRow!.prNumber as number);
      if (live.state === 'open' && !live.merged) {
        reissueTarget = { url: live.url, number: live.number };
      } else {
        const liveState = live.merged ? 'merged' : live.state;
        appendJournal(dir, {
          action: 'publish-skipped-live',
          caseId: jc.caseId,
          branch: jc.branch,
          prNumber: live.number,
          prUrl: live.url,
          liveState,
          detail: `reissue target PR #${live.number} is ${liveState} (owner acted mid-pass) — republish skipped; no second PR, no clobber`,
        });
        console.error(
          `publish: reissue target PR #${live.number} is ${liveState} (owner acted mid-pass) — SKIPPED (no push, no PR write)`,
        );
        emit(cli, {
          ok: true,
          issues,
          skipped: true,
          liveState,
          pr: { url: live.url, number: live.number },
        });
        return 0;
      }
    }
    const existing = reissue ? null : await getOpenPrByHead(transport, slugParts!, fixBranch);
    if (existing) {
      // RECONCILE, never a livelock (finding #1): reaching here means the
      // journal carries NO `pr-published` row for this case (a journal-side row
      // is blocking ERR07 above), yet the PR exists on the API side — the
      // crash window between the prior run's PR create and its journal append.
      // The head branch name is deterministic per case identity, so this IS
      // this case's PR: journal the reconciling row (same shape as the normal
      // path) and succeed, so a resumed `finish` continues instead of halting.
      guardRef(fixBranch, new Set(), { fixSweep: true });
      if (!(await refExists(cli.repo, fixBranch))) {
        await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, headSha, '']);
      }
      // D-059: the crashed run may have died between PR create and the marker
      // post — re-assert the sweep-addressed marker (0: first publish; readers
      // take the MAX, so a duplicate is harmless).
      if (mode === 'held') await postSweepAddressed(transport, slugParts!, existing.number, 0);
      appendJournal(dir, {
        action: 'pr-published',
        caseId: jc.caseId,
        branch: jc.branch,
        mode,
        draft,
        fixBranch,
        url: existing.url,
        number: existing.number,
        head: headSha,
        reconciled: true,
      });
      console.error(
        `reconciled: open PR #${existing.number} already exists for head '${fixBranch}' (${existing.url}) — journaled pr-published (crash-window heal), no new PR created`,
      );
      emit(cli, {
        ok: true,
        issues,
        pr: { url: existing.url, number: existing.number },
        head: headInfo,
        reconciled: true,
      });
      return 0;
    }
  } catch (e) {
    emit(cli, {
      ok: false,
      issues: [...issues, { id: 'ERR13_API_FAILED', detail: e instanceof Error ? e.message : String(e) }],
    });
    return 1;
  }

  // The DRIVER pushes the PR head — `git push` is the only way refs move
  // (D-049 §5). A failure is ERR15: hard halt, journaled, D-046 case-2 owner
  // report; NO fallback of any kind. A REISSUE replaces the prior resolution
  // head on the SAME ref (non-fast-forward by construction), so it pushes with
  // a compare-and-swap lease on the start-classified old head — never blind.
  const priorHead = reissue && typeof caseRow!.priorHead === 'string' ? (caseRow!.priorHead as string) : null;
  try {
    await gitPush(cli.repo, headSha, fixBranch, priorHead ? { forceWithLease: priorHead } : {});
    appendJournal(dir, {
      action: 'push',
      branch: fixBranch,
      to: headSha,
      kind: 'pr-head',
      ...(priorHead ? { replaced: priorHead, reissue: true } : {}),
    });
  } catch (e) {
    const detail =
      `git push of '${fixBranch}' at ${headSha.slice(0, 12)} failed: ${e instanceof Error ? e.message : String(e)} — ` +
      `report to the owner (D-046 case 2) and STOP; publication is blocked until the infrastructure is fixed`;
    appendJournal(dir, {
      action: 'halt',
      reason: 'push-failed',
      id: 'ERR15_PUSH_FAILED',
      branch: fixBranch,
      message: detail,
    });
    emit(cli, { ok: false, issues: [...issues, { id: 'ERR15_PUSH_FAILED', detail }] });
    return 1;
  }

  try {
    let finalBody = body;
    // Escalated hold (D-057): the warning prefix + the cold reviewer's short
    // feedback go ABOVE the agent's prose so the owner sees why this landed
    // on their desk (scope exceeded / rejected twice / did not converge).
    if (escalation) {
      finalBody = `${escalation.tag}${escalation.feedback ? ` — ${escalation.feedback}` : ''}\n\n${finalBody}`;
    }
    if (mode === 'held') {
      // D-004 machine block (D-049 decision 8): driver-maintained, delimited,
      // appended BELOW the agent's prose; posted urges keep it current.
      const pendingAbove = Math.max(0, ctx.chain.heads.length - 1 - jc.head.height);
      finalBody = withMachineBlock(finalBody, renderMachineBlock(pendingAbove, ctx.watermark12));
    }
    let result: { url: string; number: number };
    if (reissueTarget) {
      // D-059 REISSUE: the revision replaces the EXISTING PR's head (the ref
      // push above); refresh the PR's title/body from the agent's revised
      // prose — never a second PR for the same review.
      await ghExpect(transport, 'PATCH', `/repos/${slugParts!.owner}/${slugParts!.repo}/pulls/${reissueTarget.number}`, {
        title,
        body: finalBody,
      });
      result = reissueTarget;
    } else {
      result = await createPullRequest(transport, slugParts!, {
        title,
        body: finalBody,
        head: fixBranch,
        base: jc.branch,
        draft,
      });
    }
    // D-059: record the review-loop state on the PR — the sweep-addressed
    // marker names the highest SUBMITTED REVIEW id this publish addressed
    // (0 on a first publish — no review yet; a reissue posts the triggering
    // review id classified at start — always a review id actually present on
    // the PR). Held PRs only: JUDGED history PRs auto-flip to merged and
    // carry no review loop.
    const addressedReviewId =
      reissue && typeof caseRow!.addressedReviewId === 'number' ? (caseRow!.addressedReviewId as number) : 0;
    if (mode === 'held') await postSweepAddressed(transport, slugParts!, result.number, addressedReviewId);
    // Local anchor for the pushed ref. Namespace-checked, scope-exempt. A
    // reissue MOVES an existing anchor to the revised head.
    guardRef(fixBranch, new Set(), { fixSweep: true });
    if (!(await refExists(cli.repo, fixBranch))) {
      await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, headSha, '']);
    } else if (reissue) {
      await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, headSha]);
    }
    appendJournal(dir, {
      action: 'pr-published',
      caseId: jc.caseId,
      branch: jc.branch,
      mode,
      draft,
      fixBranch,
      url: result.url,
      number: result.number,
      head: headSha,
      ...(reissue ? { reissued: true, addressedReviewId } : {}),
    });
    // No stored pointer to update (D-058): the `pr-published` journal row
    // above enriches the pass's blocked view (urge target), and the next
    // pass rediscovers the PR from origin at `start`.
    console.error(
      `published ${draft ? 'draft ' : ''}PR #${result.number} for ${jc.caseId}: ${result.url}${reissueTarget ? ' (reissued — existing PR updated)' : ''}`,
    );
    emit(cli, {
      ok: true,
      issues,
      pr: { url: result.url, number: result.number },
      head: headInfo,
      ...(reissueTarget ? { reissued: true } : {}),
    });
    return 0;
  } catch (e) {
    emit(cli, {
      ok: false,
      issues: [...issues, { id: 'ERR13_API_FAILED', detail: e instanceof Error ? e.message : String(e) }],
    });
    return 1;
  }
}

/**
 * `propagate push` — the pass publication stage (§14.4, D-049). The DRIVER
 * pushes; the agent never hand-pushes anything (rule 3 as amended by D-049:
 * driver-journaled pass pushes are the only pushes). Per-pass order: verify
 * green → JUDGED PRs created (`publish`, non-draft) → THIS command pushes the
 * target branches — ONE push per branch, clean prefix + judged merge commits
 * together; GitHub auto-flips the JUDGED PRs to merged (D-040) → HELD PRs
 * created (`publish`, active/draft — D-058: bases now current, ERR14 enforces
 * it) → urge comments posted (also this command). Verify-gated (ERR18): nothing is
 * pushed before `verify` is green (§9, D-012). PUSH RESILIENCE (D-059 FINAL):
 * each target pushes INDEPENDENTLY — a failed push is journaled per branch
 * (`push-failed` with a diverged/transient/auth category; ERR15 stays the
 * per-branch LABEL) and the remaining targets still land; landed branches are
 * up-to-date (skipped) on the next run, failed ones retry — the stage is
 * resumable, never force-resolved. Closure checks and urge posting are the
 * networked parts and take the same `--token-file` as `publish`; a dry-run
 * reports intents only (no writes, no network).
 */
export async function cmdPush(cli: Cli, makeTransport?: (token: string) => GithubTransport): Promise<number> {
  const ctx = await passContext(cli); // attaches to the open pass
  const dir = ctx.dir;
  const journal = readJournal(dir);
  const issues: Issue[] = [];

  // Target set: branches the driver mutated this pass, in plan order.
  const mutated = new Set(
    journal
      .filter((e) => (e.action === 'merge' || e.action === 'resolved') && typeof e.branch === 'string')
      .map((e) => e.branch as string),
  );
  const planPath = join(dir, 'plan.json');
  const order: string[] = existsSync(planPath)
    ? (JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan).order
    : [...mutated];
  const targets = order.filter((b) => mutated.has(b));
  for (const b of mutated) if (!targets.includes(b)) targets.push(b);

  interface PushIntent {
    branch: string;
    state: 'push' | 'create' | 'up-to-date' | 'remote-ahead' | 'diverged';
    localTip: string;
  }
  const intents: PushIntent[] = [];
  for (const branch of targets) {
    if (!(await refExists(cli.repo, branch))) continue;
    const localTip = await revParse(cli.repo, branch);
    const originRef = `origin/${branch}`;
    if (!(await refExists(cli.repo, originRef))) {
      intents.push({ branch, state: 'create', localTip });
      continue;
    }
    const originTip = await revParse(cli.repo, originRef);
    if (originTip === localTip) intents.push({ branch, state: 'up-to-date', localTip });
    else if (await isAncestor(cli.repo, originTip, localTip)) intents.push({ branch, state: 'push', localTip });
    // Origin strictly ahead: someone else committed — higher is fine (D-049 §5).
    else if (await isAncestor(cli.repo, localTip, originTip)) intents.push({ branch, state: 'remote-ahead', localTip });
    else intents.push({ branch, state: 'diverged', localTip });
  }

  // JUDGED PRs published this pass — their closure is checked after the pushes.
  const judgedPrs = journal.filter((e) => e.action === 'pr-published' && e.mode === 'judged');
  const dueUrges = await detectUrges(cli, ctx, journal);

  // Verify gate (§9, D-012): nothing is pushed before verify is green.
  const gateOk = canComplete(journal);

  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): no pushes, no posts; reporting intents');
    emit(cli, {
      dryRun: true,
      verifyGreen: gateOk,
      wouldPush: intents.filter((i) => i.state === 'push' || i.state === 'create').map((i) => i.branch),
      skipped: intents.filter((i) => i.state === 'up-to-date' || i.state === 'remote-ahead').map((i) => i.branch),
      diverged: intents.filter((i) => i.state === 'diverged').map((i) => i.branch),
      wouldCheckClosure: judgedPrs.map((e) => e.number),
      wouldUrge: dueUrges.map((u) => ({ branch: u.branch, head: u.head })),
    });
    return 0;
  }

  if (!gateOk) {
    const detail =
      "no green `verify` journal entry after the pass's last mutation — run `propagate verify --execute` first (§9, D-012)";
    console.error(`push [ERR18_VERIFY_PENDING]: ${detail}`);
    emit(cli, { ok: false, issues: [{ id: 'ERR18_VERIFY_PENDING', detail }] });
    return 1;
  }

  // (1) Target pushes — ONE push per branch, plan order (D-049 decision 2).
  // PUSH RESILIENCE (D-059 FINAL): each target pushes INDEPENDENTLY — a
  // failure is journaled per branch (`push-failed`, categorized) and the loop
  // FINISHES THE REST; ERR15 stays the per-branch failure LABEL but is no
  // longer a stop. Verify already validated each publishable branch
  // independently, so a partial land is safe; landed branches are up-to-date
  // (skipped) on the next push, failed ones retry.
  const pushed: string[] = [];
  type PushFailCategory = 'diverged' | 'transient' | 'auth' | 'rejected';
  const pushFailed: Array<{ branch: string; category: PushFailCategory; detail: string }> = [];
  const categorize = (msg: string): PushFailCategory => {
    // A pre-receive-hook / permission rejection is NOT divergence (finding 3):
    // its git output also says "[remote rejected] … failed to push some refs",
    // but no history diverged — re-pushing can never succeed until the owner
    // changes the hook/branch protection. Checked FIRST so the diverged
    // patterns below cannot shadow it.
    if (/pre-receive hook declined|protected branch|\b403\b|permission.*denied to/i.test(msg)) return 'rejected';
    if (/non-fast-forward|fetch first|stale info|\[rejected\]|failed to push some refs/i.test(msg)) return 'diverged';
    if (/401|denied|authentication|could not read username|invalid credentials|terminal prompts disabled|bad credentials/i.test(msg))
      return 'auth';
    return 'transient';
  };
  // Categories that can NEVER self-heal by retrying (finding 3): the owner must
  // act. Journaled as a DISTINCT escalation row so `finish` can surface them as
  // needs-owner (not merely a category) and an autonomous re-run loop can stop
  // re-trying the branch.
  const NEEDS_OWNER: ReadonlySet<PushFailCategory> = new Set(['diverged', 'rejected']);
  const failBranch = (branch: string, category: PushFailCategory, detail: string): void => {
    appendJournal(dir, { action: 'push-failed', id: 'ERR15_PUSH_FAILED', branch, category, message: detail });
    if (NEEDS_OWNER.has(category)) {
      appendJournal(dir, { action: 'push-escalated', branch, category, detail });
    }
    issues.push({ id: 'ERR15_PUSH_FAILED', detail });
    pushFailed.push({ branch, category, detail });
    console.error(`push [ERR15_PUSH_FAILED/${category}]: ${detail}`);
  };
  for (const intent of intents) {
    if (intent.state === 'up-to-date' || intent.state === 'remote-ahead') {
      appendJournal(dir, { action: 'push-skip', branch: intent.branch, reason: intent.state });
      continue;
    }
    if (intent.state === 'diverged') {
      failBranch(
        intent.branch,
        'diverged',
        `push target '${intent.branch}' has DIVERGED from origin — owner escalation (D-046 case 2), never force-resolve; the other targets proceed`,
      );
      continue;
    }
    try {
      await gitPush(cli.repo, intent.branch, intent.branch);
      appendJournal(dir, { action: 'push', branch: intent.branch, to: intent.localTip, kind: 'target' });
      pushed.push(intent.branch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const category = categorize(msg);
      failBranch(
        intent.branch,
        category,
        `git push of target '${intent.branch}' failed (${category}): ${msg} — ` +
          (category === 'diverged'
            ? 'owner escalation (D-046 case 2), never force-resolve; the other targets proceed'
            : category === 'rejected'
              ? 'owner escalation (D-046 case 2): a hook/branch-protection rejection cannot heal by retrying; the other targets proceed'
              : 'report to the owner (D-046 case 2); the other targets proceed and this branch retries on the next finish'),
      );
    }
  }

  // APPROVED-landing rollback escalations pending a post (finding 2): the
  // verify stage journals `approved-rollback` offline; THIS stage owns the
  // networked comment. One post per rollback — an `approved-escalated` row
  // marks it done, so re-runs never re-post.
  const pendingApprovedEscalations = journal.filter(
    (e) =>
      e.action === 'approved-rollback' &&
      typeof e.prNumber === 'number' &&
      !journal.some(
        (d) => d.action === 'approved-escalated' && d.branch === e.branch && d.reviewId === e.reviewId,
      ),
  );

  // Networked steps (closure checks + urge posting + approved-rollback
  // escalations). Only constructed when there is work; same --token-file
  // contract as publish (D-049 decision 7).
  const needsNetwork = judgedPrs.length > 0 || dueUrges.length > 0 || pendingApprovedEscalations.length > 0;
  let transport: GithubTransport | null = null;
  let slugParts: { owner: string; repo: string } | null = null;
  if (needsNetwork) {
    let token: string | null = null;
    if (cli.tokenFile && existsSync(cli.tokenFile)) token = readFileSync(cli.tokenFile, 'utf8').trim() || null;
    if (!token) {
      issues.push({
        id: 'ERR11_TOKEN_MISSING',
        detail:
          'closure checks / urge posting need the substitute GitHub token: write the get_credential output to a file and pass --token-file <path>',
      });
    } else {
      slugParts = await originSlug(cli);
      if (!slugParts) {
        issues.push({
          id: 'ERR12_ORIGIN_UNRESOLVED',
          detail: 'cannot derive owner/repo from the origin remote URL',
        });
      } else {
        transport = (makeTransport ?? realGithubTransport)(token);
      }
    }
  }

  // (2) JUDGED closure check (D-040): every judged PR must have auto-flipped.
  // PRs whose target push FAILED this run are skipped (their flip is pending
  // the retried push — an ERR16 for them would be noise, not signal).
  const failedBranches = new Set(pushFailed.map((f) => f.branch));
  const closures: Array<{ number: number; merged: boolean }> = [];
  if (transport && slugParts) {
    const api = `/repos/${slugParts.owner}/${slugParts.repo}`;
    for (const e of judgedPrs) {
      if (typeof e.branch === 'string' && failedBranches.has(e.branch)) continue;
      try {
        const pr = await ghExpect(transport, 'GET', `${api}/pulls/${e.number}`);
        const merged = pr.merged === true;
        closures.push({ number: Number(e.number), merged });
        if (!merged) {
          issues.push({
            id: 'ERR16_CLOSURE_FAILED',
            detail: `JUDGED PR #${e.number} did not flip to merged after the target push — the base tip and the PR head should be the same commit; investigate before publishing more`,
          });
        }
      } catch (err) {
        issues.push({
          id: 'ERR16_CLOSURE_FAILED',
          detail: `closure check for PR #${e.number} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // (2b) APPROVED-landing rollback escalations (finding 2): tell the owner
  // their approved resolution fails the integration build, WITH the marker
  // advanced to the approving review id — the next `start` then reads the
  // review as addressed and neither re-lands nor re-serves it (a NEW review
  // re-triggers). Journaled `approved-escalated` on success (post-once); a
  // failed post is blocking (fail-closed) and retries on the next push.
  if (transport && slugParts) {
    const api = `/repos/${slugParts.owner}/${slugParts.repo}`;
    for (const esc of pendingApprovedEscalations) {
      const reviewId = typeof esc.reviewId === 'number' ? esc.reviewId : 0;
      const body = [
        `Sweep escalation (driver-posted): the APPROVED resolution on this PR (review ${reviewId}) was landed on \`${String(esc.branch)}\` but FAILED the pass's integration build (verify) and was ROLLED BACK — the approved fix breaks the build.`,
        `Owner action needed on \`${String(esc.ref ?? '')}\`: revise the resolution. This advances the sweep-addressed marker to review ${reviewId}, so the sweep will NOT re-land or re-serve this case until a NEW review is submitted — after revising, SUBMIT A NEW REVIEW on this PR to re-trigger the loop.`,
        renderSweepAddressed(reviewId),
      ].join('\n');
      try {
        await ghExpect(transport, 'POST', `${api}/issues/${esc.prNumber}/comments`, { body });
        appendJournal(dir, {
          action: 'approved-escalated',
          branch: esc.branch,
          ref: esc.ref ?? null,
          prNumber: esc.prNumber,
          reviewId: esc.reviewId ?? null,
        });
        console.error(
          `push: APPROVED-rollback escalation posted on PR #${esc.prNumber} (${String(esc.branch)}, marker -> review ${reviewId})`,
        );
      } catch (err) {
        issues.push({
          id: 'ERR13_API_FAILED',
          detail: `approved-rollback escalation for '${String(esc.branch)}' (PR #${esc.prNumber}) failed: ${err instanceof Error ? err.message : String(err)} — retries on the next push`,
        });
      }
    }
  }

  // (3) Urge posting (§8, D-004): post FIRST — journal/ledger (incl.
  // lastUrgedHead) advance only after a successful post, so a failed urge
  // retries on the next push.
  const urged: Array<{ branch: string; head: string; prNumber: number }> = [];
  if (transport && slugParts) {
    const api = `/repos/${slugParts.owner}/${slugParts.repo}`;
    for (const urge of dueUrges) {
      try {
        let prNumber = urge.prNumber;
        if (!prNumber) {
          const pr = await getOpenPrByHead(transport, slugParts, urge.fixBranch);
          prNumber = pr?.number ?? null;
        }
        if (!prNumber) {
          appendJournal(dir, { action: 'urge-skip', branch: urge.branch, reason: 'freeze PR not published yet' });
          continue;
        }
        const commentBody = await urgeCommentBody(cli, urge);
        // D-004: refresh the machine block on the PR body, then post the comment.
        const pr = await ghExpect(transport, 'GET', `${api}/pulls/${prNumber}`);
        const newBody = withMachineBlock(
          String(pr.body ?? ''),
          renderMachineBlock(urge.pending.length, ctx.watermark12),
        );
        await ghExpect(transport, 'PATCH', `${api}/pulls/${prNumber}`, { body: newBody });
        await ghExpect(transport, 'POST', `${api}/issues/${prNumber}/comments`, { body: commentBody });
        const urgeDir = join(dir, 'urges', slug(urge.branch));
        mkdirSync(urgeDir, { recursive: true });
        writeFileSync(join(urgeDir, 'urge-comment.md'), commentBody + '\n');
        appendJournal(dir, {
          action: 'urge',
          branch: urge.branch,
          head: urge.head,
          pending: urge.pending.length,
          prNumber,
        });
        // lastUrgedHead is the ONE surviving ledger write: a non-authoritative
        // dedup cache (D-058 §3 — losing it merely re-urges once). merge_status
        // is never written; blockedness is origin/journal-derived.
        const path = ledgerPathOf(cli);
        const fresh = readLedger(path);
        const cur = fresh.branches[urge.branch] ?? defaultLedgerBranch();
        fresh.branches[urge.branch] = { ...cur, lastUrgedHead: urge.head };
        writeLedger(path, fresh);
        urged.push({ branch: urge.branch, head: urge.head, prNumber });
      } catch (err) {
        issues.push({
          id: 'ERR17_URGE_FAILED',
          detail: `urge for '${urge.branch}' failed: ${err instanceof Error ? err.message : String(err)} — lastUrgedHead not advanced; it retries on the next push`,
        });
      }
    }
  }

  // Blocking NON-push issues (ERR16/ERR17/token/API) are journaled as
  // `push-issue` rows (finding 3): `finish` reads only the journal delta, so
  // without these rows a partial finish silently DROPPED them from the
  // SWEEP-RESULT whenever per-branch push failures also occurred.
  for (const i of issues) {
    if (isBlocking(i.id) && i.id !== 'ERR15_PUSH_FAILED') {
      appendJournal(dir, { action: 'push-issue', id: i.id, detail: i.detail });
    }
  }
  const ok = !issues.some((i) => isBlocking(i.id));
  console.error(
    `push ${ok ? 'complete' : 'FINISHED WITH BLOCKING ISSUES'} — ${pushed.length} branch(es) pushed, ` +
      `${pushFailed.length} failed (${pushFailed.map((f) => `${f.branch}:${f.category}`).join(', ') || 'none'}), ` +
      `${closures.filter((c) => c.merged).length}/${closures.length} judged closures confirmed, ${urged.length} urge(s) posted`,
  );
  emit(cli, { ok, issues, pushed, failed: pushFailed, closures, urged });
  return ok ? 0 : 1;
}

export async function cmdVerify(cli: Cli): Promise<number> {
  const { dir } = await passContext(cli); // attaches to the open pass
  const journal = readJournal(dir);
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  // D-051 fix 1: the recipe = THIS PASS'S publishable set (advanced branches, in
  // the plan's DAG order, minus held/frozen/open-case), built on the fork-trunk
  // base. An explicit `--recipe` still overrides (manual re-verify / debugging,
  // §12). The static scope.yaml `recipe` is now only a PLANLESS fallback (no
  // pass plan on disk): validating publishable branches replaces validating a
  // fixed config stack that could pin a permanently-held branch at its head.
  // PR_ID-blocked branches are unpublished-by-design (their unresolved conflicts
  // would recreate stack conflicts in the rebuild); DEFERRED branches carry only
  // their clean prefix and stay publishable (D-057).
  const held = prBlockedBranches(journal);
  const order = passOrder(dir);
  const derived = order.length > 0 ? publishableRecipe(journal, order, held) : (registry.scope.recipe ?? []);
  const recipe = cli.recipe ?? derived;
  const baseRef = await verifyBaseRef(cli);
  const rrCacheDir = join(cli.workspace, RR_CACHE_DIRNAME);
  const commands: VerifyCommand[] = cli.commandsFile
    ? (JSON.parse(readFileSync(cli.commandsFile, 'utf8')) as VerifyCommand[])
    : VERIFY_COMMANDS;
  const verifyOpts = { commands, baseRef, rrCacheDir };

  if (recipe.length === 0) {
    if (order.length === 0) {
      console.error('verify: no recipe (pass --recipe a,b,c or add `recipe:` to registry/scope.yaml)');
      return 2;
    }
    // A plan exists but nothing publishable advanced this pass — vacuously green
    // (nothing to integrate, nothing to push). Everything held is reported, not
    // gated (D-051): a pass where every branch froze must still complete.
    appendJournal(dir, { action: 'verify', ok: true, note: 'empty publishable recipe (nothing advanced this pass)' });
    console.error('verify: green (no publishable branches advanced this pass — nothing to rebuild)');
    emit(cli, { ok: true, recipe: [], baseRef });
    return 0;
  }
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): would rebuild the recipe + run CI commands in a temp worktree');
    emit(cli, { recipe, commands, baseRef });
    return 0;
  }

  const first = await verifyEverything(cli.repo, { recipe, ...verifyOpts });
  if (first.ok) {
    appendJournal(dir, { action: 'verify', ok: true });
    console.error('verify: green');
    emit(cli, { ok: true, build: first.build });
    return 0;
  }
  appendJournal(dir, { action: 'verify', ok: false, offender: first.offender ?? null });
  const offender = first.offender;
  if (!offender) {
    appendJournal(dir, { action: 'verify', ok: false, attributionFailed: true });
    console.error('verify: RED — no single-branch attribution (leave-one-out did not isolate an offender)');
    emit(cli, { ok: false, attributionFailed: true, commands: first.commands });
    return 1;
  }
  const preRef = lastPreRef(journal, offender);
  // D-051 fix 2: a HELD/FROZEN offender (or any branch with no this-pass pre-ref)
  // is NOT a publishable failure — it is already frozen and unpublished, so it
  // must NEVER hard-block (ERR18). fix 1 already excludes held/frozen branches
  // from the recipe, so this is defense in depth for an explicit `--recipe` (or a
  // branch frozen after its pre-ref): journal a non-blocking gate OBSERVATION,
  // re-verify the publishable set WITHOUT it, and let the rest proceed. ERR18
  // fires ONLY when a branch that WOULD be pushed this pass fails verify.
  if (held.has(offender) || !preRef) {
    appendJournal(dir, {
      action: 'verify-observation',
      ok: false,
      offender,
      held: held.has(offender),
      note: held.has(offender)
        ? 'offender is held/frozen — non-blocking (unpublished; validated by its own fix flow)'
        : 'offender has no pre-ref — non-blocking (not mutated this pass)',
    });
    const reduced = recipe.filter((b) => b !== offender);
    const re = reduced.length > 0 ? await verifyEverything(cli.repo, { recipe: reduced, ...verifyOpts }) : null;
    const reOk = re ? re.ok : true;
    appendJournal(dir, { action: 'verify', ok: reOk, offender, excluded: offender, nonBlocking: true });
    console.error(
      `verify: RED offender ${offender} is held/unpublished — non-blocking; ` +
        `${re ? `re-verify without it ${reOk ? 'green' : 'STILL RED'}` : 'no publishable branches remain'}`,
    );
    emit(cli, { ok: reOk, offender, nonBlocking: true, excluded: offender, reverify: { ok: reOk } });
    return reOk ? 0 : 1;
  }
  // Offender is a PUBLISHABLE branch with a journaled pre-ref → the gate bites:
  // roll it back to its pre-ref, HELD(gate), ledger-freeze, then re-verify (its
  // bad merge is gone) per verify.ts's model.
  const current = await revParse(cli.repo, offender);
  try {
    guardRef(offender, passScope(dir)); // protected-ref guard on the rollback write (§8/N1)
    // N1: same checked-out safety as the merge writers — refuse a dirty
    // worktree; after the rollback, reset a clean one to the pre-ref so its
    // index/working tree follow the moved ref instead of silently desyncing.
    const wt = await checkedOutWorktree(cli.repo, offender);
    await resetBranchRef(cli.repo, offender, preRef, current);
    if (wt) await git(cli.repo, ['reset', '--hard', preRef], { cwd: wt }); // clean-verified above
  } catch (e) {
    if (e instanceof DriverHalt) {
      appendJournal(dir, { action: 'halt', branch: offender, reason: e.reason, message: e.message });
      console.error(`HALT: ${e.reason} — ${e.message}`);
      return 1;
    }
    throw e;
  }
  appendJournal(dir, { action: 'pre-ref-rollback', branch: offender, to: preRef });
  appendJournal(dir, {
    action: 'held',
    branch: offender,
    caseId: `gate-${offender.replace(/\//g, '__')}`,
    height: -1,
    conflictedPaths: [],
    reason: 'gate',
  });
  // APPROVED-LANDING offender (D-059 FINAL finding 2): the rolled-back merge
  // was an owner-APPROVED resolution landed at `start`. Without a signal the
  // loop is silent and infinite — every later pass re-derives the still-open
  // approved PR, re-lands it, re-fails verify, re-rolls back, and the owner
  // never learns their approved fix breaks the build. Journal the escalation
  // here (verify is offline); `push` (networked) posts the PR comment WITH the
  // marker advanced to the approving review id, so the next `start` reads the
  // review as addressed and does NOT re-land (escalate-once semantics).
  const approvedRow = journal.find((e) => e.action === 'origin-approved' && e.branch === offender);
  if (approvedRow) {
    appendJournal(dir, {
      action: 'approved-rollback',
      branch: offender,
      ref: typeof approvedRow.ref === 'string' ? approvedRow.ref : null,
      prNumber: typeof approvedRow.prNumber === 'number' ? approvedRow.prNumber : null,
      reviewId: typeof approvedRow.reviewId === 'number' ? approvedRow.reviewId : null,
      detail:
        'the APPROVED landing failed the integration build and was rolled back — owner escalation pending (comment posted by the push stage)',
    });
    console.error(
      `verify: offender ${offender} was an APPROVED landing — escalation journaled (the owner is notified at push; the marker advance stops the re-land loop)`,
    );
  }
  // Gate hold (D-057/D-058): the journaled `held` row above IS the PR_ID state
  // for the rest of the pass — no conflicting head / PR (blockedRows keeps
  // headSha null), so it cannot auto-complete; the owner clears it manually.
  // Cross-pass a gate hold leaves nothing on origin, so the next `start`
  // re-derives the branch unblocked and the offending merge is simply retried.
  // Re-verify on the publishable set with the offender now rolled back + held —
  // it drops out of the recipe (fix 1) so its bad merge is gone (D-051).
  const reRecipe = recipe.filter((b) => b !== offender);
  const re = await verifyEverything(cli.repo, { recipe: reRecipe, ...verifyOpts });
  appendJournal(dir, { action: 'verify', ok: re.ok, offender, rolledBack: offender });
  console.error(
    `verify: RED -> rolled back ${offender} to ${preRef.slice(0, 12)}, HELD(gate); re-verify ${re.ok ? 'green' : 'STILL RED'}`,
  );
  emit(cli, { ok: re.ok, offender, rolledBack: offender, reverify: { ok: re.ok } });
  return re.ok ? 0 : 1;
}

export async function cmdUnfreeze(cli: Cli): Promise<number> {
  if (!cli.branch) {
    console.error('unfreeze: --branch <name> is required');
    return 2;
  }
  const { dir } = await passContext(cli); // attaches to the open pass (for the journal)
  const journal = readJournal(dir);
  const view = passStatusView(cli, journal);
  const st = view.get(cli.branch) ?? null;
  if (!st) {
    console.error(`unfreeze: '${cli.branch}' is not blocked (merge_status is NONE)`);
    return 2;
  }
  const blockedBy =
    st === 'PR_ID'
      ? (blockedRows(journal).get(cli.branch) ?? []).map((r) => r.caseId).join(', ') || 'held'
      : 'deferred';
  if (!cli.execute) {
    console.error(`DRY-RUN (no --execute): would manually unfreeze ${cli.branch} (blocked by ${blockedBy})`);
    emit(cli, { branch: cli.branch, blockedBy });
    return 0;
  }
  // The journaled row clears the block for THIS pass only (D-058): an origin
  // fix/sweep ref with an open PR re-derives the branch blocked at the next
  // `start` — the durable unfreeze is resolving/closing that PR on origin.
  appendJournal(dir, { action: 'unfrozen', branch: cli.branch, reason: 'manual', blockedBy });
  // Reopen the branch + its transitive inventory descendants (finding #2b,
  // as the retired reconcileMergeStatus did): an unfreeze AFTER the branch
  // already `arrived` this pass must re-process it — arrivedSet honors the
  // later `reopened` rows, so the next `run` re-derives them.
  const edges: Record<string, string[]> = Object.fromEntries(directParentEdges(cli));
  reopen(dir, [cli.branch, ...transitiveDescendants(edges, cli.branch)]);
  console.error(`unfroze ${cli.branch} (manual — this pass only; origin re-derives at the next start)`);
  emit(cli, { branch: cli.branch, unfrozen: true, reason: 'manual' });
  return 0;
}

export async function cmdStatus(cli: Cli): Promise<number> {
  const { chain, dir } = await passContext(cli);
  const journal = readJournal(dir);
  const complete = journal.some((e) => e.action === 'pass-complete');
  console.log(`repo:       ${cli.repo}`);
  console.log(`watermark:  ${chain.watermark} (${chain.heads.length} trunk heights from ${chain.base.slice(0, 12)})`);
  console.log(`pass dir:   ${dir}  [${complete ? 'COMPLETE' : 'OPEN'}]`);
  console.log(`ledger:     ${ledgerPathOf(cli)}`);
  console.log(`journal:    ${journal.length} entries`);
  const counts: Record<string, number> = {};
  for (const e of journal) counts[e.action] = (counts[e.action] ?? 0) + 1;
  for (const [action, n] of Object.entries(counts).sort()) console.log(`  ${action.padEnd(12)} ${n}`);
  // merge_status view (D-058): derived from origin rows + this-pass journal —
  // PR_ID (own PR pending) and DEFERRED (sticky behind a blocked parent);
  // heights are live-derived, never stored/shown here.
  const view = passStatusView(cli, journal);
  const rows = blockedRows(journal);
  const prBlocked = [...view.entries()].filter(([, s]) => s === 'PR_ID').map(([b]) => b);
  if (prBlocked.length) {
    console.log('merge_status PR_ID (blocked on their own PR; origin/journal-derived):');
    for (const branch of prBlocked) {
      const rs = rows.get(branch) ?? [];
      if (rs.length === 0) console.log(`  ${branch} (held)`);
      for (const r of rs) {
        console.log(`  ${branch} (${r.caseId})${r.fixBranch ? ` PR head ${r.fixBranch}` : ''}${r.prNumber ? ` #${r.prNumber}` : ''}`);
      }
    }
  }
  const deferred = [...view.entries()].filter(([, s]) => s === 'DEFERRED').map(([b]) => b);
  if (deferred.length) console.log(`merge_status DEFERRED (sticky behind a blocked parent): ${deferred.join(', ')}`);
  const annotates = journal.filter((e) => e.action === 'annotate');
  if (annotates.length) {
    console.log('annotate-class (clean merge THROUGH a HELD-ancestor height, D-002):');
    for (const a of annotates)
      console.log(`  ${a.branch} <- ${a.parent}: passes height ${a.height} held by ${a.heldAncestor}`);
  }
  const urges = journal.filter((e) => e.action === 'urge');
  if (urges.length) console.log(`urges posted: ${urges.length}`);
  const pushes = journal.filter((e) => e.action === 'push');
  if (pushes.length) console.log(`pushes (driver-journaled, D-049): ${pushes.length}`);
  const openCases = journal.filter((e) => e.action === 'case').map((e) => e.caseId as string);
  const resolvedCases = new Set(
    journal.filter((e) => e.action === 'resolved' || e.action === 'held').map((e) => e.caseId as string),
  );
  const open = openCases.filter((c) => !resolvedCases.has(c));
  console.log(`open cases: ${open.length}${open.length ? ` — ${open.join(', ')}` : ''}`);
  const divergedHalts = journal.filter((e) => e.action === 'halt' && e.reason === 'sync-diverged');
  if (divergedHalts.length) {
    console.log('diverged branches (§13 sync — skipped this pass, owner escalation):');
    for (const d of divergedHalts) console.log(`  ${d.branch}: ${d.message}`);
  }
  const mergeFailedHalts = journal.filter((e) => e.action === 'halt' && e.reason === 'merge-failed');
  if (mergeFailedHalts.length) {
    console.log('merge-failed branches (D-047/B11 backstop — halted branch-local, journaled):');
    for (const m of mergeFailedHalts) console.log(`  ${m.branch}: ${m.message}`);
  }
  // D-045 (§13): STATUS shows the full current candidate state (a human state
  // view, unthrottled); `plan` prints only newly-reported candidates.
  const openCandidates = readCandidateFiles(cli.workspace).filter((c) => !c.resolved);
  for (const line of candidateSectionLines(openCandidates)) console.log(line);
  return 0;
}

/**
 * D-052 FIX 4: the end-of-sweep owner summary, derived PURELY from the journal
 * (no git, no GitHub) so a dead or abnormally-terminated session still leaves a
 * readable status. The D-046 owner message the agent sends at end-of-sweep is a
 * thin wrapper over this — the harness can always emit it, and "no pass dies
 * silently" holds even when the agent never composed a message. Prints
 * merged / resolved / held / open-cases / pushed plus the escalation lines
 * (diverged, merge-failed, force-HELD-not-converged, stale-verdicts-cleared);
 * `--out` also writes the same summary as JSON for machine consumers.
 */
export async function cmdReport(cli: Cli): Promise<number> {
  const { dir } = await passContext(cli);
  const journal = readJournal(dir);
  const sealed = journal.some((e) => e.action === 'pass-complete');

  const merged = journal.filter((e) => e.action === 'merge');
  const mergedBranches = [...new Set(merged.map((e) => e.branch as string).filter(Boolean))];

  const resolved: Array<{ caseId: string; branch: string; tier: string }> = [];
  const held: Array<{ caseId: string; branch: string; reason: string }> = [];
  const open: Array<{ caseId: string; branch: string }> = [];
  for (const jc of [...journaledCases(journal).values()].sort((a, b) => a.firstIndex - b.firstIndex)) {
    const disp = lastDisposition(journal, jc.caseId);
    if (!disp) open.push({ caseId: jc.caseId, branch: jc.branch });
    else if (disp.action === 'resolved')
      resolved.push({ caseId: jc.caseId, branch: jc.branch, tier: (disp.tier as string) ?? 'unknown' });
    else
      held.push({
        caseId: jc.caseId,
        branch: jc.branch,
        reason: Array.isArray(disp.notes) ? (disp.notes as string[]).join('; ') : '',
      });
  }

  const pushes = journal.filter((e) => e.action === 'push');
  const pushedBranches = [...new Set(pushes.map((e) => e.branch as string).filter(Boolean))];
  const diverged = journal
    .filter((e) => e.action === 'halt' && e.reason === 'sync-diverged')
    .map((e) => e.branch as string);
  const mergeFailed = journal
    .filter((e) => e.action === 'halt' && e.reason === 'merge-failed')
    .map((e) => e.branch as string);
  const notConverged = journal.filter((e) => e.action === 'resolve-not-converged').map((e) => e.caseId as string);
  const staleCleared = journal.filter((e) => e.action === 'stale-verdict-cleared').length;
  const urges = journal.filter((e) => e.action === 'urge').length;

  console.log(`pass ${dir} — ${sealed ? 'COMPLETE (pass-complete)' : 'OPEN'}`);
  console.log(`merged:   ${merged.length}${mergedBranches.length ? ` (${mergedBranches.join(', ')})` : ''}`);
  console.log(
    `resolved: ${resolved.length}${resolved.length ? ` — ${resolved.map((r) => `${r.caseId} [${r.tier}]`).join(', ')}` : ''}`,
  );
  console.log(`held:     ${held.length}${held.length ? ` — ${held.map((h) => h.caseId).join(', ')}` : ''}`);
  console.log(`open:     ${open.length}${open.length ? ` — ${open.map((o) => o.caseId).join(', ')}` : ''}`);
  console.log(`pushed:   ${pushes.length}${pushedBranches.length ? ` (${pushedBranches.join(', ')})` : ''}`);
  if (diverged.length) console.log(`diverged (owner escalation): ${diverged.join(', ')}`);
  if (mergeFailed.length) console.log(`merge-failed (D-047/B11): ${mergeFailed.join(', ')}`);
  if (notConverged.length) console.log(`resolve-not-converged (force-HELD, ERR26): ${notConverged.join(', ')}`);
  if (staleCleared) console.log(`stale verdicts cleared (WARN05): ${staleCleared}`);

  const summary = {
    passDir: dir,
    sealed,
    merged: mergedBranches,
    mergedCount: merged.length,
    resolved,
    held,
    openCases: open,
    pushed: pushedBranches,
    diverged,
    mergeFailed,
    notConverged,
    staleVerdictsCleared: staleCleared,
    urges,
  };
  // D-054: when driven internally by `finish`, do NOT write --out — that file is
  // the outer command's result; the human summary above still prints (ignored by
  // the SWEEP-RESULT/SWEEP-STEP monitor contract, but useful in a foreground run).
  if (cli.out && !cli.internal) {
    writeFileSync(cli.out, JSON.stringify(summary, null, 2) + '\n');
    console.log(`wrote ${cli.out}`);
  }
  return 0;
}

// ==========================================================================
// D-053 — sweep state machine (SWEEP-STATE-MACHINE.md). The canonical
// AGENT-FACING surface: five commands (start / next-case / report-case /
// report-pr / finish) plus `abort`, driven by a resumable machine-state record
// in the pass dir. The agent has ZERO identifying params — the driver holds the
// watermark, the current case, the phase and the journal — which structurally
// removes the wrong-case / wrong-ref / stale-verdict / forged-plan bug classes
// (SWEEP-STATE-MACHINE.md §1/§5). These functions WRAP the deterministic
// internals above (plan/run/reverify/merge/publish/verify/push) — they never
// re-implement them. The ONLY LLM call in the loop is the cold read, run here
// via an INJECTABLE invoker that shells `claude -p` (default) — there is NO
// verdict file and NO freshness binding on this path (the driver holds the
// resolved tree and pipes the request straight to `claude -p`). The flag-based
// `resolve`/`publish` agent path (verdict file + freshness binding) is KEPT
// working (still the driver's tested implementation + reused sub-helpers), but
// is superseded as the AGENT surface by these commands.
// ==========================================================================

/** Machine phases (SWEEP-STATE-MACHINE.md §5): a dead container resumes here. */
type MachinePhase = 'open' | 'case-ready' | 'awaiting-pr' | 'finishing' | 'complete';

interface MachineState {
  schemaVersion: 1;
  phase: MachinePhase;
  watermark: string;
  watermark12: string;
  /** The case the agent is currently editing/reporting (driver-held, D-053). */
  currentCase: { caseId: string; branch: string; tier?: 'mechanical' | 'judged' | 'held' } | null;
  /** Resumable `finish` sub-phase (finishing only). */
  finishStep?: 'verify' | 'judged-prs' | 'push' | 'held-prs' | 'report' | 'done';
}

function machineStatePath(dir: string): string {
  return join(dir, 'machine-state.json');
}

function readMachineState(dir: string): MachineState | null {
  const p = machineStatePath(dir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as MachineState;
}

/** Persist the machine state AND journal the transition (§5: all transitions journaled). */
function writeMachineState(dir: string, st: MachineState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(machineStatePath(dir), JSON.stringify(st, null, 2) + '\n');
  appendJournal(dir, {
    action: 'machine',
    phase: st.phase,
    currentCase: st.currentCase?.caseId ?? null,
    ...(st.finishStep ? { finishStep: st.finishStep } : {}),
  });
}

// --------------------------------------------------------------------------
// Cold read — injectable `claude -p` invoker (D-053; the ONLY LLM call in the
// loop). The driver composes a FOCUSED request (D-050 preamble + three bounded
// questions + driver-derived context, NOTHING agent-authored), pipes it to
// `claude -p` as a synchronous, context-free subprocess, and parses the verdict
// from stdout. Tests inject a fake invoker returning a canned verdict.
// --------------------------------------------------------------------------

/** The verdict a cold read returns (parsed from `claude -p` stdout, or injected). */
export interface MachineVerdict {
  /**
   * `confirm`/`reject` are CONTENT decisions from a cold read that actually RAN.
   * `error` is an INFRA failure of the tooling (spawn error, non-zero exit,
   * unparseable stdout, or a recognizable auth/login failure) — NOT a content
   * decision (D-054). It must NOT collapse to reject/HELD: a broken tool marking
   * resolutions as content-rejected is the bug this distinguishes. `error` maps
   * to a hard blocking halt (ERR35_COLDREAD_UNAVAILABLE) at the call sites.
   */
  verdict: 'confirm' | 'reject' | 'error';
  answers?: Partial<Record<'q1' | 'q2' | 'q3', string>>;
  notes: string;
  /**
   * Short (1-2 line) reviewer feedback for the RESOLVING AGENT (D-057): why
   * the rejection / what is off. Surfaced on a reject so the agent can act;
   * reused as the PR-description prefix on a HELD escalation. Bounded
   * (COLDREAD_FEEDBACK_CAP) at parse.
   */
  feedback?: string;
  /** verdict:'error' only — the infra reason (surfaced in the ERR35 halt detail). */
  reason?: string;
  /**
   * report-pr only: when the RESOLUTION is sound but the PR DESCRIPTION
   * misrepresents it, the reader flags `description` — a description-only
   * defect → `rewrite`, not a freeze. Absent/`code` = a resolution-level defect
   * (fail-closed to HELD). Never lets a bad resolution through as a rewrite.
   */
  defect?: 'code' | 'description' | null;
}

/** Auth/login failure text a broken `claude -p` prints (often at exit 0) — infra, not content. */
const COLDREAD_AUTH_FAILURE = /not logged in|invalid api key|authentication_error|unauthorized|please run.*login|login expired|credit balance is too low/i;

/**
 * D-055: the notes/reason a cold-read INFRA failure leaves behind — a `claude -p`
 * that could not RUN, NOT a content decision. `verdict:'error'` (D-054) is the
 * canonical shape; this regex ALSO recognizes a pre-D-054 leftover verdict FILE
 * that fail-closed a `claude -p` failure to `reject` — the 2026-07-22 bug, whose
 * `coldread-verdict.json` read `{"verdict":"reject","notes":"claude -p failed
 * (status 1) — fail-closed (D-053)"}`. Either shape MUST hard-halt (ERR35), never
 * freeze HELD. Only a cold read that actually RAN and judged the content rejects.
 */
const COLDREAD_INFRA_NOTE = /claude -p failed|no parseable verdict|tooling (error|unavailable)|cold read auth\/login failure/i;

/**
 * True when a verdict (parsed `MachineVerdict` OR a `coldread-verdict.json` read
 * off disk) is an INFRA failure rather than a content decision (D-055). The
 * `verdict:'error'` form is authoritative; the notes/reason regexes catch a
 * stale/legacy verdict file that recorded an infra failure as a `reject`.
 */
function coldReadInfraFailure(v: { verdict?: unknown; notes?: unknown; reason?: unknown }): boolean {
  if (v.verdict === 'error') return true;
  const text = `${typeof v.reason === 'string' ? v.reason : ''} ${typeof v.notes === 'string' ? v.notes : ''}`;
  return COLDREAD_INFRA_NOTE.test(text) || COLDREAD_AUTH_FAILURE.test(text);
}

/** Injectable cold-read invoker: prompt in, verdict out (default shells `claude -p`). */
export type ColdReadInvoker = (prompt: string) => Promise<MachineVerdict>;

/**
 * Parse the last JSON object printed by `claude -p`. A valid confirm/reject is a
 * content decision. Otherwise → `error` (D-054): recognizable auth/login failure
 * text (which `claude -p` often prints AT EXIT 0) is an infra error, and so is a
 * total absence of a parseable verdict — NEITHER is a content reject.
 */
export function parseMachineVerdict(stdout: string): MachineVerdict {
  const matches = stdout.match(/\{[\s\S]*\}/g);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const v = JSON.parse(matches[i]) as Partial<MachineVerdict>;
        if (v.verdict === 'confirm' || v.verdict === 'reject') {
          const feedback = boundedFeedback(v);
          return {
            verdict: v.verdict,
            answers: v.answers,
            notes: typeof v.notes === 'string' ? v.notes : '',
            ...(feedback !== null ? { feedback } : {}),
            defect: v.defect ?? null,
          };
        }
      } catch {
        /* try the next candidate */
      }
    }
  }
  if (COLDREAD_AUTH_FAILURE.test(stdout)) {
    return { verdict: 'error', notes: '', reason: `cold read auth/login failure: ${stdout.trim().slice(0, 300)}` };
  }
  return { verdict: 'error', notes: '', reason: 'cold read produced no parseable verdict (tooling error, D-054)' };
}

/**
 * Default invoker: a synchronous `claude -p` subprocess, request on stdin. D-054:
 * `claude` scrubs env for its own Bash subprocesses, so the spawned `claude -p`
 * loses CLAUDE_CODE_OAUTH_TOKEN — read it from the credentials file and inject it
 * (silent if the file is unreadable: fall through to the infra-error path, never
 * crash). A spawn error / non-zero exit → `error` (infra), never a content reject.
 */
export const defaultColdReadInvoker: ColdReadInvoker = async (prompt) => {
  const env = { ...process.env };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
      if (creds?.claudeAiOauth?.accessToken) env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeAiOauth.accessToken;
    } catch {
      /* credentials unreadable — fall through to the infra-error path */
    }
  }
  const res = spawnSync('claude', ['-p'], { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  if (res.status !== 0 || typeof res.stdout !== 'string') {
    return {
      verdict: 'error',
      notes: '',
      reason: `claude -p failed (status ${res.status ?? 'null'}${res.error ? `: ${res.error.message}` : ''})`,
    };
  }
  return parseMachineVerdict(res.stdout);
};

/**
 * Fail-closed reduction shared by both cold reads (mirrors cmdResolve's D-050
 * gate): an overall `reject`, OR an `UNVERIFIABLE-FROM-REQUEST` answer on any of
 * Q1-Q3, is a reject. Returns the unverifiable question list for the notes.
 */
function coldReadRejected(v: MachineVerdict): { rejected: boolean; unverifiable: string[] } {
  const unverifiable = (['q1', 'q2', 'q3'] as const).filter((q) =>
    /UNVERIFIABLE-FROM-REQUEST/i.test(String(v.answers?.[q] ?? '')),
  );
  return { rejected: v.verdict === 'reject' || unverifiable.length > 0, unverifiable };
}

/**
 * The FOCUSED cold-read prompt for the state-machine path — same D-050 preamble,
 * three bounded questions and driver-derived context as `coldReadRequest`, but
 * asking `claude -p` to PRINT a JSON verdict (no verdict file). `description`,
 * when present (report-pr), is judged alongside the code: the reader flags a
 * `description` defect when the prose misrepresents an otherwise-sound
 * resolution (→ rewrite) and a `code` defect otherwise (→ fail-closed HELD).
 */
function machineColdReadPrompt(opts: {
  id: string;
  branch: string;
  parent: string;
  height: number;
  conflictedPaths: string[];
  contextLines: string[];
  conflictDiff: string;
  resolutionDiff: string | null;
  description?: { title: string; body: string } | null;
}): string {
  const lines: string[] = [
    `# Cold-read request — ${opts.id} (state-machine path, D-053)`,
    '',
    ...COLD_READ_PREAMBLE,
    '',
    `Branch: ${opts.branch}   Parent: ${opts.parent}   Height: ${opts.height}`,
    `Conflicted paths: ${opts.conflictedPaths.join(', ')}`,
    '',
    ...opts.contextLines,
    '',
    '## Conflict hunks (branch tip -> automerge tree)',
    '```diff',
    opts.conflictDiff,
    '```',
    '',
    '## Resolution diff (automerge tree -> resolved tree)',
    ...(opts.resolutionDiff === null
      ? [
          '_No resolution — this is a frozen-conflict (HELD) exhibit; judge the description against the conflict above._',
        ]
      : ['```diff', opts.resolutionDiff, '```']),
  ];
  if (opts.description) {
    lines.push(
      '',
      '## PR description under review (agent-written)',
      `### title`,
      opts.description.title,
      `### body`,
      opts.description.body,
    );
  }
  lines.push(
    '',
    '## Cold-reader questions',
    ...COLD_READ_QUESTIONS,
    '',
    '## Output',
    'Print ONLY a JSON object on the final line — no prose around it:',
    '```json',
    '{"verdict":"confirm|reject","answers":{"q1":"...","q2":"...","q3":"..."},"notes":"...","feedback":"...","defect":"code|description|null"}',
    '```',
    '- `reject` if any of Q1-Q3 fails, or answer `UNVERIFIABLE-FROM-REQUEST` for a point you cannot judge (fail-closed).',
    '- `feedback`: 1-2 lines for the RESOLVING AGENT — why the reject / what is off (omit when nothing is).',
    ...(opts.description
      ? [
          '- set `"defect":"description"` ONLY when the resolution is sound but the DESCRIPTION misrepresents it; otherwise `"code"`.',
        ]
      : []),
  );
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Branch-scoped tests (D-053) — a CHEAP per-case gate, NOT the finish-time
// everything-rebuild (D-051). Injectable so tests never spawn a real matrix;
// the default builds an ephemeral merge of the resolved tree in a temp worktree
// and runs the caller's command list (--commands-file), skipping (green) when
// none is configured — the authoritative full battery still runs at `finish`.
// --------------------------------------------------------------------------

export interface BranchTestArgs {
  repo: string;
  branch: string;
  branchTip: string;
  head: string;
  resolvedTree: string;
  conflictedPaths: string[];
  commands: VerifyCommand[];
  caseDir: string;
}

export interface BranchTestOutcome {
  ok: boolean;
  detail?: string;
  detailPath?: string;
}

export type BranchTestRunner = (args: BranchTestArgs) => Promise<BranchTestOutcome>;

export const defaultBranchTestRunner: BranchTestRunner = async (args) => {
  if (args.commands.length === 0) return { ok: true }; // no cheap gate configured — finish's rebuild is authoritative
  const amCommit = (
    await git(args.repo, ['commit-tree', args.resolvedTree, '-p', args.branchTip, '-p', args.head, '-m', 'branch-test'])
  ).stdout.trim();
  const wt = await addTempWorktree(args.repo, amCommit);
  try {
    for (const { cmd, cwd } of args.commands) {
      const res = spawnSync('bash', ['-c', cmd], {
        cwd: cwd ? join(wt.path, cwd) : wt.path,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.status !== 0) {
        const detailPath = join(args.caseDir, 'branch-tests.log');
        writeFileSync(detailPath, `$ ${cmd}\n${(res.stdout ?? '') + (res.stderr ?? '')}`);
        return { ok: false, detail: `\`${cmd}\` failed (exit ${res.status})`, detailPath };
      }
    }
    return { ok: true };
  } finally {
    await wt.remove();
  }
};

// --------------------------------------------------------------------------
// Shared machine helpers.
// --------------------------------------------------------------------------

/** The driver-prepared case worktree path (createCaseWorktree, SPEC 1). */
function caseWorktreePath(dir: string, caseId: string): string {
  return join(dir, caseId, 'worktree');
}

/** Snapshot the resolved tree from the case worktree (stage all, write-tree). */
async function snapshotWorktreeTree(repo: string, wtPath: string): Promise<string> {
  await git(repo, ['add', '-A'], { cwd: wtPath });
  return (await git(repo, ['write-tree'], { cwd: wtPath })).stdout.trim();
}

/** Still-present conflict markers in the resolved paths (an unresolved worktree). */
async function unresolvedMarkers(repo: string, tree: string, paths: string[]): Promise<string[]> {
  const bad: string[] = [];
  for (const p of paths) {
    const res = await git(repo, ['cat-file', '-p', `${tree}:${p}`], { allowCodes: [128] });
    if (res.code === 0 && /^(<{7}|={7}|>{7})/m.test(res.stdout)) bad.push(p);
  }
  return bad;
}

/** Driver-authored case materials (D-048) for the case-ready hand-off. */
async function machineCaseMaterials(cli: Cli, jc: JournaledCase): Promise<string> {
  const tip = await revParse(cli.repo, jc.branch);
  const sides = await perSideLog(cli.repo, tip, jc.head.sha, jc.conflictedPaths);
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  return [
    `# Case materials — ${jc.caseId}`,
    '',
    'RESOLVE ONLY THE PENDING FILES. The driver committed everything that merged',
    'cleanly (the clean prefix) and left ONLY the conflicted paths below pending —',
    '`git status` shows exactly them. Those pending files are your EDIT scope: change',
    'nothing outside them. To resolve correctly you must UNDERSTAND BOTH SIDES, so you',
    'SHOULD read what the conflict hunks directly implicate — the two versions of the',
    'conflicted code, and the definitions / call sites / relevant tests of the symbols',
    'IN the hunks — targeted (each file once, use offset/limit), never re-reading. That',
    'is understanding this delta, NOT exploring the repo: no whole-tree reads, no broad',
    '`git log`/history/decision-log spelunking, no unrelated branches, no "study until it',
    'clicks." If a bounded look at the implicated code is not enough to decide, that is a',
    '`--tier held` (escalate) — never an ever-widening search.',
    '',
    '## Conflicted paths (the pending files — your edit scope)',
    ...jc.conflictedPaths.map((p) => `- ${p}`),
    '',
    `Branch: ${jc.branch}   Parent: ${jc.parent}   Head: ${jc.head.sha.slice(0, 12)} (height ${jc.head.height})`,
    '',
    ...inventoryContextLines(registry.features, jc.branch, jc.parent, jc.conflictedPaths),
    '',
    `## ours (\`${jc.branch}\`) — \`git log --oneline\` over the conflicted paths`,
    '```',
    sides.ours,
    '```',
    '',
    `## theirs (\`${jc.parent}\`) — same range on the other side`,
    '```',
    sides.theirs,
    '```',
    '',
    'Resolve the conflict in the worktree above, then run `report-case --tier mechanical|judged|held`.',
  ].join('\n');
}

/**
 * One turn of the reissue DIALOG (D-059 FINAL): the FULL review conversation —
 * issue comments + inline review comments + review bodies + the PR description
 * — merged time-ordered. The agent's OWN prior messages (driver-posted,
 * marker-bearing; plus the PR description it wrote) are served back
 * TAG-STRIPPED and marked `agent`; every other message keeps the author's
 * GitHub login so the agent can address them. Marker-only messages (empty
 * after the strip) are dropped.
 */
interface DialogItem {
  role: 'agent' | 'reviewer';
  /** GitHub login for reviewer turns; '' for the agent's own turns. */
  author: string;
  kind: 'pr-description' | 'comment' | 'inline-comment' | 'review';
  id: number | null;
  /** ISO timestamp (created_at / submitted_at) — the sort key. */
  at: string;
  body: string;
  /** inline-comment only: the anchored file path. */
  path?: string;
  /** review only: APPROVED / CHANGES_REQUESTED / COMMENTED / ... */
  reviewState?: string;
}

/** Assemble the time-ordered reissue dialog (pure; see DialogItem). */
function buildReviewDialog(args: {
  pr: Pick<PrByHead, 'body' | 'createdAt'>;
  issueComments: PrComment[];
  inlineComments: PrComment[];
  reviews: PrReview[];
}): DialogItem[] {
  const items: DialogItem[] = [];
  const description = stripSweepAddressed(args.pr.body);
  if (description) {
    items.push({ role: 'agent', author: '', kind: 'pr-description', id: null, at: args.pr.createdAt, body: description });
  }
  // Finding 4: same reality bound as the trigger — a human comment pasting an
  // out-of-range marker stays a REVIEWER turn, never `you (prior)`.
  const { humans, driver } = classifyComments(args.issueComments, maxRealReviewId(args.reviews));
  for (const c of driver) {
    const stripped = stripSweepAddressed(c.body);
    if (!stripped) continue; // marker-only bookkeeping — not a dialog turn
    items.push({ role: 'agent', author: '', kind: 'comment', id: c.id, at: c.createdAt, body: stripped });
  }
  for (const c of humans) {
    items.push({ role: 'reviewer', author: c.author, kind: 'comment', id: c.id, at: c.createdAt, body: c.body.trim() });
  }
  for (const c of args.inlineComments) {
    items.push({
      role: 'reviewer',
      author: c.author,
      kind: 'inline-comment',
      id: c.id,
      at: c.createdAt,
      body: c.body.trim(),
      ...(c.path ? { path: c.path } : {}),
    });
  }
  for (const r of args.reviews) {
    items.push({
      role: 'reviewer',
      author: r.author,
      kind: 'review',
      id: r.id,
      at: r.submittedAt,
      body: r.body.trim(),
      reviewState: r.state,
    });
  }
  // Time-ordered; the PR description (the opening turn) pinned first.
  return items.sort((a, b) => {
    if (a.kind === 'pr-description') return -1;
    if (b.kind === 'pr-description') return 1;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id ?? 0) - (b.id ?? 0);
  });
}

/** Render one dialog turn for the reissue materials. */
function renderDialogItem(item: DialogItem): string[] {
  const who = item.role === 'agent' ? 'you (prior)' : `@${item.author || 'unknown'}`;
  const what =
    item.kind === 'pr-description'
      ? 'PR description'
      : item.kind === 'review'
        ? `review ${item.id} — ${item.reviewState ?? ''}`.trim()
        : item.kind === 'inline-comment'
          ? `inline comment ${item.id}${item.path ? ` on ${item.path}` : ''}`
          : `comment ${item.id}`;
  return ['', `### ${who} — ${what}${item.at ? ` (${item.at})` : ''}`, item.body || '(no text)'];
}

function reissueCaseMaterials(dir: string, jc: JournaledCase, caseRow: JournalEntry): string {
  const dialogPath = join(dir, jc.caseId, 'dialog.json');
  const dialog: DialogItem[] = existsSync(dialogPath)
    ? (JSON.parse(readFileSync(dialogPath, 'utf8')) as DialogItem[])
    : [];
  const latestState = typeof caseRow.reviewState === 'string' ? caseRow.reviewState : 'CHANGES_REQUESTED';
  const approvedStale = latestState === 'APPROVED';
  return [
    `# Case materials — ${jc.caseId} (REISSUE — revise the published resolution)`,
    '',
    approvedStale
      ? `Your prior resolution on PR #${caseRow.prNumber} was APPROVED, but the target branch advanced and it no`
      : `A reviewer SUBMITTED A REVIEW (${latestState}) on your prior resolution on PR #${caseRow.prNumber} —`,
    approvedStale
      ? 'longer merges cleanly — RE-RESOLVE it against the new base; keep the approved intent intact.'
      : 'REVISE the resolution accordingly; do not start over.',
    'The case worktree already contains the PRIOR RESOLUTION as the pending files (`git status` shows exactly',
    'them): edit those files to address every reviewer point, changing nothing outside them. When done, run',
    '`report-case --tier held` — the driver republishes the revision to the SAME PR at finish (never a new PR,',
    'never a local merge).',
    '',
    '## Review dialog (FULL thread, time-ordered — oldest first)',
    'Turns marked `you (prior)` are YOUR OWN earlier messages (PR description / replies you posted through the',
    'driver). Every other turn names its author by GitHub login — address them by that @login in your reply.',
    ...dialog.flatMap(renderDialogItem),
    '',
    '## Conflicted paths (the pending files — your edit scope)',
    ...jc.conflictedPaths.map((p) => `- ${p}`),
    '',
    `Branch: ${jc.branch}   Parent: ${jc.parent}   Head: ${jc.head.sha.slice(0, 12)} (height ${jc.head.height})`,
    `Existing PR: #${caseRow.prNumber}${typeof caseRow.prUrl === 'string' ? ` (${caseRow.prUrl})` : ''} — the revision replaces its head (fix ref '${caseRow.fixBranch}').`,
    '',
    'Revise the resolution in the worktree above, then run `report-case --tier held`.',
  ].join('\n');
}

/** Undispositioned cases this pass, topmost-first (DAG order = journal order). */
function openCases(journal: JournalEntry[]): JournaledCase[] {
  const cases = journaledCases(journal);
  return [...cases.values()]
    .filter((c) => lastDisposition(journal, c.caseId) === null)
    .sort((a, b) => a.firstIndex - b.firstIndex);
}

/** The branch-test command list for a case (opt-in via --commands-file). */
function branchTestCommands(cli: Cli): VerifyCommand[] {
  return cli.commandsFile ? (JSON.parse(readFileSync(cli.commandsFile, 'utf8')) as VerifyCommand[]) : [];
}

// --------------------------------------------------------------------------
// `sweep start` / `sweep abort` (SWEEP-STATE-MACHINE.md §2).
// --------------------------------------------------------------------------

/**
 * D-059 (REISSUE case-serving mechanics, FINAL review-trigger model): an open
 * PR with a SUBMITTED review beyond the sweep-addressed marker gets its case
 * served THIS pass as a REVISION of the published resolution, not a fresh
 * resolve. The case is driver-manufactured here at `start` (run skips the
 * PR_ID branch, so it would never emit one): the conflict head is the fix ref
 * head's 2nd parent (driver-built PR heads are `[tip|prefix, conflictHead]`
 * merges) — and when the OWNER PUSHED onto the fix ref (head no longer
 * driver-shaped / sha8 mismatch) the case is REBUILT from the CURRENT ref
 * head: the conflict head re-derives from the ref name's sha8 and the owner's
 * edit is served as the revision base (journaled `reissue-rebuilt`). Parent +
 * height come from the deterministic ref name (`fixBranchName`), the conflict
 * set/automerge tree are RE-PROBED live against origin/<target>, and the case
 * worktree is materialized FROM THE CURRENT REF HEAD so the agent edits the
 * existing resolution (owner edits included). The FULL review dialog
 * (description + comments + inline comments + reviews, time-ordered) is
 * stored (dialog.json) for the materials. A ref that is TRULY UNUSABLE
 * (unparseable name, unrecoverable conflict head, healed conflict, missing
 * origin base) is ESCALATED ONCE: a driver comment on the PR names the
 * problem and carries the marker at the triggering review id, so the next
 * pass does NOT re-trigger — no per-pass warn-loop; the branch stays blocked.
 * The revised resolution then flows report-case (forced HELD) → report-pr
 * (intent) → finish, where cmdPublish re-checks the PR's LIVE state,
 * force-with-lease updates the fix ref and posts the new marker.
 */
async function materializeReissueCase(
  cli: Cli,
  dir: string,
  transport: GithubTransport,
  slugParts: { owner: string; repo: string },
  args: {
    ref: string;
    refSha: string;
    branch: string;
    pr: PrByHead;
    dialog: DialogItem[];
    latestReview: PrReview;
    markerId: number | null;
    parentCandidates: Array<{ branch: string; slug: string }>;
    ancestors: string[];
    features: FeatureEntry[];
  },
): Promise<void> {
  // ESCALATE ONCE (D-059 FINAL): post the problem to the PR WITH the marker at
  // the triggering review id — the owner is notified exactly once and the next
  // pass reads the marker as current (no re-trigger, no warn-loop). Throws on
  // API failure (the caller maps it to ERR13 — fail-closed).
  const escalateOnce = async (reason: string): Promise<void> => {
    const body = [
      `Sweep escalation (driver-posted): the review on this PR cannot be served as a revision case — ${reason}.`,
      `Owner action needed on \`${args.ref}\` (target \`${args.branch}\`); the branch stays blocked meanwhile.`,
      `Note: this advances the sweep-addressed marker to review ${args.latestReview.id}, so the sweep will NOT re-serve this until a NEW review arrives — after fixing the ref, SUBMIT A NEW REVIEW on this PR to re-trigger the loop.`,
      renderSweepAddressed(args.latestReview.id),
    ].join('\n');
    await ghExpect(transport, 'POST', `/repos/${slugParts.owner}/${slugParts.repo}/issues/${args.pr.number}/comments`, {
      body,
    });
    appendJournal(dir, {
      action: 'origin-ref-escalated',
      ref: args.ref,
      branch: args.branch,
      prNumber: args.pr.number,
      reviewId: args.latestReview.id,
      reason,
    });
    console.error(
      `sweep start: ESCALATED once on PR #${args.pr.number} — ${reason}; '${args.ref}' stays blocked WITHOUT a reissue case (marker advanced to review ${args.latestReview.id})`,
    );
  };
  // (a) parent + height + conflict-head sha8 from the deterministic ref name
  // (fixBranchName shape) — the identity survives owner pushes onto the ref.
  const rest = args.ref.slice('fix/sweep/'.length).slice(slug(args.branch).length + 2); // past '<slug(branch)>--'
  const parentEntry = args.parentCandidates.find((c) => rest.startsWith(`${c.slug}-h`));
  const hm = /-h(-?\d+)-([0-9a-f]{8})$/.exec(rest);
  if (!parentEntry || !hm) {
    return escalateOnce(`cannot parse parent/height from the ref name '${args.ref}'`);
  }
  const parent = parentEntry.branch;
  const height = Number(hm[1]);
  const sha8 = hm[2];
  // (b) the conflict head: the ref head's 2nd parent when driver-shaped;
  // otherwise (owner pushed a commit onto fix/sweep — head not driver-shaped /
  // sha8 mismatch) REBUILD from the ref name's sha8 and serve the owner's edit
  // as the revision base.
  const info = await commitInfo(cli.repo, args.refSha);
  let conflictHead = info.parents[1] && info.parents[1].startsWith(sha8) ? info.parents[1] : null;
  if (!conflictHead) {
    const resolved = await git(cli.repo, ['rev-parse', '--verify', '--quiet', `${sha8}^{commit}`], {
      allowCodes: [1, 128],
    });
    if (resolved.code !== 0 || !resolved.stdout.trim()) {
      return escalateOnce(
        `the ref head ${args.refSha.slice(0, 12)} is not driver-shaped and its conflict head '${sha8}' cannot be resolved`,
      );
    }
    conflictHead = resolved.stdout.trim();
    appendJournal(dir, {
      action: 'reissue-rebuilt',
      ref: args.ref,
      branch: args.branch,
      ownerHead: args.refSha,
      conflictHead,
      detail: 'owner pushed onto the fix ref — case rebuilt from the CURRENT ref head (owner edit served as the base)',
    });
    console.error(
      `sweep start: '${args.ref}' head ${args.refSha.slice(0, 12)} is not driver-shaped (owner push) — rebuilding the reissue case from the current ref head`,
    );
  }
  // (c) live conflict, probed against the ORIGIN tip (the authority; run
  // ff-syncs the local branch to it before the case is acted on).
  if (!(await refExists(cli.repo, `origin/${args.branch}`))) {
    return escalateOnce(`origin/${args.branch} does not exist — cannot probe the conflict`);
  }
  const tip = await revParse(cli.repo, `origin/${args.branch}`);
  const probe = await newStyleMergeTree(cli.repo, tip, conflictHead);
  if (probe.clean) {
    return escalateOnce(
      `no live conflict remains for '${args.branch}' <- ${conflictHead.slice(0, 12)} (healed) — the PR may be obsolete`,
    );
  }
  const cid = caseId(args.branch, parent, height);
  const head = { sha: conflictHead, height };
  const feat = args.features.find((f) => f.branch === args.branch) as
    | (FeatureEntry & { tier_floor?: string })
    | undefined;
  const caseFile: CaseFile = {
    schemaVersion: 1,
    id: cid,
    branch: args.branch,
    parent,
    head,
    run: [head],
    tierFloor: tierFloor(args.branch, feat),
    conflictedPaths: probe.conflictFiles,
    automergeTree: probe.treeOid,
    reproduction: { command: `git merge-tree --write-tree --name-only ${tip} ${conflictHead}` },
    deferredCheck: { firstConflictHeight: height, transitiveAncestors: args.ancestors },
  };
  writeJsonFile(join(dir, cid, 'case.json'), caseFile);
  writeJsonFile(join(dir, cid, 'dialog.json'), args.dialog);
  appendJournal(dir, {
    action: 'case',
    branch: args.branch,
    parent,
    caseId: cid,
    head,
    height,
    run: caseFile.run,
    conflictedPaths: caseFile.conflictedPaths,
    reissue: true,
    fixBranch: args.ref,
    priorHead: args.refSha,
    prNumber: args.pr.number,
    prUrl: args.pr.url,
    reviewState: args.latestReview.state,
    addressedReviewId: args.latestReview.id,
    markerId: args.markerId,
  });
  await createCaseWorktree(cli, dir, caseFile, tip, args.refSha); // pending files = the CURRENT ref head (prior resolution / owner edit)
  console.error(
    `sweep start: REISSUE ${cid} — PR #${args.pr.number} carries review ${args.latestReview.id} (${args.latestReview.state}) beyond the sweep-addressed marker; serving a revision case this pass`,
  );
}

/**
 * D-059 case 5 — crashed publish (ref pushed, PR never created): the ref's
 * resolution is AUTHORITATIVE, so `start` COMPLETES the publish by creating
 * the missing PR on the existing head — nothing is re-derived and the ref is
 * never deleted. Draft-vs-active re-derives from the ref content itself
 * (conflict markers anywhere in its own diff → the pristine-conflict DRAFT;
 * marker-clean → the ACTIVE review PR). The title is the ref head's commit
 * subject; the body is driver BOOKKEEPING prose only (like the D-004 block —
 * the agent prose of the crashed pass is gone with its pass dir), and the
 * sweep-addressed marker is posted at 0 (nothing addressed yet). Throws on any
 * API failure — the caller maps it to ERR13 (fail-closed).
 */
async function createRecoveryPr(
  cli: Cli,
  transport: GithubTransport,
  slugParts: { owner: string; repo: string },
  u: { ref: string; sha: string; branch: string },
): Promise<{ number: number; url: string; draft: boolean }> {
  const info = await commitInfo(cli.repo, u.sha);
  const changed = (await git(cli.repo, ['diff', '--name-only', `${u.sha}^`, u.sha], { allowCodes: [1, 128] })).stdout
    .split('\n')
    .filter(Boolean);
  const markers = await unresolvedMarkers(cli.repo, u.sha, changed);
  const draft = markers.length > 0;
  const title = info.subject || `Sweep resolution for ${u.branch} (recovered publish)`;
  const body = [
    `Recovered publish (D-059): the resolution ref \`${u.ref}\` was pushed by an earlier pass, but its PR was`,
    'never created (crashed publish). The resolution on the ref is authoritative — this PR completes that',
    'publish; nothing was re-derived.',
    '',
    draft
      ? `The head carries the pristine conflict (markers in place) — a DRAFT: resolve fresh, then merge into \`${u.branch}\`.`
      : `Review the resolution and merge it into \`${u.branch}\` to unblock propagation.`,
  ].join('\n');
  const created = await createPullRequest(transport, slugParts, { title, body, head: u.ref, base: u.branch, draft });
  await postSweepAddressed(transport, slugParts, created.number, 0);
  return { ...created, draft };
}

/**
 * D-058 §2 → D-059 FINAL — reconstruct the blocked (PR_ID) set from ORIGIN
 * alone. For every `origin/fix/sweep/*` ref (post-fetch), parse the TARGET
 * branch out of the ref name (fix/sweep/<slug(branch)>--<slug(parent)>-h<n>-
 * <sha8>; matched against the registry scope's branch slugs, longest match
 * wins) and classify (`start` deletes a ref ONLY when its PR/head MERGED; the
 * D-058 orphan-delete is retired):
 *  1. ref IS an ancestor of origin/<target> → RESOLVED (the owner merged the
 *     PR / it landed): not blocked; delete the origin ref (cleanup).
 *  2. unmerged + OPEN PR + NO submitted non-bot review above the
 *     sweep-addressed marker → PR_ID: journal an `origin-blocked` row
 *     {branch, fixBranch, headSha, prNumber, markerId} — the pass's blocked
 *     view + block-height source (`prBlockedRecords`). Loose issue comments
 *     and standalone inline comments NEVER trigger anything.
 *  3. unmerged + OPEN PR + a submitted non-bot REVIEW above the marker →
 *     the review-state table (all landing verify-gated at finish):
 *       - APPROVED and the ref head still merges CLEANLY into the CURRENT
 *         target → LAND: merge it into the local target now (journaled
 *         `origin-approved` + `resolved` tier 'approved'; pre-ref recorded),
 *         NOT blocked — finish verifies and pushes the target, the push
 *         auto-flips the PR to merged (D-040); no reissue.
 *       - APPROVED but the target advanced so it no longer merges cleanly →
 *         REISSUE (the agent re-resolves against the new base): PR_ID row +
 *         a revision case (`materializeReissueCase`).
 *       - CHANGES_REQUESTED / COMMENTED / other → REISSUE, forced HELD
 *         downstream (stays in the review loop, never auto-merged).
 *  4. unmerged + PR CLOSED:
 *       - merged_at set (squash/rebase-merged — head not an ancestor) →
 *         RESOLVED: delete the ref; NEVER attempt a reopen on a merged PR
 *         (GitHub 422s it — the retired ERR13 halt).
 *       - genuinely closed unmerged → REOPEN the PR (driver PATCH state=open)
 *         → PR_ID. Replaces the D-058 delete.
 *  5. unmerged + NO PR at all (crashed publish) → (re)create the PR from the
 *     ref (`createRecoveryPr`) → PR_ID. The ref's resolution is authoritative;
 *     never re-derived, never deleted.
 *  6. ref ABSENT entirely (nothing on origin, not merged) → nothing here: the
 *     resolution is lost, so the pass re-derives the conflict fresh (a normal
 *     new case → new PR at finish).
 * A ref whose slug matches no scope branch is journaled `origin-ref-unknown`
 * and left alone (unknown provenance: never deleted, never blocking).
 *
 * Every GitHub list is PAGINATED to exhaustion (GitHub returns oldest-first —
 * page-1-only truncated the newest reviews) and FAIL-CLOSED: any non-200 on a
 * needed lookup/write is an ERR13 halt — never a wrongful mutation. Start's
 * origin WRITES (merged-ref delete, reopen, recovery PR create, escalation
 * comment) all run AFTER the token/slug gate. Ref deletions go through
 * `git push origin --delete` (refs move via git only, D-049); a failed delete
 * is journaled and non-fatal (the ref is re-examined at the next start).
 */
async function deriveOriginMergeStatus(
  cli: Cli,
  dir: string,
  makeTransport?: (token: string) => GithubTransport,
): Promise<{ ok: boolean; issues: Issue[]; blocked: string[] }> {
  const prefix = 'refs/remotes/origin/';
  const res = await git(cli.repo, ['for-each-ref', '--format=%(refname) %(objectname)', `${prefix}fix/sweep`], {
    allowCodes: [1],
  });
  const refs = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split(' ');
      return { ref: name.slice(prefix.length), sha };
    });
  if (refs.length === 0) return { ok: true, issues: [], blocked: [] };

  // slug(branch) → branch over the registry-derived scope, longest slug first
  // (slug() is lossy, so the ref name is matched against KNOWN branches, never
  // un-slugged).
  const registry = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile, routingFile: cli.routingFile });
  const scopeResult = await resolveScope(cli.repo, registry.features, registry.scope, { includeRemote: true });
  const candidates = scopeResult.ordered
    .map((e) => ({ branch: e.branch, slug: slug(e.branch) }))
    .sort((a, b) => b.slug.length - a.slug.length);

  // Split by disposition first so the transport is only required when an
  // unmerged ref actually needs a PR lookup.
  const merged: Array<{ ref: string; sha: string; branch: string }> = [];
  const unmerged: Array<{ ref: string; sha: string; branch: string }> = [];
  for (const r of refs) {
    const rest = r.ref.slice('fix/sweep/'.length);
    const target = candidates.find((c) => rest.startsWith(`${c.slug}--`))?.branch ?? null;
    if (!target) {
      appendJournal(dir, { action: 'origin-ref-unknown', ref: r.ref, headSha: r.sha });
      console.error(`sweep start: origin ref '${r.ref}' matches no scope branch — left alone (not blocking)`);
      continue;
    }
    const originTarget = `origin/${target}`;
    if ((await refExists(cli.repo, originTarget)) && (await isAncestor(cli.repo, r.sha, originTarget))) {
      merged.push({ ...r, branch: target });
    } else {
      unmerged.push({ ...r, branch: target });
    }
  }

  const deleteOriginRef = async (ref: string): Promise<string | null> => {
    try {
      await git(cli.repo, ['push', 'origin', '--delete', ref]);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const blocked: string[] = [];
  // TOKEN/TRANSPORT GATE FIRST (finding #6, fail-closed): when unmerged refs
  // need PR lookups, a missing token/slug must abort start BEFORE any origin
  // mutation — the merged-ref cleanup below runs only once the gate passes
  // (or is not needed: merged-only starts stay token-free).
  let transport: GithubTransport | null = null;
  let slugParts: { owner: string; repo: string } | null = null;
  if (unmerged.length > 0) {
    // Networked part (D-058 §4): start takes --token-file like publish/push.
    let token: string | null = null;
    if (cli.tokenFile && existsSync(cli.tokenFile)) token = readFileSync(cli.tokenFile, 'utf8').trim() || null;
    if (!token) {
      return {
        ok: false,
        issues: [
          {
            id: 'ERR11_TOKEN_MISSING',
            detail: `origin carries ${unmerged.length} unmerged fix/sweep ref(s) — start must check their PRs: pass --token-file <path> (substitute GitHub token)`,
          },
        ],
        blocked,
      };
    }
    slugParts = await originSlug(cli);
    if (!slugParts) {
      return {
        ok: false,
        issues: [{ id: 'ERR12_ORIGIN_UNRESOLVED', detail: 'cannot derive owner/repo from the origin remote URL' }],
        blocked,
      };
    }
    transport = (makeTransport ?? realGithubTransport)(token);
  }

  for (const m of merged) {
    const deleteFailed = await deleteOriginRef(m.ref);
    appendJournal(dir, {
      action: 'origin-ref-resolved',
      ref: m.ref,
      branch: m.branch,
      headSha: m.sha,
      ...(deleteFailed ? { deleteFailed } : {}),
    });
    console.error(`sweep start: '${m.ref}' merged into origin/${m.branch} — resolved${deleteFailed ? ' (cleanup delete failed)' : ', ref deleted'}`);
  }

  if (unmerged.length > 0) {
    // Parent-name candidates for the reissue ref-name parse: scope branches +
    // the literal entry parent 'main' (entry-model cases record parent 'main').
    const parentCandidates = [...candidates];
    if (!parentCandidates.some((c) => c.branch === 'main')) {
      parentCandidates.push({ branch: 'main', slug: slug('main') });
    }
    parentCandidates.sort((a, b) => b.slug.length - a.slug.length);
    const ancestorsOf = transitiveAncestors(scopeResult.edges);
    const scopeSet = new Set(scopeResult.ordered.map((e) => e.branch));
    const preReffed = preReffedSet(readJournal(dir));

    /**
     * APPROVED landing (D-059 FINAL): the ref head still merges CLEANLY into
     * the current target → merge it into the LOCAL branch now (pre-ref
     * recorded — abort can roll back), journal `origin-approved` + `resolved`
     * (tier 'approved'), leave the branch UNBLOCKED. Finish verifies the merge
     * (the `resolved` row re-arms the §9 gate) and its target push lands it —
     * GitHub auto-flips the review PR to merged/closed (D-040). Returns false
     * when it cannot land (target advanced / diverged local) — the caller
     * falls through to the reissue arm.
     */
    const landApproved = async (
      u: { ref: string; sha: string; branch: string },
      open: PrByHead,
      latest: PrReview,
    ): Promise<boolean> => {
      if (!(await refExists(cli.repo, `origin/${u.branch}`))) return false;
      const originTip = await revParse(cli.repo, `origin/${u.branch}`);
      const originProbe = await newStyleMergeTree(cli.repo, originTip, u.sha);
      if (!originProbe.clean) return false; // target advanced — no longer merges cleanly
      try {
        await syncBranchWithOrigin(cli, dir, u.branch, scopeSet, preReffed);
      } catch (e) {
        if (e instanceof DriverHalt) {
          appendJournal(dir, { action: 'halt', branch: u.branch, reason: e.reason, message: e.message });
          console.error(`sweep start: cannot land APPROVED '${u.ref}' — ${e.message}`);
          return false;
        }
        throw e;
      }
      const localTip = await revParse(cli.repo, u.branch);
      if (await isAncestor(cli.repo, u.sha, localTip)) {
        // Already contained: a prior pass landed the approved head locally but
        // its push failed/crashed before origin saw it (which is why the ref
        // still classifies unmerged). Re-merging would create a DUPLICATE
        // empty merge — journal the landing rows instead, so verify re-gates
        // it and the target push finally lands the existing merge.
        await recordPreRef(cli, dir, preReffed, u.branch);
        appendJournal(dir, {
          action: 'origin-approved',
          branch: u.branch,
          ref: u.ref,
          headSha: u.sha,
          prNumber: open.number,
          prUrl: open.url,
          reviewId: latest.id,
          alreadyContained: true,
        });
        appendJournal(dir, {
          action: 'resolved',
          branch: u.branch,
          caseId: `origin:${u.ref}`,
          tier: 'approved',
          mergeCommit: localTip,
          prNumber: open.number,
          reviewId: latest.id,
          alreadyContained: true,
        });
        console.error(
          `sweep start: ${u.branch} — review PR #${open.number} APPROVED (review ${latest.id}) and its head is ALREADY CONTAINED in the local tip (a prior landing whose push never arrived): no duplicate merge; pushed + auto-flipped at finish; not blocked`,
        );
        return true;
      }
      const probe = localTip === originTip ? originProbe : await newStyleMergeTree(cli.repo, localTip, u.sha);
      if (!probe.clean) return false;
      await recordPreRef(cli, dir, preReffed, u.branch);
      const mergeCommit = await journaledResolvedMerge(
        cli.repo,
        u.branch,
        u.sha,
        probe.treeOid,
        `Merge ${u.ref} into ${u.branch} (review PR #${open.number} APPROVED — landed by the sweep, verify-gated at finish)`,
        scopeSet,
      );
      appendJournal(dir, {
        action: 'origin-approved',
        branch: u.branch,
        ref: u.ref,
        headSha: u.sha,
        prNumber: open.number,
        prUrl: open.url,
        reviewId: latest.id,
      });
      appendJournal(dir, {
        action: 'resolved',
        branch: u.branch,
        caseId: `origin:${u.ref}`,
        tier: 'approved',
        mergeCommit,
        prNumber: open.number,
        reviewId: latest.id,
      });
      console.error(
        `sweep start: ${u.branch} — review PR #${open.number} APPROVED (review ${latest.id}) and still merges cleanly: LANDED locally as ${mergeCommit.slice(0, 12)} (pushed + auto-flipped at finish); not blocked`,
      );
      return true;
    };

    for (const u of unmerged) {
      // journal the PR_ID row (shared by the blocked arms; every unmerged ref
      // with a live/reissued/recovered PR blocks its branch).
      const journalBlocked = (pr: { number: number; url: string }, markerId: number | null): void => {
        appendJournal(dir, {
          action: 'origin-blocked',
          branch: u.branch,
          caseId: `origin:${u.ref}`,
          fixBranch: u.ref,
          headSha: u.sha,
          prNumber: pr.number,
          prUrl: pr.url,
          markerId,
        });
        blocked.push(u.branch);
      };
      try {
        // FAIL-CLOSED lookup across ALL states (D-059): only an authoritative
        // 200 may classify — an API failure must never read as "no PR".
        const prs = await getPrsByHead(transport!, slugParts!, u.ref);
        const open = prs.find((p) => p.state === 'open');
        if (open) {
          // Cases 2/3: REVIEWS are the only trigger (D-059 FINAL). Issue
          // comments are fetched for the marker watermark (+ dialog); loose
          // comments/inline comments never trigger. All lists paginated.
          const comments = await listIssueComments(transport!, slugParts!, open.number);
          const reviews = await listReviews(transport!, slugParts!, open.number);
          // Finding 4: the marker is bounded TO REALITY — a pasted
          // sweep-addressed id above the max real review id is ignored, so a
          // human comment can never silence the review loop.
          const { markerId } = classifyComments(comments, maxRealReviewId(reviews));
          const trigger = classifyReviewTrigger(reviews, markerId);
          if (!trigger.reissueDue) {
            // DISMISSED reviews never reissue (nothing actionable —
            // classifyReviewTrigger excludes them), but a dismissal BEYOND the
            // marker ADVANCES it (posted once), so the state reads as current.
            const dismissedBeyond = reviews
              .filter(
                (r) =>
                  r.state === 'DISMISSED' && !r.author.endsWith('[bot]') && (markerId === null || r.id > markerId),
              )
              .reduce((m, r) => Math.max(m, r.id), 0);
            if (dismissedBeyond > 0) {
              await postSweepAddressed(transport!, slugParts!, open.number, dismissedBeyond);
              appendJournal(dir, {
                action: 'review-dismissed',
                branch: u.branch,
                ref: u.ref,
                prNumber: open.number,
                reviewId: dismissedBeyond,
              });
              journalBlocked(open, dismissedBeyond);
              console.error(
                `sweep start: ${u.branch} blocked — open PR #${open.number} on '${u.ref}'; review ${dismissedBeyond} was DISMISSED (nothing actionable) — marker advanced, NO reissue`,
              );
            } else {
              journalBlocked(open, markerId);
              console.error(
                `sweep start: ${u.branch} blocked — open PR #${open.number} on '${u.ref}' (origin-derived; no review beyond the marker)`,
              );
            }
          } else if (trigger.latest!.state === 'APPROVED' && (await landApproved(u, open, trigger.latest!))) {
            // landed — logged inside; the branch is NOT blocked.
          } else {
            // APPROVED-but-stale, CHANGES_REQUESTED, COMMENTED, other →
            // REISSUE (report-case forces the revision to HELD downstream).
            journalBlocked(open, markerId);
            console.error(
              `sweep start: ${u.branch} blocked — open PR #${open.number} on '${u.ref}' has a NEW review (${trigger.latest!.state}) — REISSUE`,
            );
            const inlineComments = await listReviewComments(transport!, slugParts!, open.number);
            const dialog = buildReviewDialog({ pr: open, issueComments: comments, inlineComments, reviews });
            await materializeReissueCase(cli, dir, transport!, slugParts!, {
              ref: u.ref,
              refSha: u.sha,
              branch: u.branch,
              pr: open,
              dialog,
              latestReview: trigger.latest!,
              markerId,
              parentCandidates,
              ancestors: ancestorsOf[u.branch] ?? [],
              features: registry.features,
            });
          }
        } else if (prs.some((p) => p.mergedAt !== null)) {
          // Case 4a: the PR was MERGED (squash/rebase — the head is not an
          // ancestor of the target, which is why the ref classified unmerged).
          // The owner's decision LANDED: resolved + ref cleanup. NEVER attempt
          // a reopen on a merged PR (GitHub 422 — the retired ERR13 halt).
          const mergedPr = prs.find((p) => p.mergedAt !== null)!;
          const deleteFailed = await deleteOriginRef(u.ref);
          appendJournal(dir, {
            action: 'origin-ref-resolved',
            ref: u.ref,
            branch: u.branch,
            headSha: u.sha,
            prNumber: mergedPr.number,
            via: 'pr-merged',
            ...(deleteFailed ? { deleteFailed } : {}),
          });
          console.error(
            `sweep start: PR #${mergedPr.number} on '${u.ref}' was MERGED (squash/rebase — head not an ancestor) — resolved${deleteFailed ? ' (cleanup delete failed)' : ', ref deleted'}; never reopened`,
          );
        } else if (prs.length > 0) {
          // Case 4b: genuinely CLOSED and unmerged → REOPEN. The resolution +
          // review thread stay owner-visible.
          const closed = prs[0];
          await reopenPullRequest(transport!, slugParts!, closed.number);
          appendJournal(dir, {
            action: 'origin-pr-reopened',
            ref: u.ref,
            branch: u.branch,
            headSha: u.sha,
            prNumber: closed.number,
            prUrl: closed.url,
          });
          journalBlocked(closed, null);
          console.error(`sweep start: ${u.branch} blocked — closed PR #${closed.number} on '${u.ref}' REOPENED (D-059)`);
        } else {
          // Case 5: NO PR at all (crashed publish) → complete the publish from
          // the authoritative ref; never delete, never re-derive.
          const created = await createRecoveryPr(cli, transport!, slugParts!, u);
          appendJournal(dir, {
            action: 'origin-pr-created',
            ref: u.ref,
            branch: u.branch,
            headSha: u.sha,
            prNumber: created.number,
            prUrl: created.url,
            draft: created.draft,
          });
          journalBlocked(created, 0);
          console.error(
            `sweep start: '${u.ref}' had NO PR — ${created.draft ? 'draft ' : ''}PR #${created.number} created from the ref (recovered publish); ${u.branch} blocked`,
          );
        }
      } catch (e) {
        return {
          ok: false,
          issues: [{ id: 'ERR13_API_FAILED', detail: e instanceof Error ? e.message : String(e) }],
          blocked,
        };
      }
    }
  }
  return { ok: true, issues: [], blocked };
}

/**
 * `sweep start` — open a pass and pin its watermark. Refuses if a pass is
 * already open (a machine state that is not `complete`): the agent must
 * `finish` or `abort` first — never blind-wipe an in-flight pass (that stranded
 * resolved-but-unpushed merges before, §2). Pins the watermark = upstream top
 * commit (via cmdPlan), initializes the journal, and writes the machine state.
 *
 * D-058: start is NETWORKED — it fetches origin (+ upstream) and reconstructs
 * the blocked set from the origin fix/sweep refs (`deriveOriginMergeStatus`)
 * BEFORE planning; the ledger's merge_status is no longer read, so the local
 * pass dir is disposable and `start` is idempotent on origin. A pass that
 * crashed before `finish` published NOTHING, so the re-derived picture is
 * clean and the pass is simply redone.
 *
 * D-055 clean-slate boundary: the pass directory lives at ONE canonical location
 * — `<--workspace>/propagation/pass-<watermark12>` — logged on every `start` and
 * `status` so no operator guesses it. `start` REMOVES the WHOLE prior pass tree
 * (worktrees + case dirs + `coldread-*.json`/`.md` + `pr/`) of any COMPLETE or
 * STALE prior pass at that location before opening (a still-OPEN pass still
 * refuses). This closes the 2026-07-22 contamination: a new run at the same
 * watermark inherited a prior pass's journal (a D-053 HELD leaked into a D-054
 * run) AND a poisoned `coldread-verdict.json` (an infra failure recorded as a
 * reject) because `plan` re-attached to the leftover files. The driver OWNS the
 * pass-dir lifecycle — never rely on an external hand-rm (host `rm` fails on
 * container-uid-owned files, so teardown MUST run IN-CONTAINER, which `start`
 * does). C-1: it also refuses a `--workspace` that IS the `--repo` clone or a
 * subdirectory of it, so the pass never lands inside the clone (splitting it
 * from the durable group-root ledger + rr-cache, which killed rerere and
 * diverged the ledger). A group root inside an OUTER git repo is accepted.
 */
export async function cmdSweepStart(cli: Cli, makeTransport?: (token: string) => GithubTransport): Promise<number> {
  // C-1 (D-055): the workspace is the GROUP ROOT and MUST NOT be the FORK CLONE
  // (`--repo`) or a subdirectory of it — the run set --workspace to the clone, so
  // the pass + a throwaway empty `sweep-ledger.json` + a missing rr-cache all
  // landed inside the clone, splitting per-pass state from the durable group
  // ledger/rr-cache and killing rerere. The check is scoped to the CLONE ONLY:
  // the group root legitimately sits inside an OUTER git work tree (the real
  // server — `~/nanoclaw2` is a git repo, group root `~/nanoclaw2/groups/<g>`),
  // so a plain "inside any work tree" test would wrongly refuse the correct
  // default. Compare against `--repo`'s toplevel (real, absolute) instead.
  const repoTopRaw = (await git(cli.repo, ['rev-parse', '--show-toplevel'], { allowCodes: [1, 128] })).stdout.trim();
  if (repoTopRaw) {
    const realOf = (p: string): string => (existsSync(p) ? realpathSync(p) : pathResolve(p));
    const repoTop = realOf(repoTopRaw);
    const ws = realOf(cli.workspace);
    if (ws === repoTop || ws.startsWith(repoTop + sep)) {
      const detail =
        `--workspace ${cli.workspace} is the --repo clone (${repoTop}) or a subdirectory of it — the pass would ` +
        `land inside the clone, splitting it from the durable group-root ledger + rr-cache. Point --workspace at ` +
        `the GROUP ROOT (parent of the clone).`;
      console.error(`sweep start [ERR37_WORKSPACE_IN_CLONE]: ${detail}`);
      result(cli, { ok: false, issues: [{ id: 'ERR37_WORKSPACE_IN_CLONE', detail }] });
      return 1;
    }
  }

  // D-058: FETCH FIRST — the pass derives everything from origin, so the
  // remote-tracking view (and the upstream watermark) must be current before
  // anything is pinned. Only remotes that exist are fetched (fixtures often
  // have none — their refs/remotes/origin/* are read as-is). The fix/sweep
  // namespace is fetched with --prune under its OWN refspec so a ref another
  // clone deleted cannot linger locally and re-derive as blocked.
  {
    const remotes = (await git(cli.repo, ['remote'])).stdout.split('\n').filter(Boolean);
    for (const remote of ['origin', 'upstream'].filter((r) => remotes.includes(r))) {
      try {
        await git(cli.repo, ['fetch', remote]);
        if (remote === 'origin') {
          await git(cli.repo, ['fetch', '--prune', 'origin', '+refs/heads/fix/sweep/*:refs/remotes/origin/fix/sweep/*']);
        }
      } catch (e) {
        const detail =
          `git fetch ${remote} failed: ${e instanceof Error ? e.message : String(e)} — ` +
          `start derives the blocked set from origin (D-058) and must not open a pass on a stale view`;
        console.error(`sweep start [ERR39_FETCH_FAILED]: ${detail}`);
        result(cli, { ok: false, issues: [{ id: 'ERR39_FETCH_FAILED', detail }] });
        return 1;
      }
    }
  }

  // D-055: resolve the ONE canonical pass location for this watermark up front.
  // `--workspace` is the single artifacts root (default: the group root = parent
  // of --repo); passDir() is the sole path builder, so where the driver WRITES
  // and what the doctrine names are identical — there is exactly one location.
  const watermark12 = (await revParse(cli.repo, cli.upstream)).slice(0, 12);
  const canonicalDir = passDir(cli.workspace, watermark12);

  // Refuse a still-OPEN pass (D-053): a machine state whose phase is not
  // `complete` is in flight — require `finish`/`abort` first, never blind-wipe.
  // Check BOTH the canonical dir for THIS watermark AND the latest pass
  // attachPass would attach to (an in-flight pass at a DIFFERENT watermark
  // counts too — and guarding the canonical dir directly means a genuinely-open
  // same-watermark pass is never mistaken for a stale one and cleared below).
  const openCandidates = new Set<string>();
  if (existsSync(canonicalDir)) openCandidates.add(canonicalDir);
  try {
    openCandidates.add((await attachPass({ ...cli, cmd: 'status' })).dir);
  } catch {
    /* no attachable open pass — fine */
  }
  for (const d of openCandidates) {
    const st = readMachineState(d);
    if (st && st.phase !== 'complete') {
      const detail = `a pass is already open (${d}, phase ${st.phase}) — run \`finish\` or \`abort\` first`;
      console.error(`sweep start [ERR30_PASS_OPEN]: ${detail}`);
      result(cli, { ok: false, issues: [{ id: 'ERR30_PASS_OPEN', detail }] });
      return 1;
    }
  }

  // Clean-slate boundary (D-055): the refusal above cleared any in-flight pass,
  // so anything still at the canonical location is a COMPLETE or STALE prior
  // pass (or a pre-machine-state leftover with no machine-state.json). Remove the
  // WHOLE tree — journal + machine-state + every case dir with its
  // `coldread-*.json`/`.md` + `pr/` — so NOTHING is inherited: not the leaked
  // HELD journal, and not a poisoned `coldread-verdict.json` (an infra failure
  // recorded as a reject, the D-055 poison `cmdResolve` would read as authentic).
  // `start` is the ONLY place this happens; the driver owns the lifecycle.
  if (existsSync(canonicalDir)) {
    // De-register the prior pass's worktrees FIRST so removing the tree does not
    // strand git worktree admin entries; the tree rm then takes the files.
    for (const c of journaledCases(readJournal(canonicalDir)).keys()) {
      await removeCaseWorktree(cli, canonicalDir, c);
    }
    try {
      rmSync(canonicalDir, { recursive: true, force: true });
    } catch (e) {
      // Pass files are container-uid-owned — a host-side rm fails. The driver
      // runs IN-CONTAINER, so this normally succeeds; surface a clear halt if not.
      const detail =
        `could not clear prior pass dir ${canonicalDir}: ${e instanceof Error ? e.message : String(e)} — ` +
        `pass files are container-uid-owned; teardown MUST run IN-CONTAINER. Clear it and re-run \`start\`.`;
      console.error(`sweep start [ERR38_PASS_CLEAR_FAILED]: ${detail}`);
      result(cli, { ok: false, issues: [{ id: 'ERR38_PASS_CLEAR_FAILED', detail }] });
      return 1;
    }
    // Stale git worktree admin entries (repo/.git/worktrees/*) now point at a
    // removed tree — prune them so a fresh case can re-register its worktree.
    await git(cli.repo, ['worktree', 'prune'], { allowCodes: [1, 128] });
    console.error(`sweep start: cleared prior pass dir ${canonicalDir} (whole tree; clean-slate, D-055)`);
  }

  // D-058 §2: reconstruct the blocked set from ORIGIN into the fresh journal
  // BEFORE planning (plan/run read `origin-blocked` rows; the ledger's
  // merge_status is dead). Blocking issues (token missing, API failure) leave
  // no plan-initial.json, so a re-run start clears + re-derives cleanly.
  progress('deriving merge status from origin');
  const originDerive = await deriveOriginMergeStatus(cli, canonicalDir, makeTransport);
  if (!originDerive.ok) {
    console.error(`sweep start [${originDerive.issues[0]?.id}]: ${originDerive.issues[0]?.detail}`);
    result(cli, { ok: false, issues: originDerive.issues });
    return 1;
  }
  if (originDerive.blocked.length) {
    progress(`origin-derived blocked: ${originDerive.blocked.join(', ')}`);
  }

  // Pin the watermark + open the pass (only `plan` opens a pass, §2).
  const planRc = await cmdPlan({ ...cli, cmd: 'plan', internal: true });
  if (planRc !== 0) return planRc;
  const ctx = await openPass(cli);
  const st: MachineState = {
    schemaVersion: 1,
    phase: 'open',
    watermark: ctx.watermark,
    watermark12: ctx.watermark12,
    currentCase: null,
  };
  writeMachineState(ctx.dir, st);
  appendJournal(ctx.dir, { action: 'sweep-start', watermark: ctx.watermark });
  console.error(
    `sweep started — pass ${ctx.watermark12} pinned at ${ctx.watermark.slice(0, 12)} — pass dir: ${ctx.dir}`,
  );
  result(cli, { status: 'started', watermark: ctx.watermark, watermark12: ctx.watermark12, passDir: ctx.dir });
  return 0;
}

/**
 * `sweep abort` — discard an open pass cleanly. Rolls every branch mutated this
 * pass back to its journaled `pre-ref` (reverse order, guardRef-checked; local
 * refs only — nothing was pushed), removes case worktrees, and marks the machine
 * state `complete` so a fresh `start` is allowed. This is the ONLY sanctioned
 * way to drop an in-flight pass (§2) — never a blind wipe.
 */
export async function cmdSweepAbort(cli: Cli): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  const journal = readJournal(dir);
  const scope = passScope(dir);
  // Roll back mutated branches to their pre-pass tip, newest pre-ref first.
  const preRefs = journal.filter((e) => e.action === 'pre-ref' && typeof e.branch === 'string');
  const rolledBack: string[] = [];
  for (const e of [...preRefs].reverse()) {
    const branch = e.branch as string;
    if (rolledBack.includes(branch)) continue;
    const to = lastPreRef(journal, branch);
    if (!to || !(await refExists(cli.repo, branch))) continue;
    const current = await revParse(cli.repo, branch);
    if (current === to) continue;
    try {
      guardRef(branch, scope);
      const wt = await checkedOutWorktree(cli.repo, branch);
      await resetBranchRef(cli.repo, branch, to, current);
      if (wt) await git(cli.repo, ['reset', '--hard', to], { cwd: wt });
      appendJournal(dir, { action: 'abort-rollback', branch, to });
      rolledBack.push(branch);
    } catch (err) {
      if (err instanceof DriverHalt) {
        appendJournal(dir, { action: 'halt', branch, reason: err.reason, message: err.message });
        console.error(`sweep abort HALT: ${err.reason} — ${err.message}`);
        return 1;
      }
      throw err;
    }
  }
  for (const c of journaledCases(journal).keys()) await removeCaseWorktree(cli, dir, c);
  appendJournal(dir, { action: 'pass-aborted', rolledBack });
  // C-4 (D-055): seal the pass with `pass-complete` too — `attachPass` defines
  // "open" as (has plan-initial.json AND no pass-complete), so WITHOUT this row an
  // aborted pass stays the latest "open" pass and next-case/report-*/finish
  // re-attach to it (the machine-state `complete` alone is invisible to
  // attachPass). Mirrors cmdSweepFinish. Guarded so a re-abort stays idempotent.
  if (!readJournal(dir).some((e) => e.action === 'pass-complete')) {
    appendJournal(dir, { action: 'pass-complete', watermark: ctx.watermark });
  }
  const st = readMachineState(dir);
  writeMachineState(dir, {
    schemaVersion: 1,
    phase: 'complete',
    watermark: ctx.watermark,
    watermark12: ctx.watermark12,
    currentCase: null,
    ...(st?.finishStep ? { finishStep: st.finishStep } : {}),
  });
  console.error(`sweep aborted — pass ${ctx.watermark12} discarded (${rolledBack.length} branch(es) rolled back)`);
  result(cli, { status: 'aborted', rolledBack });
  return 0;
}

// --------------------------------------------------------------------------
// `sweep next-case` (SWEEP-STATE-MACHINE.md §2).
// --------------------------------------------------------------------------

/**
 * `sweep next-case` — deterministic, NO `claude -p`. Drives the existing
 * plan/run machinery (cmdRun: CLEAN merges + no-op skips + DEFERRED freezes,
 * barrier/reopen handled internally), then serves the topmost undispositioned
 * conflict case (DAG order) with its driver-prepared worktree + materials, or
 * reports `finalize` when none remain. Zero agent params; the driver records
 * `currentCase` in the machine state.
 */
export async function cmdSweepNextCase(cli: Cli): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  let st = readMachineState(dir);
  if (!st) {
    console.error('next-case: no machine state — run `sweep start` first');
    return 2;
  }
  if (st.phase === 'awaiting-pr') {
    const detail = `case ${st.currentCase?.caseId} is awaiting its PR description — run \`report-pr\` first`;
    console.error(`next-case [ERR31_AWAITING_PR]: ${detail}`);
    result(cli, {
      status: 'awaiting-pr',
      instruction: 'report-pr for the current case first',
      currentCase: st.currentCase,
    });
    return 1;
  }
  if (st.phase === 'complete') {
    console.error('next-case: pass is complete — run `sweep start` for a new pass');
    result(cli, { status: 'complete' });
    return 1;
  }

  // Advance the deterministic machinery (idempotent; continues reopened branches
  // above resolved heights and lands new clean prefixes/skips/defers). D-054: the
  // MAJOR transitions cmdRun runs internally, announced as progress; the batched
  // merge/skip/defer summary comes from the journal delta below.
  progress('scanning upstream');
  let planBranches = 0;
  try {
    planBranches = (JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { branches?: unknown[] }).branches
      ?.length ?? 0;
  } catch {
    /* plan.json unreadable — omit the count */
  }
  progress(`planning (${planBranches} branches)`);
  progress('executing merges');
  const journalLenBefore = readJournal(dir).length;
  const runRc = await cmdRun({ ...cli, cmd: 'run', execute: true, internal: true });
  if (runRc !== 0) {
    // A per-branch/whole-run halt (ERR2x) — surface it; the agent reports it.
    // cmdRun's own emit is suppressed (internal), so next-case emits the single
    // result itself: the halt is journaled — point the agent at it (D-054).
    console.error('next-case: `run` halted — see the journal');
    result(cli, { status: 'run-halted', instruction: 'run halted — inspect the journal for the ERR2x halt', passDir: dir });
    return runRc;
  }

  const journal = readJournal(dir);
  const delta = journal.slice(journalLenBefore);
  const mergedN = delta.filter((e) => e.action === 'merge').length;
  const skippedN = delta.filter((e) => e.action === 'skip').length;
  const deferredN = delta.filter((e) => e.action === 'defer').length;
  progress(`merged ${mergedN} clean / skipped ${skippedN} / deferred ${deferredN}`);
  const open = openCases(journal);
  if (open.length === 0) {
    st = { ...st, phase: 'open', currentCase: null };
    writeMachineState(dir, st);
    progress('no more cases');
    console.error('next-case: no more cases — finalize (run `finish`)');
    result(cli, { status: 'finalize' });
    return 0;
  }

  const jc = open[0];
  const caseFile = readCaseFile(join(dir, jc.caseId, 'case.json'));
  const worktree = caseWorktreePath(dir, jc.caseId);
  // D-059: a REISSUE case (driver-journaled at start) is served as a REVISION —
  // the worktree carries the prior published resolution and the materials carry
  // the FULL time-ordered review dialog, never the fresh-conflict briefing.
  const caseRow = journal.find((e) => e.action === 'case' && e.caseId === jc.caseId) ?? null;
  const isReissue = caseRow?.reissue === true;
  progress(
    `case ready: ${jc.branch} — ${caseFile.conflictedPaths.join(', ')}${isReissue ? ' (REISSUE — revise the published resolution)' : ''}`,
  );
  const materials = isReissue ? reissueCaseMaterials(dir, jc, caseRow!) : await machineCaseMaterials(cli, jc);
  writeFileSync(join(dir, jc.caseId, 'materials.md'), materials + '\n');
  st = { ...st, phase: 'case-ready', currentCase: { caseId: jc.caseId, branch: jc.branch } };
  writeMachineState(dir, st);
  console.error(`next-case: case ${jc.caseId} ready in ${worktree}${isReissue ? ' (reissue)' : ''}`);
  result(cli, {
    status: 'case-ready',
    worktree,
    branch: jc.branch,
    caseId: jc.caseId,
    conflictedPaths: caseFile.conflictedPaths,
    run: caseFile.run ?? [caseFile.head],
    ...(isReissue ? { reissue: true, prNumber: caseRow!.prNumber ?? null } : {}),
    materials,
    materialsPath: join(dir, jc.caseId, 'materials.md'),
  });
  return 0;
}

// --------------------------------------------------------------------------
// `report-case --tier mechanical|judged|held` (SWEEP-STATE-MACHINE.md §2).
// --------------------------------------------------------------------------

/**
 * `report-case --tier <t>` — the ONLY agent param is `--tier` (a claim; the
 * driver is demote-only). Deterministic checks first (worktree snapshot →
 * empty/unresolved → branch-scoped tests → ERR05/adequacy + duplicate →
 * per-case attempt cap force-HELD, D-052; a scope violation is CARRIED to the
 * cold read as `scopeExceeded`, D-057 #3), then the cold read PLACEMENT:
 *  - mechanical: cold read HERE (`claude -p`) over the resolution diff →
 *    confirm → merge in place → `merged, take next case`; confirm + scope
 *    exceeded → HELD publishing the resolution (active PR, escalated); reject
 *    → first strike returns the reviewer's feedback (revise-and-retry), the
 *    second strike escalates to HELD (D-057 #4).
 *  - judged/held: NO cold read here (deferred to report-pr) → on deterministic
 *    pass → `provide PR description` (materials prepared; held is frozen now).
 */
export async function cmdSweepReportCase(
  cli: Cli,
  invoke: ColdReadInvoker = defaultColdReadInvoker,
  runBranchTests: BranchTestRunner = defaultBranchTestRunner,
): Promise<number> {
  const claimed = cli.tier;
  if (claimed !== 'mechanical' && claimed !== 'judged' && claimed !== 'held') {
    console.error('report-case: --tier must be mechanical, judged or held');
    return 2;
  }
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  const st = readMachineState(dir);
  if (!st || st.phase !== 'case-ready' || !st.currentCase) {
    console.error('report-case: no case is ready — run `next-case` first');
    return 2;
  }
  const caseId = st.currentCase.caseId;
  const caseDir = join(dir, caseId);
  const caseFile = readCaseFile(join(caseDir, 'case.json'));
  const journal = readJournal(dir);

  // D-059: a REISSUE case (driver-journaled at start with `reissue: true`) is a
  // revision of a published resolution — verified against the journal-anchored
  // conflict head + a direct live probe, and ALWAYS routed through HELD (the
  // revision republishes to the EXISTING PR at finish; it never merges here).
  const caseRow = journal.find((e) => e.action === 'case' && e.caseId === caseId) ?? null;
  const isReissue = caseRow?.reissue === true;

  // §7 trust boundary: re-derive the case from git + registry (case.json is only
  // a pointer). Reuses the flag-path's reverifyCase verbatim.
  const rv = isReissue
    ? await reverifyReissueCase(cli, ctx, caseFile, journal, caseRow!)
    : await reverifyCase(cli, ctx, dir, caseFile, journal);
  if (!rv.ok) {
    console.error(`report-case HALT: case re-verification failed:\n  ${rv.errors.join('\n  ')}`);
    result(cli, {
      instruction: `case-stale: ${rv.errors[0]}`,
      tier: claimed,
      issues: rv.errors.map((detail) => ({ id: 'ERR02_CASE_STALE', detail })),
    });
    return 1;
  }
  const rc = rv.rc!;
  const reopenTargets = [rc.branch, ...rc.descendants];

  const wtPath = caseWorktreePath(dir, caseId);
  if (!existsSync(wtPath)) {
    result(cli, {
      instruction: 'case worktree missing — re-run next-case',
      tier: claimed,
      issues: [{ id: 'ERR02_CASE_STALE', detail: `no worktree at ${wtPath}` }],
    });
    return 1;
  }
  const resolvedTree = await snapshotWorktreeTree(cli.repo, wtPath);

  // --- deterministic checks (SWEEP-STATE-MACHINE.md §report-case) ------------
  const issues: Issue[] = [];
  const emptyResolution = resolvedTree === rc.automergeTree;
  const markers = await unresolvedMarkers(cli.repo, resolvedTree, rc.conflictedPaths);

  // Scope guard (recomputed automerge/paths + config-derived mode).
  const guard = await scopeGuard(cli.repo, rc.automergeTree, resolvedTree, rc.conflictedPaths, rc.scopeGuardMode);

  // Adequacy: recorded-decision (ERR05) + duplicate (ERR06) — mechanical.
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  // (Skipped for a REISSUE: its PR already exists — adequacy was settled at the
  // original publish; ERR05/ERR06 would wrongly re-litigate the open review.)
  if (!isReissue) {
    const decided = decidedAlready(registry.features, rc.branch, rc.conflictedPaths);
    if (decided) issues.push(decided);
    const dup = await duplicateCaseIssue(cli, journal, journaledCases(journal), journaledCases(journal).get(caseId)!);
    if (dup) issues.push(dup);
  }

  // Per-case attempt cap (D-052 force-HELD): count DISTINCT resolved trees this
  // case has been reported with; beyond the cap the driver force-freezes rather
  // than looping. Journaled per attempt.
  const priorTrees = new Set(
    journal
      .filter((e) => e.action === 'report-attempt' && e.caseId === caseId && typeof e.resolvedTree === 'string')
      .map((e) => e.resolvedTree as string),
  );
  const distinctTrees = new Set([...priorTrees, resolvedTree]);
  const capExceeded = distinctTrees.size > RESOLVE_COLDREAD_CAP;
  if (cli.execute && !priorTrees.has(resolvedTree)) {
    appendJournal(dir, { action: 'report-attempt', caseId, branch: rc.branch, tier: claimed, resolvedTree });
  }

  // Effective tier after demotions (authoritative): cap → HELD; conflicts
  // still present on a mech/judged claim → resolve-first (ERR32, below).
  // A scope violation is NOT an instant hold any more (D-057 #3): it is
  // carried as `scopeExceeded` past the cold read — cold read agrees + scope
  // exceeded → HELD publishing the resolution (active PR, escalated); a
  // reject follows the 2-strike rejection path.
  const conflictsPresent = emptyResolution || markers.length > 0;
  const scopeExceeded = !guard.ok;
  const scopeFeedback = scopeExceeded
    ? `resolution touches beyond the conflicted files: ${[...guard.extraPaths, ...guard.hunkViolations.map((p) => `${p} (out-of-hunk)`)].join(', ')}`.slice(
        0,
        COLDREAD_FEEDBACK_CAP,
      )
    : null;
  let effectiveTier: Tier = applyFloor(
    claimed === 'held' ? 'judged' : claimed,
    rc.tierFloor === 'judged' ? 'judged' : 'clean',
  );
  if (claimed === 'held') effectiveTier = 'held';
  const demoteReasons: string[] = [];
  if (capExceeded) {
    effectiveTier = 'held';
    demoteReasons.push(`resolution did not converge in ${RESOLVE_COLDREAD_CAP} distinct trees -> held (ERR26)`);
  }
  // D-059: a reissue revision NEVER merges in place — whatever the claim, it is
  // HELD so the revision republishes to the EXISTING review PR at finish (the
  // owner's review continues; merging locally would bypass it).
  if (isReissue) {
    effectiveTier = 'held';
    demoteReasons.push(
      `reissue revision for PR #${caseRow!.prNumber ?? '?'} — republished to the existing review PR at finish (D-059)`,
    );
  }

  // Hard blocks that are NOT a freeze: the agent must fix + re-report. An
  // adequacy hit (ERR05/ERR06) means "do not open this; apply/consolidate".
  if (issues.some((i) => i.id === 'ERR05_DECIDED_ALREADY' || i.id === 'ERR06_DUPLICATE_CASE')) {
    const first = issues.find((i) => i.id === 'ERR05_DECIDED_ALREADY' || i.id === 'ERR06_DUPLICATE_CASE')!;
    result(cli, {
      instruction: `${first.id === 'ERR05_DECIDED_ALREADY' ? 'apply the recorded decision (judged)' : 'consolidate into the topmost case'}: ${first.detail}`,
      tier: effectiveTier,
      issues,
    });
    return 1;
  }

  // Empty/unresolved on a MECHANICAL/JUDGED claim that is NOT being frozen: the
  // agent hasn't resolved yet — ask them to resolve (no freeze, re-report).
  // Applies regardless of the scope guard: a marker-laden tree has no verdict
  // to carry anywhere.
  if (conflictsPresent && claimed !== 'held' && !capExceeded) {
    const detail = emptyResolution
      ? 'worktree unchanged — resolve the conflict in the worktree first'
      : `unresolved conflict markers remain in [${markers.join(', ')}]`;
    result(cli, { instruction: detail, tier: claimed, issues: [{ id: 'ERR32_UNRESOLVED', detail }] });
    return 1;
  }

  if (!cli.execute) {
    result(cli, { dryRun: true, instruction: 'dry-run', tier: effectiveTier, claimed, scopeGuard: guard, issues });
    return 0;
  }

  // --- HELD (claimed or cap-demoted): freeze now, then send to report-pr -----
  if (effectiveTier === 'held') {
    const notes = demoteReasons.length ? demoteReasons : ['agent declared cannot-resolve (--tier held)'];
    // The unified publish decides active-vs-draft from the recorded resolution
    // (marker-clean → active review PR; otherwise → draft pristine conflict);
    // cap holds and scope-exceeded held-claims carry their escalation prefix.
    const escalation: HeldEscalation | null = capExceeded
      ? { tag: ESCALATE_CAP, feedback: scopeFeedback }
      : scopeExceeded && !conflictsPresent
        ? { tag: ESCALATE_SCOPE, feedback: scopeFeedback }
        : null;
    await freezeHeld(cli, dir, rc, notes, { resolvedTree, escalation });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`demoted: ${rc.branch} -> held (${notes.join('; ')})`);
    console.error(`report-case: held ${caseId} (${notes.join('; ')})`);
    result(cli, { instruction: 'provide PR description', tier: 'held', issues });
    return 0;
  }

  // --- branch-scoped tests (cheap; NOT the finish rebuild) -------------------
  const branchTip = await revParse(cli.repo, rc.branch);
  const tests = await runBranchTests({
    repo: cli.repo,
    branch: rc.branch,
    branchTip,
    head: rc.head.sha,
    resolvedTree,
    conflictedPaths: rc.conflictedPaths,
    commands: branchTestCommands(cli),
    caseDir,
  });
  if (!tests.ok) {
    const detail = `tests failed: ${tests.detail ?? ''}${tests.detailPath ? ` (${tests.detailPath})` : ''}`;
    result(cli, {
      instruction: detail,
      tier: effectiveTier,
      issues: [...issues, { id: 'ERR33_BRANCH_TESTS_FAILED', detail }],
    });
    return 1;
  }

  // --- JUDGED: defer the cold read to report-pr; prepare materials -----------
  if (effectiveTier === 'judged') {
    await prepareCaseMaterials(cli, dir, rc, 'judged');
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'judged' } });
    console.error(`report-case: ${caseId} judged — provide PR description`);
    result(cli, { instruction: 'provide PR description', tier: 'judged', issues });
    return 0;
  }

  // --- MECHANICAL: cold read HERE, over the resolution diff ------------------
  const conflictDiff = (
    await git(cli.repo, ['diff', branchTip, rc.automergeTree, '--', ...rc.conflictedPaths], { allowCodes: [1] })
  ).stdout;
  const resolutionDiff = (await git(cli.repo, ['diff', rc.automergeTree, resolvedTree], { allowCodes: [1] })).stdout;
  const prompt = machineColdReadPrompt({
    id: caseId,
    branch: rc.branch,
    parent: rc.parent,
    height: rc.head.height,
    conflictedPaths: rc.conflictedPaths,
    contextLines: await caseContextLines(cli, rc),
    conflictDiff: conflictDiff.slice(0, 60000),
    resolutionDiff: resolutionDiff.slice(0, 60000),
  });
  writeFileSync(join(caseDir, 'coldread-request.md'), prompt);
  progress(`cold-read: ${rc.branch}`);
  const verdict = await invoke(prompt);
  writeFileSync(join(caseDir, 'coldread-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  // D-054: infra failure of the cold read (spawn/exit/unparseable/auth) is NOT a
  // content reject — HARD BLOCKING HALT (ERR35), do NOT freeze the case. The
  // machine state stays `case-ready` so the agent re-runs report-case once the
  // tooling is fixed; only a cold read that RAN and rejected → HELD (below).
  if (verdict.verdict === 'error') {
    const detail = `cold-read tooling unavailable: ${verdict.reason ?? 'unknown'} — report to owner (D-046 case 2) and stop; NOT a content decision`;
    appendJournal(dir, {
      action: 'halt',
      reason: 'coldread-unavailable',
      id: 'ERR35_COLDREAD_UNAVAILABLE',
      caseId,
      branch: rc.branch,
      phase: 'report-case',
      message: detail,
    });
    console.error(`report-case HALT [ERR35_COLDREAD_UNAVAILABLE]: ${detail}`);
    result(cli, { instruction: detail, tier: effectiveTier, issues: [...issues, { id: 'ERR35_COLDREAD_UNAVAILABLE', detail }] });
    return 1;
  }
  const { rejected, unverifiable } = coldReadRejected(verdict);
  const feedback = boundedFeedback(verdict);
  appendJournal(dir, {
    action: 'coldread',
    caseId,
    branch: rc.branch,
    phase: 'report-case',
    verdict: verdict.verdict,
    unverifiable,
    rejected,
    feedback,
  });
  // Rejection (incl. fail-closed UNVERIFIABLE): FIRST → no freeze, surface the
  // reviewer's feedback so the agent revises in the worktree and re-reports;
  // SECOND → stop retrying, HELD via the unified publish with the escalation
  // prefix (D-057 #4). The machine state stays case-ready on the first strike.
  if (rejected) {
    const rejections = coldReadRejectionCount(readJournal(dir), caseId);
    if (rejections >= COLDREAD_REJECT_LIMIT) {
      const note =
        verdict.verdict === 'reject'
          ? `cold-read rejected ${rejections}x -> HELD (escalated): ${verdict.notes}`
          : `cold-read UNVERIFIABLE-FROM-REQUEST on ${unverifiable.join(', ')} (fail-closed), rejected ${rejections}x -> HELD (escalated): ${verdict.notes}`;
      await freezeHeld(cli, dir, rc, [note], {
        resolvedTree,
        escalation: { tag: ESCALATE_REJECTED_2X, feedback },
      });
      reopen(dir, reopenTargets);
      writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
      progress(`demoted: ${rc.branch} -> held (cold-read rejected ${rejections}x)`);
      console.error(`report-case: held ${caseId} (cold-read rejected ${rejections}x, escalated)`);
      result(cli, { instruction: 'provide PR description', tier: 'held', issues });
      return 0;
    }
    const instruction = `cold read rejected — revise the resolution in the worktree, then re-run report-case${feedback ? `: ${feedback}` : ''}`;
    console.error(`report-case: ${instruction}`);
    result(cli, { instruction, tier: claimed, rejected: true, feedback, issues });
    return 1;
  }
  // Confirm + scope exceeded (#3): HELD publishing THE RESOLUTION — the
  // unified publish ships it as an ACTIVE PR (owner reviews & merges),
  // prefixed with the scope escalation naming the extra files.
  if (scopeExceeded) {
    const note = `cold read confirmed but the resolution exceeds the conflict scope [${guard.mode}] -> HELD (resolution published for owner review)`;
    appendJournal(dir, {
      action: 'scope-violation',
      branch: rc.branch,
      caseId,
      mode: guard.mode,
      extraPaths: guard.extraPaths,
      hunkViolations: guard.hunkViolations,
    });
    await freezeHeld(cli, dir, rc, [note], {
      resolvedTree,
      escalation: { tag: ESCALATE_SCOPE, feedback: [feedback, scopeFeedback].filter(Boolean).join(' — ').slice(0, COLDREAD_FEEDBACK_CAP) },
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`demoted: ${rc.branch} -> held (scope exceeded; resolution kept for owner review)`);
    console.error(`report-case: held ${caseId} (scope exceeded — cold read agreed; resolution kept)`);
    result(cli, { instruction: 'provide PR description', tier: 'held', scopeGuard: guard, issues });
    return 0;
  }
  // Confirm → merge the resolved tree in place.
  const preReffed = preReffedSet(journal);
  await recordPreRef(cli, dir, preReffed, rc.branch);
  const msg = `Merge ${rc.parent} into ${rc.branch} (propagation, mechanical resolution of ${caseId})`;
  const mergeCommit = await journaledResolvedMerge(cli.repo, rc.branch, rc.head.sha, resolvedTree, msg, rc.scope);
  appendJournal(dir, {
    action: 'resolved',
    branch: rc.branch,
    caseId,
    tier: 'mechanical',
    mergeCommit,
    coldread: { verdict: verdict.verdict, notes: verdict.notes },
  });
  await removeCaseWorktree(cli, dir, caseId);
  reopen(dir, reopenTargets);
  writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
  progress(`mechanical resolve: ${rc.branch} — merged`);
  console.error(`report-case: merged ${caseId} (mechanical) ${mergeCommit.slice(0, 12)}`);
  result(cli, { instruction: 'merged, take next case', tier: 'mechanical', mergeCommit, issues });
  return 0;
}

// --------------------------------------------------------------------------
// `report-pr` (judged and held only) (SWEEP-STATE-MACHINE.md §2).
// --------------------------------------------------------------------------

/**
 * `report-pr` — reads the agent's PR description from the FIXED path
 * (pr/title.txt + pr/body.md), runs the SINGLE cold read over the resolution
 * diff AND the description together (kept kind-1 read with the description in
 * view). Verdict handling (D-057): a description-only defect → `rewrite:
 * <reason>`; a resolution rejection → first strike returns the reviewer's
 * feedback for a revise-and-retry, the second strike escalates to HELD;
 * confirm + scope-exceeded → HELD with the resolution recorded (active review
 * PR at finish, escalated). Then by tier — PUBLISHING NOTHING either way
 * (D-058: every PR is created at `finish`, after verify is green): held →
 * RECORD PR INTENT (the recorded `held` disposition already carries the
 * resolution/escalation the unified publish needs); judged → merge in place +
 * RECORD PR INTENT. `report-pr` pushes no ref and calls no API.
 */
export async function cmdSweepReportPr(
  cli: Cli,
  invoke: ColdReadInvoker = defaultColdReadInvoker,
): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  const st = readMachineState(dir);
  if (!st || st.phase !== 'awaiting-pr' || !st.currentCase) {
    console.error('report-pr: no case awaiting a PR — run `report-case --tier judged|held` first');
    return 2;
  }
  const { caseId, branch } = st.currentCase;
  const tier = st.currentCase.tier;
  if (tier !== 'judged' && tier !== 'held') {
    console.error('report-pr: current case is not judged/held (mechanical has no PR)');
    return 2;
  }
  const caseDir = join(dir, caseId);
  const journal = readJournal(dir);

  // PR text from the FIXED path.
  const title = existsSync(join(caseDir, 'pr', 'title.txt'))
    ? readFileSync(join(caseDir, 'pr', 'title.txt'), 'utf8').trim()
    : '';
  const body = existsSync(join(caseDir, 'pr', 'body.md'))
    ? readFileSync(join(caseDir, 'pr', 'body.md'), 'utf8').trim()
    : '';
  if (!title || !body) {
    const detail = `write ${join(caseDir, 'pr', 'title.txt')} and ${join(caseDir, 'pr', 'body.md')} yourself from the case materials`;
    result(cli, { instruction: 'provide PR description', issues: [{ id: 'ERR08_TEXT_MISSING', detail }] });
    return 1;
  }

  const caseFile = readCaseFile(join(caseDir, 'case.json'));

  // Build the review content by tier. JUDGED re-verifies + re-snapshots the
  // resolution (fail-closed only when it still CONFLICTS; a scope violation is
  // carried past the cold read — D-057 #3); HELD reviews the recorded
  // resolution when a marker-clean one exists, else the frozen conflict
  // exhibit itself.
  let conflictDiff: string;
  let resolutionDiff: string | null;
  let rc: ResolvedCase | null = null;
  let resolvedTree = '';
  let scopeExceeded = false;
  let scopeFeedback: string | null = null;
  const branchTip0 = (await refExists(cli.repo, branch)) ? await revParse(cli.repo, branch) : '';
  if (tier === 'judged') {
    const rv = await reverifyCase(cli, ctx, dir, caseFile, journal);
    if (!rv.ok) {
      result(cli, {
        instruction: `case-stale: ${rv.errors[0]}`,
        issues: rv.errors.map((detail) => ({ id: 'ERR02_CASE_STALE', detail })),
      });
      return 1;
    }
    rc = rv.rc!;
    const wtPath = caseWorktreePath(dir, caseId);
    resolvedTree = await snapshotWorktreeTree(cli.repo, wtPath);
    const guard = await scopeGuard(cli.repo, rc.automergeTree, resolvedTree, rc.conflictedPaths, rc.scopeGuardMode);
    const markers = await unresolvedMarkers(cli.repo, resolvedTree, rc.conflictedPaths);
    if (markers.length > 0) {
      // Demote to HELD (fail-closed): a judged claim that no longer resolves.
      // The marker-laden resolution is recorded but NOT marker-clean, so the
      // unified publish ships the draft pristine conflict.
      const note = `unresolved conflict markers -> held`;
      await freezeHeld(cli, dir, rc, [note], { resolvedTree });
      reopen(dir, [rc.branch, ...rc.descendants]);
      writeMachineState(dir, { ...st, currentCase: { caseId, branch, tier: 'held' } });
      result(cli, { instruction: `held: ${note} — re-run report-pr to publish the frozen exhibit`, tier: 'held' });
      return 1;
    }
    // Scope violation: carried to the cold read (D-057 #3) — an agreeing read
    // escalates to HELD publishing the resolution; a reject follows the
    // 2-strike rejection path.
    scopeExceeded = !guard.ok;
    scopeFeedback = scopeExceeded
      ? `resolution touches beyond the conflicted files: ${[...guard.extraPaths, ...guard.hunkViolations.map((p) => `${p} (out-of-hunk)`)].join(', ')}`.slice(
          0,
          COLDREAD_FEEDBACK_CAP,
        )
      : null;
    conflictDiff = (
      await git(cli.repo, ['diff', branchTip0, rc.automergeTree, '--', ...rc.conflictedPaths], { allowCodes: [1] })
    ).stdout;
    resolutionDiff = (await git(cli.repo, ['diff', rc.automergeTree, resolvedTree], { allowCodes: [1] })).stdout;
  } else {
    // held: review the RECORDED marker-clean resolution when one exists (the
    // unified publish will ship it as the active review PR); otherwise the
    // frozen conflict exhibit is the review content.
    conflictDiff = (
      await git(cli.repo, ['diff', branchTip0, caseFile.automergeTree, '--', ...caseFile.conflictedPaths], {
        allowCodes: [1],
      })
    ).stdout;
    const heldDisp = lastDisposition(journal, caseId);
    const heldResolution = heldDisp?.resolution as { tree: string; markerClean: boolean } | null | undefined;
    resolutionDiff =
      heldResolution?.markerClean === true
        ? (await git(cli.repo, ['diff', caseFile.automergeTree, heldResolution.tree], { allowCodes: [1] })).stdout
        : null;
  }

  const contextLines = await caseContextLines(cli, {
    branch,
    parent: caseFile.parent,
    head: { sha: caseFile.head.sha },
    conflictedPaths: caseFile.conflictedPaths,
  });
  const prompt = machineColdReadPrompt({
    id: caseId,
    branch,
    parent: caseFile.parent,
    height: caseFile.head.height,
    conflictedPaths: caseFile.conflictedPaths,
    contextLines,
    conflictDiff: conflictDiff.slice(0, 60000),
    resolutionDiff: resolutionDiff ? resolutionDiff.slice(0, 60000) : null,
    description: { title, body },
  });
  writeFileSync(join(caseDir, 'coldread-pr-request.md'), prompt);

  if (!cli.execute) {
    result(cli, { dryRun: true, instruction: 'dry-run', tier });
    return 0;
  }

  progress(`cold-read (resolution+description): ${branch}`);
  const verdict = await invoke(prompt);
  writeFileSync(join(caseDir, 'coldread-pr-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  // D-054: infra failure → HARD BLOCKING HALT (ERR35), NOT a HELD/reject. The
  // machine state stays `awaiting-pr` (nothing frozen, nothing published) so the
  // agent re-runs report-pr once the cold-read tooling is restored.
  if (verdict.verdict === 'error') {
    const detail = `cold-read tooling unavailable: ${verdict.reason ?? 'unknown'} — report to owner (D-046 case 2) and stop; NOT a content decision`;
    appendJournal(dir, {
      action: 'halt',
      reason: 'coldread-unavailable',
      id: 'ERR35_COLDREAD_UNAVAILABLE',
      caseId,
      branch,
      phase: 'report-pr',
      message: detail,
    });
    console.error(`report-pr HALT [ERR35_COLDREAD_UNAVAILABLE]: ${detail}`);
    result(cli, { instruction: detail, tier, issues: [{ id: 'ERR35_COLDREAD_UNAVAILABLE', detail }] });
    return 1;
  }
  const { rejected, unverifiable } = coldReadRejected(verdict);
  const feedback = boundedFeedback(verdict);
  appendJournal(dir, {
    action: 'coldread',
    caseId,
    branch,
    phase: 'report-pr',
    verdict: verdict.verdict,
    unverifiable,
    rejected,
    feedback,
    defect: verdict.defect ?? null,
  });

  // A description-only defect on a sound resolution → rewrite (not a freeze).
  if (rejected && verdict.defect === 'description') {
    result(cli, {
      instruction: `rewrite: ${verdict.notes}${feedback ? ` — ${feedback}` : ''}`,
      tier,
      feedback,
      issues: [{ id: 'WARN01_TEMPLATE_TEXT', detail: verdict.notes }],
    });
    return 1;
  }
  if (rejected) {
    const note =
      verdict.verdict === 'reject'
        ? `cold-read rejected: ${verdict.notes}`
        : `cold-read UNVERIFIABLE-FROM-REQUEST on ${unverifiable.join(', ')} (fail-closed): ${verdict.notes}`;
    if (tier === 'judged' && rc) {
      // Rejection of the RESOLUTION (D-057 #4): first strike → surface the
      // feedback, the agent revises the worktree and re-runs report-pr (which
      // re-snapshots); second strike → stop retrying, HELD via the unified
      // publish with the escalation prefix. Never merged either way.
      const rejections = coldReadRejectionCount(readJournal(dir), caseId);
      if (rejections >= COLDREAD_REJECT_LIMIT) {
        await freezeHeld(cli, dir, rc, [`${note} — rejected ${rejections}x, escalated to HELD`], {
          resolvedTree,
          escalation: { tag: ESCALATE_REJECTED_2X, feedback },
        });
        reopen(dir, [rc.branch, ...rc.descendants]);
        writeMachineState(dir, { ...st, currentCase: { caseId, branch, tier: 'held' } });
        result(cli, {
          instruction: `held: ${note} — re-run report-pr to publish for owner review`,
          tier: 'held',
        });
        return 1;
      }
      const instruction = `cold read rejected — revise the resolution in the worktree, then re-run report-pr${feedback ? `: ${feedback}` : ''}`;
      result(cli, { instruction, tier: 'judged', rejected: true, feedback });
      return 1;
    }
    // held: keep frozen + unpublished until the description is accurate.
    result(cli, {
      instruction: `rewrite: ${note}${feedback ? ` — ${feedback}` : ''}`,
      tier: 'held',
      feedback,
      issues: [{ id: 'WARN01_TEMPLATE_TEXT', detail: note }],
    });
    return 1;
  }

  // Confirm + scope exceeded on a judged claim (D-057 #3): HELD publishing THE
  // RESOLUTION — the unified publish ships it as an ACTIVE PR (owner reviews &
  // merges), prefixed with the scope escalation naming the extra files.
  if (tier === 'judged' && rc && scopeExceeded) {
    const note = `cold read confirmed but the resolution exceeds the conflict scope -> HELD (resolution published for owner review)`;
    await freezeHeld(cli, dir, rc, [note], {
      resolvedTree,
      escalation: {
        tag: ESCALATE_SCOPE,
        feedback: [feedback, scopeFeedback].filter(Boolean).join(' — ').slice(0, COLDREAD_FEEDBACK_CAP),
      },
    });
    reopen(dir, [rc.branch, ...rc.descendants]);
    writeMachineState(dir, { ...st, currentCase: { caseId, branch, tier: 'held' } });
    result(cli, { instruction: `held: ${note} — re-run report-pr to publish for owner review`, tier: 'held' });
    return 1;
  }

  // Confirm.
  if (tier === 'held') {
    // RECORD INTENT, PUBLISH NOTHING (D-058): the held PR — active for a
    // marker-clean resolution, draft for the pristine conflict — is created at
    // `finish`, AFTER verify is green, so even a held review PR sits on the
    // verified tip and a pass that crashes before finish leaves no PR on
    // origin. The `held` disposition already carries the resolution +
    // escalation the unified publish re-derives from; this row records the
    // remaining intent fields (tier, draft-vs-active, target, conflict head).
    const heldJournal = readJournal(dir);
    const heldDisp = lastDisposition(heldJournal, caseId);
    const heldResolution = heldDisp?.resolution as { tree: string; markerClean: boolean } | null | undefined;
    const draft = heldResolution?.markerClean !== true;
    const jc = journaledCases(heldJournal).get(caseId) ?? null;
    appendJournal(dir, {
      action: 'pr-intent',
      caseId,
      branch,
      mode: 'held',
      tier: 'held',
      draft,
      markerClean: heldResolution?.markerClean === true,
      resolvedTree: heldResolution?.tree ?? null,
      escalation: heldDisp?.escalation ?? null,
      conflictHead: jc?.head ?? null,
    });
    progress(`held: ${branch} — ${draft ? 'draft' : 'review'} PR intent recorded (created at finish)`);
    writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
    console.error(`report-pr: ${caseId} held — PR intent recorded (created at finish)`);
    result(cli, { instruction: 'take next case', tier: 'held', prIntent: true });
    return 0;
  }

  // judged confirm → merge in place + record PR intent (created at finish).
  const preReffed = preReffedSet(journal);
  await recordPreRef(cli, dir, preReffed, rc!.branch);
  const msg = `Merge ${rc!.parent} into ${rc!.branch} (propagation, judged resolution of ${caseId})`;
  const mergeCommit = await journaledResolvedMerge(cli.repo, rc!.branch, rc!.head.sha, resolvedTree, msg, rc!.scope);
  appendJournal(dir, {
    action: 'resolved',
    branch: rc!.branch,
    caseId,
    tier: 'judged',
    mergeCommit,
    coldread: { verdict: verdict.verdict, notes: verdict.notes },
  });
  appendJournal(dir, { action: 'pr-intent', caseId, branch: rc!.branch, mode: 'judged', mergeCommit });
  await removeCaseWorktree(cli, dir, caseId);
  reopen(dir, [rc!.branch, ...rc!.descendants]);
  writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
  progress(`judged: ${rc!.branch} — recorded`);
  console.error(
    `report-pr: ${caseId} judged — merged ${mergeCommit.slice(0, 12)}, PR intent recorded (created at finish)`,
  );
  result(cli, { instruction: 'take next case', tier: 'judged', mergeCommit, prIntent: true });
  return 0;
}

// --------------------------------------------------------------------------
// `sweep finish` (SWEEP-STATE-MACHINE.md §2) — multi-step, resumable.
// --------------------------------------------------------------------------

/**
 * `sweep finish` — the ONLY stage that publishes ANYTHING (D-058: all PRs are
 * created here, after the full-integration verify, D-012). Steps, in order:
 * verify the publishable set (full rebuild) → create JUDGED history PRs
 * (publish, non-draft) → push target branches (flips JUDGED PRs to merged) +
 * closure checks + urges → create the HELD PRs (unified active/draft — push
 * the fix/sweep ref + review PR; NOT merged, the owner decides; bases are now
 * current so the ERR14 held ordering holds) → journal-derived owner report →
 * check upstream advanced past the pinned watermark. Multi-step and resumable:
 * a red verify (offender rolled back + HELD(gate)) or ERR15/ERR18 halts,
 * reports, and re-runs from the stopped phase; pushes/PR-creates never redo
 * (cmdPush skips up-to-date; cmdPublish guards ERR07 journal- and API-side).
 * A pass that crashes BEFORE this stage has published nothing — the next
 * `start` sees a clean origin picture and redoes the pass.
 */
/** One related PR in a finished pass's owner-facing summary (D-059 owner request). */
interface PassPrSummary {
  number: number;
  url: string;
  title: string | null;
  status: string;
  kind: string;
}

/**
 * EVERY PR this pass touched, journal-derived (D-059 owner request): the open
 * review PRs `start` found (origin-blocked rows), PRs reopened/recovered at
 * start, and the JUDGED/HELD PRs created (or reissued) at finish. Titles come
 * from the recorded intent (pr/title.txt); where a transport is available each
 * PR's live title/status is refreshed from GitHub — best-effort per PR, a
 * lookup failure silently keeps the journal-derived values (the summary must
 * never fail a green finish).
 */
async function collectPassPullRequests(
  cli: Cli,
  dir: string,
  journal: JournalEntry[],
  makeTransport?: (token: string) => GithubTransport,
): Promise<PassPrSummary[]> {
  const byNumber = new Map<number, PassPrSummary>();
  const put = (row: PassPrSummary): void => {
    const prev = byNumber.get(row.number);
    byNumber.set(row.number, { ...row, title: row.title ?? prev?.title ?? null });
  };
  for (const e of journal) {
    if (e.action === 'origin-blocked' && typeof e.prNumber === 'number') {
      put({
        number: e.prNumber,
        url: typeof e.prUrl === 'string' ? e.prUrl : '',
        title: null,
        status: 'open',
        kind: 'review-open-at-start',
      });
    } else if (e.action === 'origin-pr-reopened' && typeof e.prNumber === 'number') {
      put({
        number: e.prNumber,
        url: typeof e.prUrl === 'string' ? e.prUrl : '',
        title: null,
        status: 'open',
        kind: 'reopened',
      });
    } else if (e.action === 'origin-pr-created' && typeof e.prNumber === 'number') {
      put({
        number: e.prNumber,
        url: typeof e.prUrl === 'string' ? e.prUrl : '',
        title: null,
        status: e.draft === true ? 'draft' : 'open',
        kind: 'recovered-publish',
      });
    } else if (e.action === 'origin-approved' && typeof e.prNumber === 'number') {
      put({
        number: e.prNumber,
        url: typeof e.prUrl === 'string' ? e.prUrl : '',
        title: null,
        status: 'open',
        kind: 'approved-landing',
      });
    } else if (e.action === 'publish-skipped-live' && typeof e.prNumber === 'number') {
      put({
        number: e.prNumber,
        url: typeof e.prUrl === 'string' ? e.prUrl : '',
        title: null,
        status: typeof e.liveState === 'string' ? e.liveState : 'closed',
        kind: 'owner-acted-mid-pass',
      });
    } else if (e.action === 'pr-published' && typeof e.number === 'number') {
      const titlePath = join(dir, String(e.caseId ?? ''), 'pr', 'title.txt');
      put({
        number: e.number,
        url: typeof e.url === 'string' ? e.url : '',
        title: existsSync(titlePath) ? readFileSync(titlePath, 'utf8').trim() || null : null,
        status: e.mode === 'judged' ? 'merged' : e.draft === true ? 'draft' : 'open',
        kind: e.mode === 'judged' ? 'judged-history' : e.reissued === true ? 'held-review-reissued' : 'held-review',
      });
    }
  }
  // Live refresh (best-effort): title + open/draft/merged from GitHub.
  try {
    let token: string | null = null;
    if (cli.tokenFile && existsSync(cli.tokenFile)) token = readFileSync(cli.tokenFile, 'utf8').trim() || null;
    const slugParts = token ? await originSlug(cli) : null;
    if (token && slugParts) {
      const transport = (makeTransport ?? realGithubTransport)(token);
      for (const row of byNumber.values()) {
        try {
          const pr = await ghExpect(transport, 'GET', `/repos/${slugParts.owner}/${slugParts.repo}/pulls/${row.number}`);
          if (typeof pr.title === 'string' && pr.title) row.title = pr.title;
          row.status =
            pr.merged === true
              ? 'merged'
              : pr.draft === true
                ? 'draft'
                : typeof pr.state === 'string' && pr.state
                  ? pr.state
                  : row.status;
        } catch {
          /* keep the journal-derived row */
        }
      }
    }
  } catch {
    /* summary must never fail a green finish */
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export async function cmdSweepFinish(cli: Cli, makeTransport?: (token: string) => GithubTransport): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  let st = readMachineState(dir);
  if (!st) {
    console.error('finish: no machine state — run `sweep start` first');
    return 2;
  }
  if (st.phase === 'awaiting-pr' || openCases(readJournal(dir)).length > 0) {
    const detail = 'cases remain — resolve every case (next-case/report-case/report-pr) before finish';
    console.error(`finish [ERR34_CASES_REMAIN]: ${detail}`);
    result(cli, { ok: false, issues: [{ id: 'ERR34_CASES_REMAIN', detail }] });
    return 1;
  }
  st = { ...st, phase: 'finishing', finishStep: st.finishStep ?? 'verify' };
  writeMachineState(dir, st);

  if (!cli.execute) {
    const journal = readJournal(dir);
    const unpublished = (jc: JournaledCase): boolean =>
      !journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId);
    const judged = [...journaledCases(journal).values()].filter((jc) => {
      const d = lastDisposition(journal, jc.caseId);
      return d?.action === 'resolved' && d.tier === 'judged' && unpublished(jc);
    });
    const held = [...journaledCases(journal).values()].filter(
      (jc) => lastDisposition(journal, jc.caseId)?.action === 'held' && unpublished(jc),
    );
    result(cli, {
      dryRun: true,
      verifyGreen: canComplete(journal),
      judgedToPublish: judged.map((j) => j.caseId),
      heldToPublish: held.map((j) => j.caseId),
    });
    return 0;
  }

  // (1) verify the publishable set (full rebuild, D-051). A red verify either
  // fails attribution (verifyRc != 0) or rolls a publishable offender back to
  // HELD(gate) — both HALT finish (report + resumable): re-running finish drops
  // the now-frozen offender from the publishable recipe and proceeds. Pushes
  // never redo; the rollback is not repeated (the offender is already frozen).
  progress('verify: running');
  const gateBefore = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate').length;
  const verifyRc = await cmdVerify({ ...cli, cmd: 'verify', execute: true, internal: true });
  const gatesNow = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate');
  const gateAfter = gatesNow.length;
  if (verifyRc !== 0 || gateAfter > gateBefore) {
    const offender = gateAfter > gateBefore ? (gatesNow[gatesNow.length - 1].branch as string | undefined) : undefined;
    const detail =
      verifyRc !== 0
        ? 'verify RED (no clean attribution) — investigate, fix, then re-run `finish` from the verify phase'
        : 'verify RED — offender rolled back + HELD(gate); re-run `finish` (the frozen offender drops out of the publishable set)';
    progress(`verify: RED ${offender ?? '(unattributed)'} — rolled back`);
    console.error(`finish: ${detail}`);
    result(cli, { ok: false, issues: [{ id: 'ERR18_VERIFY_PENDING', detail }], halted: 'verify' });
    return 1;
  }
  progress('verify: green');
  writeMachineState(dir, { ...st, finishStep: 'judged-prs' });

  // (2) create the JUDGED history PRs (non-draft, before the target push so the
  // push auto-flips them to merged). Only cases not already published.
  {
    const journal = readJournal(dir);
    const judged = [...journaledCases(journal).values()].filter((jc) => {
      const d = lastDisposition(journal, jc.caseId);
      return d?.action === 'resolved' && d.tier === 'judged';
    });
    let closuresN = 0;
    for (const jc of judged) {
      if (journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId)) continue;
      const rcPub = await cmdPublish(
        { ...cli, cmd: 'publish', caseId: jc.caseId, execute: true, internal: true },
        makeTransport,
      );
      if (rcPub !== 0) {
        console.error(`finish: JUDGED publish failed for ${jc.caseId} — re-run finish after fixing`);
        result(cli, { ok: false, halted: 'judged-prs', caseId: jc.caseId });
        return 1;
      }
      closuresN++;
    }
    progress(`push: judged closures (${closuresN})`);
  }
  writeMachineState(dir, { ...st, finishStep: 'push' });

  // (3) push target branches (flips JUDGED PRs to merged) + closure checks +
  // urges. PUSH RESILIENCE (D-059 FINAL): per-branch failures (`push-failed`
  // journal rows, categorized) do NOT halt finish — the rest of the pass
  // completes and the SWEEP-RESULT reports landed vs failed factually. Only a
  // GLOBAL failure with no per-branch rows (verify gate, token, closure check)
  // still halts here.
  const pushLenBefore = readJournal(dir).length;
  const pushRc = await cmdPush({ ...cli, cmd: 'push', execute: true, internal: true }, makeTransport);
  const pushDelta = readJournal(dir).slice(pushLenBefore);
  const pushFailures = pushDelta
    .filter((e) => e.action === 'push-failed')
    .map((e) => ({
      branch: String(e.branch),
      category: String(e.category ?? 'transient'),
      detail: String(e.message ?? ''),
    }));
  if (pushRc !== 0 && pushFailures.length === 0) {
    console.error('finish: push halted (ERR16/ERR18/token) — re-run finish from the push phase; pushes never redo');
    result(cli, { ok: false, halted: 'push' });
    return 1;
  }
  progress(`push: targets (${pushDelta.filter((e) => e.action === 'push' && e.kind === 'target').length})`);
  if (pushFailures.length > 0) {
    progress(
      `push: ${pushFailures.length} target(s) FAILED — ${pushFailures.map((f) => `${f.branch} (${f.category})`).join(', ')} — finishing the rest`,
    );
  }
  progress(`urge comments (${pushDelta.filter((e) => e.action === 'urge').length})`);
  writeMachineState(dir, { ...st, finishStep: 'held-prs' });

  // SYSTEMIC OUTAGE short-circuit (D-059 FINAL finding 3): when EVERY push
  // this run failed `transient` and nothing landed, the network itself is
  // down — attempting every held publish (each of which starts with a `git
  // push` of its fix ref) over the same dead transport would just burn a
  // timeout per case for identical failures. Bail to the partial report; the
  // held cases have no `pr-published` rows and retry on the next finish.
  const systemicOutage =
    pushFailures.length > 0 &&
    !pushDelta.some((e) => e.action === 'push') &&
    pushFailures.every((f) => f.category === 'transient');

  // (4) create the HELD PRs (D-058: the ONE publish phase for held cases —
  // push the fix/sweep ref + review PR, active for a marker-clean resolution,
  // draft for the pristine conflict; NEVER merged by the driver). After the
  // target pushes so cmdPublish's ERR14 held ordering holds (origin bases are
  // current). ERR07 (journal + open-PR-by-head) makes a resumed finish skip
  // already-created PRs; gate holds have no case and are never published.
  const publishFailures: Array<{ caseId: string; branch: string }> = [];
  let heldPublishesSkipped = 0;
  if (systemicOutage) {
    const journal = readJournal(dir);
    heldPublishesSkipped = [...journaledCases(journal).values()].filter(
      (jc) =>
        lastDisposition(journal, jc.caseId)?.action === 'held' &&
        !journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId),
    ).length;
    appendJournal(dir, {
      action: 'publish-phase-skipped',
      reason: 'systemic-outage',
      heldPending: heldPublishesSkipped,
      detail: 'every target push failed transient (network down) — held publishes not attempted; they retry on the next finish',
    });
    progress(`held PRs SKIPPED (${heldPublishesSkipped} pending) — systemic transient outage; re-run finish when the network heals`);
  } else {
    const journal = readJournal(dir);
    const held = [...journaledCases(journal).values()].filter(
      (jc) => lastDisposition(journal, jc.caseId)?.action === 'held',
    );
    let heldN = 0;
    for (const jc of held) {
      if (journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId)) continue;
      // Cross-tier duplicate (finding #3): a held case whose conflict signature
      // matches an ALREADY-PUBLISHED sibling (e.g. a JUDGED PR created in
      // phase 2, or an earlier held PR from this loop) can never publish —
      // ERR06 would wedge finish forever. The published PR already carries the
      // resolution: journal the skip and CONTINUE. Journal re-read per case so
      // this-loop publishes are visible to the signature match.
      const jNow = readJournal(dir);
      const jcNow = journaledCases(jNow).get(jc.caseId) ?? jc;
      const dup = await duplicateCaseIssue(cli, jNow, journaledCases(jNow), jcNow);
      if (dup?.duplicateOf) {
        appendJournal(dir, {
          action: 'held-duplicate',
          caseId: jc.caseId,
          branch: jc.branch,
          duplicateOf: dup.duplicateOf.caseId,
          url: dup.duplicateOf.url,
          number: dup.duplicateOf.number,
          detail: dup.detail,
        });
        progress(`held PR skipped — duplicate of published PR #${dup.duplicateOf.number} (${jc.caseId})`);
        continue;
      }
      const rcPub = await cmdPublish(
        { ...cli, cmd: 'publish', caseId: jc.caseId, execute: true, internal: true },
        makeTransport,
      );
      if (rcPub !== 0) {
        // PUSH RESILIENCE (D-059 FINAL): a failed held publish (e.g. its base
        // push failed → ERR14, or a transient API error) no longer halts the
        // whole finish — journal it, finish the rest, report factually; the
        // case retries on the next finish (no pr-published row exists).
        appendJournal(dir, {
          action: 'publish-failed',
          caseId: jc.caseId,
          branch: jc.branch,
          detail: 'held publish failed at finish — retries on the next finish (see the publish output above)',
        });
        publishFailures.push({ caseId: jc.caseId, branch: jc.branch });
        progress(`held PR FAILED for ${jc.caseId} — finishing the rest`);
        continue;
      }
      heldN++;
    }
    progress(`held PRs (${heldN})`);
  }
  writeMachineState(dir, { ...st, finishStep: 'report' });

  // (5) owner report.
  await cmdReport({ ...cli, cmd: 'report', internal: true });
  progress('report ready');

  // (6) upstream advanced past the pinned watermark?
  let upstreamAdvanced = false;
  try {
    const liveUpstream = await revParse(cli.repo, cli.upstream);
    upstreamAdvanced = liveUpstream !== ctx.watermark && !(await isAncestor(cli.repo, liveUpstream, ctx.watermark));
  } catch {
    /* upstream ref unavailable (e.g. fixtures) — report done */
  }

  // PUSH RESILIENCE (D-059 FINAL): with per-branch failures the pass is NOT
  // sealed — the machine state stays `finishing` so a re-run finish retries
  // exactly the failed pushes/publishes (landed branches skip as up-to-date;
  // verify re-gates). Only a fully-landed finish completes the pass.
  const anyFailures = pushFailures.length > 0 || publishFailures.length > 0;
  if (!anyFailures) {
    if (!readJournal(dir).some((e) => e.action === 'pass-complete')) {
      appendJournal(dir, { action: 'pass-complete', watermark: ctx.watermark });
    }
    writeMachineState(dir, {
      schemaVersion: 1,
      phase: 'complete',
      watermark: ctx.watermark,
      watermark12: ctx.watermark12,
      currentCase: null,
      finishStep: 'done',
    });
  } else {
    writeMachineState(dir, { ...st, phase: 'finishing', finishStep: 'push' });
  }
  const next = anyFailures ? 're-run finish' : upstreamAdvanced ? 'start again' : 'done';

  // Owner-facing pass summary on the ONE SWEEP-RESULT (success or partial,
  // D-059 owner request): every related PR (found-open at start / reopened /
  // recovered / created / reissued / approved-landed) + per-branch landed vs
  // failed outcomes + journal-derived stats, with an explicit cue to REPORT
  // them — the agent relays numbers/titles/status/failures to the owner.
  const journalFinal = readJournal(dir);
  const pullRequests = await collectPassPullRequests(cli, dir, journalFinal, makeTransport);
  // Per-branch landed/failed outcomes from THIS run's push phase.
  const outcomeOf = new Map<string, { landed: boolean; category?: string }>();
  for (const e of pushDelta) {
    if (typeof e.branch !== 'string') continue;
    if (e.action === 'push' && e.kind === 'target') outcomeOf.set(e.branch, { landed: true });
    else if (e.action === 'push-skip') outcomeOf.set(e.branch, { landed: true });
    else if (e.action === 'push-failed') outcomeOf.set(e.branch, { landed: false, category: String(e.category ?? 'transient') });
  }
  const branches = [...outcomeOf.entries()].map(([branch, o]) => ({
    branch,
    landed: o.landed,
    ...(o.category ? { category: o.category } : {}),
  }));
  // Annotate each driver-published/landed PR row with its branch outcome; a
  // held publish that failed has no PR row — it is reported via failedPublishes.
  const branchOfPr = new Map<number, string>();
  for (const e of journalFinal) {
    if ((e.action === 'pr-published' || e.action === 'origin-approved') && typeof e.branch === 'string') {
      const n = typeof e.number === 'number' ? e.number : typeof e.prNumber === 'number' ? e.prNumber : null;
      if (n !== null) branchOfPr.set(n, e.branch);
    }
  }
  const annotated = pullRequests.map((pr) => {
    const branch = branchOfPr.get(pr.number);
    const o = branch ? outcomeOf.get(branch) : undefined;
    if (!o) return pr;
    return { ...pr, landed: o.landed, ...(o.category ? { failureCategory: o.category } : {}) };
  });
  const resolvedRows = journalFinal.filter((e) => e.action === 'resolved');
  const publishedRows = journalFinal.filter((e) => e.action === 'pr-published');
  const failedByCategory = { diverged: 0, transient: 0, auth: 0, rejected: 0 };
  for (const f of pushFailures) {
    failedByCategory[(f.category as keyof typeof failedByCategory) ?? 'transient'] =
      (failedByCategory[(f.category as keyof typeof failedByCategory) ?? 'transient'] ?? 0) + 1;
  }
  // Finding 3: owner-action-required failures (diverged / hook-rejected) and
  // blocking non-push issues (ERR16/ERR17/token/API) from THIS run's push
  // phase — surfaced as their own SWEEP-RESULT fields, not merely categories,
  // so an autonomous re-run loop can stop re-trying what only the owner can fix.
  const needsOwner = pushDelta
    .filter((e) => e.action === 'push-escalated')
    .map((e) => ({
      branch: String(e.branch),
      category: String(e.category ?? 'diverged'),
      detail: String(e.detail ?? ''),
    }));
  const pushBlockingIssues = pushDelta
    .filter((e) => e.action === 'push-issue')
    .map((e) => ({ id: String(e.id), detail: String(e.detail) }));
  const stats = {
    branchesInScope: passOrder(dir).length,
    cleanMerges: journalFinal.filter((e) => e.action === 'merge').length,
    resolvedMechanical: resolvedRows.filter((e) => e.tier === 'mechanical').length,
    resolvedJudged: resolvedRows.filter((e) => e.tier === 'judged').length,
    approvedLanded: journalFinal.filter((e) => e.action === 'origin-approved').length,
    held: journalFinal.filter((e) => e.action === 'held').length,
    deferredBranches: new Set(journalFinal.filter((e) => e.action === 'defer').map((e) => e.branch)).size,
    prsCreatedJudged: publishedRows.filter((e) => e.mode === 'judged').length,
    prsCreatedHeld: publishedRows.filter((e) => e.mode === 'held' && e.reissued !== true).length,
    prsReissued: publishedRows.filter((e) => e.reissued === true).length,
    prsReopened: journalFinal.filter((e) => e.action === 'origin-pr-reopened').length,
    prsRecovered: journalFinal.filter((e) => e.action === 'origin-pr-created').length,
    prsOpenAtStart: new Set(
      journalFinal.filter((e) => e.action === 'origin-blocked' && typeof e.prNumber === 'number').map((e) => e.prNumber),
    ).size,
    // PUSH RESILIENCE: landed-vs-failed by category (this run).
    targetsLanded: branches.filter((b) => b.landed).length,
    targetsFailed: pushFailures.length,
    failedByCategory,
    heldPublishFailures: publishFailures.length,
    upstreamAdvanced,
    watermark12: ctx.watermark12,
  };
  if (anyFailures) {
    console.error(
      `sweep finish PARTIAL — ${pushFailures.length} push failure(s), ${publishFailures.length} publish failure(s)` +
        `${needsOwner.length ? `, ${needsOwner.length} OWNER-ACTION-REQUIRED` : ''}${systemicOutage ? ' (systemic outage — held publishes skipped)' : ''}; re-run finish`,
    );
    result(cli, {
      ok: false,
      status: 'partial',
      next,
      upstreamAdvanced,
      pullRequests: annotated,
      branches,
      failedPushes: pushFailures,
      failedPublishes: publishFailures,
      // Finding 3: needs-owner failures are a FIRST-CLASS field — a re-run
      // loop must stop re-trying these branches and hand them to the owner.
      needsOwner,
      blockingIssues: pushBlockingIssues,
      ...(systemicOutage ? { systemicOutage: true, heldPublishesSkipped } : {}),
      stats,
      instruction:
        `REPORT to the owner FACTUALLY: which branches LANDED (${branches.filter((b) => b.landed).map((b) => b.branch).join(', ') || 'none'}) ` +
        `and which FAILED with their categories (${pushFailures.map((f) => `${f.branch}: ${f.category}`).join('; ') || 'none'}${publishFailures.length ? `; held publishes: ${publishFailures.map((p) => p.caseId).join(', ')}` : ''}), ` +
        `plus every PR in pullRequests (number, title, status) and the stats.` +
        `${pushBlockingIssues.length ? ` Blocking push-phase issues: ${pushBlockingIssues.map((i) => i.id).join(', ')}.` : ''} ` +
        `${needsOwner.length ? `OWNER ACTION REQUIRED (do NOT just re-run for these): ${needsOwner.map((n) => `${n.branch} (${n.category})`).join('; ')} — never force-resolve. ` : 'DIVERGED branches need the owner (never force-resolve); '}` +
        `${systemicOutage ? `Network outage: ${heldPublishesSkipped} held publish(es) were skipped, not attempted. ` : ''}` +
        `then re-run \`finish\` — landed branches skip, transient failures retry.`,
    });
    return 1;
  }
  console.error(`sweep finish complete — ${next}`);
  result(cli, {
    ok: true,
    status: 'complete',
    next,
    upstreamAdvanced,
    pullRequests: annotated,
    branches,
    stats,
    instruction:
      `REPORT to the owner: every PR in pullRequests (number, title, status), the landed branches (branches list), and the stats summary; then ` +
      (upstreamAdvanced ? 'run `sweep start` again (upstream advanced past the pinned watermark)' : 'stop — the sweep is done'),
  });
  return 0;
}

const HANDLERS: Record<string, (cli: Cli) => Promise<number>> = {
  plan: cmdPlan,
  run: cmdRun,
  resolve: cmdResolve,
  publish: (cli) => cmdPublish(cli), // real transport unless a test injects one (§14)
  push: (cli) => cmdPush(cli), // §14.4 (D-049): verify-gated pass pushes + closure checks + urges
  verify: cmdVerify,
  unfreeze: cmdUnfreeze,
  status: cmdStatus,
  report: cmdReport, // §14 (D-052 FIX 4): journal-derived end-of-sweep owner summary
  // D-053 state machine (SWEEP-STATE-MACHINE.md) — the agent-facing surface.
  'sweep-start': (cli) => cmdSweepStart(cli), // real transport unless a test injects one (D-058)
  'sweep-abort': cmdSweepAbort,
  'next-case': cmdSweepNextCase,
  'report-case': (cli) => cmdSweepReportCase(cli),
  'report-pr': (cli) => cmdSweepReportPr(cli),
  'sweep-finish': (cli) => cmdSweepFinish(cli),
};

// Only run the dispatcher when invoked as a script (not when imported by tests).
const invokedDirectly = process.argv[1] && /propagate\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const cli = parseCli(process.argv.slice(2));
  const handler = HANDLERS[cli.cmd];
  if (!handler) {
    console.error(`Unknown subcommand '${cli.cmd}'\n${USAGE}`);
    process.exit(2);
  }
  handler(cli).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      process.exit(1);
    },
  );
}

export { parseCli, guardRef, DriverHalt };
export type { Cli };
