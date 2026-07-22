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
 *   publish --case ID             §14 (D-048/D-049): the ONLY sanctioned PR-creation path —
 *                                 verify the case, run the check battery + pre-PR height check
 *                                 (machine-readable {ok, issues, pr?}), and with --execute push
 *                                 the fix/sweep ref (git push) at the REAL head (HELD: the case
 *                                 run's top; JUDGED: the merge commit) and create the PR via
 *                                 the GitHub API (HELD draft, JUDGED non-draft)        (MUTATES)
 *   push                          §14.4 (D-049): verify-gated pass publication — push target
 *                                 branches (flips JUDGED PRs to merged), closure checks, post
 *                                 urge comments + D-004 machine-block refresh           (MUTATES)
 *   verify                        §9 gate: everything-rebuild + CI commands, leave-one-out
 *                                 attribution; red -> rollback offender + HELD(gate)   (MUTATES)
 *   unfreeze --branch <b>         manually clear a ledger freeze (journaled)           (MUTATES)
 *   status                        human-readable pass state from journal + ledger
 *
 * Flags:
 *   --repo <path>            repo to operate on                (default: cwd)
 *   --workspace <dir>        artifacts root                    (default: cwd)
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
 *   --token-file <path>      publish/push (every networked subcommand, D-049): file holding
 *                            the substitute GitHub token (the agent writes the get_credential
 *                            output there once per session; the credential proxy swaps the
 *                            Authorization header on the wire)
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
 *   agent writes pr/title.txt + pr/body.md from studying the case. `publish` and `push`
 *   are the only subcommands that touch the network (git push + GitHub REST, --execute
 *   only — §14/§14.4, D-049); refs move via git push ONLY, and any push failure is a
 *   hard halt reported to the owner (D-046 case 2), never worked around.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

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
  createPullRequest,
  decidedAlready,
  getOpenPrByHead,
  ghExpect,
  haltIdFor,
  isBlocking,
  parseGithubSlug,
  realGithubTransport,
  renderMachineBlock,
  withMachineBlock,
  type GithubTransport,
  type Issue,
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
 * Current HELD registry from the journal (§5 input): a `held` entry adds a
 * record; a later `resolved` for the same branch clears it (auto-unfreeze of
 * dependents follows on the next plan derivation).
 */
export function heldRegistry(journal: JournalEntry[]): HeldRecord[] {
  const held = new Map<string, HeldRecord>();
  for (const e of journal) {
    if (e.action === 'held' && typeof e.branch === 'string') {
      held.set(e.branch, {
        branch: e.branch,
        height: e.height as number,
        conflictedPaths: (e.conflictedPaths as string[]) ?? [],
        caseId: (e.caseId as string) ?? '',
      });
    } else if (e.action === 'resolved' && typeof e.branch === 'string') {
      held.delete(e.branch);
    }
  }
  return [...held.values()];
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

/** Branches frozen in the group ledger (cross-pass — §8 durable freezes). */
function frozenBranches(cli: Cli): Set<string> {
  const ledger = readLedger(ledgerPathOf(cli));
  return new Set(
    Object.entries(ledger.branches)
      .filter(([, b]) => b.status === 'frozen')
      .map(([name]) => name),
  );
}

function freezeInLedger(
  cli: Cli,
  branch: string,
  frozenBy: string,
  heldHead: string | null,
  heldPaths: string[] | null,
  fixBranch: string | null,
): void {
  const path = ledgerPathOf(cli);
  const ledger = readLedger(path);
  ledger.branches[branch] = {
    ...defaultLedgerBranch(),
    ...ledger.branches[branch],
    status: 'frozen',
    frozenBy,
    heldHead,
    heldPaths,
    fixBranch,
  };
  writeLedger(path, ledger);
}

function unfreezeInLedger(cli: Cli, branch: string): void {
  const path = ledgerPathOf(cli);
  const ledger = readLedger(path);
  if (ledger.branches[branch]) {
    ledger.branches[branch] = {
      ...ledger.branches[branch],
      status: 'active',
      frozenBy: null,
      heldHead: null,
      heldPaths: null,
    };
    writeLedger(path, ledger);
  }
}

/**
 * Cross-pass HELD registry from the ledger (§5, N3): a ledger freeze carries
 * the conflicting head sha (`heldHead`) and its conflicted paths (`heldPaths`),
 * which is enough to rebuild the DEFERRED-matching record in a LATER pass.
 * Heights are pass-relative (the chain's fork point moves as branches absorb
 * upstream), so the height is RE-DERIVED from `heldHead` against THIS pass's
 * pinned chain, never carried numerically. Entries without head/paths (gate
 * holds from §9, pre-upgrade ledgers) or whose head fell below the chain
 * cannot be matched and degrade to an ordinary case for descendants — the safe
 * direction (extra review, never less).
 */
async function ledgerHeldRecords(cli: Cli, chain: Chain): Promise<HeldRecord[]> {
  const ledger = readLedger(ledgerPathOf(cli));
  const out: HeldRecord[] = [];
  for (const [branch, b] of Object.entries(ledger.branches)) {
    if (b.status !== 'frozen' || !b.heldHead || !b.heldPaths?.length) continue;
    if (!(await refExists(cli.repo, b.heldHead))) continue;
    const height = (await deriveCoverage(cli.repo, chain, b.heldHead)).height;
    if (height < 0) continue; // below this pass's chain — degrades to an ordinary case
    out.push({ branch, height, conflictedPaths: b.heldPaths, caseId: b.frozenBy ?? '' });
  }
  return out;
}

/**
 * The effective HELD registry for derivation: the pass journal (intra-pass,
 * freshest — a `resolved` there clears the record) plus ledger-rebuilt records
 * for branches the journal does not know about (cross-pass freezes, §5/N3).
 */
async function combinedHeld(cli: Cli, ctx: PassCtx, journal: JournalEntry[]): Promise<HeldRecord[]> {
  const inPass = heldRegistry(journal);
  const have = new Set(inPass.map((h) => h.branch));
  const fromLedger = (await ledgerHeldRecords(cli, ctx.chain)).filter((h) => !have.has(h.branch));
  return [...inPass, ...fromLedger];
}

/**
 * DERIVED unfreeze (§8): a ledger-frozen branch whose CURRENT tip already
 * contains its `heldHead` (the resolution landed externally — e.g. the owner
 * merged the freeze PR) auto-unfreezes, journaled with reason `derived`.
 */
async function deriveUnfreeze(cli: Cli, dir: string, commit: boolean): Promise<string[]> {
  const ledger = readLedger(ledgerPathOf(cli));
  const unfrozen: string[] = [];
  for (const [branch, b] of Object.entries(ledger.branches)) {
    if (b.status !== 'frozen' || !b.heldHead) continue;
    if (!(await refExists(cli.repo, branch))) continue;
    const tip = await revParse(cli.repo, branch);
    if (await isAncestor(cli.repo, b.heldHead, tip)) {
      unfrozen.push(branch);
      if (commit) {
        unfreezeInLedger(cli, branch);
        appendJournal(dir, { action: 'unfrozen', branch, reason: 'derived', heldHead: b.heldHead });
      }
    }
  }
  return unfrozen;
}

/** A pending urge for a still-frozen branch (§8; posted by `push`, D-049). */
interface PendingUrge {
  branch: string;
  /** The pending run's top = the newest pending trunk head (a frozen branch lands no merges). */
  head: string;
  pending: Head[];
  fixBranch: string;
  prNumber: number | null;
  frozenBy: string | null;
}

/**
 * URGING detection (§8, pure): for each still-frozen branch, if the newest
 * pending trunk head beyond its coverage on the PINNED chain differs from
 * `lastUrgedHead`, an urge is DUE. One urge per NEW head, not per pass.
 * `plan`/`run` only report these; POSTING (PR comment + D-004 machine-block
 * refresh + `lastUrgedHead` advance) lives exclusively in the networked
 * `push` stage (D-049 — the driver posts, never prepares gh commands).
 */
async function detectUrges(cli: Cli, ctx: PassCtx): Promise<PendingUrge[]> {
  const ledger = readLedger(ledgerPathOf(cli));
  const due: PendingUrge[] = [];
  for (const [branch, b] of Object.entries(ledger.branches)) {
    if (b.status !== 'frozen') continue;
    if (!b.fixBranch) continue; // gate holds have no owner-facing freeze PR to nudge
    if (!(await refExists(cli.repo, branch))) continue;
    const tip = await revParse(cli.repo, branch);
    const coverage = (await deriveCoverage(cli.repo, ctx.chain, tip)).height;
    const pending = ctx.chain.heads.filter((h) => h.height > coverage);
    if (pending.length === 0) continue;
    const newest = pending[pending.length - 1];
    if (newest.sha === b.lastUrgedHead) continue; // already urged about this head
    due.push({
      branch,
      head: newest.sha,
      pending,
      fixBranch: b.fixBranch,
      prNumber: b.prNumber ?? null,
      frozenBy: b.frozenBy ?? null,
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
    `# Urge — ${urge.branch} still frozen (${urge.frozenBy})`,
    '',
    `${urge.pending.length} upstream commit(s) now pending beyond this branch's coverage since the freeze.`,
    `Newest ${newestList.length}:`,
    ...lines,
    '',
    `Resolving this freeze PR unblocks \`${urge.branch}\` and everything downstream.`,
  ].join('\n');
}

async function derive(cli: Cli, held: HeldRecord[], ctx: PassCtx, frozen: Set<string>): Promise<PropagationPlan> {
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
    frozen,
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
    ' "notes": "...", "resolvedTree": "<tree OID of the resolution this verdict attests to>"}',
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
 * Driver-created resolution worktree (SPEC 1): a detached worktree at
 * <passdir>/<caseid>/worktree materialized to the automerge tree (conflict
 * markers) with the branch tip as parent, so the agent resolves + commits THERE
 * and passes HEAD as --resolved-ref. Best-effort — on failure journal a warning
 * and continue (the case is still resolvable via an agent-made worktree).
 */
async function createCaseWorktree(cli: Cli, dir: string, caseFile: CaseFile, baseTip: string): Promise<void> {
  const wtPath = join(dir, caseFile.id, 'worktree');
  try {
    const amCommit = (
      await git(cli.repo, ['commit-tree', caseFile.automergeTree, '-p', baseTip, '-m', `automerge for ${caseFile.id}`])
    ).stdout.trim();
    await git(cli.repo, ['worktree', 'add', '--detach', wtPath, amCommit]);
    // Shared rerere (D-006, D-049 §4): install the workspace rr-cache into the
    // shared .git so rerere-enabled operations in the case worktree see the
    // recorded resolutions. Best-effort, like the worktree itself.
    const seeded = await installRrCache(cli.repo, join(cli.workspace, RR_CACHE_DIRNAME));
    appendJournal(dir, { action: 'case-worktree', caseId: caseFile.id, path: wtPath, rerereSeeded: seeded });
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

function emit(cli: Cli, artifact: unknown): void {
  const json = JSON.stringify(artifact, null, 2);
  if (cli.out) {
    writeFileSync(cli.out, json + '\n');
    console.log(`wrote ${cli.out}`);
  } else {
    console.log(json);
  }
}

export async function cmdPlan(cli: Cli): Promise<number> {
  // Only `plan` opens a pass. The opening snapshot (plan-initial.json) is
  // immutable; the equivalence "halt loudly" check lives in `run`, not here —
  // a pass with journal activity legitimately derives differently now (§8).
  const ctx = await openPass(cli);
  const dir = ctx.dir;
  await deriveUnfreeze(cli, dir, true); // externally-resolved freezes clear first
  // Urges are only DETECTED here; posting is `push`'s job (D-049, §14.4).
  const dueUrges = await detectUrges(cli, ctx);
  if (dueUrges.length) {
    console.error(`urges due (post via \`propagate push --execute\`): ${dueUrges.map((u) => u.branch).join(', ')}`);
  }
  const journal = readJournal(dir);
  const plan = await derive(cli, await combinedHeld(cli, ctx, journal), ctx, frozenBranches(cli));

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
  // unfreezes, no urge artifacts, no ledger/journal writes, no merges. Report
  // what WOULD happen (detect-only) and return.
  if (!cli.execute) {
    const journal0 = readJournal(dir);
    const plan0 = await derive(cli, await combinedHeld(cli, ctx, journal0), ctx, frozenBranches(cli));
    const wouldUnfreeze = await deriveUnfreeze(cli, dir, false);
    const wouldUrge = (await detectUrges(cli, ctx)).map((u) => ({ branch: u.branch, head: u.head }));
    console.error('DRY-RUN (no --execute): no state changes; reporting the plan + would-unfreeze/would-urge');
    emit(cli, { dryRun: true, plan: plan0, wouldUnfreeze, wouldUrge });
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
  // Externally-resolved freezes clear first; urges are only DETECTED (posting
  // is `push`'s job — D-049, §14.4); re-derive with the updated frozen set.
  await deriveUnfreeze(cli, dir, true);
  {
    const due = await detectUrges(cli, ctx);
    if (due.length) {
      console.error(`urges due (post via \`propagate push --execute\`): ${due.map((u) => u.branch).join(', ')}`);
    }
  }
  // B5i crash-heal BEFORE reading pass state: close ref-updated-but-journal-
  // missing cases (synthetic `resolved` + `reopened`) so the loop below
  // re-derives the branch instead of leaving it open forever.
  await crashHeal(cli, dir, readJournal(dir));
  const journal = readJournal(dir);
  const frozen = frozenBranches(cli);
  const plan = await derive(cli, await combinedHeld(cli, ctx, journal), ctx, frozen);
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
    const exclude = new Set([...arrived, ...reopened, ...frozen, ...syncedBranches, ...driverTouched]);
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
  const held = await combinedHeld(cli, ctx, journal); // journal-HELD + ledger-rebuilt (§5/N3)
  const heldSet = new Set([...held.map((h) => h.branch), ...frozen]); // journal-HELD ∪ ledger-frozen
  const preReffed = preReffedSet(journal);

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

      // A branch still HELD (frozen, awaiting the owner) arrives with an EMPTY
      // interval — descendants may proceed and DEFERRED re-evaluates, but we do
      // not re-emit its own case (it is cleared only by a mechanical/judged
      // resolve, which also reopens it).
      if (heldSet.has(snap.branch)) {
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
      const deriveLive = (): Promise<BranchPlan> =>
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
          stackCap: snap.stackCap, // effective cap resolved at plan derivation (D-049 §2)
        });
      const bp = await deriveLive();

      // Leaf / always_merge un-skip (§6): if every parent no-op'd in a pass that
      // carries progress, force (empty) merges along the cheapest parent chain.
      if ((bp.isLeaf || bp.alwaysMerge) && passHasProgress && allParentsSkipped(bp)) {
        const uchain = shortestUnskipChain(bp.branch, edges, entrySet);
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
            // HELD ancestor (§5): record the defer pointer too (was silently dropped).
            if (pp.deferredTo) {
              appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
            }
            // A clean merge up to the merge point can still leave a conflict ABOVE
            // it (§3 step 4): emit the case (recomputed post-merge) and halt.
            if (pp.case && (await emitCase(pp))) {
              branchGated = true;
              gated = true;
            }
          } else if (pp.verdict === 'defer') {
            appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
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
  let sealed = false;
  let missing: string | null = null;
  if (gated) {
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
    held: await combinedHeld(cli, ctx, journal),
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

/** Freeze a branch HELD: prepare the PR materials (D-048), journal `held`, ledger-freeze. */
async function freezeHeld(cli: Cli, dir: string, rc: ResolvedCase, notes: string[]): Promise<void> {
  const fixBranch = await prepareCaseMaterials(cli, dir, rc, 'held');
  appendJournal(dir, {
    action: 'held',
    branch: rc.branch,
    caseId: rc.id,
    height: rc.head.height,
    conflictedPaths: rc.conflictedPaths,
    notes,
  });
  // Durable cross-pass freeze (§8); head + paths let a later pass rebuild the
  // HELD registry for DEFERRED matching (§5/N3).
  freezeInLedger(cli, rc.branch, rc.id, rc.head.sha, rc.conflictedPaths, fixBranch);
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
        await freezeHeld(cli, dir, rc, [reason]);
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
    const coldread = JSON.parse(readFileSync(verdictPath, 'utf8')) as Partial<ColdReadVerdict>;
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

    // Scope guard (§7): recomputed automerge/paths + config-derived mode; violation = HELD, no merge.
    const guard = await scopeGuard(cli.repo, rc.automergeTree, resolvedTree, rc.conflictedPaths, rc.scopeGuardMode);
    const notes: string[] = [];

    if (!cli.execute) {
      const tier: Tier =
        !guard.ok || coldreadRejected ? 'held' : applyFloor(cli.tier, rc.tierFloor === 'judged' ? 'judged' : 'clean');
      console.error('DRY-RUN (no --execute): resolve decision follows');
      emit(cli, { case: rc.id, claimed: cli.tier, tier, scopeGuard: guard, coldread, reopen: reopenTargets });
      return 0;
    }

    // Scope violation -> HELD outright (a one-tier demotion would still land the
    // out-of-scope content, defeating the guard).
    if (!guard.ok) {
      const bad = [...guard.extraPaths, ...guard.hunkViolations.map((p) => `${p} (out-of-hunk)`)];
      notes.push(`scope-guard violation [${guard.mode}]: out-of-scope [${bad}] -> HELD, no merge`);
      appendJournal(dir, {
        action: 'scope-violation',
        branch: rc.branch,
        caseId: rc.id,
        mode: guard.mode,
        extraPaths: guard.extraPaths,
        hunkViolations: guard.hunkViolations,
      });
      await freezeHeld(cli, dir, rc, notes);
      await removeCaseWorktree(cli, dir, rc.id);
      reopen(dir, reopenTargets);
      console.error(`held ${rc.id}: scope-guard violation [${guard.mode}] (${bad.join(', ')})`);
      emit(cli, { case: rc.id, tier: 'held', scopeGuard: guard, notes, reopen: reopenTargets });
      return 0;
    }

    // Cold-read rejection -> HELD (incl. the D-050 fail-closed UNVERIFIABLE path).
    if (coldreadRejected) {
      notes.push(
        coldread.verdict === 'reject'
          ? `cold-read rejected -> HELD: ${coldread.notes}`
          : `cold-read UNVERIFIABLE-FROM-REQUEST on ${unverifiable.join(', ')} -> HELD (fail-closed, D-050): ${coldread.notes}`,
      );
      await freezeHeld(cli, dir, rc, notes);
      await removeCaseWorktree(cli, dir, rc.id);
      reopen(dir, reopenTargets);
      console.error(`held ${rc.id}: cold-read rejected`);
      emit(cli, { case: rc.id, tier: 'held', notes, reopen: reopenTargets });
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
    unfreezeInLedger(cli, rc.branch); // clearing a HELD unfreezes the ledger entry
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
 * height on the same day cannot collide — B8).
 */
function fixBranchName(rc: Pick<ResolvedCase, 'branch' | 'parent' | 'head'>): string {
  const date = new Date().toISOString().slice(0, 10);
  return `fix/sweep/${date}-${slug(rc.branch)}--${slug(rc.parent)}-h${rc.head.height}`;
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
    `Branch: ${rc.branch}   Parent: ${rc.parent}   Head: ${rc.head.sha.slice(0, 12)} (height ${rc.head.height})`,
    `Case run (D-049 §2, ${rc.run.length} height(s)): ${rc.run.map((h) => `h${h.height} ${h.sha.slice(0, 12)}`).join(', ')}`,
    `Pending upstream commits above this point: ${rc.pendingAbove}`,
    '',
    '## Conflicted paths',
    ...rc.conflictedPaths.map((p) => `- ${p}`),
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
 * The REAL commit a case's PR head is pushed at (§14, D-049): HELD — the case
 * run's TOP commit (verified live: a conflict with the recorded path set must
 * still exist against the CURRENT branch tip); JUDGED — the resolved merge
 * commit (must still be on the branch). Returns an ERR01/ERR02 issue instead
 * when the case has no publishable disposition or its live state moved
 * (staleness re-verification — the journal is a pointer, git is the
 * authority, same trust model as reverifyCase).
 */
async function publishHead(
  cli: Cli,
  journal: JournalEntry[],
  jc: JournaledCase,
): Promise<{ headSha?: string; mode?: 'held' | 'judged'; issue?: Issue }> {
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
    return { headSha: jc.head.sha, mode: 'held' };
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
  return { headSha: mergeCommit, mode: 'judged' };
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
async function duplicateCaseIssue(
  cli: Cli,
  journal: JournalEntry[],
  cases: Map<string, JournaledCase>,
  self: JournaledCase,
): Promise<Issue | null> {
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
 * `propagate publish --case <id>` (§14, D-048/D-049) — the ONLY sanctioned
 * PR-creation path. The agent writes pr/title.txt + pr/body.md itself from
 * studying the case; this subcommand re-verifies the case, determines the REAL
 * PR head (HELD: the case run's top commit; JUDGED: the merge commit), runs
 * the check battery incl. the pre-PR height check (ERR14) and emits ONE
 * machine-readable JSON object {ok, issues:[{id, detail}], pr?} on stdout.
 * Blocking ERR* ids stop the publish; WARN* ids ship as advisories. With
 * --execute (and all-clear) it PUSHES the fix/sweep ref via `git push`
 * (ERR15 on failure — a D-046 case-2 owner report, never worked around) and
 * creates the PR via the GitHub API (HELD draft with the D-004 machine block,
 * JUDGED non-draft); without --execute it is a dry-run — full battery, but NO
 * pushes and NO network calls of any kind. Text checks are MECHANICAL only
 * (ERR08 + lint WARNs + ERR05/ERR06); the PR-text cold read is retired (D-050).
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
  const src = await publishHead(cli, journal, jc);
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

  const fixBranch =
    mode === 'held' &&
    readLedger(ledgerPathOf(cli)).branches[jc.branch]?.frozenBy === jc.caseId &&
    readLedger(ledgerPathOf(cli)).branches[jc.branch]?.fixBranch
      ? readLedger(ledgerPathOf(cli)).branches[jc.branch]!.fixBranch!
      : fixBranchName(jc);

  if (issues.some((i) => isBlocking(i.id))) {
    emit(cli, { ok: false, issues });
    return 1;
  }

  const draft = mode === 'held'; // only HELD is a review state (D-049 §1)
  const headInfo = { commit: headSha, mode };
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
  // earlier publish already landed.
  const transport = (makeTransport ?? realGithubTransport)(token!);
  try {
    const existing = await getOpenPrByHead(transport, slugParts!, fixBranch);
    if (existing) {
      emit(cli, {
        ok: false,
        issues: [
          ...issues,
          { id: 'ERR07_PR_EXISTS', detail: `open PR already exists for head '${fixBranch}': ${existing.url}` },
        ],
      });
      return 1;
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
  // report; NO fallback of any kind.
  try {
    await gitPush(cli.repo, headSha, fixBranch);
    appendJournal(dir, { action: 'push', branch: fixBranch, to: headSha, kind: 'pr-head' });
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
    if (mode === 'held') {
      // D-004 machine block (D-049 decision 8): driver-maintained, delimited,
      // appended BELOW the agent's prose; posted urges keep it current.
      const pendingAbove = Math.max(0, ctx.chain.heads.length - 1 - jc.head.height);
      finalBody = withMachineBlock(finalBody, renderMachineBlock(pendingAbove, ctx.watermark12));
    }
    const result = await createPullRequest(transport, slugParts!, {
      title,
      body: finalBody,
      head: fixBranch,
      base: jc.branch,
      draft,
    });
    // Local anchor for the pushed ref. Namespace-checked, scope-exempt.
    guardRef(fixBranch, new Set(), { fixSweep: true });
    if (!(await refExists(cli.repo, fixBranch))) {
      await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, headSha, '']);
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
    });
    if (mode === 'held') {
      // Point the ledger freeze at the branch/PR the urges must target.
      const path = ledgerPathOf(cli);
      const ledger = readLedger(path);
      if (ledger.branches[jc.branch]?.frozenBy === jc.caseId) {
        ledger.branches[jc.branch] = { ...ledger.branches[jc.branch], fixBranch, prNumber: result.number };
        writeLedger(path, ledger);
      }
    }
    console.error(`published ${draft ? 'draft ' : ''}PR #${result.number} for ${jc.caseId}: ${result.url}`);
    emit(cli, { ok: true, issues, pr: { url: result.url, number: result.number }, head: headInfo });
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
 * together; GitHub auto-flips the JUDGED PRs to merged (D-040) → HELD draft
 * PRs created (`publish`; bases now current, ERR14 enforces it) → urge
 * comments posted (also this command). Verify-gated (ERR18): nothing is
 * pushed before `verify` is green (§9, D-012). A failed push is ERR15 — hard
 * halt, journaled, D-046 case-2 owner report, NO fallback. Closure checks and
 * urge posting are the networked parts and take the same `--token-file` as
 * `publish`; a dry-run reports intents only (no writes, no network).
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
  const dueUrges = await detectUrges(cli, ctx);

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
  const pushed: string[] = [];
  for (const intent of intents) {
    if (intent.state === 'up-to-date' || intent.state === 'remote-ahead') {
      appendJournal(dir, { action: 'push-skip', branch: intent.branch, reason: intent.state });
      continue;
    }
    if (intent.state === 'diverged') {
      const detail = `push target '${intent.branch}' has DIVERGED from origin — owner escalation, never force-resolve`;
      appendJournal(dir, {
        action: 'halt',
        reason: 'sync-diverged',
        id: 'ERR20_BRANCH_DIVERGED',
        branch: intent.branch,
        message: detail,
      });
      console.error(`push [ERR20_BRANCH_DIVERGED]: ${detail}`);
      emit(cli, { ok: false, issues: [...issues, { id: 'ERR20_BRANCH_DIVERGED', detail }], pushed });
      return 1;
    }
    try {
      await gitPush(cli.repo, intent.branch, intent.branch);
      appendJournal(dir, { action: 'push', branch: intent.branch, to: intent.localTip, kind: 'target' });
      pushed.push(intent.branch);
    } catch (e) {
      const detail =
        `git push of target '${intent.branch}' failed: ${e instanceof Error ? e.message : String(e)} — ` +
        `report to the owner (D-046 case 2) and STOP; publication is blocked until the infrastructure is fixed`;
      appendJournal(dir, {
        action: 'halt',
        reason: 'push-failed',
        id: 'ERR15_PUSH_FAILED',
        branch: intent.branch,
        message: detail,
      });
      console.error(`push [ERR15_PUSH_FAILED]: ${detail}`);
      emit(cli, { ok: false, issues: [...issues, { id: 'ERR15_PUSH_FAILED', detail }], pushed });
      return 1;
    }
  }

  // Networked steps (closure checks + urge posting). Only constructed when
  // there is work; same --token-file contract as publish (D-049 decision 7).
  const needsNetwork = judgedPrs.length > 0 || dueUrges.length > 0;
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
  const closures: Array<{ number: number; merged: boolean }> = [];
  if (transport && slugParts) {
    const api = `/repos/${slugParts.owner}/${slugParts.repo}`;
    for (const e of judgedPrs) {
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
        const path = ledgerPathOf(cli);
        const fresh = readLedger(path);
        fresh.branches[urge.branch] = { ...fresh.branches[urge.branch], lastUrgedHead: urge.head, prNumber };
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

  const ok = !issues.some((i) => isBlocking(i.id));
  console.error(
    `push ${ok ? 'complete' : 'FINISHED WITH BLOCKING ISSUES'} — ${pushed.length} branch(es) pushed, ` +
      `${closures.filter((c) => c.merged).length}/${closures.length} judged closures confirmed, ${urged.length} urge(s) posted`,
  );
  emit(cli, { ok, issues, pushed, closures, urged });
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
  const held = new Set<string>([...heldRegistry(journal).map((h) => h.branch), ...frozenBranches(cli)]);
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
  freezeInLedger(cli, offender, 'gate', null, null, null); // gate hold has no conflicting head / paths / PR
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
  const ledger = readLedger(ledgerPathOf(cli));
  const entry = ledger.branches[cli.branch];
  if (!entry || entry.status !== 'frozen') {
    console.error(`unfreeze: '${cli.branch}' is not ledger-frozen`);
    return 2;
  }
  if (!cli.execute) {
    console.error(`DRY-RUN (no --execute): would manually unfreeze ${cli.branch} (frozenBy ${entry.frozenBy})`);
    emit(cli, { branch: cli.branch, frozenBy: entry.frozenBy });
    return 0;
  }
  unfreezeInLedger(cli, cli.branch);
  appendJournal(dir, { action: 'unfrozen', branch: cli.branch, reason: 'manual', frozenBy: entry.frozenBy });
  console.error(`unfroze ${cli.branch} (manual)`);
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
  const held = heldRegistry(journal);
  if (held.length) {
    console.log('HELD (this pass):');
    for (const h of held)
      console.log(`  ${h.branch} @height ${h.height} (${h.caseId}) paths=${h.conflictedPaths.join(',')}`);
  }
  const frozen = frozenBranches(cli);
  if (frozen.size) console.log(`ledger-frozen (cross-pass): ${[...frozen].join(', ')}`);
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
  if (cli.out) {
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
  finishStep?: 'verify' | 'judged-prs' | 'push' | 'report' | 'done';
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
  verdict: 'confirm' | 'reject';
  answers?: Partial<Record<'q1' | 'q2' | 'q3', string>>;
  notes: string;
  /**
   * report-pr only: when the RESOLUTION is sound but the PR DESCRIPTION
   * misrepresents it, the reader flags `description` — a description-only
   * defect → `rewrite`, not a freeze. Absent/`code` = a resolution-level defect
   * (fail-closed to HELD). Never lets a bad resolution through as a rewrite.
   */
  defect?: 'code' | 'description' | null;
}

/** Injectable cold-read invoker: prompt in, verdict out (default shells `claude -p`). */
export type ColdReadInvoker = (prompt: string) => Promise<MachineVerdict>;

/** Parse the last JSON object printed by `claude -p`; unparseable → fail-closed reject. */
export function parseMachineVerdict(stdout: string): MachineVerdict {
  const matches = stdout.match(/\{[\s\S]*\}/g);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const v = JSON.parse(matches[i]) as Partial<MachineVerdict>;
        if (v.verdict === 'confirm' || v.verdict === 'reject') {
          return {
            verdict: v.verdict,
            answers: v.answers,
            notes: typeof v.notes === 'string' ? v.notes : '',
            defect: v.defect ?? null,
          };
        }
      } catch {
        /* try the next candidate */
      }
    }
  }
  return { verdict: 'reject', notes: 'cold read produced no parseable verdict (fail-closed, D-053)', defect: 'code' };
}

/** Default invoker: a synchronous `claude -p` subprocess, request on stdin. */
export const defaultColdReadInvoker: ColdReadInvoker = async (prompt) => {
  const res = spawnSync('claude', ['-p'], { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || typeof res.stdout !== 'string') {
    return {
      verdict: 'reject',
      notes: `claude -p failed (status ${res.status ?? 'null'}${res.error ? `: ${res.error.message}` : ''}) — fail-closed (D-053)`,
      defect: 'code',
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
    '{"verdict":"confirm|reject","answers":{"q1":"...","q2":"...","q3":"..."},"notes":"...","defect":"code|description|null"}',
    '```',
    '- `reject` if any of Q1-Q3 fails, or answer `UNVERIFIABLE-FROM-REQUEST` for a point you cannot judge (fail-closed).',
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
    `# Case materials — ${jc.caseId} (driver-authored, D-048/D-053)`,
    '',
    `Branch: ${jc.branch}   Parent: ${jc.parent}   Head: ${jc.head.sha.slice(0, 12)} (height ${jc.head.height})`,
    '',
    '## Conflicted paths',
    ...jc.conflictedPaths.map((p) => `- ${p}`),
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
 * `sweep start` — open a pass and pin its watermark. Refuses if a pass is
 * already open (a machine state that is not `complete`): the agent must
 * `finish` or `abort` first — never blind-wipe an in-flight pass (that stranded
 * resolved-but-unpushed merges before, §2). Pins the watermark = upstream top
 * commit (via cmdPlan), initializes the journal, and writes the machine state.
 */
export async function cmdSweepStart(cli: Cli): Promise<number> {
  // Refuse a still-open pass. attachPass finds the latest OPEN pass dir (no
  // pass-complete); a machine state that is not `complete` means it is in flight.
  try {
    const existing = await attachPass({ ...cli, cmd: 'status' });
    const st = readMachineState(existing.dir);
    if (st && st.phase !== 'complete') {
      const detail = `a pass is already open (${existing.watermark12}, phase ${st.phase}) — run \`finish\` or \`abort\` first`;
      console.error(`sweep start [ERR30_PASS_OPEN]: ${detail}`);
      emit(cli, { ok: false, issues: [{ id: 'ERR30_PASS_OPEN', detail }] });
      return 1;
    }
  } catch {
    /* no open pass — proceed */
  }
  // Pin the watermark + open the pass (only `plan` opens a pass, §2).
  const planRc = await cmdPlan({ ...cli, cmd: 'plan' });
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
  console.error(`sweep started — pass ${ctx.watermark12} pinned at ${ctx.watermark.slice(0, 12)}`);
  emit(cli, { status: 'started', watermark: ctx.watermark, watermark12: ctx.watermark12, passDir: ctx.dir });
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
  emit(cli, { status: 'aborted', rolledBack });
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
    emit(cli, {
      status: 'awaiting-pr',
      instruction: 'report-pr for the current case first',
      currentCase: st.currentCase,
    });
    return 1;
  }
  if (st.phase === 'complete') {
    console.error('next-case: pass is complete — run `sweep start` for a new pass');
    emit(cli, { status: 'complete' });
    return 1;
  }

  // Advance the deterministic machinery (idempotent; continues reopened branches
  // above resolved heights and lands new clean prefixes/skips/defers).
  const runRc = await cmdRun({ ...cli, cmd: 'run', execute: true });
  if (runRc !== 0) {
    // A per-branch/whole-run halt (ERR2x) — surface it; the agent reports it.
    console.error('next-case: `run` halted — see the journal');
    return runRc;
  }

  const journal = readJournal(dir);
  const open = openCases(journal);
  if (open.length === 0) {
    st = { ...st, phase: 'open', currentCase: null };
    writeMachineState(dir, st);
    console.error('next-case: no more cases — finalize (run `finish`)');
    emit(cli, { status: 'finalize' });
    return 0;
  }

  const jc = open[0];
  const caseFile = readCaseFile(join(dir, jc.caseId, 'case.json'));
  const worktree = caseWorktreePath(dir, jc.caseId);
  const materials = await machineCaseMaterials(cli, jc);
  writeFileSync(join(dir, jc.caseId, 'materials.md'), materials + '\n');
  st = { ...st, phase: 'case-ready', currentCase: { caseId: jc.caseId, branch: jc.branch } };
  writeMachineState(dir, st);
  console.error(`next-case: case ${jc.caseId} ready in ${worktree}`);
  emit(cli, {
    status: 'case-ready',
    worktree,
    branch: jc.branch,
    caseId: jc.caseId,
    conflictedPaths: caseFile.conflictedPaths,
    run: caseFile.run ?? [caseFile.head],
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
 * empty/unresolved → scope guard ⊆ conflicted paths with demote → branch-scoped
 * tests → ERR05/adequacy + duplicate → per-case attempt cap force-HELD, D-052),
 * then the cold read PLACEMENT:
 *  - mechanical: cold read HERE (`claude -p`) over the resolution diff → confirm
 *    → merge in place → `merged, take next case`; reject → freeze HELD.
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

  // §7 trust boundary: re-derive the case from git + registry (case.json is only
  // a pointer). Reuses the flag-path's reverifyCase verbatim.
  const rv = await reverifyCase(cli, ctx, dir, caseFile, journal);
  if (!rv.ok) {
    console.error(`report-case HALT: case re-verification failed:\n  ${rv.errors.join('\n  ')}`);
    emit(cli, {
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
    emit(cli, {
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
  const decided = decidedAlready(registry.features, rc.branch, rc.conflictedPaths);
  if (decided) issues.push(decided);
  const dup = await duplicateCaseIssue(cli, journal, journaledCases(journal), journaledCases(journal).get(caseId)!);
  if (dup) issues.push(dup);

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

  // Effective tier after demotions (authoritative): scope violation → HELD;
  // judged/mechanical with conflicts still present → HELD; cap → HELD.
  const conflictsPresent = emptyResolution || markers.length > 0;
  let effectiveTier: Tier = applyFloor(
    claimed === 'held' ? 'judged' : claimed,
    rc.tierFloor === 'judged' ? 'judged' : 'clean',
  );
  if (claimed === 'held') effectiveTier = 'held';
  const demoteReasons: string[] = [];
  if (!guard.ok) {
    effectiveTier = 'held';
    demoteReasons.push(
      `scope-guard violation [${guard.mode}]: [${[...guard.extraPaths, ...guard.hunkViolations].join(', ')}] -> held`,
    );
  }
  if (conflictsPresent && claimed !== 'held') {
    effectiveTier = 'held';
    demoteReasons.push(
      emptyResolution
        ? 'worktree unchanged (empty resolution) -> held'
        : `unresolved conflict markers in [${markers.join(', ')}] -> held`,
    );
  }
  if (capExceeded) {
    effectiveTier = 'held';
    demoteReasons.push(`resolution did not converge in ${RESOLVE_COLDREAD_CAP} distinct trees -> held (ERR26)`);
  }

  // Hard blocks that are NOT a freeze: the agent must fix + re-report. An
  // adequacy hit (ERR05/ERR06) means "do not open this; apply/consolidate".
  if (issues.some((i) => i.id === 'ERR05_DECIDED_ALREADY' || i.id === 'ERR06_DUPLICATE_CASE')) {
    const first = issues.find((i) => i.id === 'ERR05_DECIDED_ALREADY' || i.id === 'ERR06_DUPLICATE_CASE')!;
    emit(cli, {
      instruction: `${first.id === 'ERR05_DECIDED_ALREADY' ? 'apply the recorded decision (judged)' : 'consolidate into the topmost case'}: ${first.detail}`,
      tier: effectiveTier,
      issues,
    });
    return 1;
  }

  // Empty/unresolved on a MECHANICAL/JUDGED claim that is NOT being frozen: the
  // agent hasn't resolved yet — ask them to resolve (no freeze, re-report).
  if (conflictsPresent && claimed !== 'held' && !capExceeded && guard.ok) {
    const detail = emptyResolution
      ? 'worktree unchanged — resolve the conflict in the worktree first'
      : `unresolved conflict markers remain in [${markers.join(', ')}]`;
    emit(cli, { instruction: detail, tier: claimed, issues: [{ id: 'ERR32_UNRESOLVED', detail }] });
    return 1;
  }

  if (!cli.execute) {
    emit(cli, { dryRun: true, instruction: 'dry-run', tier: effectiveTier, claimed, scopeGuard: guard, issues });
    return 0;
  }

  // --- HELD (claimed or demoted): freeze now, then send to report-pr ---------
  if (effectiveTier === 'held') {
    const notes = demoteReasons.length ? demoteReasons : ['agent declared cannot-resolve (--tier held)'];
    await freezeHeld(cli, dir, rc, notes);
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    console.error(`report-case: held ${caseId} (${notes.join('; ')})`);
    emit(cli, { instruction: 'provide PR description', tier: 'held', issues });
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
    emit(cli, {
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
    emit(cli, { instruction: 'provide PR description', tier: 'judged', issues });
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
  const verdict = await invoke(prompt);
  writeFileSync(join(caseDir, 'coldread-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  const { rejected, unverifiable } = coldReadRejected(verdict);
  appendJournal(dir, {
    action: 'coldread',
    caseId,
    branch: rc.branch,
    phase: 'report-case',
    verdict: verdict.verdict,
    unverifiable,
  });
  if (rejected) {
    const note =
      verdict.verdict === 'reject'
        ? `cold-read rejected -> HELD: ${verdict.notes}`
        : `cold-read UNVERIFIABLE-FROM-REQUEST on ${unverifiable.join(', ')} -> HELD (fail-closed): ${verdict.notes}`;
    await freezeHeld(cli, dir, rc, [note]);
    reopen(dir, reopenTargets);
    writeMachineState(dir, { ...st, phase: 'awaiting-pr', currentCase: { caseId, branch: rc.branch, tier: 'held' } });
    console.error(`report-case: held ${caseId} (cold-read rejected)`);
    emit(cli, { instruction: 'provide PR description', tier: 'held', issues });
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
  unfreezeInLedger(cli, rc.branch);
  await removeCaseWorktree(cli, dir, caseId);
  reopen(dir, reopenTargets);
  writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
  console.error(`report-case: merged ${caseId} (mechanical) ${mergeCommit.slice(0, 12)}`);
  emit(cli, { instruction: 'merged, take next case', tier: 'mechanical', mergeCommit, issues });
  return 0;
}

// --------------------------------------------------------------------------
// `report-pr` (judged and held only) (SWEEP-STATE-MACHINE.md §2).
// --------------------------------------------------------------------------

/**
 * Publish a HELD draft PR NOW (D-053 report-pr) — the case run's TOP commit as
 * the PR head, pushed via `git push`, draft PR created with the D-004 machine
 * block. UNLIKE `cmdPublish`'s held path this does NOT run checkBaseHeight
 * (ERR14): a HELD draft lands nothing on a target branch, so origin base
 * currency is irrelevant — it publishes the moment the case is frozen, before
 * any target push (SWEEP-STATE-MACHINE.md §report-pr). Reuses publishHead (live
 * conflict re-verify), the mechanical adequacy checks (ERR05/ERR06/ERR08) and
 * the real PR-creation path. Returns {ok, issues}.
 */
async function publishHeldDraftNow(
  cli: Cli,
  dir: string,
  jc: JournaledCase,
  journal: JournalEntry[],
  watermark12: string,
  chainLen: number,
  makeTransport?: (token: string) => GithubTransport,
): Promise<{ ok: boolean; issues: Issue[] }> {
  const issues: Issue[] = [];
  const src = await publishHead(cli, journal, jc);
  if (src.issue) return { ok: false, issues: [src.issue] };
  if (src.mode !== 'held') {
    return {
      ok: false,
      issues: [
        { id: 'ERR01_CASE_NOT_OPEN', detail: `case '${jc.caseId}' is not HELD — report-pr held expects a frozen case` },
      ],
    };
  }
  const headSha = src.headSha!;
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const decided = decidedAlready(registry.features, jc.branch, jc.conflictedPaths);
  if (decided) issues.push(decided);
  const dup = await duplicateCaseIssue(cli, journal, journaledCases(journal), jc);
  if (dup) issues.push(dup);
  if (journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId)) {
    const prior = journal.filter((e) => e.action === 'pr-published' && e.caseId === jc.caseId).pop()!;
    issues.push({ id: 'ERR07_PR_EXISTS', detail: `PR #${prior.number} already published for this case: ${prior.url}` });
  }
  const prDir = join(dir, jc.caseId, 'pr');
  const title = existsSync(join(prDir, 'title.txt')) ? readFileSync(join(prDir, 'title.txt'), 'utf8').trim() : '';
  const body = existsSync(join(prDir, 'body.md')) ? readFileSync(join(prDir, 'body.md'), 'utf8').trim() : '';
  if (!title || !body) {
    issues.push({
      id: 'ERR08_TEXT_MISSING',
      detail: `write ${join(prDir, 'title.txt')} and ${join(prDir, 'body.md')} yourself`,
    });
  } else {
    issues.push(...advisoryTextIssues(title, body, jc.conflictedPaths));
  }
  const fixBranch =
    readLedger(ledgerPathOf(cli)).branches[jc.branch]?.frozenBy === jc.caseId &&
    readLedger(ledgerPathOf(cli)).branches[jc.branch]?.fixBranch
      ? readLedger(ledgerPathOf(cli)).branches[jc.branch]!.fixBranch!
      : fixBranchName(jc);
  let token: string | null = null;
  if (cli.tokenFile && existsSync(cli.tokenFile)) token = readFileSync(cli.tokenFile, 'utf8').trim() || null;
  if (!token) issues.push({ id: 'ERR11_TOKEN_MISSING', detail: 'report-pr held publish needs --token-file <path>' });
  const slugParts = await originSlug(cli);
  if (!slugParts) issues.push({ id: 'ERR12_ORIGIN_UNRESOLVED', detail: 'cannot derive owner/repo from origin' });
  if (issues.some((i) => isBlocking(i.id))) return { ok: false, issues };

  const transport = (makeTransport ?? realGithubTransport)(token!);
  try {
    const existing = await getOpenPrByHead(transport, slugParts!, fixBranch);
    if (existing)
      return {
        ok: false,
        issues: [
          ...issues,
          { id: 'ERR07_PR_EXISTS', detail: `open PR already exists for head '${fixBranch}': ${existing.url}` },
        ],
      };
  } catch (e) {
    return {
      ok: false,
      issues: [...issues, { id: 'ERR13_API_FAILED', detail: e instanceof Error ? e.message : String(e) }],
    };
  }
  try {
    await gitPush(cli.repo, headSha, fixBranch);
    appendJournal(dir, { action: 'push', branch: fixBranch, to: headSha, kind: 'pr-head' });
  } catch (e) {
    const detail = `git push of '${fixBranch}' at ${headSha.slice(0, 12)} failed: ${e instanceof Error ? e.message : String(e)} — report to the owner (D-046 case 2) and STOP`;
    appendJournal(dir, {
      action: 'halt',
      reason: 'push-failed',
      id: 'ERR15_PUSH_FAILED',
      branch: fixBranch,
      message: detail,
    });
    return { ok: false, issues: [...issues, { id: 'ERR15_PUSH_FAILED', detail }] };
  }
  try {
    const pendingAbove = Math.max(0, chainLen - 1 - jc.head.height);
    const finalBody = withMachineBlock(body, renderMachineBlock(pendingAbove, watermark12));
    const result = await createPullRequest(transport, slugParts!, {
      title,
      body: finalBody,
      head: fixBranch,
      base: jc.branch,
      draft: true,
    });
    guardRef(fixBranch, new Set(), { fixSweep: true });
    if (!(await refExists(cli.repo, fixBranch)))
      await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, headSha, '']);
    appendJournal(dir, {
      action: 'pr-published',
      caseId: jc.caseId,
      branch: jc.branch,
      mode: 'held',
      draft: true,
      fixBranch,
      url: result.url,
      number: result.number,
      head: headSha,
    });
    const path = ledgerPathOf(cli);
    const ledger = readLedger(path);
    if (ledger.branches[jc.branch]?.frozenBy === jc.caseId) {
      ledger.branches[jc.branch] = { ...ledger.branches[jc.branch], fixBranch, prNumber: result.number };
      writeLedger(path, ledger);
    }
    console.error(`report-pr: published draft PR #${result.number} for ${jc.caseId}: ${result.url}`);
    return { ok: true, issues: [...issues, ...[]] };
  } catch (e) {
    return {
      ok: false,
      issues: [...issues, { id: 'ERR13_API_FAILED', detail: e instanceof Error ? e.message : String(e) }],
    };
  }
}

/**
 * `report-pr` — reads the agent's PR description from the FIXED path
 * (pr/title.txt + pr/body.md), runs the SINGLE cold read over the resolution
 * diff AND the description together (kept kind-1 read with the description in
 * view — reject/UNVERIFIABLE → HELD fail-closed; a description-only defect →
 * `rewrite: <reason>`), then by tier: held → PUBLISH THE DRAFT PR NOW (push the
 * fix/sweep branch at the case head + open the draft — it lands nothing on a
 * target, so there is no verify dependency, D-047/D-053); judged → merge in
 * place + RECORD PR INTENT only (create+close deferred to `finish`).
 */
export async function cmdSweepReportPr(
  cli: Cli,
  invoke: ColdReadInvoker = defaultColdReadInvoker,
  makeTransport?: (token: string) => GithubTransport,
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
    emit(cli, { instruction: 'provide PR description', issues: [{ id: 'ERR08_TEXT_MISSING', detail }] });
    return 1;
  }

  const caseFile = readCaseFile(join(caseDir, 'case.json'));

  // Build the review content by tier. JUDGED re-verifies + re-snapshots the
  // resolution (fail-closed if it now scope-violates / still conflicts); HELD is
  // a frozen exhibit — the cold read judges the description against the conflict.
  let conflictDiff: string;
  let resolutionDiff: string | null;
  let rc: ResolvedCase | null = null;
  let resolvedTree = '';
  const branchTip0 = (await refExists(cli.repo, branch)) ? await revParse(cli.repo, branch) : '';
  if (tier === 'judged') {
    const rv = await reverifyCase(cli, ctx, dir, caseFile, journal);
    if (!rv.ok) {
      emit(cli, {
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
    if (!guard.ok || markers.length > 0) {
      // Demote to HELD (fail-closed): a judged claim that no longer resolves.
      const note = !guard.ok ? `scope-guard violation [${guard.mode}] -> held` : `unresolved conflict markers -> held`;
      await freezeHeld(cli, dir, rc, [note]);
      reopen(dir, [rc.branch, ...rc.descendants]);
      writeMachineState(dir, { ...st, currentCase: { caseId, branch, tier: 'held' } });
      emit(cli, { instruction: `held: ${note} — re-run report-pr to publish the frozen exhibit`, tier: 'held' });
      return 1;
    }
    conflictDiff = (
      await git(cli.repo, ['diff', branchTip0, rc.automergeTree, '--', ...rc.conflictedPaths], { allowCodes: [1] })
    ).stdout;
    resolutionDiff = (await git(cli.repo, ['diff', rc.automergeTree, resolvedTree], { allowCodes: [1] })).stdout;
  } else {
    // held exhibit: the conflict IS the review content.
    conflictDiff = (
      await git(cli.repo, ['diff', branchTip0, caseFile.automergeTree, '--', ...caseFile.conflictedPaths], {
        allowCodes: [1],
      })
    ).stdout;
    resolutionDiff = null;
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
    emit(cli, { dryRun: true, instruction: 'dry-run', tier });
    return 0;
  }

  const verdict = await invoke(prompt);
  writeFileSync(join(caseDir, 'coldread-pr-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  const { rejected, unverifiable } = coldReadRejected(verdict);
  appendJournal(dir, {
    action: 'coldread',
    caseId,
    branch,
    phase: 'report-pr',
    verdict: verdict.verdict,
    unverifiable,
    defect: verdict.defect ?? null,
  });

  // A description-only defect on a sound resolution → rewrite (not a freeze).
  if (rejected && verdict.defect === 'description') {
    emit(cli, {
      instruction: `rewrite: ${verdict.notes}`,
      tier,
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
      // Fail-closed: a rejected judged resolution becomes HELD — do not merge.
      await freezeHeld(cli, dir, rc, [note]);
      reopen(dir, [rc.branch, ...rc.descendants]);
      writeMachineState(dir, { ...st, currentCase: { caseId, branch, tier: 'held' } });
      emit(cli, { instruction: `held: ${note} — re-run report-pr to publish the frozen exhibit`, tier: 'held' });
      return 1;
    }
    // held: keep frozen + unpublished until the description is accurate.
    emit(cli, {
      instruction: `rewrite: ${note}`,
      tier: 'held',
      issues: [{ id: 'WARN01_TEMPLATE_TEXT', detail: note }],
    });
    return 1;
  }

  // Confirm.
  if (tier === 'held') {
    // PUBLISH THE DRAFT PR NOW (§2): lands nothing on a target branch, so there
    // is no verify dependency and no target-push ordering (D-053) — publish the
    // moment the case is frozen, via the dedicated held-draft path (skips the
    // ERR14 origin-currency check that gates cmdPublish's D-049 held-after-push).
    const jc = journaledCases(readJournal(dir)).get(caseId)!;
    const pub = await publishHeldDraftNow(
      cli,
      dir,
      jc,
      readJournal(dir),
      ctx.watermark12,
      ctx.chain.heads.length,
      makeTransport,
    );
    if (!pub.ok) {
      console.error(`report-pr: HELD draft publish for ${caseId} blocked`);
      emit(cli, { ok: false, tier: 'held', issues: pub.issues });
      return 1;
    }
    writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
    emit(cli, { instruction: 'take next case', tier: 'held', published: true, issues: pub.issues });
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
  unfreezeInLedger(cli, rc!.branch);
  await removeCaseWorktree(cli, dir, caseId);
  reopen(dir, [rc!.branch, ...rc!.descendants]);
  writeMachineState(dir, { ...st, phase: 'open', currentCase: null });
  console.error(
    `report-pr: ${caseId} judged — merged ${mergeCommit.slice(0, 12)}, PR intent recorded (created at finish)`,
  );
  emit(cli, { instruction: 'take next case', tier: 'judged', mergeCommit, prIntent: true });
  return 0;
}

// --------------------------------------------------------------------------
// `sweep finish` (SWEEP-STATE-MACHINE.md §2) — multi-step, resumable.
// --------------------------------------------------------------------------

/**
 * `sweep finish` — the ONLY stage that lands code on a target branch (needs the
 * full-integration verify, D-012). Steps, in order (MERGE-POLICY §5): verify the
 * publishable set (full rebuild) → create JUDGED history PRs (publish, non-draft)
 * → push target branches (flips JUDGED PRs to merged) + closure checks + urges →
 * (HELD drafts already published at report-pr) → journal-derived owner report →
 * check upstream advanced past the pinned watermark. Multi-step and resumable: a
 * red verify (offender rolled back + HELD(gate)) or ERR15/ERR18 halts, reports,
 * and re-runs from the stopped phase; pushes never redo (cmdPush skips
 * up-to-date; cmdPublish guards ERR07).
 */
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
    emit(cli, { ok: false, issues: [{ id: 'ERR34_CASES_REMAIN', detail }] });
    return 1;
  }
  st = { ...st, phase: 'finishing', finishStep: st.finishStep ?? 'verify' };
  writeMachineState(dir, st);

  if (!cli.execute) {
    const journal = readJournal(dir);
    const judged = [...journaledCases(journal).values()].filter((jc) => {
      const d = lastDisposition(journal, jc.caseId);
      return (
        d?.action === 'resolved' &&
        d.tier === 'judged' &&
        !journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId)
      );
    });
    emit(cli, { dryRun: true, verifyGreen: canComplete(journal), judgedToPublish: judged.map((j) => j.caseId) });
    return 0;
  }

  // (1) verify the publishable set (full rebuild, D-051). A red verify either
  // fails attribution (verifyRc != 0) or rolls a publishable offender back to
  // HELD(gate) — both HALT finish (report + resumable): re-running finish drops
  // the now-frozen offender from the publishable recipe and proceeds. Pushes
  // never redo; the rollback is not repeated (the offender is already frozen).
  const gateBefore = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate').length;
  const verifyRc = await cmdVerify({ ...cli, cmd: 'verify', execute: true });
  const gateAfter = readJournal(dir).filter((e) => e.action === 'held' && e.reason === 'gate').length;
  if (verifyRc !== 0 || gateAfter > gateBefore) {
    const detail =
      verifyRc !== 0
        ? 'verify RED (no clean attribution) — investigate, fix, then re-run `finish` from the verify phase'
        : 'verify RED — offender rolled back + HELD(gate); re-run `finish` (the frozen offender drops out of the publishable set)';
    console.error(`finish: ${detail}`);
    emit(cli, { ok: false, issues: [{ id: 'ERR18_VERIFY_PENDING', detail }], halted: 'verify' });
    return 1;
  }
  writeMachineState(dir, { ...st, finishStep: 'judged-prs' });

  // (2) create the JUDGED history PRs (non-draft, before the target push so the
  // push auto-flips them to merged). Only cases not already published.
  {
    const journal = readJournal(dir);
    const judged = [...journaledCases(journal).values()].filter((jc) => {
      const d = lastDisposition(journal, jc.caseId);
      return d?.action === 'resolved' && d.tier === 'judged';
    });
    for (const jc of judged) {
      if (journal.some((e) => e.action === 'pr-published' && e.caseId === jc.caseId)) continue;
      const rcPub = await cmdPublish({ ...cli, cmd: 'publish', caseId: jc.caseId, execute: true }, makeTransport);
      if (rcPub !== 0) {
        console.error(`finish: JUDGED publish failed for ${jc.caseId} — re-run finish after fixing`);
        emit(cli, { ok: false, halted: 'judged-prs', caseId: jc.caseId });
        return 1;
      }
    }
  }
  writeMachineState(dir, { ...st, finishStep: 'push' });

  // (3) push target branches (flips JUDGED PRs to merged) + closure checks + urges.
  const pushRc = await cmdPush({ ...cli, cmd: 'push', execute: true }, makeTransport);
  if (pushRc !== 0) {
    console.error('finish: push halted (ERR15/ERR16/ERR18) — re-run finish from the push phase; pushes never redo');
    emit(cli, { ok: false, halted: 'push' });
    return 1;
  }
  writeMachineState(dir, { ...st, finishStep: 'report' });

  // (4) HELD drafts are already published (report-pr). (5) owner report.
  await cmdReport({ ...cli, cmd: 'report' });

  // (6) upstream advanced past the pinned watermark?
  let upstreamAdvanced = false;
  try {
    const liveUpstream = await revParse(cli.repo, cli.upstream);
    upstreamAdvanced = liveUpstream !== ctx.watermark && !(await isAncestor(cli.repo, liveUpstream, ctx.watermark));
  } catch {
    /* upstream ref unavailable (e.g. fixtures) — report done */
  }
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
  const next = upstreamAdvanced ? 'start again' : 'done';
  console.error(`sweep finish complete — ${next}`);
  emit(cli, { ok: true, status: 'complete', next, upstreamAdvanced });
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
  'sweep-start': cmdSweepStart,
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
