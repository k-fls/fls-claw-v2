/**
 * scripts/sweep/propagate.ts — mechanical propagation driver CLI
 * (PROPAGATION.md §8, D-035..D-040).
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/propagate.ts <plan|run|resolve|status> [flags]
 *
 * Subcommands:
 *   plan                          pin the watermark, enumerate heights, derive coverage,
 *                                 emit plan.json (pure derivation, idempotent)
 *   run                           execute the plan: CLEAN merges + skips + DEFERRED marks;
 *                                 halt at the first case needing judgment PER BRANCH (emit
 *                                 case files), continue with siblings          (MUTATES refs)
 *   resolve --case ID --tier T    scope-guard + cold-read gate, then merge (MECHANICAL),
 *                                 prepare a PR (JUDGED) or freeze (HELD)        (MUTATES refs)
 *   status                        human-readable pass state from the journal + derivation
 *
 * Flags:
 *   --repo <path>            repo to operate on                (default: cwd)
 *   --workspace <dir>        artifacts root                    (default: cwd)
 *   --inventory <dir>        live feature inventory            (default: latest bootstrap snapshot)
 *   --scope-config <file>    scope policy                      (default: registry/scope.yaml)
 *   --routing-config <file>  router/scan tuning                (default: registry/routing.yaml)
 *   --upstream <ref>         upstream ref (watermark source)   (default: upstream/main)
 *   --base <ref>             trunk-chain fork point            (default: FORK_POINT else merge-base)
 *   --execute                perform mutations (run/resolve); without it, dry-run
 *   --case <id>              resolve: the case id
 *   --tier <mechanical|judged>  resolve: the agent's claimed tier
 *   --resolved-ref <ref>     resolve: commit carrying the agent's resolution (tree source)
 *   --out <file>             write the subcommand's JSON artifact to a file
 *
 * Artifacts live under <workspace>/propagation/pass-<watermark12>/:
 *   plan.json, step-<branch>.json, case-<branch>-hN.json (+ coldread-request.md),
 *   journal.jsonl (append-only). The driver PREPARES PR branches/bodies/gh commands
 *   but never calls gh / the network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

import { DEFAULT_UPSTREAM_REF, FORK_POINT } from './config.js';
import { commitTreeMerge, git, revParse, refExists, worktreeBranches } from './git.js';
import { loadRegistry } from './registry.js';
import { scopeGuard } from './scope-guard.js';
import { buildStepFile, caseId, readCaseFile, verifyStepFile, writeJsonFile } from './steps.js';
import { applyFloor, demoteForScopeViolation, isClaimableTier } from './tiers.js';
import { allParentsSkipped, deriveBranch, derivePlan, plansEquivalent, shortestUnskipChain } from './plan.js';
import { deriveCoverage, enumerateChain } from './heights.js';
import type { BranchPlan, CaseFile, ColdReadVerdict, HeldRecord, PropagationPlan, Tier } from './types.js';

interface Cli {
  cmd: string;
  repo: string;
  workspace: string;
  inventory: string | null;
  scopeFile?: string;
  routingFile?: string;
  upstream: string;
  base?: string;
  execute: boolean;
  caseId?: string;
  tier?: string;
  resolvedRef?: string;
  out?: string;
}

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/propagate.ts <plan|run|resolve|status> [--repo <path>] [--workspace <dir>] [--execute] [--case <id>] [--tier <t>] [flags]';

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

/** Branches that finished processing this pass (barrier arrival — journal). */
export function arrivedSet(journal: JournalEntry[]): Set<string> {
  return new Set(journal.filter((e) => e.action === 'arrived').map((e) => e.branch as string));
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

async function derive(cli: Cli, held: HeldRecord[]): Promise<PropagationPlan> {
  const base = await resolveBase(cli);
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  return derivePlan({
    repo: cli.repo,
    upstreamRef: cli.upstream,
    base,
    features: registry.features,
    scope: registry.scope,
    held,
  });
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

function caseFileFor(bp: BranchPlan, pp: BranchPlan['parents'][number]): CaseFile {
  const c = pp.case!;
  return {
    schemaVersion: 1,
    id: caseId(bp.branch, c.head.height),
    branch: bp.branch,
    parent: pp.parent,
    head: c.head,
    tierFloor: bp.tierFloor,
    conflictedPaths: c.conflictedPaths,
    automergeTree: c.automergeTree,
    reproduction: c.reproduction,
    deferredCheck: { firstConflictHeight: c.head.height, transitiveAncestors: bp.ancestors },
  };
}

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
  // Held registry is empty until a resolve marks something HELD; but if a
  // journal exists (resumed pass) we honour it so DEFERRED re-derivation is stable.
  const wmChain = await enumerateChain(cli.repo, cli.upstream, await resolveBase(cli));
  const dir = passDir(cli.workspace, wmChain.watermark.slice(0, 12));
  const journal = readJournal(dir);
  const plan = await derive(cli, heldRegistry(journal));

  const planPath = join(dir, 'plan.json');
  if (existsSync(planPath)) {
    const prev = JSON.parse(readFileSync(planPath, 'utf8')) as PropagationPlan;
    if (!plansEquivalent(prev, plan)) {
      console.error('FATAL: re-derived plan does not match the existing plan.json — git moved under us; halting');
      emit(cli, { mismatch: true, plan });
      return 1;
    }
  }
  writeJsonFile(planPath, plan);
  console.error(`plan written: ${planPath} (watermark ${plan.watermark12}, ${plan.branches.length} branches)`);
  emit(cli, plan);
  return 0;
}

export async function cmdRun(cli: Cli): Promise<number> {
  const base = await resolveBase(cli);
  const chain = await enumerateChain(cli.repo, cli.upstream, base);
  const dir = passDir(cli.workspace, chain.watermark.slice(0, 12));
  const journal = readJournal(dir);
  const plan = await derive(cli, heldRegistry(journal));
  const passHasProgress = plan.chainLength > 0;

  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): run plan follows');
    emit(cli, plan);
    return 0;
  }
  writeJsonFile(join(dir, 'plan.json'), plan);

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

  const arrived = arrivedSet(journal);
  let gated = false;

  for (const snap of plan.branches) {
    if (arrived.has(snap.branch)) continue; // already processed this pass (resume)

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

    const emitCase = async (pp: (typeof bp.parents)[number]): Promise<void> => {
      const caseFile = caseFileFor(bp, pp);
      const caseDir = join(dir, caseFile.id);
      writeJsonFile(join(caseDir, 'case.json'), caseFile);
      const nowTip = await revParse(cli.repo, bp.branch);
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
    };

    let branchGated = false;
    for (const pp of bp.parents) {
      if (branchGated) break; // halt at first case needing judgment per branch
      if (pp.verdict === 'merge') {
        const label = pp.model === 'entry' ? `main@height${pp.mergePoint!.height}` : pp.parent;
        const msg = `Merge ${label} into ${bp.branch} (propagation${pp.forced ? ', forced no-op' : ''})`;
        const newRef = await journaledMerge(cli.repo, bp.branch, pp.mergePoint!.sha, msg);
        appendJournal(dir, {
          action: 'merge',
          branch: bp.branch,
          parent: pp.parent,
          head: pp.mergePoint,
          forced: pp.forced ?? false,
          newRef,
        });
        // A clean merge up to the merge point can still leave a conflict ABOVE
        // it (§3 step 4): emit the case and halt this branch.
        if (pp.case) {
          await emitCase(pp);
          branchGated = true;
          gated = true;
        }
      } else if (pp.verdict === 'defer') {
        appendJournal(dir, { action: 'defer', branch: bp.branch, parent: pp.parent, deferredTo: pp.deferredTo });
      } else if (pp.verdict === 'case') {
        await emitCase(pp);
        branchGated = true;
        gated = true;
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

  console.error(
    gated ? 'run complete — one or more branches have open cases (resolve them)' : 'run complete — no open cases',
  );
  emit(cli, { watermark12: plan.watermark12, gated, passDir: dir });
  return 0;
}

export async function cmdResolve(cli: Cli): Promise<number> {
  if (!cli.caseId || !cli.tier) {
    console.error('resolve: --case <id> and --tier <mechanical|judged> are required');
    return 2;
  }
  if (!isClaimableTier(cli.tier)) {
    console.error(`resolve: --tier must be 'mechanical' or 'judged' (got '${cli.tier}')`);
    return 2;
  }
  const base = await resolveBase(cli);
  const chain = await enumerateChain(cli.repo, cli.upstream, base);
  const dir = passDir(cli.workspace, chain.watermark.slice(0, 12));
  const caseDir = join(dir, cli.caseId);
  const casePath = join(caseDir, 'case.json');
  if (!existsSync(casePath)) {
    console.error(`resolve: case file not found: ${casePath}`);
    return 2;
  }
  const caseFile = readCaseFile(casePath);
  if (!cli.resolvedRef) {
    console.error('resolve: --resolved-ref <ref> (the agent resolution commit) is required');
    return 2;
  }
  const resolvedTree = await treeOf(cli.repo, cli.resolvedRef);

  // Scope guard (§7, D-038): resolution may only touch the case's conflicted paths.
  const guard = await scopeGuard(cli.repo, caseFile.automergeTree, resolvedTree, caseFile.conflictedPaths);

  // Cold-read gate: the driver requires a context-free verdict before accepting.
  const verdictPath = join(caseDir, 'coldread-verdict.json');
  let coldread: ColdReadVerdict | null = null;
  if (existsSync(verdictPath)) coldread = JSON.parse(readFileSync(verdictPath, 'utf8')) as ColdReadVerdict;

  // Tier ladder: floor raise (edition/flagged), scope-guard demotion, cold-read rejection.
  let tier: Tier = applyFloor(cli.tier, caseFile.tierFloor === 'judged' ? 'judged' : 'clean');
  const notes: string[] = [];
  if (!guard.ok) {
    tier = demoteForScopeViolation(tier as Exclude<Tier, 'deferred'>);
    notes.push(`scope-guard violation: extra paths ${guard.extraPaths.join(', ')} -> demote`);
  }
  if (!coldread) {
    console.error(`resolve: cold-read verdict missing (${verdictPath}); produce it before resolving`);
    return 2;
  }
  if (coldread.verdict === 'reject') {
    tier = 'held';
    notes.push('cold-read rejected -> HELD');
  }

  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): resolve decision follows');
    emit(cli, { case: caseFile.id, claimed: cli.tier, tier, scopeGuard: guard, coldread, notes });
    return 0;
  }

  // The conflicting head sha is carried in the case file (the commit to merge).
  const headSha = caseFile.head.sha;

  if (tier === 'mechanical' || tier === 'judged') {
    const msg = `Merge ${caseFile.parent} into ${caseFile.branch} (propagation, ${tier} resolution of ${caseFile.id})`;
    const mergeCommit = await journaledResolvedMerge(cli.repo, caseFile.branch, headSha, resolvedTree, msg);
    appendJournal(dir, { action: 'resolved', branch: caseFile.branch, caseId: caseFile.id, tier, mergeCommit, notes });
    if (tier === 'judged') {
      await preparePr(cli, dir, caseFile, { tier, atCommit: mergeCommit });
    }
    console.error(`resolved ${caseFile.id} as ${tier}; merge commit ${mergeCommit.slice(0, 12)}`);
    emit(cli, { case: caseFile.id, tier, mergeCommit, scopeGuard: guard, notes });
    return 0;
  }

  // HELD: real-diff draft PR at the parent conflicting head, freeze, no merge.
  await preparePr(cli, dir, caseFile, { tier: 'held', atCommit: headSha });
  appendJournal(dir, {
    action: 'held',
    branch: caseFile.branch,
    caseId: caseFile.id,
    height: caseFile.head.height,
    conflictedPaths: caseFile.conflictedPaths,
    notes,
  });
  console.error(`held ${caseFile.id}; branch frozen, real-diff draft PR prepared`);
  emit(cli, { case: caseFile.id, tier: 'held', notes });
  return 0;
}

/** Prepare (never execute) the PR mechanics: local fix branch, gh commands, body file. */
async function preparePr(
  cli: Cli,
  dir: string,
  caseFile: CaseFile,
  opts: { tier: Tier; atCommit: string },
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const topic = caseFile.branch.replace(/\//g, '-');
  const fixBranch = `fix/sweep/${date}-${topic}`;
  await git(cli.repo, ['update-ref', `refs/heads/${fixBranch}`, opts.atCommit]);
  const prDir = join(dir, caseFile.id, 'pr');
  const bodyPath = join(prDir, 'body.md');
  const draft = opts.tier === 'held';
  const body = [
    `# ${draft ? 'FREEZE' : 'JUDGED'} — ${caseFile.branch} (${caseFile.id})`,
    '',
    `Conflicted paths: ${caseFile.conflictedPaths.join(', ')}`,
    `Reproduction: \`${caseFile.reproduction.command}\``,
    draft ? '\nThe unmergeable state IS the conflict exhibit (D-030 shape).' : '\nCold-read confirmed resolution.',
  ].join('\n');
  mkdirSync(prDir, { recursive: true });
  writeFileSync(bodyPath, body + '\n');
  const ghCmds = [
    `git push origin ${fixBranch}`,
    `gh pr create --base ${caseFile.branch} --head ${fixBranch} ${draft ? '--draft ' : ''}--title "${opts.tier}: ${caseFile.branch} sweep" --body-file ${bodyPath}`,
  ];
  writeFileSync(join(prDir, 'gh-commands.sh'), ghCmds.join('\n') + '\n');
}

export async function cmdStatus(cli: Cli): Promise<number> {
  const base = await resolveBase(cli);
  const chain = await enumerateChain(cli.repo, cli.upstream, base);
  const dir = passDir(cli.workspace, chain.watermark.slice(0, 12));
  const journal = readJournal(dir);
  console.log(`repo:       ${cli.repo}`);
  console.log(`watermark:  ${chain.watermark} (${chain.heads.length} trunk heights from ${chain.base.slice(0, 12)})`);
  console.log(`pass dir:   ${dir}`);
  console.log(`journal:    ${journal.length} entries`);
  const counts: Record<string, number> = {};
  for (const e of journal) counts[e.action] = (counts[e.action] ?? 0) + 1;
  for (const [action, n] of Object.entries(counts).sort()) console.log(`  ${action.padEnd(10)} ${n}`);
  const held = heldRegistry(journal);
  if (held.length) {
    console.log('HELD:');
    for (const h of held)
      console.log(`  ${h.branch} @height ${h.height} (${h.caseId}) paths=${h.conflictedPaths.join(',')}`);
  }
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
