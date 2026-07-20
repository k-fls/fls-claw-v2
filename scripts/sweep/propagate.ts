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
 *                                 gate, then merge (MECHANICAL), prepare a PR (JUDGED), or
 *                                 freeze (HELD, --tier held direct)                    (MUTATES)
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
 *   --case <id>              resolve: the case id
 *   --tier <mechanical|judged|held>  resolve: the agent's claimed tier (held = direct freeze)
 *   --resolved-ref <ref>     resolve: commit carrying the agent's resolution (tree source)
 *   --branch <name>          unfreeze: the branch to clear
 *   --recipe <a,b,c>         verify: everything-rebuild recipe (default: scope.yaml recipe)
 *   --commands-file <file>   verify: CI command list JSON [{cmd,cwd?}] (test injection)
 *   --out <file>             write the subcommand's JSON artifact to a file
 *
 * Artifacts live under <workspace>/propagation/pass-<watermark12>/:
 *   plan-initial.json (immutable opening snapshot), plan.json (working), step files,
 *   case-<id>/case.json (+ coldread-request.md), journal.jsonl (append-only). case.json is
 *   a POINTER only — resolve re-derives everything from git+registry (§7 trust boundary).
 *   The driver PREPARES PR branches/bodies/gh commands but never calls gh / the network.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

import { DEFAULT_UPSTREAM_REF, FORK_POINT, LEDGER_FILENAME, VERIFY_COMMANDS } from './config.js';
import {
  commitInfo,
  commitTreeMerge,
  git,
  isAncestor,
  newStyleMergeTree,
  resetBranchRef,
  revParse,
  refExists,
  worktreeBranches,
} from './git.js';
import { readLedger, writeLedger, defaultLedgerBranch } from './ledger.js';
import { loadRegistry } from './registry.js';
import { scopeGuard } from './scope-guard.js';
import { buildStepFile, caseId, readCaseFile, verifyStepFile, writeJsonFile } from './steps.js';
import { applyFloor, isClaimableTier, tierFloor } from './tiers.js';
import { allParentsSkipped, deriveBranch, derivePlan, plansDiffer, shortestUnskipChain } from './plan.js';
import { deriveCoverage, enumerateChain, type Chain } from './heights.js';
import { verifyEverything, type VerifyCommand } from './verify.js';
import type {
  BranchPlan,
  CaseFile,
  ColdReadVerdict,
  FeatureEntry,
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
  inventory: string | null;
  scopeFile?: string;
  routingFile?: string;
  upstream: string;
  base?: string;
  execute: boolean;
  caseId?: string;
  tier?: string;
  resolvedRef?: string;
  branch?: string;
  recipe?: string[];
  commandsFile?: string;
  out?: string;
}

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/propagate.ts <plan|run|resolve|verify|unfreeze|status> [--repo <path>] [--workspace <dir>] [--ledger <file>] [--pass <wm12>] [--execute] [--case <id>] [--tier <t>] [--branch <b>] [flags]';

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
    inventory: null,
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
    fixBranch,
  };
  writeLedger(path, ledger);
}

function unfreezeInLedger(cli: Cli, branch: string): void {
  const path = ledgerPathOf(cli);
  const ledger = readLedger(path);
  if (ledger.branches[branch]) {
    ledger.branches[branch] = { ...ledger.branches[branch], status: 'active', frozenBy: null, heldHead: null };
    writeLedger(path, ledger);
  }
}

/**
 * DERIVED unfreeze (§8): a ledger-frozen branch whose CURRENT tip already
 * contains its `heldHead` (the resolution landed externally — e.g. the owner
 * merged the freeze PR) auto-unfreezes, journaled with reason `derived`.
 */
async function deriveUnfreeze(cli: Cli, dir: string): Promise<void> {
  const ledger = readLedger(ledgerPathOf(cli));
  for (const [branch, b] of Object.entries(ledger.branches)) {
    if (b.status !== 'frozen' || !b.heldHead) continue;
    if (!(await refExists(cli.repo, branch))) continue;
    const tip = await revParse(cli.repo, branch);
    if (await isAncestor(cli.repo, b.heldHead, tip)) {
      unfreezeInLedger(cli, branch);
      appendJournal(dir, { action: 'unfrozen', branch, reason: 'derived', heldHead: b.heldHead });
    }
  }
}

/**
 * URGING (§8): for each still-frozen branch, if the newest pending trunk head
 * beyond its coverage on the PINNED chain differs from `lastUrgedHead`, PREPARE
 * (never execute) a PR comment for the freeze PR — pending count + newest heads
 * with subjects — and record the new head. One urge per NEW head, not per pass.
 */
async function urgeFrozen(cli: Cli, ctx: PassCtx, dir: string): Promise<void> {
  const path = ledgerPathOf(cli);
  const ledger = readLedger(path);
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

    const newestList = pending.slice(-10);
    const lines: string[] = [];
    for (const h of newestList) {
      const info = await commitInfo(cli.repo, h.sha);
      lines.push(`- h${h.height} ${h.sha.slice(0, 12)} ${info.subject}`);
    }
    // Write into the CURRENT pass dir (freezes are cross-pass; the freeze PR's
    // original artifacts live in an older pass), targeting the stored fix branch.
    const urgeDir = join(dir, 'urges', branch.replace(/\//g, '__'));
    mkdirSync(urgeDir, { recursive: true });
    const body = [
      `# Urge — ${branch} still frozen (${b.frozenBy})`,
      '',
      `${pending.length} upstream commit(s) now pending beyond this branch's coverage since the freeze.`,
      `Newest ${newestList.length}:`,
      ...lines,
      '',
      `Resolving the freeze PR (\`${b.fixBranch}\`) unblocks this branch and everything downstream.`,
    ].join('\n');
    writeFileSync(join(urgeDir, 'urge-comment.md'), body + '\n');
    appendFileSync(
      join(urgeDir, 'urge-commands.sh'),
      `gh pr comment ${b.fixBranch} --body-file ${join(urgeDir, 'urge-comment.md')}\n`,
    );
    appendJournal(dir, { action: 'urge', branch, head: newest.sha, pending: pending.length });
    const fresh = readLedger(path);
    fresh.branches[branch] = { ...fresh.branches[branch], lastUrgedHead: newest.sha };
    writeLedger(path, fresh);
  }
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

// --------------------------------------------------------------------------
// Journaled ref mutations (reuse merge.ts's commit-tree + update-ref technique).
// --------------------------------------------------------------------------

async function treeOf(repo: string, commit: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
}

async function journaledMerge(repo: string, branch: string, headSha: string, message: string): Promise<string> {
  const checkedOut = await worktreeBranches(repo);
  const wt = checkedOut.get(branch);
  if (wt) {
    await git(repo, ['merge', '--no-edit', '-m', message, headSha], { cwd: wt });
    return revParse(repo, branch);
  }
  return commitTreeMerge(repo, branch, headSha, message);
}

/** Commit a merge whose tree is the AGENT-RESOLVED tree (scope-guarded caller). */
async function journaledResolvedMerge(
  repo: string,
  branch: string,
  headSha: string,
  resolvedTree: string,
  message: string,
): Promise<string> {
  const tip = await revParse(repo, branch);
  const theirs = await revParse(repo, headSha);
  const commit = (await git(repo, ['commit-tree', resolvedTree, '-p', tip, '-p', theirs, '-m', message])).stdout.trim();
  await git(repo, ['update-ref', `refs/heads/${branch}`, commit, tip]);
  return commit;
}

// --------------------------------------------------------------------------
// Case artifacts.
// --------------------------------------------------------------------------

const COLD_READ_QUESTIONS = [
  '1. Does the resolution preserve BOTH sides intended behaviour (no silent drop of either delta)?',
  '2. Is every changed hunk explained purely by the conflict, with no unrelated edits?',
  '3. Would the resolution still be correct if you had never seen how it was framed?',
  '4. Are there follow-on invariants (tests, types, call sites) this resolution must also satisfy?',
];

function coldReadRequest(caseFile: CaseFile, diffText: string): string {
  return [
    `# Cold-read request — ${caseFile.id}`,
    '',
    `Branch: ${caseFile.branch}   Parent: ${caseFile.parent}   Height: ${caseFile.head.height}`,
    `Conflicted paths: ${caseFile.conflictedPaths.join(', ')}`,
    '',
    '## Conflict hunks (automerge tree) + resolution diff',
    '```diff',
    diffText,
    '```',
    '',
    '## Cold-reader questions',
    ...COLD_READ_QUESTIONS,
  ].join('\n');
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
  await deriveUnfreeze(cli, dir); // externally-resolved freezes clear first
  await urgeFrozen(cli, ctx, dir); // urge still-frozen branches with new pending content
  const journal = readJournal(dir);
  const plan = await derive(cli, heldRegistry(journal), ctx, frozenBranches(cli));

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
  emit(cli, plan);
  return 0;
}

export async function cmdRun(cli: Cli): Promise<number> {
  const ctx = await passContext(cli); // attaches to the open pass
  const { chain, dir } = ctx;
  await deriveUnfreeze(cli, dir); // externally-resolved freezes clear first
  await urgeFrozen(cli, ctx, dir); // urge still-frozen branches with new pending content
  const journal = readJournal(dir);
  const frozen = frozenBranches(cli);
  const plan = await derive(cli, heldRegistry(journal), ctx, frozen);
  const passHasProgress = plan.chainLength > 0;

  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): run plan follows');
    emit(cli, plan);
    return 0;
  }

  // Plan-equivalence guard (§8): the live re-derivation must match the pass's
  // LAST written plan for branches not yet processed and not reopened this pass
  // — a mismatch means git moved under us. (Arrived/reopened/frozen branches
  // legitimately differ.) Then update the working plan.json.
  const arrived = arrivedSet(journal);
  const reopened = new Set(journal.filter((e) => e.action === 'reopened').map((e) => e.branch as string));
  const planPath = join(dir, 'plan.json');
  if (existsSync(planPath)) {
    const prev = JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan;
    const exclude = new Set([...arrived, ...reopened, ...frozen]);
    const drift = plansDiffer(prev, plan, exclude);
    if (drift.length) {
      appendJournal(dir, { action: 'halt', reason: 'plan-drift', branches: drift });
      console.error(`HALT: git moved under us — plan drift for not-yet-processed branch(es): ${drift.join(', ')}`);
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
  const held = heldRegistry(journal);
  const heldSet = new Set([...held.map((h) => h.branch), ...frozen]); // journal-HELD ∪ ledger-frozen
  const preReffed = preReffedSet(journal);

  let gated = false;

  for (const snap of plan.branches) {
    if (arrived.has(snap.branch)) continue; // already processed this pass (resume)

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
    const model: 'entry' | 'parents' = snap.parents[0]?.model ?? 'entry';
    const bp = await deriveBranch({
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
    });

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
        id: caseId(bp.branch, pp.case!.head.height),
        branch: bp.branch,
        parent: pp.parent,
        head: pp.case!.head,
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
      writeFileSync(join(caseDir, 'coldread-request.md'), coldReadRequest(caseFile, diffText.stdout.slice(0, 60000)));
      appendJournal(dir, {
        action: 'case',
        branch: bp.branch,
        parent: pp.parent,
        caseId: caseFile.id,
        height: caseFile.head.height,
        conflictedPaths: caseFile.conflictedPaths,
      });
      return true;
    };

    let branchGated = false;
    for (const pp of bp.parents) {
      if (branchGated) break; // halt at first case needing judgment per branch
      if (pp.verdict === 'merge') {
        const label = pp.model === 'entry' ? `main@height${pp.mergePoint!.height}` : pp.parent;
        const msg = `Merge ${label} into ${bp.branch} (propagation${pp.forced ? ', forced no-op' : ''})`;
        await recordPreRef(cli, dir, preReffed, bp.branch);
        const newRef = await journaledMerge(cli.repo, bp.branch, pp.mergePoint!.sha, msg);
        appendJournal(dir, {
          action: 'merge',
          branch: bp.branch,
          parent: pp.parent,
          head: pp.mergePoint,
          forced: pp.forced ?? false,
          newRef,
        });
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
    appendJournal(dir, { action: 'arrived', branch: bp.branch });
    arrived.add(bp.branch);
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
  console.error(sealed ? 'run complete — pass sealed (pass-complete)' : `run complete — ${missing}`);
  emit(cli, { watermark12: plan.watermark12, gated, sealed, missing, passDir: dir });
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

/** Transitive inventory descendants of `branch` in the plan snapshot. */
function transitiveDescendants(plan: PropagationPlan, branch: string): string[] {
  const edges = planEdges(plan);
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
 * The re-derived (from git + registry) authority for a case — everything the
 * driver acts on. `case-*.json` is only a POINTER; these values come from
 * merge-tree + the eligible line + the registry, NEVER the file (§7).
 */
interface ResolvedCase {
  id: string;
  branch: string;
  parent: string;
  model: 'entry' | 'parents';
  head: { sha: string; height: number };
  conflictedPaths: string[];
  automergeTree: string;
  reproduction: { command: string };
  tierFloor: Tier;
  /** Effective scope-guard mode, re-derived from config (per-feature > global). */
  scopeGuardMode: ScopeGuardMode;
  /** Trunk heights above the head still pending (PR "behind freeze" count). */
  pendingAbove: number;
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

  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) return { ok: false, errors: [...errors, 'no plan.json in the pass dir'] };
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan;
  const snap = plan.branches.find((b) => b.branch === caseFile.branch);
  if (!snap) return { ok: false, errors: [...errors, `branch '${caseFile.branch}' is not in the plan`] };

  const branchTip = await revParse(cli.repo, caseFile.branch);

  // (3) re-derive tier floor AND scope-guard mode from config (ignore the file's).
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

  // (1)+(2) re-derive the branch LIVE and locate the named parent's conflict.
  const model: 'entry' | 'parents' = snap.parents[0]?.model ?? 'entry';
  const bp = await deriveBranch({
    repo: cli.repo,
    branch: caseFile.branch,
    kind: snap.kind,
    model,
    parents: snap.parents.map((p) => p.parent),
    chain: ctx.chain,
    ancestors: snap.ancestors,
    tierFloor: floor,
    isLeaf: snap.isLeaf,
    alwaysMerge: snap.alwaysMerge,
    held: heldRegistry(journal),
  });
  const pp = bp.parents.find((p) => p.parent === caseFile.parent);
  if (!pp)
    return {
      ok: false,
      errors: [...errors, `parent '${caseFile.parent}' is not a legal parent of '${caseFile.branch}'`],
    };
  if (!pp.case) {
    return {
      ok: false,
      errors: [
        ...errors,
        `no live conflict for '${caseFile.branch}' <- '${caseFile.parent}' (head off the eligible line, or clean now)`,
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
      conflictedPaths: rc.conflictedPaths,
      automergeTree: rc.automergeTree,
      reproduction: rc.reproduction,
      tierFloor: floor,
      scopeGuardMode,
      pendingAbove,
    },
  };
}

/** Freeze a branch HELD: prepare the D-030 real-diff draft PR, journal `held`, ledger-freeze. */
async function freezeHeld(cli: Cli, dir: string, rc: ResolvedCase, notes: string[]): Promise<void> {
  const fixBranch = await preparePr(cli, dir, rc, { tier: 'held', atCommit: rc.head.sha });
  appendJournal(dir, {
    action: 'held',
    branch: rc.branch,
    caseId: rc.id,
    height: rc.head.height,
    conflictedPaths: rc.conflictedPaths,
    notes,
  });
  freezeInLedger(cli, rc.branch, rc.id, rc.head.sha, fixBranch); // durable cross-pass freeze (§8)
}

export async function cmdResolve(cli: Cli): Promise<number> {
  if (!cli.caseId || !cli.tier) {
    console.error('resolve: --case <id> and --tier <mechanical|judged|held> are required');
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
    appendJournal(dir, {
      action: 'halt',
      branch: caseFile.branch,
      caseId: caseFile.id,
      reason: 'case-reverification-failed',
      errors: rv.errors,
    });
    console.error(`HALT: case re-verification failed for ${caseFile.id}:\n  ${rv.errors.join('\n  ')}`);
    return 1;
  }
  const rc = rv.rc!;

  // Reopen targets = the branch + its transitive descendants (from the snapshot).
  const planSnap = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as PropagationPlan;
  const reopenTargets = [rc.branch, ...transitiveDescendants(planSnap, rc.branch)];
  const preReffed = preReffedSet(journal);

  // Direct HELD freeze path (§8): "cannot resolve" — no resolution commit, no
  // scope guard, no cold-read gate; prepare the real-diff draft PR and freeze.
  if (cli.tier === 'held') {
    if (!cli.execute) {
      console.error('DRY-RUN (no --execute): would freeze HELD and reopen descendants');
      emit(cli, { case: rc.id, tier: 'held', reopen: reopenTargets });
      return 0;
    }
    await freezeHeld(cli, dir, rc, ['agent declared cannot-resolve (--tier held)']);
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

  // Cold-read verdict VALIDATION (§7, D2): shape + freshness before it can gate.
  const verdictPath = join(caseDir, 'coldread-verdict.json');
  if (!existsSync(verdictPath)) {
    console.error(`resolve: cold-read verdict missing (${verdictPath}); produce it before resolving`);
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
    console.error(
      `resolve: cold-read verdict is stale — resolvedTree ${String(coldread.resolvedTree).slice(0, 12)} != this resolution's tree ${resolvedTree.slice(0, 12)}`,
    );
    return 2;
  }

  // Scope guard (§7): recomputed automerge/paths + config-derived mode; violation = HELD, no merge.
  const guard = await scopeGuard(cli.repo, rc.automergeTree, resolvedTree, rc.conflictedPaths, rc.scopeGuardMode);
  const notes: string[] = [];

  if (!cli.execute) {
    const tier: Tier =
      !guard.ok || coldread.verdict === 'reject'
        ? 'held'
        : applyFloor(cli.tier, rc.tierFloor === 'judged' ? 'judged' : 'clean');
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
    reopen(dir, reopenTargets);
    console.error(`held ${rc.id}: scope-guard violation [${guard.mode}] (${bad.join(', ')})`);
    emit(cli, { case: rc.id, tier: 'held', scopeGuard: guard, notes, reopen: reopenTargets });
    return 0;
  }

  // Cold-read rejection -> HELD.
  if (coldread.verdict === 'reject') {
    notes.push(`cold-read rejected -> HELD: ${coldread.notes}`);
    await freezeHeld(cli, dir, rc, notes);
    reopen(dir, reopenTargets);
    console.error(`held ${rc.id}: cold-read rejected`);
    emit(cli, { case: rc.id, tier: 'held', notes, reopen: reopenTargets });
    return 0;
  }

  // MECHANICAL/JUDGED: floor-raised, merge the RESOLVED tree at the recomputed head.
  const tier: Tier = applyFloor(cli.tier, rc.tierFloor === 'judged' ? 'judged' : 'clean');
  const msg = `Merge ${rc.parent} into ${rc.branch} (propagation, ${tier} resolution of ${rc.id})`;
  await recordPreRef(cli, dir, preReffed, rc.branch);
  const mergeCommit = await journaledResolvedMerge(cli.repo, rc.branch, rc.head.sha, resolvedTree, msg);
  appendJournal(dir, { action: 'resolved', branch: rc.branch, caseId: rc.id, tier, mergeCommit, notes });
  unfreezeInLedger(cli, rc.branch); // clearing a HELD unfreezes the ledger entry
  if (tier === 'judged') await preparePr(cli, dir, rc, { tier, atCommit: mergeCommit });
  reopen(dir, reopenTargets);
  console.error(`resolved ${rc.id} as ${tier}; merge commit ${mergeCommit.slice(0, 12)}`);
  emit(cli, { case: rc.id, tier, mergeCommit, scopeGuard: guard, reopen: reopenTargets });
  return 0;
}

/**
 * Prepare (never execute) the PR mechanics to the fork's D-030/D-031 standard:
 * a `fix/sweep/<date>-<topic>-h<height>` branch (height suffix so two cases on
 * one branch in one day cannot collide), a labeled ours/theirs body with the
 * concrete owner ask + verification pointers, and the exact `gh` commands.
 */
async function preparePr(
  cli: Cli,
  dir: string,
  rc: ResolvedCase,
  opts: { tier: Tier; atCommit: string },
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const topic = rc.branch.replace(/\//g, '-');
  const fixBranch = `fix/sweep/${date}-${topic}-h${rc.head.height}`;
  await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, opts.atCommit]);
  const prDir = join(dir, rc.id, 'pr');
  const bodyPath = join(prDir, 'body.md');
  const draft = opts.tier === 'held';
  const oursLabel = rc.branch;
  const theirsLabel =
    rc.model === 'entry' ? `upstream trunk @ height ${rc.head.height} (${rc.head.sha.slice(0, 12)})` : rc.parent;
  const body = [
    `# ${draft ? 'FREEZE (unresolved conflict)' : 'JUDGED resolution'} — ${rc.branch} (${rc.id})`,
    '',
    `**ours** = \`${oursLabel}\` (the fork branch)   ·   **theirs** = \`${theirsLabel}\``,
    '',
    '## Conflict',
    `Conflicted paths: ${rc.conflictedPaths.map((p) => `\`${p}\``).join(', ')}`,
    `Pending upstream commits above this point: ${rc.pendingAbove}`,
    '',
    '## Behavior at stake',
    `- behavior kept: \`${oursLabel}\`'s intent on the conflicted paths must survive.`,
    `- behavior lost if merged blindly: \`${theirsLabel}\`'s change to the same regions.`,
    '',
    '## The ask',
    draft
      ? `The driver could not mechanically resolve this. **Decision needed:** which side's behavior wins on ${rc.conflictedPaths.join(', ')} (or how to reconcile both)? The unmergeable state IS the conflict exhibit (D-030) — GitHub will flag it.`
      : `Cold-read confirmed the resolution. **Owner ack requested** before push (D-031): confirm the merged behavior on ${rc.conflictedPaths.join(', ')} is intended.`,
    '',
    '## Verification',
    `- reproduce the conflict: \`${rc.reproduction.command}\``,
    `- check the resolution is wrong by diffing the resolved tree against each side on the conflicted paths; any silently dropped delta on \`${theirsLabel}\` or \`${oursLabel}\` is a bug.`,
  ].join('\n');
  mkdirSync(prDir, { recursive: true });
  writeFileSync(bodyPath, body + '\n');
  const ghCmds = [
    `git push origin ${fixBranch}`,
    `gh pr create --base ${rc.branch} --head ${fixBranch} ${draft ? '--draft ' : ''}--title "${opts.tier}: ${rc.branch} sweep (h${rc.head.height})" --body-file ${bodyPath}`,
  ];
  writeFileSync(join(prDir, 'gh-commands.sh'), ghCmds.join('\n') + '\n');
  return fixBranch;
}

export async function cmdVerify(cli: Cli): Promise<number> {
  const { dir } = await passContext(cli); // attaches to the open pass
  const journal = readJournal(dir);
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const recipe = cli.recipe ?? registry.scope.recipe ?? [];
  if (recipe.length === 0) {
    console.error('verify: no recipe (pass --recipe a,b,c or add `recipe:` to registry/scope.yaml)');
    return 2;
  }
  const commands: VerifyCommand[] = cli.commandsFile
    ? (JSON.parse(readFileSync(cli.commandsFile, 'utf8')) as VerifyCommand[])
    : VERIFY_COMMANDS;
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): would rebuild the recipe + run CI commands in a temp worktree');
    emit(cli, { recipe, commands });
    return 0;
  }

  const first = await verifyEverything(cli.repo, { recipe, commands });
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
  // Roll the offender back to its journaled pre-ref, HELD(gate), ledger-freeze,
  // then re-verify (its bad merge is gone) per verify.ts's model.
  const preRef = lastPreRef(journal, offender);
  if (!preRef) {
    appendJournal(dir, { action: 'verify', ok: false, offender, note: 'no pre-ref to roll back to' });
    console.error(`verify: RED offender ${offender} has no journaled pre-ref — cannot roll back`);
    emit(cli, { ok: false, offender, note: 'no pre-ref' });
    return 1;
  }
  const current = await revParse(cli.repo, offender);
  await resetBranchRef(cli.repo, offender, preRef, current);
  appendJournal(dir, { action: 'pre-ref-rollback', branch: offender, to: preRef });
  appendJournal(dir, {
    action: 'held',
    branch: offender,
    caseId: `gate-${offender.replace(/\//g, '__')}`,
    height: -1,
    conflictedPaths: [],
    reason: 'gate',
  });
  freezeInLedger(cli, offender, 'gate', null, null); // gate hold has no conflicting head / PR
  const re = await verifyEverything(cli.repo, { recipe, commands });
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
  const openCases = journal.filter((e) => e.action === 'case').map((e) => e.caseId as string);
  const resolvedCases = new Set(
    journal.filter((e) => e.action === 'resolved' || e.action === 'held').map((e) => e.caseId as string),
  );
  const open = openCases.filter((c) => !resolvedCases.has(c));
  console.log(`open cases: ${open.length}${open.length ? ` — ${open.join(', ')}` : ''}`);
  return 0;
}

const HANDLERS: Record<string, (cli: Cli) => Promise<number>> = {
  plan: cmdPlan,
  run: cmdRun,
  resolve: cmdResolve,
  verify: cmdVerify,
  unfreeze: cmdUnfreeze,
  status: cmdStatus,
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

export { parseCli };
export type { Cli };
