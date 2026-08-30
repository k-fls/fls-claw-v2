/**
 * scripts/sweep/propagate.ts — mechanical propagation driver
 * (DRIVER.md §4).
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/propagate.ts <sweep-start|next-case|report-case|report-pr|sweep-finish|sweep-abort> [flags]
 *
 * The state machine (DRIVER.md §1) is the ONLY command surface —
 * the same six commands `sweep-machine.ts` wraps under their agent-facing names.
 * The deterministic stages (plan, run, publish, push, verify, report) are
 * INTERNAL steps of those six and have no standalone entry point: `sweep-start`
 * runs plan, `next-case` runs run, `sweep-finish` runs verify → publish → push →
 * report.
 *
 * Flags:
 *   --repo <path>            repo to operate on                (default: cwd)
 *   --workspace <dir>        artifacts root = GROUP ROOT       (default: parent of --repo; never the --repo clone or a subdirectory of it)
 *   --pass <watermark12>     attach to a specific pass         (default: latest OPEN pass)
 *   --inventory <dir>        feature inventory (tests/fixtures) (default: scripts/sweep/inventory in the clone)
 *   --scope-config <file>    scope policy                      (default: registry/scope.yaml)
 *   --routing-config <file>  router/scan tuning                (default: registry/routing.yaml)
 *   --upstream <ref>         upstream ref (sweep-start only)   (default: upstream/main)
 *   --base <ref>             trunk-chain fork point            (default: FORK_POINT else merge-base)
 *   --dry-run                compute without writing (execute is the default)
 *   --tier <mechanical|judged|held>  report-case: the agent's claimed tier
 *   --token-file <path>      sweep-start/sweep-finish: file holding the substitute
 *                            GitHub token (the agent writes the get_credential output there
 *                            once per session; the credential proxy swaps the Authorization
 *                            header on the wire)
 *   --checks-file <path>     sweep-start: the checks config    (default: scripts/sweep/checks.json)
 *   --commands-file <file>   sweep-finish: CI command list JSON [{cmd,cwd?}] (test injection)
 *   --out <file>             write the command's JSON artifact to a file
 *
 * Artifacts live under <workspace>/propagation/pass-<watermark12>/:
 *   plan-initial.json (immutable opening snapshot), plan.json (working), step files,
 *   case-<id>/case.json (+ coldread-request.md, pr/materials.md), journal.jsonl
 *   (append-only). case.json is a POINTER only — report-case re-derives everything from
 *   git+registry (§7 trust boundary). The driver NEVER generates PR prose (§14): the
 *   agent writes pr/title.txt + pr/body.md from studying the case. `sweep-start` and
 *   `sweep-finish` are the only commands that touch the network (git push/fetch +
 *   GitHub REST — §14/§14.4); refs move via git push ONLY, and any push
 *   failure is a hard halt reported to the owner, never worked around.
 *
 *   NOTHING is published before `finish` — report-pr records intent only, and
 *   finish's single post-verify publish phase creates every PR (judged + held). The
 *   blocked (merge_status) picture is derived from ORIGIN at `sweep start`, never from
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as pathResolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';

import {
  DEFAULT_STACK_CAP,
  DEFAULT_UPSTREAM_REF,
  FORK_POINT,
  RR_CACHE_DIRNAME,
  VERIFY_COMMANDS,
  defaultInventoryDir,
} from './config.js';
import {
  addTempWorktree,
  gitPushDelete,
  commitInfo,
  commitTreeMerge,
  git,
  gitPush,
  isAncestor,
  localBranchExists,
  replayCommitOnto,
  newStyleMergeTree,
  resetBranchRef,
  revParse,
  refExists,
  worktreeBranches,
} from './git.js';
import { CANDIDATE_STANDING_INSTRUCTION, candidateSectionLines, deriveCandidates } from './candidates.js';
import {
  attributeFailure,
  blameCandidates,
  blameFile,
  countFailingFiles,
  describeFingerprint,
  failingLocations,
  fingerprintKeys,
  parseFailingFiles,
  parseFailureFingerprints,
  type FileBlame,
} from './attribute.js';
import { ROOT_BRANCH, TRUNK_BRANCH } from './hierarchy.js';
import {
  classifyEnvironmentFault,
  classifyFailure,
  classifyInstallFailure,
  findIntroducingCommit,
  partitionOwners,
  type BisectOutcome,
  type History,
  type OwnerGroup,
  type SubsetProbe,
} from './not-my-bug.js';
import { malformedCutPointExceptionsIssue, resolveCutPointExceptions, staleWarnings } from './cut-points.js';
import { installRrCache } from './merge.js';
import { appendObservation } from './observations.js';
import { loadFeatures, loadRegistry } from './registry.js';
import { resolveScope } from './scope.js';
import { scopeGuard } from './scope-guard.js';
import {
  advisoryTextIssues,
  checkBaseHeight,
  convertPullRequestToDraft,
  classifyComments,
  classifyReviewTrigger,
  createPullRequest,
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
  renderSweepUrge,
  stripSweepAddressed,
  urgedHeads,
  withMachineBlock,
  type GithubTransport,
  type Issue,
  type PrByHead,
  type PrComment,
  type PrReview,
} from './publish.js';
import { buildStepFile, caseId, readCaseFile, slug, verifyStepFile, writeJsonFile } from './steps.js';
import { applyFloor, tierFloor } from './tiers.js';
import {
  allParentsSkipped,
  deriveBranch,
  derivePlan,
  effectiveCut,
  findLeaves,
  planDrift,
  plansDiffer,
  shortestUnskipChain,
  transitiveAncestors,
  unskipChainClean,
} from './plan.js';
import { deriveCoverage, enumerateChain, type Chain } from './heights.js';
import { DRIVER_COMMIT_ENV, disposeProposal, driverShaped } from './proposal.js';
import {
  classifyConflict,
  conflictIdentity,
  type ConflictHunk,
  type ConflictRelation,
} from './conflict-identity.js';
import { verifyEverything, type VerifyCommand } from './verify.js';
import { WHOLE_RANGE_BLOCK } from './types.js';
import type {
  BranchPlan,
  CaseFile,
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
  pass?: string;
  /**
   * Inventory dir. Omitted (undefined) falls back to the committed
   * scripts/sweep/inventory/ in the clone via loadRegistry — NEVER to an
   * empty inventory, which would silently collapse the scope to
   * main_patched alone.
   */
  inventory?: string;
  scopeFile?: string;
  routingFile?: string;
  upstream: string;
  base?: string;
  execute: boolean;
  caseId?: string;
  tier?: string;
  /**
   * `report-case --not-my-bug` — the agent's claim that the checks failure the
   * driver just reported is not caused by its resolution. ADDITIONAL to `--tier`,
   * never a replacement: the tier classifies the agent's EDIT, this classifies
   * the driver's TEST REPORT. The claim is adjudicated mechanically
   * (`not-my-bug.ts`) and decides nothing on its own; it only says which case is
   * worth paying a comparison for. It cannot be raised on the first
   * `report-case` — the agent may not run tests, so before the gate answers it
   * does not know a test failed at all.
   */
  notMyBug?: boolean;
  /**
   * Dependency-install seam. NOT a CLI flag — an injection point, because
   * `createCaseWorktree` is reached deep inside `cmdRun` and no per-call
   * parameter can carry a stub that far. Without it every fixture case worktree
   * spawns a real `pnpm install`.
   */
  installRunner?: InstallRunner;
  resolvedRef?: string;
  /**
   * Internal override: file holding the substitute GitHub token (§14) — wins
   * over the environment when present, so the flag CLI and tests can pin a
   * token explicitly. The default source is the ENVIRONMENT, read fresh at
   * each networked write: `GH_TOKEN`, then `GITHUB_TOKEN` as fallback (see
   * `resolveGithubTokenSourced`); the credential proxy swaps the Authorization
   * header for api.github.com on the wire. Absent everywhere →
   * ERR11_TOKEN_MISSING; a 401/403 on use → ERR41_TOKEN_REJECTED, whose detail
   * names the token's source.
   */
  tokenFile?: string;
  branch?: string;
  commandsFile?: string;
  /**
   * checks-file: host+runner typecheck/test command lists shipped in the
   * repo (`scripts/sweep/checks.json`). `sweep start` resolves this to
   * flag-or-default, persists the absolute path into machine state, and the later
   * commands read it FROM STATE (never a flag). JSON `{typecheck:[{cmd,cwd}],
   * test:[{cmd,cwd}]}`; a missing file → the corresponding gate is skipped.
   */
  checksFile?: string;
  /** In-memory verify command-list override (finish threads checks.test here). */
  commands?: VerifyCommand[];
  out?: string;
  /**
   * Set on a nested invocation (a state-machine command driving a flag
   * command internally — next-case→run, finish→verify/publish/push/report). When
   * true, `emit` is a no-op and cmdReport skips its `--out` write, so ONLY the
   * outer state-machine command produces a result line. The nested call still
   * does its work, journals, and prints its own SWEEP-STEP progress.
   */
  internal?: boolean;
  /**
   * Publish a HELD case as a RED-FINISH ESCALATION: the pass's target pushes did
   * NOT run (tests are red), so the resolution is transplanted onto
   * `origin/<branch>` instead of sitting on the local tip. Set only by
   * `sweep-finish`'s red arm; never a user-facing flag.
   */
  escalateUnpushed?: boolean;
}

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/propagate.ts <sweep-start|next-case|report-case|report-pr|sweep-finish|sweep-abort> [--repo <path>] [--workspace <dir>] [--pass <wm12>] [--dry-run] [--tier <t>] [--not-my-bug] [--inventory <dir>] [--checks-file <path>] [flags]';

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
    // EXECUTE IS THE DEFAULT for the agent surface — `--dry-run` opts into
    // no-write. (`--execute` is still accepted as an idempotent no-op.)
    execute: true,
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
        cli.execute = true; // idempotent — execute is already the default
        break;
      case '--dry-run':
        cli.execute = false;
        break;
      case '--checks-file':
        cli.checksFile = pathResolve(need());
        break;
      case '--tier':
        cli.tier = need();
        break;
      case '--not-my-bug':
        cli.notMyBug = true;
        break;
      case '--token-file':
        cli.tokenFile = pathResolve(need());
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
  // The canonical workspace is the GROUP ROOT — the parent of the
  // git clone (`repo/`), where the DURABLE `rr-cache` lives. When `--workspace`
  // is not given, derive it from `--repo` so the pass and rr-cache never land
  // INSIDE the clone (a clone-local rr-cache is wiped with the clone, losing
  // rerere's learned resolutions). An explicit `--workspace` is honored
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

/**
 * There is NO start-time base gate: `start` does not typecheck the base, and a
 * red base never refuses a pass.
 *
 * A red base is discovered where every other red is: `finish`'s verify, which
 * blames the failing files and mints a gate-fix case on the branch that owns
 * them — the base included, since `main_patched` is a scope entry and the
 * default parent of every root (scope.ts). The cross-pass anti-loop is the
 * fix's own PR: an active gate-fix ref on origin blocks its branch through the
 * machinery that already blocks every other fix PR, and self-clears when the
 * owner merges it. No local side-car state is kept for this — the blocked
 * picture is derived from ORIGIN at start, never from a local file.
 */

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

/**
 * Blocked state: merge_status is not stored anywhere local — it is DERIVED.
 * Cross-pass authority is ORIGIN: `sweep start` reconstructs the
 * PR_ID set from the origin `fix/sweep/*` refs (an unmerged ref WITH an open
 * PR ⇔ blocked) and journals one `origin-blocked` row per blocked branch into
 * the fresh pass dir. Within a pass the journal is the working view:
 * `origin-blocked` rows + this-pass `held` dispositions are PR_ID; `defer`
 * rows are DEFERRED while a direct parent is still blocked; a manual
 * `unfrozen` row clears a branch for the rest of the pass.
 */
interface BlockedRow {
  branch: string;
  /** Blocking case id ('origin:<ref>' for start-derived rows, 'gate*' for §9 holds). */
  caseId: string;
  /**
   * WHAT THE OPEN PROPOSAL IS, from the SHAPE of its head when it was
   * classified — never from the ref name, which is a string the driver minted
   * rather than a fact about the objects:
   *  - `merge` — a two-parent head proposes a merge. Its cut sits inside one
   *    window: everything below the merge point is already in, everything at or
   *    above it waits for the owner.
   *  - `fix` — a one-parent head proposes a fix to the branch's own content, so
   *    the branch is RED. Nothing on it is proven and the block is total.
   * Only an explicit `fix` freezes: a proposal is a merge unless its head was
   * seen to be one commit.
   */
  kind: 'merge' | 'fix';
  /**
   * The commit whose TRUNK COVERAGE is the cut. For a merge proposal that is
   * the head, from which the cut point is recovered (a driver-built PR head is
   * `[branch tip, conflict head]`, and the conflict head is the cut; a
   * this-pass hold carries the conflict head itself, which is already it).
   * Null when nothing measurable was recorded — which cuts the whole range,
   * since an unmeasurable block is a total one, not an absent one.
   */
  headSha: string | null;
  /**
   * The proposal PREDATES this pass (it was read off origin at `start`), so the
   * branch has been held back for as long as the owner has taken with it. That
   * is what keeps it out of the integration build: it lags the trunk, and a
   * rebuild onto a current base blames it for the conflict its own freeze
   * implies. A branch frozen by THIS pass has landed exactly the prefix it
   * could integrate and is in no such position.
   */
  carriedOver: boolean;
  /** fix/sweep head branch on origin (urge target); null until a PR exists. */
  fixBranch: string | null;
  prNumber: number | null;
  /**
   * The PR's effective sweep-addressed id at classification time (null
   * when unknown/no marker). Urge comments re-assert it so every driver
   * comment carries the marker (the content-based bot exclusion).
   */
  markerId: number | null;
}

/**
 * PR_ID rows derived from the pass journal, keyed branch → ALL of its rows
 * (last-writer-wins per branch+caseId): a multi-parent branch can carry
 * SEVERAL concurrent blocks (one per held case / origin fix ref), and every
 * one matters — collapsing to one row weakens the descendants' DEFER
 * height-MIN whenever the survivor is the HIGHER block.
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
        kind: e.kind === 'fix' ? 'fix' : 'merge',
        headSha: typeof e.headSha === 'string' ? e.headSha : null,
        carriedOver: true,
        fixBranch: typeof e.fixBranch === 'string' ? e.fixBranch : null,
        prNumber: typeof e.prNumber === 'number' ? e.prNumber : null,
        markerId: typeof e.markerId === 'number' ? e.markerId : null,
      });
    } else if (e.action === 'held') {
      const jc = typeof e.caseId === 'string' ? cases.get(e.caseId) : undefined;
      put({
        branch: e.branch,
        caseId: typeof e.caseId === 'string' ? e.caseId : 'held',
        // A gate hold is a fix on the branch's own content, so the PR it
        // becomes has one parent — it freezes here already, one pass before
        // origin can show the driver that shape.
        kind: e.reason === 'gate' ? 'fix' : 'merge',
        headSha: jc?.head.sha ?? null,
        carriedOver: false,
        fixBranch: null, // no PR until `finish` publishes
        prNumber: null,
        markerId: null,
      });
    } else if (e.action === 'env-blocked') {
      // The same block a HELD freeze puts on the branch, and for the same
      // reason: an unjudgeable case is an unresolved one. Its window is trimmed
      // at the conflict head (or wholly, for a gate fix — a branch under repair
      // proposes a fix to its own content), so nothing below it takes content
      // this pass could not verify.
      const jc = typeof e.caseId === 'string' ? cases.get(e.caseId) : undefined;
      put({
        branch: e.branch,
        caseId: typeof e.caseId === 'string' ? e.caseId : 'env-blocked',
        kind: e.gateFix === true ? 'fix' : 'merge',
        headSha: jc?.head.sha ?? (typeof e.headSha === 'string' ? e.headSha : null),
        carriedOver: false,
        fixBranch: null, // there is no proposal: nothing was verified
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
 * Branches under repair, and every transitive descendant.
 *
 * A FREEZE IS TRANSITIVE AND ABSOLUTE, and that is about VERIFIABILITY, not
 * provenance. Below a red branch every case is unjudgeable: `report-case`
 * checks fail on a defect the open fix already describes, `--not-my-bug` burns
 * adjudication rounds proving it, and the agent is handed work that cannot
 * complete. Letting merges flow past would take excluding the tests, which
 * makes the gate meaningless. So the frozen branch and everything under it take
 * NOTHING from any parent — the same empty-interval, all-skip treatment a
 * branch waiting on its own PR gets.
 */
function frozenBranches(cli: Cli, journal: JournalEntry[]): Set<string> {
  const roots = new Set(
    [...blockedRows(journal).entries()].filter(([, rows]) => rows.some((r) => r.kind === 'fix')).map(([b]) => b),
  );
  if (roots.size === 0) return roots;
  const out = new Set(roots);
  const ancestorsOf = transitiveAncestors(Object.fromEntries(directParentEdges(cli)));
  for (const [branch, ancestors] of Object.entries(ancestorsOf)) {
    if (ancestors.some((a) => roots.has(a))) out.add(branch);
  }
  return out;
}

/**
 * The pass's merge_status view (branch → PR_ID | DEFERRED; absence = NONE),
 * derived from the journal alone:
 *  - PR_ID: `blockedRows` (origin-derived rows + this-pass holds), PLUS every
 *    transitive descendant of a FROZEN branch.
 *  - DEFERRED: branches with a journaled `defer` this pass, kept only while a
 *    DIRECT parent (registry edges) is still blocked — the STAY rule as
 *    a fixpoint over the journal instead of a stored flag, so a cleared
 *    parent releases its whole deferred chain on the next derivation. Across
 *    passes nothing is stored: DEFERRED is simply recomputed from the
 *    parents' PR_ID during derivation (the BECOME height-MIN rule re-runs).
 */
function passStatusView(cli: Cli, journal: JournalEntry[]): Map<string, 'PR_ID' | 'DEFERRED'> {
  const pr = blockedRows(journal);
  const parentsOf = directParentEdges(cli);
  const frozen = frozenBranches(cli, journal);
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
      .filter((b) => !pr.has(b) && !frozen.has(b)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of [...deferred]) {
      const parents = parentsOf.get(b) ?? [];
      if (!parents.some((p) => pr.has(p) || frozen.has(p) || deferred.has(p))) {
        deferred.delete(b);
        changed = true;
      }
    }
  }
  const out = new Map<string, 'PR_ID' | 'DEFERRED'>();
  for (const b of pr.keys()) out.set(b, 'PR_ID');
  for (const b of frozen) out.set(b, 'PR_ID');
  for (const b of deferred) out.set(b, 'DEFERRED');
  return out;
}

/**
 * LIVE cut records for the blocked branches. No height is stored anywhere —
 * heights are pass-relative (the chain's fork point moves as branches absorb
 * upstream), so every cut is RE-DERIVED against THIS pass's pinned chain from
 * the row's sha. DEFERRED branches are not here: their heights are re-probed
 * live during derivation.
 *
 * A MERGE proposal cuts at its SECOND PARENT'S coverage. A driver-built PR head
 * is `[branch tip, conflict head]`, and it is the conflict head that says where
 * the window closes — the head's OWN coverage is the max of the two sides, so
 * once the branch tip moves past the conflict (an owner commit, another
 * parent's merge) it reads high and hands descendants content nobody has
 * integrated. A row whose sha is already the cut commit (a this-pass hold
 * carries the conflict head itself) is its own second parent.
 *
 * A FIX proposal is the BOTTOM of the lattice (`-Infinity`): the branch is red,
 * not red-above-height-k, so no prefix of it is proven clean and nothing from
 * it is eligible. The same value covers a block whose sha cannot be resolved —
 * an unmeasurable block is a total one, not an absent one.
 *
 * A cut BELOW this pass's window trims nothing: the window closes AT the
 * conflict, and a conflict under the window is not in it. The branch's own
 * cases still gate it.
 */
async function prBlockedRecords(cli: Cli, journal: JournalEntry[], chain: Chain): Promise<HeldRecord[]> {
  const out: HeldRecord[] = [];
  for (const [branch, rows] of blockedRows(journal)) {
    // Multiple concurrent blocks per branch: contribute the
    // MINIMUM cut — the safest trim for descendants (a higher survivor would
    // let a child below it wrongly take content the lower cut covers).
    let best: HeldRecord | null = null;
    for (const row of rows) {
      let height: number;
      if (row.kind === 'fix' || !row.headSha || !(await refExists(cli.repo, row.headSha))) {
        height = WHOLE_RANGE_BLOCK;
      } else {
        const head = await commitInfo(cli.repo, row.headSha);
        const cutSha = head.parents.length >= 2 ? head.parents[1] : row.headSha;
        height = (await deriveCoverage(cli.repo, chain, cutSha)).height;
        if (height < 0) continue; // the cut is below this pass's window
      }
      if (!best || height < best.height) best = { branch, height, conflictedPaths: [], caseId: row.caseId };
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * The pass's CUT MAP, rebuilt from the plan rows in DAG order: each blocked
 * branch's own cut, then every branch's inherited minimum plus whatever its own
 * rows deferred at.
 *
 * A derivation outside the run loop — a case re-verification — has to see the
 * SAME cut the run derived. Rebuilding only the blocked branches' cuts would
 * leave a branch two edges below a block with an open window, and the
 * re-derivation would then find a conflict the run never served and call the
 * live case stale.
 */
function passCutMap(plan: PropagationPlan, held: HeldRecord[]): Map<string, number> {
  const cutOf = new Map<string, number>();
  const put = (branch: string, height: number): void => {
    cutOf.set(branch, Math.min(height, cutOf.get(branch) ?? Infinity));
  };
  for (const rec of held) put(rec.branch, rec.height);
  for (const bp of plan.branches) {
    const inherited = effectiveCut(
      bp.parents.map((p) => p.parent),
      cutOf,
    );
    if (inherited) put(bp.branch, inherited.height);
    for (const pp of bp.parents) if (pp.deferHeight !== undefined) put(bp.branch, pp.deferHeight);
  }
  return cutOf;
}

/**
 * Direct-parent edges from the registry (features + scope extra_edges): the
 * DEFERRED stay-condition is a function of the DIRECT parents, never a stored
 * flag or a journaled defer pointer.
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

/** A pending urge for a still-PR_ID-blocked branch (§8; posted by `push`, §14.4). */
interface PendingUrge {
  branch: string;
  /** The pending run's top = the newest pending trunk head (a blocked branch lands no merges). */
  head: string;
  pending: Head[];
  fixBranch: string;
  prNumber: number | null;
  /** The blocking case id (merge_status PR_ID caseId). */
  caseId: string;
  /** Current sweep-addressed id re-asserted by the urge comment. */
  markerId: number | null;
}

/**
 * URGING detection (§8, pure): for each PR_ID-blocked branch, if the newest
 * pending trunk head beyond its coverage on the PINNED chain differs from
 * `lastUrgedHead`, an urge is DUE. One urge per NEW head, not per pass.
 * `plan`/`run` only report these; POSTING (PR comment + machine-block
 * refresh + `lastUrgedHead` advance) lives exclusively in the networked
 * `push` stage (§14.4 — the driver posts, never prepares gh commands).
 * Blocked rows come from the journal (origin-derived at start). DEDUP is
 * done at POST time against the PR's own comments (`urgedHeads`), not from a
 * local cache: "have I already urged about this head" is a fact about origin.
 */
async function detectUrges(cli: Cli, ctx: PassCtx, journal: JournalEntry[]): Promise<PendingUrge[]> {
  const due: PendingUrge[] = [];
  for (const row of [...blockedRows(journal).values()].flat()) {
    // Rows without a fix branch have no owner-facing PR to nudge: gate holds,
    // and this-pass holds whose PR is only created at `finish` — those
    // become origin-derived rows (with a PR) by the next pass.
    if (!row.fixBranch) continue;
    if (!(await refExists(cli.repo, row.branch))) continue;
    const tip = await revParse(cli.repo, row.branch);
    const coverage = (await deriveCoverage(cli.repo, ctx.chain, tip)).height;
    const pending = ctx.chain.heads.filter((h) => h.height > coverage);
    if (pending.length === 0) continue;
    const newest = pending[pending.length - 1];
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
    // Every driver comment carries the sweep-addressed marker (the
    // content-based bot exclusion — same PAT as the human). The urge RE-ASSERTS
    // the current value; classification takes the MAX, so this never regresses.
    renderSweepAddressed(urge.markerId ?? 0),
    // The record that this head WAS urged — read back by `urgedHeads`, never
    // from a local cache.
    renderSweepUrge(urge.head),
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
    stackCap: registry.routing.stackCap, // stacked-run cap lever (per-feature override in derivePlan)
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
  const superseded = supersededCaseIds(journal);
  const out = new Set<string>();
  for (const [caseId, branch] of branchOf) if (!closed.has(caseId) && !superseded.has(caseId)) out.add(branch);
  return out;
}

/**
 * RECIPE MEMBERSHIP — the ONE rule, and the only one: a branch belongs iff
 * NOTHING AT OR ABOVE IT IS BLOCKED.
 *
 * A blocked branch carries an unresolved proposal, so its content is not
 * integrable and merging it onto the base recreates the conflict the proposal
 * exists to settle. Everything under it is in the same position: its window is
 * cut at that block, so what it holds above the cut is a state the trunk has
 * never seen, and a rebuild that includes it blames the descendant for the
 * ancestor's conflict.
 *
 * "Advanced this pass" is NOT the rule. Whether a branch happened to merge
 * something in the last few minutes says nothing about whether its content
 * integrates, and gating on it means the build validates a slice of the fork
 * that shrinks to nothing on a quiet pass.
 */
export function recipeMember(branch: string, blocked: Set<string>, ancestorsOf: Record<string, string[]>): boolean {
  if (blocked.has(branch)) return false;
  return !(ancestorsOf[branch] ?? []).some((a) => blocked.has(a));
}

/**
 * The verify recipe: every member of `order` (the plan's DAG order, parents
 * before children) that passes `recipeMember`.
 */
export function publishableRecipe(
  order: string[],
  blocked: Set<string>,
  ancestorsOf: Record<string, string[]>,
): string[] {
  return order.filter((b) => recipeMember(b, blocked, ancestorsOf));
}

/** Why a branch sits outside the integration build (§10.7 `coverage.excluded`). */
export type ExclusionReason =
  | 'cut-this-pass'
  | 'blocked-before-this-pass'
  | 'under-repair'
  | 'open-case'
  | 'blocked-above'
  | 'no-local-ref';

/** One branch the build left out, and why — `via` names the block above it. */
export interface RecipeExclusion {
  branch: string;
  reason: ExclusionReason;
  via?: string;
}

/**
 * THE BRANCHES THE INTEGRATION BUILD LEAVES OUT, each with the reason. The
 * build can only judge content the trunk could actually receive, so a branch
 * standing at a cut is outside it whichever pass cut it:
 *
 *  - CUT THIS PASS — a hold taken here closes the window at the conflict, and a
 *    sibling carrying content ABOVE that cut re-materialises the very conflict
 *    the cut represents inside the rebuild; the held branch is then named the
 *    offender and rolled back for a conflict that is pending propagation, not
 *    integration breakage. Two branches at different cut points do not merge
 *    into one tree. Structural, not policy — and no statement about whether the
 *    pass produced something legitimate there (see `pushMember`).
 *  - BLOCKED BEFORE THIS PASS — a proposal read off origin has held its branch
 *    back for as long as the owner has taken with it, so the branch lags the
 *    trunk by that much.
 *  - UNDER REPAIR — a branch with a fix proposal on its own content, and every
 *    transitive descendant, is red by definition.
 *  - OPEN CASE — an unresolved conflict still in hand.
 *
 * A DEFERRED branch is not listed: it is already out through the blocked
 * ancestor it is deferring behind, and naming it would say the block is its own.
 */
function directExclusions(cli: Cli, journal: JournalEntry[]): Map<string, ExclusionReason> {
  const out = new Map<string, ExclusionReason>();
  for (const [branch, rows] of blockedRows(journal)) {
    out.set(
      branch,
      rows.some((r) => r.kind === 'fix')
        ? 'under-repair'
        : rows.some((r) => r.carriedOver)
          ? 'blocked-before-this-pass'
          : 'cut-this-pass',
    );
  }
  for (const b of frozenBranches(cli, journal)) if (!out.has(b)) out.set(b, 'under-repair');
  for (const b of openCaseBranches(journal)) if (!out.has(b)) out.set(b, 'open-case');
  return out;
}

/** The set form of `directExclusions` — the recipe's blocked input. */
function blockedForRecipe(cli: Cli, journal: JournalEntry[]): Set<string> {
  return new Set(directExclusions(cli, journal).keys());
}

/**
 * WHAT THE INTEGRATION BUILD COVERED AND WHAT IT LEFT OUT, per branch and with
 * the reason (§10.7). A PARTIAL build is a valid pass; what makes it valid is
 * that the result says which branches shipped without one, so the owner never
 * has to infer it from a log line.
 *
 * `unresolvable` are recipe members with no local ref: dropped loudly at the
 * gate, and dropped here for the same reason rather than counted as built.
 */
export function recipeCoverage(
  order: string[],
  direct: Map<string, ExclusionReason>,
  ancestorsOf: Record<string, string[]>,
  unresolvable: readonly string[] = [],
): { built: string[]; excluded: RecipeExclusion[] } {
  const built: string[] = [];
  const excluded: RecipeExclusion[] = [];
  const noRef = new Set(unresolvable);
  for (const branch of order) {
    const own = direct.get(branch);
    if (own) {
      excluded.push({ branch, reason: own });
      continue;
    }
    const via = (ancestorsOf[branch] ?? []).find((a) => direct.has(a));
    if (via) excluded.push({ branch, reason: 'blocked-above', via });
    else if (noRef.has(branch)) excluded.push({ branch, reason: 'no-local-ref' });
    else built.push(branch);
  }
  return { built, excluded };
}

/**
 * PUSH MEMBERSHIP — a DIFFERENT question from recipe membership, and coupling
 * the two is a defect.
 *
 * The recipe answers "can this be integration-built". This answers "did the
 * pass produce something legitimate here", and a branch merged to its cut point
 * has: the prefix below the cut is a complete, consistent position, and its
 * held PR is opened against ORIGIN'S copy of that prefix. Withholding the push
 * bases the PR on a commit the branch no longer sits on (`checkBaseHeight` then
 * refuses with ERR14, and the transplant fallback leaves the branch diverged),
 * and the same work is redone every pass until the owner acts.
 *
 * So blockedness never withholds a push. Content pushed at a cut point was in
 * no integration build — that is REPORTED (`coverage`, `pushedUnbuilt`), never
 * prevented by holding the branch back. The gate on pushing is that the pass
 * succeeded (a green verify for this pass, §9), not that the branch was in the
 * recipe.
 */
export function pushMember(branch: string, mutated: ReadonlySet<string>): boolean {
  return mutated.has(branch);
}

/**
 * THE PROPOSALS THIS PASS DROPPED. `start` deletes a ref whose head poses no
 * question any more, or answers one it can no longer answer, and GitHub closes
 * the pull request with it. That is a PR disappearing from the owner's list and
 * an agent's resolution going with it, so it is named in the finish report —
 * branch, number, url and what made it inapplicable — and a delete that failed
 * says so, because then the PR is still open.
 */
function droppedProposalRows(
  journal: JournalEntry[],
): Array<{ branch: string; ref: string; number: number; url: string; reason: string; deleteFailed?: string }> {
  return journal
    .filter((e) => e.action === 'proposal-dropped')
    .map((e) => ({
      branch: String(e.branch ?? ''),
      ref: String(e.ref ?? ''),
      number: typeof e.prNumber === 'number' ? e.prNumber : 0,
      url: String(e.prUrl ?? ''),
      reason: String(e.reason ?? ''),
      ...(typeof e.deleteFailed === 'string' ? { deleteFailed: e.deleteFailed } : {}),
    }));
}

/**
 * THE PROPOSALS NOBODY COULD JUDGE. The merged-tree probe disagreed with itself
 * on the same tree, or never ran at all, so the disposition that a red would
 * have driven — deleting the ref — did not happen. The pull request stands
 * exactly where it was; what needs reporting is the unstable check.
 */
function undecidedProposalRows(
  journal: JournalEntry[],
): Array<{ branch: string; ref: string; number: number; url: string; id: string; detail: string }> {
  return journal
    .filter((e) => e.action === 'proposal-check-undecided')
    .map((e) => ({
      branch: String(e.branch ?? ''),
      ref: String(e.ref ?? ''),
      number: typeof e.prNumber === 'number' ? e.prNumber : 0,
      url: String(e.prUrl ?? ''),
      id: String(e.id ?? ''),
      detail: String(e.detail ?? ''),
    }));
}

/** The pass's coverage, from the journal and the plan on disk (§10.7). */
function passCoverage(
  cli: Cli,
  dir: string,
  journal: JournalEntry[],
): { built: string[]; excluded: RecipeExclusion[] } {
  const noRef = journal
    .filter((e) => e.action === 'verify-recipe-dropped')
    .flatMap((e) => (Array.isArray(e.branches) ? (e.branches as string[]) : []));
  return recipeCoverage(
    passOrder(dir),
    directExclusions(cli, journal),
    transitiveAncestors(Object.fromEntries(directParentEdges(cli))),
    noRef,
  );
}

/**
 * BRANCHES THIS PASS MERGED ON WHOSE MERGES NEVER REACHED ORIGIN, with the
 * reason. Up-to-date and origin-ahead skips are not here — there was nothing to
 * send — and neither are push FAILURES, which the result reports as failures.
 * What is left is work the pass did and did not ship, which the owner is
 * otherwise left to notice for himself.
 */
function withheldPushRows(journal: JournalEntry[]): Array<{ branch: string; reason: string }> {
  const mutated = new Set(
    journal
      .filter((e) => (e.action === 'merge' || e.action === 'resolved') && typeof e.branch === 'string')
      .map((e) => e.branch as string),
  );
  const seenByPush = new Set(
    journal
      .filter(
        (e) =>
          (e.action === 'push' || e.action === 'push-skip' || e.action === 'push-failed') &&
          typeof e.branch === 'string',
      )
      .map((e) => e.branch as string),
  );
  const stated = new Map(
    journal
      .filter((e) => e.action === 'push-withheld' && typeof e.branch === 'string')
      .map((e) => [e.branch as string, String(e.reason ?? '')]),
  );
  return [...mutated]
    .filter((b) => !seenByPush.has(b))
    .map((branch) => ({ branch, reason: stated.get(branch) || 'the push stage did not reach this branch' }));
}

/**
 * ONE FAILING FILE SET THE PASS PROVED PRE-EXISTING AND ATTRIBUTED TO NOBODY
 * (§10.7 `uncoveredRemainders`).
 */
export interface UncoveredRemainder {
  /** The files still failing with no case behind them. */
  files: string[];
  /** The case whose adjudication produced them. */
  caseId: string;
  /** The branch that case was merging INTO, and the parent it was merging FROM. */
  branch: string;
  parent: string;
  /**
   * `interaction` — green on each side alone, red only merged: this merge owns
   * it and nobody upstream does. `unknown` — a probe would not build, so no
   * owner could be proven either way.
   */
  reason: 'interaction' | 'unknown';
  /** The adjudication's own per-side words for it. */
  detail: string;
}

/**
 * THE FAILURES THIS PASS PROVED REAL AND MINTED NOTHING FOR.
 *
 * `--not-my-bug` partitions a confirmed pre-existing failure across its owners.
 * Every file that reaches a proven owner gets a gate-fix case; the rest are the
 * REMAINDER, and a remainder has no case, no pull request and no branch to land
 * on. It is nonetheless red, and it stays red after the pass.
 *
 * The mid-pass `report-case` result names it, but that result is gone by the
 * time the agent reports, and the agent assembles its report from the FINISH
 * result alone. A fact carried only mid-pass is a fact reconstructed from
 * memory, which is how a remainder turns into a claim about branch tips nobody
 * measured. So the finish result carries it too, derived from the journal —
 * the same journal, no new state, and nothing that outlives the pass.
 *
 * COVERED LATER IS NOT UNCOVERED. A remainder the pass went on to deal with —
 * scope-widened and fixed, or re-adjudicated onto an owner that did get a case
 * — is not reported, per file, so a partially covered set reports only the part
 * still standing. What counts as cover, all of it strictly after the remainder
 * was journaled:
 *
 *  - a `gate-fix` mint naming the file: an owner was proven after all;
 *  - a proven-owner (`branch`/`parent`) row naming it: same answer, stated by
 *    the adjudication itself;
 *  - a `resolved` row for the case that carried it, or for its branch: that
 *    case passed the checks gate on a tree containing this merge, so the file
 *    is green there.
 */
export function uncoveredRemainders(
  journal: JournalEntry[],
  cases: Map<string, { branch: string; parent: string }>,
): UncoveredRemainder[] {
  const filesOf = (e: JournalEntry): string[] => (Array.isArray(e.files) ? (e.files as string[]) : []);
  const out: UncoveredRemainder[] = [];
  journal.forEach((e, i) => {
    if (e.action !== 'not-my-bug-owner') return;
    if (e.owner !== 'interaction' && e.owner !== 'unknown') return;
    const caseId = String(e.caseId ?? '');
    const covered = new Set<string>();
    for (const later of journal.slice(i + 1)) {
      if (later.action === 'gate-fix') for (const f of filesOf(later)) covered.add(f);
      else if (later.action === 'not-my-bug-owner' && (later.owner === 'branch' || later.owner === 'parent'))
        for (const f of filesOf(later)) covered.add(f);
      else if (later.action === 'resolved' && (later.caseId === caseId || later.branch === e.branch))
        for (const f of filesOf(e)) covered.add(f);
    }
    const files = filesOf(e).filter((f) => !covered.has(f));
    if (files.length === 0) return;
    const c = cases.get(caseId);
    out.push({
      files,
      caseId,
      branch: c?.branch ?? String(e.branch ?? ''),
      parent: c?.parent ?? '',
      reason: e.owner as 'interaction' | 'unknown',
      detail: String(e.detail ?? ''),
    });
  });
  return out;
}

/** A red this pass proved and could hand to no branch (§10.7 `needsOwner`). */
export interface UnmintableRed {
  /** The branch no case could be rooted on. */
  branch: string;
  /** The failing files, where the refusal named them. */
  files: string[];
  /** The code the refusal named, where it named one. */
  id?: string;
  detail: string;
}

/**
 * THE REDS THIS PASS PROVED AND COULD HAND TO NOBODY.
 *
 * A refusal is journaled `gate-fix-refused` wherever it is taken — the mint, the
 * `--not-my-bug` preflight, the landing gate — and nothing read those rows. So a
 * red that blocked a branch, minted no case and opened no PR left the pass
 * entirely: the mid-pass result that named it is gone by the time the agent
 * reports, and the report is assembled from the FINISH result alone.
 *
 * It is owner-shaped work, not driver-shaped: only the owner can decide what to
 * do about a failure no branch introduced. So it travels under `needsOwner`,
 * where an autonomous re-run loop already knows to stop rather than retry.
 *
 * COVERED LATER IS NOT UNCOVERED, on the same terms as a remainder: a refusal the
 * pass went on to mint a case for — a re-measurement that confirmed the red where
 * it belonged — is not reported, and neither is one whose branch was later
 * measured GREEN. Both are strictly after the refusal.
 *
 * Coverage is by FILE, not by branch: a branch can carry two independent reds, and
 * minting a case for one says nothing about the other. Only a mint whose files
 * contain the refusal's answers it. A refusal that named no files — a landing
 * refusal, whose subject is the whole tree — is answered by any later mint on the
 * branch, since there is nothing narrower to compare.
 */
export function unmintableReds(journal: JournalEntry[]): UnmintableRed[] {
  const out: UnmintableRed[] = [];
  const seen = new Set<string>();
  journal.forEach((e, i) => {
    if (e.action !== 'gate-fix-refused') return;
    const branch = String(e.branch ?? '');
    const files = Array.isArray(e.files) ? (e.files as string[]) : [];
    const key = `${branch} :: ${files.join(', ')}`;
    if (seen.has(key)) return;
    for (const later of journal.slice(i + 1)) {
      if (later.branch !== branch) continue;
      if (later.action === 'gate-fix') {
        const mintedFiles = Array.isArray(later.files) ? (later.files as string[]) : [];
        if (files.length === 0 || files.every((f) => mintedFiles.includes(f))) return;
      }
      if (later.action === 'landing-check' && later.ok === true) return;
    }
    seen.add(key);
    out.push({
      branch,
      files,
      // NO GUESSED CODE. A code is a specific diagnosis and the owner reads it as
      // one; a row that named none is reported without one rather than under
      // whatever the reader would have defaulted to.
      ...(typeof e.id === 'string' ? { id: e.id } : {}),
      detail: String(e.reason ?? ''),
    });
  });
  return out;
}

// --------------------------------------------------------------------------
// Journaled ref mutations (reuse merge.ts's commit-tree + update-ref technique).
// --------------------------------------------------------------------------

async function treeOf(repo: string, commit: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
}

/**
 * The SUBTREE a checks command runs in — the object a run of that command is a
 * function of.
 *
 * A command carries a `cwd` (`{ cmd: 'bun test', cwd: 'container/agent-runner' }`),
 * and everything it can observe lives under that path: its verdict is a fact
 * about THAT subtree and says nothing about the rest of the tree. A command with
 * no cwd runs at the repo root, so its subtree IS the whole tree.
 *
 * A cwd that does not exist at this commit resolves to the whole tree instead.
 * Over-keying costs a measurement; under-keying would let two unrelated trees
 * share a verdict, so the fallback goes the safe way.
 */
async function subtreeOf(repo: string, commit: string, cwd?: string): Promise<string> {
  const rel = (cwd ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (rel === '') return treeOf(repo, commit);
  const r = await git(repo, ['rev-parse', `${commit}:${rel}`], { allowCodes: [1, 128] });
  const oid = r.stdout.trim();
  return r.code === 0 && oid !== '' ? oid : treeOf(repo, commit);
}

/**
 * What a check verdict is ABOUT: the subtree the command ran in and the command.
 *
 * Both halves are load-bearing. A run of `tsc` says nothing about `bun test`,
 * and a run of `bun test` in `container/agent-runner` says nothing about `src/`
 * — so two branches whose `container/agent-runner` subtrees are identical
 * cannot disagree about it, and neither can two commands that measure different
 * bytes.
 */
function checkKey(subtree: string, cmd: string): string {
  return `${subtree} :: ${cmd}`;
}

/** One command's verdict, with the subtree it was measured on. */
export interface CheckVerdict {
  cmd: string;
  cwd?: string;
  subtree: string;
}

/** Resolve every command's subtree at one commit, in config order. */
async function checkVerdictKeys(repo: string, commit: string, commands: VerifyCommand[]): Promise<CheckVerdict[]> {
  const out: CheckVerdict[] = [];
  for (const c of commands) out.push({ cmd: c.cmd, ...(c.cwd ? { cwd: c.cwd } : {}), subtree: await subtreeOf(repo, commit, c.cwd) });
  return out;
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
 * the §9 rollback guard in cmdVerify, where it can only ever FORBID a write:
 * WHICH branch rolls back is the leave-one-out offender, and handing plan.json
 * in as the allow-set lets a tampered plan narrow what may be written, never
 * widen it. The resolve flow derives its scope from the registry instead (N2,
 * reverifyCase): there plan.json IS attacker-relevant and must not extend the
 * scope.
 */
function passScope(dir: string): Set<string> {
  const p = join(dir, 'plan.json');
  const src = existsSync(p) ? p : join(dir, 'plan-initial.json');
  if (!existsSync(src)) return new Set();
  const plan = JSON.parse(readFileSync(src, 'utf8')) as PropagationPlan;
  return new Set(plan.branches.map((b) => b.branch));
}

/** The pass plan's DAG order (parents before children) — verify recipe order (§9). */
function passOrder(dir: string): string[] {
  const p = join(dir, 'plan.json');
  const src = existsSync(p) ? p : join(dir, 'plan-initial.json');
  if (!existsSync(src)) return [];
  const plan = JSON.parse(readFileSync(src, 'utf8')) as PropagationPlan;
  return plan.order ?? [];
}

/**
 * The verify rebuild base per the §3 merge-source model: module & feat
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
    // Backstop: cmdRun re-probes cleanliness against the LIVE tip
    // immediately before every parent merge (§3 execution re-probe), so a
    // conflicted tree is unreachable here in normal operation. Anything that
    // still throws (racing ref movement, update-ref CAS refusal) must surface
    // as a journaled per-branch halt — never escape as a bare Error and abort
    // the whole run.
    throw new DriverHalt(
      'merge-failed',
      `merge into '${branch}' failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Origin sync (§13) — one journaled origin-sync step per in-scope branch,
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

/**
 * Commit a GATE FIX onto a branch — a SINGLE-parent commit, unlike
 * `journaledResolvedMerge`. A gate fix is new code, not a propagation merge:
 * there is no `theirs` side to record, and recording the branch tip as a second
 * parent would fabricate a self-merge. Same ref-scope guard and same
 * follow-the-ref treatment of a checked-out worktree.
 */
async function journaledFixCommit(
  repo: string,
  branch: string,
  fixedTree: string,
  message: string,
  scope: Set<string>,
): Promise<string> {
  guardRef(branch, scope);
  const wt = await checkedOutWorktree(repo, branch);
  const tip = await revParse(repo, branch);
  const commit = (await git(repo, ['commit-tree', fixedTree, '-p', tip, '-m', message])).stdout.trim();
  await git(repo, ['update-ref', `refs/heads/${branch}`, commit, tip]);
  if (wt) await git(repo, ['reset', '--hard', commit], { cwd: wt });
  return commit;
}

// --------------------------------------------------------------------------
// Case artifacts.
// --------------------------------------------------------------------------

/**
 * The three BOUNDED cold-reader questions. The cold read is deliberately
 * focused — it must not go researching the universe. There is no open-ended
 * question about follow-on invariants (tests, types, call sites):
 * typecheck/tests are the verify gate's job (§9), not the reader's.
 */
const COLD_READ_QUESTIONS = [
  "1. Within the conflicted hunks, is each side's behaviour preserved or its loss explicitly justified? Name anything silently lost.",
  '2. Is every change in the resolution diff explained by the conflict — no content from outside the two sides/base? Name any unexplained hunk.',
  '3. Does the resolution contradict any record included in this request?',
];

/**
 * A GATE FIX is judged on different questions, because it is not a merge.
 *
 * The shared set asks about "the conflicted hunks" and "the two sides/base". A
 * gate fix has neither: its `automergeTree` IS the branch tip, so the conflict
 * section of its request is EMPTY. Q1 is then unanswerable and Q2 is worse —
 * with no conflict to explain anything, EVERY hunk reads as "content from
 * outside the two sides".
 *
 * What actually needs judging is: does this change fix the named failure, and
 * ONLY that. Q2 is deliberately the sharp one — a gate-fix case is the place an
 * agent is most tempted to smuggle in an unrelated fix, since it is the one case
 * kind that edits code the pass did not merge.
 */
const GATE_FIX_COLD_READ_QUESTIONS = [
  '1. Does the change plausibly make the named failing check pass? Name anything that would still fail.',
  '2. Is every hunk explained by THAT failure — nothing unrelated fixed, cleaned up or refactored along the way? Name any unexplained hunk.',
  '3. Does the change contradict any record included in this request?',
];

/**
 * A gate fix's EVIDENCE is the failing check's own output — it stands where the
 * conflict hunks stand for a merge case. Without it the reader is asked whether
 * a change fixes a failure it was never shown.
 */
function gateFixEvidenceLines(failedOutput: string): string[] {
  return [
    '## The failure this fix must clear (checks output, verbatim)',
    '```',
    failedOutput.trim() || '(no output was captured)',
    '```',
    '',
    'There are NO conflict hunks and no two sides: this branch is not being merged.',
    'The change below edits code the pass did not merge, which is legitimate for a',
    'gate fix. The file a compiler NAMES is often not the file that must change —',
    'a signature, a type or a caller elsewhere may be the real fix — so a hunk',
    'outside the failing files is NOT by itself wrong. Judge whether it is',
    'explained by THIS failure.',
  ];
}

/** Cold-read preamble: the reader judges from the request ONLY — never researches. */
const COLD_READ_PREAMBLE = [
  'Judge ONLY from the materials in this request. Do NOT explore the repository or search',
  'beyond them. If something cannot be judged from the request, answer',
  'UNVERIFIABLE-FROM-REQUEST for that point instead of researching — the driver will treat',
  'it as a reject reason only if it concerns questions 1-3.',
];

/**
 * Per-side one-line histories over the conflicted paths: what each side did to
 * the disputed files since their merge base (`git log --oneline`, capped).
 * Driver-derived facts used by the case context block (§7) and
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
 * The CONFLICT REGIONS only (token-opt), extracted from the automerge tree
 * blobs: each `<<<<<<<…=======…>>>>>>>` block (diff3 `|||||||` base included)
 * with ±`around` lines of surrounding context, gaps elided with `…`, one
 * labeled block per path. Replaces a full `git diff <tip> <automergeTree>`,
 * which also dragged in theirs's NON-conflicting clean changes to the same
 * files — the cold read only judges the marked regions + the resolution diff.
 * A path absent from the tree (delete/modify) is skipped (its conflict shows in
 * the resolution diff). Best-effort; returns '' if nothing is markered.
 */
export async function conflictHunks(repo: string, tree: string, paths: string[], around = 3): Promise<string> {
  const blocks: string[] = [];
  for (const p of paths) {
    const res = await git(repo, ['cat-file', '-p', `${tree}:${p}`], { allowCodes: [128] });
    if (res.code !== 0) continue;
    const lines = res.stdout.split('\n');
    const keep = new Set<number>();
    let inConflict = false;
    lines.forEach((l, i) => {
      if (/^<{7}/.test(l)) inConflict = true;
      if (inConflict) for (let j = Math.max(0, i - around); j <= Math.min(lines.length - 1, i + around); j++) keep.add(j);
      if (/^>{7}/.test(l)) inConflict = false;
    });
    if (keep.size === 0) continue;
    const out: string[] = [`--- ${p} ---`];
    let prev = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i > prev + 1) out.push('…');
      out.push(lines[i]);
      prev = i;
    }
    blocks.push(out.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Relevant inventory context for a case (used by BOTH cold reads): the
 * branch's and parent's entries plus any entry whose owned_paths cover a
 * conflicted path, reduced to summary + owned_paths. The inventory says WHOSE
 * code a case is in; it never says how to resolve one, so there is no prose
 * here to embed. Driver-authored from the registry, so the resolving agent
 * still cannot frame the question.
 */
function inventoryContextLines(features: FeatureEntry[], branch: string, parent: string, paths: string[]): string[] {
  const relevant = features.filter(
    (f) =>
      f.branch === branch ||
      f.branch === parent ||
      (f.owned_paths ?? []).some((glob) => paths.some((p) => p.startsWith(glob.replace(/\*.*$/, '')))),
  );
  if (relevant.length === 0) return ['(no matching inventory entries)'];
  const lines: string[] = [];
  for (const f of relevant) {
    lines.push(`- entry '${f.id}'${f.branch ? ` (branch ${f.branch})` : ''}: ${f.summary ?? f.name}`);
    if (f.owned_paths?.length) lines.push(`  owned_paths: ${f.owned_paths.join(', ')}`);
  }
  return lines;
}

/**
 * The driver-derived case context block: the branch's inventory entry summary +
 * owned_paths, and per-side `git log
 * --oneline` over the conflicted paths, so the cold reader can answer
 * ownership questions instead of rejecting for lack of context. Driver-authored
 * inputs only — the resolving agent still cannot frame the question.
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
    '## Case context (driver-derived)',
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
 * The cold-read request (§7): conflict hunks + resolution diff +
 * the driver-derived case context (inventory summary/owned_paths/
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
  gateFix?: { failedOutput: string } | null,
): string {
  return [
    `# Cold-read request — ${c.id}`,
    '',
    ...COLD_READ_PREAMBLE,
    '',
    ...(gateFix
      ? [
          `Branch: ${c.branch}   GATE FIX (no merge — this change resolves no conflict)`,
          `Failing files: ${c.conflictedPaths.join(', ')}`,
        ]
      : [
          `Branch: ${c.branch}   Parent: ${c.parent}   Height: ${c.head.height}`,
          `Conflicted paths: ${c.conflictedPaths.join(', ')}`,
        ]),
    '',
    ...contextLines,
    '',
    ...(gateFix
      ? gateFixEvidenceLines(gateFix.failedOutput)
      : ['## Conflict hunks (branch tip -> automerge tree)', '```diff', conflictDiff, '```']),
    '',
    gateFix ? '## The fix (branch tip -> resolved tree)' : '## Resolution diff (automerge tree -> resolved tree)',
    ...(resolutionDiff === null
      ? ['_No resolution attempt yet — `resolve` regenerates this file with the diff before requiring a verdict (§7)._']
      : ['```diff', resolutionDiff, '```']),
    '',
    '## Cold-reader questions',
    ...(gateFix ? GATE_FIX_COLD_READ_QUESTIONS : COLD_READ_QUESTIONS),
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
    'An `UNVERIFIABLE-FROM-REQUEST` answer on any of q1-q3 is treated as a reject (fail-closed).',
  ].join('\n');
}

/**
 * Anti-thrash cap (defense in depth, mirroring the kind-2 repro
 * cap). A resolution whose tree keeps CHANGING between attempts never
 * converges under cold read; beyond this many DISTINCT resolution trees the
 * driver stops retrying the case and force-freezes it HELD for the owner
 * rather than looping. Kept small — a genuine resolve converges in one or two.
 */
export const RESOLVE_COLDREAD_CAP = 2;

/**
 * Cold-read REJECTIONS per case before the driver stops retrying and
 * escalates to HELD (published via the unified active/draft path with the
 * warning prefix below). Tightens the distinct-tree cap above: two content
 * rejections mean the owner should look, not the agent loop.
 */
const COLDREAD_REJECT_LIMIT = 2;

/** Bound on the cold reviewer's 1-2 line `feedback`. */
const COLDREAD_FEEDBACK_CAP = 400;

/**
 * DEPENDENCIES WOULD NOT INSTALL WHERE THE MANIFESTS ARE COMMITTED AND VALID.
 *
 * Every install the driver runs on a committed tree reads manifests git is
 * holding, so a failure there is the machine — no network, no permissions, no
 * package manager — and nothing in the fork can fix it. It is terminal for the
 * pass: a tree with no environment yields check results that are not evidence
 * about the code, so the driver refuses to serve or judge work in it and hands
 * the machine to the owner.
 */
const ERR_ENVIRONMENT_UNUSABLE = 'ERR47_ENVIRONMENT_UNUSABLE';

/**
 * THE RESOLUTION'S MANIFESTS DO NOT INSTALL.
 *
 * At the checks gate the manifests in the worktree are the AGENT'S: a
 * `package.json` left unparseable, or a lockfile the resolution's dependency
 * change no longer matches under `--frozen-lockfile`. This is work the agent
 * can do, so it is handed back with what to fix — not reported to the owner as
 * a broken machine, and not counted as a failing check, because no check ran.
 */
const ERR_MANIFEST_UNINSTALLABLE = 'ERR49_MANIFEST_UNINSTALLABLE';

/** PR-description warning prefixes for HELD escalations (owner-facing). */
const ESCALATE_REJECTED_2X = '[AUTO-ESCALATED: cold read rejected 2x]';
const ESCALATE_SCOPE = '[AUTO-ESCALATED: scope exceeded]';
const ESCALATE_CAP = '[AUTO-ESCALATED: resolution did not converge]';
/** The checks gate (typecheck/tests) kept failing CHECKS_FAIL_LIMIT times. */
const ESCALATE_CHECKS = '[AUTO-ESCALATED: checks failing]';

/**
 * How many times a case's checks gate (typecheck OR tests) may fail before
 * the driver stops asking the agent to fix and force-freezes it HELD (draft,
 * pristine conflict — the agent's failing resolution is NOT published) for the
 * owner. Counted per case, reset on a passing checks run (`checksFailCount`).
 */
export const CHECKS_FAIL_LIMIT = 10;

/**
 * How many consecutive checks failures prove a DEAD END: distinct resolutions
 * that all fail with the identical fingerprint set (`deadEndEvidence`).
 *
 * Three is the smallest number that can distinguish "the agent is converging" from
 * "the agent is orbiting". Two identical failures are ordinary — the first fix
 * missed. Three, each from a DIFFERENT tree, say the failure is insensitive to
 * everything the agent has tried, which is a fact about the case and not about
 * the agent's effort.
 *
 * It is EVIDENCE, not a gate. Reaching it changes no disposition, forces no
 * tier, and does not touch `CHECKS_FAIL_LIMIT` above: the agent is told what the
 * driver can prove and keeps every option it had, including spending the
 * remaining attempts. A driver that decided here would be guessing at the one
 * thing it cannot see — whether the cause is reachable from this case.
 */
export const DEAD_END_ATTEMPTS = 3;
/** How many fingerprints the dead-end sentence names before it stops listing. */
const DEAD_END_NAMED = 3;

/**
 * How many times `next-case` may hand the SAME case to the agent before it says
 * so, and before it refuses.
 *
 * `CHECKS_FAIL_LIMIT` counts `report-case` failures, so it never fires on an
 * agent that never submits — the shape to foreclose: an agent reads a dozen
 * files, concludes nothing, and asks for the next case; `next-case` re-selects
 * the same one (it refuses only `awaiting-pr`) and journals nothing, so the
 * pass looks idle while going nowhere. The bound belongs here, where the
 * looping actually happens.
 *
 * WARN first, then refuse. A silent forced HELD would throw away the agent's
 * chance to write the diagnosis, which is the deliverable when it cannot fix
 * something — so the warning names the loop and asks for `--tier held`, and only
 * the next serve is an error.
 */
export const CASE_SERVE_WARN = 3;
export const CASE_SERVE_LIMIT = 4;

/**
 * The host+runner checks (typecheck + tests) that `report-case` runs as
 * its single quality gate (RESOLVED cases) and `finish` runs on the publishable
 * set. Shipped in the repo (`scripts/sweep/checks.json`); each list is command +
 * clone-root-relative cwd. A missing/empty list → that gate is skipped.
 */
export interface ChecksConfig {
  typecheck: VerifyCommand[];
  test: VerifyCommand[];
}

/**
 * Load + normalize the checks config from the persisted path; null when absent
 * — or unparseable, which is why every caller asks `malformedChecksIssue` FIRST:
 * that is the only thing that tells the two apart.
 */
function loadChecksConfig(checksFile: string | undefined): ChecksConfig | null {
  if (!checksFile || !existsSync(checksFile)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(checksFile, 'utf8'));
  } catch {
    return null;
  }
  const r = (raw ?? {}) as { typecheck?: unknown; test?: unknown };
  const norm = (v: unknown): VerifyCommand[] =>
    Array.isArray(v) ? (v.filter((c) => c && typeof (c as VerifyCommand).cmd === 'string') as VerifyCommand[]) : [];
  return { typecheck: norm(r.typecheck), test: norm(r.test) };
}

/**
 * A MALFORMED checks file, told apart from an ABSENT one.
 *
 * `loadChecksConfig` returns null for both and null means "skip the gate", so a
 * single JSON typo would silently disable BOTH gates — the per-case checks gate
 * and the finish verify command list — with no issue, no journal row and no
 * warning: the pass would run to completion reporting everything green while
 * nothing was ever typechecked or tested. An ABSENT file stays a deliberate
 * skip (a repo without checks simply skips both gates); a BROKEN one is a
 * broken gate and must stop the command that found it.
 */
function malformedChecksIssue(checksFile: string | undefined): Issue | null {
  if (!checksFile || !existsSync(checksFile)) return null;
  try {
    JSON.parse(readFileSync(checksFile, 'utf8'));
    return null;
  } catch (e) {
    return {
      id: 'ERR43_CHECKS_MALFORMED',
      detail:
        `the checks file ${checksFile} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — ` +
        `the per-case checks gate AND the finish verify list would both be skipped SILENTLY; ` +
        `fix the file (or point --checks-file elsewhere) and re-run`,
    };
  }
}

/**
 * How much of a failing checks run the agent is handed. The FULL log goes to
 * `<kind>-output.full.txt`; the file the driver TELLS the agent to read is capped
 * to this many trailing lines. An uncapped run of a large test suite can write
 * hundreds of KB, and "read <output-file>" then becomes a context bomb for a
 * handful of failing names. The tail is where failures and summaries live.
 */
const CHECKS_OUTPUT_TAIL_LINES = 250;

/**
 * Cap on the failing verify output carried in a journal row. Enough
 * for the compiler diagnostics `attributeFailure` parses; small enough that a
 * chatty test runner cannot bloat the journal the whole pass reads repeatedly.
 */
const VERIFY_OUTPUT_JOURNAL_CAP = 20000;


/**
 * A gate fix has NO parent — it is not a merge. `CaseFile.parent` is a required
 * string, so it carries this self-describing label rather than a branch name.
 * It is WRITE-ONLY: nothing reads it (case KIND comes from the `gateFix: true`
 * journal flag, and the ref name from `isGateFixCaseId`), so it cannot mislead
 * a code path — it only has to be legible in the journal.
 * Deleting it would mean making `parent` optional across CaseFile/ResolvedCase
 * and every reader, which is churn for no behavioural gain.
 */
const GATE_FIX_PARENT = '(gate-fix)';

/**
 * A gate fix's IDENTITY: the branch the fix lands on plus the set of failing
 * files. It is the anti-loop key (`a gate fix was already attempted for this
 * branch over these files`) AND the seed of the case id, so the two can never
 * disagree about what "the same gate fix" means.
 */
function gateFixKey(branch: string, files: string[]): string {
  return `${branch}::${[...files].sort().join(',')}`;
}

/**
 * A GATE-FIX case id. N5 SHAPE, gate-fix form: `gate-fix-<slug(branch)>-<id8>`.
 *
 * A gate fix has NO conflict and therefore NO height, so it cannot honestly
 * wear the conflict form (`<branch>--<parent>-h<n>`) — a fake placeholder
 * height would be a lie that the id validator's regex, the fix-ref parser, and
 * every height reader downstream would all have to be taught. The id instead
 * carries the case's real identity:
 * the branch, plus a digest of the FAILING FILE SET — which is also what keeps
 * two DIFFERENT gate fixes on ONE branch (same pass, different failing files)
 * from colliding on an id. A collision there is fatal, not cosmetic: the second
 * case inherits the first's `resolved` disposition, drops straight out of
 * `openCases`, and `next-case` can never serve it.
 *
 * THE DIGEST COVERS THE FILES ONLY, not `gateFixKey`. With
 * the branch mixed in, the same failing test on two branches would produce two
 * unrelated digests and a cross-branch duplicate would be invisible BY CONSTRUCTION —
 * and duplicates are the normal case for an unstable shared test, which surfaces
 * wherever luck puts it. Files-only means the same defect wears the same digest
 * everywhere, so `refs/remotes/origin/fix/sweep/*--gate-fix-*` can be matched on
 * sight with no extra bookkeeping. Within-branch uniqueness is untouched:
 * different file sets still differ.
 *
 * `gateFixKey` remains branch-scoped and remains the per-pass ANTI-LOOP key —
 * two concerns, two keys. One looping branch must not suppress another branch's
 * first attempt at the same file.
 */
function gateFixFilesDigest(files: string[]): string {
  return createHash('sha256')
    .update([...files].sort().join(','))
    .digest('hex')
    .slice(0, 8);
}

function gateFixCaseId(branch: string, files: string[]): string {
  return `gate-fix-${slug(branch)}-${gateFixFilesDigest(files)}`;
}

/**
 * Gate fixes ELSEWHERE covering any of these failing files — this pass's journal
 * plus the open fix refs on origin from earlier passes.
 *
 * Both cases are still minted: separate branches are separate lines of history
 * and each genuinely needs the fix. What the owner must not have to work out for
 * themselves is that they are ONE defect — merge one, then rebase or drop the
 * rest — so it goes in the PR text.
 *
 * WITHIN THE PASS the match is per-FILE, not whole-set. A descendant inherits an
 * ancestor's red PLUS its own, so its file set is typically a SUPERSET of the
 * ancestor's — the normal shape, and invisible to a digest comparison. The
 * journal's `gate-fix` rows carry the files verbatim, so the intersection is
 * exact and local. ACROSS PASSES only the whole-set digest in the ref name is
 * available: a diagnosis-only held gate fix is an empty commit, so its files
 * cannot be recovered by diffing the ref. Digest equality is the strongest
 * sound cross-pass signal and stays.
 */
async function duplicateGateFixes(cli: Cli, dir: string, branch: string, files: string[]): Promise<string[]> {
  const digest = gateFixFilesDigest(files);
  const want = new Set(files);
  const out: string[] = [];
  for (const e of readJournal(dir)) {
    if (e.action !== 'gate-fix' || typeof e.caseId !== 'string' || e.branch === branch) continue;
    const theirs = Array.isArray(e.files) ? (e.files as string[]) : [];
    const shared = theirs.filter((f) => want.has(f));
    if (shared.length === 0) continue;
    const scope = shared.length === theirs.length && shared.length === want.size ? 'same files' : `shares ${shared.join(', ')}`;
    out.push(`${String(e.caseId)} (this pass, on ${String(e.branch)} — ${scope})`);
  }
  for (const ref of await activeGateFixRefs(cli.repo)) {
    if (!ref.endsWith(`-${digest}`)) continue;
    if (ref.includes(`/${slug(branch)}--`)) continue; // this branch's own open fix
    out.push(`${ref} (open on origin)`);
  }
  return [...new Set(out)];
}

/** The gate-fix id form (N5). Charset-safe by construction — no `/`, no `.`. */
const GATE_FIX_CASE_ID_RE = /^gate-fix-[A-Za-z0-9_-]+-[0-9a-f]{8}$/;

function isGateFixCaseId(id: string): boolean {
  return GATE_FIX_CASE_ID_RE.test(id);
}

/**
 * The HEIGHT of a gate-fix case's head. A gate fix's head IS the branch tip
 * (there is no conflict head to merge), so its height is that tip's COVERAGE on
 * the pass's pinned chain — the highest trunk head the branch already contains.
 * That is the same quantity a conflict head's height denotes (a trunk index),
 * which is what keeps every height reader honest for a gate fix: notably the
 * PR-body machine block, whose `pendingAbove = heads.length - 1 - head.height`
 * would report `heads.length` — one MORE than the chain even holds — on every
 * held gate-fix PR if a placeholder `-1` sat in this field.
 *
 * `deriveCoverage` may itself return -1, and that is not a placeholder: it means
 * the branch contains NO head of this chain, for which "every trunk head is
 * still pending above it" is the arithmetically correct reading.
 */
async function gateFixHeadHeight(cli: Cli, chain: Chain, tip: string): Promise<number> {
  return (await deriveCoverage(cli.repo, chain, tip)).height;
}

/**
 * A MECHANICAL digest of a failing checks run: one line per failing file, with
 * how many diagnostics it carries, which error codes, and the LINE RANGE those
 * diagnostics occupy in the full log.
 *
 * A tail answers "what were the last N lines"; this answers "what failed, and
 * where do I read about it" — which is the question both readers actually have.
 * The agent gets regions to open instead of a window someone else chose, and
 * the SHAPE of a failure becomes legible: 38 files all reporting TS2580
 * "Cannot find name 'process'" reads instantly as a broken toolchain, where the
 * last 4000 characters of the same run can look like four files with type
 * errors — a misreading that mints a gate-fix case against a defect that does
 * not exist.
 *
 * Pure text in, pure text out — no git, no fs.
 */
export function failureSummary(output: string, fullFile: string | null): string {
  const lines = output.split('\n');
  type Agg = { count: number; codes: Set<string>; first: number; last: number };
  const perFile = new Map<string, Agg>();
  lines.forEach((line, i) => {
    const m = TSC_DIAG_RE.exec(line);
    if (!m) return;
    const file = m[1].replace(/^\.\//, '');
    const code = m[2];
    const agg = perFile.get(file);
    if (agg) {
      agg.count += 1;
      agg.codes.add(code);
      agg.last = i + 1;
    } else {
      perFile.set(file, { count: 1, codes: new Set([code]), first: i + 1, last: i + 1 });
    }
  });
  if (perFile.size === 0) return '';
  const rows = [...perFile.entries()].sort((a, b) => b[1].count - a[1].count);
  const width = Math.min(60, Math.max(...rows.map(([f]) => f.length)));
  const body = rows.map(
    ([file, a]) =>
      `  ${file.padEnd(width)}  ${String(a.count).padStart(3)} err  ` +
      `${[...a.codes].sort().join(',').slice(0, 40).padEnd(40)}  lines ${a.first}-${a.last}`,
  );
  const total = rows.reduce((n, [, a]) => n + a.count, 0);
  return [
    `SUMMARY: ${total} diagnostic(s) across ${rows.length} file(s), ${lines.length} lines of output` +
      (fullFile ? ` — full log: ${fullFile}` : ''),
    ...body,
  ].join('\n');
}

/** `src/x.ts(12,3): error TS2345: …` and `src/x.ts:12:3 - error TS2345: …`. */
const TSC_DIAG_RE = /^\s*([\w./@-]+\.[cm]?tsx?)(?:\(\d+,\d+\)|:\d+:\d+\s*-)\s*:?\s*error\s+(TS\d+)/;

/**
 * The text BLAME reads for a failed verify: the full log from disk when it is
 * there, else the journal's bounded copy.
 *
 * Blame is a pure text scrape (`parseFailingFiles`), so a file whose
 * diagnostics were cropped out is not merely under-reported — it cannot be
 * attributed, named in a case, or fixed. The journal field stays capped so a
 * chatty runner cannot bloat it; the file carries everything.
 */
function attributionOutput(row: JournalEntry | null): string {
  const f = typeof row?.failedOutputFile === 'string' ? row.failedOutputFile : null;
  if (f && existsSync(f)) {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      /* fall through to the journal copy */
    }
  }
  return typeof row?.failedOutput === 'string' ? row.failedOutput : '';
}

/**
 * The bounded view of a failing checks run: the failing command names up front
 * (the thing the agent must act on), then the tail of the raw output, then a
 * pointer to the full log on disk for when the tail is not enough.
 */
function boundedChecksOutput(r: ChecksRunResult, fullFile: string): string {
  const lines = r.output.split('\n');
  const truncated = lines.length > CHECKS_OUTPUT_TAIL_LINES;
  const tail = truncated ? lines.slice(-CHECKS_OUTPUT_TAIL_LINES) : lines;
  const summary = failureSummary(r.output, fullFile);
  return [
    `FAILED: ${r.failedNames.join(', ')}`,
    truncated
      ? `(showing the last ${CHECKS_OUTPUT_TAIL_LINES} of ${lines.length} lines — full log: ${fullFile})`
      : `(full output below — also at ${fullFile})`,
    // The digest goes ABOVE the tail: when a run fails in hundreds of places the
    // tail is the least informative part of it, and the per-file line ranges are
    // what let the agent open the right region of the full log.
    ...(summary ? ['', summary] : []),
    '',
    ...tail,
  ].join('\n');
}

/** The outcome of running one checks command list in a directory. */
export interface ChecksRunResult {
  ok: boolean;
  /** The commands that exited non-zero (their `cmd` strings). */
  failedNames: string[];
  /** Concatenated stdout+stderr of the failed commands (written to an output file). */
  output: string;
  /**
   * A command that never RAN — the process could not be spawned (missing
   * binary, OOM killer, fork failure), which `spawnSync` reports as a null
   * status. That is an ENVIRONMENT FAULT, not a red check: the tree was never
   * measured. It still counts as a failure for gates that must fail closed, but
   * a reader deciding to destroy something on the strength of a red must see
   * this field and refuse.
   */
  environmentFault?: { cmd: string; detail: string };
}

/**
 * Run a checks command list under `baseDir` (each command's `cwd` is
 * joined onto it) and report which commands failed + their output. Injectable
 * (mirrors the cold-read invoker) so tests never spawn a real pnpm/bun.
 */
export type ChecksRunner = (commands: VerifyCommand[], baseDir: string) => Promise<ChecksRunResult>;

export const defaultChecksRunner: ChecksRunner = async (commands, baseDir) => {
  const failedNames: string[] = [];
  let output = '';
  let environmentFault: { cmd: string; detail: string } | undefined;
  for (const { cmd, cwd } of commands) {
    const res = spawnSync('bash', ['-c', cmd], {
      cwd: cwd ? join(baseDir, cwd) : baseDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      failedNames.push(cmd);
      output += `$ ${cmd}\n${(res.stdout ?? '') + (res.stderr ?? '')}\n`;
    }
    // A NULL STATUS IS NOT A VERDICT. The process did not run (or was killed by
    // a signal), so the tree was never measured — reporting that as a failing
    // check hands every consumer a red they can act on, including the ones that
    // destroy something.
    if (res.status === null && !environmentFault) {
      environmentFault = {
        cmd,
        detail:
          `'${cmd}' did not run: ${res.error ? res.error.message : `terminated by ${res.signal ?? 'an unknown signal'}`}` +
          ' — an environment fault, not a failing check',
      };
    }
  }
  return { ok: failedNames.length === 0, failedNames, output, ...(environmentFault ? { environmentFault } : {}) };
};

/** Single-quote a path for `bash -c`. Paths here come from git, but never trust. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Narrow a checks command list to the FILES that failed (`VerifyCommand.filter`).
 *
 * Each file is assigned to the command with the LONGEST matching `cwd`, so a
 * failure under `container/agent-runner` re-runs bun alone and not the root pnpm
 * suite as well — every command's cwd is a prefix of it and without the
 * longest-match rule both would run, which is most of the cost this is avoiding.
 *
 * A command with no `filter` still runs WHOLE when one of its files failed. That
 * is deliberate for `tsc`: a project typecheck cannot be narrowed to a file list
 * without changing what it means (it would drop the tsconfig), so it pays full
 * price and stays correct. Commands with no failing file are dropped entirely.
 */
export function subsetCommands(commands: VerifyCommand[], files: string[]): VerifyCommand[] {
  return subsetCommandMap(commands, files).map((m) => m.narrowed);
}

/**
 * The same narrowing, WITH the command each narrowed one came from.
 *
 * A narrowed command reports itself under a different name (`bun test 'src/x.test.ts'`,
 * not `bun test`), and every consumer downstream of a checks run — the journal's
 * `failed`, the HELD escalation text, `--not-my-bug`'s
 * `list.filter(c => failedNames.includes(c.cmd))` — matches those names against
 * the CONFIGURED command list. Without the way back, a narrowed run's failure
 * matches nothing and adjudication is handed an empty command list.
 */
export function subsetCommandMap(
  commands: VerifyCommand[],
  files: string[],
): Array<{ from: VerifyCommand; narrowed: VerifyCommand }> {
  const norm = (cwd: string | undefined): string => (cwd ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '');
  const under = (f: string, cwd: string): boolean => cwd === '' || f === cwd || f.startsWith(`${cwd}/`);
  const cwds = commands.map((c) => norm(c.cwd));
  const ownerOf = (f: string): string =>
    cwds.filter((c) => under(f, c)).sort((a, b) => b.length - a.length)[0] ?? '';
  const out: Array<{ from: VerifyCommand; narrowed: VerifyCommand }> = [];
  for (const c of commands) {
    const cwd = norm(c.cwd);
    const mine = files.filter((f) => under(f, cwd) && ownerOf(f) === cwd);
    if (mine.length === 0) continue;
    if (!c.filter) {
      out.push({ from: c, narrowed: { cmd: c.cmd, cwd: c.cwd } });
      continue;
    }
    const rel = mine.map((f) => (cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f));
    // Function replacement, not a string one: `String.replace` expands `$&`,
    // "$`" and `$'` INSIDE the replacement text, so a path containing them would
    // rewrite the command.
    const joined = rel.map(shellQuote).join(' ');
    out.push({ from: c, narrowed: { cmd: c.filter.replace('{files}', () => joined), cwd: c.cwd } });
  }
  return out;
}

/** One recorded subset run — journaled so the verdict can be audited after the fact. */
export interface ProbeRun {
  target: string;
  files: string[];
  usable: boolean;
  failing: string[];
  /** The run failed but named no file — unusable, and worth seeing in the journal. */
  unparseable?: boolean;
}

/**
 * A `SubsetProbe` bound to this pass: runs the failing checks, narrowed to the
 * files in question, against the case worktree or any committed tree.
 *
 * ONE temp worktree is created lazily and reset between probes (the same shape
 * `firstRedParticipant` uses) — a bisect can ask for a dozen trees and creating
 * a worktree each time is the expensive part.
 *
 * DEPENDENCIES ARE PER TREE, installed into the worktree from the manifests that
 * tree carries (`installDeps`). A tree whose dependencies will not install is
 * UNUSABLE, never green — an environment we cannot trust must be skipped rather
 * than believed, which is the whole admissibility rule this probe enforces.
 */
function makeSubsetProbe(
  cli: Cli,
  commands: VerifyCommand[],
  runChecks: ChecksRunner,
  caseWorktree: string,
  runInstall?: InstallRunner,
  opts: {
    /**
     * Narrow each run to the files in question (`VerifyCommand.filter`). OFF for
     * the ADJUDICATION and ownership probes: the gate's own counts come from the
     * FULL command, and comparing a full-suite count against a narrowed one
     * compares two different populations — the difference decides the verdict.
     * A deadline-bound test can fail only under whole-suite load and pass in
     * milliseconds on its own, so a narrowed baseline would call exactly the
     * failure this exists for `flaky` and never `pre-existing`.
     *
     * ON for the BISECT, where every probe is narrowed on BOTH sides of the
     * comparison and the tip-determinism gate rejects anything that does not
     * reproduce under that same narrowing.
     */
    narrow?: boolean;
  } = {},
): { probe: SubsetProbe; runs: ProbeRun[]; dispose: () => Promise<void> } {
  const runs: ProbeRun[] = [];
  let wt: { path: string; remove: () => Promise<void> } | null = null;
  /** The case worktree is installed ONCE: unlike a commit target, it never changes here. */
  let caseWorktreeInstalled = false;
  const probe: SubsetProbe = async (target, files) => {
    const cmds = opts.narrow ? subsetCommands(commands, files) : commands;
    const empty = { usable: false, counts: new Map<string, number>(), output: '' };
    if (cmds.length === 0 || files.length === 0) {
      runs.push({ target: target.kind === 'worktree' ? 'worktree' : target.sha.slice(0, 12), files, usable: false, failing: [] });
      return empty;
    }
    let baseDir: string;
    if (target.kind === 'worktree') {
      // BOTH SIDES OF THE COMPARISON ARE THE SAME KIND OF TREE. Every commit
      // target below is installed before it is measured; taking the case
      // worktree as it stands measures a dependency-FULL baseline against a
      // dependency-LESS case tree, and every environment red in the case tree
      // then reads as "caused by the case" — which is a whole suite blamed on a
      // resolution that touched three files.
      if (!caseWorktreeInstalled) {
        if (!(await installDeps(cli, caseWorktree, runInstall)).ok) {
          runs.push({ target: 'worktree', files, usable: false, failing: [] });
          return empty;
        }
        caseWorktreeInstalled = true;
      }
      baseDir = caseWorktree;
    } else {
      try {
        if (!wt) {
          wt = await addTempWorktree(cli.repo, target.sha);
        } else {
          await git(cli.repo, ['reset', '--hard', target.sha], { cwd: wt.path });
          // `reset --hard` leaves UNTRACKED files behind, so a previous probe's
          // build output, coverage or generated fixtures would still be sitting
          // in the tree when the next commit is checked out — and could decide
          // its result. The dep links are re-created right after, so exclude them.
          await git(cli.repo, ['clean', '-fdx', ...WORKTREE_DEP_LINKS.flatMap((rel) => ['-e', rel])], {
            cwd: wt.path,
            allowCodes: [1, 128],
          });
          for (const rel of WORKTREE_DEP_LINKS) rmSync(join(wt.path, rel), { recursive: true, force: true });
        }
        if (!(await installDeps(cli, wt.path, runInstall)).ok) {
          runs.push({ target: target.sha.slice(0, 12), files, usable: false, failing: [] });
          return empty;
        }
      } catch {
        runs.push({ target: target.sha.slice(0, 12), files, usable: false, failing: [] });
        return empty;
      }
      baseDir = wt.path;
    }
    const r = await runChecks(cmds, baseDir);
    const counts = countFailingFiles(rootChecksOutput(r.output, cmds));
    const label = target.kind === 'worktree' ? 'worktree' : target.sha.slice(0, 12);
    // A command that FAILED but named no file is UNINTERPRETABLE, and reading it
    // as "no failures" reads a red tree as green — the one thing rule 3 forbids.
    // Two real shapes: `vitest run <path that matches nothing>` exits 1 with "No
    // test files found", and a bun module-load error prints `1 fail` with no
    // `(fail)` line at all. Either would have made a failing baseline look clean
    // and refused a true claim, or made a failing tip look like a bisect anchor.
    if (!r.ok && counts.size === 0) {
      runs.push({ target: label, files, usable: false, failing: [], unparseable: true });
      return { usable: false, counts, output: r.output };
    }
    runs.push({ target: label, files, usable: true, failing: [...counts.keys()] });
    return { usable: true, counts, output: r.output };
  };
  return {
    probe,
    runs,
    dispose: async () => {
      if (wt) await wt.remove().catch(() => undefined);
      wt = null;
    },
  };
}

/** `History` over the real clone, for `findIntroducingCommit`. */
function repoHistory(repo: string): History {
  return {
    ancestor: async (ref, back) => {
      const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}~${back}^{commit}`], { allowCodes: [1, 128] });
      return r.code === 0 ? r.stdout.trim() : null;
    },
    listFirstParent: async (from, to) => {
      const r = await git(repo, ['rev-list', '--first-parent', '--reverse', `${from}..${to}`], { allowCodes: [128] });
      return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    },
    hasAnyFile: async (sha, files) => {
      for (const f of files) {
        const r = await git(repo, ['cat-file', '-e', `${sha}:${f}`], { allowCodes: [1, 128] });
        if (r.code === 0) return true;
      }
      return false;
    },
    contains: async (sha, ancestor) =>
      (await git(repo, ['merge-base', '--is-ancestor', ancestor, sha], { allowCodes: [1, 128] })).code === 0,
  };
}

/**
 * How many `checks-fail` rows a case has accumulated since its most recent
 * `checks-pass` (a pass resets the count) — else from the case's start. Shared by
 * typecheck AND test failures; drives the CHECKS_FAIL_LIMIT force-HELD backstop.
 * Independent of the cold-read reject/cap counters.
 */
function checksFailCount(journal: JournalEntry[], caseId: string): number {
  let count = 0;
  for (const e of journal) {
    if (e.caseId !== caseId) continue;
    if (e.action === 'checks-pass') count = 0;
    else if (e.action === 'checks-fail') count++;
  }
  return count;
}

/**
 * The files the case's LAST failure of this kind named, since its last
 * `checks-pass` — the set a re-run may narrow to.
 *
 * Per KIND, always. The narrowing assigns files to commands by cwd, so feeding
 * typecheck's failing source files to the test list would re-run
 * `pnpm test src/x.ts` — a path matching no test file, which exits non-zero with
 * "No test files found" and reads as a red that nothing in the tree caused.
 *
 * The MOST RECENT row only. A row that named nothing (an unparseable runner)
 * yields nothing, and the caller then runs the full list — the older row's files
 * describe a tree two edits ago and re-running them would answer a question
 * nobody asked.
 */
function priorFailingFiles(journal: JournalEntry[], caseId: string, kind: string): string[] {
  let files: string[] = [];
  for (const e of journal) {
    if (e.caseId !== caseId) continue;
    if (e.action === 'checks-pass') files = [];
    else if (e.action === 'checks-fail' && e.kind === kind) {
      files = Array.isArray(e.files) ? (e.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    }
  }
  return files;
}

/** One checks run for the gate, with what it cost and what it is allowed to say. */
interface GatedChecksRun {
  /** The verdict the gate acts on. An `ok` here can only have come from a FULL run. */
  result: ChecksRunResult;
  /** The commands `result.output` came from — blame re-roots by their cwd. */
  used: VerifyCommand[];
  /** The narrow probe, when one ran. */
  narrow?: { files: string[]; red: boolean };
}

/**
 * Run one checks list, re-running the PREVIOUSLY FAILING FILES first.
 *
 * Cost, and only cost. On attempts 2+ the overwhelmingly likely outcome is that
 * the same files still fail, and proving that costs one test file instead of a
 * whole suite; the full suite is then never run for a negative it already knows.
 * A red narrow run is a complete negative — the check IS failing — so it is
 * reported exactly as a full red would be.
 *
 * A GREEN NARROW RUN PROVES NOTHING and may not end the gate: the fix could have
 * broken a file the narrowing dropped, and closing a case on the subset that was
 * already suspect is how a regression ships. So green means "now pay for the
 * full list", in this same invocation.
 *
 * That rule is STRUCTURAL, not conventional: the probe below returns a result
 * only on its `red` arm, so no expression in this function can carry a narrow
 * run's verdict into `ok` — the single full `runChecks` is the only source of
 * one. A command with no `filter` (a project typecheck cannot be narrowed
 * without dropping its tsconfig) runs whole either way; narrowing then only
 * drops the commands that own no failing file.
 */
async function runGatedChecks(
  runChecks: ChecksRunner,
  list: VerifyCommand[],
  baseDir: string,
  priorFiles: string[],
): Promise<GatedChecksRun> {
  const map = priorFiles.length > 0 ? subsetCommandMap(list, priorFiles) : [];
  const narrowed = map.map((m) => m.narrowed);
  const probe = async (): Promise<{ red: true; result: ChecksRunResult } | { red: false }> => {
    if (narrowed.length === 0) return { red: false };
    const r = await runChecks(narrowed, baseDir);
    return r.ok ? { red: false } : { red: true, result: r };
  };
  const p = await probe();
  if (p.red) {
    // Report the CONFIGURED command name, not the narrowed spelling. Which files
    // were re-run is a cost decision, recorded on the `checks-fail` row as
    // `narrowedTo`; the thing that FAILED is `bun test`, which is the name every
    // consumer downstream — journal, escalation text, adjudication — matches on.
    const byNarrowed = new Map(map.map((m) => [m.narrowed.cmd, m.from.cmd]));
    const failedNames = [...new Set(p.result.failedNames.map((n) => byNarrowed.get(n) ?? n))];
    return { result: { ...p.result, failedNames }, used: narrowed, narrow: { files: priorFiles, red: true } };
  }
  const result = await runChecks(list, baseDir);
  return { result, used: list, ...(narrowed.length > 0 ? { narrow: { files: priorFiles, red: false } } : {}) };
}

/** A case whose failure has outlived three distinct resolutions unchanged. */
interface DeadEndEvidence {
  /** The distinct trees, oldest first. */
  trees: string[];
  /** The fingerprint set they all share, sorted (`fingerprintKeys`). */
  fingerprints: string[];
}

/**
 * PROOF that the last `DEAD_END_ATTEMPTS` resolutions did not touch the failure.
 *
 * Both halves are required and neither is inferable from the other:
 *
 *   DIFFERENT TREES — the agent actually edited between attempts. Re-reporting
 *   the same tree fails identically by definition, and calling that a dead end
 *   would tell an agent that has not yet tried anything to stop trying.
 *
 *   IDENTICAL FINGERPRINTS — the same items failed the same way in the same
 *   places. Same FILES is not enough: a file that fails a different test, or the
 *   same test at a different line, is a failure that MOVED, which is exactly the
 *   sign the edits are reaching it.
 *
 * An empty fingerprint set is never evidence. It means the runner named nothing
 * the parser understands, so nothing was compared — and "we could not read the
 * output" must never be reported to the agent as "you are provably stuck".
 */
function deadEndEvidence(journal: JournalEntry[], caseId: string): DeadEndEvidence | null {
  let rows: JournalEntry[] = [];
  for (const e of journal) {
    if (e.caseId !== caseId) continue;
    if (e.action === 'checks-pass') rows = [];
    else if (e.action === 'checks-fail') rows.push(e);
  }
  const last = rows.slice(-DEAD_END_ATTEMPTS);
  if (last.length < DEAD_END_ATTEMPTS) return null;
  const trees = last.map((e) => (typeof e.resolvedTree === 'string' ? e.resolvedTree : ''));
  if (trees.some((t) => t === '') || new Set(trees).size !== trees.length) return null;
  const sets = last.map((e) =>
    Array.isArray(e.fingerprints) ? (e.fingerprints as unknown[]).filter((f): f is string => typeof f === 'string') : [],
  );
  if (sets.some((s) => s.length === 0)) return null;
  // Journaled sorted and de-duplicated, so string equality IS set equality.
  const first = sets[0].join('\n');
  if (!sets.every((s) => s.join('\n') === first)) return null;
  return { trees, fingerprints: sets[0] };
}

/**
 * The dead end in words, for the agent that has to decide what to do about it.
 *
 * It states the fact and stops. No instruction to claim held, no tier, no
 * verdict on whether the case is fixable — the driver knows the failure did not
 * move and nothing else, and an agent told "give up" on evidence that only
 * supports "look elsewhere" would abandon cases it could still close.
 */
function deadEndNote(ev: DeadEndEvidence): string {
  const named = ev.fingerprints.slice(0, DEAD_END_NAMED).map(describeFingerprint).join('; ');
  const more = ev.fingerprints.length > DEAD_END_NAMED ? ` (+${ev.fingerprints.length - DEAD_END_NAMED} more)` : '';
  return (
    ` Your last ${ev.trees.length} resolutions were different trees but ${named}${more}. ` +
    `Nothing you changed affected it — the cause is somewhere you have not looked, or it cannot be fixed within this case.`
  );
}

/** A HELD escalation carried from freeze to publish: prefix tag + the
 * cold reviewer's short feedback, prepended to the PR description. */
interface HeldEscalation {
  tag: string;
  feedback: string | null;
}

/** Bounded reviewer feedback out of a verdict-ish object. */
function boundedFeedback(v: { feedback?: unknown }): string | null {
  return typeof v.feedback === 'string' && v.feedback.trim() !== ''
    ? v.feedback.trim().slice(0, COLDREAD_FEEDBACK_CAP)
    : null;
}

/**
 * Cold-read REJECTIONS of the RESOLUTION journaled for a case (fail-closed
 * UNVERIFIABLE counts). EVERY reject counts toward COLDREAD_REJECT_LIMIT.
 *
 * There is NO `defect: 'description'` exclusion. The cold read
 * is the single gate at `report-case`, where no PR prose exists yet — the
 * reader is never shown a description and never asked to classify one. Such an
 * exclusion would mean a stray `"defect":"description"` in the reader's JSON
 * silently un-counts a real resolution reject: the case would never reach the
 * 2× HELD escalation, and re-reporting an UNCHANGED tree records no new
 * report-attempt either, so the convergence cap would not catch it — an
 * unbounded revise loop. Count them all.
 */
function coldReadRejectionCount(journal: JournalEntry[], caseId: string): number {
  return journal.filter((e) => e.action === 'coldread' && e.caseId === caseId && e.rejected === true).length;
}

/**
 * The CLEAN-PREFIX tree: the automerge tree
 * with every conflicted path reset to its `baseTip` (ours) blob — i.e. all of
 * the merge that landed cleanly, and NONE of the conflict. Committing THIS as
 * the case worktree's HEAD (see `createCaseWorktree`) makes the conflicted paths
 * the ONLY pending change in the worktree: `git status` = exactly the conflict,
 * so the agent reviews only the conflicting delta, never a many-hundred-file
 * accumulated merge (the per-case context blowup).
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
 * Driver-created resolution worktree (pending-diff shape): a
 * detached worktree at <passdir>/<caseid>/worktree whose HEAD is the CLEAN
 * PREFIX commit (all of the merge that landed cleanly — `cleanPrefixTree`),
 * parented on the branch tip; the conflicted paths are then written into the
 * WORKING TREE (unstaged) with their automerge (conflict-marker) content. The
 * result: `git status` shows ONLY the conflicted paths as pending, so the agent
 * resolves just that delta — not the whole accumulated merge (commit all before
 * the conflict; the agent reviews ONLY the
 * pending files). The on-disk bytes and the `add -A; write-tree` snapshot are
 * IDENTICAL to a full automerge-tree checkout (prefix == automerge outside the
 * conflict; the conflicted files are overwritten back to automerge content), so
 * the empty-resolution check, scope guard and cold-read diff (all vs
 * `automergeTree`) are unaffected — only what is committed vs pending changes.
 * Best-effort — on failure journal a warning and continue (the case is still
 * resolvable via an agent-made worktree).
 *
 * Reissue: `contentSource` overrides WHERE the pending files' on-disk
 * content comes from (default: the automerge tree — the fresh conflict with
 * markers). A REISSUE case passes the origin fix/sweep ref head so the agent
 * edits the PRIOR RESOLUTION (revises it per the owner's PR comments) instead
 * of re-resolving the raw conflict. Everything else (prefix HEAD, pending
 * status, snapshot/scope-guard vs automergeTree) is identical.
 */
/**
 * The dependency trees a case worktree needs for the checks gate. Relative
 * to the clone root; each is linked only when the clone actually has it.
 */
const WORKTREE_DEP_LINKS = ['node_modules', 'container/agent-runner/node_modules'];

/**
 * Make paths invisible to `git add -A`, via `$GIT_COMMON_DIR/info/exclude` —
 * NOT a `.gitignore` edit (that would be committed and leak into every PR).
 * `info/exclude` is repo-local and never committed.
 *
 * Must be the COMMON dir: git reads `info/exclude` from the shared `.git`, NOT
 * from a linked worktree's private `.git/worktrees/<id>/` (writing there has no
 * effect and `git status` still lists the links as untracked).
 * Patterns are anchored (`/path`), so they apply at the top level of the clone
 * and of every worktree alike.
 *
 * This exists because `.gitignore` DOES NOT COVER THE DEP LINKS: the repo
 * ignores `node_modules/` — with a trailing slash, which
 * matches DIRECTORIES ONLY — while git records a symlink as mode 120000, a FILE.
 * `git add -A` would therefore stage the links into every resolved tree.
 * Slash-free patterns here match a path of ANY type.
 */
async function excludeInWorktree(repo: string, wtPath: string, patterns: string[]): Promise<void> {
  const gitDir = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: wtPath })).stdout.trim();
  if (!gitDir) return;
  const infoDir = join(gitDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const file = join(infoDir, 'exclude');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split('\n').map((l) => l.trim()));
  const add = patterns.map((p) => `/${p}`).filter((p) => !lines.has(p));
  if (add.length === 0) return;
  writeFileSync(file, (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + add.join('\n') + '\n');
}

/**
 * Install the tree's dependencies INTO THE WORKTREE, from the manifests that are
 * in that worktree. Returns false when no valid environment could be produced.
 *
 * NO shared dependency pool, and no symlink to the clone's `node_modules`.
 * Linking the clone's tree typechecks a branch that declares its own package
 * against the wrong dependency tree — `TS2307 Cannot find module`, an
 * environment gap read as a code defect that mints a gate-fix case blaming the
 * branch; and the clone's tree is mutable, so an install run mid-pass can flip
 * the SAME sha between red and green with no commit between. A pool is a
 * SHARED, CACHED, KEYED artifact, and each of those three properties is its own
 * failure class:
 *   - shared: one bad install (e.g. `--ignore-scripts` skipping native addon
 *     builds) breaks every tree linked to it at once;
 *   - keyed on the PRE-MERGE branch tip while the worktree holds the MERGED
 *     tree: a dependency the merge introduces is simply absent;
 *   - keyed on manifests alone: no fix can ever invalidate an existing pool —
 *     a poisoned one must be deleted by hand, and a node upgrade silently
 *     poisons it again with no code change at all.
 * Each such failure is reported to the sweep as a code failure and turns into
 * branch-targeted work. A pool is also exactly the LOCAL STATE this driver
 * forbids: it survives clean-slate by design, keyed by a value that cannot
 * change in response to the bug, and never self-heals.
 *
 * Installing into the worktree is correct BY CONSTRUCTION: the environment is a
 * function of the tree under test and nothing else, there is no cache to poison,
 * no key to invalidate, and no fallback that can silently restore the original
 * bug. Measured in the real agent image with a warm store (153 MB, hardlinked):
 * pnpm 3.5s cold / 2.4s repeat, bun 2s — about five seconds per worktree, which
 * is not worth a caching layer that costs correctness.
 *
 * The dep dirs are excluded from git FIRST: `.gitignore` does not cover them
 * (it ignores `node_modules/` WITH a trailing slash, which matches directories
 * only), and without the exclude they land in the resolved tree, the merge and
 * the PR.
 */
async function installDeps(cli: Cli, wtPath: string, runInstall?: InstallRunner): Promise<InstallResult> {
  await excludeInWorktree(cli.repo, wtPath, WORKTREE_DEP_LINKS);
  return (runInstall ?? cli.installRunner ?? defaultInstallRunner)(wtPath);
}

/**
 * How many characters of a failed install's output are kept.
 *
 * Enough for the package manager's error code and the sentence after it, which
 * is the whole of what anything downstream reads; a failing install can print
 * megabytes of resolution trace, and a journal is not a log file.
 */
const INSTALL_OUTPUT_TAIL = 2000;

/**
 * WHAT AN INSTALL FAILURE WAS.
 *
 * A bare "it failed" cannot be acted on: a manifest the resolution wrote badly
 * and a machine with no network are the same fact at that grain, and they have
 * opposite dispositions — one is the agent's to fix, the other is the owner's.
 * The package manager says which in its own output, so the output travels.
 */
export interface InstallFailure {
  /** The command as it was run. */
  command: string;
  /** Where it ran, relative to the worktree root (`.` at the root). */
  cwd: string;
  /** The tail of what it printed, bounded by `INSTALL_OUTPUT_TAIL`. */
  output: string;
}

/**
 * Runs the installs for a prepared worktree. Injectable so tests never spawn a
 * real pnpm/bun.
 *
 * There is no fallback: a tree whose dependencies could not be installed has NO
 * valid environment, and a check run in it is an inadmissible observation — not
 * evidence about the code. Falling back to the clone's `node_modules` is exactly
 * how an environment gap becomes a `TS2307` blamed on a branch.
 */
export type InstallResult = { ok: true } | { ok: false; failure: InstallFailure };
export type InstallRunner = (worktree: string) => Promise<InstallResult>;

const defaultInstallRunner: InstallRunner = async (dir) => {
  const run = async (command: string, cwd: string, rel: string): Promise<InstallResult> => {
    try {
      await promisify(execFile)('bash', ['-c', command], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        // corepack needs a writable HOME (it resolves the repo's
        // `packageManager` pin) and pnpm needs the shared store; both are
        // ambient in the container today, so state them rather than inherit
        // them by luck. Measured: without a writable HOME the install dies
        // `EACCES … /.cache/node/corepack`.
        env: { ...process.env, HOME: process.env.HOME || tmpdir() },
      });
      return { ok: true };
    } catch (e) {
      // stderr AND stdout: pnpm prints its error code on stderr, bun and the
      // native build steps print theirs on stdout, and a spawn failure that
      // never reached a shell has neither — only the error's own message. All
      // three are the same question ("what happened"), so all three are kept.
      const err = e as { stderr?: string; stdout?: string; message?: string };
      const text = `${err.stderr ?? ''}${err.stdout ?? ''}` || err.message || String(e);
      return { ok: false, failure: { command, cwd: rel, output: text.slice(-INSTALL_OUTPUT_TAIL) } };
    }
  };
  // NO `--ignore-scripts`: it skips the NATIVE BUILD, so `better-sqlite3` never
  // compiles its addon and every suite that opens a database fails at require
  // time. These are the fork's own lockfiles; the flag is untrusted-code defence
  // that buys nothing here and breaks the tree it is meant to protect.
  const root = await run('pnpm install --frozen-lockfile', dir, '.');
  if (!root.ok) return root;
  const ar = join(dir, 'container', 'agent-runner');
  if (existsSync(join(ar, 'package.json'))) {
    const runner = await run('bun install --frozen-lockfile', ar, 'container/agent-runner');
    if (!runner.ok) return runner;
  }
  return { ok: true };
};

/**
 * What a case-worktree preparation produced.
 *
 * A failure must never be reported as a normal return — a caller that resets a
 * worktree to the pristine conflict would then tell the agent "the worktree is
 * now pristine" and freeze a draft PR over a tree that still holds the agent's
 * discarded edits. The claim has to follow the outcome.
 */
export interface WorktreePrep {
  /** The worktree exists at the case path with its pending conflict in it. */
  ok: boolean;
  /**
   * The dependency install failed, and WHAT failed. Everything installed here
   * comes from COMMITTED, parseable manifests (the clean prefix), so the
   * failure is about the MACHINE and never about the conflict or a resolution.
   * A case served into a tree with no environment produces check results that
   * are not evidence about the code, so a caller that would SERVE this case
   * must refuse instead.
   */
  environment: InstallFailure | null;
}

/**
 * Prepare a case's resolution worktree. The body is best-effort against a tree
 * the host may not be able to remove (container uid), so a build failure
 * answers `{ok: false}` rather than throwing; a dependency-install failure
 * additionally answers `environment: true`, which is a different thing to do
 * something about.
 *
 * `install: false` is for the callers that RESET a worktree to the pristine
 * conflict on their way to freezing a held draft: they run no checks and hand
 * the tree back to nobody, so they need no environment — and paying for one
 * would let a broken machine turn a legal freeze into a case that cannot be
 * concluded at all.
 */
export async function createCaseWorktree(
  cli: Cli,
  dir: string,
  caseFile: CaseFile,
  baseTip: string,
  contentSource?: string,
  /** Injectable so tests never spawn a real pnpm/bun. */
  runInstall?: InstallRunner,
  opts: { install?: boolean } = {},
): Promise<WorktreePrep> {
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
    // Idempotent: a case RE-EMITTED after a reopen may leave a stale
    // worktree registration and/or dir at this path — `worktree add` then fails
    // with "missing but already registered" or "already exists", stranding the
    // case with no worktree. Clear both (registration via remove+prune, dir via
    // rm) before re-adding so re-emission always yields a fresh worktree.
    await git(cli.repo, ['worktree', 'remove', '--force', wtPath], { allowCodes: [1, 128] });
    await git(cli.repo, ['worktree', 'prune'], { allowCodes: [1, 128] });
    rmSync(wtPath, { recursive: true, force: true });
    await git(cli.repo, ['worktree', 'add', '--detach', wtPath, prefixCommit]);
    // INSTALL BEFORE THE CONFLICT IS WRITTEN. The worktree currently holds the
    // CLEAN-PREFIX tree, so every manifest in it is the base commit's own valid
    // blob. The loop below writes conflict-marker blobs into the conflicted
    // paths — and when `package.json` is one of them the manifest stops being
    // JSON, `pnpm install` dies on it, the `bun install` for
    // `container/agent-runner` never runs behind the short-circuit, and the
    // agent works a whole session in a tree with no `node_modules` at all: the
    // typecheck then cannot resolve `@types/bun` and reports a missing-types
    // error that belongs to the environment, not to the code.
    //
    // So the environment is built from the manifests that are PARSEABLE by
    // construction, and a failure here is about the machine rather than about
    // the conflict. The manifests the checks must run against are the RESOLVED
    // ones, which do not exist yet at this point: the gate re-installs in this
    // same worktree at `report-case` (§7.1), after the agent has resolved them.
    const install = (opts.install ?? true) ? await installDeps(cli, wtPath, runInstall) : ({ ok: true } as InstallResult);
    if (!install.ok) {
      const detail =
        `dependencies would not install into the case worktree at ${wtPath}, from the base commit's own ` +
        `committed manifests — the environment is broken, not the tree: \`${install.failure.command}\` ` +
        `(in ${install.failure.cwd}) failed with: ${install.failure.output.slice(-400)}`;
      appendJournal(dir, {
        action: 'environment-unusable',
        id: ERR_ENVIRONMENT_UNUSABLE,
        caseId: caseFile.id,
        branch: caseFile.branch,
        phase: 'case-worktree',
        path: wtPath,
        install: install.failure,
        detail,
      });
      console.error(`[${ERR_ENVIRONMENT_UNUSABLE}]: ${detail}`);
      return { ok: false, environment: install.failure };
    }
    // Materialize the conflicted paths as PENDING working-tree changes: write the
    // automerge (marker) blob to disk without staging, or delete the file when the
    // automerge tree dropped it (delete/modify conflict), so `git status` = exactly
    // the conflict. The index still holds the prefix (ours) version — hence pending.
    const source = contentSource ?? caseFile.automergeTree;
    // Carried paths are materialized the same way: they hold what the published
    // resolution left there, so the revision starts from the whole resolution
    // rather than from the part of it that still conflicts.
    for (const p of [...caseFile.conflictedPaths, ...(caseFile.carriedPaths ?? [])]) {
      const abs = join(wtPath, p);
      const blob = await git(cli.repo, ['cat-file', '-p', `${source}:${p}`], { allowCodes: [128] });
      if (blob.code === 0) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, blob.stdout);
      } else {
        rmSync(abs, { force: true });
      }
    }
    // Shared rerere: install the workspace rr-cache into the
    // shared .git so rerere-enabled operations in the case worktree see the
    // recorded resolutions. Best-effort, like the worktree itself.
    const seeded = await installRrCache(cli.repo, join(cli.workspace, RR_CACHE_DIRNAME));
    appendJournal(dir, {
      action: 'case-worktree',
      caseId: caseFile.id,
      path: wtPath,
      rerereSeeded: seeded,
      installed: opts.install ?? true,
      pendingPaths: [...caseFile.conflictedPaths, ...(caseFile.carriedPaths ?? [])],
      ...(contentSource ? { contentSource } : {}),
    });
    return { ok: true, environment: null };
  } catch (e) {
    appendJournal(dir, {
      action: 'warning',
      caseId: caseFile.id,
      message: `case worktree creation failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { ok: false, environment: null };
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
 * The single machine-readable guidance line for a state-machine command
 * (DRIVER.md §10.7), written to STDOUT with the exact prefix
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
  // A flag command run INTERNALLY by a state-machine command
  // (next-case→run, finish→verify/publish/push) produces no output — only the
  // outer command emits its single SWEEP-RESULT line.
  //
  // What the contract protects is that ONE STDOUT LINE, not the artifact. An
  // internal caller that passes an explicit `--out` is asking to READ the
  // result itself, and returning early would throw it away — `finish`'s held
  // escalation passes `out` to capture WHY a publish refused, and would read
  // `reason: unknown` if this line returned first. The file is written
  // silently — no `wrote ...` line — so the invariant is untouched.
  const json = JSON.stringify(artifact, null, 2);
  if (cli.internal) {
    if (cli.out) writeFileSync(cli.out, json + '\n');
    return;
  }
  if (cli.out) {
    writeFileSync(cli.out, json + '\n');
    console.log(`wrote ${cli.out}`);
  } else {
    console.log(json);
  }
}

/**
 * Observability: a MAJOR-STEP progress line for a running sweep, written to
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

/**
 * The substitute GitHub token for a networked write. The agent does not
 * manage a token file — the driver reads it from the environment (`GH_TOKEN`,
 * fallback `GITHUB_TOKEN`) at each networked write and never persists it. The
 * internal `--token-file` override (a file wins when present) lets the flag
 * CLI and tests pin a token explicitly, but the default is the env.
 * Absent from both → null (the caller returns `ERR11_TOKEN_MISSING`).
 */
function resolveGithubToken(cli: Cli): string | null {
  return resolveGithubTokenSourced(cli).token;
}

/**
 * The token PLUS where it came from. The driver picks a token up off
 * the ENVIRONMENT silently, so a rejected token is ambiguous: a revoked `GH_TOKEN`
 * and a stale ambient `GITHUB_TOKEN` that was never meant for this pass fail
 * identically. Every auth failure report names this source so the two are
 * distinguishable from the output alone (see `apiFailureIssue`).
 */
function resolveGithubTokenSourced(cli: Cli): { token: string | null; source: string } {
  if (cli.tokenFile && existsSync(cli.tokenFile)) {
    return { token: readFileSync(cli.tokenFile, 'utf8').trim() || null, source: `--token-file ${cli.tokenFile}` };
  }
  const gh = process.env.GH_TOKEN?.trim();
  if (gh) return { token: gh, source: '$GH_TOKEN' };
  const github = process.env.GITHUB_TOKEN?.trim();
  if (github) return { token: github, source: '$GITHUB_TOKEN' };
  return { token: null, source: 'unset' };
}

/**
 * The HTTP status a transport error carries. The transport throws
 * `Error('<METHOD> <path> -> HTTP <status>…')` (publish.ts), so the status is
 * recoverable from the message without changing the transport contract.
 */
function httpStatusOf(e: unknown): number | null {
  const m = /->\s*HTTP\s+(\d{3})/.exec(e instanceof Error ? e.message : String(e));
  return m ? Number(m[1]) : null;
}

/**
 * Classify a caught networked failure. A 401/403 is the TOKEN being REJECTED —
 * a distinct, actionable cause — not the generic `ERR13_API_FAILED` "retry once,
 * then report" case, which a retry with the same rejected token can never clear.
 * The detail names the token's SOURCE, so a stale ambient `$GITHUB_TOKEN` is
 * diagnosable from the failing output instead of looking like a revoked grant.
 */
function apiFailureIssue(cli: Cli, e: unknown, context?: string): { id: string; detail: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const detail = context ? `${context}: ${msg}` : msg;
  const status = httpStatusOf(e);
  if (status !== 401 && status !== 403) return { id: 'ERR13_API_FAILED', detail };
  const { source } = resolveGithubTokenSourced(cli);
  return {
    id: 'ERR41_TOKEN_REJECTED',
    detail: `${detail} — the GitHub token from ${source} was REJECTED (HTTP ${status}); a retry with the same token cannot clear this`,
  };
}

export async function cmdPlan(cli: Cli): Promise<number> {
  // Only `plan` opens a pass. The opening snapshot (plan-initial.json) is
  // immutable; the equivalence "halt loudly" check lives in `run`, not here —
  // a pass with journal activity legitimately derives differently now (§8).
  const ctx = await openPass(cli);
  const dir = ctx.dir;
  // Blocked state is journal-derived: `sweep start` reconstructs the
  // PR_ID set from origin and journals `origin-blocked` rows BEFORE plan runs;
  // there is no local reconcile step — origin is the authority.
  const journal = readJournal(dir);
  // Urges are only DETECTED here; posting is `push`'s job (§14.4).
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

  // Candidate discovery (§13): candidates are DERIVED FRESH
  // from git every pass — no cross-pass store, no report throttle; a candidate
  // is reported every pass until the owner acts in config (an inventory entry
  // or a scope exclusion). candidates.json + the journal `candidate` rows are
  // pass-dir artifacts. Candidates are never planned or merged; the printed
  // section is the agent's relay duty to the owner (doctrine).
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
  for (const record of candidateRecords) {
    appendJournal(dir, {
      action: 'candidate',
      event: 'discovered',
      branch: record.branch,
      tip: record.tip,
      confidence: record.confidence,
    });
  }
  writeJsonFile(join(dir, 'candidates.json'), {
    schemaVersion: 1,
    watermark12: ctx.watermark12,
    candidates: candidateRecords,
    standingInstruction: CANDIDATE_STANDING_INSTRUCTION,
  });
  for (const line of candidateSectionLines(candidateRecords)) console.error(line);

  emit(cli, plan);
  return 0;
}

/**
 * The verdict of the LANDING GATE on one branch (DRIVER.md §7.6).
 *
 * `skipped` is "no verdict was owed": nothing landed, the tree was already
 * measured this pass, or no checks are configured. `unmeasured` is "a verdict
 * was owed and could not be taken" — no environment, so the tree was never
 * run — and it is never read as green. `flaky` is "the verdict changed on the
 * identical tree": no green, no accusation, and the tree is still owed one.
 */
type LandingVerdict =
  | { kind: 'skipped' }
  | { kind: 'green' }
  | { kind: 'unmeasured' }
  | { kind: 'red'; output: string; failed: VerifyCommand[]; failedNames: string[]; tree: string; sha: string }
  | { kind: 'flaky'; tree: string; failedNames: string[]; flaky: string[]; detail: string };

/**
 * Every (subtree, command) this pass measured GREEN → the branch it ran on.
 *
 * Keyed on the subtree the command runs in, so a branch that shares another's
 * `container/agent-runner` subtree inherits its `bun test` verdict and pays for
 * nothing, while still paying for the commands whose subtrees it does not
 * share. Rows are written by every gate that runs the configured commands.
 */
function greenChecks(journal: JournalEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of journal) {
    if (e.action !== 'landing-check' && e.action !== 'branch-check') continue;
    if (!Array.isArray(e.checks) || typeof e.branch !== 'string') continue;
    for (const c of e.checks as Array<{ cmd?: unknown; subtree?: unknown; ok?: unknown }>) {
      if (c.ok !== true || typeof c.cmd !== 'string' || typeof c.subtree !== 'string') continue;
      const k = checkKey(c.subtree, c.cmd);
      if (!out.has(k)) out.set(k, e.branch);
    }
  }
  return out;
}

/** Trees whose landing verdict CHANGED on the identical tree — measured, and still unanswered. */
function unstableTrees(journal: JournalEntry[]): Set<string> {
  return new Set(
    journal.filter((e) => e.action === 'landing-check' && e.unstable === true && typeof e.tree === 'string').map((e) => e.tree as string),
  );
}

/**
 * Trees this pass measured CONFIRMED RED and minted NOTHING for.
 *
 * A red landing that could not be handed to a branch leaves the tree in exactly
 * the position an UNSTABLE one leaves it: never green, nothing minted, the branch
 * did not arrive. The merge, however, already happened — so on the next call the
 * tree has not MOVED, and the no-op skip would pass it over as "nothing arrived
 * that was not already there". It would then land `no-op -> arrived` and hand its
 * content down measured by nothing, which is the one thing the landing gate
 * exists to prevent. So the tree stays OWED a verdict and is measured again.
 *
 * A tree whose branch took a gate fix AFTER the red is not owed: that fix is what
 * moves it, and re-running the suite for a red the pass has already acted on buys
 * a known answer at full price. A fix minted BEFORE the red answers some other
 * failure on the same branch and is no answer to this one.
 */
export function owedRedTrees(journal: JournalEntry[]): Set<string> {
  /** The last landing-check that produced a VERDICT for each tree; skips carry none. */
  const last = new Map<string, { ok: boolean; confirmed: boolean; branch: string; at: number }>();
  journal.forEach((e, i) => {
    if (e.action !== 'landing-check' || typeof e.tree !== 'string' || typeof e.ok !== 'boolean') return;
    last.set(e.tree, {
      ok: e.ok,
      confirmed: e.confirmed === true,
      branch: typeof e.branch === 'string' ? e.branch : '',
      at: i,
    });
  });
  /** Where in the pass each branch's gate fixes were minted. */
  const mintedAt = new Map<string, number[]>();
  journal.forEach((e, i) => {
    if (e.action !== 'gate-fix' && !(e.action === 'case' && e.gateFix === true)) return;
    if (typeof e.branch !== 'string') return;
    mintedAt.set(e.branch, [...(mintedAt.get(e.branch) ?? []), i]);
  });
  const out = new Set<string>();
  for (const [tree, v] of last) {
    if (v.ok || !v.confirmed) continue;
    // POSITIONAL, not merely per-branch: an exemption earned earlier in the pass
    // would let a LATER refused red skip its re-measurement and arrive `no-op ->
    // arrived` unmeasured — the exact hole this set exists to close.
    if ((mintedAt.get(v.branch) ?? []).some((at) => at > v.at)) continue;
    out.add(tree);
  }
  return out;
}

/** A journaled red confirmation: what the re-run said, and where it was taken. */
interface RedConfirmRecord {
  reproduced: boolean;
  /**
   * The re-run could not be TAKEN at all — the environment refused, so nothing
   * was observed. `reproduced: false` alone cannot say this, and reading it as
   * "it passed" turns a missing measurement into an accusation of flakiness.
   */
  unmeasurable: boolean;
  /** The branch whose tree was standing when the command ran. */
  branch: string;
}

/**
 * The reds this pass has already RE-RUN, keyed by (subtree, command), and what
 * the re-run said.
 *
 * A confirmed red is a settled fact about a SUBTREE, so every later path that
 * would accuse on the same (subtree, command) reads it here instead of paying
 * for the same suite again — including a path standing on a different branch
 * that carries the identical subtree. An UNSTABLE one is not settled and is
 * deliberately not reusable as a measurement: it records that the driver may
 * not mint on that observation, never that the subtree is red.
 *
 * The BRANCH the run was taken on is part of the record. Sharing a verdict
 * spares a second measurement; it does not make the red an observation ABOUT
 * the second branch, and a case says "this branch is red".
 */
function redConfirmations(journal: JournalEntry[]): Map<string, RedConfirmRecord> {
  const out = new Map<string, RedConfirmRecord>();
  for (const e of journal) {
    if (e.action !== 'red-confirm' || typeof e.subtree !== 'string' || typeof e.cmd !== 'string') continue;
    // LAST WRITE WINS. An unstable subtree is re-measured on a later call, and
    // that run is the current fact about it: reading the first row instead would
    // pin the pass to the contradicted observation and refuse every later mint.
    out.set(checkKey(e.subtree, e.cmd), {
      reproduced: e.reproduced === true,
      unmeasurable: e.unmeasurable === true,
      branch: typeof e.branch === 'string' ? e.branch : '',
    });
  }
  return out;
}

/** Whether a red observation may found a case on the branch it would be rooted on. */
export type RedObservationVerdict =
  | { usable: true; observed: CheckVerdict[] }
  | {
      usable: false;
      /** Which finding this is, so the agent is told what it is looking at. */
      id: 'WARN21_CHECKS_FLAKY' | 'WARN22_RED_UNCONFIRMED';
      /** One sentence per command that may not found a case, and why. */
      reasons: string[];
      observed: CheckVerdict[];
    };

/**
 * MAY THIS RED FOUND A CASE ON THIS BRANCH? A journal read and a git read —
 * nothing is measured, nothing is journaled, nothing is decided elsewhere.
 *
 * The answer is PURE because it has to be asked BEFORE anything irreversible
 * happens. A caller that destroys the agent's resolution and then discovers the
 * mint refuses has thrown work away for a case it never created; asking first
 * costs a journal read.
 *
 * TWO THINGS ARE CHECKED, per failing command:
 *  - the SUBTREE the command runs in AT THE ROOTED BRANCH is the one the
 *    confirmation is about. `bun test` in `container/agent-runner` says nothing
 *    about `src/`, so a confirmation for another command's subtree authorises
 *    nothing here;
 *  - the confirming run was taken ON THE ROOTED BRANCH. A branch that shares the
 *    subtree shares the VERDICT — it is the same bytes and it is not measured
 *    again — but a case says "this branch is red", and where two branches carry
 *    the identical subtree nothing distinguishes them: no branch introduced the
 *    failure and none of them can be handed the fix. That red blocks both and is
 *    REPORTED; it accuses neither.
 *
 * TWO DIFFERENT FINDINGS, TWO IDS. A check that gave both answers is UNSTABLE
 * and the instability is the news; a red nobody confirmed here is simply
 * UNCONFIRMED — the check may be perfectly stable and the branch perfectly red,
 * and what is missing is a measurement, not a fix. Reporting the second as
 * flakiness sends the agent hunting an instability that was never observed.
 */
export async function redObservationUsable(
  journal: JournalEntry[],
  repo: string,
  rootedOn: string,
  at: string,
  commands: VerifyCommand[],
  opts?: {
    /**
     * The caller has PROVEN by AUTHORSHIP that `rootedOn` is the ceiling for the
     * failing files — the shallowest branch that wrote them.
     *
     * A confirmation is keyed by the SUBTREE the command ran in, and the branch
     * match exists because two branches carrying identical bytes are
     * indistinguishable by the run alone: neither introduced the failure and
     * neither can be handed the fix. Authorship is what distinguishes them. Once
     * it names one of them as the level that wrote the failing content, the
     * identical bytes carry the verdict there and the fix reaches every red
     * beneath it.
     *
     * WITHOUT that proof the backstop is unchanged, so WARN22 keeps its meaning
     * for every un-attributed caller.
     */
    attributedCeiling?: boolean;
  },
): Promise<RedObservationVerdict> {
  const confirmations = redConfirmations(journal);
  const observed = await checkVerdictKeys(repo, at, commands);
  const unusable = observed
    .map((v) => ({ v, rec: confirmations.get(checkKey(v.subtree, v.cmd)) }))
    .filter(({ rec }) => rec?.reproduced !== true || (!opts?.attributedCeiling && rec.branch !== rootedOn));
  if (unusable.length === 0) return { usable: true, observed };
  const why = ({ v, rec }: (typeof unusable)[number]): string => {
    const where = v.cwd ? `${v.cwd} (${v.subtree.slice(0, 12)})` : `the tree ${v.subtree.slice(0, 12)}`;
    if (rec === undefined) return `${v.cmd} was never re-run on ${where}`;
    if (rec.unmeasurable) return `${v.cmd} could not be RE-RUN on ${where} — the observation was never taken`;
    if (!rec.reproduced) return `${v.cmd} failed and then PASSED on a re-run of ${where}`;
    return (
      `${v.cmd} was confirmed red on ${where} by a run on ${rec.branch}, not on ${rootedOn} — ` +
      `the two carry the identical subtree, so nothing there distinguishes them`
    );
  };
  return {
    usable: false,
    // A run that could not be TAKEN is not an instability: nothing gave two
    // answers, so the finding is a missing measurement.
    id: unusable.some(({ rec }) => rec?.reproduced === false && !rec.unmeasurable) ? 'WARN21_CHECKS_FLAKY' : 'WARN22_RED_UNCONFIRMED',
    reasons: unusable.map(why),
    observed,
  };
}

/** The one sentence a refused red is reported with, wherever it is refused. */
export function redRefusalDetail(reasons: string[]): string {
  return `${reasons.join('; ')} — nothing is blamed and nothing is minted`;
}

/** What a second run of the failing commands, on the identical tree, said. */
interface RedConfirmation {
  /** Every command that failed failed AGAIN — the observation may found a case. */
  reproduced: boolean;
  /** Commands that failed and then PASSED with nothing changed between. */
  flaky: string[];
  /** The re-run itself could not be taken, so there is no second observation at all. */
  unmeasurable?: { detail: string };
  detail: string;
}

/**
 * A CONFIRMING RE-RUN MUST VARY SOMETHING, so it is taken in a SECOND,
 * INDEPENDENTLY PREPARED WORKTREE at the same commit.
 *
 * Two runs back to back in one worktree can only detect randomness: they share
 * the moment, the machine's load, the filesystem and the installed dependency
 * tree, so a failure that depends on any of those reproduces exactly and the
 * probe stamps it confirmed. What the driver CAN vary, and does here, is the
 * environment: a fresh checkout at the same sha, its own dependency install from
 * that tree's manifests, and the elapsed time that preparation takes — during
 * which the driver does nothing else, since it runs one command at a time.
 *
 * WHAT IT DOES NOT CLAIM, and must not: the container is shared with whatever
 * else is running in it, so this cannot isolate LOAD. `loadIsolated: false` is
 * journaled with the variation, and a reader must not read a confirmation as
 * "reproduced independently of load" — only as "reproduced in a second
 * environment, prepared separately, N ms later".
 *
 * A re-run that cannot be PREPARED (the worktree or its install fails) yields no
 * second observation at all, which is exactly what may not found a case.
 */
async function variedRerun(
  cli: Cli,
  sha: string,
  commands: VerifyCommand[],
  runChecks: ChecksRunner,
  runInstall?: InstallRunner,
): Promise<RerunOutcome> {
  const wt = await addTempWorktree(cli.repo, sha);
  try {
    const install = await installDeps(cli, wt.path, runInstall);
    if (!install.ok) {
      return {
        unprepared:
          `a second, independently prepared worktree could not be built at ${sha.slice(0, 12)}: ` +
          `\`${install.failure.command}\` failed with: ${install.failure.output.slice(-200)}`,
      };
    }
    const startedAt = Date.now();
    return { result: await runChecks(commands, wt.path), startedAt, worktree: wt.path };
  } finally {
    await wt.remove();
  }
}

/** What a confirming re-run produced, or why it could not be taken at all. */
type RerunOutcome =
  | { result: ChecksRunResult; startedAt: number; worktree: string }
  | { unprepared: string };

/**
 * A SINGLE RED OBSERVATION MAY NOT FOUND A CASE — re-run it on the identical
 * subtree, in a separately prepared environment, first.
 *
 * The driver's probes run in a container that is simultaneously installing
 * worktrees, merging and running other suites, so its own
 * `REPRODUCTION: FULL SUITE ONLY` class — order-, load- and timing-dependent,
 * the shape where an orphaned poller outlives the test that spawned it — comes
 * back red here and green on a quiet machine. Acting on the first sample mints a
 * case against an innocent branch, opens a held PR for it, and reports a
 * reproduction at a commit that is green on repeat. Identical input, different
 * verdict: the only thing that can be concluded is that the check is unstable.
 *
 * PAID ONCE, NOT ONCE PER PATH AND NOT ONCE PER BRANCH. The landing gate, blame
 * and the ownership probe can all reach the same (subtree, command); the first
 * to re-run journals the answer and the rest read it, wherever they are
 * standing. Greens are never re-run — only a red that is about to accuse
 * somebody.
 *
 * ONLY THE FAILING COMMANDS ARE RE-RUN. They are the whole of the accusation,
 * and re-running the green ones would pay for the part of the suite that is not
 * in question.
 */
async function confirmRed(
  dir: string,
  args: {
    branch: string;
    sha: string;
    phase: string;
    /** The commands that failed, WITH the subtree each of them ran in. */
    failed: CheckVerdict[];
    /** Re-run the FAILED commands on the identical tree, in a fresh environment. */
    rerun: (commands: CheckVerdict[]) => Promise<RerunOutcome>;
  },
): Promise<RedConfirmation> {
  const { branch, sha, phase, failed } = args;
  const observedAt = Date.now();
  const known = redConfirmations(readJournal(dir));
  // THE ROW BELONGS TO THE BRANCH THAT MEASURED IT, which is not always the one
  // asking. A re-statement journaled under the asker would move the verdict onto
  // it — last write wins — so whichever branch happened to ask LAST would become
  // the one the red was confirmed on, and the refusal would depend on the order
  // the pass walked its branches rather than on where anything was measured.
  const journalOne = (v: CheckVerdict, rest: Record<string, unknown>, on: string = branch): void =>
    appendJournal(dir, {
      action: 'red-confirm',
      branch: on,
      sha,
      phase,
      cmd: v.cmd,
      ...(v.cwd ? { cwd: v.cwd } : {}),
      subtree: v.subtree,
      // The command list, for a reader scanning one row: a confirmation covers
      // exactly one command, and naming it twice costs nothing.
      commands: [v.cmd],
      ...rest,
    });
  // ALREADY SETTLED, PER COMMAND. A command whose (subtree, command) the pass has
  // confirmed is not re-run — on this branch or any other carrying that subtree.
  const settled = failed.filter((v) => known.get(checkKey(v.subtree, v.cmd))?.reproduced === true);
  const owed = failed.filter((v) => !settled.includes(v));
  for (const v of settled)
    journalOne(
      v,
      { ran: false, reason: 'confirmed-this-pass', reproduced: true },
      known.get(checkKey(v.subtree, v.cmd))!.branch,
    );
  if (owed.length === 0) {
    const names = settled.map((v) => v.cmd);
    return { reproduced: true, flaky: [], detail: `${names.join(', ')} were already confirmed red on this subtree` };
  }
  const rerun = await args.rerun(owed);
  if ('unprepared' in rerun) {
    const detail = `the confirming re-run could not be taken: ${rerun.unprepared}`;
    for (const v of owed) journalOne(v, { ran: false, reproduced: false, unmeasurable: true, detail });
    return { reproduced: false, flaky: [], unmeasurable: { detail }, detail };
  }
  const again = rerun.result;
  if (again.environmentFault) {
    const detail = `the confirming re-run could not be taken: ${again.environmentFault.detail}`;
    for (const v of owed) journalOne(v, { ran: true, reproduced: false, unmeasurable: true, detail });
    return { reproduced: false, flaky: [], unmeasurable: { detail }, detail };
  }
  // WHAT WAS VARIED, stated in the row rather than implied by it. A reader
  // deciding whether to believe a confirmation needs to know which of the two
  // runs' conditions differed — and which did not.
  const variation = {
    freshWorktree: rerun.worktree,
    freshInstall: true,
    separatedMs: Math.max(0, rerun.startedAt - observedAt),
    /** The container is shared; nothing here can quiet it. */
    loadIsolated: false,
  };
  const flaky = owed.filter((v) => !again.failedNames.includes(v.cmd));
  for (const v of owed) {
    const changed = flaky.includes(v);
    journalOne(v, {
      ran: true,
      variation,
      reproduced: !changed,
      ...(changed ? { flaky: [v.cmd] } : {}),
      detail: changed
        ? `${v.cmd} FAILED and then PASSED on the identical subtree ${v.subtree.slice(0, 12)} — the code did not ` +
          `change between the two runs, so the failure is non-deterministic and belongs to no branch`
        : `${v.cmd} failed again on the identical subtree ${v.subtree.slice(0, 12)}, in a worktree checked out and ` +
          `installed afresh ${variation.separatedMs}ms after the first run (the container's other work is NOT quiet)`,
    });
  }
  const names = flaky.map((v) => v.cmd);
  const detail = names.length
    ? `${names.join(', ')} FAILED and then PASSED on the identical subtree — the code did not change between ` +
      `the two runs, so the failure is non-deterministic and belongs to no branch`
    : `${failed.map((v) => v.cmd).join(', ')} failed again on the identical subtree, in a separately prepared ` +
      `worktree ${variation.separatedMs}ms later`;
  return { reproduced: names.length === 0, flaky: names, detail };
}

/**
 * THE LANDING GATE — content that propagates arrives green, or it does not
 * arrive.
 *
 * A merge the driver commits contributes its content to every descendant and is
 * pushed to origin. The other checks gates cannot speak for it: `report-case`
 * measures a CASE's tree, the `start` probe measures a PROPOSAL, and finish's
 * integration verify EXCLUDES every branch with a block above it — so without
 * this, a branch that merges cleanly hands content down on no evidence, and a
 * cut branch's prefix, pushed at its cut point, ships measured by nothing.
 * Naming that in the result is not measuring it. So the gate runs where the
 * prefix LANDS, on the branch's own tip, with the same checks config and the
 * same typecheck-THEN-test ordering `report-case` uses; there is one notion of
 * green in this driver, not two.
 *
 * WHAT IT DOES NOT RUN, and why each is safe:
 *  - No checks configured — the same deliberate skip every other gate takes.
 *  - The tree did not MOVE (forced no-op merges, a merge that adds no content):
 *    nothing arrived, so nothing propagates that was not already there, and
 *    what was already there is finish's integration verify to judge.
 *  - The TREE was already measured green this pass, on any branch: a checks run
 *    is a function of the tree it runs on (dependencies included — they install
 *    from that tree's own manifests), so a second run answers the same question
 *    at full price.
 * Each skip is journaled, so "did this branch arrive green" stays a journal
 * read rather than a re-probe.
 */
async function landingCheck(
  cli: Cli,
  dir: string,
  branch: string,
  treeBefore: string,
  runChecks: ChecksRunner,
  runInstall?: InstallRunner,
): Promise<LandingVerdict> {
  // The pass's PINNED checks file first: a sweep pass gates on what `start`
  // opened it with, not on what a later command was handed.
  const checks = loadChecksConfig(readMachineState(dir)?.checksFile ?? cli.checksFile);
  if (!checks || checks.typecheck.length + checks.test.length === 0) return { kind: 'skipped' };
  const sha = await revParse(cli.repo, branch);
  const tree = await treeOf(cli.repo, sha);
  // A tree this pass recorded UNSTABLE — or CONFIRMED RED with nothing minted
  // for it — is still OWED a verdict. It was never green, nothing was minted on
  // it and the branch did not arrive — so a later call, which lands nothing new
  // because the merge already happened, must MEASURE it instead of passing it
  // over as a no-op. Skipping it there is how a tree that was never green walks
  // into the pass as though it had been checked, and hands its content down.
  const soFar = readJournal(dir);
  if (tree === treeBefore && !unstableTrees(soFar).has(tree) && !owedRedTrees(soFar).has(tree)) {
    appendJournal(dir, { action: 'landing-check', branch, sha, tree, ran: false, reason: 'no-op' });
    return { kind: 'skipped' };
  }
  // WHAT THIS BRANCH STILL OWES, COMMAND BY COMMAND. A command's verdict belongs
  // to the subtree its `cwd` names, so a branch that shares another's
  // `container/agent-runner` subtree owes no `bun test` — the answer is the same
  // object's, already measured — while still owing every command whose subtree
  // it does not share. The whole-tree question ("has this tree been measured")
  // cannot express that: it re-measures a suite over bytes nobody changed.
  const green = greenChecks(readJournal(dir));
  const phases: Array<{ phase: 'typecheck' | 'test'; owed: VerifyCommand[]; owedKeys: CheckVerdict[] }> = [];
  /** Every command's outcome, measured or inherited — this row IS the evidence. */
  const checkRows: Array<{ cmd: string; cwd?: string; subtree: string; ok: boolean; measuredOn?: string }> = [];
  const inherited = new Set<string>();
  for (const [phase, commands] of [
    ['typecheck', checks.typecheck],
    ['test', checks.test],
  ] as const) {
    const keys = await checkVerdictKeys(cli.repo, sha, commands);
    const owed: VerifyCommand[] = [];
    const owedKeys: CheckVerdict[] = [];
    for (let i = 0; i < commands.length; i++) {
      const on = green.get(checkKey(keys[i].subtree, commands[i].cmd));
      if (on === undefined) {
        owed.push(commands[i]);
        owedKeys.push(keys[i]);
        continue;
      }
      checkRows.push({ ...keys[i], ok: true, measuredOn: on });
      inherited.add(on);
    }
    phases.push({ phase, owed, owedKeys });
  }
  if (phases.every((p) => p.owed.length === 0)) {
    const on = [...inherited].sort();
    appendJournal(dir, {
      action: 'landing-check',
      branch,
      sha,
      tree,
      ok: true,
      // The verdict is COPIED, and the row says where each half was measured.
      measuredOn: on.length === 1 ? on[0] : on.join(', '),
      checks: checkRows,
    });
    return { kind: 'skipped' };
  }
  const wt = await addTempWorktree(cli.repo, sha);
  try {
    // Dependencies come from THIS tree's manifests: a branch that declares its
    // own package must not be measured against the clone's node_modules, and an
    // environment that will not install yields no verdict at all.
    const install = await installDeps(cli, wt.path, runInstall);
    if (!install.ok) {
      appendJournal(dir, {
        action: 'landing-check',
        branch,
        sha,
        tree,
        ran: false,
        reason: 'deps-unusable',
        id: 'WARN13_DEPS_UNUSABLE',
        // WHAT failed, not merely THAT it did: a manifest the tree carries and a
        // machine with no network are the same row without it, and they are not
        // the same problem.
        install: install.failure,
      });
      console.error(
        `run [WARN13_DEPS_UNUSABLE]: ${branch} dependencies would not install — landing NOT checked: ` +
          `\`${install.failure.command}\` failed with: ${install.failure.output.slice(-400)}`,
      );
      return { kind: 'unmeasured' };
    }
    // Typecheck FIRST: it is the cheap check and its diagnostics are what make a
    // failure readable; a red typecheck short-circuits the tests.
    //
    // THE SHORT-CIRCUIT SURVIVES SUBTREE KEYING. It is an ordering, not a
    // verdict: a red typecheck says nothing about the test command's subtree, so
    // nothing green is inherited from it and the tests are simply not run yet.
    // The pass returns here, the fix lands, and the tests are measured then.
    for (const { phase, owed, owedKeys } of phases) {
      if (owed.length === 0) continue;
      const r = await runChecks(owed, wt.path);
      if (r.environmentFault) {
        appendJournal(dir, {
          action: 'landing-check',
          branch,
          sha,
          tree,
          ran: false,
          reason: 'environment-fault',
          id: 'WARN14_ENVIRONMENT_FAULT',
          detail: r.environmentFault.detail,
          phase,
          checks: checkRows,
        });
        console.error(`run [WARN14_ENVIRONMENT_FAULT]: ${branch} — ${r.environmentFault.detail}`);
        return { kind: 'unmeasured' };
      }
      // GREENS ARE RECORDED ONLY FROM A GREEN PHASE. A runner that stops at the
      // first failure leaves the commands after it unrun, and an unrun command
      // recorded green would be inherited by every branch sharing its subtree.
      for (const k of owedKeys) if (r.ok || r.failedNames.includes(k.cmd)) checkRows.push({ ...k, ok: r.ok });
      if (!r.ok) {
        // ONE RED IS AN OBSERVATION, NOT A VERDICT. What follows a red landing is
        // a reopen of the branch AND its subtree, a gate-fix case minted on it
        // and a held PR accusing it — all of it founded on this one run, in a
        // container that is installing worktrees and running other suites at the
        // same time. So the failing commands run AGAIN on the identical tree
        // before any of that happens.
        const failed = owed.filter((c) => r.failedNames.includes(c.cmd));
        const failedKeys = owedKeys.filter((k) => r.failedNames.includes(k.cmd));
        const confirm = await confirmRed(dir, {
          branch,
          sha,
          phase,
          failed: failedKeys,
          // NOT IN THIS WORKTREE. The standing one is where the red was just
          // seen; a second run in it repeats the same moment on the same
          // installed tree, which detects randomness and nothing else.
          rerun: (again) =>
            variedRerun(cli, sha, failed.filter((c) => again.some((k) => k.cmd === c.cmd)), runChecks, runInstall),
        });
        if (confirm.unmeasurable) {
          // The second run never happened, so there is no second observation and
          // the first one stands alone — which is exactly what may not found a
          // case. No verdict, and no verdict is never green.
          appendJournal(dir, {
            action: 'landing-check',
            branch,
            sha,
            tree,
            ran: false,
            reason: 'environment-fault',
            id: 'WARN14_ENVIRONMENT_FAULT',
            detail: confirm.unmeasurable.detail,
            phase,
            checks: checkRows,
          });
          console.error(`run [WARN14_ENVIRONMENT_FAULT]: ${branch} — ${confirm.unmeasurable.detail}`);
          return { kind: 'unmeasured' };
        }
        if (!confirm.reproduced) {
          appendJournal(dir, {
            action: 'landing-check',
            branch,
            sha,
            tree,
            ok: false,
            unstable: true,
            id: 'WARN21_CHECKS_FLAKY',
            phase,
            failed: r.failedNames,
            flaky: confirm.flaky,
            detail: confirm.detail,
            checks: checkRows,
          });
          return { kind: 'flaky', tree, failedNames: r.failedNames, flaky: confirm.flaky, detail: confirm.detail };
        }
        appendJournal(dir, {
          action: 'landing-check',
          branch,
          sha,
          tree,
          ok: false,
          confirmed: true,
          phase,
          failed: r.failedNames,
          checks: checkRows,
        });
        return { kind: 'red', output: r.output, failed, failedNames: r.failedNames, tree, sha };
      }
    }
    appendJournal(dir, { action: 'landing-check', branch, sha, tree, ok: true, checks: checkRows });
    return { kind: 'green' };
  } finally {
    await wt.remove();
  }
}

export async function cmdRun(
  cli: Cli,
  /** The landing gate's checks runner — injected so a pass under test spawns nothing. */
  runChecks: ChecksRunner = defaultChecksRunner,
  runInstall?: InstallRunner,
): Promise<number> {
  const ctx = await passContext(cli); // attaches to the open pass
  const { chain, dir } = ctx;

  // DRY-RUN PURITY (N4): without --execute, NO state changes of ANY kind — no
  // urge artifacts, no journal writes, no merges. Report what WOULD
  // happen (detect-only) and return.
  if (!cli.execute) {
    const journal0 = readJournal(dir);
    const plan0 = await derive(cli, await prBlockedRecords(cli, journal0, ctx.chain), ctx, passStatusView(cli, journal0));
    const wouldUrge = (await detectUrges(cli, ctx, journal0)).map((u) => ({ branch: u.branch, head: u.head }));
    console.error('DRY-RUN (no --execute): no state changes; reporting the plan + would-urge');
    emit(cli, { dryRun: true, plan: plan0, wouldUrge });
    return 0;
  }

  // EXECUTE. Repo-wide rerere first: BEFORE the
  // first mutation, idempotently enable rerere in the agent clone so every
  // merge — driver or case worktree — records/replays resolutions. Journaled
  // once, only when the value actually changes.
  const rr = await git(cli.repo, ['config', '--get', 'rerere.enabled'], { allowCodes: [1] });
  if (rr.stdout.trim() !== 'true') {
    await git(cli.repo, ['config', 'rerere.enabled', 'true']);
    appendJournal(dir, { action: 'rerere-enabled', repo: cli.repo });
  }
  // Blocked state is journal-derived: the origin-derived PR_ID rows
  // were journaled by `sweep start`; there is no local reconcile step. Urges
  // are only DETECTED (posting is `push`'s job — §14.4).
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
  const held = await prBlockedRecords(cli, journal, ctx.chain); // PR_ID block heights, live-derived (§5/N3)
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
  // Branches the DRIVER itself already mutated or demoted this pass
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
    // merge_status transitions are sanctioned derivation changes: a
    // branch manually unfrozen this pass legitimately derives differently
    // from the last written plan.
    const statusCleared = new Set(
      journal
        .filter((e) => e.action === 'unfrozen' && typeof e.branch === 'string')
        .map((e) => e.branch as string),
    );
    // A branch BELOW a blocked one derives differently for the same sanctioned
    // reason the blocked branch itself does: its window is trimmed at that block
    // (§5.2), so heads the written plan listed are no longer eligible. The block
    // can also arrive mid-pass — a verify gate hold is journaled long after
    // `start` wrote the plan — and reading that as "git moved under us" halts a
    // pass for doing exactly what the block is supposed to make it do.
    // WHAT MOVED THIS PASS EXCUSES EVERYTHING UNDER IT. A branch derives against
    // its parents, so the moment a parent merges, takes a case, or is cut, every
    // descendant's eligible line is a different line than the one `start` wrote
    // down — fewer heads, a different verdict, sometimes its own conflict where
    // the parent stopped. None of that is "git moved under us".
    //
    // The verdict is deliberately NOT part of the test: a descendant of a gated
    // parent commonly derives a merge or a case on what remains rather than
    // pointing at the block, and demanding otherwise halts the pass for doing
    // exactly what the block makes it do.
    //
    // The guard still bites where it matters: a branch with NO blocked and NO
    // moved ancestor that derives differently really did have git move under
    // it, and that is the case this exists to catch.
    const ancestorsOf = transitiveAncestors(Object.fromEntries(directParentEdges(cli)));
    const blockedOrMoved = new Set([...driverTouched, ...blockedForRecipe(cli, journal), ...blockedSet]);
    const belowBlocked = new Set(
      [...prev.branches, ...plan.branches]
        .map((b) => b.branch)
        .filter((b) => (ancestorsOf[b] ?? []).some((a) => blockedOrMoved.has(a))),
    );
    const exclude = new Set([
      ...arrived,
      ...reopened,
      ...blockedSet,
      ...belowBlocked,
      ...statusCleared,
      ...syncedBranches,
      ...driverTouched,
    ]);
    const driftRows = planDrift(prev, plan, exclude);
    const drift = driftRows.map((d) => d.branch);
    if (drift.length) {
      // §14: DriverHalt reasons surface under the machine-readable id
      // scheme in CLI output; the human text stays in `detail`/the journal.
      const detail = `git moved under us — plan drift for not-yet-processed branch(es): ${drift.join(', ')}`;
      // The halt carries WHAT CHANGED, not just who: the signature the plan
      // recorded and the one the live derivation produced. Without both a reader
      // cannot tell a parent's merge moving a head from somebody pushing to the
      // branch, and those want opposite responses.
      appendJournal(dir, {
        action: 'halt',
        reason: 'plan-drift',
        id: 'ERR24_PLAN_DRIFT',
        branches: drift,
        drift: driftRows,
      });
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

  // Cut map for the LIVE execution path (mirrors derivePlan): every branch that
  // closes a window, with the coordinate it closes it at. It feeds the
  // eligible-line cut and the height-MIN DEFER over blocked DIRECT parents, and
  // it GROWS in DAG order so a branch's effective cut reaches its descendants.
  // Without it the live re-derivation loses what plan.json computed. Blocked
  // branches' cuts come re-derived from their journaled heads (`held`);
  // branches that ALREADY ARRIVED this pass (they will not be re-processed
  // below) seed from their live-probed plan rows — heights are never read from
  // merge_status.
  const blockHeightOf = new Map<string, number>();
  const recordCut = (branch: string, height?: number): void => {
    if (height !== undefined) blockHeightOf.set(branch, Math.min(height, blockHeightOf.get(branch) ?? Infinity));
  };
  for (const h of held) recordCut(h.branch, h.height);
  for (const bp of plan.branches) {
    if (!arrived.has(bp.branch)) continue;
    const hs = bp.parents.filter((pp) => pp.deferHeight !== undefined).map((pp) => pp.deferHeight!);
    if (hs.length) recordCut(bp.branch, Math.min(...hs));
  }

  let gated = false;
  /** A landing whose red did not reproduce: nothing minted, and the branch unverified. */
  let unstableLanding: { branch: string; tree: string; flaky: string[]; detail: string } | null = null;
  /** A red landing no branch could be handed: nothing minted, nothing arrived. */
  let refusedLanding: { branch: string; id: string; detail: string } | null = null;
  const diverged: string[] = [];
  const mergeFailed: string[] = [];
  /** §14: this run's per-branch halts under the ERR2x id scheme (CLI output). */
  const issues: Issue[] = [];

  try {
    for (const snap of plan.branches) {
      if (arrived.has(snap.branch)) continue; // already processed this pass (resume)

      // Origin sync (§13): reconcile the local branch with origin BEFORE its
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

      // Live merge_status dispatch (the JOURNAL is re-read per branch so
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
      // per-parent verdict goes stale mid-branch.
      const model: 'entry' | 'parents' = snap.parents[0]?.model ?? 'entry';
      const parentBranches = snap.parents.map((p) => p.parent);
      // Read the cut FRESH on every derivation: an earlier sibling in this same
      // loop can defer and close the window since the last read.
      const deriveLive = (mergeBlocked?: { state: 'DEFERRED'; behind: string }): Promise<BranchPlan> =>
        deriveBranch({
          repo: cli.repo,
          branch: snap.branch,
          kind: snap.kind,
          model,
          parents: parentBranches,
          chain,
          ancestors: snap.ancestors,
          tierFloor: snap.tierFloor,
          isLeaf: snap.isLeaf,
          alwaysMerge: snap.alwaysMerge,
          cut: effectiveCut(parentBranches, blockHeightOf),
          blockHeightOf,
          stackCap: snap.stackCap, // effective cap resolved at plan derivation
          mergeBlocked,
        });

      // DEFERRED (STAY rule, journal-derived): sticky while ANY direct parent is
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
            recordCut(snap.branch, pp.deferHeight);
          }
          appendJournal(dir, { action: 'skip', branch: snap.branch, reason: 'deferred' });
          appendJournal(dir, { action: 'arrived', branch: snap.branch });
          arrived.add(snap.branch);
          continue;
        }
      }

      // The tip the plan was DERIVED AT. Step verification must judge the step
      // against THIS tip, not a fresh read — see the note at the verify call.
      const tipAtDerive = await revParse(cli.repo, snap.branch);
      // The tree the branch carried BEFORE this pass's merges landed on it —
      // the landing gate's no-op test (§7.6) compares against it.
      const treeAtDerive = await treeOf(cli.repo, tipAtDerive);
      const bp = await deriveLive();
      // The effective cut is INHERITED: this branch cannot hand its descendants
      // what it could not take itself, so it closes their window at the same
      // coordinate. Recorded before any merge below, so a child processed later
      // in this same loop sees it.
      recordCut(bp.branch, effectiveCut(parentBranches, blockHeightOf)?.height);

      // Leaf / always_merge un-skip (§6): if every parent no-op'd in a pass that
      // carries progress, force (empty) merges along the cheapest parent chain.
      // The chain must not merge into/through a branch whose merge_status
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
        // §6 conflict pre-probe: the un-skip premise
        // ("every parent no-op'd, so forcing produces empty merges") breaks
        // once a prior forced hop moves a tip and a later hop then genuinely
        // conflicts — journaledMerge -> clean-only commitTreeMerge would throw
        // mid-chain (ERR21_MERGE_FAILED hard-halt, partial forced merges left
        // behind). Simulate the WHOLE chain first, including the leaf's own
        // forced merge; ANY unclean hop aborts the un-skip with NO hops forced
        // — the leaf stays skipped ('unskip-conflict', the step verifier's
        // sanctioned all-skip, exactly like the 'unskip-blocked' abort above)
        // and the conflicting branch is handled by its OWN case derivation.
        if (uchain.length >= 2 && !(await unskipChainClean(cli.repo, uchain))) {
          for (const pp of bp.parents) {
            if (pp.verdict === 'skip' || pp.verdict === 'up-to-date') pp.skipReason = 'unskip-conflict';
          }
        } else if (uchain.length >= 2) {
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

      // VERIFY AGAINST THE TIP THE PLAN WAS DERIVED AT.
      //
      // `deriveBranch` pins ONE `branchTip` for all of a branch's per-parent
      // probes — verdicts are statements about THAT tip. A fresh `revParse`
      // here instead would let any ref movement between derivation and this
      // line put the two on different trees, disagreeing about the same merge:
      // the plan says `merge`, the re-probe says "no-op (should be skip)", and
      // the run halts on its own result — a self-healing halt that is
      // indistinguishable from a real one.
      //
      // Judging a plan against a tree the plan never saw is the bug; holding
      // the tip fixed across both makes the two agree by construction rather
      // than by luck of timing.
      const verdict = await verifyStepFile(cli.repo, step, {
        chain,
        branchTip: tipAtDerive,
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
       * Emit a case AGAINST THE BRANCH'S CURRENT TIP.
       *
       * The plan row was probed before this branch's earlier parents merged, so
       * by the time a case is emitted the tip has moved and every part of the
       * row is a statement about a tree that no longer exists. Re-derive the
       * parent row LIVE and take head, run, height, conflicted paths and
       * automerge tree from that ONE derivation: recomputing only the paths and
       * the tree against the moved tip leaves the caseId — branch, parent and
       * HEIGHT — naming a height whose conflict set was measured at a different
       * one, and the run describing commits the recomputed conflict no longer
       * spans. Resolve then re-derives a case that does not match the one on
       * disk.
       *
       * A conflict that HEALED against the moved tip emits nothing. Returns
       * whether a case was emitted (i.e. the branch gates).
       */
      const emitCase = async (pp: (typeof bp.parents)[number]): Promise<boolean> => {
        const nowTip = await revParse(cli.repo, bp.branch);
        const probe = await newStyleMergeTree(cli.repo, nowTip, pp.case!.head.sha);
        if (probe.clean) {
          appendJournal(dir, { action: 'case-healed', branch: bp.branch, parent: pp.parent, head: pp.case!.head });
          return false;
        }
        const live = (await deriveLive()).parents.find((p) => p.parent === pp.parent)?.case ?? null;
        if (!live) {
          // The conflict is still there against this tip, but the live
          // derivation no longer offers it — the window closed above it while
          // an earlier parent was merging. Serving it anyway hands the agent a
          // conflict on content the branch may not take.
          appendJournal(dir, {
            action: 'case-withdrawn',
            branch: bp.branch,
            parent: pp.parent,
            head: pp.case!.head,
            detail: 'the live re-derivation offers no case here — the merge window closed above it',
          });
          return false;
        }
        const caseFile: CaseFile = {
          schemaVersion: 1,
          id: caseId(bp.branch, pp.parent, live.head.height), // B8: branch+PARENT+height (run TOP)
          branch: bp.branch,
          parent: pp.parent,
          head: live.head, // the run's TOP commit (stacked-run model)
          run: live.run,
          tierFloor: bp.tierFloor,
          conflictedPaths: live.conflictedPaths,
          automergeTree: live.automergeTree,
          reproduction: live.reproduction,
          deferredCheck: { firstConflictHeight: live.head.height, transitiveAncestors: bp.ancestors },
        };
        // THE WORKTREE IS BUILT BEFORE THE CASE EXISTS. A case whose environment
        // could not be built must not be journaled at all: journaling it first
        // leaves it in `openCases` with nothing able to check it, `finish`
        // refuses on ERR34_CASES_REMAIN, and the pass has no legal move. The
        // install here reads the base commit's own committed manifests, so its
        // failure is the machine — halt the run and hand it to the owner.
        const prep = await createCaseWorktree(cli, dir, caseFile, nowTip, undefined, runInstall); // agent resolves here
        if (prep.environment) {
          throw new DriverHalt(
            'environment-unusable',
            `the case worktree for ${caseFile.id} (${bp.branch}) has no dependencies — they would not install from ` +
              `the branch's own committed manifests, so nothing in this pass can be checked. No case was opened.`,
          );
        }
        const caseDir = join(dir, caseFile.id);
        writeJsonFile(join(caseDir, 'case.json'), caseFile);
        const diffText = await conflictHunks(cli.repo, caseFile.automergeTree, caseFile.conflictedPaths);
        writeFileSync(
          join(caseDir, 'coldread-request.md'),
          // Resolution diff added at resolve (§7); the context block is included
          // from emission so the reader is never context-starved.
          coldReadRequest(caseFile, diffText.slice(0, 60000), null, await caseContextLines(cli, caseFile)),
        );
        appendJournal(dir, {
          action: 'case',
          branch: bp.branch,
          parent: pp.parent,
          caseId: caseFile.id,
          head: caseFile.head, // sha recorded for the B5i crash-heal ancestry check
          height: caseFile.head.height,
          run: caseFile.run, // the stacked run
          conflictedPaths: caseFile.conflictedPaths,
        });
        return true;
      };

      let branchGated = false;
      try {
        for (let pi = 0; pi < bp.parents.length; pi++) {
          let pp = bp.parents[pi];
          if (branchGated) break; // halt at first case needing judgment per branch
          // Execution re-probe (§3/§8): each per-parent verdict above
          // was probed against the branch tip AT DERIVATION, but parents merge
          // SEQUENTIALLY — once an earlier parent's merge advances the tip, a
          // later parent's clean `merge` verdict is stale (executing it blind
          // crashes the run mid-merge). Re-probe against the CURRENT tip
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
            // Annotate-class (§1): a CLEAN merge passing THROUGH a height a
            // transitive ancestor is HELD on — never gates, surfaced in the report.
            // A clean prefix can merge while the conflict ABOVE it is DEFERRED to a
            // blocked DIRECT parent (§5): record the defer pointer — the journaled
            // `defer` row IS the DEFERRED state, so blocked(X) holds in the
            // derived view from this moment.
            if (pp.deferredTo) {
              appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
              recordCut(bp.branch, pp.deferHeight);
            }
            // A clean merge up to the merge point can still leave a conflict ABOVE
            // it (§3 step 4): emit the case (recomputed post-merge) and halt.
            if (pp.case && (await emitCase(pp))) {
              branchGated = true;
              gated = true;
            }
          } else if (pp.verdict === 'defer') {
            // BECOME DEFERRED: the journaled `defer` row is the state
            // — the branch is blocked in the derived view from now on.
            appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
            recordCut(bp.branch, pp.deferHeight);
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
        // A merge write that STILL fails (journaledMerge's backstop —
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

      // THE LANDING GATE (§7.6). Whatever this branch just took is now its tip:
      // its descendants take it below, `finish` pushes it to origin, and a cut
      // branch's prefix is pushed and then left OUT of the integration recipe.
      // Measure it here, once, before any of that happens.
      const landing = await landingCheck(cli, dir, bp.branch, treeAtDerive, runChecks, runInstall);
      if (landing.kind === 'flaky') {
        // A CHANGED VERDICT ACCUSES NOBODY, and it is not a green either.
        //
        // Nothing is minted and no branch is blamed: the two runs disagree about
        // one tree, so the only fact established is that the check is unstable.
        // But the content is then UNVERIFIED, and content that propagates arrives
        // green or does not arrive — so the branch does not arrive, nothing below
        // it takes its tip, and the pass cannot seal. The tree stays owed a
        // verdict, so a later call re-measures it rather than skipping it as a
        // no-op; a stable answer completes the pass, another unstable one is the
        // owner's to hear about.
        unstableLanding = { branch: bp.branch, tree: landing.tree, flaky: landing.flaky, detail: landing.detail };
        gated = true;
        issues.push({ id: 'WARN21_CHECKS_FLAKY', detail: `${bp.branch}: ${landing.detail}` });
        console.error(`run [WARN21_CHECKS_FLAKY]: ${bp.branch} — ${landing.detail}`);
        break;
      }
      if (landing.kind === 'red') {
        // A RED LANDING IS A FIX-SHAPED PROBLEM ONLY WHERE THERE IS A BRANCH TO
        // HAND THE FIX TO, and that is decided BEFORE the reopen. The reopen is
        // not free: it supersedes this branch's undispositioned case and its
        // descendants' cases, which is right when a gate fix replaces them and
        // pure loss when the mint then refuses. The question is a journal read,
        // so it is asked first.
        //
        // AND WHERE THE FIX GOES IS DECIDED FIRST TOO. A branch that landed red on
        // content it INHERITED is a true observation and a false accusation: the
        // fix belongs at the level that AUTHORED the failing files, where one case
        // covers every branch below it instead of one case per branch. The reopen
        // then has to cover the ceiling's subtree, which is why this comes before
        // it and not after.
        const lift = await liftGateFixTarget(
          cli,
          dir,
          null,
          bp.branch,
          landing.sha,
          parseFailingFiles(rootChecksOutput(landing.output, landing.failed)),
          landing.failed,
          runChecks,
          runInstall,
        );
        // A REFUSAL FROM THE CEILING TABLE IS REPORTED IN THE SAME SHAPE as one
        // from the journal check, SUBTREES INCLUDED: the row is the only place a
        // reader learns which object the finding is keyed to, and an empty list
        // there reads as "no command has a subtree", which is never true.
        const redUsable: RedObservationVerdict = lift.refused
          ? {
              usable: false,
              id: lift.refused.id,
              reasons: [lift.refused.detail],
              observed: await checkVerdictKeys(cli.repo, lift.ref, landing.failed).catch(() => []),
            }
          : await redObservationUsable(readJournal(dir), cli.repo, lift.branch, lift.ref, landing.failed, {
              attributedCeiling: lift.attributedCeiling,
            });
        if (!redUsable.usable) {
          const why = redRefusalDetail(redUsable.reasons);
          appendJournal(dir, {
            action: 'gate-fix-refused',
            id: redUsable.id,
            branch: lift.branch,
            at: lift.ref,
            subtrees: redUsable.observed.map((v) => ({ cmd: v.cmd, ...(v.cwd ? { cwd: v.cwd } : {}), subtree: v.subtree })),
            commands: landing.failed.map((c) => c.cmd),
            reason: why,
          });
          // NOT GREEN, AND NOT ARRIVED. The content is red and unverified, so the
          // branch does not arrive and nothing below it takes its tip. The tree
          // stays owed a verdict (`owedRedTrees`), so the next call measures it
          // again rather than skipping it as a no-op merge.
          refusedLanding = { branch: bp.branch, id: redUsable.id, detail: why };
          gated = true;
          issues.push({ id: redUsable.id, detail: `${bp.branch}: ${why}` });
          console.error(`run [${redUsable.id}]: ${bp.branch} landed RED and no branch may be handed the fix — ${why}`);
          break;
        }
        // REOPEN BEFORE MINTING, branch and subtree together. The reopen
        // supersedes this branch's own undispositioned case — a conflict case on
        // a red tree is unjudgeable, its checks fail on a defect the fix already
        // describes — and it supersedes the descendants' cases for the same
        // reason; minting after the reopen keeps the fix itself out of the
        // supersede.
        // THE TARGET'S SUBTREE, which contains this branch's when blame lifted:
        // everything under a branch that is about to take a gate fix is blocked,
        // and a descendant left open is served ahead of the fix it depends on.
        reopen(
          dir,
          [...new Set([bp.branch, lift.branch, ...transitiveDescendants(planEdgesOf(dir), lift.branch)])],
        );
        const gate = await materializeGateFixCases(cli, dir, ctx.chain, withCeilingNote(landing.output, lift), landing.failed, null, {
          rootBranch: lift.branch,
          // The observation this case rests on. Blame does not re-measure it —
          // the gate above already re-ran it, and a lift is licensed by a
          // confirmation at the ceiling — but it refuses to mint on one that the
          // journal does not record as confirmed.
          redOn: { at: lift.ref, commands: landing.failed },
          attributedCeiling: lift.attributedCeiling,
        });
        gated = true;
        issues.push({
          id: 'WARN09_GATE_FIX_SERVED',
          detail:
            `${bp.branch} landed RED (${landing.failedNames.join(', ')}) — ` +
            (gate.cases.length ? `gate fix served: ${gate.cases.map((c) => c.caseId).join(', ')}` : gate.reason),
        });
        console.error(`run [WARN09_GATE_FIX_SERVED]: ${bp.branch} landed red — ${gate.reason}`);
        // NOTHING ELSE MERGES THIS CALL. The branch is not `arrived`, so the
        // next run re-derives it; the branches below it would be merging the
        // red content this gate just refused, and the ones beside it wait one
        // call for a pass that cannot complete until the fix lands anyway.
        break;
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
  // "Open cases" covers MORE than this run's own gating: a REISSUE case
  // journaled at `start` (undispositioned, never emitted by run — its branch is
  // PR_ID) must keep the pass open, or run would seal a pass with a case still
  // to serve and report-*/finish could no longer attach.
  let sealed = false;
  let missing: string | null = null;
  if (gated || openCases(readJournal(dir)).length > 0) {
    // An unstable landing gates the pass with NO case to serve — saying "open
    // cases remain" would send the reader looking for one that does not exist.
    missing = unstableLanding
      ? `${unstableLanding.branch} landed an UNSTABLE tree — unverified, nothing minted`
      : refusedLanding
        ? `${refusedLanding.branch} landed RED with no branch to hand the fix to — unverified, nothing minted`
        : 'open cases remain';
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
    console.error(`merge-failed branches halted this pass (journaled): ${mergeFailed.join(', ')}`);
  console.error(sealed ? 'run complete — pass sealed (pass-complete)' : `run complete — ${missing}`);
  emit(cli, {
    watermark12: plan.watermark12,
    gated,
    sealed,
    missing,
    passDir: dir,
    diverged,
    mergeFailed,
    ...(unstableLanding ? { unstableLanding } : {}),
    ...(refusedLanding ? { refusedLanding } : {}),
    issues,
  });
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
/** The pass plan's parent edges, or {} when the plan is unreadable. */
function planEdgesOf(dir: string): Record<string, string[]> {
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) return {};
  try {
    return planEdges(JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan);
  } catch {
    return {};
  }
}

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
    // NEVER crash-heal a GATE-FIX case. The heuristic below reads
    // "the ref already contains the case head, so it was resolved before a
    // crash" — but a gate-fix case's head IS the branch tip by construction, and
    // a commit is always its own ancestor, so it would match instantly and the
    // case would be journaled `resolved` on the next command; `openCases` would
    // drop it and `next-case` would answer `finalize` with the case unserved.
    if (e.gateFix === true) continue;
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
  /** The case run's TOP head (stacked-run model). */
  head: { sha: string; height: number };
  /** The stacked run (ascending); run[run.length - 1] === head. */
  run: Head[];
  conflictedPaths: string[];
  /** Pending-and-in-scope reach re-seeded from a published resolution (CaseFile). */
  carriedPaths?: string[];
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
 * Re-derive a GATE-FIX case. `reverifyCase` cannot be used — it
 * re-derives a CONFLICT (live first-conflict head against a named parent, an
 * automerge tree, a plan snapshot entry), and a gate fix has none of those. Left
 * on that path every gate-fix case would die with ERR02_CASE_STALE and the agent
 * would loop: next-case serves it, report-case rejects it, forever.
 *
 * The trust boundary still holds: branch, files and the failing commands come
 * from the DRIVER'S OWN journal row, never from the agent-writable case.json.
 * Scope and descendants are re-derived from the registry, as everywhere else.
 */
async function reverifyGateFixCase(
  cli: Cli,
  ctx: PassCtx,
  caseFile: CaseFile,
  journal: JournalEntry[],
): Promise<{ ok: boolean; rc?: ResolvedCase; errors: string[] }> {
  const row = journal.find((e) => e.action === 'gate-fix' && e.caseId === caseFile.id);
  if (!row) return { ok: false, errors: [`no gate-fix journal row for ${caseFile.id}`] };
  const branch = String(row.branch);
  if (!(await refExists(cli.repo, branch))) return { ok: false, errors: [`gate-fix branch ${branch} no longer exists`] };
  const registry = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile, routingFile: cli.routingFile });
  const scopeResult = await resolveScope(cli.repo, registry.features, registry.scope, { includeRemote: true });
  const scope = new Set(scopeResult.ordered.map((e) => e.branch));
  if (!scope.has(branch)) return { ok: false, errors: [`gate-fix branch ${branch} is out of pass scope`] };
  // The root the case was MATERIALIZED at — the branch tip unless the driver
  // deliberately rooted deeper (`--not-my-bug`, last-failed point). Read from the
  // driver's own journal row, so the trust boundary is unchanged; a row without
  // it (any case minted before rooting existed) falls back to the tip.
  const rootAt = typeof row.rootAt === 'string' ? row.rootAt : null;
  const tip = rootAt && (await refExists(cli.repo, rootAt)) ? rootAt : await revParse(cli.repo, branch);
  const files = Array.isArray(row.files) ? (row.files as string[]) : [];
  // Same head/height/run derivation as `materializeGateFixCases` — re-derived
  // from git, never read back from the agent-writable case.json.
  const head = { sha: tip, height: await gateFixHeadHeight(cli, ctx.chain, tip) };
  return {
    ok: true,
    errors: [],
    rc: {
      id: caseFile.id,
      branch,
      parent: GATE_FIX_PARENT,
      model: 'parents',
      head,
      run: [head], // the run invariant: run[run.length - 1] === head
      conflictedPaths: files,
      // The BRANCH TIP's tree stands in for the automerge tree, and that is
      // load-bearing rather than incidental: everything downstream reads this
      // field as "the tree the agent started from" — the scope guard diffs
      // against it, `emptyResolution` (nothing was fixed) compares against it,
      // and the cold read's resolution diff is computed from it. For a gate fix
      // the agent starts from the clean tip, so the tip's tree is exactly that
      // tree. (There are no conflict markers in it, which is why the guard mode
      // below cannot be `conflict-hunks`.)
      automergeTree: await treeOf(cli.repo, tip),
      reproduction: { command: (Array.isArray(row.failedCommands) ? (row.failedCommands as string[]) : []).join(' && ') },
      // A gate fix is NEW CODE on the branch, never a mechanical merge: the
      // floor keeps it out of the mechanical tier so it always gets a cold read.
      tierFloor: 'judged',
      // 'same-files' is the only mode that MEANS anything here, not a default
      // for want of an "off": it confines the fix to the files the driver named
      // (which is the whole scope statement in the briefing), while
      // `conflict-hunks` — the other mode, and a legal registry setting for this
      // branch — reads conflict-marker spans out of the automerge blob to bound
      // the edit. This "automerge" tree has no markers, so every hunk would land
      // outside the (empty) marker set and EVERY gate fix would be scope-flagged.
      // Hence config is deliberately not consulted for a gate fix.
      scopeGuardMode: 'same-files',
      pendingAbove: Math.max(0, ctx.chain.heads.length - 1 - head.height),
      scope,
      descendants: transitiveDescendants(scopeResult.edges, branch),
    },
  };
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
  const feat = registry.features.find((f) => f.branch === caseFile.branch);
  const floor = tierFloor(caseFile.branch, feat);
  const scopeGuardMode: ScopeGuardMode = feat?.scope_guard ?? registry.routing.scopeGuardMode ?? 'same-files';
  // Stacked-run cap lever, re-derived from config exactly like the tier floor above.
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

  // (1)+(2) re-derive the branch LIVE and locate the named parent's conflict,
  // under the pass's own cut map — the window this branch was served under.
  const cutOf = passCutMap(plan, await prBlockedRecords(cli, journal, ctx.chain));
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
    cut: effectiveCut(parents, cutOf),
    blockHeightOf: cutOf,
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
 * Re-verification for a REISSUE case (a revision of a published-and-
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
  const feat = registry.features.find((f) => f.branch === caseFile.branch);
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
      // Carried through the re-derivation: they are pending in the worktree and
      // in scope, and a guard that forgot them would charge the agent for the
      // resolution it was handed.
      ...(caseFile.carriedPaths?.length ? { carriedPaths: caseFile.carriedPaths } : {}),
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
 * Freeze a branch HELD: prepare the PR materials (§14) and journal `held` —
 * the journaled disposition IS the blocked state for the rest of the pass
 * (blockedRows/passStatusView read it; nothing is written to the
 * journal, and NOTHING is pushed or published here — the PR is created at
 * `finish`, after verify). The journal entry records what the UNIFIED publish
 * needs:
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
    headSha: rc.head.sha, // conflict head — the derived block height's anchor
    conflictedPaths: rc.conflictedPaths,
    notes,
    resolution,
    escalation: opts.escalation ?? null,
  });
}

/**
 * N5: the CONFLICT case-id shape (`slug(branch)--slug(parent)-h<n>`, steps.ts).
 * `<n>` may be NEGATIVE and that is not a sentinel: `deriveCoverage` returns -1
 * for a head that sits BELOW this pass's pinned chain, which parents-model
 * cases hit routinely — which is also exactly why a gate fix wearing a fake
 * `-h-1` would be indistinguishable from a real case id.
 */
const CONFLICT_CASE_ID_RE = /^[A-Za-z0-9_-]+-h-?\d+$/;

/**
 * N5: does `id` have a shape the DRIVER generates? `--case` is joined into
 * paths under the pass dir, so anything outside the slug charset — path
 * separators, dots, `..` traversal — is refused BEFORE any path join. slug()
 * maps all other characters to `_`, so a generated id always matches.
 *
 * There are TWO generated shapes, because there are two kinds of case: the
 * CONFLICT form above, and the GATE-FIX form (`gateFixCaseId`), which has no
 * height because a gate fix has no merge. Both shapes are
 * stated as themselves, so the charset guarantee is unchanged and no case
 * has to lie about having a height to be publishable.
 */
function isGeneratedCaseId(id: string): boolean {
  return CONFLICT_CASE_ID_RE.test(id) || isGateFixCaseId(id);
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
 *
 * A GATE FIX has no parent and no height, so it names itself with its own
 * identity (the case id) after the `<slug(branch)>--` prefix every fix ref
 * needs — that prefix is what `deriveOriginMergeStatus` maps back to the target
 * branch. Spelling it through the conflict form would put the `(gate-fix)`
 * parent LABEL and a fake height into a ref name that the next pass's origin
 * reader then tries to parse a real scope branch and a real trunk height back
 * out of.
 */
function fixBranchName(id: string, rc: Pick<ResolvedCase, 'branch' | 'parent' | 'head'>): string {
  if (isGateFixCaseId(id)) return `fix/sweep/${slug(rc.branch)}--${id}`;
  return `fix/sweep/${slug(rc.branch)}--${slug(rc.parent)}-h${rc.head.height}-${rc.head.sha.slice(0, 8)}`;
}

/**
 * Prepare the case's PR MATERIALS (§14) — structured driver facts ONLY:
 * conflicted paths, the case run, per-side one-line histories over those
 * paths, the reproduction command. The driver NEVER generates PR prose
 * (driver-generated boilerplate cannot pass the agent's own text gate): the
 * agent studies the case (worktree + these
 * materials) and writes pr/title.txt + pr/body.md itself, then runs
 * `propagate publish --case <id>` — the ONLY sanctioned PR-creation path.
 * No fix/sweep ref is created here either: publish pushes the ref at the REAL
 * head (HELD: the run's top commit; JUDGED: the merge commit). Returns
 * the deterministic fix branch NAME for urge bookkeeping.
 */
/** Where the case's PR template is written — the ONE template the agent may use. */
function prTemplatePath(dir: string, caseId: string): string {
  return join(dir, caseId, 'pr', 'TEMPLATE.md');
}

/**
 * The PR-description handoff, appended to every result that asks for PR text.
 * With no template named, an agent reaches for the repo's contribution
 * template instead. Name the one to use; say nothing about the rest.
 */
function prHandoff(dir: string, caseId: string, base: string): string {
  return `${base}. Write \`pr/body.md\` from ${prTemplatePath(dir, caseId)} — use only this template.`;
}

/**
 * The case's PR template. Written per case, and TAILORED to its kind: a gate fix
 * has no merge, so ours/theirs/chosen is meaningless there and inviting it
 * produces invented content. The section set IS the instruction.
 */
function prTemplateFor(rc: ResolvedCase, tier: Tier): string {
  const gateFix = isGateFixCaseId(rc.id);
  const head = [
    '<!-- sweep-pr-template: v1 — the only template for a sweep PR. -->',
    '<!-- The FIRST line below is the PR title. Keep the `# ` and replace the text. -->',
    '<!-- Delete every comment and every <angle-bracket> placeholder before publishing. -->',
    '',
  ];
  const body = gateFix
    ? [
        `# Decision needed: <the specific choice the owner must make about this fix>`,
        '',
        '## What is broken',
        '<the failing check and what it reports, from gate-fix-output.txt — not a guess>',
        '',
        `## The fix (\`${rc.branch}\`)`,
        ...rc.conflictedPaths.map((p) => `\n### \`${p}\`\n\n<what you changed and WHY it makes the check pass>`),
        '',
        '## Scope',
        `This is a GATE FIX: it repairs a pre-existing defect, it resolves no merge conflict.`,
        `Nothing outside the ${rc.conflictedPaths.length} file(s) above is touched.`,
        '',
        '## Verification',
        '<which checks you ran and their result; name any gate that could NOT run here and why>',
      ]
    : [
        `# Decision needed: <the specific choice> | Review needed: <the specific risk>`,
        '',
        '## What this merge is',
        `\`${rc.parent}\` → \`${rc.branch}\` at height ${rc.head.height}. <what the upstream change does>`,
        '',
        '## Resolutions',
        ...rc.conflictedPaths.map(
          (p) =>
            `\n### \`${p}\`\n\n<details>\n<summary>ours vs theirs vs chosen</summary>\n\n` +
            `**ours (\`${rc.branch}\`)** — <behaviour>\n\n` +
            `**theirs (\`${rc.parent}\`)** — <behaviour>\n\n` +
            `**chosen** — <what you kept, and WHY>\n\n</details>`,
        ),
        '',
        '## Scope',
        `Everything outside these ${rc.conflictedPaths.length} file(s) is verbatim upstream, already reviewed upstream.`,
        '',
        '## Verification',
        '<which checks you ran and their result; name any gate that could NOT run here and why>',
      ];
  return [...head, ...body, ''].join('\n');
}

/**
 * The reading contract handed to the agent with every case.
 *
 * ONE COPY, shared by `prepareCaseMaterials` and `machineCaseMaterials` — an
 * edit that changes one and not the other leaves two divergent contracts in
 * play. Two copies of a rule are two rules.
 */
const CASE_DIRECTIVES: string[] = [
  'EDIT: the pending files below, nothing else. `git status` shows exactly them.',
  'READ: the hunk ranges below, then only what those hunks name — definitions,',
  '  call sites and tests of the symbols IN them.',
  'DO NOT: read whole files or trees, walk history, open unrelated branches.',
  'CANNOT DECIDE: `report-case --tier held`. Never a wider search.',
];

/**
 * The two sides' commit subjects over the conflicted paths. Also one copy, so
 * the two documents cannot drift to different wordings for the same two
 * `git log` runs.
 */
function perSideBlocks(sides: { ours: string; theirs: string }, ours: string, theirs: string): string[] {
  return [
    `## ours (\`${ours}\`) — \`git log --oneline\` over the conflicted paths since the merge base`,
    '```',
    sides.ours,
    '```',
    '',
    `## theirs (\`${theirs}\`) — same range on the other side`,
    '```',
    sides.theirs,
    '```',
  ];
}

async function prepareCaseMaterials(cli: Cli, dir: string, rc: ResolvedCase, tier: Tier): Promise<string> {
  const fixBranch = fixBranchName(rc.id, rc);
  const prDir = join(dir, rc.id, 'pr');
  mkdirSync(prDir, { recursive: true });
  // The template is REWRITTEN every time: it embeds this case's branch, parent
  // and conflicted paths, so a stale copy from a prior disposition would name
  // the wrong files.
  writeFileSync(prTemplatePath(dir, rc.id), prTemplateFor(rc, tier));
  const tip = await revParse(cli.repo, rc.branch);
  const sides = await perSideLog(cli.repo, tip, rc.head.sha, rc.conflictedPaths);
  const materials = [
    `# Case materials — ${rc.id} (${tier})`,
    '',
    ...CASE_DIRECTIVES,
    '',
    '## Conflicted paths (the pending files — your edit scope)',
    ...rc.conflictedPaths.map((p) => `- ${p}`),
    '',
    `Branch: ${rc.branch}   Parent: ${rc.parent}   Head: ${rc.head.sha.slice(0, 12)} (height ${rc.head.height})`,
    `Case run (${rc.run.length} height(s)): ${rc.run.map((h) => `h${h.height} ${h.sha.slice(0, 12)}`).join(', ')}`,
    `Pending upstream commits above this point: ${rc.pendingAbove}`,
    '',
    `## Reproduction`,
    '```',
    rc.reproduction.command,
    '```',
    '',
    ...perSideBlocks(sides, rc.branch, rc.parent),
    '',
    'Write pr/title.txt and pr/body.md YOURSELF from studying the case, then run',
    `\`report-pr\`.`,
  ].join('\n');
  writeFileSync(join(prDir, 'materials.md'), materials + '\n');
  return fixBranch;
}

// --------------------------------------------------------------------------
// publish — the ONLY sanctioned PR-creation path (§14).
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
    // `held-duplicate` IS a terminal disposition: the case folded
    // into a HELD topmost sibling and inherits its PR — it must drain from
    // openCases (so `finish` completes) and never publish a PR of its own. It is
    // NOT `held`, so the finish held-publish phase (which filters action==='held')
    // correctly skips it.
    // `env-blocked` IS a terminal disposition: the environment made the case
    // unjudgeable, so there is nothing left to serve, resolve or publish. It
    // must drain from openCases — otherwise `finish` refuses on ERR34 forever
    // and the pass has no legal move — and it is NOT `held`, so the finish
    // held-publish phase (which filters action==='held') correctly skips it:
    // nothing about the tree was verified, so nothing about it is proposed.
    if (
      (e.action === 'held' ||
        e.action === 'resolved' ||
        e.action === 'held-duplicate' ||
        e.action === 'env-blocked') &&
      e.caseId === caseId
    )
      last = e;
  }
  return last;
}

/**
 * The commit a RED-FINISH ESCALATION should build its PR head on: `origin/<branch>`
 * when the pass left local ahead of it, else null (no escalation, no origin ref,
 * or origin already contains the local tip — the ordinary head is correct and
 * ERR14 passes on its own terms).
 *
 * Every escalation head must go through this — an escalation built on the
 * local tip instead publishes a PR carrying hundreds of the pass's unpushed
 * merge commits for a case with no code change.
 */
async function escalationBase(cli: Cli, branch: string, tip: string): Promise<string | null> {
  if (!cli.escalateUnpushed) return null;
  const originRef = `origin/${branch}`;
  if (!(await refExists(cli.repo, originRef))) return null;
  const originTip = await revParse(cli.repo, originRef);
  if (await isAncestor(cli.repo, tip, originTip)) return null;
  return originTip;
}

/**
 * Rebase a held resolution onto `origin/<branch>` for a RED-FINISH ESCALATION.
 *
 * Returns null when no transplant is needed or wanted (not escalating, no origin
 * ref, origin already at/above the local tip — the ordinary case, where the head
 * is already correct). Otherwise replays the resolution's own delta
 * (`tip..localHead`) on top of origin's tip, so the escalation PR carries the fix
 * and NOT the pass's unpushed merges.
 *
 * A conflicting transplant is NOT a refusal. The fix cannot be separated from the
 * merges it sits on, so the case still reaches the owner — as a DRAFT, off the
 * un-transplanted head, with the reason journaled. Dropping it silently is the
 * failure this whole path exists to end; a fat diff the owner can still read is
 * strictly better than no PR at all.
 */
async function transplantOntoOrigin(
  cli: Cli,
  dir: string,
  jc: JournaledCase,
  tip: string,
  localHead: string,
): Promise<{ headSha: string; draft: boolean } | null> {
  const originTip = await escalationBase(cli, jc.branch, tip);
  if (originTip === null) return null;
  const originRef = `origin/${jc.branch}`;
  const replay = await replayCommitOnto(cli.repo, localHead, originTip);
  if (!replay.clean) {
    if (cli.execute) {
      appendJournal(dir, {
        action: 'escalation-not-transplanted',
        id: 'WARN16_ESCALATION_BASE_BEHIND',
        branch: jc.branch,
        caseId: jc.caseId,
        conflictedPaths: replay.conflictFiles,
        detail:
          `the held resolution does not replay cleanly onto ${originRef} (${originTip.slice(0, 12)}) — ` +
          `conflicts in [${replay.conflictFiles.join(', ')}]. Publishing a DRAFT off the local tip instead: its diff ` +
          `also contains this pass's UNPUSHED merges, which were never verified green (the finish was red)`,
      });
    }
    return { headSha: localHead, draft: true };
  }
  const headSha = await deterministicCommit(
    cli.repo,
    replay.treeOid,
    [originTip],
    `Escalated resolution of ${jc.caseId} on ${jc.branch} (rebased onto ${originRef} — the pass finished RED and pushed nothing)`,
  );
  if (cli.execute) {
    appendJournal(dir, {
      action: 'escalation-transplanted',
      branch: jc.branch,
      caseId: jc.caseId,
      from: localHead,
      to: headSha,
      onto: originTip,
      detail: `resolution replayed onto ${originRef} so the escalation PR shows the fix alone`,
    });
  }
  return { headSha, draft: false };
}


/**
 * Publish every HELD case that has not reached a PR yet, as a RED-FINISH
 * ESCALATION. Returns how many published, and how many were pending.
 *
 * Shared by BOTH red exits from `finish` (attributed ERR40 and the
 * unattributed ERR18 halt) — the rule "a held case reaches the owner" belongs
 * to the OUTCOME, not to one code path, so neither exit may drop the agent's
 * work.
 *
 * Records WHY each refusal happened. `cmdPublish` reports through `emit`, which
 * `internal: true` silences, so a bare exit code says nothing — the `out` file
 * is what keeps a refusal from journaling an unactionable "publish-failed".
 */
async function escalateHeldCases(
  cli: Cli,
  dir: string,
  makeTransport: ((token: string) => GithubTransport) | undefined,
  phase: string,
): Promise<{ escalated: number; total: number }> {
  const pending = [...journaledCases(readJournal(dir)).values()].filter(
    (jc) =>
      lastDisposition(readJournal(dir), jc.caseId)?.action === 'held' &&
      !readJournal(dir).some((e) => e.action === 'pr-published' && e.caseId === jc.caseId),
  );
  let escalated = 0;
  for (const jc of pending) {
    const pubOut = join(dir, `publish-${slug(jc.caseId)}.json`);
    const rcPub = await cmdPublish(
      { ...cli, cmd: 'publish', caseId: jc.caseId, execute: true, internal: true, out: pubOut, escalateUnpushed: true },
      makeTransport,
    );
    if (rcPub === 0) {
      escalated++;
      continue;
    }
    let why = 'unknown';
    try {
      const r = JSON.parse(readFileSync(pubOut, 'utf8')) as { issues?: Array<{ id?: string; detail?: string }> };
      why = (r.issues ?? []).map((i) => `${i.id ?? '?'}: ${i.detail ?? ''}`).join('; ') || 'no issues reported';
    } catch {
      /* keep 'unknown' */
    }
    appendJournal(dir, { action: 'publish-failed', caseId: jc.caseId, branch: jc.branch, phase, reason: why });
    console.error(`finish: held publish failed for ${jc.caseId} — ${why}`);
  }
  return { escalated, total: pending.length };
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

export function journaledCases(journal: JournalEntry[]): Map<string, JournaledCase> {
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
 * Deterministic driver-built commit (publish heads). The identity it stamps is
 * also what the driver-shape test reads back, so both live in `proposal.ts`.
 */
async function deterministicCommit(repo: string, tree: string, parents: string[], message: string): Promise<string> {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
  return (await git(repo, args, { env: DRIVER_COMMIT_ENV })).stdout.trim();
}

/**
 * The REAL commit a case's PR head is pushed at — the UNIFIED publish (§14).
 * Decision key for a HELD case: does a MARKER-CLEAN resolution
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
    // A GATE FIX has no conflict and never had one — its `head.sha`
    // IS the branch tip by construction, and `freezeHeld` only journals (it never
    // advances the ref). Without this guard all three staleness probes below
    // would fire unconditionally on every held gate fix: the first would read
    // "the resolution landed", finish would journal `publish-failed`, and the
    // agent's fix would be thrown away — no fix/sweep ref, no PR, nothing for
    // the owner. (`crashHeal` carries the analogous guard.) A held gate fix
    // publishes like any other held case, off its recorded resolution.
    const isGateFix = journal.some((e) => e.action === 'gate-fix' && e.caseId === jc.caseId);
    if (!isGateFix && (await isAncestor(cli.repo, jc.head.sha, tip))) {
      return {
        issue: {
          id: 'ERR02_CASE_STALE',
          detail: `branch tip already contains held head ${jc.head.sha.slice(0, 12)} — the resolution landed; no freeze PR to publish`,
        },
      };
    }
    const probe = isGateFix ? null : await newStyleMergeTree(cli.repo, tip, jc.head.sha);
    if (probe?.clean) {
      return {
        issue: {
          id: 'ERR02_CASE_STALE',
          detail: `no live conflict for '${jc.branch}' <- ${jc.head.sha.slice(0, 12)} — healed`,
        },
      };
    }
    if (probe && !samePathSet(probe.conflictFiles, jc.conflictedPaths)) {
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
        // A HELD GATE FIX ships as a SINGLE-parent commit. Its
        // `head.sha` IS the branch tip, so the ordinary two-parent form would
        // record the tip as both parents — a degenerate self-merge whose PR
        // diff reads as an empty merge rather than the fix.
        const localHead = isGateFix
          ? await deterministicCommit(cli.repo, shipTree, [tip], `Gate fix for ${jc.caseId} on ${jc.branch} (owner review)`)
          : await deterministicCommit(
              cli.repo,
              shipTree,
              [tip, jc.head.sha],
              `Resolution of ${jc.caseId} for owner review (merges ${jc.head.sha.slice(0, 12)} into ${jc.branch})`,
            );
        // RED-FINISH ESCALATION. `localHead` sits on the local tip, which this
        // pass advanced with merges that were deliberately NOT pushed (the tests
        // are red). A PR of it against `origin/<branch>` would show every one of
        // those unverified merges alongside the fix, and ERR14 refuses it
        // outright — silently dropping the escalation. Transplant the
        // resolution onto origin's ACTUAL tip so
        // the PR's diff is the case's own work and nothing else.
        const transplant = await transplantOntoOrigin(cli, dir, jc, tip, localHead);
        if (transplant) return { ...transplant, mode: 'held', draft: transplant.draft, escalation };
        return { headSha: localHead, mode: 'held', draft: false, escalation };
      }
    }
    // A GATE FIX HAS NO PRISTINE CONFLICT TO FALL BACK ON. It never had a
    // conflict, so when it freezes HELD with no resolution the agent tried and
    // could not fix it — which is a real outcome the owner has to see, not a
    // reason to drop the case. The rule applies to every held gate fix alike:
    // reproducible-but-unfixable-in-scope reaches the owner as a held PR.
    // There is no other channel.
    //
    // A PR needs a commit and there is no diff to make, so the head is an EMPTY
    // commit whose message names the case; the finding lives in the PR body the
    // agent wrote. DRAFT, because there is nothing to merge — it is a report.
    if (!probe) {
      // ON ORIGIN'S TIP WHEN ESCALATING. Parenting this on the LOCAL tip —
      // which the pass advanced — would publish a PR of hundreds of commits
      // and files for a case with no code change at all. An empty commit needs
      // only the right parent.
      const reportBase = (await escalationBase(cli, jc.branch, tip)) ?? tip;
      const headSha = await deterministicCommit(
        cli.repo,
        `${reportBase}^{tree}`, // tree-ish: `commit-tree` resolves it; `revParse` normalizes to a COMMIT and cannot
        [reportBase],
        `Diagnosis for ${jc.caseId} on ${jc.branch} — no code change (owner review)`,
      );
      return { headSha, mode: 'held', draft: true, escalation };
    }
    // DRAFT: the pristine conflict, as ONE commit — the automerge tree parented
    // on the branch tip and the conflict head. One commit because the ref has to
    // stay readable as the driver's: the first-parent walk down to the base is
    // what decides whether anyone else has pushed here, and it needs
    // `parents[0]` to BE the base tip. The PR's diff against its base is this
    // tree however many commits carry it, so nothing is lost by not splitting.
    //
    // The clean-prefix commit belongs to the case WORKTREE, where it is
    // load-bearing: it is what makes `git status` show exactly the conflict.
    const headSha = await deterministicCommit(
      cli.repo,
      probe.treeOid,
      [tip, jc.head.sha],
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
 * blobs). Subset loosening: a case whose path set is a SUBSET of a sibling's
 * (either direction) is also a duplicate when the conflict blobs on the SHARED
 * paths match — a near-duplicate differing only by a missing path is still the
 * same conflict. Duplicates consolidate into the TOPMOST case by DAG order (run
 * journals cases in DAG order, so first-journaled = topmost); the topmost case
 * itself publishes.
 */
/**
 * ERR06 with a machine-readable pointer when the matched sibling's PR is
 * ALREADY PUBLISHED — `finish`'s held phase skips such a case (journaled
 * `held-duplicate`) instead of wedging on an unpublishable duplicate;
 * absent for the still-open topmost-sibling arm, which remains
 * a consolidate-first error.
 */
interface DuplicateIssue extends Issue {
  duplicateOf?: { caseId: string; url: string; number: number };
  /**
   * Set when the matching topmost sibling is itself HELD (frozen for
   * the owner, no PR yet). "Resolve THAT case" is impossible — it is frozen — so
   * report-case CONSOLIDATES this case into it (a `held-duplicate` disposition)
   * rather than blocking, and it inherits the topmost's held PR at finish.
   */
  heldDuplicateOf?: { caseId: string; branch: string };
}

export async function duplicateCaseIssue(
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
   * strip the marker labels before comparing.
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
    // Path-set relation: equal, or one a SUBSET of the other. The
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

  const superseded = supersededCaseIds(journal);
  for (const other of cases.values()) {
    if (other.caseId === self.caseId) continue;
    // A case SUPERSEDED by a reopen is dead — never a duplicate. Its
    // undispositioned `case` row would otherwise read as an open sibling and,
    // since a reopen re-emits a superset case (same conflict + new paths), match
    // this case's signature and fire ERR06 pointing at a case next-case will
    // never serve — the same wedge the open-case readers guard against.
    if (superseded.has(other.caseId)) continue;
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
      // A HELD topmost cannot be "resolved" — it is frozen for the
      // owner. Flag it for consolidation (report-case journals a held-duplicate)
      // instead of an unsatisfiable "resolve THAT case" block that would loop
      // and then wedge `finish` (ERR34). An UNDISPOSED topmost keeps the plain
      // block: the agent CAN resolve it first, then this case inherits via rerere.
      if (disposition?.action === 'held') {
        return {
          id: 'ERR06_DUPLICATE_CASE',
          detail: `identical conflict to HELD case '${other.caseId}' (topmost) — it is frozen for the owner, so this case consolidates into it and inherits its PR`,
          heldDuplicateOf: { caseId: other.caseId, branch: other.branch },
        };
      }
      return {
        id: 'ERR06_DUPLICATE_CASE',
        detail: `duplicate of case '${other.caseId}' (topmost by DAG order) — publish/resolve THAT case; this one inherits the resolution`,
      };
    }
  }
  return null;
}

/**
 * `propagate publish --case <id>` (§14; unified for held + judged) — the
 * ONLY sanctioned PR-creation path. The agent writes pr/title.txt + pr/body.md
 * itself from studying the case; this subcommand re-verifies the case,
 * determines the REAL PR head via `publishHead` (HELD with a marker-clean
 * resolution: the resolved merge commit, ACTIVE PR; HELD without one: the
 * pristine-conflict commit, DRAFT PR; JUDGED: the merge commit, non-draft),
 * runs the check battery incl. the pre-PR height check (ERR14) and emits ONE
 * machine-readable JSON object {ok, issues:[{id, detail}], pr?} on stdout.
 * Blocking ERR* ids stop the publish; WARN* ids ship as advisories. With
 * --execute (and all-clear) it PUSHES the fix/sweep ref via `git push`
 * (ERR15 on failure — an owner report, never worked around) and
 * creates the PR via the GitHub API (HELD PRs carry the machine block,
 * escalated holds the warning prefix + reviewer feedback); without --execute
 * it is a dry-run — full battery, but NO pushes and NO network calls of any
 * kind. Text checks are MECHANICAL only (ERR08 + lint WARNs + ERR06).
 */
export async function cmdPublish(cli: Cli, makeTransport?: (token: string) => GithubTransport): Promise<number> {
  if (!cli.caseId) {
    console.error('publish: --case <id> is required');
    return 2;
  }
  if (!isGeneratedCaseId(cli.caseId)) {
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
  // REAL head + the pre-PR height check (ERR14).
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
  push(await checkBaseHeight(cli.repo, jc.branch, mode, headSha, cli.escalateUnpushed === true));

  // (4) "should this PR exist": duplicates (ERR06) + already-published (ERR07,
  // journal side).
  push(await duplicateCaseIssue(cli, journal, cases, jc));
  const priorPr = journal.filter((e) => e.action === 'pr-published' && e.caseId === jc.caseId).pop();
  if (priorPr) {
    push({
      id: 'ERR07_PR_EXISTS',
      detail: `PR #${priorPr.number} already published for this case: ${priorPr.url}`,
    });
  }

  // (5) agent-written text (ERR08) + MECHANICAL text checks only — the lint
  // WARNs below and the ERR06 adequacy gate above.
  const prDir = join(dir, jc.caseId, 'pr');
  const titlePath = join(prDir, 'title.txt');
  const bodyPath = join(prDir, 'body.md');
  const title = existsSync(titlePath) ? readFileSync(titlePath, 'utf8').trim() : '';
  const body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8').trim() : '';
  if (title === '' || body === '') {
    push({
      id: 'ERR08_TEXT_MISSING',
      detail: `write ${titlePath} and ${bodyPath} YOURSELF from studying the case (worktree + pr/materials.md) — the driver never generates PR prose`,
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
    token = resolveGithubToken(cli);
    if (!token) {
      push({
        id: 'ERR11_TOKEN_MISSING',
        detail:
          'publish needs the substitute GitHub token in the environment: export GH_TOKEN (or GITHUB_TOKEN) — the credential proxy swaps the Authorization header for api.github.com on the wire',
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

  // Deterministic fix branch (no pinned copy anywhere —
  // the name derives from the case identity alone, so a retried publish and
  // the next pass's origin scan agree on it). A REISSUE case prefers
  // the ORIGIN ref name the driver recorded at start (it IS the existing PR's
  // head branch — the identity-derived name must and does match it).
  const caseRow = journal.find((e) => e.action === 'case' && e.caseId === jc.caseId) ?? null;
  const reissue = caseRow?.reissue === true;
  const fixBranch =
    reissue && typeof caseRow!.fixBranch === 'string' ? (caseRow!.fixBranch as string) : fixBranchName(jc.caseId, jc);

  if (issues.some((i) => isBlocking(i.id))) {
    emit(cli, { ok: false, issues });
    return 1;
  }

  // Active-vs-draft is the unified publish decision: a HELD case with
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
  // earlier publish already landed. For a REISSUE the KNOWN PR's LIVE
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
    // PROVENANCE-BLIND: a PR either exists for this case's deterministic head
    // ref or it does not. Which pass opened it — and whether this pass remembers
    // opening it — is not a difference the driver may act on: the ref name
    // derives from the case identity alone, so an open PR on it IS this case's
    // PR. It gets UPDATED with the current head and prose, exactly as a reissue
    // does. The only thing `finish` must never do is create a second one.
    if (!reissueTarget) {
      const existing = await getOpenPrByHead(transport, slugParts!, fixBranch);
      if (existing) {
        reissueTarget = existing;
        appendJournal(dir, {
          action: 'pr-adopted',
          caseId: jc.caseId,
          branch: jc.branch,
          fixBranch,
          url: existing.url,
          number: existing.number,
          detail: 'an open PR already exists on this case\'s head ref — updating it instead of creating a second',
        });
        console.error(`publish: open PR #${existing.number} already exists for head '${fixBranch}' — updating it`);
      }
    }
  } catch (e) {
    emit(cli, { ok: false, issues: [...issues, apiFailureIssue(cli, e)] });
    return 1;
  }

  // The DRIVER pushes the PR head — `git push` is the only way refs move.
  // A failure is ERR15: hard halt, journaled, reported to the owner;
  // NO fallback of any kind. A REISSUE replaces the prior resolution
  // head on the SAME ref (non-fast-forward by construction), so it pushes with
  // a compare-and-swap lease on the start-classified old head — never blind.
  //
  // An ADOPTED PR (found on the ref, not journaled by this pass) leases against
  // the driver's own local anchor for that ref, which is what it last pushed
  // there. Without a lease the push would clobber whatever the ref carries now;
  // with one, a ref that moved under us fails loudly instead.
  const localAnchor = (await refExists(cli.repo, fixBranch))
    ? await revParse(cli.repo, fixBranch)
    : null;
  const priorHead =
    reissue && typeof caseRow!.priorHead === 'string' ? (caseRow!.priorHead as string) : reissueTarget ? localAnchor : null;
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
      `report to the owner and STOP; publication is blocked until the infrastructure is fixed`;
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
    // Escalated hold: the warning prefix + the cold reviewer's short
    // feedback go ABOVE the agent's prose so the owner sees why this landed
    // on their desk (scope exceeded / rejected twice / did not converge).
    if (escalation) {
      finalBody = `${escalation.tag}${escalation.feedback ? ` — ${escalation.feedback}` : ''}\n\n${finalBody}`;
    }
    if (mode === 'held') {
      // The PR-body machine block: driver-maintained, delimited,
      // appended BELOW the agent's prose; posted urges keep it current.
      const pendingAbove = Math.max(0, ctx.chain.heads.length - 1 - jc.head.height);
      finalBody = withMachineBlock(finalBody, renderMachineBlock(pendingAbove, ctx.watermark12));
    }
    let result: { url: string; number: number };
    if (reissueTarget) {
      // UPDATE IN PLACE: the new head is already on the ref (the push above);
      // refresh the PR's title and body from the current prose. Never a second
      // PR — for a reissue, and equally for a PR this pass merely found.
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
    // Record the review-loop state on the PR — the sweep-addressed
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
    } else {
      // The anchor follows what was pushed, whatever put the ref there — it is
      // the lease for the next update.
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
    // No stored pointer to update: the `pr-published` journal row
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
    emit(cli, { ok: false, issues: [...issues, apiFailureIssue(cli, e)] });
    return 1;
  }
}

/**
 * `propagate push` — the pass publication stage (§14.4). The DRIVER
 * pushes; the agent never hand-pushes anything —
 * driver-journaled pass pushes are the only pushes. Per-pass order: verify
 * green → JUDGED PRs created (`publish`, non-draft) → THIS command pushes the
 * target branches — ONE push per branch, clean prefix + judged merge commits
 * together; GitHub auto-flips the JUDGED PRs to merged → HELD PRs
 * created (`publish`, active/draft — bases now current, ERR14 enforces
 * it) → urge comments posted (also this command). Verify-gated (ERR18): nothing is
 * pushed before `verify` is green (§9). PUSH RESILIENCE:
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

  // Target set: every branch the driver mutated this pass, in plan order
  // (`pushMember`). Blockedness does NOT withhold a push — a branch merged to
  // its cut point holds a complete prefix, and its held PR is opened against
  // origin's copy of it. What the integration build did not cover is REPORTED
  // (`coverage` / `pushedUnbuilt` at finish), never held back.
  const mutated = new Set(
    journal
      .filter((e) => (e.action === 'merge' || e.action === 'resolved') && typeof e.branch === 'string')
      .map((e) => e.branch as string),
  );
  const planPath = join(dir, 'plan.json');
  const order: string[] = existsSync(planPath)
    ? (JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan).order
    : [...mutated];
  const targets = order.filter((b) => pushMember(b, mutated));
  for (const b of mutated) if (pushMember(b, mutated) && !targets.includes(b)) targets.push(b);

  interface PushIntent {
    branch: string;
    state: 'push' | 'create' | 'up-to-date' | 'remote-ahead' | 'diverged';
    localTip: string;
  }
  const intents: PushIntent[] = [];
  for (const branch of targets) {
    if (!(await refExists(cli.repo, branch))) {
      // Mutated but gone by push time: nothing to send, and a silent `continue`
      // is how a branch drops out of the pass with no line anywhere. Journaled
      // per branch so the finish result can name it (§10.7 `withheldPushes`).
      appendJournal(dir, { action: 'push-withheld', branch, reason: 'no local ref at push time' });
      console.error(`push: not pushing ${branch} — it has no local ref`);
      continue;
    }
    const localTip = await revParse(cli.repo, branch);
    const originRef = `origin/${branch}`;
    if (!(await refExists(cli.repo, originRef))) {
      intents.push({ branch, state: 'create', localTip });
      continue;
    }
    const originTip = await revParse(cli.repo, originRef);
    if (originTip === localTip) intents.push({ branch, state: 'up-to-date', localTip });
    else if (await isAncestor(cli.repo, originTip, localTip)) intents.push({ branch, state: 'push', localTip });
    // Origin strictly ahead: someone else committed — higher is fine.
    else if (await isAncestor(cli.repo, localTip, originTip)) intents.push({ branch, state: 'remote-ahead', localTip });
    else intents.push({ branch, state: 'diverged', localTip });
  }

  // JUDGED PRs published this pass — their closure is checked after the pushes.
  const judgedPrs = journal.filter((e) => e.action === 'pr-published' && e.mode === 'judged');
  const dueUrges = await detectUrges(cli, ctx, journal);

  // Verify gate (§9): nothing is pushed before verify is green.
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
      "no green `verify` journal entry after the pass's last mutation — run `propagate verify --execute` first (§9)";
    console.error(`push [ERR18_VERIFY_PENDING]: ${detail}`);
    emit(cli, { ok: false, issues: [{ id: 'ERR18_VERIFY_PENDING', detail }] });
    return 1;
  }

  // (1) Target pushes — ONE push per branch, plan order.
  // PUSH RESILIENCE: each target pushes INDEPENDENTLY — a
  // failure is journaled per branch (`push-failed`, categorized) and the loop
  // FINISHES THE REST; ERR15 stays the per-branch failure LABEL but is no
  // longer a stop. Verify already validated each publishable branch
  // independently, so a partial land is safe; landed branches are up-to-date
  // (skipped) on the next push, failed ones retry.
  const pushed: string[] = [];
  type PushFailCategory = 'diverged' | 'transient' | 'auth' | 'rejected';
  const pushFailed: Array<{ branch: string; category: PushFailCategory; detail: string }> = [];
  const categorize = (msg: string): PushFailCategory => {
    // A pre-receive-hook / permission rejection is NOT divergence:
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
  // Categories that can NEVER self-heal by retrying: the owner must
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
        `push target '${intent.branch}' has DIVERGED from origin — owner escalation, never force-resolve; the other targets proceed`,
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
            ? 'owner escalation, never force-resolve; the other targets proceed'
            : category === 'rejected'
              ? 'owner escalation: a hook/branch-protection rejection cannot heal by retrying; the other targets proceed'
              : 'report to the owner; the other targets proceed and this branch retries on the next finish'),
      );
    }
  }

  // APPROVED-landing rollback escalations pending a post: the
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
  // contract as publish.
  const needsNetwork = judgedPrs.length > 0 || dueUrges.length > 0 || pendingApprovedEscalations.length > 0;
  let transport: GithubTransport | null = null;
  let slugParts: { owner: string; repo: string } | null = null;
  if (needsNetwork) {
    let token: string | null = null;
    token = resolveGithubToken(cli);
    if (!token) {
      issues.push({
        id: 'ERR11_TOKEN_MISSING',
        detail:
          'closure checks / urge posting need the substitute GitHub token in the environment: export GH_TOKEN (or GITHUB_TOKEN)',
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

  // (2) JUDGED closure check: every judged PR must have auto-flipped.
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

  // (2b) APPROVED-landing rollback escalations: tell the owner
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
        issues.push(
          apiFailureIssue(
            cli,
            err,
            `approved-rollback escalation for '${String(esc.branch)}' (PR #${esc.prNumber}) failed (retries on the next push)`,
          ),
        );
      }
    }
  }

  // (3) Urge posting (§8): post FIRST — the journal row and the comment's
  // own `sweep-urge` marker land only after a successful post, so a failed urge
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
        // ORIGIN-DERIVED DEDUP: the PR's own comments say whether this head was
        // already urged. Cheap (one paginated read per due urge, and urges are
        // rare), and it cannot go stale the way a local cache field can.
        if ((await urgedHeads(transport, slugParts, prNumber)).has(urge.head)) {
          appendJournal(dir, { action: 'urge-skip', branch: urge.branch, head: urge.head, reason: 'already urged for this head' });
          continue;
        }
        const commentBody = await urgeCommentBody(cli, urge);
        // Refresh the machine block on the PR body, then post the comment.
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
        urged.push({ branch: urge.branch, head: urge.head, prNumber });
      } catch (err) {
        issues.push({
          id: 'ERR17_URGE_FAILED',
          detail: `urge for '${urge.branch}' failed: ${err instanceof Error ? err.message : String(err)} — no urge marker was posted, so it retries on the next push`,
        });
      }
    }
  }

  // Blocking NON-push issues (ERR16/ERR17/token/API) are journaled as
  // `push-issue` rows: `finish` reads only the journal delta, so
  // without these rows a partial finish would silently drop them from the
  // SWEEP-RESULT whenever per-branch push failures also occur.
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
  // The recipe = every branch with nothing blocked at or above it, in the
  // plan's DAG order, built on the fork-trunk base. It is derived from the pass
  // and nothing else: a gate that validated a fixed config stack instead would
  // pin a permanently-blocked branch at its head and could never go green.
  const order = passOrder(dir);
  const ancestorsOf = transitiveAncestors(Object.fromEntries(directParentEdges(cli)));
  const blocked = blockedForRecipe(cli, journal);
  // A branch with no ref here cannot be merged, and `git merge` on a name that
  // does not resolve aborts the whole gate. Drop it LOUDLY: a build that
  // silently covered less than it claims is the one failure this gate cannot
  // afford.
  const recipe: string[] = [];
  const unresolvable: string[] = [];
  for (const b of publishableRecipe(order, blocked, ancestorsOf)) {
    ((await refExists(cli.repo, b)) ? recipe : unresolvable).push(b);
  }
  if (unresolvable.length > 0) {
    appendJournal(dir, { action: 'verify-recipe-dropped', branches: unresolvable, reason: 'no local ref' });
    console.error(`verify: recipe branch(es) with no local ref, excluded from the rebuild: ${unresolvable.join(', ')}`);
  }
  const baseRef = await verifyBaseRef(cli);
  const rrCacheDir = join(cli.workspace, RR_CACHE_DIRNAME);
  // An in-memory command list (finish threads checks.test here) wins,
  // then `--commands-file`, then the static VERIFY_COMMANDS default.
  const commands: VerifyCommand[] = cli.commands
    ? cli.commands
    : cli.commandsFile
      ? (JSON.parse(readFileSync(cli.commandsFile, 'utf8')) as VerifyCommand[])
      : VERIFY_COMMANDS;
  // The dependency links, applied to the VERIFY worktree too — the same as the
  // case and gate-fix worktrees. Without them the finish-time verify typechecks
  // without `@types/node` or `vitest` and is
  // red on every pass regardless of content (see VerifyOptions.prepareWorktree).
  const verifyOpts = {
    commands,
    baseRef,
    rrCacheDir,
    // The verify worktree is base + every publishable branch merged, so its
    // manifests are the MERGED ones and nothing else can describe them.
    // (Linking the clone's trees instead would be the same environment gap.)
    prepareWorktree: async (wtPath: string) => {
      const ok = (await installDeps(cli, wtPath)).ok;
      return ok ? WORKTREE_DEP_LINKS : [];
    },
  };

  if (recipe.length === 0) {
    if (order.length === 0) {
      // No plan on disk: `start` always writes one, so the pass this attached
      // to is not a pass. Nothing is verified and nothing is claimed green.
      console.error('verify: no plan in the pass directory — nothing to derive a recipe from');
      return 2;
    }
    // A plan exists but every branch has something blocked at or above it —
    // vacuously green (nothing to integrate, nothing to push). Everything
    // blocked is reported, not gated: a pass where every branch froze must
    // still complete.
    appendJournal(dir, { action: 'verify', ok: true, note: 'empty recipe (every branch is blocked or under a block)' });
    console.error('verify: green (no unblocked branches to rebuild)');
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
  // TWO SHAPES OF RED, and they need DIFFERENT evidence.
  //
  // A recipe branch that would not MERGE fails before a single command runs:
  // no base probe, no failing tests, no output. Journaling the test-shaped
  // fields there writes an accusation whose every evidence field is empty —
  // exactly the bare row the auditability rule below forbids — and a reader who
  // trusts them concludes "blamed on nothing". The evidence for THIS failure is
  // the conflicted paths and what got merged before the offender, so journal
  // that instead and say plainly which kind of failure it was.
  const buildConflict = !first.build.ok;
  appendJournal(dir, {
    action: 'verify',
    ok: false,
    offender: first.offender ?? null,
    failureKind: buildConflict ? 'merge-conflict' : 'checks',
    ...(buildConflict
      ? {
          // Never a `?? null` placeholder: the build sets this whenever it stops
          // on a conflict, so a null here would be a claim nobody measured.
          ...(first.build.conflictBranch ? { conflictBranch: first.build.conflictBranch } : {}),
          // The paths git left conflicted, and the branches that DID merge
          // ahead of the offender — together they say what the offender
          // collided with and where.
          unresolved: first.build.unresolved ?? [],
          merged: first.build.merged,
        }
      : {
          // What the base probe SAW, on every checks red. A verdict of "this
          // branch did it" is a claim that the merged tree fails something the
          // BASE does not, and that claim has to be auditable from the journal
          // alone — otherwise a correct attribution and a missed base defect
          // read exactly the same, and branches get rolled back for a defect
          // that was never theirs.
          baseFailingFiles: first.baseFailingFiles ?? [],
          mergedFailingFiles: first.mergedFailingFiles ?? [],
          // Whether the BASE ALONE was green. A bare offender row —
          // no commands, no output, no base verdict — is an
          // accusation that cannot be checked without re-running the pass by hand.
          // A branch is only credibly to blame if the base was green.
          baseGreen: first.baseGreen ?? null,
          ...(first.baseFailedCommands?.length ? { baseFailedCommands: first.baseFailedCommands } : {}),
          // The failing commands on EVERY checks red, not only the
          // unattributable ones — the attributed path is precisely the one that
          // accuses a branch and rolls it back, so it must carry its
          // diagnostics too.
          failedCommands: first.commands.filter((c) => c.code !== 0).map((c) => c.cmd),
        }),
    ...(first.nonDeterministic ? { nonDeterministic: true, flakyCommands: first.flakyCommands ?? [] } : {}),
  });
  // The one sentence that says what actually happened when the rebuild hit a
  // CONFLICT, reused by every arm that reports the offender. Without it a
  // build-shaped failure is narrated in the checks-red wording — "red, fix the
  // tests, investigate the diff" — for a failure where no test ever ran, and
  // the reader goes looking for evidence that does not exist.
  const conflictDetail = buildConflict
    ? `${first.build.conflictBranch ?? '(unknown branch)'} could not be merged into the integration rebuild; ` +
      `unresolved conflicts in ${(first.build.unresolved ?? []).join(', ') || '(no paths reported)'}` +
      (first.build.merged.length
        ? ` — merged ahead of it: ${first.build.merged.join(', ')}`
        : ' — nothing merged ahead of it')
    : null;
  // A NON-DETERMINISTIC red belongs to no branch, so there is nothing to
  // attribute, roll back or gate-fix. Say that plainly instead of the generic
  // "investigate" — the agent's next move is completely different (report the
  // flaky command to the owner, do not go hunting through a branch's diff).
  if (first.nonDeterministic) {
    const flaky = first.flakyCommands ?? [];
    const detail =
      `verify is NON-DETERMINISTIC: ${flaky.join(', ')} failed and then PASSED on a re-run of the same tree. ` +
      `No branch caused this and none was rolled back — attribution would have blamed whichever branch was ` +
      `removed when the test happened to pass. Report the flaky command(s) to the owner.`;
    appendJournal(dir, { action: 'verify-non-deterministic', id: 'WARN17_VERIFY_FLAKY', flakyCommands: flaky, detail });
    console.error(`verify: ${detail}`);
    emit(cli, { ok: false, nonDeterministic: true, flakyCommands: flaky, issues: [{ id: 'WARN17_VERIFY_FLAKY', detail }] });
    return 1;
  }
  // BASE-RED: the failure reproduces on the base with no recipe branch merged,
  // so no branch is responsible and none is rolled back. Reported in the SAME
  // shape as an unattributable red — failing commands, cwds, full output — so
  // finish's existing gate-fix path roots it on the base branch ON THE FIRST
  // RED, which is a HELD PR that blocks every branch beneath it — instead of
  // peeling one branch per pass the long way round.
  if (first.baseRed) {
    const baseFailed = (first.baseCommands ?? []).filter((c) => c.code !== 0);
    const failedCommands = baseFailed.map((c) => c.cmd);
    const failedCwds = baseFailed.map((c) => commands.find((v) => v.cmd === c.cmd)?.cwd ?? '');
    const fullText = baseFailed.map((c) => `$ ${c.cmd}\n${c.output}`).join('\n');
    const failedOutputFile = join(dir, 'verify-output.full.txt');
    try {
      writeFileSync(failedOutputFile, fullText);
    } catch (e) {
      console.error(`verify: could not write the full log: ${e instanceof Error ? e.message : String(e)}`);
    }
    const summary = failureSummary(fullText, failedOutputFile);
    const failedOutput = [summary, '', fullText].join('\n').slice(-VERIFY_OUTPUT_JOURNAL_CAP);
    const detail =
      `the failure reproduces on ${baseRef} with NO recipe branch merged — it is PRE-EXISTING in the base. ` +
      `No branch caused it and none was rolled back; root it at ${baseRef} (gate fix + HELD PR), which blocks ` +
      `every branch beneath it.`;
    appendJournal(dir, {
      action: 'verify',
      ok: false,
      attributionFailed: true,
      baseRed: true,
      baseRef,
      failedCommands,
      failedCwds,
      failedOutput,
      failedOutputFile,
      ...(summary ? { failureSummary: summary } : {}),
      detail,
    });
    console.error(`verify: BASE-RED — ${detail}`);
    emit(cli, { ok: false, baseRed: true, baseRef, attributionFailed: true, commands: first.commands });
    return 1;
  }
  const offender = first.offender;
  if (!offender) {
    // Expose the failed command names so finish can render a factual
    // "tests failed at finish — <list>" STOP result.
    // ALSO journal the failing OUTPUT. finish cannot attribute an
    // unattributable red to a branch without the diagnostics — file paths live
    // in the compiler output, not in a command name — and the VerifyResult
    // itself never reaches finish; only this journal row does. Bounded so a
    // chatty runner cannot bloat the journal.
    const failedCmds = first.commands.filter((c) => c.code !== 0);
    const failedCommands = failedCmds.map((c) => c.cmd);
    // …and each failing command's CWD. A command rooted in a sub-package prints
    // paths relative to ITS directory; without the cwd here, finish hands blame a
    // `src/…` that means something else at the repo root (rootChecksOutput).
    const failedCwds = failedCmds.map((c) => commands.find((v) => v.cmd === c.cmd)?.cwd ?? '');
    const fullText = failedCmds.map((c) => `$ ${c.cmd}\n${c.output}`).join('\n');
    // The FULL log goes to disk; the journal keeps a bounded view plus the path.
    // Blame reads the FILE (see `attributionOutput`), so a long failure is
    // attributed completely instead of being scoped to whatever fits in the
    // journal cap — which would scope a gate-fix case to only the files that
    // happen to land in the tail.
    const failedOutputFile = join(dir, 'verify-output.full.txt');
    try {
      writeFileSync(failedOutputFile, fullText);
    } catch (e) {
      console.error(`verify: could not write the full log: ${e instanceof Error ? e.message : String(e)}`);
    }
    const summary = failureSummary(fullText, failedOutputFile);
    const failedOutput = [summary, '', fullText].join('\n').slice(-VERIFY_OUTPUT_JOURNAL_CAP);
    appendJournal(dir, {
      action: 'verify',
      ok: false,
      attributionFailed: true,
      failedCommands,
      failedCwds,
      failedOutput,
      failedOutputFile,
      ...(summary ? { failureSummary: summary } : {}),
    });
    console.error('verify: RED — no single-branch attribution (leave-one-out did not isolate an offender)');
    emit(cli, { ok: false, attributionFailed: true, commands: first.commands });
    return 1;
  }
  const preRef = lastPreRef(journal, offender);
  // AN OFFENDER THIS PASS NEVER MUTATED IS NOT A PUBLISHABLE FAILURE. The
  // recipe is every branch with nothing blocked at or above it, whether or not
  // it advanced, so a branch that merged nothing this pass is an ordinary
  // member of the integration build — and there is no `pre-ref` to roll it back
  // to, so the blocking path below would freeze a branch for a merge it never
  // made and roll back a state it never left. Journal a non-blocking gate
  // OBSERVATION instead, re-verify the publishable set without it, and let the
  // rest proceed. ERR18 fires ONLY for a branch that WOULD be pushed this pass.
  if (!preRef) {
    appendJournal(dir, {
      action: 'verify-observation',
      ok: false,
      offender,
      ...(conflictDetail ? { failureKind: 'merge-conflict', detail: conflictDetail } : {}),
      note: 'offender has no pre-ref — non-blocking (not mutated this pass)',
    });
    const reduced = recipe.filter((b) => b !== offender);
    const re = reduced.length > 0 ? await verifyEverything(cli.repo, { recipe: reduced, ...verifyOpts }) : null;
    const reOk = re ? re.ok : true;
    appendJournal(dir, {
      action: 'verify',
      ok: reOk,
      offender,
      excluded: offender,
      nonBlocking: true,
      // Same naming as the blocking arm: this row's `ok` is the re-verify's
      // verdict, so what the EXCLUSION was for goes in its own field.
      ...(conflictDetail ? { excludedFor: 'merge-conflict', unresolved: first.build.unresolved ?? [] } : {}),
    });
    console.error(
      `verify: RED offender ${offender} was not mutated this pass — non-blocking; ` +
        `${conflictDetail ? `${conflictDetail}; ` : ''}` +
        `${re ? `re-verify without it ${reOk ? 'green' : 'STILL RED'}` : 'no publishable branches remain'}`,
    );
    emit(cli, {
      ok: reOk,
      offender,
      nonBlocking: true,
      excluded: offender,
      // `excludedFor`, not `failureKind`: `ok` here is the RE-VERIFY's verdict,
      // and naming the conflict as this result's failure kind labels a GREEN
      // answer a merge conflict — the same mistake the blocking arm fixes.
      ...(conflictDetail
        ? { excludedFor: 'merge-conflict', unresolved: first.build.unresolved ?? [], detail: conflictDetail }
        : {}),
      reverify: { ok: reOk },
    });
    return reOk ? 0 : 1;
  }
  // Offender is a PUBLISHABLE branch with a journaled pre-ref → the gate bites:
  // roll it back to its pre-ref, HELD(gate), then re-verify (its
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
  // A GATE hold is not a case: the branch was rolled back and dropped from the
  // publishable set, with no conflict, no head and no merge behind it. It
  // deliberately carries NO `height` or `conflictedPaths` — those would be
  // placeholders claiming a measurement nobody took. Nothing reads them (no
  // `case` row is ever journaled for a `gate-*` id, so the head lookup in
  // `deriveLive` correctly misses and records a null headSha), but a fake
  // height in a typed-looking field is exactly the shape that corrupts height
  // readers like `pendingAbove = heads.length - 1 - head.height`. Omit them:
  // absent says "not applicable", `-1` says "measured, and the answer is -1".
  appendJournal(dir, {
    action: 'held',
    branch: offender,
    caseId: `gate-${offender.replace(/\//g, '__')}`,
    reason: 'gate',
    // WHY this branch was frozen, in the row that freezes it. A gate hold on a
    // conflict is otherwise indistinguishable from one on a red test suite, and
    // the two ask the reader for entirely different evidence. Both kinds are
    // NAMED — absence would have to be read as "checks", which is a guess.
    failureKind: conflictDetail ? 'merge-conflict' : 'checks',
    ...(conflictDetail ? { detail: conflictDetail } : {}),
  });
  // APPROVED-LANDING offender: the rolled-back merge
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
  // Gate hold: the journaled `held` row above IS the PR_ID state
  // for the rest of the pass — no conflicting head / PR (blockedRows keeps
  // headSha null), so it cannot auto-complete; the owner clears it manually.
  // Cross-pass a gate hold leaves nothing on origin, so the next `start`
  // re-derives the branch unblocked and the offending merge is simply retried.
  // Re-verify on the publishable set with the offender now rolled back + held —
  // it drops out of the recipe so its bad merge is excluded.
  const reRecipe = recipe.filter((b) => b !== offender);
  const re = await verifyEverything(cli.repo, { recipe: reRecipe, ...verifyOpts });
  // THIS ROW IS THE RE-VERIFY'S VERDICT, not the rollback's. Its `ok` describes
  // the publishable set WITHOUT the offender, so the conflict fields must not be
  // named as if they described it — `failureKind` here would label a GREEN row
  // `merge-conflict`, and a row red for an unrelated reason would wear the
  // conflict as its cause. `rolledBackFor` says what the rollback was for and
  // leaves the verdict to `ok`.
  //
  // The re-verify's own failing commands are journaled too: this red belongs to
  // the branches that remain, the conflict did not cause it, and without them
  // the only record of it is an `ok: false` with no evidence at all.
  const reFailed = re.commands.filter((c) => c.code !== 0).map((c) => c.cmd);
  appendJournal(dir, {
    action: 'verify',
    ok: re.ok,
    offender,
    rolledBack: offender,
    ...(conflictDetail
      ? { rolledBackFor: 'merge-conflict', unresolved: first.build.unresolved ?? [], detail: conflictDetail }
      : {}),
    ...(re.ok ? {} : { reverifyFailedCommands: reFailed }),
  });
  console.error(
    `verify: ${conflictDetail ?? 'RED'} -> rolled back ${offender} to ${preRef.slice(0, 12)}, HELD(gate); ` +
      `re-verify ${re.ok ? 'green' : `STILL RED (${reFailed.join(', ') || 'no command named'})`}`,
  );
  emit(cli, {
    ok: re.ok,
    offender,
    rolledBack: offender,
    ...(conflictDetail
      ? { rolledBackFor: 'merge-conflict', unresolved: first.build.unresolved ?? [], detail: conflictDetail }
      : {}),
    reverify: { ok: re.ok, ...(re.ok ? {} : { failedCommands: reFailed }) },
  });
  return re.ok ? 0 : 1;
}

/**
 * The end-of-sweep owner summary, derived PURELY from the journal
 * (no git, no GitHub) so a dead or abnormally-terminated session still leaves a
 * readable status. The owner message the agent sends at end-of-sweep is a
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
  if (mergeFailed.length) console.log(`merge-failed: ${mergeFailed.join(', ')}`);
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
  // When driven internally by `finish`, do NOT write --out — that file is
  // the outer command's result; the human summary above still prints (ignored by
  // the SWEEP-RESULT/SWEEP-STEP monitor contract, but useful in a foreground run).
  if (cli.out && !cli.internal) {
    writeFileSync(cli.out, JSON.stringify(summary, null, 2) + '\n');
    console.log(`wrote ${cli.out}`);
  }
  return 0;
}

// ==========================================================================
// Sweep state machine (DRIVER.md §1). The canonical
// AGENT-FACING surface: five commands (start / next-case / report-case /
// report-pr / finish) plus `abort`, driven by a resumable machine-state record
// in the pass dir. The agent has ZERO identifying params — the driver holds the
// watermark, the current case, the phase and the journal — which structurally
// removes the wrong-case / wrong-ref / stale-verdict / forged-plan bug classes
// (DRIVER.md §1). These functions WRAP the deterministic
// internals above (plan/run/reverify/merge/publish/verify/push) — they never
// re-implement them. The ONLY LLM call in the loop is the cold read, run here
// via an INJECTABLE invoker that shells `claude -p` (default) — there is NO
// verdict file and NO freshness binding on this path (the driver holds the
// resolved tree and pipes the request straight to `claude -p`). The flag-based
// `resolve`/`publish` path (verdict file + freshness binding) remains the
// driver's tested implementation + reused sub-helpers, but these commands are
// the AGENT surface — the flag path is never handed to the agent.
// ==========================================================================

/** Machine phases (DRIVER.md §6.7): a dead container resumes here. */
type MachinePhase = 'open' | 'case-ready' | 'awaiting-pr' | 'finishing' | 'complete';

interface MachineState {
  schemaVersion: 1;
  phase: MachinePhase;
  watermark: string;
  watermark12: string;
  /** The case the agent is currently editing/reporting (driver-held). */
  currentCase: { caseId: string; branch: string; tier?: 'mechanical' | 'judged' | 'held' } | null;
  /** Resumable `finish` sub-phase (finishing only). */
  finishStep?: 'verify' | 'judged-prs' | 'push' | 'held-prs' | 'report' | 'done';
  /**
   * The pass's resolved config paths, pinned at `start` and read from
   * state by every later command (the agent passes no such flag mid-pass).
   * `inventory` — absolute inventory dir (undefined → the committed scripts/sweep/inventory);
   * `checksFile` — absolute path to the host+runner typecheck/test command JSON.
   */
  inventory?: string;
  checksFile?: string;
}

/**
 * Apply the pass's PINNED config paths (resolved + persisted at `start`)
 * onto the CLI so the deterministic internals (loadRegistry via cli.inventory,
 * the checks gate via the returned path) see the pass's config, not whatever the
 * later invocation happened to pass. Returns the persisted checks-file path.
 */
function applyPassConfig(cli: Cli, st: MachineState | null): string | undefined {
  if (st?.inventory !== undefined) cli.inventory = st.inventory;
  return st?.checksFile;
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
// Cold read — injectable `claude -p` invoker (the ONLY LLM call in the
// loop). The driver composes a FOCUSED request (the judge-from-the-request-only
// preamble + three bounded
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
   * decision. It must NOT collapse to reject/HELD: a broken tool marking
   * resolutions as content-rejected is the bug this distinguishes. `error` maps
   * to a hard blocking halt (ERR35_COLDREAD_UNAVAILABLE) at the call sites.
   */
  verdict: 'confirm' | 'reject' | 'error';
  answers?: Partial<Record<'q1' | 'q2' | 'q3', string>>;
  notes: string;
  /**
   * Short (1-2 line) reviewer feedback for the RESOLVING AGENT: why
   * the rejection / what is off. Surfaced on a reject so the agent can act;
   * reused as the PR-description prefix on a HELD escalation. Bounded
   * (COLDREAD_FEEDBACK_CAP) at parse.
   */
  feedback?: string;
  /** verdict:'error' only — the infra reason (surfaced in the ERR35 halt detail). */
  reason?: string;
  /**
   * Parsed but not acted on: a reader may still emit it to classify a reject
   * as a PR-prose defect vs a resolution defect, but the gate runs at
   * `report-case` with no prose in sight, so
   * every reject is a resolution reject — see `coldReadRejectionCount`.
   */
  defect?: 'code' | 'description' | null;
}

/** Auth/login failure text a broken `claude -p` prints (often at exit 0) — infra, not content. */
const COLDREAD_AUTH_FAILURE = /not logged in|invalid api key|authentication_error|unauthorized|please run.*login|login expired|credit balance is too low/i;

/** Injectable cold-read invoker: prompt in, verdict out (default shells `claude -p`). */
export type ColdReadInvoker = (prompt: string) => Promise<MachineVerdict>;

/**
 * Parse the last JSON object printed by `claude -p`. A valid confirm/reject is a
 * content decision. Otherwise → `error`: recognizable auth/login failure
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
  return { verdict: 'error', notes: '', reason: 'cold read produced no parseable verdict (tooling error)' };
}

/**
 * Default invoker: a synchronous `claude -p` subprocess, request on stdin.
 * `claude` scrubs env for its own Bash subprocesses, so the spawned `claude -p`
 * loses CLAUDE_CODE_OAUTH_TOKEN — read it from the credentials file and inject it
 * (silent if the file is unreadable: fall through to the infra-error path, never
 * crash). A spawn error / non-zero exit → `error` (infra), never a content reject.
 */
/** Default backoff (ms) before cold-read attempts: immediate, then a widening
 * wait for an AUTOMATED auth refresh to land in the credentials file. */
const COLDREAD_BACKOFF_MS = [0, 5000, 15000, 30000];

/**
 * Retry wrapper for a single-shot cold read. Auth is refreshed AUTOMATICALLY
 * into the credentials file, but not instantly — a cold-started container or a
 * mid-run token rotation can make `claude -p` print "Not logged in" for a few
 * seconds. A `verdict:'error'` is an INFRA/auth failure, so we wait and
 * retry (the `attempt` re-reads the token fresh each call, so a retry picks up
 * the just-refreshed token). A real confirm/reject is a content decision and
 * returns immediately — never retried. Only after the whole backoff is spent
 * does the infra error propagate (→ ERR35). Injectable backoff (tests pass
 * zeros); exported for unit tests.
 */
export async function coldReadWithRetry(
  attempt: () => MachineVerdict,
  backoffMs: number[] = COLDREAD_BACKOFF_MS,
): Promise<MachineVerdict> {
  let last: MachineVerdict = { verdict: 'error', notes: '', reason: 'cold read not attempted' };
  for (let i = 0; i < backoffMs.length; i++) {
    if (backoffMs[i] > 0) await new Promise((r) => setTimeout(r, backoffMs[i]));
    last = attempt();
    if (last.verdict !== 'error') return last; // content decision (confirm/reject) — done
    // else: infra/auth failure — wait and retry with a freshly-read token
  }
  return last;
}

export const defaultColdReadInvoker: ColdReadInvoker = (prompt) =>
  coldReadWithRetry(() => {
    const env = { ...process.env };
    // Re-read the token from the credentials file EVERY attempt: auth is
    // auto-refreshed into this file, so a retry after a transient "Not logged
    // in" must pick up the NEW token rather than reuse a stale env value. The
    // file (when it carries a token) is the fresh source of truth; the ambient
    // env is only the fallback when the file is unreadable/tokenless.
    try {
      const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
      if (creds?.claudeAiOauth?.accessToken) env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeAiOauth.accessToken;
    } catch {
      /* credentials unreadable — fall through to the infra-error path */
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
  });

/**
 * Fail-closed reduction shared by both cold reads: an overall
 * `reject`, OR an `UNVERIFIABLE-FROM-REQUEST` answer on any of Q1-Q3, is a
 * reject. Returns the unverifiable question list for the notes.
 */
function coldReadRejected(v: MachineVerdict): { rejected: boolean; unverifiable: string[] } {
  const unverifiable = (['q1', 'q2', 'q3'] as const).filter((q) =>
    /UNVERIFIABLE-FROM-REQUEST/i.test(String(v.answers?.[q] ?? '')),
  );
  return { rejected: v.verdict === 'reject' || unverifiable.length > 0, unverifiable };
}

/**
 * The FOCUSED cold-read prompt for the state-machine path — same preamble,
 * three bounded questions and driver-derived context as `coldReadRequest`, but
 * asking `claude -p` to PRINT a JSON verdict (no verdict file).
 *
 * The reader judges the RESOLUTION only. It runs at `report-case`, before
 * any PR text exists, so there is no description to review and no defect to
 * classify — a reject is always a resolution reject.
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
  gateFix?: { failedOutput: string } | null;
  /**
   * `--not-my-bug` widening: files added to the edit scope because the merge
   * itself is red while both sides are green in isolation. Without telling the
   * reviewer, it sees a resolution diff touching files it was told are not part
   * of the conflict — the standard reject shape — and two rejects escalate the
   * case to HELD for doing exactly what the driver instructed.
   */
  widenedPaths?: { files: string[]; reason: string } | null;
}): string {
  const gf = opts.gateFix ?? null;
  const lines: string[] = [
    `# Cold-read request — ${opts.id} (state-machine path)`,
    '',
    ...COLD_READ_PREAMBLE,
    '',
    ...(gf
      ? [
          `Branch: ${opts.branch}   GATE FIX (no merge — this change resolves no conflict)`,
          `Failing files: ${opts.conflictedPaths.join(', ')}`,
        ]
      : [
          `Branch: ${opts.branch}   Parent: ${opts.parent}   Height: ${opts.height}`,
          `Conflicted paths: ${opts.conflictedPaths.join(', ')}`,
        ]),
    '',
    ...(opts.widenedPaths && opts.widenedPaths.files.length > 0
      ? [
          `SCOPE WIDENED BY THE DRIVER: ${opts.widenedPaths.files.join(', ')}`,
          `Reason: ${opts.widenedPaths.reason}`,
          'Edits to those files are IN SCOPE for this case and resolve no conflict markers —',
          'judge them as the fix for the failure named above, not as a scope violation.',
          '',
        ]
      : []),
    ...opts.contextLines,
    '',
    ...(gf
      ? gateFixEvidenceLines(gf.failedOutput)
      : ['## Conflict hunks (branch tip -> automerge tree)', '```diff', opts.conflictDiff, '```']),
    '',
    gf ? '## The fix (branch tip -> resolved tree)' : '## Resolution diff (automerge tree -> resolved tree)',
    ...(opts.resolutionDiff === null
      ? [
          '_No resolution — this is a frozen-conflict (HELD) exhibit; judge the description against the conflict above._',
        ]
      : ['```diff', opts.resolutionDiff, '```']),
  ];
  lines.push(
    '',
    '## Cold-reader questions',
    ...(gf ? GATE_FIX_COLD_READ_QUESTIONS : COLD_READ_QUESTIONS),
    '',
    '## Output',
    'Print ONLY a JSON object on the final line — no prose around it:',
    '```json',
    '{"verdict":"confirm|reject","answers":{"q1":"...","q2":"...","q3":"..."},"notes":"...","feedback":"..."}',
    '```',
    '- `reject` if any of Q1-Q3 fails, or answer `UNVERIFIABLE-FROM-REQUEST` for a point you cannot judge (fail-closed).',
    '- `feedback`: 1-2 lines for the RESOLVING AGENT — why the reject / what is off (omit when nothing is).',
  );
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Branch-scoped tests — a CHEAP per-case gate, NOT the finish-time
// everything-rebuild (§9). Injectable so tests never spawn a real matrix;
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

/** The driver-prepared case worktree path (createCaseWorktree). */
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

/**
 * WHERE the conflict markers are, per pending file, as line ranges.
 *
 * The driver computed the merge, so it knows every hunk's position exactly.
 * Handing the agent only the file NAMES makes it PAGE a 2000-line file to find
 * the hunks — re-reading the same paths over and over — while the materials
 * instruct "each file once, never re-reading": an instruction the missing
 * information would make impossible to follow.
 *
 * Line ranges, not hunk CONTENT. The agent must read the real file anyway (Edit
 * requires it), so shipping the text would be an extra read, not a substitute.
 * Ranges turn "page the file to find the markers" into "read these two windows",
 * which satisfies the same precondition and is what the re-reads would be
 * spent on.
 */
async function conflictHunkRanges(repo: string, wtPath: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rel of paths) {
    let text: string;
    try {
      text = readFileSync(join(wtPath, rel), 'utf8');
    } catch {
      continue; // deleted on one side — no markers to point at
    }
    const lines = text.split('\n');
    const ranges: string[] = [];
    let start: number | null = null;
    lines.forEach((l, i) => {
      if (l.startsWith('<<<<<<<')) start = i + 1;
      else if (l.startsWith('>>>>>>>') && start !== null) {
        ranges.push(`${start}-${i + 1}`);
        start = null;
      }
    });
    if (ranges.length > 0) out.push(`- ${rel} — ${ranges.length} hunk(s) at lines ${ranges.join(', ')}`);
    else out.push(`- ${rel} — no markers (add/delete or already resolved)`);
  }
  return out;
}

/** Driver-authored case materials for the case-ready hand-off. */
/**
 * THE MERGE BRIEFING — the same for a conflict whoever is looking at it.
 *
 * What constrains a resolution is the two sides, what each of them did over the
 * conflicted paths, and which feature owns the code (doctrine §5). None of that
 * changes because the resolution has been published once and reviewed: a
 * reissue is the SAME merge, and an agent revising it needs the same facts as
 * the agent that first resolved it. Served in one shape so it cannot go missing
 * from one kind of case and be present in another.
 */
async function conflictBriefing(cli: Cli, dir: string, jc: JournaledCase): Promise<string[]> {
  const tip = await revParse(cli.repo, jc.branch);
  const sides = await perSideLog(cli.repo, tip, jc.head.sha, jc.conflictedPaths);
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  return [
    '## Conflicted paths (the pending files — your edit scope)',
    // Ranges only here: by `prepareCaseMaterials` the conflict is RESOLVED, so
    // there are no markers left to point at.
    'Line numbers are where the markers ARE — read those windows, not the file.',
    ...(await conflictHunkRanges(cli.repo, caseWorktreePath(dir, jc.caseId), jc.conflictedPaths)),
    '',
    `Branch: ${jc.branch}   Parent: ${jc.parent}   Head: ${jc.head.sha.slice(0, 12)} (height ${jc.head.height})`,
    '',
    ...inventoryContextLines(registry.features, jc.branch, jc.parent, jc.conflictedPaths),
    '',
    ...perSideBlocks(sides, jc.branch, jc.parent),
  ];
}

async function machineCaseMaterials(cli: Cli, dir: string, jc: JournaledCase): Promise<string> {
  return [
    `# Case materials — ${jc.caseId}`,
    '',
    ...CASE_DIRECTIVES,
    '',
    ...(await conflictBriefing(cli, dir, jc)),
    '',
    'Resolve the conflict in the worktree above, then run `report-case --tier mechanical|judged|held`.',
  ].join('\n');
}

/**
 * One turn of the reissue DIALOG: the FULL review conversation —
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
  // Same reality bound as the trigger — a human comment pasting an
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

async function reissueCaseMaterials(
  cli: Cli,
  dir: string,
  jc: JournaledCase,
  caseRow: JournalEntry,
): Promise<string> {
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
    // THE SAME BRIEFING A FIRST-TIME CASE GETS. A reissue is the same merge, and
    // the review is a reason to revise it, not a substitute for knowing what the
    // two sides did. Without this the agent is handed a conversation and a list
    // of filenames and has to reconstruct the merge from the diff.
    ...(await conflictBriefing(cli, dir, jc)),
    '',
    ...(Array.isArray(caseRow.carriedPaths) && caseRow.carriedPaths.length
      ? [
          '## Files your published resolution reached outside the conflict',
          'These are pending too, holding what the published resolution left there — the call sites you',
          'updated, the signature you changed. They are NOT new conflicts and they are in scope: keep them',
          'consistent with the revision, and say so in the PR text if the reviewer asked about the reach.',
          ...(caseRow.carriedPaths as string[]).map((p) => `- ${p}`),
          '',
        ]
      : []),
    `Existing PR: #${caseRow.prNumber}${typeof caseRow.prUrl === 'string' ? ` (${caseRow.prUrl})` : ''} — the revision replaces its head (fix ref '${caseRow.fixBranch}').`,
    '',
    'Revise the resolution in the worktree above, then run `report-case --tier held`.',
  ].join('\n');
}

/** Undispositioned cases this pass, topmost-first (DAG order = journal order). */
/**
 * Cases SUPERSEDED by a later reopen. Resolving a case reopens its
 * branch + descendants (§8); the next `run` re-derives each reopened branch
 * against its now-ADVANCED parent and re-emits a FRESH case — new conflict
 * head, new height (so a new caseId), new conflict set. The pre-reopen case is
 * never dispositioned (it was superseded, not resolved), so every "open case"
 * reader MUST drop it: otherwise `openCases` still serves the stale case first
 * (lower index) and `report-case` fires ERR02_CASE_STALE forever, the branch
 * stays wrongly excluded from the publishable set even after the fresh case
 * resolves, and the pass never completes. A case is superseded when its LAST
 * `case` entry precedes its branch's most-recent `reopened` (using the last
 * entry, not `firstIndex`, so a case re-emitted under the SAME caseId after the
 * reopen correctly survives). A reopen that re-emits nothing (branch healed /
 * merged clean / deferred) simply leaves the branch with no open case — right.
 */
export function supersededCaseIds(journal: JournalEntry[]): Set<string> {
  const lastReopened = new Map<string, number>();
  const lastCase = new Map<string, { branch: string; idx: number }>();
  journal.forEach((e, i) => {
    if (typeof e.branch !== 'string') return;
    if (e.action === 'reopened') lastReopened.set(e.branch, i);
    else if (e.action === 'case' && typeof e.caseId === 'string') lastCase.set(e.caseId, { branch: e.branch, idx: i });
  });
  const out = new Set<string>();
  for (const [caseId, { branch, idx }] of lastCase) {
    // Only an UNDISPOSED case can be superseded. A resolved/held case's
    // disposition STANDS — the `reopened` it triggers re-processes the branch's
    // DESCENDANTS (§8), not the case itself, and a held case remains a valid
    // duplicate candidate (ERR06). Without this guard a just-held case would be
    // dropped from the duplicate scan the instant its own resolve reopened it.
    if (idx < (lastReopened.get(branch) ?? -1) && lastDisposition(journal, caseId) === null) out.add(caseId);
  }
  return out;
}

export function openCases(journal: JournalEntry[]): JournaledCase[] {
  const cases = journaledCases(journal);
  const superseded = supersededCaseIds(journal);
  return [...cases.values()]
    .filter((c) => !superseded.has(c.caseId) && lastDisposition(journal, c.caseId) === null)
    .sort((a, b) => a.firstIndex - b.firstIndex);
}

/** The branch-test command list for a case (opt-in via --commands-file). */
function branchTestCommands(cli: Cli): VerifyCommand[] {
  return cli.commandsFile ? (JSON.parse(readFileSync(cli.commandsFile, 'utf8')) as VerifyCommand[]) : [];
}

// --------------------------------------------------------------------------
// `sweep start` / `sweep abort` (DRIVER.md §6.1, §6.6).
// --------------------------------------------------------------------------

/**
 * REISSUE case-serving mechanics (review-trigger model): an open
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
  // ESCALATE ONCE: post the problem to the PR WITH the marker at
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
  // A GATE-FIX ref names a case with NO parent and NO conflict head, so there is
  // nothing here to parse and nothing to REVISE: a reissue re-probes a live
  // conflict, and this PR never had one. Say that, rather than reporting the
  // driver's own ref name as unparseable (the parent lookup below searches
  // SCOPE BRANCHES, and no branch is or can be named `(gate-fix)`, so falling
  // through would escalate every reviewed gate-fix PR with a bogus reason).
  if (isGateFixCaseId(rest)) {
    return escalateOnce(
      `'${args.ref}' is a GATE-FIX PR (case ${rest}): it carries a fix, not a conflict resolution, so there is no revision case to serve — merge or close it`,
    );
  }
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
  // WHAT THE PUBLISHED RESOLUTION TOUCHED OUTSIDE THE CONFLICT SET.
  //
  // A resolution may legitimately reach beyond the conflicted files — union two
  // signatures, update the call sites — and that reach is exactly what the
  // reviewer is looking at. Seeding only the still-conflicting paths hands the
  // agent a resolution missing part of itself, to revise against a review that
  // discusses the missing part.
  //
  // A path qualifies when the PR head differs from TODAY'S automerge there AND
  // the branch has not moved on it since the PR head was built. That second
  // condition is what makes this safe: where the base HAS moved, the PR head is
  // stale rather than richer, and overlaying it would revert the branch's own
  // progress under the guise of restoring a resolution.
  const namesOf = async (a: string, b: string): Promise<string[]> =>
    (await git(cli.repo, ['diff', '--name-only', a, b])).stdout.split('\n').filter(Boolean);
  const priorBase = (await git(cli.repo, ['merge-base', args.refSha, tip], { allowCodes: [1] })).stdout.trim();
  const movedSince = new Set(priorBase ? await namesOf(priorBase, tip) : []);
  const conflicting = new Set(probe.conflictFiles);
  const carried = (await namesOf(probe.treeOid, args.refSha)).filter(
    (p) => !conflicting.has(p) && !movedSince.has(p),
  );
  const cid = caseId(args.branch, parent, height);
  const head = { sha: conflictHead, height };
  const feat = args.features.find((f) => f.branch === args.branch);
  const caseFile: CaseFile = {
    schemaVersion: 1,
    id: cid,
    branch: args.branch,
    parent,
    head,
    run: [head],
    tierFloor: tierFloor(args.branch, feat),
    conflictedPaths: probe.conflictFiles,
    ...(carried.length ? { carriedPaths: carried } : {}),
    automergeTree: probe.treeOid,
    reproduction: { command: `git merge-tree --write-tree --name-only ${tip} ${conflictHead}` },
    deferredCheck: { firstConflictHeight: height, transitiveAncestors: args.ancestors },
  };
  // Same rule as `run`'s emission: no environment, no case. `start` does NOT
  // halt for it — a half-opened pass would leave the next `start` refusing on
  // ERR30_PASS_OPEN — it simply does not serve this reissue. The branch stays
  // blocked by its own open PR either way, so nothing is lost but the revision,
  // and the next pass re-derives it from the same PR.
  const prep = await createCaseWorktree(cli, dir, caseFile, tip, args.refSha); // pending files = the CURRENT ref head (prior resolution / owner edit)
  if (prep.environment) {
    appendJournal(dir, {
      action: 'reissue-skipped',
      id: 'ERR47_ENVIRONMENT_UNUSABLE',
      ref: args.ref,
      branch: args.branch,
      caseId: cid,
      detail:
        `dependencies would not install for the reissue worktree of '${args.ref}' — the revision is NOT served ` +
        `this pass; the pull request and its review are untouched`,
    });
    console.error(
      `sweep start [ERR47_ENVIRONMENT_UNUSABLE]: '${args.ref}' reissue NOT served — the case worktree has no dependencies`,
    );
    return;
  }
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
    ...(carried.length ? { carriedPaths: carried } : {}),
    reissue: true,
    fixBranch: args.ref,
    priorHead: args.refSha,
    prNumber: args.pr.number,
    prUrl: args.pr.url,
    reviewState: args.latestReview.state,
    addressedReviewId: args.latestReview.id,
    markerId: args.markerId,
  });
  console.error(
    `sweep start: REISSUE ${cid} — PR #${args.pr.number} carries review ${args.latestReview.id} (${args.latestReview.state}) beyond the sweep-addressed marker; serving a revision case this pass`,
  );
}

/**
 * Crashed publish (ref pushed, PR never created): the ref's
 * resolution is AUTHORITATIVE, so `start` COMPLETES the publish by creating
 * the missing PR on the existing head — nothing is re-derived and the ref is
 * never deleted. Draft-vs-active re-derives from the ref content itself
 * (conflict markers anywhere in its own diff → the pristine-conflict DRAFT;
 * marker-clean → the ACTIVE review PR). The title is the ref head's commit
 * subject; the body is driver BOOKKEEPING prose only (like the machine block —
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
    `Recovered publish: the resolution ref \`${u.ref}\` was pushed by an earlier pass, but its PR was`,
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
 * Reconstruct the blocked (PR_ID) set from ORIGIN
 * alone. For every `origin/fix/sweep/*` ref (post-fetch), parse the TARGET
 * branch out of the ref name (fix/sweep/<slug(branch)>--<slug(parent)>-h<n>-
 * <sha8>; matched against the registry scope's branch slugs, longest match
 * wins) and classify (`start` deletes a ref ONLY when its PR/head MERGED):
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
 *         auto-flips the PR to merged; no reissue.
 *       - APPROVED but the target advanced so it no longer merges cleanly →
 *         REISSUE (the agent re-resolves against the new base): PR_ID row +
 *         a revision case (`materializeReissueCase`).
 *       - CHANGES_REQUESTED / COMMENTED / other → REISSUE, forced HELD
 *         downstream (stays in the review loop, never auto-merged).
 *  4. unmerged + PR CLOSED:
 *       - merged_at set (squash/rebase-merged — head not an ancestor) →
 *         RESOLVED: delete the ref; NEVER attempt a reopen on a merged PR
 *         (GitHub 422s it).
 *       - genuinely closed unmerged → REOPEN the PR (driver PATCH state=open)
 *         → PR_ID.
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
 * a page-1-only read would truncate the newest reviews) and FAIL-CLOSED: any non-200 on a
 * needed lookup/write is an ERR13 halt — never a wrongful mutation. Start's
 * origin WRITES (merged-ref delete, reopen, recovery PR create, escalation
 * comment) all run AFTER the token/slug gate. Ref deletions go through
 * `git push origin --delete` (refs move via git only); a failed delete
 * is journaled and non-fatal (the ref is re-examined at the next start).
 */
/**
 * The conflict hunks at GIT'S OWN conflicted paths, read out of `tree`.
 *
 * The paths come from a merge probe and never from grepping the tree for
 * marker-shaped lines: a file may legitimately contain a line of seven angle
 * brackets (this repo's own sweep fixtures do), and such a phantom hunk is
 * invisible while both sides carry it and flips the verdict to `different` the
 * moment that file is edited for unrelated reasons — which force-pushes and
 * comments on a pull request whose conflict never moved.
 */
async function conflictAt(repo: string, tree: string, paths: readonly string[]): Promise<ConflictHunk[]> {
  if (paths.length === 0) return [];
  return conflictIdentity(paths, async (p) => {
    const res = await git(repo, ['cat-file', 'blob', `${tree}:${p}`], { allowCodes: [128] });
    return res.code === 0 ? res.stdout : null;
  });
}

/**
 * The conflict an exhibit head EXHIBITS. The head IS a merge commit and its
 * tree IS the pristine automerge, so re-probing `merge-tree` on its own two
 * parents recovers the conflicted-file list authoritatively and the bodies come
 * from the tree the pull request actually shows. A head with fewer than two
 * parents proposes no merge and exhibits no conflict.
 */
async function exhibitedConflict(repo: string, head: string): Promise<ConflictHunk[]> {
  const info = await commitInfo(repo, head);
  if (info.parents.length < 2) return [];
  const probe = await newStyleMergeTree(repo, info.parents[0], info.parents[1]);
  if (probe.clean) return [];
  return conflictAt(repo, `${head}^{tree}`, probe.conflictFiles);
}

/**
 * The verdict of the merged-tree checks probe. `undecided` means the tree was
 * not measured, and it is NOT a red: nothing may be destroyed on it.
 */
interface MergedChecksVerdict {
  green: boolean;
  undecided: { id: string; detail: string } | null;
}

/**
 * "Checks green" is the DRIVER'S OWN gate — the one `report-case` runs — on the
 * MERGED tree, never GitHub's check-runs: the sweep judges by the checks it
 * ships with, on the tree the merge would actually produce.
 *
 * No configured checks and no usable environment both mean NO VERDICT, and no
 * verdict reads as green: every consequence of red here is an intervention on
 * somebody's pull request, and the driver does not intervene on a measurement
 * it did not take.
 *
 * A RED IS RE-RUN BEFORE IT IS BELIEVED. The consequence of red on a driver
 * answer is deleting the ref, which closes the review thread and discards the
 * resolution — the one thing the next pass cannot walk back. A flaky check
 * would delete and re-create the same pull request on alternating passes, with
 * a new number each time. So the failing commands run AGAIN on the identical
 * tree, exactly as the integration gate does, and a disagreement between the
 * two runs is non-determinism: undecided, reported, nothing destroyed. A
 * SPAWN-LEVEL fault is undecided for the same reason and never a red at all.
 */
async function mergedChecksGreen(
  cli: Cli,
  checksFile: string | undefined,
  runChecks: ChecksRunner,
  mergedTree: string,
  parents: string[],
): Promise<MergedChecksVerdict> {
  const green: MergedChecksVerdict = { green: true, undecided: null };
  const checks = loadChecksConfig(checksFile);
  if (!checks || checks.typecheck.length === 0) return green;
  const probe = await deterministicCommit(cli.repo, mergedTree, parents, 'sweep: checks probe on the merged tree');
  const wt = await addTempWorktree(cli.repo, probe);
  try {
    if (!(await installDeps(cli, wt.path)).ok) return green;
    const first = await runChecks(checks.typecheck, wt.path);
    if (first.environmentFault) {
      return { green: false, undecided: { id: 'WARN14_ENVIRONMENT_FAULT', detail: first.environmentFault.detail } };
    }
    if (first.ok) return green;
    const failed = checks.typecheck.filter((c) => first.failedNames.includes(c.cmd));
    const again = await runChecks(failed, wt.path);
    if (again.environmentFault) {
      return { green: false, undecided: { id: 'WARN14_ENVIRONMENT_FAULT', detail: again.environmentFault.detail } };
    }
    const flaky = first.failedNames.filter((c) => !again.failedNames.includes(c));
    if (flaky.length > 0) {
      return {
        green: false,
        undecided: {
          id: 'WARN17_VERIFY_FLAKY',
          detail: `${flaky.join(', ')} failed and then PASSED on a re-run of the same tree`,
        },
      };
    }
    return { green: false, undecided: null };
  } finally {
    await wt.remove();
  }
}

async function deriveOriginMergeStatus(
  cli: Cli,
  dir: string,
  makeTransport?: (token: string) => GithubTransport,
  checksFile?: string,
  runChecks: ChecksRunner = defaultChecksRunner,
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
      await gitPushDelete(cli.repo, ref);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const blocked: string[] = [];
  // TOKEN/TRANSPORT GATE FIRST (fail-closed): when unmerged refs
  // need PR lookups, a missing token/slug must abort start BEFORE any origin
  // mutation — the merged-ref cleanup below runs only once the gate passes
  // (or is not needed: merged-only starts stay token-free).
  let transport: GithubTransport | null = null;
  let slugParts: { owner: string; repo: string } | null = null;
  if (unmerged.length > 0) {
    // Networked part: start takes --token-file like publish/push.
    let token: string | null = null;
    token = resolveGithubToken(cli);
    if (!token) {
      return {
        ok: false,
        issues: [
          {
            id: 'ERR11_TOKEN_MISSING',
            detail: `origin carries ${unmerged.length} unmerged fix/sweep ref(s) — start must check their PRs: export GH_TOKEN (or GITHUB_TOKEN) with the substitute GitHub token`,
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
     * APPROVED landing: the ref head still merges CLEANLY into
     * the current target → merge it into the LOCAL branch now (pre-ref
     * recorded — abort can roll back), journal `origin-approved` + `resolved`
     * (tier 'approved'), leave the branch UNBLOCKED. Finish verifies the merge
     * (the `resolved` row re-arms the §9 gate) and its target push lands it —
     * GitHub auto-flips the review PR to merged/closed. Returns false
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

    /**
     * DISPOSE OF AN OPEN PROPOSAL THAT CARRIES NOTHING NEW (§5.6). The agent is
     * not called — there is no new review — but the base moves, conflicts heal
     * and answers go stale, and the ref must not go on exhibiting a question
     * nobody is asking.
     *
     * Returns `dropped` when the ref is gone (the branch is free to derive the
     * conflict fresh), `blocked` when the proposal stands.
     */
    const disposeOpenProposal = async (
      u: { ref: string; sha: string; branch: string },
      open: PrByHead,
      transport: GithubTransport,
      slugParts: { owner: string; repo: string },
    ): Promise<'blocked' | 'dropped'> => {
      const originRef = `origin/${u.branch}`;
      if (!(await refExists(cli.repo, originRef))) return 'blocked';
      const targetTip = await revParse(cli.repo, originRef);
      const head = await commitInfo(cli.repo, u.sha);
      const shape = (await driverShaped(cli.repo, u.sha, targetTip)) ? 'driver' : 'owner';
      const baseMoved = head.parents.length > 0 && head.parents[0] !== targetTip;
      const conflictHead = head.parents[1] ?? null;

      // EXHIBIT OR ANSWER, decided on CONTENT: a head whose tree still carries
      // markers poses a question; one that does not offers an answer. The draft
      // flag says the same thing on a good day, but it is a label somebody can
      // flip, and the tree is not.
      const exhibited = shape === 'driver' ? await exhibitedConflict(cli.repo, u.sha) : [];
      let relation: ConflictRelation | null = null;
      if (exhibited.length > 0 && conflictHead) {
        const now = await newStyleMergeTree(cli.repo, targetTip, conflictHead);
        relation = classifyConflict(
          exhibited,
          now.clean ? [] : await conflictAt(cli.repo, now.treeOid, now.conflictFiles),
        );
      }

      // The expensive question is asked only where the answer is used: an
      // exhibit's disposition turns on the conflict alone.
      let mergeable = false;
      let checksGreen = false;
      if (relation === null) {
        const probe = await newStyleMergeTree(cli.repo, targetTip, u.sha);
        mergeable = probe.clean;
        if (mergeable) {
          const verdict = await mergedChecksGreen(cli, checksFile, runChecks, probe.treeOid, [targetTip, u.sha]);
          // AN UNDECIDED PROBE DECIDES NOTHING. A red here deletes the ref and
          // closes the review thread, so a measurement that disagreed with
          // itself, or never ran, must leave the proposal exactly as it stands
          // and say so. The next pass measures again.
          if (verdict.undecided) {
            appendJournal(dir, {
              action: 'proposal-check-undecided',
              id: verdict.undecided.id,
              ref: u.ref,
              branch: u.branch,
              headSha: u.sha,
              prNumber: open.number,
              prUrl: open.url,
              detail: verdict.undecided.detail,
            });
            console.error(
              `sweep start: '${u.ref}' (PR #${open.number}) left alone [${verdict.undecided.id}]: ${verdict.undecided.detail} — nothing deleted`,
            );
            return 'blocked';
          }
          checksGreen = verdict.green;
        }
      }

      const action = disposeProposal({ shape, relation, mergeable, checksGreen, approved: false, baseMoved });
      const why =
        relation !== null
          ? `the conflict it exhibits is ${relation}`
          : `it ${mergeable ? 'merges' : 'no longer merges'} and ${checksGreen ? 'passes' : 'does not pass'}`;

      if (action === 'leave' || action === 'hold') return 'blocked';

      if (action === 'delete') {
        // DELETING IS NOT DESTRUCTIVE: GitHub closes the PR and keeps its
        // commits, restorable. A head that poses no question, or answers one it
        // can no longer answer, is dropped and the case derives fresh.
        const deleteFailed = await deleteOriginRef(u.ref);
        appendJournal(dir, {
          action: 'proposal-dropped',
          ref: u.ref,
          branch: u.branch,
          headSha: u.sha,
          prNumber: open.number,
          prUrl: open.url,
          reason: why,
          ...(deleteFailed ? { deleteFailed } : {}),
        });
        console.error(
          `sweep start: dropped '${u.ref}' (PR #${open.number}) — ${why}${deleteFailed ? ' (ref delete failed)' : ', ref deleted'}; ${u.branch} derives fresh`,
        );
        return deleteFailed ? 'blocked' : 'dropped';
      }

      if (action === 'draft-and-report') {
        // NEVER REBUILT, NEVER DELETED: force-pushing over commits somebody else
        // put there is the one destructive operation available here. The draft
        // flag is the "already told you" marker, so the conversion and the
        // comment happen ONCE and a PR the owner opened as a draft gets neither
        // — the REPORT at finish is what carries it every pass.
        let alreadyDraft = true;
        try {
          alreadyDraft = (await getPullRequest(transport, slugParts, open.number)).draft;
        } catch {
          alreadyDraft = true; // unknown state: say nothing rather than say it twice
        }
        // The conversion and the comment are a COURTESY on the transition, and a
        // courtesy that cannot be delivered must not stop the pass: the row
        // below is what the finish report reads, and it says the same thing
        // every pass whether or not the write landed.
        let drafted = false;
        if (!alreadyDraft) {
          try {
            await convertPullRequestToDraft(transport, slugParts, open.number);
            await ghExpect(transport, 'POST', `/repos/${slugParts.owner}/${slugParts.repo}/issues/${open.number}/comments`, {
              body:
                `Sweep note (driver-posted): this pull request ${why} against \`${u.branch}\` as it stands on origin, ` +
                `so it has been converted to a draft. Nothing here has been rewritten — fix it or close it. ` +
                `This is said once; the sweep's end-of-pass report will keep listing it until it merges or passes.`,
            });
            drafted = true;
          } catch (e) {
            appendJournal(dir, {
              action: 'owner-pr-notice-failed',
              ref: u.ref,
              branch: u.branch,
              prNumber: open.number,
              message: e instanceof Error ? e.message : String(e),
            });
            console.error(
              `sweep start: could not draft/comment PR #${open.number} — ${e instanceof Error ? e.message : String(e)}; it is still reported at finish`,
            );
          }
        }
        appendJournal(dir, {
          action: 'owner-pr-degraded',
          ref: u.ref,
          branch: u.branch,
          prNumber: open.number,
          prUrl: open.url,
          mergeable,
          checksGreen,
          drafted,
          reason: why,
        });
        console.error(
          `sweep start: owner-shaped PR #${open.number} on '${u.ref}' ${why}${drafted ? ' — converted to draft, commented once' : ' (no notice posted)'}`,
        );
        return 'blocked';
      }

      // REBASE or REBUILD: the exhibit is re-cut against the target as it stands
      // now. Both push onto the SAME ref, under a lease against the head this
      // pass classified — a new name would mint a second ref and a second PR for
      // one case. Only a head every commit of which is the driver's gets here.
      if (!conflictHead) return 'blocked';
      const now = await newStyleMergeTree(cli.repo, targetTip, conflictHead);
      if (now.clean) return 'blocked'; // nothing to exhibit; the next pass drops it
      const rebuilt = await deterministicCommit(
        cli.repo,
        now.treeOid,
        [targetTip, conflictHead],
        `Pristine conflict for ${u.ref} (conflict markers in place — resolve fresh)`,
      );
      if (rebuilt === u.sha) return 'blocked'; // identical rebuild: nothing moved
      try {
        await gitPush(cli.repo, rebuilt, u.ref, { forceWithLease: u.sha });
      } catch (e) {
        appendJournal(dir, {
          action: 'proposal-repush-failed',
          ref: u.ref,
          branch: u.branch,
          prNumber: open.number,
          message: e instanceof Error ? e.message : String(e),
        });
        console.error(`sweep start: could not re-push '${u.ref}' — ${e instanceof Error ? e.message : String(e)}`);
        return 'blocked';
      }
      appendJournal(dir, {
        action: action === 'rebase' ? 'proposal-rebased' : 'proposal-rebuilt',
        ref: u.ref,
        branch: u.branch,
        prNumber: open.number,
        from: u.sha,
        to: rebuilt,
        onto: targetTip,
        reason: why,
      });
      u.sha = rebuilt; // the blocked row must name the head that is on origin now
      if (action === 'rebuild') {
        // The body describes a question that is no longer being asked, and the
        // driver never writes PR prose. Say so once; a review on this PR
        // reissues the case and the agent rewrites it.
        await ghExpect(transport, 'POST', `/repos/${slugParts.owner}/${slugParts.repo}/issues/${open.number}/comments`, {
          body:
            `Sweep note (driver-posted): the conflict this pull request exhibits has changed — ${why}. ` +
            `The exhibit has been rebuilt against \`${u.branch}\` as it stands on origin, so the description above ` +
            `no longer matches it. Review this PR to have the sweep re-serve the case and rewrite the description.`,
        });
      }
      console.error(
        `sweep start: ${action === 'rebase' ? 'rebased' : 'rebuilt'} '${u.ref}' onto ${targetTip.slice(0, 12)} — ${why}`,
      );
      return 'blocked';
    };

    for (const u of unmerged) {
      // WHAT THE PROPOSAL IS COMES FROM THE SHAPE OF ITS HEAD, and this is the
      // only place that can see it: the ref name is a string the driver minted,
      // and by the time the plan reads the journal it is all that survives. Two
      // parents merge something and cut at the merge point; one parent fixes
      // the branch's own content, which makes the branch red and freezes it
      // whole.
      const headKind = (await commitInfo(cli.repo, u.sha)).parents.length >= 2 ? 'merge' : 'fix';
      // journal the PR_ID row (shared by the blocked arms; every unmerged ref
      // with a live/reissued/recovered PR blocks its branch).
      const journalBlocked = (pr: { number: number; url: string }, markerId: number | null): void => {
        appendJournal(dir, {
          action: 'origin-blocked',
          branch: u.branch,
          caseId: `origin:${u.ref}`,
          fixBranch: u.ref,
          kind: headKind,
          headSha: u.sha,
          prNumber: pr.number,
          prUrl: pr.url,
          markerId,
        });
        blocked.push(u.branch);
      };
      try {
        // FAIL-CLOSED lookup across ALL states: only an authoritative
        // 200 may classify — an API failure must never read as "no PR".
        const prs = await getPrsByHead(transport!, slugParts!, u.ref);
        const open = prs.find((p) => p.state === 'open');
        if (open) {
          // Cases 2/3: REVIEWS are the only trigger. Issue
          // comments are fetched for the marker watermark (+ dialog); loose
          // comments/inline comments never trigger. All lists paginated.
          const comments = await listIssueComments(transport!, slugParts!, open.number);
          const reviews = await listReviews(transport!, slugParts!, open.number);
          // The marker is bounded TO REALITY — a pasted
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
              console.error(
                `sweep start: ${u.branch} blocked — open PR #${open.number} on '${u.ref}'; review ${dismissedBeyond} was DISMISSED (nothing actionable) — marker advanced, NO reissue`,
              );
            }
            // NOTHING NEW ON THE PR — so no agent is called, but the world moved
            // underneath it and the proposal has to be kept honest. What happens
            // to it follows from what it IS now (§5.6), not from why it got
            // there.
            const effectiveMarker = dismissedBeyond > 0 ? dismissedBeyond : markerId;
            const outcome = await disposeOpenProposal(u, open, transport!, slugParts!);
            if (outcome === 'blocked') {
              journalBlocked(open, effectiveMarker);
              if (dismissedBeyond === 0) {
                console.error(
                  `sweep start: ${u.branch} blocked — open PR #${open.number} on '${u.ref}' (origin-derived; no review beyond the marker)`,
                );
              }
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
          // a reopen on a merged PR (GitHub 422s it).
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
          // Case 4b: genuinely CLOSED and unmerged. CLOSING IS THE OWNER SAYING
          // "DROP THIS", and it is honoured as-is.
          //
          // The driver never closes a PR — there is no such call anywhere in it —
          // so a closed one was closed by a person. Reopening it would override
          // that decision; and because the gate is keyed on the
          // REF, closing by hand would not even lift the gate — the owner
          // would have to close a PR AND delete a ref to withdraw a case.
          //
          // NO AGENT IS SERVED, and comments on the closed PR are not carried
          // anywhere. A comment explains a decision; it is not a work item, and
          // there is no artifact left to revise. The decision is scoped to the
          // ref the owner closed: while that PR/ref stands it speaks for
          // itself; once the refs are cleaned the question is legitimately
          // open again. A decision that must bind future passes belongs in
          // code or configuration — never in driver memory.
          //
          // Relevance needs no logic either: if the defect is still real the
          // next verify re-derives it and mints a fresh case; if it is not,
          // nothing comes back. The agent's resolution stays readable on the
          // closed PR.
          const closed = prs[0];
          const deleteFailed = await deleteOriginRef(u.ref);
          appendJournal(dir, {
            action: 'origin-ref-withdrawn',
            ref: u.ref,
            branch: u.branch,
            headSha: u.sha,
            prNumber: closed.number,
            prUrl: closed.url,
            via: 'pr-closed-by-owner',
            ...(deleteFailed ? { deleteFailed } : {}),
          });
          appendObservation(cli.workspace, {
            kind: 'origin-ref-withdrawn',
            ref: u.ref,
            branch: u.branch,
            prNumber: closed.number,
            prUrl: closed.url,
          });
          console.error(
            `sweep start: PR #${closed.number} on '${u.ref}' was CLOSED by the owner — case withdrawn, ` +
              `${u.branch} no longer gated${deleteFailed ? ' (ref delete failed)' : ', ref deleted'}`,
          );
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
        return { ok: false, issues: [apiFailureIssue(cli, e)], blocked };
      }
    }
  }
  return { ok: true, issues: [], blocked };
}

/**
 * `sweep start` — open a pass and pin its watermark. Refuses if a pass is
 * already open (a machine state that is not `complete`): the agent must
 * `finish` or `abort` first — never blind-wipe an in-flight pass (that strands
 * resolved-but-unpushed merges, §2). Pins the watermark = upstream top
 * commit (via cmdPlan), initializes the journal, and writes the machine state.
 *
 * start is NETWORKED — it fetches origin (+ upstream) and reconstructs
 * the blocked set from the origin fix/sweep refs (`deriveOriginMergeStatus`)
 * BEFORE planning; merge_status is origin-derived, so the local
 * pass dir is disposable and `start` is idempotent on origin. A pass that
 * crashed before `finish` published NOTHING, so the re-derived picture is
 * clean and the pass is simply redone.
 *
 * Clean-slate boundary: the pass directory lives at ONE canonical location
 * — `<--workspace>/propagation/pass-<watermark12>` — logged on every `start` and
 * `status` so no operator guesses it. `start` REMOVES the WHOLE prior pass tree
 * (worktrees + case dirs + `coldread-*.json`/`.md` + `pr/`) of any COMPLETE or
 * STALE prior pass at that location before opening (a still-OPEN pass still
 * refuses). Without the wipe a new run at the same
 * watermark inherits a prior pass's journal (a leftover HELD leaks into the
 * new run) AND a poisoned `coldread-verdict.json` (an infra failure recorded as
 * a reject), because `plan` re-attaches to the leftover files. The driver OWNS
 * the pass-dir lifecycle — never rely on an external hand-rm (host `rm` fails
 * on container-uid-owned files, so teardown MUST run IN-CONTAINER, which
 * `start` does). C-1: it also refuses a `--workspace` that IS the `--repo`
 * clone or a subdirectory of it, so the pass never lands inside the clone
 * (splitting it from the durable group-root rr-cache loses rerere's learned
 * resolutions). A group root inside an OUTER git repo is accepted.
 */
export async function cmdSweepStart(
  cli: Cli,
  makeTransport?: (token: string) => GithubTransport,
  /** The checks gate an open proposal's merged tree is judged by (§5.6); injectable for tests. */
  runChecks: ChecksRunner = defaultChecksRunner,
): Promise<number> {
  // RESOLVE the pass config to flag-or-default up front, then persist the
  // absolute paths into machine state (below) so every later command reads them
  // FROM STATE and the agent passes no such flag mid-pass.
  //  - inventory: `--inventory` (tests/fixtures) or the committed
  //    `scripts/sweep/inventory/` in the clone — config tracked in the repo,
  //    never a workspace dir.
  //  - checks-file: `--checks-file` or the in-repo default
  //    `scripts/sweep/checks.json`; a non-existent path → the gate is skipped.
  const resolvedChecksFile = cli.checksFile ?? pathResolve(cli.repo, 'scripts', 'sweep', 'checks.json');

  // C-1: the workspace is the GROUP ROOT and MUST NOT be the FORK CLONE
  // (`--repo`) or a subdirectory of it — a --workspace pointed at the clone
  // lands the pass + rr-cache inside the clone, splitting per-pass
  // state from the durable group rr-cache and losing rerere's learned
  // resolutions. The check is scoped to the CLONE ONLY:
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
        `land inside the clone, splitting it from the durable group-root rr-cache. Point --workspace at ` +
        `the GROUP ROOT (parent of the clone).`;
      console.error(`sweep start [ERR37_WORKSPACE_IN_CLONE]: ${detail}`);
      result(cli, { ok: false, issues: [{ id: 'ERR37_WORKSPACE_IN_CLONE', detail }] });
      return 1;
    }
  }

  // FETCH FIRST — the pass derives everything from origin, so the
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
          `start derives the blocked set from origin and must not open a pass on a stale view`;
        console.error(`sweep start [ERR39_FETCH_FAILED]: ${detail}`);
        result(cli, { ok: false, issues: [{ id: 'ERR39_FETCH_FAILED', detail }] });
        return 1;
      }
    }
  }

  // Resolve the ONE canonical pass location for this watermark up front.
  // `--workspace` is the single artifacts root (default: the group root = parent
  // of --repo); passDir() is the sole path builder, so where the driver WRITES
  // and what the doctrine names are identical — there is exactly one location.
  const watermark12 = (await revParse(cli.repo, cli.upstream)).slice(0, 12);
  const canonicalDir = passDir(cli.workspace, watermark12);

  // Refuse a still-OPEN pass: a machine state whose phase is not
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
      // CONTINUE-OR-ABORT IS THE OWNER'S CALL, NOT THE AGENT'S.
      //
      // The two are not interchangeable: `finish` resumes
      // from the stopped step and keeps the pass's merges and published PRs,
      // while `abort` rolls every touched branch back to its journaled pre-ref
      // and throws the in-flight work away. Which is right depends on why the
      // pass stopped. An agent cannot know that, so it must not choose — and
      // the refusal must never read as a menu the agent picks from.
      //
      // The facts the decision needs go in the result, so the report is not the
      // agent's summary of a journal it half-read.
      const j = readJournal(d);
      const count = (a: string): number => j.filter((e) => e.action === a).length;
      const merged = count('resolved');
      const published = count('pr-published');
      const heldCases = count('held');
      const stillOpen = openCases(j).length;
      const detail =
        `a pass is already open (${d}, phase ${st.phase}${st.finishStep ? `, step ${st.finishStep}` : ''}) — ` +
        `${merged} branch(es) merged locally, ${published} PR(s) published, ${heldCases} case(s) held, ` +
        `${stillOpen} case(s) still open. CONTINUING and ABORTING are different outcomes and the choice is the ` +
        `OWNER'S.`;
      console.error(`sweep start [ERR30_PASS_OPEN]: ${detail}`);
      result(cli, {
        ok: false,
        issues: [{ id: 'ERR30_PASS_OPEN', detail }],
        openPass: {
          dir: d,
          phase: st.phase,
          ...(st.finishStep ? { finishStep: st.finishStep } : {}),
          mergedLocally: merged,
          prsPublished: published,
          casesHeld: heldCases,
          casesOpen: stillOpen,
        },
        instruction:
          `ASK THE OWNER, then STOP. Do not choose, and do not run \`finish\` or \`abort\` on your own. ` +
          `Report: the previous sweep did not complete — it is at phase ${st.phase}` +
          `${st.finishStep ? ` (step ${st.finishStep})` : ''} with ${merged} branch(es) merged locally but not ` +
          `pushed, ${published} PR(s) already published, and ${stillOpen} case(s) still open. Offer exactly two ` +
          `options and wait for the answer: (1) CONTINUE — resume the unfinished pass from where it stopped ` +
          `(\`next-case\` while cases remain, then \`finish\`); the merges and published PRs are kept. ` +
          `(2) ABORT — drop the pass; every touched branch is rolled back to its pre-pass ref and the local ` +
          `merges are lost, though PRs already on origin remain. Say WHY it stopped if the journal shows it.`,
      });
      return 1;
    }
  }

  // Start guard: the inventory is strict config — a missing or empty
  // inventory, or any entry error (unknown key, bad value), is fatal here.
  // Mid-pass commands re-read the pinned path from machine state and stay
  // fail-open: start already guaranteed its validity for the pass.
  {
    const inventoryDir = cli.inventory ?? defaultInventoryDir();
    const { features, warnings } = loadFeatures(inventoryDir);
    if (!inventoryDir || warnings.length > 0 || features.length === 0) {
      const detail = !inventoryDir
        ? 'no inventory: scripts/sweep/inventory/ is missing and no --inventory was given'
        : warnings.length > 0
          ? `inventory '${inventoryDir}' is not valid config: ${warnings.join('; ')}`
          : `inventory '${inventoryDir}' is empty`;
      console.error(`sweep start [ERR46_INVENTORY_INVALID]: ${detail}`);
      result(cli, { ok: false, issues: [{ id: 'ERR46_INVENTORY_INVALID', detail }] });
      return 1;
    }
    cli.inventory = inventoryDir; // pinned into machine state below
  }

  // A checks file that does not PARSE disables every gate this pass has (the
  // per-case checks gate and the finish verify) — silently: the pass would open,
  // merge, publish and report green having typechecked and tested nothing. Refuse here,
  // before the clean-slate wipe, so nothing is destroyed and the operator is told
  // exactly which file to fix.
  const badChecks = malformedChecksIssue(resolvedChecksFile);
  if (badChecks) {
    console.error(`sweep start [${badChecks.id}]: ${badChecks.detail}`);
    result(cli, {
      ok: false,
      status: 'stopped',
      issues: [badChecks],
      instruction: `REPORT to the owner: the checks file is unreadable, so no gate can run — ${badChecks.detail}`,
    });
    return 1;
  }

  // NO BASE GATE HERE — see the note above `attachPass`. `start` opens the pass;
  // it does not judge the build. A red base surfaces at `finish`'s verify like
  // any other red, and its fix is served as an ordinary gate-fix case.
  //
  // Clean-slate boundary: the refusal above cleared any in-flight pass,
  // so anything still at the canonical location is a COMPLETE or STALE prior
  // pass (or a pre-machine-state leftover with no machine-state.json). Remove the
  // WHOLE tree — journal + machine-state + every case dir with its
  // `coldread-*.json`/`.md` + `pr/` — so NOTHING is inherited: not the leaked
  // HELD journal, and not a poisoned `coldread-verdict.json` (the poison:
  // an infra failure recorded on disk as a reject, which a later read of that
  // file would take for an authentic content decision).
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
    console.error(`sweep start: cleared prior pass dir ${canonicalDir} (whole tree; clean-slate)`);
  }

  // Reconstruct the blocked set from ORIGIN into the fresh journal
  // BEFORE planning (plan/run read `origin-blocked` rows).
  // Blocking issues (token missing, API failure) leave
  // no plan-initial.json, so a re-run start clears + re-derives cleanly.
  progress('deriving merge status from origin');
  const originDerive = await deriveOriginMergeStatus(cli, canonicalDir, makeTransport, resolvedChecksFile, runChecks);
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
    // Pin the resolved config paths for the rest of the pass.
    ...(cli.inventory !== undefined ? { inventory: cli.inventory } : {}),
    checksFile: resolvedChecksFile,
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
        // The journal keeps the BRANCH (the result line is command-level); the
        // shared reporter emits the one SWEEP-RESULT — journaling and
        // returning 1 with no result line would tell the agent nothing.
        appendJournal(dir, { action: 'halt', branch, reason: err.reason, message: err.message });
        return reportDriverHalt(cli, err);
      }
      throw err;
    }
  }
  for (const c of journaledCases(journal).keys()) await removeCaseWorktree(cli, dir, c);
  appendJournal(dir, { action: 'pass-aborted', rolledBack });
  // C-4: seal the pass with `pass-complete` too — `attachPass` defines
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
// `sweep next-case` (DRIVER.md §6.2).
// --------------------------------------------------------------------------

/**
 * `sweep next-case` — deterministic, NO `claude -p`. Drives the existing
 * plan/run machinery (cmdRun: CLEAN merges + no-op skips + DEFERRED freezes,
 * barrier/reopen handled internally), then serves the topmost undispositioned
 * conflict case (DAG order) with its driver-prepared worktree + materials, or
 * reports `finalize` when none remain. Zero agent params; the driver records
 * `currentCase` in the machine state.
 */
/**
 * The fixed hand-off line served with every case — the checks contract.
 * The agent runs the typechecks itself while editing; report-case runs BOTH the
 * typecheck and the tests as its single gate, so the agent must NOT run the
 * (slow) tests beforehand.
 */
const CHECKS_HANDOFF_LINE =
  'After editing, run the typechecks and fix any issues. Do NOT run tests before report-case — it runs them itself.';

/**
 * The branches this pass will actually touch, in the plan's topological order.
 *
 * A branch PARTICIPATES if the pass merges something INTO it (a `merge`/`case`
 * verdict on one of its parents) or if it is the SOURCE such a merge reads. The
 * source half is not decoration: a branch that is red and static — nothing
 * pending into it — would otherwise be skipped and then propagated FROM, which
 * is precisely how a red trunk reaches every descendant while each descendant's
 * own pre-merge tip still looks green.
 *
 * Branches the pass does not touch are not checked. The sweep validates what it
 * changes; a branch nobody merges and nobody reads is not this pass's business.
 */
function participatingBranches(dir: string): string[] {
  const f = existsSync(join(dir, 'plan.json')) ? join(dir, 'plan.json') : join(dir, 'plan-initial.json');
  if (!existsSync(f)) return [];
  let plan: PropagationPlan;
  try {
    plan = JSON.parse(readFileSync(f, 'utf8')) as PropagationPlan;
  } catch {
    return [];
  }
  const participants = new Set<string>();
  for (const bp of plan.branches ?? []) {
    for (const pp of bp.parents ?? []) {
      if (pp.verdict !== 'merge' && pp.verdict !== 'case') continue;
      participants.add(bp.branch); // target: content lands here
      participants.add(pp.parent); // source: content is read from here
    }
  }
  const order = plan.order ?? [];
  const ordered = order.filter((b) => participants.has(b));
  // Anything the order does not name still gets checked, after the ordered set.
  return [...ordered, ...[...participants].filter((b) => !ordered.includes(b))];
}

/**
 * PRE-MERGE BRANCH CHECK — the first participating branch that is already RED.
 *
 * Detection runs FORWARD, with the sweep, instead of backwards from a symptom.
 * The sweep propagates down from the trunk, so a defect on a branch reaches
 * every descendant that merges it; checking each participant BEFORE its content
 * moves catches it at the one branch that can actually fix it, and no
 * descendant ever inherits an unfixable failure.
 *
 * This check deliberately covers EVERY participating branch, not only the
 * trunk (a red on any source branch reaches its descendants the same way), and
 * lives inside the pass (which can put a case somewhere) rather than at
 * `start` (which could only refuse). Without it, the per-case gate is the only
 * `runChecks` call in this driver, so a CLEAN merge is never typechecked and a
 * red propagates in silence until an unrelated conflict case trips over it and
 * cannot fix it in scope.
 *
 * TYPECHECK ONLY: tests are far slower and `finish`'s
 * verify still runs them. Results are memoised as `branch-check` journal rows
 * keyed by (branch, tip sha) — a PASS-LOCAL fact, not durable state. `start` wipes
 * the journal, so it cannot go stale across passes, and a judged fix moves the
 * tip so the key changes and the branch is re-checked. (A stored green set
 * would be exactly the local cross-pass state this driver forbids.)
 */
export async function firstRedParticipant(
  cli: Cli,
  dir: string,
  checksFile: string | undefined,
  runChecks: ChecksRunner,
  runInstall?: InstallRunner,
): Promise<{ branch: string; sha: string; output: string; failed: VerifyCommand[]; failedNames: string[]; tree: string } | null> {
  // An ABSENT checks file is a deliberate skip (a repo without one skips the
  // gate). A CONFIGURED one that will not load is a silently disabled gate —
  // the ERR43 failure shape — so say so instead of returning null indistinguishably.
  const checks = loadChecksConfig(checksFile);
  if (!checks || checks.typecheck.length === 0) {
    if (checksFile && (!checks || checks.typecheck.length === 0)) {
      const why = checks ? 'its `typecheck` list is empty' : 'it could not be read';
      appendJournal(dir, {
        action: 'warning',
        id: 'WARN11_PRE_MERGE_CHECK_SKIPPED',
        message: `pre-merge branch check SKIPPED: ${checksFile} — ${why}; branches merge unverified`,
      });
      console.error(`next-case [WARN11_PRE_MERGE_CHECK_SKIPPED]: ${checksFile} — ${why}`);
    }
    return null;
  }
  const branches = participatingBranches(dir);
  if (branches.length === 0) return null;
  const journal = readJournal(dir);
  const checked = new Map<string, boolean>();
  for (const e of journal) {
    if (e.action === 'branch-check' && typeof e.branch === 'string' && typeof e.sha === 'string') {
      checked.set(`${e.branch}@${e.sha}`, e.ok === true);
    }
    // A GREEN LANDING SUBSUMES THIS CHECK. The landing gate (§7.6) ran the
    // typechecks AND the tests on that exact tip, so re-typechecking it here
    // pays full price for an answer already in the journal. Only a green
    // counts: a red landing blocks its branch through its gate-fix case, and
    // an unmeasured one carries no `ok` at all.
    if (e.action === 'landing-check' && e.ok === true && typeof e.branch === 'string' && typeof e.sha === 'string') {
      checked.set(`${e.branch}@${e.sha}`, true);
    }
  }
  let wt: { path: string; remove: () => Promise<void> } | null = null;
  try {
    for (const branch of branches) {
      if (!(await refExists(cli.repo, branch))) continue;
      const sha = await revParse(cli.repo, branch);
      const key = `${branch}@${sha}`;
      if (checked.has(key)) {
        if (checked.get(key) === true) continue;
      }
      // THE SAME SUBTREE IS THE SAME MEASUREMENT. Every configured typecheck is
      // green on the subtree it runs in, measured on some branch this pass — so
      // this branch's typecheck is that answer, and running it again would buy
      // the same fact at full price.
      const memo = greenChecks(readJournal(dir));
      const memoKeys = await checkVerdictKeys(cli.repo, sha, checks.typecheck);
      if (memoKeys.every((k) => memo.has(checkKey(k.subtree, k.cmd)))) {
        appendJournal(dir, {
          action: 'branch-check',
          branch,
          sha,
          ok: true,
          measuredOn: [...new Set(memoKeys.map((k) => memo.get(checkKey(k.subtree, k.cmd))!))].sort().join(', '),
          checks: memoKeys.map((k) => ({ ...k, ok: true })),
        });
        continue;
      }
      // Dependencies for THIS branch's manifests, not the clone's. Without
      // this a branch declaring its own package reports TS2307 and is blamed
      // for an environment gap — and worse, an unchanged sha flips red->green
      // the moment anything installs into the shared clone.

      if (!wt) {
        wt = await addTempWorktree(cli.repo, sha);
      } else {
        await git(cli.repo, ['reset', '--hard', sha], { cwd: wt.path });
        for (const rel of WORKTREE_DEP_LINKS) rmSync(join(wt.path, rel), { recursive: true, force: true });
      }
      const install = await installDeps(cli, wt.path, runInstall);
      if (!install.ok) {
        // No valid environment ⇒ no verdict. Memoising this as a pass would skip
        // the branch's only typecheck for the whole pass (a bogus GREEN is the
        // durable one — it ships), and as a failure it would blame the branch.
        appendJournal(dir, {
          action: 'warning',
          id: 'WARN13_DEPS_UNUSABLE',
          branch,
          sha,
          install: install.failure,
          message:
            `dependencies would not install for ${branch}@${sha.slice(0, 12)} — not checked: ` +
            `\`${install.failure.command}\` failed with: ${install.failure.output.slice(-400)}`,
        });
        console.error(`next-case [WARN13_DEPS_UNUSABLE]: ${branch} dependencies would not install — branch NOT checked`);
        continue;
      }
      const wtPath = wt.path;
      const keys = memoKeys;
      const r = await runChecks(checks.typecheck, wtPath);
      appendJournal(dir, {
        action: 'branch-check',
        branch,
        sha,
        ok: r.ok,
        ...(r.ok ? {} : { failed: r.failedNames }),
        // The evidence, per command and per subtree: a green here is what spares
        // the landing gate the same command on any branch carrying that subtree.
        checks: keys.filter((k) => r.ok || r.failedNames.includes(k.cmd)).map((k) => ({ ...k, ok: r.ok })),
      });
      if (!r.ok) {
        const failed = checks.typecheck.filter((c) => r.failedNames.includes(c.cmd));
        // ONE RED IS AN OBSERVATION, NOT A VERDICT — and this red blocks every
        // merge in the pass and mints a case on the branch, so it is re-run on
        // the identical tree first.
        const tree = await treeOf(cli.repo, sha);
        const confirm = await confirmRed(dir, {
          branch,
          sha,
          phase: 'typecheck',
          failed: keys.filter((k) => r.failedNames.includes(k.cmd)),
          rerun: (again) =>
            variedRerun(cli, sha, failed.filter((c) => again.some((k) => k.cmd === c.cmd)), runChecks, runInstall),
        });
        if (!confirm.reproduced) {
          // NOT RED, AND NOT GREEN — so this check has no verdict to give and
          // says nothing. The pass keeps going and the LANDING GATE decides:
          // it measures the tree that actually results, typecheck AND tests,
          // with the same confirming re-run. Stopping the pass here instead
          // would block every merge on a measurement that contradicted itself.
          appendJournal(dir, {
            action: 'branch-check',
            branch,
            sha,
            tree,
            ok: false,
            unstable: true,
            id: 'WARN21_CHECKS_FLAKY',
            failed: r.failedNames,
            detail: confirm.detail,
          });
          console.error(`next-case [WARN21_CHECKS_FLAKY]: ${branch} — ${confirm.detail}`);
          continue;
        }
        return { branch, sha, output: r.output, failed, failedNames: r.failedNames, tree };
      }
    }
  } finally {
    if (wt) await wt.remove();
  }
  return null;
}

export async function cmdSweepNextCase(
  cli: Cli,
  runChecks: ChecksRunner = defaultChecksRunner,
  /** Pre-merge branch check installs per-branch dependencies; injectable for tests. */
  runInstall?: InstallRunner,
): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  let st = readMachineState(dir);
  // applyPassConfig RETURNS the pass's checks file; it does not assign it onto
  // `cli` (it only does that for `inventory`). Dropping the return value would
  // leave `checksFile` undefined here, so the pre-merge check below would load
  // no config and silently do nothing — zero `branch-check` rows while
  // the merges run on regardless. `report-case` and `finish` both capture it.
  const passChecksFile = applyPassConfig(cli, st);
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

  // PRE-MERGE BRANCH CHECK — BEFORE cmdRun, which is where the merging happens.
  // A branch that is already red must not have content merged into it and must
  // not be propagated FROM: either spreads the defect to every descendant, and
  // the descendant is then handed a failure it cannot fix inside its own case
  // scope. Serve the fix as a case on the branch that owns it instead; the
  // branch is thereby blocked, and the existing DEFERRED path holds its
  // descendants back with no extra machinery.
  //
  // AN OPEN GATE FIX IS THE SAME STATEMENT, already proven. The pre-merge check
  // is TYPECHECK ONLY (tests are far slower and `finish` runs them), so a branch
  // whose TESTS are red passes it — which is exactly the branch a `--not-my-bug`
  // adjudication has just proved red and minted a gate fix for. Without this,
  // `cmdRun` merges into it anyway and RE-EMITS the very conflict case that was
  // aborted; the re-emission gives that case a newer `case` row, so it is no
  // longer superseded, it sorts ahead of the gate fix by first-seen order, and
  // `next-case` serves it instead of the fix.
  const openGateFixCase = ((): boolean => {
    const j = readJournal(dir);
    const gateFixIds = new Set(j.filter((e) => e.action === 'case' && e.gateFix === true).map((e) => e.caseId as string));
    return openCases(j).some((c) => gateFixIds.has(c.caseId));
  })();
  const redBranch = openGateFixCase ? null : await firstRedParticipant(cli, dir, passChecksFile, runChecks, runInstall);
  let redGate: { reason: string; gated: string[] } | null = null;
  if (openGateFixCase) {
    progress('a gate fix is open — merging nothing until it lands');
    console.error('next-case: an open gate-fix case blocks its branch — no merges this call');
  } else if (redBranch) {
    // Ensure a gate-fix case EXISTS for the red branch — idempotent, since
    // materializeGateFixCases dedups on its own key — and then FALL THROUGH to
    // the ordinary case-serving path below.
    //
    // Returning here instead would tell the agent to "run `next-case`", but the
    // very next call would re-run this check, hit that dedup, and never hand
    // the case over: minted and then STRANDED (phase stuck at `open` with
    // currentCase null while the agent improvises its own diagnosis).
    // Serving it on THIS call also means the tree is typechecked once, not once
    // per round-trip.
    // WHERE THE FIX GOES, before it is minted. A branch that is red on content it
    // INHERITED is a true observation and a false accusation: the fix belongs at
    // the level that AUTHORED the failing files, where one case covers every
    // branch below it. A refusal from that table mints nothing at all.
    const lift = await liftGateFixTarget(
      cli,
      dir,
      null,
      redBranch.branch,
      redBranch.sha,
      parseFailingFiles(rootChecksOutput(redBranch.output, redBranch.failed)),
      redBranch.failed,
      runChecks,
      runInstall,
    );
    const gate = lift.refused
      ? { reason: lift.refused.detail, gated: [] as string[], cases: [] as GateFixCaseSummary[] }
      : await materializeGateFixCases(cli, dir, ctx.chain, withCeilingNote(redBranch.output, lift), redBranch.failed, null, {
          rootBranch: lift.branch,
          // The observation the case rests on — confirmed above, and re-read here
          // so no path reaches a mint on a single red run.
          redOn: { at: lift.ref, commands: redBranch.failed },
          attributedCeiling: lift.attributedCeiling,
        });
    if (lift.refused) {
      appendJournal(dir, {
        action: 'gate-fix-refused',
        id: lift.refused.id,
        branch: redBranch.branch,
        at: redBranch.sha,
        commands: redBranch.failed.map((c) => c.cmd),
        reason: lift.refused.detail,
      });
      console.error(`next-case [${lift.refused.id}]: ${redBranch.branch} — ${lift.refused.detail}`);
    }
    redGate = { reason: gate.reason, gated: gate.gated };
    progress(`${redBranch.branch} is RED before any merge (${redBranch.failedNames.join(', ')}) — merging nothing`);
    console.error(`next-case: ${redBranch.branch} red — serving its gate-fix; no merges this call`);
  } else {

  // Advance the deterministic machinery (idempotent; continues reopened branches
  // above resolved heights and lands new clean prefixes/skips/defers). The
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
  const runRc = await cmdRun({ ...cli, cmd: 'run', execute: true, internal: true }, runChecks, runInstall);
  if (runRc !== 0) {
    // A per-branch/whole-run halt (ERR2x) — surface it; the agent reports it.
    // cmdRun's own emit is suppressed (internal), so next-case emits the single
    // result itself: the halt is journaled — point the agent at it.
    console.error('next-case: `run` halted — see the journal');
    // THE HALT'S OWN ID TRAVELS WITH IT. `cmdRun` journals the id it halted on
    // and its emit is suppressed here, so without this the agent is handed
    // "run halted" and nothing to look the reason up under — and a halt that is
    // NOT self-healing (a broken environment) reads exactly like one that is.
    const haltRow = [...readJournal(dir).slice(journalLenBefore)]
      .reverse()
      .find((e) => e.action === 'halt' && typeof e.id === 'string');
    // RESUMABLE BY CONSTRUCTION — say so, because the agent cannot tell a
    // self-healing halt from a terminal one and will otherwise stop on both.
    // `cmdRun` is idempotent: it re-derives from git every call, so a halt whose
    // cause was a mid-run ref movement clears on the next attempt — and an
    // agent that stops and files a driver issue on the first halt leaves a
    // servable case sitting ready.
    result(cli, {
      status: 'run-halted',
      ...(haltRow ? { issues: [{ id: String(haltRow.id), detail: String(haltRow.message ?? haltRow.reason ?? '') }] } : {}),
      instruction:
        'run halted — RE-RUN `next-case` ONCE first: `run` re-derives from git every call, so a halt caused by a ' +
        'mid-run ref movement clears on the retry. If it halts AGAIN on the SAME branch, that is a real driver ' +
        'bug: inspect the journaled halt row and report it. Do not file an issue on the first halt.',
      passDir: dir,
      resumable: true,
    });
    return runRc;
  }
  const delta = readJournal(dir).slice(journalLenBefore);
  const mergedN = delta.filter((e) => e.action === 'merge').length;
  const skippedN = delta.filter((e) => e.action === 'skip').length;
  const deferredN = delta.filter((e) => e.action === 'defer').length;
  progress(`merged ${mergedN} clean / skipped ${skippedN} / deferred ${deferredN}`);
  }

  const journal = readJournal(dir);
  // ACTIVE GATES, read from ORIGIN at the moment of asking. A branch whose gate
  // fix is already written and waiting on the owner is SKIPPED, not re-served —
  // and the agent is told, so "nothing to serve" is never mistaken for "nothing
  // is wrong". A gate on the trunk skips everything beneath it: `main_patched`
  // is the default parent of every root (scope.ts), and a blocked direct parent
  // already defers its descendants.
  const activeGates = await activeGateFixRefs(cli.repo);
  const gateNote =
    activeGates.length > 0
      ? ` ${activeGates.length} branch(es) have an OPEN gate-fix PR (${activeGates.join(', ')}) and are SKIPPED until the owner merges it — REPORT that to the owner, do not try to fix them here.`
      : '';

  const open = openCases(journal);
  // AN UNSTABLE LANDING IS THE PASS'S ANSWER, never a silent `finalize`. The
  // landing gate saw a red, re-ran it on the identical tree and got a different
  // answer: nobody is blamed and nothing is minted, so there is no case to
  // serve — and "no case is open, run `finish`" would read as "all done" while a
  // branch sits unverified with its merges already landed locally.
  // The branch's LATEST landing verdict, never any earlier one: a tree measured
  // unstable and then measured again — the next call re-measures it, since it is
  // still owed a verdict — must be reported as whatever the LAST run said, or
  // the pass answers "unstable" forever on a row that has been superseded.
  const lastLanding = new Map<string, JournalEntry>();
  for (const e of journal) if (e.action === 'landing-check' && typeof e.branch === 'string') lastLanding.set(e.branch, e);
  const unstable = [...lastLanding.values()].reverse().find((e) => e.unstable === true);
  if (open.length === 0 && !redBranch && unstable) {
    st = { ...st, phase: 'open', currentCase: null };
    writeMachineState(dir, st);
    const seen = journal.filter((e) => e.action === 'landing-check' && e.unstable === true && e.tree === unstable.tree).length;
    const detail = `${unstable.branch}: ${String(unstable.detail ?? 'the landing checks changed their answer on the identical tree')}`;
    console.error(`next-case [WARN21_CHECKS_FLAKY]: ${detail}`);
    // A fix already written and HELD but unpublished must still reach the owner:
    // `finish` is what opens its PR, and stopping here would strand it in the
    // pass directory — the same ending the red-branch path guards against.
    const heldUnpublished = [...journaledCases(journal).values()].filter(
      (jc) =>
        lastDisposition(journal, jc.caseId)?.action === 'held' &&
        !journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId),
    );
    result(cli, {
      ok: false,
      status: 'stopped',
      issues: [{ id: 'WARN21_CHECKS_FLAKY', detail }],
      ...(heldUnpublished.length ? { heldAwaitingPublish: heldUnpublished.map((jc) => ({ caseId: jc.caseId, branch: jc.branch })) } : {}),
      ...(seen < 2 ? { resumable: true } : {}),
      instruction: heldUnpublished.length
        ? `run \`finish\` — it publishes the ${heldUnpublished.length} held fix(es) already written. Then REPORT to the ` +
          `owner that ${unstable.branch} landed an UNSTABLE tree (${detail}): nothing was blamed, no case was minted, ` +
          `and that branch is unverified.`
        : seen < 2
          ? `RE-RUN \`next-case\` ONCE: the tree is re-measured from scratch, and a stable answer — green or red — ` +
            `completes the pass. Do NOT edit code: no branch was blamed and there is nothing to fix. If the same ` +
            `tree comes back UNSTABLE again, REPORT AND STOP.`
        : `REPORT to the owner and STOP: the same tree measured UNSTABLE ${seen} times on ${unstable.branch} ` +
          `(${detail}). The suite is unstable under load on that branch; nothing was merged onward, nothing was ` +
          `blamed and no case was minted. Do not re-run and do not edit code.`,
    });
    return 1;
  }
  if (open.length === 0 && redBranch) {
    // Red, and nothing left to SERVE for it. Two very different endings:
    //
    //  (a) a fix for it is already written and HELD but not yet PUBLISHED —
    //      `finish` is what pushes the fix/sweep ref and opens the PR, so the
    //      pass is not over and saying "report to the owner" strands the fix in
    //      the pass dir: pr-intent journaled, zero refs pushed, zero PRs — the
    //      work exists and the owner cannot see it.
    //  (b) nothing to publish either (already gated on origin, or nothing
    //      blameable) — then it really is a stop.
    //
    // Never `finalize` in either case: that reads as "all done" while the branch
    // is broken and nothing merged.
    const unpublishedHeld = [...journaledCases(journal).values()].filter(
        (jc) =>
          lastDisposition(journal, jc.caseId)?.action === 'held' &&
          !journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId),
      );
    st = { ...st, phase: 'open', currentCase: null };
    writeMachineState(dir, st);
    if (unpublishedHeld.length > 0) {
      const who = unpublishedHeld.map((jc) => jc.branch).join(', ');
      progress(`${redBranch.branch} still RED — ${unpublishedHeld.length} held fix(es) awaiting publication`);
      console.error(`next-case: ${redBranch.branch} red; ${unpublishedHeld.length} held fix(es) not yet published — finish`);
      result(cli, {
        status: 'finalize',
        heldAwaitingPublish: unpublishedHeld.map((jc) => ({ caseId: jc.caseId, branch: jc.branch })),
        instruction:
          `run \`finish\` — ${redBranch.branch} is still RED (${redBranch.failedNames.join(', ')}) and the fix for it ` +
          `is HELD on ${who} but NOT yet published. \`finish\` opens the PR that puts it in front of the owner; ` +
          `until it runs, the fix exists only in the pass directory. Report AFTER it completes.`,
      });
      return 0;
    }
    console.error(`next-case: ${redBranch.branch} red, no case servable — ${redGate?.reason ?? ''}`);
    result(cli, {
      ok: false,
      status: 'stopped',
      ...(redGate?.gated.length ? { gatedBranches: redGate.gated } : {}),
      instruction:
        `REPORT to the owner: ${redBranch.branch} is RED before this pass merges anything ` +
        `(${redBranch.failedNames.join(', ')}) and no gate-fix case could be served — ${redGate?.reason ?? 'no reason recorded'}. ` +
        `Nothing was merged.`,
    });
    return 1;
  }
  if (open.length === 0) {
    st = { ...st, phase: 'open', currentCase: null };
    writeMachineState(dir, st);
    progress(`no more cases${activeGates.length ? ` (${activeGates.length} branch(es) gated)` : ''}`);
    console.error(`next-case: no more cases — finalize (run \`finish\`)${gateNote}`);
    // A RED NOBODY COULD BE HANDED IS NOT "ALL DONE". There is genuinely nothing
    // left to SERVE — no branch may be blamed, so no case exists — and `finish`
    // is still the right next command: its integration verify measures the
    // content, and the refusal reaches the owner through the finish result. But
    // an instruction that says only "no case is open" invites the agent to
    // report a clean pass, and the refusal is the pass's least visible finding.
    const refusedReds = unmintableReds(journal);
    const refusedNote = refusedReds.length
      ? ` A red was PROVEN and could be handed to no branch (${refusedReds
          .map((u) => `${u.branch}${u.id ? ` (${u.id})` : ''}`)
          .join(', ')}), so no case was minted for it: \`finish\` measures the content and carries the finding — ` +
        `report it to the owner from the finish result, not as a clean pass.`
      : '';
    result(cli, {
      status: 'finalize',
      ...(activeGates.length ? { activeGates } : {}),
      ...(refusedReds.length ? { unmintableReds: refusedReds } : {}),
      instruction: `no case is open — run \`finish\`.${gateNote}${refusedNote}`,
    });
    return 0;
  }

  const jc = open[0];
  const caseFile = readCaseFile(join(dir, jc.caseId, 'case.json'));
  const worktree = caseWorktreePath(dir, jc.caseId);
  // A REISSUE case (driver-journaled at start) is served as a REVISION —
  // the worktree carries the prior published resolution and the materials carry
  // the FULL time-ordered review dialog, never the fresh-conflict briefing.
  const caseRow = journal.find((e) => e.action === 'case' && e.caseId === jc.caseId) ?? null;
  const isReissue = caseRow?.reissue === true;
  // A GATE-FIX case has no merge and no markers — the briefing is the
  // failing build, not a conflict.
  const isGateFix = caseRow?.gateFix === true;
  progress(
    `case ready: ${jc.branch} — ${caseFile.conflictedPaths.join(', ')}${isReissue ? ' (REISSUE — revise the published resolution)' : ''}`,
  );
  // SERVE BOUND. Every serve is journaled, so "handed out N times, concluded
  // zero times" is answerable: `case` rows come from `run`,
  // `report` and the gate-fix reopen, never from here, so without this row a
  // re-serve would leave no trace at all.
  const servedBefore = readJournal(dir).filter((e) => e.action === 'case-served' && e.caseId === jc.caseId).length;
  const serves = servedBefore + 1;
  if (serves > CASE_SERVE_LIMIT) {
    const detail =
      `case '${jc.caseId}' has been served ${serves} times and never concluded — no resolution, no ` +
      `\`report-case\`, no escalation. Reading it again will not change that. Run ` +
      `\`report-case --tier held\` and write what you found: an unfixable case with a diagnosis is a ` +
      `valid outcome, an unanswered one is not.`;
    // THE REFUSAL WITHDRAWS INVESTIGATION, NOT THE ABILITY TO CONCLUDE. The
    // instruction it carries is `report-case --tier held`, and `report-case`
    // hard-requires phase `case-ready` with a current case. Leaving the phase
    // as it was hands the agent an instruction this same driver rejects: the
    // case stays open, `finish` halts on ERR34_CASES_REMAIN, and the pass has
    // no legal move left. So the phase the instruction needs is written first.
    st = { ...st, phase: 'case-ready', currentCase: { caseId: jc.caseId, branch: jc.branch } };
    writeMachineState(dir, st);
    appendJournal(dir, { action: 'case-serve-limit', id: 'ERR44_CASE_LOOPING', caseId: jc.caseId, branch: jc.branch, serves, detail });
    console.error(`next-case [ERR44_CASE_LOOPING]: ${detail}`);
    result(cli, { ok: false, status: 'looping', caseId: jc.caseId, serves, issues: [{ id: 'ERR44_CASE_LOOPING', detail }] });
    return 1;
  }
  // A REFUSED SERVE IS NOT A SERVE. Recorded above the check, the refusal counts
  // itself: the journal then answers "how many times was this case handed out"
  // with a number that includes every time the driver declined to hand it out,
  // and that number grows on each further call.
  appendJournal(dir, { action: 'case-served', caseId: jc.caseId, branch: jc.branch, serves });
  const loopWarning =
    serves >= CASE_SERVE_WARN
      ? `WARN46_CASE_LOOPING: this case has now been served ${serves} times with no conclusion. If you are ` +
        `re-reading files you have already read, you are not going to fix it — run \`report-case --tier held\` ` +
        `and write the diagnosis. The next serve is refused.`
      : null;

  // Every case carries the fixed checks-contract line (typechecks now; tests are
  // report-case's job) — served in both the materials and the result.
  const materials =
    (isGateFix
      ? gateFixCaseMaterials(dir, jc, caseRow!)
      : isReissue
        ? await reissueCaseMaterials(cli, dir, jc, caseRow!)
        : await machineCaseMaterials(cli, dir, jc)) +
    (loopWarning ? `\n\n## LOOP WARNING\n${loopWarning}\n` : '') +
    `\n\n${CHECKS_HANDOFF_LINE}`;
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
    // Pending too, and in scope — the agent's report should not read them as
    // files it wandered into.
    ...(caseFile.carriedPaths?.length ? { carriedPaths: caseFile.carriedPaths } : {}),
    run: caseFile.run ?? [caseFile.head],
    ...(isReissue ? { reissue: true, prNumber: caseRow!.prNumber ?? null } : {}),
    ...(activeGates.length ? { activeGates } : {}),
    ...(loopWarning ? { serves, warning: loopWarning } : {}),
    materials,
    materialsPath: join(dir, jc.caseId, 'materials.md'),
  });
  return 0;
}

// --------------------------------------------------------------------------
// `report-case --not-my-bug` — adjudicate the claim, then route the failure.
// --------------------------------------------------------------------------

/** PR-description prefix for a hold caused by an UNSTABLE check, not a defect. */
const ESCALATE_FLAKY = '[AUTO-ESCALATED: check unstable]';

/**
 * PR-description prefix for a hold caused by a red that is REAL, PRE-EXISTING
 * and mintable on no branch — the owner is being told about a defect nobody can
 * be handed, not about an unstable check.
 */
const ESCALATE_UNMINTABLE = '[AUTO-ESCALATED: red owned by no branch]';

/**
 * What the gate should do with the claim. `handled` means this function already
 * emitted the result and the command is over; otherwise the gate falls through
 * to its normal ERR36/ERR40 answer, enriched with `note`/`yours`.
 */
interface NotMyBugOutcome {
  handled: boolean;
  code?: number;
  note?: string;
  /** Refused: the failing files that ARE the agent's, so the gate can name them. */
  yours?: string[];
}

/**
 * Adjudicate `--not-my-bug` and route the outcome.
 *
 * FEEDBACK IS PART OF THE CONTRACT here, not decoration. Everything this does
 * is invisible to the agent — it runs test suites across trees the agent never
 * sees, for minutes at a time — and the agent is the only thing that can tell
 * the owner what is happening. So every stage emits a `SWEEP-STEP:` line, every
 * verdict is journaled with the probe log that produced it, and the result
 * carries a `notMyBug` block the agent can report verbatim.
 */
async function adjudicateNotMyBug(p: {
  cli: Cli;
  ctx: PassCtx;
  dir: string;
  caseId: string;
  caseDir: string;
  /**
   * The RE-DERIVED case (§7 trust boundary), never `case.json`. Ownership routing
   * reads `parent` and `head.sha` from here: `case.json` is agent-writable, and
   * those two values choose which branch gets a gate-fix case minted on it.
   */
  rc: ResolvedCase;
  wtPath: string;
  resolvedTree: string;
  kind: 'typecheck' | 'test';
  failedCommands: VerifyCommand[];
  failingOutput: string;
  runChecks: ChecksRunner;
  runInstall?: InstallRunner;
}): Promise<NotMyBugOutcome> {
  const { cli, ctx, dir, caseId, rc, wtPath, kind, failedCommands, failingOutput } = p;
  const branch = rc.branch;
  const all = countFailingFiles(rootChecksOutput(failingOutput, failedCommands));

  // A failure IN A CONFLICTED PATH is never adjudicable, and must be dropped
  // before anything else. The baseline is the clean prefix, which holds each
  // conflicted path at the branch's PRE-MERGE blob (or omits it, when the path
  // was added on theirs) against an otherwise fully merged tree — precisely the
  // incompatibility the conflict is about. So a conflicted file fails there for
  // reasons that have nothing to do with the agent's resolution being right or
  // wrong: a genuine regression in it would be "confirmed" pre-existing, and a
  // path added on theirs can never fail there, guaranteeing a false refuse.
  // Those files are inside the agent's own edit scope anyway — they are its work
  // by definition, so there is no claim to make about them.
  const conflicted = new Set(rc.conflictedPaths);
  const resolved = new Map([...all].filter(([f]) => !conflicted.has(f)));
  const files = [...resolved.keys()];
  const dropped = [...all.keys()].filter((f) => conflicted.has(f));
  if (files.length === 0) {
    const why = dropped.length
      ? `every failure is in a file you are resolving (${dropped.join(', ')}) — that is your work by definition`
      : 'the failing output named no source file outside your conflicted paths';
    appendJournal(dir, { action: 'not-my-bug', caseId, branch, kind, verdict: 'refused', files: dropped, detail: why });
    progress(`not-my-bug: REFUSED — ${why}`);
    return { handled: false, note: why, yours: dropped };
  }
  progress(
    `not-my-bug: adjudicating ${files.length} failing file(s) [${files.join(', ')}] against the pre-conflict tree` +
      (dropped.length ? ` (${dropped.length} in your conflicted paths are yours and were dropped)` : ''),
  );

  // The baseline: the case worktree's own HEAD — the CLEAN PREFIX commit, the
  // whole merge minus the agent's resolution. Its parent is the branch tip the
  // merge was attempted from, which is the first ownership probe below.
  const headSha = (await git(cli.repo, ['rev-parse', 'HEAD'], { cwd: wtPath, allowCodes: [128] })).stdout.trim();
  const branchTip = (await git(cli.repo, ['rev-parse', 'HEAD^'], { cwd: wtPath, allowCodes: [128] })).stdout.trim();
  if (!headSha) {
    return { handled: false, note: 'the pre-conflict tree could not be resolved from the case worktree' };
  }

  // TWO probes over ONE temp worktree. The adjudication runs the failed commands
  // WHOLE, so both sides of the comparison are the population the gate measured;
  // the bisect narrows to the failing files, since it compares a commit against
  // its own history and full-suite cost is not affordable across a dozen probes.
  //
  // NEITHER forces an environment. Pinning the CASE's dependency tree onto
  // every probe (so a lockfile difference could not decide a verdict) would
  // corrupt the side that is already RIGHT — the clean prefix carries the
  // merged manifests — buying comparability by corrupting the correct
  // observation, which yields a false `pre-existing`, a converged bisect and a
  // PR against the wrong branch. Each tree gets its own dependencies.
  const { probe, runs, dispose } = makeSubsetProbe(cli, failedCommands, p.runChecks, wtPath, p.runInstall);
  const { probe: narrowProbe, runs: narrowRuns, dispose: disposeNarrow } = makeSubsetProbe(
    cli,
    failedCommands,
    p.runChecks,
    wtPath,
    p.runInstall,
    { narrow: true },
  );
  try {
    const verdict = await classifyFailure(resolved, headSha, probe);
    appendJournal(dir, {
      action: 'not-my-bug',
      caseId,
      branch,
      kind,
      verdict: verdict.verdict,
      files: verdict.files,
      probes: verdict.probes,
      detail: verdict.detail,
      runs,
    });
    progress(`not-my-bug: ${verdict.verdict.toUpperCase()} — ${verdict.detail}`);
    console.error(`report-case [not-my-bug]: ${verdict.verdict} — ${verdict.detail}`);

    // ENVIRONMENT FAULT. A broken environment reproduces identically on both
    // trees, so the verdict is a perfectly
    // correct "not caused by your resolution" — about a failure no code change
    // can fix. Left unchecked the driver blames a branch and mints a
    // many-file gate fix whose log holds missing bindings and zero
    // assertions. Checked here, before any routing decision.
    const envFault = classifyEnvironmentFault(failingOutput);
    if (envFault.isEnvironment) {
      appendJournal(dir, {
        action: 'not-my-bug-environment',
        caseId,
        branch,
        kind,
        signature: envFault.signature,
        files: [...resolved.keys()],
        detail: envFault.detail,
      });
      progress(`not-my-bug: ENVIRONMENT FAULT — ${envFault.signature} — no gate-fix case minted`);
      console.error(`report-case [WARN14_ENVIRONMENT_FAULT]: ${envFault.detail}`);
      result(cli, {
        ok: false,
        status: 'stopped',
        stoppedAt: 'not-my-bug',
        issues: [{ id: 'WARN14_ENVIRONMENT_FAULT', detail: envFault.detail }],
        notMyBug: { verdict: 'environment', signature: envFault.signature, files: [...resolved.keys()], detail: envFault.detail },
        instruction:
          `REPORT to the owner: ${envFault.detail} Nothing was merged and no case was created. ` +
          `Do NOT try to fix this in code and do NOT re-run — the dependency trees must be rebuilt first.`,
      });
      return { handled: true, code: 1 };
    }

    if (verdict.verdict === 'caused-by-case') {
      // Refused — and the driver now knows exactly WHICH failures are the
      // agent's, which is strictly better steering than "read the output".
      return { handled: false, note: verdict.detail, yours: verdict.files };
    }
    if (verdict.verdict === 'undecidable') {
      return { handled: false, note: verdict.detail };
    }
    if (verdict.verdict === 'flaky') {
      // Nobody's defect: it did not reproduce on either tree. There is no owner
      // to root a fix on and no reason to make the agent keep trying, so the
      // case goes to the owner with its resolution INTACT and the instability
      // named. Over-blocking, visibly, with an artifact — the safe direction.
      await freezeHeld(cli, dir, rc, [`checks unstable (${verdict.files.join(', ')}) -> HELD (resolution kept)`], {
        resolvedTree: p.resolvedTree,
        escalation: { tag: ESCALATE_FLAKY, feedback: verdict.detail.slice(0, COLDREAD_FEEDBACK_CAP) },
      });
      reopen(dir, [rc.branch, ...rc.descendants]);
      const st = readMachineState(dir);
      writeMachineState(dir, { ...st!, phase: 'awaiting-pr', currentCase: { caseId, branch, tier: 'held' } });
      progress(`not-my-bug: held (unstable check) — ${branch}`);
      result(cli, {
        instruction: prHandoff(
          dir,
          caseId,
          `provide PR description — your resolution stands; the hold is an UNSTABLE check (${verdict.files.join(', ')}) that ` +
            `passes and fails on the same tree. Say that plainly and name it.`,
        ),
        tier: 'held',
        notMyBug: { verdict: verdict.verdict, files: verdict.files, probes: verdict.probes, detail: verdict.detail },
        issues: [],
      });
      return { handled: true, code: 0 };
    }

    // CONFIRMED pre-existing. The prefix proves it is not the agent's; it cannot
    // say whose — and "whose" need not be a single branch. PARTITION the failing
    // set instead: every file ends up in a proven owner's group or in a NAMED
    // remainder, and no file is ever folded into an owner that does not own it.
    progress('not-my-bug: confirmed — partitioning the failure by owner (branch tip, then parent head)');
    const partition = await partitionOwners(verdict.files, branchTip, rc.head.sha, probe, {
      // A file that does not EXIST at a tip cannot fail there, and a runner asked
      // for a path it cannot find exits non-zero with nothing parseable — which
      // the probe reports as unusable. The ordinary case is exactly this: the
      // failing test arrived WITH the merge, so it is absent from the branch tip.
      // Answering "absent" from git is both cheaper and unambiguous.
      hasAnyFile: async (sha, fs) => {
        for (const f of fs) {
          const r = await git(cli.repo, ['cat-file', '-e', `${sha}:${f}`], { allowCodes: [1, 128] });
          if (r.code === 0) return true;
        }
        return false;
      },
      // PAID ONCE PER (SUBTREE, COMMAND), not once per path and not once per
      // branch. Where the pass already confirmed these commands on the subtrees
      // this commit carries, the confirming probe here would buy a journaled
      // fact at the price of another full run of the failing commands — and it
      // would buy it as a SECOND observation, which it is not: the same bytes
      // measured again at a different ref is the first measurement, restated.
      // PROVEN OWNER MUST MEAN MINTABLE OWNER, so this asks exactly what the mint
      // asks: confirmed, AND confirmed on the branch this side would blame. A
      // branch-blind version proves owners the mint then refuses — after the
      // merge has been aborted for them.
      confirmedRed: async (sha) => {
        const known = redConfirmations(readJournal(dir));
        const on = sha === branchTip ? branch : rc.parent;
        const keys = await checkVerdictKeys(cli.repo, sha, failedCommands).catch(() => []);
        return (
          keys.length > 0 &&
          keys.every((k) => {
            const rec = known.get(checkKey(k.subtree, k.cmd));
            return rec?.reproduced === true && rec.branch === on;
          })
        );
      },
      // THE OTHER HALF OF THE SAME QUESTION: a red these bytes already carry from
      // another branch. One command settled elsewhere is enough — the mint needs
      // EVERY command confirmed here, and nothing measured on this commit can
      // supply what is already settled for the identical subtree.
      sharedRed: async (sha) => {
        const known = redConfirmations(readJournal(dir));
        const on = sha === branchTip ? branch : rc.parent;
        const keys = await checkVerdictKeys(cli.repo, sha, failedCommands).catch(() => []);
        for (const k of keys) {
          const rec = known.get(checkKey(k.subtree, k.cmd));
          if (rec?.reproduced === true && rec.branch !== on) return rec.branch;
        }
        return null;
      },
      // A RED THIS PROBE MEASURED ITSELF IS STILL ONE OBSERVATION. Its two runs
      // share a worktree and a moment — that is what makes them comparable for
      // the FILE-level partition, and what makes them useless as a determinism
      // check. So the accusation is confirmed the way every other accusation is:
      // one varied re-run, in a separately prepared worktree, journaled where the
      // mint below can read it.
      measuredRed: async (sha) => {
        return confirmRed(dir, {
          branch: sha === branchTip ? branch : rc.parent,
          sha,
          phase: 'ownership',
          failed: await checkVerdictKeys(cli.repo, sha, failedCommands),
          rerun: (again) =>
            variedRerun(
              cli,
              sha,
              failedCommands.filter((c) => again.some((k) => k.cmd === c.cmd)),
              p.runChecks,
              p.runInstall,
            ),
        });
      },
    });
    /** The branch a group's fix has to land on. */
    const branchOf = (g: OwnerGroup): string => (g.owner === 'branch' ? branch : rc.parent);
    // SHALLOWEST OWNER FIRST, and in this one order everywhere — journal, mints
    // and result. The parent sits above this branch, so a judged fix there plus
    // the reopen it triggers can moot the branch's own case before it is worked,
    // and `next-case` serves in DAG order so it reaches the parent first anyway.
    // Reporting any other order would make the case this result NAMES a different
    // one from the case the next command hands over.
    const ownerGroups = [...partition.groups].sort((x, y) => (x.owner === y.owner ? 0 : x.owner === 'parent' ? -1 : 1));
    const owners = ownerGroups.map((g) => ({ owner: g.owner, branch: branchOf(g), ref: g.ref, files: g.files }));
    for (const g of ownerGroups) {
      appendJournal(dir, {
        action: 'not-my-bug-owner',
        caseId,
        branch,
        owner: g.owner,
        ownerBranch: branchOf(g),
        ref: g.ref,
        files: g.files,
        detail: g.detail,
      });
    }
    if (partition.remainder) {
      // THE REMAINDER GETS A ROW OF ITS OWN. It is the answer most easily lost:
      // no case is minted for it, so without this the only trace that those files
      // were seen at all is the absence of one — and a reader comparing the
      // failing set against the minted cases has to infer what happened to them.
      appendJournal(dir, {
        action: 'not-my-bug-owner',
        caseId,
        branch,
        owner: partition.remainder.kind,
        ownerBranch: null,
        ref: partition.remainder.ref,
        files: partition.remainder.files,
        detail: partition.remainder.detail,
      });
    }
    appendJournal(dir, {
      action: 'not-my-bug-partition',
      caseId,
      branch,
      owners: ownerGroups.map((g) => ({ owner: g.owner, branch: branchOf(g), ref: g.ref, files: g.files })),
      remainder: partition.remainder ? { kind: partition.remainder.kind, files: partition.remainder.files } : null,
      rounds: partition.rounds,
      probes: partition.probes,
    });
    progress(
      `not-my-bug: ${partition.groups.length} proven owner(s) in ${partition.rounds} locate round(s)` +
        (partition.remainder ? `; ${partition.remainder.files.length} file(s) ${partition.remainder.kind}` : ''),
    );
    // A RED TWO BRANCHES SHARE IS A FLOOR, NOT A DEAD END. The partition stops
    // on it because nothing IT measured distinguishes the two branches — but
    // that is a statement about measurement, and authorship is a different
    // question with a different answer. So the shared remainder joins the floor
    // groups below and the ceiling step decides it, exactly as it decides a
    // proven owner. What it may not do is end the case before that question has
    // been asked.
    const sharedRemainder =
      partition.remainder?.kind === 'shared' && partition.remainder.ref ? partition.remainder : null;
    /** The remainder no gate fix can cover — a promoted one is not one of those. */
    const remainder = sharedRemainder ? null : partition.remainder;

    if (partition.groups.length === 0 && !sharedRemainder) {
      // NOTHING WAS PLACED, so the remainder is the whole failing set and the two
      // answers that are not a gate fix apply to it unchanged.
      const rest = partition.remainder!;
      if (rest.kind === 'unknown') {
        return { handled: false, note: `${verdict.detail}; but ${rest.detail}` };
      }
      if (rest.kind === 'flaky' || rest.kind === 'shared') {
        // A SIDE THAT NAMES NEITHER AN OWNER NOR A COMMIT ENDS THE CASE HERE. The
        // failure is real on the merged tree and it is not the agent's — the
        // adjudication proved that — but the tip that would be blamed is red once
        // and green once on the identical tree, or its red sits at no commit the
        // ceiling step could measure. Either way there is no branch to root a fix
        // on and nothing for the agent to fix, so the case goes to the owner with
        // its resolution INTACT and the reason named. Over-blocking, visibly,
        // with an artifact.
        const shared = rest.kind === 'shared';
        const id = shared ? 'WARN22_RED_UNCONFIRMED' : 'WARN21_CHECKS_FLAKY';
        await freezeHeld(
          cli,
          dir,
          rc,
          [
            shared
              ? `pre-existing red no branch can be handed (${rest.files.join(', ')}) -> HELD (resolution kept)`
              : `ownership probe unstable (${rest.files.join(', ')}) -> HELD (resolution kept)`,
          ],
          {
            resolvedTree: p.resolvedTree,
            escalation: {
              tag: shared ? ESCALATE_UNMINTABLE : ESCALATE_FLAKY,
              feedback: rest.detail.slice(0, COLDREAD_FEEDBACK_CAP),
            },
          },
        );
        reopen(dir, [rc.branch, ...rc.descendants]);
        const stFlaky = readMachineState(dir);
        writeMachineState(dir, { ...stFlaky!, phase: 'awaiting-pr', currentCase: { caseId, branch, tier: 'held' } });
        progress(`not-my-bug: held (${shared ? 'no branch can be handed the fix' : 'ownership probe unstable'}) — ${branch}`);
        console.error(`report-case [${id}]: ${rest.detail}`);
        result(cli, {
          instruction: prHandoff(
            dir,
            caseId,
            shared
              ? `provide PR description — your resolution stands and NO branch was blamed: the red that would have ` +
                `named an owner (${rest.files.join(', ')}) is PRE-EXISTING and belongs to no branch — ${rest.detail}. ` +
                `Say that plainly and name it.`
              : `provide PR description — your resolution stands and NO branch was blamed: the check that would have ` +
                `named an owner (${rest.files.join(', ')}) is UNSTABLE — red once and green once on the same tree. ` +
                `Say that plainly and name it.`,
          ),
          tier: 'held',
          notMyBug: { verdict: verdict.verdict, files: rest.files, owner: rest.kind, probes: verdict.probes + partition.probes, detail: rest.detail },
          uncovered: { kind: rest.kind, files: rest.files, detail: rest.detail },
          issues: [{ id, detail: rest.detail }],
        });
        return { handled: true, code: 0 };
      }
      // Neither side is red alone: this merge produced it, so it belongs to THIS
      // case. Widen the edit scope to the failing files (the scope guard reads
      // the widening from the journal) and hand the failure back — the one
      // special case the owner sanctioned: let the agent edit files that are not
      // conflicted, and let the cold read accept a change that resolves no
      // markers.
      appendJournal(dir, { action: 'scope-widened', caseId, branch, files: rest.files, reason: rest.detail });
      progress(`not-my-bug: scope widened — you may now edit ${rest.files.join(', ')}`);
      console.error(`report-case [WARN12_SCOPE_WIDENED]: ${caseId} may now edit ${rest.files.join(', ')}`);
      result(cli, {
        status: 'scope-widened',
        instruction:
          `${rest.detail}. Your EDIT SCOPE now also includes ${rest.files.join(', ')} — fix the failure there, ` +
          `then re-run report-case. The cold reader is told these files were added to the scope and why.`,
        widenedPaths: rest.files,
        notMyBug: { verdict: verdict.verdict, files: verdict.files, owner: rest.kind, probes: verdict.probes + partition.probes },
        issues: [{ id: 'WARN12_SCOPE_WIDENED', detail: rest.detail }],
      });
      return { handled: true, code: 1 };
    }

    /** One branch a fix will be rooted on, and the files that go with it. */
    interface MintTarget {
      /** Which side of the merge the FLOOR evidence came from — for the briefing. */
      owner: OwnerGroup['owner'];
      branch: string;
      /** The commit the case is rooted at and the red observation is keyed to. */
      ref: string;
      /**
       * EVERY commit this target was assembled from, `ref` first.
       *
       * A target is the union of the floors that route to one branch, and those
       * floors were measured at DIFFERENT commits — a parent floor at the case's
       * merge point, a lift at the branch tip that has since moved past it. Their
       * subtrees differ, so a single key would find no record for one half and
       * refuse the whole target, including the half that was solidly confirmed.
       */
      refs: string[];
      files: string[];
      detail: string;
      /** `branch` is the proven CEILING for `files` — see `redObservationUsable`. */
      attributedCeiling: boolean;
    }
    /** A target that CANNOT be handed a fix, and why it cannot. */
    interface RefusedOwner {
      target: MintTarget;
      ownerBranch: string;
      /** The finding's id, where the refusal has one the agent must report. */
      id?: string;
      detail: string;
      subtrees?: Array<{ cmd: string; cwd?: string; subtree: string }>;
    }

    // THE FLOOR IS WHERE THE RED WAS MEASURED; THE CEILING IS WHERE THE FIX GOES.
    //
    // A branch that is red on a defect it INHERITED is a true observation and a
    // false accusation. Minting there gives every sibling carrying the same
    // content its own case for one defect, and each of those fixes reaches only
    // its own branch. So blame is lifted to the shallowest branch that AUTHORED
    // the failing content, where one fix reaches every red beneath it.
    //
    // LIFTING IS BOUNDED AT BOTH ENDS. Authorship bounds it from above — above
    // that line the content is not there to be wrong — and a MEASUREMENT bounds
    // it from below: a ceiling that is green is not where the defect is, so the
    // red stays on the floor that showed it. Authorship alone never mints; a
    // confirmation at the ceiling is what licenses the case there.
    const floors: Array<{ owner: OwnerGroup['owner']; branch: string; ref: string; files: string[]; detail: string }> = [
      ...ownerGroups.map((g) => ({ owner: g.owner, branch: branchOf(g), ref: g.ref, files: g.files, detail: g.detail })),
      ...(sharedRemainder
        ? [
            {
              owner: (sharedRemainder.ref === branchTip ? 'branch' : 'parent') as OwnerGroup['owner'],
              branch: sharedRemainder.ref === branchTip ? branch : rc.parent,
              ref: sharedRemainder.ref!,
              files: sharedRemainder.files,
              detail: sharedRemainder.detail,
            },
          ]
        : []),
    ].sort((x, y) => (x.owner === y.owner ? 0 : x.owner === 'parent' ? -1 : 1));

    const targets: MintTarget[] = [];
    const refusedOwners: RefusedOwner[] = [];
    // TWO FLOORS THAT LIFT TO ONE BRANCH ARE ONE DEFECT AND ONE CASE. Minting per
    // floor would put two competing gate fixes on the same ref, where the mint's
    // own per-branch key refuses the second and its files are silently dropped.
    // A lift also carries the ref with it: the confirmation that licensed it was
    // taken at the ceiling's tip, so that is the commit the case rests on.
    const addTarget = (t: MintTarget): void => {
      const seen = targets.find((x) => x.branch === t.branch);
      if (!seen) {
        targets.push({ ...t, files: [...t.files], refs: [...new Set(t.refs)] });
        return;
      }
      seen.files = [...new Set([...seen.files, ...t.files])];
      seen.refs = [...new Set([...seen.refs, ...t.refs])];
      if (t.attributedCeiling && !seen.attributedCeiling) {
        seen.ref = t.ref;
        seen.attributedCeiling = true;
        // The ATTRIBUTED ref leads: it is the one a lift's confirmation was taken
        // at, so it is the first the mintability check should try.
        seen.refs = [t.ref, ...seen.refs.filter((r) => r !== t.ref)];
      }
      seen.detail = boundedDetail(`${seen.detail}; ${t.detail}`);
    };

    for (const floor of floors) {
      // A RED ON UPSTREAM IS NOT A BLAME QUESTION. `main` is outside the mandate
      // and it is also the shallowest level there is, so nothing can be lifted
      // from it — a "ceiling" below it would move an upstream defect onto a fork
      // branch and manufacture work for a defect that branch does not have. It
      // goes to the preflight as it stands and is refused there, loudly.
      if (floor.branch === ROOT_BRANCH) {
        addTarget({ ...floor, refs: [floor.ref], attributedCeiling: false });
        continue;
      }
      const ceil = await ceilingFor(cli, dir, floor.files);
      const buckets: Array<{ ceiling: string | null; files: string[] }> = [
        ...[...ceil.byCeiling].map(([b, fs]) => ({ ceiling: b as string | null, files: fs })),
        ...(ceil.ties.length > 0 ? [{ ceiling: null, files: ceil.ties.map((t) => t.file) }] : []),
      ];
      // Blame that could not be taken at all lifts nothing: the floor keeps every
      // file it was measured with.
      if (buckets.length === 0) buckets.push({ ceiling: null, files: floor.files });
      for (const b of buckets) {
        // THE EVIDENCE TRAIL. One row per (floor -> target), so a reader can see
        // which question was asked about which files and what answered it.
        const note = (decided: string, detail: string, ceiling: string | null, ceilingRef: string | null): void => {
          appendJournal(dir, {
            action: 'gate-fix-ceiling',
            caseId,
            floor: floor.branch,
            floorRef: floor.ref,
            ceiling,
            ceilingRef,
            files: b.files,
            decided,
            detail,
          });
        };
        // RED WHERE THE CONTENT IS NOT, carried as a NOTE. The same command is
        // confirmed red at a commit that does not carry the failing content, and
        // content cannot break a tree it is absent from — so that red says
        // something about the machine. What it does NOT establish is that THIS
        // red is the same failure: the key is the command, and one command
        // carries many failures. A branch that forked before the failing file
        // existed and is red on its own unrelated defect matches it exactly.
        //
        // So the coordinate is REPORTED and blame is never pushed up on it, but
        // it does not refuse a floor mint that is confirmed: refusing on this
        // would tell an agent that no code change can fix a defect that a code
        // change fixes. Genuine environment faults are refused by
        // `classifyEnvironmentFault`, which keys on the fault's own signature.
        const absent = await redWhereContentIsAbsent(cli, readJournal(dir), b.files, failedCommands);
        const coordinate = absent
          ? `${b.files.join(', ')} affects everything below ${b.ceiling ?? floor.branch}; also red at ` +
            `${absent.sha.slice(0, 12)} which does not carry the content (${absent.file} is not there)`
          : null;
        if (coordinate) note('environment-noted', coordinate, b.ceiling, null);
        /** The floor's own account, this decision's, and the coordinate where there is one. */
        const detailOf = (decision: string): string =>
          boundedDetail([floor.detail, decision, ...(coordinate ? [coordinate] : [])].join('; '));
        const stayOnFloor = (decided: string, detail: string, ceiling: string | null, ceilingRef: string | null): void => {
          note(decided, detail, ceiling, ceilingRef);
          addTarget({
            owner: floor.owner,
            branch: floor.branch,
            ref: floor.ref,
            refs: [floor.ref],
            files: b.files,
            detail: detailOf(detail),
            attributedCeiling: false,
          });
        };
        const lift = (decided: string, detail: string, ceiling: string, ceilingRef: string): void => {
          note(decided, detail, ceiling, ceilingRef);
          addTarget({
            owner: floor.owner,
            branch: ceiling,
            ref: ceilingRef,
            refs: [ceilingRef],
            files: b.files,
            detail: detailOf(detail),
            attributedCeiling: true,
          });
        };
        const refuse = async (decided: string, detail: string, id: string, ceiling: string | null): Promise<void> => {
          note(decided, detail, ceiling, null);
          // The SUBTREES the commands run in at the ref this row is about — the
          // same evidence every other refusal row carries, and what tells a
          // reader which object the finding is keyed to.
          const observed = await checkVerdictKeys(cli.repo, floor.ref, failedCommands).catch(() => []);
          refusedOwners.push({
            target: {
              owner: floor.owner,
              branch: floor.branch,
              ref: floor.ref,
              refs: [floor.ref],
              files: b.files,
              detail,
              attributedCeiling: false,
            },
            ownerBranch: floor.branch,
            id,
            detail,
            subtrees: observed.map((v) => ({ cmd: v.cmd, ...(v.cwd ? { cwd: v.cwd } : {}), subtree: v.subtree })),
          });
        };
        if (b.ceiling === null) {
          stayOnFloor(
            'no-lift-tie',
            `no branch can be named the ceiling for ${b.files.join(', ')}, so blame stays where it was ` +
              `MEASURED, on ${floor.branch}`,
            null,
            null,
          );
          continue;
        }
        if (b.ceiling === floor.branch) {
          stayOnFloor(
            'no-lift-same',
            `${floor.branch} authored ${b.files.join(', ')} — it is both the floor and the ceiling`,
            b.ceiling,
            floor.ref,
          );
          continue;
        }
        const ceilingTip = await revParse(cli.repo, b.ceiling).catch(() => '');
        if (!ceilingTip) {
          stayOnFloor(
            'no-lift-unmeasurable',
            `the ceiling ${b.ceiling} does not resolve in this clone, so it cannot be measured — blame stays ` +
              `on ${floor.branch}`,
            b.ceiling,
            null,
          );
          continue;
        }
        // ALREADY MEASURED THERE. Every failing command is confirmed red on the
        // subtrees the ceiling's tip carries, so the ceiling IS red and nothing
        // needs to be run to learn it — whichever branch happened to take the
        // measurement, since authorship is what distinguishes branches sharing
        // those bytes.
        const known = redConfirmations(readJournal(dir));
        const keys = await checkVerdictKeys(cli.repo, ceilingTip, failedCommands).catch(() => []);
        if (keys.length > 0 && keys.every((k) => known.get(checkKey(k.subtree, k.cmd))?.reproduced === true)) {
          lift(
            'lift-shared',
            `${b.ceiling} authored ${b.files.join(', ')} and every failing command is already confirmed red on ` +
              `the subtrees its tip carries — the fix goes there, where it reaches every red beneath it`,
            b.ceiling,
            ceilingTip,
          );
          continue;
        }
        progress(`not-my-bug: measuring the ceiling ${b.ceiling} for ${b.files.join(', ')}`);
        const at = await confirmRedAt(cli, dir, b.ceiling, ceilingTip, failedCommands, p.runChecks, p.runInstall);
        if (at === 'red') {
          lift(
            'lift-measured',
            `${b.ceiling} authored ${b.files.join(', ')} and its tip is CONFIRMED RED on the failing ` +
              `command(s) — the fix goes there, where it reaches every red beneath it`,
            b.ceiling,
            ceilingTip,
          );
          continue;
        }
        if (at === 'green') {
          stayOnFloor(
            'no-lift-green',
            `${b.ceiling} authored ${b.files.join(', ')} but its tip is GREEN — the red is BELOW the author, ` +
              `so blame stays on ${floor.branch}`,
            b.ceiling,
            ceilingTip,
          );
          continue;
        }
        if (at === 'unstable') {
          // NOT RED AND NOT GREEN. The ceiling answered both ways on one tree, so
          // there is no verdict to lift and no verdict to fall back to either:
          // the floor's own red is the same failure, and it has just been shown
          // to be unstable where the content lives.
          await refuse(
            'refused-unstable',
            `${b.ceiling} authored ${b.files.join(', ')} and its tip is UNSTABLE on the failing command(s) — ` +
              `red once and green once with nothing changed between, so the failure belongs to no branch`,
            'WARN21_CHECKS_FLAKY',
            b.ceiling,
          );
          continue;
        }
        // A SECOND OBSERVATION THAT COULD NOT BE TAKEN MAY NOT LIFT BLAME, and it
        // may not BLOCK a floor mint that is already confirmed either: the floor's
        // evidence is exactly what it was before this was attempted.
        stayOnFloor(
          'no-lift-unmeasurable',
          `the ceiling ${b.ceiling} could not be measured for ${b.files.join(', ')} — blame stays on ${floor.branch}`,
          b.ceiling,
          ceilingTip,
        );
      }
    }

    // DECIDE BEFORE DESTROYING. Everything below the reopen is irreversible for
    // the agent's work: the reopen re-derives the branch, the next
    // `createCaseWorktree` rebuilds the worktree from the automerge tree, and
    // the resolved tree goes to `git gc`. A mint that then REFUSES leaves the
    // pass with the work gone and the case re-served — which is the same case,
    // the same adjudication and the same refusal, every round.
    //
    // So every refusal that is a pure FUNCTION of the journal and git is taken
    // here, first: the mandate boundary, an empty file set, and whether the red
    // may found a case on the branch it would be rooted on. Each is the same
    // question `materializeGateFixCases` asks — that backstop is unchanged and
    // still refuses whatever reaches it — asked before anything is spent.
    const mintableGroups: MintTarget[] = [];
    for (const target of targets) {
      const ownerBranch = target.branch;
      // MANDATE BOUNDARY. `main` is UPSTREAM — never ours to fix, and a fix
      // committed there could not be pushed anywhere the fork controls. The red
      // is real and urgent (the fork is about to merge a broken upstream commit)
      // so it is REPORTED; what the driver must not do is manufacture work.
      if (ownerBranch === ROOT_BRANCH) {
        refusedOwners.push({
          target,
          ownerBranch,
          id: 'WARN15_UPSTREAM_RED',
          detail:
            `the failure is on UPSTREAM ${ROOT_BRANCH} (${target.files.join(', ')}) — outside this sweep's mandate, ` +
            `so no case may be minted there`,
        });
        continue;
      }
      // A case needs at least one named file: an agent handed a fix with nothing
      // in it cannot work it, and the empty case pre-empts the honest stop.
      if (target.files.length === 0) {
        refusedOwners.push({
          target,
          ownerBranch,
          detail: 'the ownership probe named no file for this owner — there is nothing to hand an agent',
        });
        continue;
      }
      // ANY CONSTITUENT REF LICENSES THE TARGET. The refs a target was assembled
      // from were measured at different commits, so their subtrees differ, and a
      // check keyed at one of them finds no record for the others' commands —
      // which would refuse a target whose other half is solidly confirmed. The
      // first ref that answers is the one the case rests on, so `redOn` and the
      // bisect window follow it.
      const usableAt = (ref: string): Promise<RedObservationVerdict> =>
        redObservationUsable(readJournal(dir), cli.repo, ownerBranch, ref, failedCommands, {
          attributedCeiling: target.attributedCeiling,
        });
      // The PRIMARY ref is tried first and its verdict is the one REPORTED: it is
      // where the case would have been rooted, so its reasons are the ones that
      // say why it could not be.
      const red = await usableAt(target.ref);
      if (!red.usable) {
        let licensed: string | null = null;
        for (const ref of target.refs) {
          if (ref === target.ref) continue;
          if ((await usableAt(ref)).usable) {
            licensed = ref;
            break;
          }
        }
        if (licensed === null) {
          refusedOwners.push({
            target,
            ownerBranch,
            id: red.id,
            detail: redRefusalDetail(red.reasons),
            subtrees: red.observed.map((v) => ({ cmd: v.cmd, ...(v.cwd ? { cwd: v.cwd } : {}), subtree: v.subtree })),
          });
          continue;
        }
        target.ref = licensed;
      }
      if (target.refs.length > 1) {
        appendJournal(dir, {
          action: 'gate-fix-red-ref',
          caseId,
          branch: ownerBranch,
          ref: target.ref,
          refs: target.refs,
          commands: failedCommands.map((c) => c.cmd),
        });
      }
      mintableGroups.push(target);
    }
    // A REFUSAL IS A ROW, AND THE ROW CARRIES THE CASE IT CAME FROM. Without the
    // case id a reader cannot tell which adjudication produced it, and `finish`
    // cannot report it beside the case whose failure it describes.
    for (const r of refusedOwners) {
      appendJournal(dir, {
        action: 'gate-fix-refused',
        ...(r.id ? { id: r.id } : {}),
        caseId,
        branch: r.ownerBranch,
        at: r.target.ref,
        files: r.target.files,
        ...(r.subtrees ? { subtrees: r.subtrees } : {}),
        commands: failedCommands.map((c) => c.cmd),
        reason: r.detail,
      });
      console.error(`report-case [${r.id ?? 'gate-fix-refused'}]: ${r.ownerBranch} — ${r.detail}`);
    }
    /** What no gate fix will cover: the partition's remainder plus every refusal. */
    const refusedFiles = [...new Set(refusedOwners.flatMap((r) => r.target.files))];
    const refusedDetail = refusedOwners
      .map((r) => `${r.ownerBranch} [${r.target.files.join(', ')}]: ${r.detail}`)
      .join('; ');
    const refusedIssues = refusedOwners
      .filter((r) => typeof r.id === 'string')
      .map((r) => ({ id: r.id!, detail: `${r.ownerBranch}: ${r.detail}` }));
    // WHAT NO GATE FIX WILL COVER, in one block, whichever way this ends. A
    // remainder folded silently into another owner's case is a misattribution; a
    // remainder dropped is a red build nobody was told about.
    //
    // A REFUSED OWNER BELONGS IN THE SAME SENTENCE. Its files were proven to
    // belong to a branch and no case was minted for them either, so from the
    // owner's side they are in exactly the position of a remainder: still red,
    // nothing prepared. Reporting only the remainder would leave them unsaid.
    const uncovered =
      remainder || refusedFiles.length > 0
        ? {
            kind: remainder ? remainder.kind : 'unmintable-red',
            files: [...(remainder?.files ?? []), ...refusedFiles],
            detail: [...(remainder ? [remainder.detail] : []), refusedDetail].filter(Boolean).join('; '),
          }
        : null;
    const uncoveredNote = uncovered
      ? `NOT COVERED BY ANY GATE FIX: ${uncovered.files.join(', ')} — ${uncovered.detail}. ` +
        `No case was minted for those files and they stay red; report them to the owner.`
      : '';
    /** The remainder's own finding, where it has one — never a footnote on a case. */
    const remainderIssues =
      remainder?.kind === 'flaky'
        ? [{ id: 'WARN21_CHECKS_FLAKY', detail: remainder.detail }]
        : remainder?.kind === 'shared'
          ? [{ id: 'WARN22_RED_UNCONFIRMED', detail: remainder.detail }]
          : [];

    if (mintableGroups.length === 0) {
      // EVERY OWNER WAS PROVEN AND NONE MAY BE HANDED THE FIX. The failure is
      // real, it is pre-existing, and there is no branch to root a case on — so
      // there is nothing for the agent to fix and nothing to gain by taking its
      // resolution away from it. The case goes to the owner with its resolution
      // INTACT and the refusal named, exactly as an unstable side does.
      // Over-blocking, visibly, with an artifact — the safe direction.
      await freezeHeld(
        cli,
        dir,
        rc,
        [`pre-existing red no branch can be handed (${refusedFiles.join(', ')}) -> HELD (resolution kept)`],
        {
          resolvedTree: p.resolvedTree,
          escalation: { tag: ESCALATE_UNMINTABLE, feedback: refusedDetail.slice(0, COLDREAD_FEEDBACK_CAP) },
        },
      );
      // THE BRANCH ONLY, AND ITS DESCENDANTS. No owner's subtree is reopened:
      // no gate fix is being minted on one, so there is nothing above this case
      // for a reopen to clear the way for.
      reopen(dir, [rc.branch, ...rc.descendants]);
      const stUnmintable = readMachineState(dir);
      writeMachineState(dir, { ...stUnmintable!, phase: 'awaiting-pr', currentCase: { caseId, branch, tier: 'held' } });
      progress(`not-my-bug: held (no branch can be handed the fix) — ${branch}`);
      console.error(`report-case [not-my-bug]: no mintable owner — ${refusedDetail}`);
      result(cli, {
        instruction: prHandoff(
          dir,
          caseId,
          `provide PR description — your resolution stands and NO branch was blamed: the failure ` +
            `(${refusedFiles.join(', ')}) is PRE-EXISTING and no branch can be handed a fix for it — ` +
            `${refusedDetail}. Say that plainly and name it.`,
        ),
        tier: 'held',
        notMyBug: {
          verdict: verdict.verdict,
          files: uncovered!.files,
          owners,
          probes: verdict.probes + partition.probes,
          detail: uncovered!.detail,
        },
        uncovered: uncovered!,
        issues: [...refusedIssues, ...remainderIssues],
      });
      return { handled: true, code: 0 };
    }

    // ONE GATE FIX PER PROVEN OWNER, and everything that goes into one is
    // PER-OWNER: the search for the introducing commit, the root and its floor,
    // the rebase note and the duplicate check each describe ONE branch's defect,
    // so running them once over a set spanning two branches answers about neither.
    const trunkHead = await revParse(cli.repo, TRUNK_BRANCH).catch(() => '');
    interface OwnerPlan {
      target: MintTarget;
      ownerBranch: string;
      rootAt: string;
      rootedBelowTip: boolean;
      introduced: { sha: string; subject: string; author: string } | null;
      bisect: BisectOutcome;
      rebaseNote: string;
      dupNote: string;
      dupes: string[];
      gateOutput: string;
    }
    const plans: OwnerPlan[] = [];
    for (const target of mintableGroups) {
      // The owner is a BRANCH — the ceiling for these files, which is this branch,
      // the parent it is merging from, or the level above both that authored them.
      // Name the commit that introduced it before minting the case: a gate fix
      // whose briefing is "this branch is red, here is a log" costs the agent an
      // open-ended search, and the commit is also what tells the owner whether the
      // fix belongs on this branch at all.
      const ownerBranch = target.branch;
      progress(`not-my-bug: searching ${ownerBranch} for the commit that introduced ${target.files.join(', ')}`);
      const bisect = await findIntroducingCommit(
        target.ref,
        target.files,
        narrowProbe,
        repoHistory(cli.repo),
        // The FULL-command fallback. A load-dependent failure exists only under
        // whole-suite load, so a narrowed probe cannot see it and the determinism
        // gate writes it off as a coin flip.
        probe,
        // The FLOOR — bound the SEARCH, do not clamp its answer afterwards: it
        // never spends probes on commits whose answer would be refused, and for a
        // gate fix ON the trunk the window is empty so it returns at once.
        trunkHead,
      );
      let introduced: { sha: string; subject: string; author: string } | null = null;
      if (bisect.status === 'found' && bisect.sha) {
        const info = await git(cli.repo, ['show', '-s', '--format=%s%n%an', bisect.sha], { allowCodes: [128] });
        const [subject = '', author = ''] = info.stdout.split('\n');
        introduced = { sha: bisect.sha, subject, author };
        progress(`not-my-bug: introduced by ${bisect.sha.slice(0, 12)} "${subject}" (${author})`);
      } else {
        progress(`not-my-bug: bisect ${bisect.status} — ${bisect.detail}`);
      }
      appendJournal(dir, {
        action: 'not-my-bug-bisect',
        caseId,
        branch: ownerBranch,
        files: target.files,
        status: bisect.status,
        sha: bisect.sha ?? null,
        anchor: bisect.anchor ?? null,
        lastFailed: bisect.lastFailed ?? null,
        usedFullCommand: bisect.usedFullCommand === true,
        probes: bisect.probes,
        scanned: bisect.scanned ?? null,
        detail: bisect.detail,
        runs: bisect.usedFullCommand ? [...narrowRuns, ...runs] : narrowRuns,
      });

      // THE BISECT NEVER GATES THE CASE. Whether a gate fix is
      // warranted was settled by the verdict (`pre-existing`) and the owner probe;
      // naming the introducing commit only improves the BRIEFING. Suppressing the
      // case because the optional step failed would throw a proven defect away —
      // and incoherently so: two failure modes of one optional step must not have
      // opposite consequences.
      //
      // ROOT AT THE LAST FAILED POINT. When the search cannot name an introducer it
      // still knows the OLDEST commit it saw red, and that is the better root: the
      // fix lands as deep as the evidence supports, so branches sharing that
      // ancestor can take one fix instead of one each. The cost is that the fix is
      // then BEHIND the branch tip, which is what the rebase note below is for.
      //
      // ROOT FLOOR: never deeper than the current trunk head.
      //
      // Rooting a fix at the commit that INTRODUCED a failure is right in
      // principle — branches sharing that ancestor take one fix instead of one
      // each — and catastrophic without a floor: a bisect can name a commit
      // hundreds of commits behind the trunk, making the case worktree a
      // weeks-old tree; the checks gate then demands THAT tree green, and it is
      // red in unrelated files whose fixes simply have not been written yet. The
      // agent cannot win — its case scope is one test, and the gate wants a
      // suite from before half the branch's history existed.
      //
      // The floor is the trunk head: a root must CONTAIN it. Below that line the
      // history is shared and already-integrated, so a fix rooted there carries
      // every intervening divergence for no benefit. Above it, deep rooting still
      // works — a feature branch can root back to where it left the current trunk,
      // which is the case the shared-ancestor argument was actually about.
      const bisectRoot = bisect.sha ?? bisect.lastFailed ?? target.ref;
      const trunkContained =
        bisectRoot === target.ref ||
        !trunkHead ||
        (await git(cli.repo, ['merge-base', '--is-ancestor', trunkHead, bisectRoot], { allowCodes: [1, 128] })).code === 0;
      if (!trunkContained) {
        appendJournal(dir, {
          action: 'gate-fix-root-clamped',
          caseId,
          branch: ownerBranch,
          wanted: bisectRoot,
          usedTip: target.ref,
          reason: `root would predate the ${TRUNK_BRANCH} head — clamped to the branch tip`,
        });
        progress(`not-my-bug: root ${bisectRoot.slice(0, 12)} predates the ${TRUNK_BRANCH} head — rooting at the tip instead`);
      }
      const rootAt = trunkContained ? bisectRoot : target.ref;
      const rootedBelowTip = rootAt !== target.ref;
      const behind = rootedBelowTip
        ? Number(
            (
              await git(cli.repo, ['rev-list', '--count', '--first-parent', `${rootAt}..${target.ref}`], {
                allowCodes: [128],
              })
            ).stdout.trim() || '0',
          )
        : 0;

      // Does the fix, once made HERE, still apply and hold at the TIP? The checks
      // gate will prove it at `rootAt`, which is not the same statement. Probing it
      // costs one run and turns "rebase before merging" from advice into a fact the
      // owner can act on — or a warning that it does not apply at all.
      const rebaseNote = rootedBelowTip
        ? `[ROOTED AT ${rootAt.slice(0, 12)}: ${behind} commit(s) behind the ${ownerBranch} tip — REBASE before merging` +
          `${bisect.status === 'found' ? '' : `; this is the oldest point the search OBSERVED the failure, not a proven introducing commit`}]`
        : '';

      // DUPLICATE ACROSS BRANCHES. An unstable failure surfaces wherever luck puts
      // it, so the same shared test can earn a gate fix on several branches — each
      // genuinely needs it (separate lines of history), but the owner must be told
      // they are one defect so they merge one and rebase or drop the rest.
      //
      // Asked for EVERY owner BEFORE any of them mints, so the sibling cases this
      // same adjudication is about to create cannot be reported as duplicates of
      // each other: the partition made their file sets disjoint, so they are not.
      const dupes = await duplicateGateFixes(cli, dir, ownerBranch, target.files);
      const dupNote = dupes.length > 0 ? `[POSSIBLE DUPLICATE: ${dupes.join('; ')}]` : '';
      if (dupes.length > 0) {
        // Journaled, not only briefed: the overlap is a fact about the pass, and a
        // reader of the journal must not have to reconstruct it from PR prose.
        appendJournal(dir, { action: 'gate-fix-duplicate', branch: ownerBranch, files: target.files, duplicates: dupes });
      }

      const gateOutput =
        `${failingOutput}\n\n--- not-my-bug ---\n${verdict.detail}\n${target.detail}\n${bisect.detail}\n` +
        `this case covers ${target.files.join(', ')} on ${ownerBranch}\n` +
        (introduced ? `introduced by ${introduced.sha} "${introduced.subject}" (${introduced.author})\n` : '') +
        (bisect.usedFullCommand ? `(the search ran the FULL failing command: narrowed to these files it does not reproduce)\n` : '') +
        (rebaseNote ? `${rebaseNote}\n` : '') +
        (dupNote ? `${dupNote}\n` : '');

      plans.push({ target, ownerBranch, rootAt, rootedBelowTip, introduced, bisect, rebaseNote, dupNote, dupes, gateOutput });
    }

    // ABORT THE MERGE, **BEFORE** minting any gate fix. The case's merge was
    // never made — it lives only as the clean prefix in the worktree — so
    // aborting it is a `reopened` row, which supersedes this pass's
    // undispositioned case (`supersededCaseIds`) and drops it out of
    // `openCases` so `next-case` re-derives the branch once the fix has landed.
    //
    // ORDER IS LOAD-BEARING, and it is ALL reopens before ALL mints.
    // `supersededCaseIds` supersedes every undispositioned case whose `case` row
    // PRECEDES its branch's last `reopened`. When an owner is a branch a gate fix
    // was already minted on, reopening after that mint would supersede the fix
    // TOO, the instant it was created: `next-case` would never serve it, the
    // conflict case would be re-emitted, and the pass would loop through a full
    // re-adjudication (bisect included) until the ten-strike backstop. Reopen
    // first and every gate fix's rows land after it, untouched.
    //
    // DESCENDANTS TOO — every other path that blocks a branch does this
    // (`freezeHeld`'s callers, the crash-heal, the resolve path), and reopening
    // only the branch itself is a bug. A branch that has just been proven RED is
    // blocked, and its descendants' OPEN cases were derived against it: they
    // cannot pass, because the red commit is in the very content they are merging.
    // Left open they are served one by one, each failing the same checks, each
    // paying a full adjudication, each hitting the `gateFixKey` anti-loop and
    // falling back to `--tier held` — a queue of junk HELD PRs for one defect.
    // Reopening supersedes them, so they are
    // re-derived against the blocked parent and the existing DEFERRED path holds
    // them until the fix lands. No priority rule is needed: with the descendants
    // superseded, the gate fixes are the only cases left to serve.
    // EVERY OWNER'S SUBTREE, not just this case's. When ownership routes to the
    // PARENT, the gate fix lands on a branch this case is not on — and without
    // this its OTHER children are never reopened, so they stay open, sort ahead
    // of the fix, and are served first: the same "junk PRs queued ahead of the
    // fix" bug, one level up. Everything under a blocked branch
    // is blocked, wherever the case that found it happened to live.
    const ownerSubtrees = plans.flatMap((pl) =>
      pl.ownerBranch === branch ? [] : [pl.ownerBranch, ...transitiveDescendants(planEdgesOf(dir), pl.ownerBranch)],
    );
    reopen(dir, [...new Set([branch, ...rc.descendants, ...ownerSubtrees])]);

    // THE AGENT'S RESOLUTION IS DISCARDED, and the loss is RECORDED. Reopening
    // re-derives the branch and the next `createCaseWorktree` rebuilds this
    // worktree from the automerge tree, so the resolved tree goes to `git gc`.
    // Pinning it under a local ref would not save it in any sense that matters:
    // a local ref never leaves this clone and dies with it, so it is not a
    // delivery channel. Anything that must survive a pass is a PR. The journal
    // row is the whole mechanism — the next attempt re-derives the case from the
    // automerge tree regardless.
    appendJournal(dir, { action: 'not-my-bug-discarded', caseId, tree: p.resolvedTree });
    appendObservation(cli.workspace, { kind: 'not-my-bug-resolution-discarded', caseId, branch: rc.branch });

    const minted: Array<{ plan: OwnerPlan; gate: Awaited<ReturnType<typeof materializeGateFixCases>> }> = [];
    for (const plan of plans) {
      const gate = await materializeGateFixCases(cli, dir, ctx.chain, plan.gateOutput, failedCommands, null, {
        rootBranch: plan.ownerBranch,
        // THE OBSERVATION THIS CASE RESTS ON: the red at the commit this case is
        // rooted on — the ownership probe's own, or the ceiling's confirmation
        // where blame was lifted. Where that ref's subtrees were already red on
        // another branch and no ceiling was proven, the probe measured nothing
        // new — it read a shared verdict — and this refuses the mint rather than
        // dressing one measurement up as two.
        redOn: { at: plan.target.ref, commands: failedCommands },
        // The lift's licence, carried to the backstop: `rootBranch` is the proven
        // ceiling, so a verdict taken on a branch sharing its subtree is a
        // verdict about it.
        attributedCeiling: plan.target.attributedCeiling,
        // The PROVEN subset. `partitionOwners` ran the failing commands at this
        // owner's ref and reported which files fail THERE; the raw log carries
        // more than that — the other owners' files and the paths the adjudication
        // dropped as the agent's own work — so a case scoped from the log would
        // name files this owner does not own.
        ownedFiles: plan.target.files,
        ...(plan.rootedBelowTip ? { rootAt: plan.rootAt } : {}),
        // REPRODUCTION CHARACTER, carried to the briefing. The bisect had to fall
        // back to the FULL failing command because the narrowed probe did not
        // reproduce — i.e. the failure needs the whole suite running. Burying that
        // in a parenthetical at the bottom of the captured output leaves the agent
        // debugging a full-suite-only failure it can never observe (it may not
        // run tests). Whether a failure is observable at all decides what to DO
        // with it, so it
        // belongs at the top of the briefing rather than in a log footer.
        ...(plan.bisect.usedFullCommand ? { fullSuiteOnly: true } : {}),
      });
      minted.push({ plan, gate });
    }
    const cases = minted.flatMap((m) => m.gate.cases.map((c) => ({ ...c, plan: m.plan })));
    const probeTotal = verdict.probes + partition.probes + plans.reduce((n, pl) => n + pl.bisect.probes, 0);
    const unmintedNote = minted
      .filter((m) => !m.gate.served)
      .map((m) => `No case on ${m.plan.ownerBranch} for [${m.plan.target.files.join(', ')}] — ${m.gate.reason}.`)
      .join(' ');

    if (cases.length === 0) {
      // Already gated on origin, or already attempted this pass. Both are real
      // answers the agent must relay rather than retry. The reopen above already
      // superseded this case, so say so plainly instead of implying a retry: the
      // agent's next move is `next-case`, which re-derives the branch.
      const why = minted.map((m) => `${m.plan.ownerBranch}: ${m.gate.reason}`).join('; ');
      progress(`not-my-bug: no gate-fix case served — ${why}`);
      const stNow = readMachineState(dir);
      writeMachineState(dir, { ...stNow!, phase: 'open', currentCase: null });
      result(cli, {
        status: 'stopped',
        issues: [
        { id: 'WARN09_GATE_FIX_SERVED', detail: minted.map((m) => m.gate.detail).join(' | ') },
        // A REFUSAL TRAVELS UNDER ITS OWN ID. "No case was minted" and WHY are
        // different sentences, and the why decides what the agent reports.
        ...minted
          .filter((m) => typeof m.gate.id === 'string')
          .map((m) => ({ id: m.gate.id!, detail: `${m.plan.ownerBranch}: ${m.gate.reason}` })),
        // The files the probe could not settle travel with their OWN id: they
        // are not part of any gate fix, and an unstable check is a finding in
        // its own right rather than a footnote on someone else's case.
        ...remainderIssues,
        ...refusedIssues,
      ],
        notMyBug: {
          verdict: verdict.verdict,
          files: verdict.files,
          owner: ownerGroups[0].owner,
          ownerBranch: plans[0].ownerBranch,
          owners,
          probes: probeTotal,
          detail: verdict.detail,
        },
        ...(uncovered ? { uncovered } : {}),
        instruction:
          `REPORT to the owner: ${verdict.detail}. ${plans.map((pl) => `${pl.ownerBranch} owns [${pl.target.files.join(', ')}]`).join('; ')}. ` +
          `But ${why} — no new case could be prepared. ` +
          (uncoveredNote ? `${uncoveredNote} ` : '') +
          `Run \`next-case\` to continue with the rest of the pass.`,
      });
      return { handled: true, code: 1 };
    }

    const st = readMachineState(dir);
    writeMachineState(dir, { ...st!, phase: 'open', currentCase: null });
    // `gateFix` names the FIRST case (shallowest owner first, as `next-case` will
    // serve them); `gateFixes` carries every one, and the top-level briefing
    // fields describe the case `gateFix` names.
    const first = cases[0];
    const where = cases.map((c) => `${c.caseId} on ${c.branch} [${c.files.join(', ')}]`).join('; ');
    progress(`not-my-bug: merge aborted; ${cases.length} gate-fix case(s) prepared — ${where} — run next-case`);
    console.error(`report-case: gate-fix ${where}; case ${caseId} superseded`);
    result(cli, {
      status: 'gate-fix-required',
      // A PROCEED arm must never carry an ERR id — the agent obeys the id's
      // doctrine row, and an ERR row says "stop and report". WARN advises.
      issues: [
        { id: 'WARN09_GATE_FIX_SERVED', detail: minted.map((m) => m.gate.detail).join(' | ') },
        // The files the probe could not settle travel with their OWN id: they
        // are not part of any gate fix, and an unstable check is a finding in
        // its own right rather than a footnote on someone else's case.
        ...remainderIssues,
        ...refusedIssues,
      ],
      notMyBug: {
        verdict: verdict.verdict,
        files: verdict.files,
        owner: first.plan.target.owner,
        ownerBranch: first.plan.ownerBranch,
        owners,
        probes: probeTotal,
        detail: verdict.detail,
      },
      ...(uncovered ? { uncovered } : {}),
      introducedBy: first.plan.introduced,
      ...(first.plan.rebaseNote ? { rebaseNote: first.plan.rebaseNote } : {}),
      ...(first.plan.dupes.length ? { duplicates: first.plan.dupes } : {}),
      gateFix: { caseId: first.caseId, branch: first.branch, files: first.files, reason: first.reason },
      gateFixes: cases.map((c) => ({
        caseId: c.caseId,
        branch: c.branch,
        files: c.files,
        owner: c.plan.target.owner,
        introducedBy: c.plan.introduced,
        ...(c.plan.rebaseNote ? { rebaseNote: c.plan.rebaseNote } : {}),
        ...(c.plan.dupes.length ? { duplicates: c.plan.dupes } : {}),
      })),
      instruction:
        `Your resolution was not the problem: ${verdict.detail}. ` +
        `${cases.length} gate-fix case(s) prepared: ${where}. ` +
        cases
          .map(
            (c) =>
              `${c.caseId}: ${c.plan.target.detail}` +
              (c.plan.introduced
                ? `; introduced by ${c.plan.introduced.sha.slice(0, 12)} "${c.plan.introduced.subject}" (${c.plan.introduced.author})`
                : `; ${c.plan.bisect.detail}`) +
              (c.plan.rebaseNote ? `; ${c.plan.rebaseNote} — put that line in its PR body` : '') +
              (c.plan.dupNote ? `; ${c.plan.dupNote} — say so in its PR body` : '') +
              '.',
          )
          .join(' ') +
        (unmintedNote ? ` ${unmintedNote}` : '') +
        (uncoveredNote ? ` ${uncoveredNote}` : '') +
        ` This case's merge is ABORTED — run \`next-case\`.`,
    });
    return { handled: true, code: 1 };
  } finally {
    await dispose();
    await disposeNarrow();
  }
}

// --------------------------------------------------------------------------
// `report-case --tier mechanical|judged|held` (DRIVER.md §6.4).
// --------------------------------------------------------------------------

/**
 * `report-case --tier <t>` — the ONLY agent param is `--tier` (a claim;
 * the driver is demote-only) and it is the SINGLE quality gate. Branch order
 * (first match wins, DRIVER.md §6.4):
 *   1. held-duplicate → consolidate into the topmost held twin.
 *   2. adequacy block (ERR06 duplicate).
 *   3. conflicts present + claim ≠ held → ERR32 (resolve first).
 *   4. claim == held + conflicts present (PRISTINE) → reset the worktree to the
 *      pristine conflict, freeze HELD DRAFT, "provide PR description (pristine)";
 *      SKIP checks + cold read.
 *   5. RESOLVED (no conflicts):
 *      5a. CHECKS GATE — typecheck THEN tests in the worktree; a failure writes
 *          `<caseDir>/{typecheck,test}-output.txt`, journals `checks-fail`, and
 *          either returns ERR36/ERR40 (fix + re-run, NO report-attempt) or, at
 *          the CHECKS_FAIL_LIMIT, resets to pristine + HELD DRAFT (escalated).
 *          All pass → `checks-pass` (resets the counter).
 *      5b. report-attempt recorded HERE (post-checks) → RESOLVE_COLDREAD_CAP
 *          counts only cold-read-reaching trees; cap exceeded → HELD ACTIVE.
 *      5c. COLD READ (mechanical + judged + held) → infra→ERR35 halt; 1st
 *          reject→revise; 2nd reject→HELD ACTIVE; confirm+scope→HELD ACTIVE;
 *          confirm+in-scope → mechanical MERGES, judged/held → awaiting-pr.
 */
export async function cmdSweepReportCase(
  cli: Cli,
  invoke: ColdReadInvoker = defaultColdReadInvoker,
  runChecks: ChecksRunner = defaultChecksRunner,
  /** `--not-my-bug` probes install per-tree dependencies; injectable for tests. */
  runInstall?: InstallRunner,
): Promise<number> {
  const claimed = cli.tier;
  if (claimed !== 'mechanical' && claimed !== 'judged' && claimed !== 'held') {
    console.error('report-case: --tier must be mechanical, judged or held');
    return 2;
  }
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  const st = readMachineState(dir);
  const checksFile = applyPassConfig(cli, st);
  if (!st || st.phase !== 'case-ready' || !st.currentCase) {
    console.error('report-case: no case is ready — run `next-case` first');
    return 2;
  }
  const caseId = st.currentCase.caseId;
  const caseDir = join(dir, caseId);
  const caseFile = readCaseFile(join(caseDir, 'case.json'));
  const journal = readJournal(dir);

  // A REISSUE case (driver-journaled at start with `reissue: true`) is a
  // revision of a published resolution — verified against the journal-anchored
  // conflict head + a direct live probe, and ALWAYS routed through HELD (the
  // revision republishes to the EXISTING PR at finish; it never merges here).
  const caseRow = journal.find((e) => e.action === 'case' && e.caseId === caseId) ?? null;
  const isReissue = caseRow?.reissue === true;

  // §7 trust boundary: re-derive the case from git + registry (case.json is only
  // a pointer). Reuses the flag-path's reverifyCase verbatim.
  const isGateFixCase = caseRow?.gateFix === true;
  const rv = isGateFixCase
    ? await reverifyGateFixCase(cli, ctx, caseFile, journal)
    : isReissue
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

  // --- deterministic checks (DRIVER.md §6.4) ------------
  const issues: Issue[] = [];
  const emptyResolution = resolvedTree === rc.automergeTree;
  const markers = await unresolvedMarkers(cli.repo, resolvedTree, rc.conflictedPaths);

  // Scope guard (recomputed automerge/paths + config-derived mode).
  //
  // WIDENED PATHS (`--not-my-bug`, owner = interaction): when both sides of the
  // merge are green in isolation and only the merged tree is red, no upstream
  // branch owns the failure — it is this merge's own, and the fix lives in files
  // that are not conflicted. The driver journals the widening; the guard reads it
  // back so those edits pass instead of reading as a scope violation. This is
  // the one owner-sanctioned special case: let the agent edit
  // non-conflicted files, and let the cold read accept it.
  const widenRows = journal.filter(
    (e) => e.action === 'scope-widened' && e.caseId === caseId && Array.isArray(e.files),
  );
  const widenedPaths = [...new Set(widenRows.flatMap((e) => e.files as string[]))];
  const widenedReason = String(widenRows[widenRows.length - 1]?.reason ?? '');
  // Carried paths are in scope by construction: they are the published
  // resolution's own reach, seeded pending, and the reviewer is looking at them.
  // Booking them as a violation would charge the agent for an edit it inherited.
  const allowedPaths = [...new Set([...rc.conflictedPaths, ...(rc.carriedPaths ?? []), ...widenedPaths])];
  // `conflict-hunks` mode bounds edits to the automerge blob's MARKER SPANS. A
  // widened file has no markers, so every edit in it would be a hunk violation
  // and the widening would be inert — the extra-file violation simply renamed.
  // They are exempt from the hunk check and file-level allowed instead.
  const guard = await scopeGuard(cli.repo, rc.automergeTree, resolvedTree, allowedPaths, rc.scopeGuardMode, {
    // A carried path holds the prior resolution, not an automerge blob, so it
    // has no marker spans to bound edits by — file-level allowed, like a widening.
    hunkExempt: [...widenedPaths, ...(rc.carriedPaths ?? [])],
  });

  // Adequacy: duplicate detection (ERR06) — mechanical.
  // (Skipped for a REISSUE: its PR already exists — adequacy was settled at the
  // original publish; ERR06 would wrongly re-litigate the open review.)
  let dupIssue: DuplicateIssue | null = null;
  if (!isReissue) {
    dupIssue = await duplicateCaseIssue(cli, journal, journaledCases(journal), journaledCases(journal).get(caseId)!);
    if (dupIssue) issues.push(dupIssue);
  }

  // Scope + resolution-state snapshot. A scope violation is NOT an instant
  // hold: it is carried as `scopeExceeded` past the cold read — cold read
  // agrees + scope exceeded → HELD ACTIVE (resolution published, escalated); a
  // reject follows the 2-strike rejection path.
  const conflictsPresent = emptyResolution || markers.length > 0;
  const scopeExceeded = !guard.ok;
  // BLAST RADIUS, not a violation — for a GATE FIX. The file a compiler NAMES is
  // often not the file that must change (a signature, a type, a caller
  // elsewhere), so bounding a gate fix's edits to the failing files would force
  // the fix into the wrong place. Here the guard MEASURES reach instead: a fix
  // confined to the named files may land in place (`judged`); one that reaches
  // further is legitimate but goes to the owner (`held`). The wording matters —
  // this text is fed to the cold read below, and calling a correct gate fix a
  // "violation" primes a reject.
  const scopeFeedback = scopeExceeded
    ? isGateFixCase
      ? `the fix reaches beyond the failing files (${[...guard.extraPaths, ...guard.hunkViolations].join(', ')}) — legitimate for a gate fix when the failure explains it; it caps the tier at held`.slice(
          0,
          COLDREAD_FEEDBACK_CAP,
        )
      : `resolution touches beyond the conflicted files: ${[...guard.extraPaths, ...guard.hunkViolations.map((p) => `${p} (out-of-hunk)`)].join(', ')}`.slice(
          0,
          COLDREAD_FEEDBACK_CAP,
        )
    : null;
  // Effective tier: a claim of `held`, a reissue revision (never merges
  // in place — republished to the existing review PR at finish), or a checks/cap
  // demotion (5a/5b) all force HELD; otherwise the claim under its floor.
  let effectiveTier: Tier = applyFloor(
    claimed === 'held' ? 'judged' : claimed,
    rc.tierFloor === 'judged' ? 'judged' : 'clean',
  );
  if (claimed === 'held') effectiveTier = 'held';
  if (isReissue) effectiveTier = 'held';

  // ---- 1. held-duplicate: CONSOLIDATE into the topmost held twin ------------
  // The twin is frozen for the owner (no PR yet), so "resolve THAT case" is
  // impossible; blocking loops and wedges `finish` (ERR34). Journal a terminal
  // `held-duplicate` disposition (drains openCases; opens no PR of its own; this
  // case inherits the twin's held PR) and reopen descendants. FIRST — a duplicate
  // child's own worktree/markers are irrelevant (it takes the twin's resolution).
  if (dupIssue?.heldDuplicateOf) {
    if (!cli.execute) {
      result(cli, {
        dryRun: true,
        instruction: `would consolidate into held ${dupIssue.heldDuplicateOf.caseId}`,
        tier: 'held',
        issues,
      });
      return 0;
    }
    appendJournal(dir, {
      action: 'held-duplicate',
      caseId,
      branch: rc.branch,
      duplicateOf: dupIssue.heldDuplicateOf.caseId,
      detail: dupIssue.detail,
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
    console.error(`report-case: ${caseId} consolidated into held ${dupIssue.heldDuplicateOf.caseId}`);
    result(cli, {
      instruction: `consolidated into held case ${dupIssue.heldDuplicateOf.caseId} (inherits its PR); take next case`,
      tier: 'held',
      issues,
    });
    return 0;
  }

  // ---- 2. adequacy block (ERR06 duplicate) -----------------------------------
  const dup = issues.find((i) => i.id === 'ERR06_DUPLICATE_CASE');
  if (dup) {
    result(cli, {
      instruction: `consolidate into the topmost case: ${dup.detail}`,
      tier: effectiveTier,
      issues,
    });
    return 1;
  }

  // A GATE FIX the agent cannot fix IN SCOPE escalates to a HELD PR —
  // reproducible-but-unfixable-in-scope leads to a held PR;
  // there is no other way. It is a real and common category and needs
  // somewhere to go: the failure REPRODUCES (so it is not `flaky`), it is
  // genuinely pre-existing (so it is not the agent's), and yet no edit inside the
  // named files can fix it — because the driver scopes a gate fix to the files
  // the failure was REPORTED in, which is not where the fix belongs. `tsc` names
  // the call site, not the edit; a failing test names the test, not the source.
  //
  // Without this arm, `--tier held` with an unchanged worktree falls into ERR32
  // below and is told "edit the files named in the briefing, or report the
  // diagnosis to the owner" — but reporting is not a driver action, so the case
  // dead-ends and the agent burns attempts until the container is reaped. The
  // escalation IS the outcome: the owner gets a PR carrying the diagnosis,
  // which is exactly what a fix nobody can make in scope should produce.
  if (isGateFixCase && claimed === 'held') {
    await freezeHeld(cli, dir, rc, ['gate fix: agent declared cannot-fix-in-scope (--tier held)'], {
      // An unchanged tree publishes no diff — the PR is the DIAGNOSIS. A tree
      // with edits keeps them: a partial or wrong attempt the owner can read
      // beats an empty exhibit.
      resolvedTree: emptyResolution ? null : resolvedTree,
      escalation: {
        tag: ESCALATE_CHECKS,
        feedback: `cannot be fixed within the case's named files (${rc.conflictedPaths.join(', ')})`.slice(
          0,
          COLDREAD_FEEDBACK_CAP,
        ),
      },
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`gate fix held (cannot fix in scope): ${rc.branch}`);
    console.error(`report-case: held ${caseId} (gate fix, cannot fix in scope)`);
    result(cli, {
      instruction: prHandoff(
        dir,
        caseId,
        `provide PR description — you could not fix this within ${rc.conflictedPaths.join(', ')}. State WHAT fails, ` +
          `WHY it cannot be fixed in those files, and WHERE you believe the fix belongs. That diagnosis IS the deliverable`,
      ),
      tier: 'held',
      issues,
    });
    return 0;
  }

  // ---- 3. conflicts present + claim ≠ held → ERR32 (resolve first) ----------
  // A marker-laden / unchanged tree has nothing to gate; ask the agent to resolve.
  if (conflictsPresent && claimed !== 'held') {
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

  // ---- 4. claim == held + conflicts present → PRISTINE HELD DRAFT -----------
  // The agent could not resolve (held) and left the conflict pristine. Reset the
  // worktree to the pristine conflict (already pristine — no agent edits to
  // publish), freeze a HELD DRAFT (resolution null → draft pristine-conflict PR),
  // and SKIP checks + cold read. The PR description must describe the CONFLICT.
  if (claimed === 'held' && conflictsPresent) {
    // The reset is what makes "pristine" true. When it FAILS (a container-uid
    // -owned tree the host cannot remove) the agent's discarded edits are still
    // on disk, so freezing a draft here and announcing a pristine worktree would
    // be a plain false statement — and the draft PR would be built from a tree
    // nobody reset. Stop instead; the case stays case-ready and can be retried
    // from a context that can write the worktree.
    // NO INSTALL: this reset ends the case. It freezes a held draft, runs no
    // checks and hands the tree to nobody, so an environment it will never use
    // must not be able to turn a legal freeze into a case that cannot conclude.
    if (!(await createCaseWorktree(cli, dir, caseFile, await revParse(cli.repo, rc.branch), undefined, undefined, { install: false })).ok) {
      const detail =
        `could not reset the worktree at ${wtPath} to the pristine conflict (see the journaled warning) — ` +
        `the tree still holds edits, so no pristine-conflict PR can be frozen from it; clear the worktree ` +
        `(in-container, where the pass files are writable) and re-run report-case`;
      console.error(`report-case [ERR44_WORKTREE_RESET_FAILED]: ${detail}`);
      result(cli, { instruction: detail, tier: claimed, issues: [...issues, { id: 'ERR44_WORKTREE_RESET_FAILED', detail }] });
      return 1;
    }
    await freezeHeld(cli, dir, rc, ['agent declared cannot-resolve (--tier held) — pristine conflict'], {
      resolvedTree: null,
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`held (pristine): ${rc.branch}`);
    console.error(`report-case: held ${caseId} (pristine conflict — draft)`);
    result(cli, {
      instruction:
        prHandoff(dir, caseId, 'provide PR description — base it on the PRISTINE conflict state (the worktree is now pristine); do NOT describe a resolution'),
      tier: 'held',
      issues,
    });
    return 0;
  }

  // ==== 5. RESOLVED (no conflicts present) ==================================
  // ---- 5a. CHECKS GATE — typecheck THEN tests in the worktree ---------------
  // A checks file edited into invalid JSON mid-pass would make this gate skip
  // itself with no trace and pass an untypechecked, untested resolution straight
  // to the cold read. Journal it and refuse — the case stays case-ready.
  const badChecks = malformedChecksIssue(checksFile);
  if (badChecks) {
    appendJournal(dir, { action: 'warning', caseId, id: badChecks.id, message: badChecks.detail });
    console.error(`report-case [${badChecks.id}]: ${badChecks.detail}`);
    result(cli, { instruction: badChecks.detail, tier: claimed, issues: [...issues, badChecks] });
    return 1;
  }
  const checks = loadChecksConfig(checksFile);
  if (checks) {
    // THE ENVIRONMENT THE CHECKS RUN IN COMES FROM THE RESOLVED MANIFESTS.
    //
    // The prep install ran on the clean prefix, where a conflicted
    // `package.json` was still the base commit's. By now the agent has resolved
    // it, so a dependency the resolution adds, drops or moves exists only here
    // — and a gate run against the prep environment is a statement about a tree
    // that no longer exists. This is the install that decides the verdict.
    //
    // It costs one install per `report-case` INVOCATION, and a case can have
    // many. That is the price of the gate measuring the tree it is judging.
    //
    // A failure here is not automatically the machine: the manifests it reads
    // are the AGENT'S now. `classifyInstallFailure` says whose it is.
    if (checks.typecheck.length + checks.test.length > 0) {
      const gateInstall = await installDeps(cli, wtPath, runInstall);
      if (!gateInstall.ok) {
        const f = gateInstall.failure;
        const what = `\`${f.command}\` (in ${f.cwd}) failed with: ${f.output.slice(-600)}`;
        // WHOSE FAULT IT IS DECIDES WHAT HAPPENS NEXT, and the two answers are
        // opposites: one is work the agent can do, the other is a machine no
        // code change reaches.
        if (classifyInstallFailure(f.output) === 'resolution') {
          const detail =
            `the dependencies of YOUR RESOLUTION do not install: ${what} The checks did not run, so this is not ` +
            `a failing check and nothing was counted against the case.`;
          appendJournal(dir, {
            action: 'install-refused',
            id: ERR_MANIFEST_UNINSTALLABLE,
            caseId,
            branch: rc.branch,
            install: f,
            detail,
          });
          console.error(`report-case [${ERR_MANIFEST_UNINSTALLABLE}]: ${detail}`);
          result(cli, {
            tier: claimed,
            issues: [...issues, { id: ERR_MANIFEST_UNINSTALLABLE, detail }],
            instruction:
              `FIX AND RETRY: the manifests in your worktree do not install. ${what} Make \`package.json\` and its ` +
              `lockfile agree — usually by putting back a dependency edit the resolution dropped, or by not making ` +
              `one at all. If the resolution genuinely CHANGES the dependencies, say so with \`--tier held\` and ` +
              `name the change: regenerating a lockfile is not yours to decide. Then re-run report-case.`,
          });
          return 1;
        }
        // THE MACHINE. Terminal for the pass: nothing else in it can be checked
        // either. The case is DISPOSED so it does not sit in `openCases` with
        // `finish` refusing on ERR34 and no legal move left, and the branch +
        // its descendants are reopened against the block the disposition puts
        // on it — exactly what a HELD freeze does — so nothing below builds on
        // a merge that never happened.
        const detail =
          `dependencies would not install into the case worktree at ${wtPath}, and the failure names the machine ` +
          `rather than the manifests: ${what} The checks did not run. Nothing was counted against this case, and ` +
          `no code change can fix this.`;
        appendJournal(dir, {
          action: 'env-blocked',
          id: ERR_ENVIRONMENT_UNUSABLE,
          caseId,
          branch: rc.branch,
          headSha: rc.head.sha,
          gateFix: isGateFixCase,
          phase: 'checks-gate',
          install: f,
          detail,
        });
        reopen(dir, reopenTargets);
        writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
        console.error(`report-case [${ERR_ENVIRONMENT_UNUSABLE}]: ${detail}`);
        result(cli, {
          ok: false,
          status: 'stopped',
          stoppedAt: 'checks-install',
          tier: claimed,
          issues: [...issues, { id: ERR_ENVIRONMENT_UNUSABLE, detail }],
          instruction:
            `REPORT to the owner: ${detail} This case is closed as unjudgeable and ${rc.branch} is blocked for the ` +
            `rest of the pass. Do NOT edit code and do NOT re-run report-case. Run \`finish\`, which will report ` +
            `it under needsOwner, and stop.`,
        });
        return 1;
      }
    }
    for (const kind of ['typecheck', 'test'] as const) {
      const list = checks[kind];
      if (list.length === 0) continue;
      // `--not-my-bug` BUYS A COMPARISON, and its price is the whole population.
      // The adjudication below measures this run's failing files against probes
      // that run the failed commands WHOLE; a narrowed run on this side compares
      // a file list against a full suite, and the difference between the two
      // populations — not the trees — decides the verdict. A deadline-bound test
      // that only fails under whole-suite load is exactly the failure the flag
      // exists for, and it would be called flaky or pre-existing on a subset.
      const adjudicable = cli.notMyBug && !isGateFixCase && !isReissue;
      const narrowTo = adjudicable ? [] : priorFailingFiles(journal, caseId, kind);
      const gated = await runGatedChecks(runChecks, list, wtPath, narrowTo);
      const r = gated.result;
      if (r.ok) {
        // CONFIRM A GREEN THAT FOLLOWS A RED. One run cannot tell "fixed" from
        // "got lucky", and on a non-deterministic check the difference matters:
        // the agent changes something plausible, the gate passes by coincidence,
        // the case closes as resolved, and the defect stays in the tree with
        // nobody looking for it any more — worse than never having tried.
        //
        // Only where luck is plausible. A first-attempt pass has no prior red to
        // explain away, so it is believed as-is; re-running every green would
        // double the gate's cost on every case to guard a question nobody asked.
        // This costs one extra run, on cases that were already red once.
        const failedBefore = journal.some((e) => e.action === 'checks-fail' && e.caseId === caseId && e.kind === kind);
        if (!failedBefore) continue;
        const confirm = await runChecks(list, wtPath);
        if (confirm.ok) continue;
        const flakyFile = join(caseDir, `${kind}-nondeterministic.txt`);
        writeFileSync(flakyFile, confirm.output);
        const detail =
          `the ${kind} checks PASSED and then FAILED on an immediate re-run of the same tree ` +
          `(${confirm.failedNames.join(', ')}). One green run cannot confirm a fix for a check that does not ` +
          `reproduce — the pass would have closed this case on a coincidence. Output: ${flakyFile}`;
        appendJournal(dir, {
          action: 'checks-nondeterministic',
          id: 'WARN21_CHECKS_FLAKY',
          caseId,
          kind,
          failed: confirm.failedNames,
          detail,
        });
        console.error(`report-case [WARN21_CHECKS_FLAKY]: ${detail}`);
        result(cli, {
          instruction:
            `the ${kind} is NON-DETERMINISTIC on this tree — it passed once and failed once with no change ` +
            `between. Do not re-run hoping for green: claim \`--tier held\` and say which check is unstable, ` +
            `so the owner sees it. Output: ${flakyFile}`,
          tier: claimed,
          issues: [...issues, { id: 'WARN21_CHECKS_FLAKY', detail }],
        });
        return 1;
      }
      const outFile = join(caseDir, `${kind}-output.txt`);
      const fullFile = join(caseDir, `${kind}-output.full.txt`);
      writeFileSync(fullFile, r.output);
      writeFileSync(outFile, boundedChecksOutput(r, fullFile));
      // ENVIRONMENT FAULT — checked HERE, on the ORDINARY path, before anything
      // is counted against the agent. Checking it only inside
      // `adjudicateNotMyBug` (which needs the flag AND a second failure) would
      // let an agent that never raises the flag march a broken toolchain all
      // the way to CHECKS_FAIL_LIMIT and freeze a HELD PR for it.
      const envFaultGate = classifyEnvironmentFault(r.output);
      if (envFaultGate.isEnvironment) {
        appendJournal(dir, {
          action: 'environment-fault',
          caseId,
          branch: rc.branch,
          kind,
          signature: envFaultGate.signature,
          detail: envFaultGate.detail,
        });
        progress(`ENVIRONMENT FAULT (${envFaultGate.signature}) — not a code defect; nothing counted against the case`);
        console.error(`report-case [WARN14_ENVIRONMENT_FAULT]: ${envFaultGate.detail}`);
        result(cli, {
          ok: false,
          status: 'stopped',
          stoppedAt: 'checks',
          issues: [{ id: 'WARN14_ENVIRONMENT_FAULT', detail: envFaultGate.detail }],
          instruction:
            `REPORT to the owner: ${envFaultGate.detail} Your resolution is untouched and this attempt was NOT ` +
            `counted against the case. Do NOT try to fix this in code and do NOT re-run until the owner says so.`,
        });
        return 1;
      }
      // WHAT failed, at both grains, RE-ROOTED at the repo root the same way
      // blame reads it (`rootChecksOutput`). The bun suite prints `src/x.test.ts`
      // from its own cwd, while the narrowing assigns files to commands BY cwd
      // prefix — an un-rooted path would be handed to the ROOT command and
      // re-run there as a file that does not exist.
      //
      // FILES are what the next attempt narrows its re-run to; FINGERPRINTS are
      // what make "the same failure again" a comparison instead of an
      // impression. Both are journaled because both are read back from the
      // journal, and a derivation kept only in this frame would cost a whole
      // checks run to recover.
      const rootedOutput = rootChecksOutput(r.output, gated.used);
      appendJournal(dir, {
        action: 'checks-fail',
        caseId,
        resolvedTree,
        kind,
        failed: r.failedNames,
        files: parseFailingFiles(rootedOutput),
        fingerprints: fingerprintKeys(parseFailureFingerprints(rootedOutput)),
        ...(gated.narrow ? { narrowedTo: gated.narrow.files, narrowRed: gated.narrow.red } : {}),
      });
      const afterFail = readJournal(dir);
      const n = checksFailCount(afterFail, caseId);
      // Decided on the journal, which now holds this attempt, and journaled the
      // moment it is found — whichever way the case then goes. A reader must be
      // able to see that the driver knew, not reconstruct it from three rows of
      // fingerprints.
      const deadEnd = deadEndEvidence(afterFail, caseId);
      if (deadEnd) {
        appendJournal(dir, {
          action: 'checks-dead-end',
          caseId,
          kind,
          trees: deadEnd.trees,
          fingerprints: deadEnd.fingerprints,
        });
        progress(`dead end: ${DEAD_END_ATTEMPTS} distinct trees, identical failure (${deadEnd.fingerprints.length} fingerprint(s))`);
      }

      // ---- `--not-my-bug`: adjudicate the claim, then route the failure -----
      // A GATE FIX case is exempt: it has no clean prefix to compare against
      // (there was no merge), and the failure it is fixing is by construction
      // not the agent's — that is the whole premise of the case.
      let notMyBug: NotMyBugOutcome = { handled: false };
      // A REISSUE is exempt for the same reason a gate fix is: it is a revision of
      // an ALREADY PUBLISHED resolution against an open PR, and the abort path
      // (reopen + phase `open`) would supersede the driver-manufactured reissue
      // case, discard the revision and strand the review.
      if (cli.notMyBug && !isGateFixCase && !isReissue) {
        if (n < 2) {
          // The agent may not run tests (CHECKS_HANDOFF_LINE), so before this
          // gate has reported a failure it cannot have an informed opinion about
          // one. The claim is not refused as false — it is premature, and saying
          // which it is keeps the agent from concluding the flag does not work.
          appendJournal(dir, { action: 'not-my-bug-premature', caseId, branch: rc.branch, kind });
          progress('not-my-bug: ignored on the first failure — nothing had been reported to you yet');
        } else {
          const failedCmds = list.filter((c) => r.failedNames.includes(c.cmd));
          notMyBug = await adjudicateNotMyBug({
            cli,
            ctx,
            dir,
            caseId,
            caseDir,
            rc,
            wtPath,
            resolvedTree,
            kind,
            failedCommands: failedCmds,
            failingOutput: r.output,
            runChecks,
            runInstall,
          });
          if (notMyBug.handled) return notMyBug.code ?? 1;
        }
      }

      // An EXPLICIT `--tier held` claim is the agent saying it cannot make this
      // green — which is exactly what the counter below infers after ten tries.
      // Honour it now, keeping the fix, instead of demanding nine more failures.
      //
      // Without this the two escape routes cancel out: the pristine-held branch
      // above needs `conflictsPresent` (markers, or no resolution at all), so an
      // agent that HAS resolved the conflict falls through to this gate, and the
      // gate answers ERR36/ERR40 — "fix the pending files" — which is impossible
      // when the failing file is not one of them (e.g. an upstream test far from
      // the conflicted paths). The agent claims held, is refused, and is
      // deadlocked. Doctrine's own ERR36 row tells it
      // to claim held here, so refusing that is the driver contradicting itself.
      //
      // HELD work is not merged — it goes out as a PR for the owner, whose text
      // must say the checks still fail (the instruction below requires it). A
      // failing fix the owner can read beats a case nobody can close.
      // NOT `&& n < CHECKS_FAIL_LIMIT`. That composition would make an explicit
      // claim stop counting at exactly the try the agent worked hardest for:
      // below the limit the claim is honoured and the resolution kept —
      // throwing it away would
      // lose the useful part and tell the owner to resolve a conflict that is
      // already resolved — while at the limit the identical claim would fall
      // through to the limit path, reset the worktree to pristine and null
      // `resolvedTree`.
      // The limit path keeps its real purpose: an agent that kept failing and
      // never conceded, where an empty exhibit is the honest thing to ship.
      const heldByClaim = claimed === 'held';
      if (n >= CHECKS_FAIL_LIMIT || heldByClaim) {
        // Backstop: stop asking the agent to fix and escalate to the owner.
        // A GATE-FIX case has NO pristine conflict to reset to — the
        // "pristine" reset would rebuild a merge that never happened and the
        // briefing would tell the owner to resolve a conflict that does not
        // exist. Keep the attempted fix instead and ship it as the held
        // ACTIVE PR: a failing fix the owner can read beats an empty exhibit.
        if (isGateFixCase) {
          await freezeHeld(
            cli,
            dir,
            rc,
            [
              heldByClaim
                ? `agent claimed --tier held with ${kind} failing (${r.failedNames.join(', ')}) -> HELD (fix kept for owner review)`
                : `checks (${kind}) failing ${n}x on a gate fix -> HELD (escalated, fix kept)`,
            ],
            {
              resolvedTree,
              escalation: {
                tag: ESCALATE_CHECKS,
                feedback: `${kind} failing: ${r.failedNames.join(', ')}`.slice(0, COLDREAD_FEEDBACK_CAP),
              },
            },
          );
          reopen(dir, reopenTargets);
          writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
          progress(`checks failing ${n}x -> held (gate fix kept): ${rc.branch}`);
          console.error(`report-case: held ${caseId} (gate fix, checks ${kind} failing ${n}x, escalated)`);
          result(cli, {
            instruction: prHandoff(dir, caseId, `provide PR description — the ${kind} still fails (${r.failedNames.join(', ')}); say so plainly`),
            tier: 'held',
            issues,
          });
          return 0;
        }
        // A conflict case held BY CLAIM keeps its resolution: the agent resolved
        // the conflict and is escalating a failure it does not own, so throwing
        // that work away and shipping an empty exhibit would lose the useful part
        // and tell the owner to resolve a conflict that is already resolved.
        if (heldByClaim) {
          await freezeHeld(
            cli,
            dir,
            rc,
            [`agent claimed --tier held with ${kind} failing (${r.failedNames.join(', ')}) -> HELD (resolution kept for owner review)`],
            {
              resolvedTree,
              escalation: {
                tag: ESCALATE_CHECKS,
                feedback: `${kind} failing: ${r.failedNames.join(', ')}`.slice(0, COLDREAD_FEEDBACK_CAP),
              },
            },
          );
          reopen(dir, reopenTargets);
          writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
          progress(`held by claim (${kind} failing): ${rc.branch}`);
          console.error(`report-case: held ${caseId} by claim (${kind} failing: ${r.failedNames.join(', ')})`);
          result(cli, {
            instruction: prHandoff(
              dir,
              caseId,
              `provide PR description — the ${kind} still fails (${r.failedNames.join(', ')}); say so plainly and name what you could not fix`,
            ),
            tier: 'held',
            issues,
          });
          return 0;
        }
        // Conflict case at the LIMIT: reset to pristine (the failing resolution
        // is NOT published) and freeze a HELD DRAFT, escalated. A failed reset
        // must not be announced as pristine — same rule as branch 4.
        // No install — the same rule as branch 4: this reset ends the case.
        if (!(await createCaseWorktree(cli, dir, caseFile, await revParse(cli.repo, rc.branch), undefined, undefined, { install: false })).ok) {
          const detail =
            `checks (${kind}) failed ${n}x and the worktree at ${wtPath} could not be reset to the pristine ` +
            `conflict (see the journaled warning) — nothing was frozen; clear the worktree (in-container) and re-run report-case`;
          console.error(`report-case [ERR44_WORKTREE_RESET_FAILED]: ${detail}`);
          result(cli, { instruction: detail, tier: claimed, issues: [...issues, { id: 'ERR44_WORKTREE_RESET_FAILED', detail }] });
          return 1;
        }
        await freezeHeld(cli, dir, rc, [`checks (${kind}) failing ${n}x -> HELD (escalated, pristine)`], {
          resolvedTree: null,
          escalation: { tag: ESCALATE_CHECKS, feedback: `${kind} failing: ${r.failedNames.join(', ')}`.slice(0, COLDREAD_FEEDBACK_CAP) },
        });
        reopen(dir, reopenTargets);
        writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
        progress(`checks failing ${n}x -> held (pristine): ${rc.branch}`);
        console.error(`report-case: held ${caseId} (checks ${kind} failing ${n}x, escalated, pristine)`);
        result(cli, {
          instruction:
            prHandoff(dir, caseId, 'provide PR description — base it on the PRISTINE conflict state (the worktree is now pristine); do NOT describe a resolution'),
          tier: 'held',
          issues,
        });
        return 0;
      }
      const id = kind === 'typecheck' ? 'ERR36_TYPECHECK_FAILED' : 'ERR40_TESTS_FAILED';
      // The dead end rides on the ORDINARY failure payload and nowhere else. It
      // is one more thing the agent knows on its way back into the fix loop —
      // the id, the tier, the attempt count and the limit are all exactly what
      // they would be without it, because what the evidence supports is
      // "look somewhere else", and the agent is the one that can.
      const stuck = deadEnd ? deadEndNote(deadEnd) : '';
      const detail = `${kind} failed: ${r.failedNames.join(', ')} (see ${outFile})${notMyBug.note ? ` — ${notMyBug.note}` : ''}${stuck}`;
      console.error(`report-case [${id}]: ${detail}`);
      // The escape hatch is ADVERTISED HERE, in the same message that reports the
      // failure. This is the only moment the agent learns a check failed at all,
      // so an escape it has to remember from a doctrine row is one it will not
      // find. A refused claim names the agent's own failures instead,
      // which beats "read the output and work out which half is yours".
      const yours = notMyBug.yours?.length
        ? ` These failures are YOURS — they pass without your resolution: ${notMyBug.yours.join(', ')}.`
        : '';
      const hatch = notMyBug.handled || notMyBug.yours?.length
        ? ''
        : ` If you believe this failure is not caused by your resolution, re-run with \`--not-my-bug\` (alongside your --tier) and the driver will PROVE it against the pre-conflict tree.`;
      // NO report-attempt is recorded on a checks failure (5b counts only trees
      // that reach the cold read). Phase stays case-ready.
      result(cli, {
        instruction:
          `read ${outFile} and the named files, fix the pending files, re-run report-case.${yours}${hatch}` +
          // PRICE THE EXIT, and say which attempt this is.
          //
          // A message that only prescribes the fix loop and never mentions
          // `--tier held` leaves an agent stuck on an unobservable failure to
          // invent an escape rule of its own. The attempt count is the
          // driver's to know, and naming the alternative costs one clause.
          //
          // A gate fix also has no `--not-my-bug` left to offer: the driver
          // already proved the failure pre-existing, which is WHY the case
          // exists, so that clause is dead weight there.
          (isGateFixCase
            ? ` This is attempt ${n} of ${CHECKS_FAIL_LIMIT}. If you cannot name the fix from the code, do not ` +
              `spend another cycle guessing — \`report-case --tier held\` with what you found is a valid ` +
              `outcome and the diagnosis is the deliverable.`
            : '') +
          stuck,
        tier: claimed,
        ...(notMyBug.note ? { notMyBug: { verdict: 'refused', detail: notMyBug.note, files: notMyBug.yours ?? [] } } : {}),
        issues: [...issues, { id, detail }],
      });
      return 1;
    }
    appendJournal(dir, { action: 'checks-pass', caseId, resolvedTree });
  }

  // ---- 5b. report-attempt (post-checks) + RESOLVE_COLDREAD_CAP --------------
  const priorTrees = new Set(
    journal
      .filter((e) => e.action === 'report-attempt' && e.caseId === caseId && typeof e.resolvedTree === 'string')
      .map((e) => e.resolvedTree as string),
  );
  if (!priorTrees.has(resolvedTree)) {
    appendJournal(dir, { action: 'report-attempt', caseId, branch: rc.branch, tier: claimed, resolvedTree });
  }
  if (new Set([...priorTrees, resolvedTree]).size > RESOLVE_COLDREAD_CAP) {
    // Backstop: the resolution never converged across RESOLVE_COLDREAD_CAP
    // distinct cold-read-reaching trees → HELD ACTIVE (owner review).
    await freezeHeld(cli, dir, rc, [`resolution did not converge in ${RESOLVE_COLDREAD_CAP} distinct trees -> held`], {
      resolvedTree,
      escalation: { tag: ESCALATE_CAP, feedback: scopeFeedback },
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`cap exceeded -> held: ${rc.branch}`);
    console.error(`report-case: held ${caseId} (resolution did not converge)`);
    result(cli, { instruction: prHandoff(dir, caseId, 'provide PR description'), prTemplate: prTemplatePath(dir, caseId), tier: 'held', issues });
    return 0;
  }

  // ---- 5c. COLD READ over the resolution diff (mechanical + judged + held) --
  const conflictDiff = await conflictHunks(cli.repo, rc.automergeTree, rc.conflictedPaths);
  const resolutionDiff = (await git(cli.repo, ['diff', rc.automergeTree, resolvedTree], { allowCodes: [1] })).stdout;
  const prompt = machineColdReadPrompt({
    id: caseId,
    branch: rc.branch,
    parent: rc.parent,
    height: rc.head.height,
    conflictedPaths: rc.conflictedPaths,
    contextLines: await caseContextLines(cli, rc),
    widenedPaths: widenedPaths.length > 0 ? { files: widenedPaths, reason: widenedReason } : null,
    conflictDiff: conflictDiff.slice(0, 60000),
    resolutionDiff: resolutionDiff.slice(0, 60000),
    // A gate fix is judged on the FAILING CHECK, not on conflict hunks it has
    // none of — its conflictDiff is empty by construction.
    gateFix: isGateFixCase ? { failedOutput: gateFixFailedOutput(dir, caseId) } : null,
  });
  writeFileSync(join(caseDir, 'coldread-request.md'), prompt);
  progress(`cold-read: ${rc.branch}`);
  const verdict = await invoke(prompt);
  writeFileSync(join(caseDir, 'coldread-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  // Infra failure of the cold read (spawn/exit/unparseable/auth) is NOT a
  // content reject — HARD BLOCKING HALT (ERR35), do NOT freeze the case. The
  // machine state stays `case-ready` so the agent re-runs report-case once the
  // tooling is fixed; only a cold read that RAN and rejected → HELD (below).
  if (verdict.verdict === 'error') {
    const detail = `cold-read tooling unavailable: ${verdict.reason ?? 'unknown'} — report to owner and stop; NOT a content decision`;
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
  // prefix. The machine state stays case-ready on the first strike.
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
      result(cli, { instruction: prHandoff(dir, caseId, 'provide PR description'), prTemplate: prTemplatePath(dir, caseId), tier: 'held', issues });
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
    // A gate fix reaching past the failing files is EXPECTED (the compiler names
    // the symptom, not the cause), so it is journaled as REACH and demoted
    // without an escalation tag — the demotion IS the policy, not a fault. A
    // merge resolution doing the same is still a violation.
    const note = isGateFixCase
      ? `gate fix reaches beyond the failing files [${guard.mode}] -> HELD (owner reviews; a fix confined to them could have landed judged)`
      : `cold read confirmed but the resolution exceeds the conflict scope [${guard.mode}] -> HELD (resolution published for owner review)`;
    appendJournal(dir, {
      action: isGateFixCase ? 'gate-fix-reach' : 'scope-violation',
      branch: rc.branch,
      caseId,
      mode: guard.mode,
      extraPaths: guard.extraPaths,
      hunkViolations: guard.hunkViolations,
    });
    await freezeHeld(cli, dir, rc, [note], {
      resolvedTree,
      ...(isGateFixCase
        ? {}
        : {
            escalation: {
              tag: ESCALATE_SCOPE,
              feedback: [feedback, scopeFeedback].filter(Boolean).join(' — ').slice(0, COLDREAD_FEEDBACK_CAP),
            },
          }),
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`demoted: ${rc.branch} -> held (scope exceeded; resolution kept for owner review)`);
    console.error(`report-case: held ${caseId} (scope exceeded — cold read agreed; resolution kept)`);
    result(cli, {
      instruction: prHandoff(dir, caseId, 'provide PR description'),
      prTemplate: prTemplatePath(dir, caseId),
      tier: 'held',
      scopeGuard: guard,
      issues,
    });
    return 0;
  }
  // Confirm + in-scope → dispatch by effective tier.
  //  - JUDGED: defer to report-pr (prepare materials; the merge lands there).
  if (effectiveTier === 'judged') {
    await prepareCaseMaterials(cli, dir, rc, 'judged');
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'judged' } });
    console.error(`report-case: ${caseId} judged — provide PR description`);
    result(cli, { instruction: prHandoff(dir, caseId, 'provide PR description'), prTemplate: prTemplatePath(dir, caseId), tier: 'judged', issues });
    return 0;
  }
  //  - HELD (explicit held-claim on a marker-clean resolution, or a reissue):
  //    freeze HELD ACTIVE (resolution) — the owner reviews & merges at finish.
  if (effectiveTier === 'held') {
    await freezeHeld(cli, dir, rc, ['agent declared cannot-resolve (--tier held) — resolution kept for owner review'], {
      resolvedTree,
    });
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    progress(`held (resolution kept): ${rc.branch}`);
    console.error(`report-case: held ${caseId} (resolution kept for owner review)`);
    result(cli, { instruction: prHandoff(dir, caseId, 'provide PR description'), prTemplate: prTemplatePath(dir, caseId), tier: 'held', issues });
    return 0;
  }
  //  - MECHANICAL: merge the resolved tree in place.
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
// `report-pr` (judged and held only) (DRIVER.md §6.5).
// --------------------------------------------------------------------------

/**
 * `report-pr` — PR AUTHORING ONLY. The single quality gate (checks + the
 * cold read) already ran at `report-case`; this stage reads the agent's PR text
 * and RECORDS INTENT — no cold read, no typecheck, no tests, no network.
 *
 * PR content: either a `pr/body.md` whose FIRST line is the H1 title (`# <title>`,
 * canonical), with the rest the body; or a `pr/title.txt` + `pr/body.md`
 * pair (both accepted; the H1 wins when both are present). The
 * resolved title/body are normalized back to `pr/title.txt` + `pr/body.md` so
 * the finish-time publish reads them unchanged. Missing title or body → ERR08;
 * deterministic text checks add WARN01/WARN02 (advisory, non-blocking).
 *
 * By tier (PUBLISHING NOTHING — every PR is created at `finish`, after verify):
 *  - held → RECORD PR INTENT (active for a marker-clean resolution, draft for the
 *    pristine conflict — from the recorded `held` disposition);
 *  - judged → merge the resolution in place + RECORD PR INTENT (flips to merged
 *    when its history PR is pushed at finish).
 */
export async function cmdSweepReportPr(
  cli: Cli,
  _invoke: ColdReadInvoker = defaultColdReadInvoker,
): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  const st = readMachineState(dir);
  applyPassConfig(cli, st);
  if (!st || st.phase !== 'awaiting-pr' || !st.currentCase) {
    console.error('report-pr: no case awaiting a PR — run `report-case --tier judged|held` first (ERR01)');
    result(cli, {
      instruction: 'no case awaiting a PR — run report-case first',
      issues: [{ id: 'ERR01_CASE_NOT_OPEN', detail: 'no awaiting-pr case in the machine state' }],
    });
    return 1;
  }
  const { caseId, branch } = st.currentCase;
  const tier = st.currentCase.tier;
  if (tier !== 'judged' && tier !== 'held') {
    console.error('report-pr: current case is not judged/held (mechanical has no PR)');
    return 2;
  }
  const caseDir = join(dir, caseId);
  const journal = readJournal(dir);

  // PR content: `pr/body.md` (H1 title on the first line, canonical) or the
  // `pr/title.txt` + `pr/body.md` pair. Resolve title + body, then
  // normalize both files so the finish-time publish reads them verbatim.
  const titlePath = join(caseDir, 'pr', 'title.txt');
  const bodyPath = join(caseDir, 'pr', 'body.md');
  const titleTxt = existsSync(titlePath) ? readFileSync(titlePath, 'utf8').trim() : '';
  const bodyRaw = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '';
  let title = titleTxt;
  let body = bodyRaw.trim();
  if (!title) {
    const lines = bodyRaw.split('\n');
    const firstIdx = lines.findIndex((l) => l.trim() !== '');
    const m = firstIdx >= 0 ? /^#\s+(.+)$/.exec(lines[firstIdx].trim()) : null;
    if (m) {
      title = m[1].trim();
      body = lines.slice(firstIdx + 1).join('\n').trim();
    }
  }
  if (!title || !body) {
    const detail =
      `write ${bodyPath} with the H1 title on the first line (\`# <title>\`) and the body below, ` +
      `FROM ${prTemplatePath(dir, caseId)} — the driver never generates PR prose`;
    result(cli, {
      instruction: prHandoff(dir, caseId, 'provide PR description'),
      prTemplate: prTemplatePath(dir, caseId),
      issues: [{ id: 'ERR08_TEXT_MISSING', detail }],
    });
    return 1;
  }
  // Normalize both files so the finish publish (which reads title.txt + body.md)
  // sees the resolved values regardless of which input form the agent used.
  mkdirSync(join(caseDir, 'pr'), { recursive: true });
  writeFileSync(titlePath, title + '\n');
  writeFileSync(bodyPath, body + '\n');

  const caseFile = readCaseFile(join(caseDir, 'case.json'));

  // Deterministic PR-text checks (WARN01/WARN02) — advisory, never blocking.
  const warnings = advisoryTextIssues(title, body, caseFile.conflictedPaths);

  if (!cli.execute) {
    result(cli, { dryRun: true, instruction: 'dry-run', tier, issues: warnings });
    return 0;
  }

  // held → RECORD PR INTENT (publish at finish). The recorded `held` disposition
  // already carries the resolution + escalation the unified publish re-derives
  // from; this row records the remaining intent fields (draft-vs-active, target,
  // conflict head). Reissue cases are held too — the publish targets the existing
  // review PR from the case row.
  if (tier === 'held') {
    const heldDisp = lastDisposition(journal, caseId);
    const heldResolution = heldDisp?.resolution as { tree: string; markerClean: boolean } | null | undefined;
    // A case that had to be WARNED for looping ships as a DRAFT even when its
    // resolution is marker-clean. An active PR says "I resolved this, merge it";
    // a case the agent circled without concluding has not earned that claim, and
    // the owner should see the diagnosis before anything lands.
    const looped =
      journal.filter((e) => e.action === 'case-served' && e.caseId === caseId).length >= CASE_SERVE_WARN;
    const draft = heldResolution?.markerClean !== true || looped;
    const jc = journaledCases(journal).get(caseId) ?? null;
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
    result(cli, { instruction: 'take next case', tier: 'held', prIntent: true, issues: warnings });
    return 0;
  }

  // judged → merge the resolution in place + record PR intent. The cold read
  // already confirmed it at report-case; re-verify + re-snapshot (fail-closed to
  // HELD only if it no longer resolves), then merge (the history PR flips to
  // merged when pushed at finish).
  // A JUDGED GATE FIX is new code on the branch, not a propagation
  // merge — there is no parent to merge and no conflict to re-verify. Commit the
  // fixed tree as a SINGLE-parent commit, then REOPEN every descendant so the
  // fix is pulled through the DAG; the next `finish` sees cases outstanding
  // (ERR34) and sends the agent back to `next-case`, and the pass can still
  // complete. This is what makes a trunk-rooted fix salvage the pass instead of
  // forcing a restart.
  const gateFixRow = journal.find((e) => e.action === 'gate-fix' && e.caseId === caseId);
  if (gateFixRow) {
    const fixedTree = await snapshotWorktreeTree(cli.repo, caseWorktreePath(dir, caseId));
    const registry = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile, routingFile: cli.routingFile });
    const scopeResult = await resolveScope(cli.repo, registry.features, registry.scope, { includeRemote: true });
    const scope = new Set(scopeResult.ordered.map((e) => e.branch));
    const descendants = transitiveDescendants(scopeResult.edges, branch);
    const preReffed0 = preReffedSet(journal);
    await recordPreRef(cli, dir, preReffed0, branch);
    const fixMsg = `${title}\n\n${body}\n\nGate fix for ${(gateFixRow.files as string[]).join(', ')} (case ${caseId}).`;
    const fixCommit = await journaledFixCommit(cli.repo, branch, fixedTree, fixMsg, scope);
    appendJournal(dir, { action: 'resolved', branch, caseId, tier: 'judged', gateFix: true, mergeCommit: fixCommit });
    // NO pr-intent. The JUDGED history PR exists to be auto-flipped to merged by
    // the target push that lands the SAME merge commit — machinery specific to a
    // propagation merge. A gate fix is a single-parent commit with no conflict
    // head, so that publish path does not apply (it halts at `judged-prs`). The
    // fix's record is the commit itself: the agent's PR title/body become its
    // message, and it reaches origin with the ordinary target push.
    await removeCaseWorktree(cli, dir, caseId);
    reopen(dir, [branch, ...descendants]);
    writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
    progress(`gate-fix (judged): ${branch} — ${fixCommit.slice(0, 12)}; ${descendants.length} descendant(s) reopened`);
    console.error(`report-pr: gate-fix ${caseId} committed ${fixCommit.slice(0, 12)} on ${branch}`);
    result(cli, {
      instruction: 'take next case — the gate fix must now be pulled through the reopened branches',
      tier: 'judged',
      gateFix: true,
      mergeCommit: fixCommit,
      reopened: descendants,
      // NO `prIntent`. The arm above deliberately journals no pr-intent row and
      // finish excludes gate fixes from the judged PRs, so claiming one would
      // make the agent promise the owner a PR that is never created. The commit
      // IS the record here.
      prIntent: false,
      issues: warnings,
    });
    return 0;
  }

  const rv = await reverifyCase(cli, ctx, dir, caseFile, journal);
  if (!rv.ok) {
    result(cli, {
      instruction: `case-stale: ${rv.errors[0]}`,
      issues: rv.errors.map((detail) => ({ id: 'ERR02_CASE_STALE', detail })),
    });
    return 1;
  }
  const rc = rv.rc!;
  const resolvedTree = await snapshotWorktreeTree(cli.repo, caseWorktreePath(dir, caseId));
  const markers = await unresolvedMarkers(cli.repo, resolvedTree, rc.conflictedPaths);
  if (markers.length > 0) {
    const note = `unresolved conflict markers -> held`;
    await freezeHeld(cli, dir, rc, [note], { resolvedTree });
    reopen(dir, [rc.branch, ...rc.descendants]);
    writeMachineState(dir, { ...st, currentCase: { caseId, branch, tier: 'held' } });
    result(cli, { instruction: `held: ${note} — re-run report-pr to record the frozen exhibit`, tier: 'held' });
    return 1;
  }
  const preReffed = preReffedSet(journal);
  await recordPreRef(cli, dir, preReffed, rc.branch);
  const msg = `Merge ${rc.parent} into ${rc.branch} (propagation, judged resolution of ${caseId})`;
  const mergeCommit = await journaledResolvedMerge(cli.repo, rc.branch, rc.head.sha, resolvedTree, msg, rc.scope);
  appendJournal(dir, { action: 'resolved', branch: rc.branch, caseId, tier: 'judged', mergeCommit });
  appendJournal(dir, { action: 'pr-intent', caseId, branch: rc.branch, mode: 'judged', mergeCommit });
  await removeCaseWorktree(cli, dir, caseId);
  reopen(dir, [rc.branch, ...rc.descendants]);
  writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
  progress(`judged: ${rc.branch} — merged ${mergeCommit.slice(0, 12)}, PR intent recorded`);
  console.error(`report-pr: ${caseId} judged — merged ${mergeCommit.slice(0, 12)}, PR intent recorded (created at finish)`);
  result(cli, { instruction: 'take next case', tier: 'judged', mergeCommit, prIntent: true, issues: warnings });
  return 0;
}

// --------------------------------------------------------------------------
// `sweep finish` (DRIVER.md §10.2) — multi-step, resumable.
// --------------------------------------------------------------------------

/**
 * `sweep finish` — the ONLY stage that publishes ANYTHING (all PRs are
 * created here, after the full-integration verify, §9). Steps, in order:
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
/**
 * The GATE-FIX briefing. Deliberately unlike a conflict briefing: it
 * says up front that there is no merge and nothing pending, so the agent does
 * not hunt for markers, and it states the scope explicitly because the standard
 * "your scope is what this merge causes" rule does not apply here.
 */
/** The captured checks output for a gate-fix case (its cold-read evidence). */
function gateFixFailedOutput(dir: string, caseId: string): string {
  const f = join(dir, caseId, 'gate-fix-output.txt');
  const raw = existsSync(f) ? readFileSync(f, 'utf8') : '';
  // TAIL, like the materials: a compiler can emit thousands of lines and the
  // diagnostics that matter are the last ones.
  return raw.split('\n').slice(-120).join('\n').slice(0, 60000);
}

export function gateFixCaseMaterialsForTest(dir: string, jc: JournaledCase, caseRow: JournalEntry): string {
  return gateFixCaseMaterials(dir, jc, caseRow);
}

function gateFixCaseMaterials(dir: string, jc: JournaledCase, caseRow: JournalEntry): string {
  const gf = readJournal(dir).find((e) => e.action === 'gate-fix' && e.caseId === jc.caseId);
  const files = Array.isArray(gf?.files) ? (gf.files as string[]) : (caseRow.conflictedPaths as string[]) ?? [];
  const failedCommands = Array.isArray(gf?.failedCommands) ? (gf.failedCommands as string[]) : [];
  const candidates = Array.isArray(gf?.candidates) ? (gf.candidates as string[]) : [];
  const outFile = join(dir, jc.caseId, 'gate-fix-output.txt');
  const raw = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const tail = raw.split('\n').slice(-120).join('\n');
  return [
    `# GATE-FIX — ${jc.branch}`,
    '',
    'The full-integration build is RED from a defect that is NOT a merge conflict.',
    'There are NO conflict markers and NOTHING is pending in this worktree.',
    '',
    `Failing checks: ${failedCommands.join(', ') || '(see the output below)'}`,
    `Attributed to ${jc.branch} — ${String(gf?.reason ?? 'registry ownership')}.`,
    ...(caseRow.fullSuiteOnly === true
      ? [
          '',
          '## REPRODUCTION: FULL SUITE ONLY — you cannot observe this failure',
          'The driver probed it: narrowed to these files it does NOT reproduce; it needs',
          'the whole suite running. You may not run the suite, so you cannot see this',
          'failure happen, cannot test a hypothesis, and cannot confirm a fix — only',
          '`report-case` can, one attempt at a time.',
          '',
          'That is a REASON, not an obstacle to push through. A failure that appears only',
          'under concurrency is usually about ORDER, SHARED STATE or TIMING between tests',
          'rather than the logic in the named file — read it once with that in mind. If',
          'you cannot name the interaction from the code, `report-case --tier held` and',
          'write what you found: an unfixable-here finding with a diagnosis is the',
          'DELIVERABLE for this shape, not a failure to fix it.',
        ]
      : []),
    ...(candidates.length > 1 ? [`Implicated: ${candidates.join(', ')} (earliest by hierarchy wins).`] : []),
    '',
    '## Files to fix',
    ...files.map((f) => `- ${f}`),
    '',
    ...(() => {
      // ROOT THE PATHS FIRST. `bun test` runs with `cwd: container/agent-runner`
      // (checks.json), so it prints `src/poll-loop.test.ts` for a file that lives
      // at `container/agent-runner/src/poll-loop.test.ts`. Handing that to the
      // agent sends it to a path that does not exist — `ls: cannot access`
      // before it finds the file, in the very section whose
      // whole purpose is "do not hunt".
      //
      // `rootChecksOutput` re-roots a command's output by its cwd and is
      // what blame uses; this section must not bypass it. The failing-command list comes
      // from the gate-fix row, which records the command NAMES — resolve them
      // back to their configured entries so the cwds are the real ones.
      const cmdEntries = loadChecksConfig(readMachineState(dir)?.checksFile) ?? { typecheck: [], test: [] };
      const all = [...cmdEntries.typecheck, ...cmdEntries.test];
      const used = failedCommands.length > 0 ? all.filter((c) => failedCommands.includes(c.cmd)) : all;
      const locs = failingLocations(used.length > 0 ? rootChecksOutput(raw, used) : raw);
      return locs.length > 0
        ? ['## Failing locations (from the output — start here, do not hunt)', ...locs.map((l) => `- ${l}`), '']
        : [];
    })(),
    '## SCOPE',
    'The files above, plus what fixing them DIRECTLY forces. This is the ONLY case',
    'type where you change code this pass did not merge. Do NOT restructure.',
    '',
    'A failing test names the TEST, not the source. When the defect is in the code',
    'the named files exercise, FIX IT THERE — that is what "what fixing them',
    'directly forces" means. Reaching outside the named files is expected here and',
    'is not a violation: the driver measures the reach, the reviewer is told why',
    'those files were touched, and the case caps at `held`, which means the OWNER',
    'approves your fix rather than you merging it. A held PR carrying a WORKING FIX',
    'is the best outcome this case type has.',
    '',
    'Claim `--tier held` with an unchanged worktree only when the fix cannot be',
    'made here at all — it needs an owner decision, or it belongs to upstream, or',
    'it is outside this repository. Then the PR carries your DIAGNOSIS: what fails,',
    'why it cannot be fixed, and where the fix belongs. That is a valid outcome.',
    'What is NOT valid is reporting the diagnosis in chat and stopping — the PR is',
    'how it reaches the owner.',
    '',
    '## WHEN TO STOP READING',
    'ONE pass over the implicated code, then decide. "Implicated" is: the failing',
    'file, the source it exercises, and the definitions of the symbols in the',
    'failure. Each file ONCE.',
    '',
    'If you have read those and have NOT made an edit, you are done investigating:',
    'claim `--tier held` and write the diagnosis. Re-reading a file you have',
    'already read is the signal that reading is no longer producing decisions —',
    'stop there. Re-reading in a loop burns the whole session without ever',
    'producing a fix or an escalation; the diagnosis you already have IS the',
    'deliverable.',
    '',
    '## REPORT AS YOU GO',
    'Send a one-line message when you TAKE this case, and again on every',
    '`report-case` attempt and its outcome. From outside, an agent that is working',
    'and one that has hung are indistinguishable — silence is what makes a human',
    'interrupt you. Never go more than a few minutes without a line.',
    '',
    '## TIER',
    '- `--tier judged` — you are confident. The fix is committed on the branch and',
    '  pulled through every descendant; this pass can still complete.',
    '- `--tier held`   — you are not, OR the fix does not belong in these files.',
    '  Published as a PR for the owner; BLOCKS the next sweep until merged.',
    '',
    `## Failing output (tail; full log: ${outFile})`,
    '```',
    tail,
    '```',
  ].join('\n');
}

/**
 * The failing commands on an `attributionFailed` verify row, WITH their cwds —
 * blame needs the cwd to re-root the diagnostics (see `rootChecksOutput`), so
 * cmdVerify journals `failedCwds` alongside `failedCommands`.
 */
function failedChecksOf(row: JournalEntry | undefined): VerifyCommand[] {
  const cmds = Array.isArray(row?.failedCommands) ? (row.failedCommands as string[]) : [];
  const cwds = Array.isArray(row?.failedCwds) ? (row.failedCwds as string[]) : [];
  return cmds.map((cmd, i) => ({ cmd, ...(cwds[i] ? { cwd: cwds[i] } : {}) }));
}

/**
 * Re-root a failing checks run's diagnostics at the REPO ROOT before blame.
 *
 * The shipped checks.json runs `{ cmd: 'bun test', cwd: 'container/agent-runner' }`,
 * so that runner prints `src/auth/x.ts` while every registry pattern is written
 * from the clone root (`container/agent-runner/**`). Blame therefore matched
 * nothing — or, worse, matched a ROOT-level `src/…` owner and named a branch
 * that has nothing to do with the failure. Sections are split on the `$ <cmd>`
 * headers both `defaultChecksRunner` and `cmdVerify` write; output with no
 * headers is re-rooted only when the failing commands share ONE cwd, the only
 * case where the mapping is unambiguous. The paths themselves come from
 * `parseFailingFiles` — the same parser blame uses, never a second copy of the
 * diagnostic regexes.
 */
function rootChecksOutput(output: string, commands: VerifyCommand[]): string {
  const norm = (cwd: string | undefined): string => (cwd ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '');
  const cwdOf = new Map(commands.map((c) => [c.cmd, norm(c.cwd)]));
  const distinct = new Set(cwdOf.values());
  if ([...distinct].every((c) => c === '')) return output; // everything already repo-rooted
  const reroot = (block: string, cwd: string): string => {
    if (!cwd) return block;
    let out = block;
    for (const f of parseFailingFiles(block)) {
      const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(^|[^\\w./@-])${escaped}`, 'gm'), (_m, lead: string) => `${lead}${cwd}/${f}`);
    }
    return out;
  };
  const lines = output.split('\n');
  const headed = lines.some((l) => l.startsWith('$ ') && cwdOf.has(l.slice(2)));
  let current = headed ? '' : distinct.size === 1 ? [...distinct][0] : '';
  const out: string[] = [];
  let block: string[] = [];
  const flush = (): void => {
    if (block.length) out.push(reroot(block.join('\n'), current));
    block = [];
  };
  for (const line of lines) {
    if (headed && line.startsWith('$ ') && cwdOf.has(line.slice(2))) {
      flush();
      current = cwdOf.get(line.slice(2))!;
      out.push(line);
      continue;
    }
    block.push(line);
  }
  flush();
  return out.join('\n');
}

/** One materialized gate-fix case (a pass can need several — see below). */
interface GateFixCaseSummary {
  caseId: string;
  branch: string;
  files: string[];
  reason: string;
}

/**
 * Turn an unattributable red into GATE-FIX case(s).
 *
 * Blame the failing files to their branches by GIT HISTORY (`attributeFailure`,
 * owner rule: shallowest by hierarchy), then prepare a worktree at each blamed
 * branch's tip. Unlike a conflict case there is nothing pending and no markers —
 * the agent edits the named files so the checks pass.
 *
 * BATCHED, ONE CASE PER BRANCH. A red build routinely
 * names files that belong to DIFFERENT branches; a single case would force all
 * of them onto one branch's worktree, where the fix for someone else's file
 * either cannot
 * be made or lands where it reaches nobody. Cases come back SHALLOWEST BRANCH
 * FIRST: a judged trunk fix plus the `reopen()` it triggers can moot a
 * descendant's case entirely, so the trunk must be workable before its children.
 *
 * ANTI-LOOP: a gate fix that does not actually fix leaves verify red, which
 * would prepare another case for the same files forever. One attempt per
 * (branch, file-set) per pass — the key is per BRANCH, so one looping branch
 * never suppresses another branch's first attempt. When nothing at all is
 * servable the caller falls back to the STOP path.
 *
 * `rootBranch`: the case is rooted THERE rather than
 * on the blamed branch — see the rooting comment below.
 */
/**
 * The ACTIVE GATE on a branch: an unmerged gate-fix ref on ORIGIN.
 *
 * This is the cross-pass anti-loop, and three properties make it the right one:
 *
 *  - PER-BRANCH, so it covers every gate fix `finish` can mint — no branch is
 *    re-mintable on every pass;
 *  - DERIVED FROM ORIGIN, not local state a pass wipe or a fresh
 *    clone silently loses;
 *  - SELF-CLEARING: a ref disappears when its PR merges. (A sha-keyed local
 *    record would wedge on a HELD fix — which by definition leaves the branch
 *    red until the owner merges it — pinning the key forever.)
 *
 * Keyed on the BRANCH, not the case id: a gate fix IS per-branch (blame groups
 * the failing files by owner and mints one case per owner), so "does this branch
 * already have a fix awaiting the owner" is the whole question. The id stays in
 * the ref NAME only to keep it unique and deterministic — nothing looks it up.
 */
async function activeGateFixRef(repo: string, branch: string): Promise<string | null> {
  const refs = await gateFixRefs(repo, slug(branch));
  return refs[0] ?? null;
}

/** Every ACTIVE gate on origin, any branch — one ref read, no scope mapping. */
async function activeGateFixRefs(repo: string): Promise<string[]> {
  return gateFixRefs(repo, '*');
}

async function gateFixRefs(repo: string, branchSlug: string): Promise<string[]> {
  const pattern = `refs/remotes/origin/fix/sweep/${branchSlug}--gate-fix-*`;
  const res = await git(repo, ['for-each-ref', '--format=%(refname:short)', pattern], { allowCodes: [1] });
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((r) => r.replace(/^origin\//, ''));
}

/**
 * Bound on a case's assembled `detail`.
 *
 * A target's account is CONCATENATED — one sentence per floor that routes to it,
 * plus the ceiling decision and any coordinate — and it is carried into the case
 * briefing, the PR text and the result instruction, all of which a human reads.
 * Unbounded, a wide failure turns each of them into a paragraph nobody finishes.
 */
const CEILING_DETAIL_CAP = 1200;

function boundedDetail(detail: string): string {
  return detail.length <= CEILING_DETAIL_CAP ? detail : `${detail.slice(0, CEILING_DETAIL_CAP)}…`;
}

/** The CEILING for a failing set: per file, the shallowest branch that AUTHORED it. */
export interface CeilingBlame {
  /** Per-file blame, input order — the record of how each ceiling was decided. */
  perFile: FileBlame[];
  /** Ceiling branch -> the files whose blame may be lifted to it. */
  byCeiling: Map<string, string[]>;
  /** Files whose shallowest authors TIE: no ceiling, so no lift for them. */
  ties: FileBlame[];
}

/**
 * HOW HIGH BLAME MAY GO, for one set of failing files.
 *
 * Two branches red on the same failure are already a measurement — indirect,
 * since neither is directly attributed — and they give the FLOOR. This gives the
 * CEILING: blame may not be lifted above the shallowest level that AUTHORED the
 * failing content, because above that line the content is not there to be wrong.
 * The mint goes at the ceiling so ONE fix reaches every red beneath it, instead
 * of one case per branch that inherited the defect.
 *
 * AUTHORSHIP ONLY BOUNDS — it is not a locator. It answers "who wrote these
 * bytes", never "what changed between green and red", and the file it is asked
 * about is the one that REPORTED the failure (`parseFailingFiles`), not
 * necessarily the one that caused it. So a ceiling licenses nothing on its own:
 * what licenses a mint up there is a CONFIRMATION taken there.
 *
 * BLAME THAT CANNOT BE TRUSTED MUST NOT LIFT BLAME. A malformed cut-point
 * exceptions file (cut-points.ts) makes every count suspect — it is exactly the
 * input that credits one branch with another's rebased commits — so this returns
 * NO ceiling for anything and every failure stays where it was measured. The
 * mint's own loud ERR43 stop is a separate decision and is unchanged.
 */
async function ceilingFor(cli: Cli, dir: string, files: string[]): Promise<CeilingBlame> {
  const none: CeilingBlame = { perFile: [], byCeiling: new Map(), ties: [] };
  if (files.length === 0) return none;
  const badCutPoints = malformedCutPointExceptionsIssue();
  if (badCutPoints) {
    appendJournal(dir, { action: 'warning', id: badCutPoints.id, message: badCutPoints.detail });
    console.error(`gate-fix [${badCutPoints.id}]: ${badCutPoints.detail}`);
    return none;
  }
  const { features } = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile, routingFile: cli.routingFile });
  const cutPoints = await resolveCutPointExceptions(cli.repo);
  // STALE entries are journaled, never applied: a claim git now contradicts must
  // not suppress a real answer. NOT-APPLICABLE ones stay quiet — they suppress
  // nothing.
  for (const w of staleWarnings(cutPoints)) {
    appendJournal(dir, {
      action: 'warning',
      id: 'WARN08_CUT_POINT_EXCEPTION_STALE',
      message: `${w.branch}/${w.kind}: ${w.detail}`,
    });
    console.error(`gate-fix [WARN08_CUT_POINT_EXCEPTION_STALE]: ${w.branch}/${w.kind}: ${w.detail}`);
  }
  const byFile = await blameCandidates(cli.repo, files, features, undefined, cutPoints.duplicates);
  // `blameFile` already answers the two edges: NOBODY authored the file (the
  // trunk is the ceiling — it is where a fix reaches every branch and the one
  // place that is never someone else's work) and a TIE at the shallowest depth
  // (no ceiling at all, because picking one would be a decision made by
  // spelling). Neither is re-derived here.
  const perFile = files.map((f) => blameFile(f, byFile.get(f) ?? []));
  const byCeiling = new Map<string, string[]>();
  for (const b of perFile) {
    if (!b.branch) continue;
    byCeiling.set(b.branch, [...(byCeiling.get(b.branch) ?? []), b.file]);
  }
  return { perFile, byCeiling, ties: perFile.filter((b) => !b.branch) };
}

/** What one fresh measurement at a commit established, or why it established nothing. */
type CeilingVerdict = 'red' | 'green' | 'unstable' | 'unmeasurable';

/**
 * MEASURE THE CEILING ITSELF, once, in a worktree of its own.
 *
 * Authorship says a fix may go this high; only a run says it SHOULD. This is
 * that run: one fresh temp worktree at the ceiling's tip, its own dependency
 * install from that tree's manifests, and the failing commands — the same
 * conditions every other gate measures under, so its answer is comparable with
 * theirs.
 *
 * GREEN IS A RESULT, NOT A WASTED PROBE. It is journaled as a `branch-check`
 * row, so `greenChecks` inherits it: every later gate whose command runs on the
 * same subtree reads that verdict instead of paying for it again. It also
 * settles the question the caller asked — the red is BELOW the author, so blame
 * stays where it was measured.
 *
 * A RED IS STILL ONE OBSERVATION, so it goes through `confirmRed` like every
 * other accusation: a varied re-run in a separately prepared worktree, journaled
 * where the mint's backstop can read it. NO NEW ROW SHAPES — `branch-check` and
 * `red-confirm` are what the existing readers consume, and a measurement they
 * cannot see is a measurement that refuses the mint it was taken for.
 */
async function confirmRedAt(
  cli: Cli,
  dir: string,
  branch: string,
  sha: string,
  commands: VerifyCommand[],
  runChecks: ChecksRunner,
  runInstall?: InstallRunner,
  /** Which gate took the measurement — the row says so, and readers scan by it. */
  phase: string = 'ceiling',
): Promise<CeilingVerdict> {
  const keys = await checkVerdictKeys(cli.repo, sha, commands);
  const wt = await addTempWorktree(cli.repo, sha);
  let r: ChecksRunResult;
  try {
    // A tree whose dependencies will not install has NO environment, and a check
    // run in it is not evidence about the code.
    const install = await installDeps(cli, wt.path, runInstall);
    if (!install.ok) return 'unmeasurable';
    r = await runChecks(commands, wt.path);
  } finally {
    await wt.remove();
  }
  if (r.environmentFault) return 'unmeasurable';
  if (r.ok) {
    appendJournal(dir, { action: 'branch-check', branch, sha, ok: true, checks: keys.map((k) => ({ ...k, ok: true })) });
    return 'green';
  }
  const failedKeys = keys.filter((k) => r.failedNames.includes(k.cmd));
  // NOT OK AND NAMING NOTHING is not a red: there is no command to confirm and
  // no subtree to key a verdict to, so the ceiling was never measured.
  if (failedKeys.length === 0) return 'unmeasurable';
  const failed = commands.filter((c) => r.failedNames.includes(c.cmd));
  const confirm = await confirmRed(dir, {
    branch,
    sha,
    phase,
    failed: failedKeys,
    rerun: (again) => variedRerun(cli, sha, failed.filter((c) => again.some((k) => k.cmd === c.cmd)), runChecks, runInstall),
  });
  if (confirm.unmeasurable) return 'unmeasurable';
  return confirm.reproduced ? 'red' : 'unstable';
}

/**
 * A CONFIRMED RED FOR THE SAME COMMAND, AT A COMMIT THAT DOES NOT CARRY THE
 * CONTENT — a coordinate worth REPORTING, and never on its own a verdict.
 *
 * Content cannot break a commit it is absent from, so that red is not about that
 * content. What the match does NOT establish is that it is about the SAME
 * FAILURE: the key here is the command, and one command carries many failures. A
 * branch that forked before the failing file existed and is red on its own
 * unrelated defect matches every part of this test. So the coordinate travels
 * with the case — it says the machine may be part of the story, and the reader
 * can check it, which is why the sha and the file travel with it — and blame is
 * never pushed above the floor on it. Refusing a confirmed floor mint on it
 * would tell an agent that no code change can fix a defect a code change fixes.
 *
 * Absence is answered from git (`cat-file -e`), not from a probe: a runner asked
 * for a path it cannot find exits non-zero with nothing parseable, which is the
 * same shape as a red.
 */
async function redWhereContentIsAbsent(
  cli: Cli,
  journal: JournalEntry[],
  files: string[],
  commands: VerifyCommand[],
): Promise<{ sha: string; file: string } | null> {
  const names = new Set(commands.map((c) => c.cmd));
  const shas = new Set<string>();
  for (const e of journal) {
    if (typeof e.sha !== 'string' || e.sha === '') continue;
    if (e.action === 'red-confirm' && e.reproduced === true && typeof e.cmd === 'string' && names.has(e.cmd)) {
      shas.add(e.sha);
      continue;
    }
    if (
      e.action === 'landing-check' &&
      e.ok === false &&
      e.confirmed === true &&
      Array.isArray(e.failed) &&
      (e.failed as unknown[]).some((n) => typeof n === 'string' && names.has(n))
    ) {
      shas.add(e.sha);
    }
  }
  for (const sha of shas) {
    for (const file of files) {
      const r = await git(cli.repo, ['cat-file', '-e', `${sha}:${file}`], { allowCodes: [1, 128] });
      if (r.code !== 0) return { sha, file };
    }
  }
  return null;
}

/** Where a measured red's fix goes: the floor it was measured on, or one ceiling above. */
interface LiftDecision {
  /** The branch the case is rooted on. */
  branch: string;
  /** The commit the case is rooted at and the red observation is keyed to. */
  ref: string;
  attributedCeiling: boolean;
  /**
   * Set instead of a mint: the table refused, and this is what to report. The id
   * is one of the two a refused red travels under, because the caller reports it
   * in exactly the shape `redObservationUsable` produces.
   */
  refused?: { id: 'WARN21_CHECKS_FLAKY' | 'WARN22_RED_UNCONFIRMED'; detail: string };
  /**
   * A confirmed red for the same command at a commit that does not carry the
   * failing content. It is REPORTED with the case — it says something about the
   * machine — and it decides nothing, because the key is the command and one
   * command carries many failures.
   */
  coordinate?: string;
  decided: string;
  detail: string;
}

/**
 * The failing log a gate-fix case is briefed with, plus what the ceiling step
 * found. A coordinate that lives only in the journal is one the agent working
 * the case never sees, and it is the sentence that tells the owner the machine
 * may be part of the story.
 */
function withCeilingNote(output: string, lift: LiftDecision): string {
  return lift.coordinate ? `${output}\n\n--- ceiling ---\n${lift.coordinate}\n` : output;
}

/**
 * THE CEILING FOR A RED MEASURED AT ONE COMMIT — the landing gate's answer and
 * the pre-merge check's, where the adjudication's per-owner partition does not
 * exist.
 *
 * Same rule, same table: authorship bounds how high blame may go, a measurement
 * at the ceiling decides whether it goes there, and a green ceiling keeps blame
 * on the floor that showed the red.
 *
 * ONE CASE HAS ONE ROOT, so a lift needs ONE ceiling for the WHOLE failing set.
 * A set whose files were authored at different levels, or one carrying a tie,
 * stays on the floor: splitting it would mint a case per level from a single
 * observation, and folding it onto one level would hand a branch files it never
 * wrote.
 *
 * THE FLOOR'S OWN CONFIRMATION TRAVELS FOR FREE where the ceiling's tip carries
 * the identical subtree — which is the ordinary shape, since a branch that
 * inherited a defect changed nothing in the subtree the failing command runs in.
 * Nothing is re-run for that case.
 */
async function liftGateFixTarget(
  cli: Cli,
  dir: string,
  caseId: string | null,
  floorBranch: string,
  floorRef: string,
  files: string[],
  commands: VerifyCommand[],
  runChecks: ChecksRunner,
  runInstall?: InstallRunner,
): Promise<LiftDecision> {
  const onFloor = (decided: string, detail: string): LiftDecision => ({
    branch: floorBranch,
    ref: floorRef,
    attributedCeiling: false,
    decided,
    detail,
  });
  // NO PARSEABLE FILES, NO CEILING QUESTION. Blame has nothing to be about, so
  // the red stays exactly where it was measured.
  if (files.length === 0) return onFloor('no-lift-none', 'the failing output named no file to attribute');
  const ceil = await ceilingFor(cli, dir, files);
  const ceilings = [...ceil.byCeiling.keys()];
  const journalRow = (d: LiftDecision, ceiling: string | null, ceilingRef: string | null): LiftDecision => {
    appendJournal(dir, {
      action: 'gate-fix-ceiling',
      ...(caseId ? { caseId } : {}),
      floor: floorBranch,
      floorRef,
      ceiling,
      ceilingRef,
      files,
      decided: d.decided,
      detail: d.detail,
    });
    return d;
  };
  /** The one branch a lift could go to, or null where no single branch is named. */
  const ceiling = ceil.ties.length === 0 && ceilings.length === 1 ? ceilings[0] : null;
  // RED WHERE THE CONTENT IS NOT, carried as a NOTE — see the same scan in the
  // adjudication. It travels with the case and decides nothing: the key is the
  // command, and a branch that forked before the failing file existed and is red
  // on its own unrelated defect matches it exactly. Refusing on it would tell an
  // agent that no code change can fix a defect a code change fixes.
  //
  // ASKED BEFORE ANY ARM ANSWERS, exactly as the adjudication asks it. A red that
  // stays on its floor is the case most likely to be about the machine, so a scan
  // placed after the no-lift arms would report the coordinate only where blame
  // moved — which is the half that needs it least.
  const absent = await redWhereContentIsAbsent(cli, readJournal(dir), files, commands);
  const coordinate = absent
    ? `${files.join(', ')} affects everything below ${ceiling ?? floorBranch}; also red at ` +
      `${absent.sha.slice(0, 12)} which does not carry the content (${absent.file} is not there)`
    : undefined;
  if (coordinate) journalRow({ ...onFloor('environment-noted', coordinate), coordinate }, ceiling, null);
  /** Everything decided from here carries the coordinate, where there is one. */
  const withNote = (d: LiftDecision): LiftDecision => (coordinate ? { ...d, coordinate } : d);
  if (ceiling === null) {
    return journalRow(
      withNote(
        onFloor(
          'no-lift-tie',
          `no single branch can be named the ceiling for ${files.join(', ')}, so blame stays where it was ` +
            `MEASURED, on ${floorBranch}`,
        ),
      ),
      null,
      null,
    );
  }
  if (ceiling === floorBranch) {
    return journalRow(
      withNote(
        onFloor('no-lift-same', `${floorBranch} authored ${files.join(', ')} — it is both the floor and the ceiling`),
      ),
      ceiling,
      floorRef,
    );
  }
  const ceilingTip = await revParse(cli.repo, ceiling).catch(() => '');
  if (!ceilingTip) {
    return journalRow(
      withNote(
        onFloor(
          'no-lift-unmeasurable',
          `the ceiling ${ceiling} does not resolve in this clone, so it cannot be measured — blame stays on ${floorBranch}`,
        ),
      ),
      ceiling,
      null,
    );
  }
  const known = redConfirmations(readJournal(dir));
  const keys = await checkVerdictKeys(cli.repo, ceilingTip, commands).catch(() => []);
  const lifted = (decided: string, detail: string): LiftDecision => ({
    branch: ceiling,
    ref: ceilingTip,
    attributedCeiling: true,
    decided,
    detail,
  });
  if (keys.length > 0 && keys.every((k) => known.get(checkKey(k.subtree, k.cmd))?.reproduced === true)) {
    return journalRow(
      withNote(lifted(
        'lift-shared',
        `${ceiling} authored ${files.join(', ')} and every failing command is already confirmed red on the ` +
          `subtrees its tip carries — the fix goes there, where it reaches every red beneath it`,
      )),
      ceiling,
      ceilingTip,
    );
  }
  progress(`ceiling: measuring ${ceiling} for ${files.join(', ')}`);
  const at = await confirmRedAt(cli, dir, ceiling, ceilingTip, commands, runChecks, runInstall);
  if (at === 'red') {
    return journalRow(
      withNote(lifted(
        'lift-measured',
        `${ceiling} authored ${files.join(', ')} and its tip is CONFIRMED RED on the failing command(s) — the ` +
          `fix goes there, where it reaches every red beneath it`,
      )),
      ceiling,
      ceilingTip,
    );
  }
  if (at === 'green') {
    return journalRow(
      withNote(onFloor(
        'no-lift-green',
        `${ceiling} authored ${files.join(', ')} but its tip is GREEN — the red is BELOW the author, so blame ` +
          `stays on ${floorBranch}`,
      )),
      ceiling,
      ceilingTip,
    );
  }
  if (at === 'unstable') {
    const detail =
      `${ceiling} authored ${files.join(', ')} and its tip is UNSTABLE on the failing command(s) — red once and ` +
      `green once with nothing changed between, so the failure belongs to no branch`;
    return journalRow(
      withNote({ ...onFloor('refused-unstable', detail), refused: { id: 'WARN21_CHECKS_FLAKY', detail } }),
      ceiling,
      ceilingTip,
    );
  }
  // A SECOND OBSERVATION THAT COULD NOT BE TAKEN MAY NOT LIFT BLAME, and it may
  // not BLOCK a floor mint that is already confirmed either.
  return journalRow(
    withNote(
      onFloor(
        'no-lift-unmeasurable',
        `the ceiling ${ceiling} could not be measured for ${files.join(', ')} — blame stays on ${floorBranch}`,
      ),
    ),
    ceiling,
    ceilingTip,
  );
}

/**
 * WHAT A CALLER OWES THE MINT: a confirmation, or the authority to take one.
 *
 * Blame never measures — it reads git history over a failing log somebody else
 * produced — so a single red run reaches it as an established fact and comes out
 * the other side as a case, a held PR and a named culprit. The obligation is
 * therefore in the TYPE rather than in a convention: a caller either says WHERE
 * its red was confirmed, or hands the mint a way to confirm one itself. There is
 * no third shape, and that is the point — "mint with no measurement behind it"
 * is not expressible, so no future caller can reach a mint by omitting a field.
 */
type GateFixEvidence =
  | {
      /**
       * The OBSERVATION this case would rest on: the COMMIT the failing commands
       * were measured at, and the commands.
       *
       * Checked against the confirmations the pass has journaled, PER COMMAND AND
       * PER SUBTREE: a red that was re-run and reproduced on the subtree the
       * command runs in mints, and one that changed its answer (or was never
       * re-run at all) mints nothing. Nothing is re-run here — the confirmation
       * belongs where the tree was standing and its worktree still had its
       * dependencies, and this is a journal read.
       */
      redOn: { at: string; commands: VerifyCommand[] };
      confirmAtRoot?: never;
    }
  | {
      redOn?: never;
      /**
       * TAKE THE OBSERVATION HERE. The caller has no confirmation to offer — the
       * integration verify attributes a red build by elimination, over a log that
       * names the file which REPORTED the failure and not necessarily the one
       * that caused it — so it authorises the mint to measure each blamed branch
       * at the commit the case would be rooted on, before accusing it.
       */
      confirmAtRoot: RootConfirmer;
    };

/** Measure one branch at one commit: the four answers a fresh run can give. */
export type RootConfirmer = (branch: string, sha: string, commands: VerifyCommand[]) => Promise<CeilingVerdict>;

async function materializeGateFixCases(
  cli: Cli,
  dir: string,
  chain: Chain,
  failedOutput: string,
  failedCommands: VerifyCommand[],
  accused: string | null,
  opts: GateFixEvidence & {
    rootBranch?: string;
    /** The failure reproduces only under the FULL command (see the call site). */
    fullSuiteOnly?: boolean;
    /**
     * Root the case's worktree at THIS commit instead of the branch tip
     * (`--not-my-bug`). Used when the search could not name an
     * introducing commit but did observe the failure at an older point: rooting
     * there puts the fix as deep as the evidence supports, so branches sharing
     * that ancestor can take one fix rather than one each. The trade is that the
     * fix is then BEHIND the tip — the PR text carries the rebase note.
     */
    rootAt?: string;
    /**
     * The files an ownership probe PROVED belong to `rootBranch`. When the caller
     * has that proof it decides the case's scope, because the re-parse below
     * cannot: it reads the RAW failing log, which names every file the run
     * complained about — including files the probe showed this owner does NOT own
     * and paths the adjudication already excluded as the agent's own work. A case
     * carrying those hands its owner work it never touched. Callers with no probe
     * (the finish-path blame) omit it and get the parsed set.
     */
    ownedFiles?: string[];
    /**
     * `rootBranch` is the CEILING for these files, proven by authorship. The red
     * may then be carried there from any branch sharing the subtree — see
     * `redObservationUsable`, which is where the rule lives.
     */
    attributedCeiling?: boolean;
  },
): Promise<{
  served: boolean;
  cases: GateFixCaseSummary[];
  reason: string;
  detail: string;
  gated: string[];
  /** The id a REFUSAL carries, so the agent is told which finding it is. */
  id?: string;
}> {
  const journal = readJournal(dir);
  const { features } = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile, routingFile: cli.routingFile });
  const none = { served: false as const, cases: [] as GateFixCaseSummary[], reason: '', detail: '', gated: [] as string[] };
  // A SINGLE RED OBSERVATION MAY NOT FOUND A CASE, AND A VERDICT BELONGS TO THE
  // SUBTREE THE COMMAND RAN IN — the BACKSTOP, at the one place a case is
  // created, so no caller can reach a mint with an unconfirmed red or with a
  // red that was never measured where the case is being rooted. Callers that
  // must not destroy anything before they know the answer ask
  // `redObservationUsable` themselves, first; this refuses whatever still
  // arrives. Nothing is re-run here: the confirmation belongs where the tree was
  // standing and its worktree still had its dependencies, and this is a journal
  // read.
  if (opts.redOn) {
    const rootedOn = opts.rootBranch ?? '';
    const red = await redObservationUsable(journal, cli.repo, rootedOn, opts.redOn.at, opts.redOn.commands, {
      attributedCeiling: opts.attributedCeiling === true,
    });
    if (!red.usable) {
      const detail = redRefusalDetail(red.reasons);
      appendJournal(dir, {
        action: 'gate-fix-refused',
        id: red.id,
        branch: rootedOn,
        at: opts.redOn.at,
        subtrees: red.observed.map((v) => ({ cmd: v.cmd, ...(v.cwd ? { cwd: v.cwd } : {}), subtree: v.subtree })),
        commands: opts.redOn.commands.map((c) => c.cmd),
        reason: detail,
      });
      console.error(`gate-fix [${red.id}]: ${detail}`);
      return { ...none, reason: detail, detail, id: red.id };
    }
  }
  // CUT-POINT EXCEPTIONS (cut-points.ts). A MALFORMED file is LOUD and stops
  // this command — the ERR43_CHECKS_MALFORMED contract. Blaming with the
  // exceptions silently dropped is not "blame without them": it is blame that
  // credits `module/credentials` with `module/host-rpc`'s rebased `3b8c5896`
  // and then mints a gate-fix case on the wrong branch, which is a worse
  // outcome than stopping and saying so. An ABSENT file skips in silence.
  const badCutPoints = malformedCutPointExceptionsIssue();
  if (badCutPoints) {
    appendJournal(dir, { action: 'warning', id: badCutPoints.id, message: badCutPoints.detail });
    console.error(`gate-fix [${badCutPoints.id}]: ${badCutPoints.detail}`);
    return {
      ...none,
      reason: 'the cut-point exceptions file is unreadable — blame cannot be trusted',
      detail: badCutPoints.detail,
    };
  }
  const cutPoints = await resolveCutPointExceptions(cli.repo);
  // STALE entries are journaled, never applied: a claim git now contradicts must
  // not suppress a real answer. NOT-APPLICABLE ones (refs absent in this clone)
  // stay quiet — they suppress nothing.
  for (const w of staleWarnings(cutPoints)) {
    appendJournal(dir, {
      action: 'warning',
      id: 'WARN08_CUT_POINT_EXCEPTION_STALE',
      message: `${w.branch}/${w.kind}: ${w.detail}`,
    });
    console.error(`gate-fix [WARN08_CUT_POINT_EXCEPTION_STALE]: ${w.branch}/${w.kind}: ${w.detail}`);
  }
  if (cutPoints.applied.length > 0) {
    appendJournal(dir, { action: 'cutPointExceptions', applied: cutPoints.applied });
  }
  const a = await attributeFailure(
    cli.repo,
    rootChecksOutput(failedOutput, failedCommands),
    features,
    accused,
    cutPoints.duplicates,
  );
  // PROOF BEATS RE-PARSING. `attributeFailure` still runs — its candidates and
  // reason are the blame record — but where the caller proved the owner's subset,
  // that subset is the case's file list.
  const files = opts.ownedFiles ? [...opts.ownedFiles] : a.files;
  const commandNames = failedCommands.map((c) => c.cmd);
  // NO FILES, NO CASE. `cmdVerify`'s ROLLBACK arm (an offender isolated, rolled
  // back, HELD(gate), and the re-verify STILL red) journals no attributionFailed
  // row, so `failedOutput` arrives empty: attribution parses nothing, falls back
  // to the ACCUSED branch, and a case would be minted with empty conflictedPaths
  // and an empty output file — the agent handed something to fix with nothing in
  // it, pre-empting the honest STOP. A case needs at least one named file.
  if (files.length === 0) {
    return {
      ...none,
      reason: 'the failing output named no source files — there is nothing to hand an agent',
      detail: `verify RED with no parseable diagnostics; ${a.reason}`,
    };
  }
  // ROOTING. A BASE-RED gate fix must target the BASE ANCHOR ITSELF: the base
  // gate typechecks the anchor IN ISOLATION, so a commit on any other branch —
  // however honestly blamed — does nothing for it. The next `start` re-runs the
  // same typecheck on the same red base and fails identically, forever. One case
  // then, carrying EVERY failing file, because they must all be fixed in the one
  // place that is the base.
  const rooted = opts.rootBranch ?? null;
  const groups: Array<{ branch: string; files: string[]; reason: string }> = rooted
    ? [
        {
          branch: rooted,
          files,
          reason:
            `${a.reason}; rooted on ${rooted} — ` +
            (opts.rootBranch && a.groups.some((g) => g.branch === rooted)
              ? `the located owner, which every failing file must be fixed on`
              : `the base, and a commit on a descendant can never turn the base green`),
        },
      ]
    : a.groups.map((g) => ({ branch: g.branch, files: g.files, reason: g.reason }));
  if (groups.length === 0) {
    return { ...none, reason: 'no branch could be blamed for the failing files', detail: `verify RED (no clean attribution); ${a.reason}` };
  }

  // MANDATE BOUNDARY. `main` is UPSTREAM — never ours to fix,
  // and a fix committed there could not be pushed anywhere the fork controls.
  // The failure shape this forecloses: a probe of
  // upstream's head runs with the wrong dependencies, comes back red for a
  // module upstream actually declares, ownership moves to the parent, a bisect
  // converges — a fully substantiated case for a defect that does not exist.
  //
  // Enforced HERE because this is the one place a case is created, and the
  // `rootBranch` override bypasses attribution entirely (which already excludes
  // upstream). Putting it in the callers would give two copies and leave the
  // pre-merge check's own override uncovered.
  //
  // A REFUSAL IS NOT SILENCE. "Upstream is red at <sha> for <files>" is a real
  // and urgent finding — the fork is about to merge a broken upstream commit —
  // so it is reported, loudly, as something only the owner can act on. What the
  // driver must not do is manufacture work against it.
  const upstreamGroups = groups.filter((g) => g.branch === ROOT_BRANCH);
  if (upstreamGroups.length > 0) {
    const files = [...new Set(upstreamGroups.flatMap((g) => g.files))];
    appendJournal(dir, {
      action: 'gate-fix-refused',
      // The id travels ON THE ROW: `unmintableReds` reports what the row says,
      // and a row that names no code is reported under whatever the reader
      // defaults to — here, an unconfirmed red, which this is not.
      id: 'WARN15_UPSTREAM_RED',
      branch: ROOT_BRANCH,
      files,
      reason: 'upstream is outside the sweep mandate — no work may be minted there',
    });
    console.error(`gate-fix [WARN15_UPSTREAM_RED]: refusing to mint on upstream ${ROOT_BRANCH} (${files.join(', ')})`);
  }
  const mintable = groups.filter((g) => g.branch !== ROOT_BRANCH);
  if (mintable.length === 0) {
    const files = [...new Set(upstreamGroups.flatMap((g) => g.files))];
    return {
      ...none,
      reason: `the failure is on UPSTREAM ${ROOT_BRANCH} (${files.join(', ')}) — outside this sweep's mandate`,
      detail:
        `verify RED and blamed to upstream ${ROOT_BRANCH} over ${files.join(', ')}. The sweep may not commit to ` +
        `upstream, so no case was created. REPORT to the owner: upstream is red and the fork is merging from it.`,
    };
  }

  const cases: GateFixCaseSummary[] = [];
  const looping: string[] = [];
  const gated: string[] = [];
  /** Branches whose fix worktree has no environment — the machine, not the branch. */
  const envBlocked: string[] = [];
  /** Branches the mint measured GREEN at their own tip — blamed, and not red. */
  const droppedGreen: Array<{ branch: string; detail: string }> = [];
  /** Branches whose own tip gave no verdict to accuse them with. */
  const unconfirmed: Array<{ branch: string; detail: string }> = [];
  // A GATE HOLD ALREADY TAKEN THIS PASS BLOCKS EVERYTHING BENEATH IT.
  //
  // A gate fix means the branch is RED. Every descendant merges that branch, so
  // every descendant inherits the redness — there is no height at which one is
  // unaffected, and nothing beneath can be judged until the fix lands. The
  // cross-pass skip below reads ORIGIN refs, which do not exist until `finish`
  // publishes, so within a pass this check is what blocks beneath a trunk gate.
  // Without it the loop mints a SECOND gate fix on a descendant — work
  // downstream of a trunk the pass has already stopped on. One gate fix,
  // one HELD PR, everything beneath blocked, is the rule.
  //
  // TWO SHAPES OF GATE HOLD, and this check must cover BOTH:
  //
  //   `reason: 'gate'`        — the §9 rollback: verify blamed a branch and froze it.
  //   a held GATE-FIX case    — the agent worked a gate fix and reported --tier held.
  //                             That row carries NO `reason` at all.
  //
  // Matching on `reason` alone misses the second shape, and a gate fix gets
  // minted on a descendant of a gate-held trunk anyway.
  const gateFixCaseIds = new Set(
    journal.filter((e) => e.action === 'gate-fix' && typeof e.caseId === 'string').map((e) => e.caseId as string),
  );
  const gateHeldThisPass = new Set(
    journal
      .filter(
        (e) =>
          e.action === 'held' &&
          typeof e.branch === 'string' &&
          (e.reason === 'gate' || (typeof e.caseId === 'string' && gateFixCaseIds.has(e.caseId))),
      )
      .map((e) => e.branch as string),
  );
  // Which FILES each gate-held branch's fix covers, read off the `gate-fix` row
  // that minted it. Needed by the located-owner rule below: a located owner is
  // only trustworthy for files the gated ancestor's own fix does not already
  // cover.
  const gateHeldFiles = new Map<string, Set<string>>();
  for (const e of journal) {
    if (e.action !== 'gate-fix' || typeof e.branch !== 'string' || !gateHeldThisPass.has(e.branch)) continue;
    const set = gateHeldFiles.get(e.branch) ?? new Set<string>();
    for (const f of Array.isArray(e.files) ? (e.files as string[]) : []) set.add(f);
    gateHeldFiles.set(e.branch, set);
  }
  const ancestorsOfBranch = transitiveAncestors(Object.fromEntries(directParentEdges(cli)));
  for (const g of mintable) {
    // A LOCATED OWNER IS TRUSTED ONLY FOR FILES NO GATED ANCESTOR ALREADY OWNS.
    //
    // The ancestor gate exists for the FINISH path, where a red integration build
    // is attributed by elimination: beneath a gate-held ancestor that attribution
    // is unreliable, because the ancestor's own defect is in everything below it.
    // `--not-my-bug` is stronger — the failure was PROVEN pre-existing against the
    // pre-conflict tree and the owner was located by probing the branch tip and
    // the parent head (`opts.rootBranch` is set only on that path) — so refusing
    // it wholesale burns an adjudication round per descendant, each naming the
    // SAME owner, and records nothing.
    //
    // But it is not proof of OWNERSHIP.
    // `locateOwner` proves the branch tip is RED — which inherited redness from a
    // gate-held ancestor satisfies just as well as an own defect. When the
    // ancestor's held fix covers files this mint also carries, the honest read is
    // "the ancestor's defect seen from below": minting here asks the agent to
    // re-fix it on a descendant (which the parents-merge model then turns into a
    // future conflict) and asks the owner the same question twice. For files the
    // ancestor's fix does NOT cover, the located owner stands and the case mints.
    const ownerLocated = typeof opts.rootBranch === 'string' && opts.rootBranch === g.branch;
    const coveringAncestor = (ancestorsOfBranch[g.branch] ?? []).find((a) => {
      if (!gateHeldThisPass.has(a)) return false;
      if (!ownerLocated) return true;
      const covered = gateHeldFiles.get(a);
      return covered ? g.files.some((f) => covered.has(f)) : false;
    });
    const gatedAncestor = coveringAncestor;
    if (gatedAncestor && !gateHeldThisPass.has(g.branch)) {
      gated.push(g.branch);
      // FIELD NAMES THAT CANNOT BE MISREAD. This row is the only place the
      // failing FILES appear next to a branch name, and a reader looking for
      // "who owns this failure" reads the most branch-shaped field it has. So
      // the branch this row is ABOUT must never sit in a field that reads like
      // the answer: `owner` is the branch that holds the defect and the fix,
      // `skipped` is the branch no case was minted on, and the files are named
      // `skippedFiles` because they are the mint that did NOT happen — not the
      // owner's failing set. The detail leads with the owner for the same
      // reason.
      appendJournal(dir, {
        action: 'gate-fix-skipped',
        id: 'WARN20_ANCESTOR_GATED',
        owner: gatedAncestor,
        skipped: g.branch,
        skippedFiles: g.files,
        detail:
          `'${gatedAncestor}' took a gate fix this pass and is RED; ${g.branch} descends from it — everything ` +
          `beneath it inherits that. No case was minted for [${g.files.join(', ')}]: it cannot be judged until the ` +
          `ancestor's fix lands, and it may well BE the ancestor's defect seen from below` +
          `${
            gateHeldFiles.get(gatedAncestor)?.size
              ? ` (its fix covers ${[...gateHeldFiles.get(gatedAncestor)!].join(', ')})`
              : ''
          }.`,
      });
      console.error(`gate-fix: ${g.branch} descends from gate-held '${gatedAncestor}' — not minting beneath a red ancestor`);
      continue;
    }
    // ACTIVE GATE (cross-pass): this branch already has a gate fix on origin
    // awaiting the owner. Minting a second one would hand the agent a case whose
    // fix is already written and under review. Skip the BRANCH and report it —
    // `next-case` has nothing to serve here until the PR merges.
    //
    // WHETHER IT IS THE SAME DEFECT IS A SEPARATE QUESTION, and the ref name
    // answers it: every gate-fix case id ends in a digest of its FAILING FILE
    // SET, so `fix/sweep/<branch>--gate-fix-<branch>-<digest>` says which defect
    // is under review. Reporting every glob match as "the fix is written and
    // awaiting the owner" is false for a SECOND, unrelated
    // defect on the same branch — no fix for it exists anywhere —
    // and the owner merges the open PR expecting green, reds again on the other
    // defect, and pays one round-trip per defect on a message the driver has the
    // digest to falsify.
    //
    // The skip itself stays: the branch really is blocked, and a case minted
    // here could never be served (`next-case` skips gated branches), so it would
    // sit in `openCases` and block `finish` with ERR34. What changes is that the
    // report says which defect is covered and which is not.
    const gateRef = await activeGateFixRef(cli.repo, g.branch);
    if (gateRef) {
      const sameDefect = gateRef.endsWith(`--${gateFixCaseId(g.branch, g.files)}`);
      gated.push(g.branch);
      // Same field names as the ancestor skip above: one action, one shape, so
      // no reader has to work out which kind of skip it is holding before it can
      // tell which branch is which. Here the skipped branch is its OWN owner —
      // the gate is on itself — and `ref` names the open fix.
      appendJournal(dir, {
        action: 'gate-fix-skipped',
        owner: g.branch,
        skipped: g.branch,
        ref: gateRef,
        skippedFiles: g.files,
        sameDefect,
        ...(sameDefect
          ? {}
          : {
              id: 'WARN19_GATE_COVERS_OTHER_DEFECT',
              detail:
                `${g.branch} is gated by '${gateRef}', which is a fix for a DIFFERENT failing file set — it does ` +
                `NOT cover [${g.files.join(', ')}]. Merging it will not turn this branch green; a second gate fix ` +
                `is needed once it lands. No case was minted: a gated branch cannot be served this pass.`,
            }),
      });
      console.error(
        sameDefect
          ? `gate-fix: ${g.branch} already has an ACTIVE gate '${gateRef}' for these files — not minting a second case`
          : `gate-fix: ${g.branch} is gated by '${gateRef}', which does NOT cover [${g.files.join(', ')}] — skipped, and the fix for these files is NOT yet written`,
      );
      continue;
    }
    const key = gateFixKey(g.branch, g.files);
    if (journal.some((e) => e.action === 'gate-fix' && e.key === key)) {
      looping.push(g.branch);
      continue;
    }
    // N5 SHAPE: the gate-fix id form (`gateFixCaseId` — branch + file-set digest,
    // never a height). The id is joined into paths AND passed to `publish --case`.
    const caseId = gateFixCaseId(g.branch, g.files);
    // The ROOT of the fix: the branch tip by default, or an explicit older
    // commit when the caller has evidence the failure lives further down.
    const tip = opts.rootAt ? await revParse(cli.repo, opts.rootAt) : await revParse(cli.repo, g.branch);
    // The head's HEIGHT (see `gateFixHeadHeight`): the tip's coverage on this
    // pass's pinned chain — never a `-1` placeholder.
    const head = { sha: tip, height: await gateFixHeadHeight(cli, chain, tip) };
    // MEASURE THE BRANCH BEFORE ACCUSING IT, where the caller could not.
    //
    // Attribution reads a log that names the file which REPORTED the failure —
    // not necessarily the one that caused it — so on its own it can hand a case
    // to the innocent author of a reporting file. It is an upper bound on where
    // blame may go (which is why the journal check below waives the branch match:
    // attribution IS the ceiling on this path), never evidence that this branch
    // is red. So a group whose commands the pass has not already confirmed here
    // is MEASURED at the commit the case would be rooted on, and what comes back
    // decides. Paid after the cheap skips above, so nothing is measured for a
    // group that was never going to mint.
    if (opts.confirmAtRoot) {
      const already = await redObservationUsable(readJournal(dir), cli.repo, g.branch, tip, failedCommands, {
        attributedCeiling: true,
      });
      if (!already.usable) {
        const verdict = await opts.confirmAtRoot(g.branch, tip, failedCommands);
        const subtrees = (await checkVerdictKeys(cli.repo, tip, failedCommands).catch(() => [])).map((v) => ({
          cmd: v.cmd,
          ...(v.cwd ? { cwd: v.cwd } : {}),
          subtree: v.subtree,
        }));
        if (verdict === 'green') {
          // GREEN AT ITS OWN TIP MEANS THE RED IS NOT THIS BRANCH'S. The failure
          // exists only in the integration of several branches, and there is a
          // mechanism for that shape already; a case here would ask an agent to
          // fix a branch that passes.
          const detail =
            `${g.branch} is green at its own tip — the red is integration-only; the leave-one-out rollback ` +
            `owns that shape`;
          droppedGreen.push({ branch: g.branch, detail });
          appendJournal(dir, {
            action: 'gate-fix-skipped',
            owner: g.branch,
            skipped: g.branch,
            skippedFiles: g.files,
            at: tip,
            subtrees,
            detail,
          });
          console.error(`gate-fix: ${detail}`);
          continue;
        }
        if (verdict !== 'red') {
          // NOT RED AND NOT GREEN. An UNSTABLE tip established nothing in either
          // direction; a tip that could not be measured yielded no second
          // observation at all. Neither may found a case, and the two are
          // different findings, so they travel under different ids.
          const id = verdict === 'unstable' ? 'WARN21_CHECKS_FLAKY' : 'WARN22_RED_UNCONFIRMED';
          const detail =
            verdict === 'unstable'
              ? `${g.branch} is UNSTABLE at its own tip ${tip.slice(0, 12)} on ${commandNames.join(', ')} — red ` +
                `once and green once with nothing changed between, so the failure belongs to no branch`
              : `${g.branch} could not be measured at its own tip ${tip.slice(0, 12)} — no second observation`;
          unconfirmed.push({ branch: g.branch, detail });
          appendJournal(dir, {
            action: 'gate-fix-refused',
            id,
            branch: g.branch,
            at: tip,
            files: g.files,
            subtrees,
            commands: commandNames,
            reason: detail,
          });
          console.error(`gate-fix [${id}]: ${detail}`);
          continue;
        }
      }
    }
    // NO ENVIRONMENT, NO CASE. A gate fix exists to turn a failing check green;
    // minted into a tree whose dependencies would not install, its gate can
    // never answer, and it would sit in `openCases` blocking `finish`.
    const gateFixPrep = await createGateFixWorktree(cli, dir, caseId, tip);
    if (gateFixPrep.environment) {
      envBlocked.push(g.branch);
      appendJournal(dir, {
        action: 'gate-fix-skipped',
        id: ERR_ENVIRONMENT_UNUSABLE,
        owner: g.branch,
        skipped: g.branch,
        skippedFiles: g.files,
        install: gateFixPrep.environment,
        detail:
          `dependencies would not install into the fix worktree for ${g.branch} at ${tip.slice(0, 12)}, from its ` +
          `own committed manifests — no case was minted, because its checks gate could never answer: ` +
          `\`${gateFixPrep.environment.command}\` failed with: ${gateFixPrep.environment.output.slice(-400)}`,
      });
      console.error(`gate-fix [${ERR_ENVIRONMENT_UNUSABLE}]: ${g.branch} fix worktree has no dependencies — not minting`);
      continue;
    }
    const caseFile: CaseFile = {
      schemaVersion: 1,
      id: caseId,
      branch: g.branch,
      head,
      // `run[run.length - 1] === head` is the run invariant (types.ts). A gate fix
      // stacks nothing, so its run is the head alone — NOT the empty array, which
      // breaks the invariant and prints "0 height(s)" into the case materials.
      run: [head],
      parent: GATE_FIX_PARENT,
      tierFloor: 'judged',
      conflictedPaths: g.files,
      automergeTree: await treeOf(cli.repo, tip),
      reproduction: { command: commandNames.join(' && ') },
      // firstConflictHeight is documented as "the run's TOP height" — that is
      // `head.height`, whatever kind of case this is. (Nothing reads a gate fix's
      // DEFERRED inputs: it has no transitive ancestors to defer against.)
      deferredCheck: { firstConflictHeight: head.height, transitiveAncestors: [] },
    };
    mkdirSync(join(dir, caseId), { recursive: true });
    writeFileSync(join(dir, caseId, 'case.json'), JSON.stringify(caseFile, null, 2) + '\n');
    appendJournal(dir, {
      action: 'gate-fix',
      key,
      caseId,
      branch: g.branch,
      files: g.files,
      failedCommands: commandNames,
      reason: g.reason,
      // The ROOT the case's worktree was created at. Journaled because
      // `reverifyGateFixCase` re-derives the case from THIS row (never from the
      // agent-writable case.json) — without it, re-verification recomputes the
      // tree from the branch TIP while the worktree sits at an older root, and
      // the scope guard then sees every commit in between as an agent edit and
      // demotes an in-scope fix to HELD for "scope exceeded".
      rootAt: tip,
      // Git evidence, not declarations: `<branch>@<depth>/<own commits>`.
      candidates: a.candidates.map((c) => `${c.branch}@${c.depth}/${c.commits}`),
    });
    appendJournal(dir, {
      action: 'case',
      caseId,
      branch: g.branch,
      parent: GATE_FIX_PARENT,
      gateFix: true,
      head,
      height: head.height,
      run: caseFile.run,
      conflictedPaths: g.files,
      // On the `case` row because `gateFixCaseMaterials` is handed THAT row —
      // a flag written only to the `gate-fix` row never reaches the agent.
      ...(opts.fullSuiteOnly ? { fullSuiteOnly: true } : {}),
    });
    writeFileSync(join(dir, caseId, 'gate-fix-output.txt'), failedOutput);
    cases.push({ caseId, branch: g.branch, files: g.files, reason: g.reason });
  }
  if (cases.length === 0) {
    // Two distinct reasons nothing was minted, and they mean opposite things to
    // the agent. GATED: the fix already exists and is waiting on the OWNER —
    // there is nothing for the agent to do and nothing is wrong. LOOPING: a fix
    // was attempted THIS pass and the build is still red — that is a dead end.
    if (gated.length > 0) {
      const who = gated.join(', ');
      return {
        ...none,
        gated,
        reason: `${who} already has an OPEN gate-fix PR — the fix is written and awaiting the owner`,
        detail: `verify RED, but every blamed branch (${who}) already has a gate fix on origin awaiting the owner — nothing to serve`,
      };
    }
    // A THIRD reason, and it means neither of the other two: the build is red
    // and the branch that owns it cannot even be given an environment. Nothing
    // is wrong with the branch and nothing more is worth attempting here.
    if (envBlocked.length > 0) {
      const who = envBlocked.join(', ');
      return {
        ...none,
        reason: `dependencies would not install for ${who} — no fix case can be checked, so none was minted`,
        detail: `verify RED, but ${who} has no working environment: the machine has to be fixed before any fix can be judged`,
      };
    }
    // A FOURTH AND A FIFTH, from the mint's own measurement: every blamed branch
    // was GREEN where the case would have been rooted (so the red belongs to the
    // integration, not to any one of them), or none of them could be measured
    // there at all. Both mean "no case, and here is what the driver observed" —
    // they travel out through the same doors as the reasons above, because what
    // the caller does next is the same in every one of them.
    if (droppedGreen.length > 0 || unconfirmed.length > 0) {
      const why = [...droppedGreen, ...unconfirmed].map((d) => d.detail).join('; ');
      return { ...none, reason: why, detail: `verify RED, but ${why}` };
    }
    const who = looping.join(', ');
    return {
      ...none,
      reason: `a gate fix was already attempted for ${who} over these files and the build is still red`,
      detail: `verify RED again after a gate fix on ${who} — not re-serving`,
    };
  }
  const reason =
    cases.length === 1
      ? cases[0].reason
      : `${cases.length} gate-fix cases prepared (shallowest first): ${cases.map((c) => `${c.branch} [${c.files.join(', ')}]`).join('; ')} — ${a.reason}`;
  return {
    served: true,
    cases,
    reason,
    detail: `verify RED (no clean attribution) — ${reason}`,
    gated,
  };
}

/**
 * A gate-fix worktree: the branch tip, CLEAN. No clean-prefix commit, no pending
 * conflict blobs — there is no merge here. The dep links + per-worktree excludes
 * are installed exactly as for a conflict case so the checks gate can run.
 *
 * The tip is committed, so its manifests are valid: an install failure here is
 * the machine, and the caller must not mint a case into a tree where the only
 * thing the case exists to do — turn a failing check green — cannot be measured.
 */
async function createGateFixWorktree(cli: Cli, dir: string, caseId: string, tip: string): Promise<WorktreePrep> {
  const wtPath = caseWorktreePath(dir, caseId);
  await git(cli.repo, ['worktree', 'remove', '--force', wtPath], { allowCodes: [1, 128] });
  await git(cli.repo, ['worktree', 'prune'], { allowCodes: [1, 128] });
  rmSync(wtPath, { recursive: true, force: true });
  await git(cli.repo, ['worktree', 'add', '--detach', wtPath, tip]);
  const install = await installDeps(cli, wtPath);
  if (!install.ok) return { ok: false, environment: install.failure };
  return { ok: true, environment: null };
}

/** One related PR in a finished pass's owner-facing summary. */
interface PassPrSummary {
  number: number;
  url: string;
  title: string | null;
  status: string;
  kind: string;
}

/**
 * EVERY PR this pass touched, journal-derived: the open
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
    token = resolveGithubToken(cli);
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

export async function cmdSweepFinish(
  cli: Cli,
  makeTransport?: (token: string) => GithubTransport,
  /**
   * How the mint measures a blamed branch at its own tip. Injected so a pass
   * under test spawns no suite; the default takes the measurement for real, in a
   * fresh worktree installed from that tree's own manifests.
   */
  confirmAtRoot?: RootConfirmer,
): Promise<number> {
  const ctx = await attachPass(cli);
  const dir = ctx.dir;
  const confirmRoot: RootConfirmer =
    confirmAtRoot ??
    ((branch, sha, commands) =>
      confirmRedAt(cli, dir, branch, sha, commands, defaultChecksRunner, undefined, 'finish'));
  let st = readMachineState(dir);
  /**
   * EVERY EXIT FROM FINISH REPORTS THE PROPOSALS THE PASS CLOSED. Deleting a
   * ref closes its pull request and discards the resolution on it, and the next
   * pass wipes the journal that recorded it — so a drop the report skips is a
   * closed PR carrying an agent's work that nobody is ever told about. It rides
   * out through whichever door the pass leaves by, cue included.
   */
  const finishResult = (artifact: Record<string, unknown>): void => {
    const journalNow = readJournal(dir);
    const dropped = droppedProposalRows(journalNow);
    const undecided = undecidedProposalRows(journalNow);
    if (dropped.length === 0 && undecided.length === 0) {
      result(cli, artifact);
      return;
    }
    const cue =
      (dropped.length
        ? ` The sweep CLOSED ${dropped.length} pull request(s) whose proposal no longer applies: ` +
          `${dropped.map((d) => `#${d.number} (${d.branch}: ${d.reason})`).join('; ')} — report them, they are gone from the owner's list otherwise.`
        : '') +
      (undecided.length
        ? ` ${undecided.length} pull request(s) could not be judged and were left untouched: ` +
          `${undecided.map((u) => `#${u.number} (${u.branch}: ${u.detail})`).join('; ')} — report the unstable check, do not re-run hoping for a verdict.`
        : '');
    result(cli, {
      ...artifact,
      ...(dropped.length ? { droppedProposals: dropped } : {}),
      ...(undecided.length ? { undecidedProposals: undecided } : {}),
      ...(typeof artifact.instruction === 'string' ? { instruction: artifact.instruction + cue } : {}),
    });
  };
  const checksFile = applyPassConfig(cli, st);
  // The finish verify gate runs the checks from the pass's pinned
  // checks-file on the publishable set; a persisted checks-file wins over any
  // --commands-file. When it is absent the gate is skipped (cli.commands
  // undefined → cmdVerify falls back to --commands-file / VERIFY_COMMANDS).
  //
  // TYPECHECK FIRST, then tests. Running `test` only would let
  // a type error surface indirectly (a suite failing to import) or not at all,
  // with no compiler diagnostics in the verify log — leaving `attributeFailure`
  // nothing to parse and every unattributable red falling back to the branch
  // verify accused. Typecheck output is what makes blame possible, and it is the
  // cheap check besides.
  //
  // An unparseable checks file would silently empty that list and finish would
  // publish on a verify that ran nothing. Halt instead — this is the last gate
  // before anything reaches origin.
  const badChecks = malformedChecksIssue(checksFile);
  if (badChecks) {
    appendJournal(dir, { action: 'warning', id: badChecks.id, message: badChecks.detail });
    console.error(`finish [${badChecks.id}]: ${badChecks.detail}`);
    finishResult({ ok: false, issues: [badChecks], halted: 'verify', instruction: badChecks.detail });
    return 1;
  }
  const finishChecks = loadChecksConfig(checksFile);
  const finishTestCommands = finishChecks ? [...finishChecks.typecheck, ...finishChecks.test] : undefined;
  if (!st) {
    console.error('finish: no machine state — run `sweep start` first');
    return 2;
  }
  if (st.phase === 'awaiting-pr' || openCases(readJournal(dir)).length > 0) {
    // Say WHY cases reappeared when a judged gate fix reopened the
    // DAG — otherwise "cases remain" right after a finish reads like a driver
    // bug, and the agent is liable to report it as one instead of looping.
    const gfResolved = readJournal(dir).find((e) => e.action === 'resolved' && e.gateFix === true);
    const detail = gfResolved
      ? `cases remain — the gate fix on ${String(gfResolved.branch)} advanced that branch, so its descendants were ` +
        `reopened to pull the fix through. This is expected: run \`next-case\` and work them, then finish again.`
      : 'cases remain — resolve every case (next-case/report-case/report-pr) before finish';
    console.error(`finish [ERR34_CASES_REMAIN]: ${detail}`);
    finishResult({ ok: false, issues: [{ id: 'ERR34_CASES_REMAIN', detail }] });
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
      // A gate fix is never a JUDGED history PR — see below.
      return d?.action === 'resolved' && d.tier === 'judged' && d.gateFix !== true && unpublished(jc);
    });
    const held = [...journaledCases(journal).values()].filter(
      (jc) => lastDisposition(journal, jc.caseId)?.action === 'held' && unpublished(jc),
    );
    finishResult({
      dryRun: true,
      verifyGreen: canComplete(journal),
      judgedToPublish: judged.map((j) => j.caseId),
      heldToPublish: held.map((j) => j.caseId),
    });
    return 0;
  }

  // (1) verify the publishable set (full rebuild, §9). A red verify either
  // fails attribution (verifyRc != 0) or rolls a publishable offender back to
  // HELD(gate) — both HALT finish (report + resumable): re-running finish drops
  // the now-frozen offender from the publishable recipe and proceeds. Pushes
  // never redo; the rollback is not repeated (the offender is already frozen).
  // THE BASE MAY ALREADY BE UNDER REPAIR. A gate fix on the base is an OPEN,
  // unmerged HELD PR — the defect is still there by definition — so rebuilding
  // on it and running the matrix is guaranteed red, and every red then gets
  // attributed to a recipe branch — innocent branches rolled back and frozen,
  // one per finish run, for a
  // base defect that already has a gate fix waiting for the owner.
  //
  // `activeGateFixRefs` is how `next-case` skips a gated branch; finish
  // must ask it too. Verification cannot mean anything until the base is fixed,
  // so don't pretend it can: publish the held work and report the blocker.
  const verifyBase = await verifyBaseRef(cli);
  const gatedRefs = await activeGateFixRefs(cli.repo);
  const baseGate = gatedRefs.find((r) => r.startsWith(`fix/sweep/${slug(verifyBase)}--gate-fix-`));
  if (baseGate) {
    const { escalated, total } = await escalateHeldCases(cli, dir, makeTransport, 'finish-base-gated');
    const detail =
      `the base '${verifyBase}' has an OPEN gate-fix PR (${baseGate}) — its defect is still present, so a full ` +
      `verify would be red no matter which branches are in the recipe, and any branch it accused would be ` +
      `innocent. Nothing was merged, pushed or rolled back. The owner must merge the base gate fix first.`;
    appendJournal(dir, { action: 'verify-skipped', id: 'WARN18_BASE_GATED', branch: verifyBase, gateRef: baseGate, detail });
    progress(`verify: SKIPPED — base '${verifyBase}' is gated; ${escalated}/${total} held PR(s) published`);
    console.error(`finish: ${detail}`);
    // A pass that merged locally and shipped nothing has to SAY which merges
    // are sitting on local refs; "stopped" alone reads as "nothing happened".
    const gatedWithheld = withheldPushRows(readJournal(dir)).map((w) => ({
      branch: w.branch,
      reason: `the verify base '${verifyBase}' is gated — no verify, no push`,
    }));
    finishResult({
      ok: false,
      status: 'stopped',
      stoppedAt: 'base-gated',
      heldPublished: escalated,
      withheldPushes: gatedWithheld,
      issues: [{ id: 'WARN18_BASE_GATED', detail }],
      instruction:
        `REPORT to the owner: the base '${verifyBase}' is waiting on its own gate-fix PR (${baseGate}); nothing ` +
        `can be verified or landed until that is merged. ${escalated} held PR(s) are published and named above. ` +
        `${gatedWithheld.length ? `Merged locally and NOT pushed: ${gatedWithheld.map((w) => w.branch).join(', ')}. ` : ''}` +
        `Do NOT re-run finish until the owner merges it.`,
    });
    return 1;
  }

  progress('verify: running');
  const gateBefore = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate').length;
  const verifyLenBefore = readJournal(dir).length;
  const verifyRc = await cmdVerify({
    ...cli,
    cmd: 'verify',
    execute: true,
    internal: true,
    ...(finishTestCommands ? { commands: finishTestCommands } : {}),
  });
  const gatesNow = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate');
  const gateAfter = gatesNow.length;
  if (verifyRc !== 0 || gateAfter > gateBefore) {
    // An UNATTRIBUTABLE red where the checks TESTS failed (build clean, no
    // single-branch offender) is a STOP, not a resumable rollback: journal the
    // failed test names and report "publish nothing; report to the owner" —
    // fixing red tests is code work / the owner's call, never a re-run.
    const attrib = readJournal(dir)
      .slice(verifyLenBefore)
      .find((e) => e.action === 'verify' && e.attributionFailed === true && Array.isArray(e.failedCommands));
    const failedTests = attrib ? (attrib.failedCommands as string[]) : [];
    const offender = gateAfter > gateBefore ? (gatesNow[gatesNow.length - 1].branch as string | undefined) : undefined;
    // A gate hold taken on a MERGE CONFLICT in the integration rebuild, and the
    // sentence verify wrote for it. This finish report is what the agent relays,
    // so it must not describe a conflict in the words of a red test suite —
    // "investigate, fix, re-run" sends the agent hunting through a diff for a
    // failure that is a collision between two branches. Matched to THIS run's
    // rollback (same branch, rows written after the verify call) so an earlier
    // conflict cannot narrate a later, different red.
    const conflictRow = readJournal(dir)
      .slice(verifyLenBefore)
      .find(
        (e) =>
          e.action === 'verify' &&
          e.rolledBackFor === 'merge-conflict' &&
          typeof e.detail === 'string' &&
          offender !== undefined &&
          e.rolledBack === offender,
      );
    // The row's `ok` is the RE-VERIFY without the offender. Green means the
    // conflict really was the whole failure; red means the remaining branches
    // fail something else on top of it, and saying "no test failed" over that is
    // simply untrue — the report has to carry both.
    const reverifyStillRed = conflictRow ? conflictRow.ok === false : false;
    const reverifyFailed = Array.isArray(conflictRow?.reverifyFailedCommands)
      ? (conflictRow!.reverifyFailedCommands as string[])
      : [];

    // An UNATTRIBUTABLE red is a build defect nobody in this pass
    // caused — dead-ending it in an ERR18/ERR40 whose message asks a
    // HUMAN to fix something the agent is forbidden to deliver (it may not push
    // or open a PR) goes nowhere. Turn it into a CASE instead, so the fix flows through the
    // machinery that already exists: agent edits → checks gate PROVES it green →
    // cold read → judged (merge in place + re-propagate) or held (fix/sweep ref +
    // PR that blocks the next pass until the owner merges).
    if (verifyRc !== 0) {
      const failedOutput = attributionOutput(attrib ?? null);
      // THE MINT MEASURES WHAT THIS PATH CANNOT. The integration verify attributes
      // a red BUILD by elimination, over a log naming the file that REPORTED the
      // failure — so there is no observation here tying the red to the branch a
      // case would accuse. The mint takes one, per blamed branch, at the commit
      // the case would be rooted on.
      const gate = await materializeGateFixCases(cli, dir, ctx.chain, failedOutput, failedChecksOf(attrib), offender ?? null, {
        confirmAtRoot: confirmRoot,
      });
      if (gate.served) {
        writeMachineState(dir, { ...st, phase: 'open', currentCase: null, finishStep: 'verify' });
        // BATCHED blame: the failing files can belong to several branches, and
        // `gateFix` reports the FIRST — the shallowest, which `next-case` serves
        // first because a judged fix there can moot the ones below it. Every case
        // is listed in `gateFixes` (and journaled) so nothing is invisible.
        const first = gate.cases[0];
        const branches = gate.cases.map((c) => c.branch).join(', ');
        progress(`verify: RED (unattributed) — ${gate.cases.length} gate-fix case(s) prepared on ${branches}`);
        console.error(`finish: gate-fix case${gate.cases.length > 1 ? 's' : ''} prepared on ${branches}`);
        // PROCEED arm — same rule as the base-red arm in `cmdSweepStart`: cases
        // were materialized and the agent is told to run `next-case`, so the id
        // must ADVISE, not BLOCK. `ERR18_VERIFY_PENDING` also still marks the two
        // genuine blocks (an ungated push, and a halted verify below), and an id
        // cannot mean "stop" in one arm and "continue" in another.
        finishResult({
          ok: false,
          status: 'gate-fix-required',
          stoppedAt: 'verify',
          issues: [{ id: 'WARN09_GATE_FIX_SERVED', detail: gate.detail }],
          gateFix: { caseId: first.caseId, branch: first.branch, files: first.files, reason: gate.reason },
          gateFixes: gate.cases.map((c) => ({ caseId: c.caseId, branch: c.branch, files: c.files })),
          instruction: `${gate.cases.length} GATE-FIX case(s) have been prepared (shallowest branch first: ${branches}) — run \`next-case\``,
        });
        return 1;
      }
      // GATED: every blamed branch already has a gate fix on origin awaiting the
      // owner. The build is red and stays red, but nothing is broken and there is
      // nothing for the agent to do — the fix is written and under review. Said
      // plainly here, because the ERR40 fallthrough below would tell the agent
      // "checks failed, publish nothing" and invite it to fix what it already
      // fixed. No ERR id: this is a WAIT, not a fault.
      if (gate.gated.length > 0) {
        const who = gate.gated.join(', ');
        progress(`verify: RED — ${who} gated on an open gate-fix PR; nothing to serve`);
        console.error(`finish: RED but gated — ${who} awaiting the owner`);
        finishResult({
          ok: false,
          status: 'stopped',
          stoppedAt: 'verify',
          gatedBranches: gate.gated,
          instruction:
            `REPORT to the owner: the build is RED and the fix is ALREADY WRITTEN — ${who} has an open gate-fix PR ` +
            `waiting to be merged. Nothing can land until it is. Do NOT re-fix it and do NOT open another PR; ` +
            `re-run \`start\` after the owner merges.`,
        });
        return 1;
      }
      // Not servable (already attempted for these files, or nothing to blame):
      // fall through to the STOP so a bad fix cannot cycle forever.
      if (failedTests.length > 0) {
        appendJournal(dir, { action: 'finish-tests-failed', failed: failedTests });
        // PUBLISH THE HELD ESCALATIONS ANYWAY — the red is very often the thing
        // they are ABOUT.
        //
        // The catch-22 this forecloses: a gate fix is served, the agent
        // correctly finds the fix lives OUTSIDE the case's named files and
        // claims `--tier held` exactly as doctrine says. Held means NOT merged,
        // so the failure persists, so `finish`'s verify stays RED — and an arm
        // that publishes NOTHING on red swallows the held PR that was the
        // entire escalation: the sweep suppresses its own request for help and
        // reports "nothing published" while holding the small diff that would
        // fix it.
        //
        // Publishing held cases here is safe: a held publish pushes a
        // `fix/sweep/*` ref and opens a REVIEW PR the owner merges. It never
        // pushes a target branch — that is phase (3), which this arm still
        // refuses. So the red gate keeps doing its job (nothing lands) while the
        // escalation actually reaches a human.
        const { escalated, total: heldTotal } = await escalateHeldCases(cli, dir, makeTransport, 'finish-tests-red');
        const heldPending = { length: heldTotal };
        progress(
          `verify: RED — ${failedTests.join(', ')} — no branch lands; ${escalated}/${heldPending.length} held PR(s) published for the owner`,
        );
        console.error(`finish: ${failedTests.join(', ')} failed; ${gate.reason}; ${escalated} held PR(s) escalated, no targets pushed`);
        finishResult({
          ok: false,
          status: 'stopped',
          stoppedAt: 'finish-tests',
          failedTests,
          heldPublished: escalated,
          issues: [{ id: 'ERR40_TESTS_FAILED', detail: `checks failed at finish — ${failedTests.join(', ')}` }],
          instruction:
            `REPORT to the owner: checks failed at finish — ${failedTests.join(', ')}; ${gate.reason}. NOTHING was ` +
            `merged or pushed to any branch. ${escalated} held review PR(s) WERE published — the fix is written and ` +
            `waiting for the owner to merge; name them and stop.`,
        });
        return 1;
      }
    }
    // THE HELD WORK LEAVES BY THIS DOOR TOO. There are two red exits from
    // finish: the attributed one above (ERR40) and this halt, and BOTH must
    // publish their held cases — a pass that leaves through
    // `verify RED (no clean attribution)` must not drop every held PR. A held
    // case is the
    // owner's to decide either way; which red path the pass took is the driver's
    // bookkeeping, not a reason to throw the agent's work away.
    const { escalated: haltEscalated, total: haltHeld } = await escalateHeldCases(
      cli,
      dir,
      makeTransport,
      'finish-verify-halt',
    );
    const detail =
      (conflictRow
        ? `${conflictRow.detail as string}. It was rolled back and HELD(gate) — a MERGE CONFLICT in the ` +
          `integration rebuild, not a failing check; the conflict itself is the owner's to place. ` +
          (reverifyStillRed
            ? `A SECOND, separate failure remains: without the offender the rebuild is STILL RED — ` +
              `${reverifyFailed.join(', ') || 'no command named'} failed, which the conflict did not cause. ` +
              `Report both; re-running \`finish\` will not clear the red one.`
            : `Nothing else failed: no command ran on the conflicting build, and the re-verify without the ` +
              `offender is green. Re-run \`finish\` (the frozen offender drops out of the publishable set).`)
        : verifyRc !== 0
          ? 'verify RED (no clean attribution) — investigate, fix, then re-run `finish` from the verify phase'
          : 'verify RED — offender rolled back + HELD(gate); re-run `finish` (the frozen offender drops out of the publishable set)') +
      (haltHeld > 0 ? ` — ${haltEscalated}/${haltHeld} held PR(s) published for the owner` : '');
    progress(
      conflictRow
        ? `verify: MERGE CONFLICT ${offender} — rolled back`
        : `verify: RED ${offender ?? '(unattributed)'} — rolled back`,
    );
    console.error(`finish: ${detail}`);
    finishResult({
      ok: false,
      issues: [{ id: 'ERR18_VERIFY_PENDING', detail }],
      halted: 'verify',
      // The report is assembled from THIS object, so what the failure WAS has to
      // be in it — a reader that only sees `halted: "verify"` writes "the tests
      // failed" over a conflict.
      ...(conflictRow
        ? {
            failureKind: 'merge-conflict',
            offender,
            unresolved: Array.isArray(conflictRow.unresolved) ? conflictRow.unresolved : [],
            // A second failure the conflict did not cause, if there is one. The
            // report is assembled from this object, so a red that survives the
            // rollback has to be IN it or it is not reported at all.
            reverify: { ok: !reverifyStillRed, ...(reverifyStillRed ? { failedCommands: reverifyFailed } : {}) },
          }
        : {}),
      heldPublished: haltEscalated,
    });
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
      // EXCLUDE gate fixes. The JUDGED history PR is auto-flipped to
      // merged by the target push landing the SAME merge commit — machinery for a
      // propagation merge. A gate fix is a single-parent commit with no conflict
      // head, so cmdPublish cannot build it and finish would halt at `judged-prs`.
      // Selection is by DISPOSITION, so dropping its pr-intent is not enough.
      return d?.action === 'resolved' && d.tier === 'judged' && d.gateFix !== true;
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
        finishResult({ ok: false, halted: 'judged-prs', caseId: jc.caseId });
        return 1;
      }
      closuresN++;
    }
    progress(`push: judged closures (${closuresN})`);
  }
  writeMachineState(dir, { ...st, finishStep: 'push' });

  // (3) push target branches (flips JUDGED PRs to merged) + closure checks +
  // urges. PUSH RESILIENCE: per-branch failures (`push-failed`
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
    finishResult({ ok: false, halted: 'push' });
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

  // SYSTEMIC OUTAGE short-circuit: when EVERY push
  // this run failed `transient` and nothing landed, the network itself is
  // down — attempting every held publish (each of which starts with a `git
  // push` of its fix ref) over the same dead transport would just burn a
  // timeout per case for identical failures. Bail to the partial report; the
  // held cases have no `pr-published` rows and retry on the next finish.
  const systemicOutage =
    pushFailures.length > 0 &&
    !pushDelta.some((e) => e.action === 'push') &&
    pushFailures.every((f) => f.category === 'transient');

  // (4) create the HELD PRs (the ONE publish phase for held cases —
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
      // Cross-tier duplicate: a held case whose conflict signature
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
        // PUSH RESILIENCE: a failed held publish (e.g. its base
        // push failed → ERR14, or a transient API error) does not halt the
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

  // PUSH RESILIENCE: with per-branch failures the pass is NOT
  // sealed — the machine state stays `finishing` so a re-run finish retries
  // exactly the failed pushes/publishes (landed branches skip as up-to-date;
  // verify re-gates). Only a fully-landed finish completes the pass.
  // A CASE THE ENVIRONMENT MADE UNJUDGEABLE IS A FAILED PASS, not a complete
  // one. It reached no verdict and its branch is blocked, so sealing the pass
  // `complete` would say the sweep finished what it started.
  const envBlockedCases = readJournal(dir).filter((e) => e.action === 'env-blocked');
  const anyFailures = pushFailures.length > 0 || publishFailures.length > 0 || envBlockedCases.length > 0;
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

  // Owner-facing pass summary on the ONE SWEEP-RESULT (success or
  // partial): every related PR (found-open at start / reopened /
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
  // WHAT THE BUILD COVERED, WHAT LANDED WITHOUT ONE, AND WHAT DID NOT LAND.
  // A partial integration build is a valid pass — `ok` stays true — and what
  // makes it valid is that the result SAYS so: which branches were built, which
  // were left out and why, which reached origin from outside the build, and
  // which merged locally and went nowhere. A pass that ships a cut prefix and
  // reports it in a log line only is indistinguishable from a healthy one.
  const coverage = passCoverage(cli, dir, journalFinal);
  const pushedUnbuilt = journalFinal
    .filter((e) => e.action === 'push' && e.kind === 'target' && typeof e.branch === 'string')
    .map((e) => e.branch as string)
    .filter((b, i, all) => all.indexOf(b) === i && !coverage.built.includes(b));
  const withheldPushes = withheldPushRows(journalFinal);
  // FAILURES THE PASS PROVED AND COVERED WITH NOTHING. An adjudication that
  // partitions a pre-existing red can leave files no branch owns; no case is
  // minted for them and they are still red when the pass ends. The mid-pass
  // result that named them is gone, and the report is assembled from THIS
  // object, so a remainder missing here is a remainder recalled from memory.
  const uncoveredRemaindersNow = uncoveredRemainders(journalFinal, journaledCases(journalFinal));
  // REDS THIS PASS PROVED AND COULD HAND TO NOBODY. Journaled wherever the
  // refusal was taken and, until now, read nowhere: a failure that blocked a
  // branch, minted no case and opened no PR left the pass without a trace in the
  // one object the agent's report is assembled from.
  const unmintableRedsNow = unmintableReds(journalFinal);
  const resolvedRows = journalFinal.filter((e) => e.action === 'resolved');
  const publishedRows = journalFinal.filter((e) => e.action === 'pr-published');
  const failedByCategory = { diverged: 0, transient: 0, auth: 0, rejected: 0 };
  for (const f of pushFailures) {
    failedByCategory[(f.category as keyof typeof failedByCategory) ?? 'transient'] =
      (failedByCategory[(f.category as keyof typeof failedByCategory) ?? 'transient'] ?? 0) + 1;
  }
  // Owner-action-required failures (diverged / hook-rejected) and
  // blocking non-push issues (ERR16/ERR17/token/API) from THIS run's push
  // phase — surfaced as their own SWEEP-RESULT fields, not merely categories,
  // so an autonomous re-run loop can stop re-trying what only the owner can fix.
  const needsOwner = [
    ...pushDelta
      .filter((e) => e.action === 'push-escalated')
      .map((e) => ({
        branch: String(e.branch),
        category: String(e.category ?? 'diverged'),
        detail: String(e.detail ?? ''),
      })),
    // A broken machine is exactly this list's subject: only the owner can fix
    // it, and re-running finish will not. Naming it here rather than letting
    // the pass end on a bare ERR34 is the difference between "the owner has to
    // repair the environment" and "cases remain, try again".
    ...envBlockedCases.map((e) => ({
      branch: String(e.branch),
      category: 'environment',
      detail: String(e.detail ?? ''),
    })),
    // A RED NO BRANCH COULD BE HANDED is this list's subject too: nothing the
    // driver can do reaches it, re-running finish will not change it, and the
    // only thing left is to tell the owner. Reported here, it survives the pass;
    // reported only mid-pass, it is recalled from memory or not at all.
    ...unmintableRedsNow.map((u) => ({
      branch: u.branch,
      category: 'unmintable-red',
      ...(u.id ? { id: u.id } : {}),
      detail: `${u.files.length ? `${u.files.join(', ')}: ` : ''}${u.detail}`,
    })),
  ];
  const pushBlockingIssues = pushDelta
    .filter((e) => e.action === 'push-issue')
    .map((e) => ({ id: String(e.id), detail: String(e.detail) }));
  // OWNER-SHAPED PULL REQUESTS THAT NO LONGER MERGE OR NO LONGER PASS. The
  // driver will not touch these — force-pushing over someone else's commits is
  // the one destructive act available to it — so it says so instead, EVERY
  // pass. The one-time draft conversion is a courtesy on the transition; this
  // list is the notification, and it is the only thing that keeps a degraded PR
  // visible once the courtesy has been spent.
  const ownerPrs = journalFinal
    .filter((e) => e.action === 'owner-pr-degraded')
    .map((e) => ({
      branch: String(e.branch),
      ref: String(e.ref),
      number: typeof e.prNumber === 'number' ? e.prNumber : 0,
      url: String(e.prUrl ?? ''),
      mergeable: e.mergeable === true,
      checksGreen: e.checksGreen === true,
      reason: String(e.reason ?? ''),
    }));
  const ownerPrCue = ownerPrs.length
    ? ` PRs you changed that no longer merge or no longer pass: fix or close — ${ownerPrs.map((p) => `#${p.number} (${p.branch}: ${p.reason})`).join('; ')}.`
    : '';
  // The partial-build cue. A pass that built a slice of the fork and pushed
  // beyond it says both, in one sentence, or the owner reads "complete" and
  // assumes everything was verified together.
  const coverageCue =
    coverage.excluded.length || pushedUnbuilt.length || withheldPushes.length
      ? ` PARTIAL BUILD: the integration verify covered ${coverage.built.join(', ') || 'nothing'}` +
        `${coverage.excluded.length ? ` and left out ${coverage.excluded.map((x) => `${x.branch} (${x.reason}${x.via ? `: ${x.via}` : ''})`).join('; ')}` : ''}.` +
        `${pushedUnbuilt.length ? ` Pushed with no build behind it: ${pushedUnbuilt.join(', ')}.` : ''}` +
        `${withheldPushes.length ? ` Merged locally and NOT pushed: ${withheldPushes.map((w) => `${w.branch} (${w.reason})`).join('; ')}.` : ''}`
      : '';
  // The remainder cue. Without it the agent reports the pass as though every
  // failure it saw ended in a case, and the files nobody owns go unmentioned.
  const uncoveredCue = uncoveredRemaindersNow.length
    ? ` STILL RED, NO CASE: ${uncoveredRemaindersNow
        .map(
          (u) =>
            `${u.files.join(', ')} (${u.reason}, from ${u.caseId} merging ${u.parent} into ${u.branch}) — ${u.detail}`,
        )
        .join('; ')}. Report these to the owner exactly as written; nothing this pass fixes them.`
    : '';
  // The refusal cue. A red nobody can be handed is the pass's least reportable
  // finding — no case, no PR, no branch to name — so it is the one most easily
  // dropped from the report, and the owner is the only one who can act on it.
  const unmintableCue = unmintableRedsNow.length
    ? ` RED, NO BRANCH TO FIX IT: ${unmintableRedsNow
        .map((u) => `${u.branch}${u.files.length ? ` [${u.files.join(', ')}]` : ''}${u.id ? ` (${u.id})` : ''} — ${u.detail}`)
        .join('; ')}. Report these to the owner exactly as written; nothing this pass fixes them.`
    : '';
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
    finishResult({
      ok: false,
      status: 'partial',
      next,
      upstreamAdvanced,
      pullRequests: annotated,
      branches,
      failedPushes: pushFailures,
      failedPublishes: publishFailures,
      // Needs-owner failures are a FIRST-CLASS field — a re-run
      // loop must stop re-trying these branches and hand them to the owner.
      needsOwner,
      ...(ownerPrs.length ? { ownerPullRequests: ownerPrs } : {}),
      blockingIssues: pushBlockingIssues,
      ...(systemicOutage ? { systemicOutage: true, heldPublishesSkipped } : {}),
      coverage,
      pushedUnbuilt,
      withheldPushes,
      uncoveredRemainders: uncoveredRemaindersNow,
      unmintableReds: unmintableRedsNow,
      stats,
      instruction:
        `REPORT to the owner FACTUALLY: which branches LANDED (${branches.filter((b) => b.landed).map((b) => b.branch).join(', ') || 'none'}) ` +
        `and which FAILED with their categories (${pushFailures.map((f) => `${f.branch}: ${f.category}`).join('; ') || 'none'}${publishFailures.length ? `; held publishes: ${publishFailures.map((p) => p.caseId).join(', ')}` : ''}), ` +
        `plus every PR in pullRequests (number, title, status) and the stats.` +
        `${pushBlockingIssues.length ? ` Blocking push-phase issues: ${pushBlockingIssues.map((i) => i.id).join(', ')}.` : ''} ` +
        `${needsOwner.length ? `OWNER ACTION REQUIRED (do NOT just re-run for these): ${needsOwner.map((n) => `${n.branch} (${n.category})`).join('; ')} — never force-resolve. ` : 'DIVERGED branches need the owner (never force-resolve); '}` +
        `${systemicOutage ? `Network outage: ${heldPublishesSkipped} held publish(es) were skipped, not attempted. ` : ''}` +
        `${ownerPrCue}${coverageCue}${uncoveredCue}${unmintableCue}` +
        ` then re-run \`finish\` — landed branches skip, transient failures retry.`,
    });
    return 1;
  }
  console.error(`sweep finish complete — ${next}`);
  finishResult({
    ok: true,
    status: 'complete',
    next,
    upstreamAdvanced,
    pullRequests: annotated,
    branches,
    // OWNER-ACTION-REQUIRED SURVIVES A CLEAN FINISH. Every push and publish can
    // succeed and still leave a red no branch can be handed a fix for: the pass
    // did everything available to it, and the one thing left is the owner's.
    // Omitting the list on a complete result would say the opposite.
    ...(needsOwner.length ? { needsOwner } : {}),
    ...(ownerPrs.length ? { ownerPullRequests: ownerPrs } : {}),
    coverage,
    pushedUnbuilt,
    withheldPushes,
    uncoveredRemainders: uncoveredRemaindersNow,
    unmintableReds: unmintableRedsNow,
    stats,
    instruction:
      `REPORT to the owner: every PR in pullRequests (number, title, status), the landed branches (branches list), and the stats summary.` +
      `${ownerPrCue}${coverageCue}${uncoveredCue}${unmintableCue} Then ` +
      (upstreamAdvanced ? 'run `sweep start` again (upstream advanced past the pinned watermark)' : 'stop — the sweep is done'),
  });
  return 0;
}

/**
 * Turn a caught `DriverHalt` into the command's ONE `SWEEP-RESULT` line, and
 * return the exit code.
 *
 * A DriverHalt is an EXPECTED, journaled refusal — a protected or out-of-scope
 * ref, a dirty worktree, a diverged branch, a surprise merge conflict. Every
 * command must route it here: letting it reach the
 * top-level rejection handler prints a raw stack and NO `SWEEP-RESULT`
 * line at all, breaking the two-prefix contract (SWEEP-STEP relays,
 * SWEEP-RESULT is parsed and acted on) and leaving the agent nothing actionable
 * at the exact moment the driver refuses to proceed.
 *
 * No new id is minted. `haltIdFor` supplies the mapped ERR when one exists —
 * `out-of-scope` has none, and inventing an id would need a doctrine row to be
 * actionable — and the raw reason always travels in `halted`. Doctrine already
 * routes "a global halt reported in the output" to a stop-case 2 report, which
 * is exactly what this is.
 */
export function reportDriverHalt(cli: Cli, err: DriverHalt): number {
  const id = haltIdFor(err.reason);
  console.error(`sweep ${cli.cmd} HALT${id ? ` [${id}]` : ''}: ${err.reason} — ${err.message}`);
  result(cli, {
    ok: false,
    status: 'stopped',
    halted: err.reason,
    ...(id ? { issues: [{ id, detail: err.message }] } : {}),
    instruction:
      `REPORT to the owner: the driver HALTED (${err.reason}) — ${err.message}. This is a refusal, not a crash: ` +
      `nothing further ran and no ref was moved. Do NOT retry the command until the owner has resolved it.`,
  });
  return 1;
}

// The state machine (DRIVER.md §1) — the ONLY command surface. The
// deterministic stages (plan/run/publish/push/verify/report) are internal steps
// of these six; they have no standalone entry point.
const HANDLERS: Record<string, (cli: Cli) => Promise<number>> = {
  'sweep-start': (cli) => cmdSweepStart(cli), // real transport unless a test injects one
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
      // A halt is a refusal the agent must REPORT; anything else is a genuine
      // crash and keeps its stack.
      if (err instanceof DriverHalt) process.exit(reportDriverHalt(cli, err));
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      process.exit(1);
    },
  );
}

export { parseCli, guardRef, DriverHalt };
export type { Cli };
