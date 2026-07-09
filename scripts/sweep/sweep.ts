/**
 * scripts/sweep/sweep.ts — upstream-sweep pipeline CLI (thin dispatcher).
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/sweep.ts <subcommand> [flags]
 *
 * Subcommands (pipeline spec §5; read-only unless marked MUTATES):
 *   fetch              git fetch upstream origin --prune          (MUTATES remotes state)
 *   ff-main            fast-forward main to upstream/main         (MUTATES)
 *   scan               conflict scan + stop points + PoIs -> sweep-report.json
 *   stop-points        per-branch largest clean first-parent prefix
 *   merge              DAG-ordered propagation to stop points     (MUTATES)
 *   verify             everything rebuild + test matrix in a temp worktree
 *   record             fold report/outcomes/verify into the state branch (MUTATES)
 *   status             human-readable sweep-state summary
 *   validate-registry  6-rule registry validator (exit 1 on ALERTs)
 *   route              score report PoIs against feature entries
 *   replay             replay registry test-cases (exit 1 on failure)
 *
 * Common flags:
 *   --repo <path>          repo to operate on          (default: cwd)
 *   --state-branch <name>  registry/state branch       (default: maint/fork-registry)
 *   --execute              actually perform mutations; WITHOUT it every
 *                          mutating subcommand only prints its plan (dry-run)
 *   --upstream <ref>       upstream ref                (default: upstream/main)
 *   --base <ref>           PoI range base              (default: state lastSweep.upstreamTip, else merge-base(main, upstream))
 *   --branch <name>        restrict to one branch (repeatable)
 *   --out <file>           write the subcommand's JSON artifact to a file
 *   --report <file>        input sweep-report.json     (merge/route/record)
 *   --outcomes <file>      input merge-outcomes JSON   (record/verify --rollback)
 *   --verify-result <file> input verify result JSON    (record)
 *   --recipe <a,b,c>       verify recipe override      (default: sweep-scope.yaml recipe)
 *   --commands-file <file> verify command list JSON [{cmd, cwd?}] (test injection)
 *   --case <id>            replay a single case
 *
 * Safety model: mutating stages are dry-run by default; `main` only ever
 * fast-forwards; everything* / design/* / docs/* / maint/* branches are
 * never merge targets; state mutations are journaled commits on the state
 * branch (never checked out). See scripts/sweep/README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  DEFAULT_STATE_BRANCH,
  DEFAULT_UPSTREAM_REF,
  EXCLUDED_BRANCH_GLOBS,
  LARGE_ANY_BYTES,
  SENSITIVE_PATHS,
  VERIFY_COMMANDS,
} from './config.js';
import { git, isAncestor, localBranches, refExists, revParse, worktreeBranches } from './git.js';
import { globMatchAny } from './globs.js';
import { executeMerges, planMerges, rollbackBranch, type MergeOutcome } from './merge.js';
import { recordSweep } from './record.js';
import { loadRegistry, loadReplayCases, loadRoutingConfig } from './registry.js';
import { replayCases } from './replay.js';
import { routePois } from './routing.js';
import { buildReport, enrichPois, type BuildReportOptions } from './scan.js';
import { resolveScope, type ScopeResult } from './scope.js';
import { findStopPoint } from './stop-points.js';
import { readSweepState, writeSweepState } from './state.js';
import type { SweepReport } from './types.js';
import { validateRegistry } from './validate.js';
import { verifyEverything, type VerifyCommand, type VerifyResult } from './verify.js';

interface Cli {
  cmd: string;
  repo: string;
  stateBranch: string;
  execute: boolean;
  upstream: string;
  base?: string;
  branches: string[];
  out?: string;
  report?: string;
  outcomes?: string;
  verifyResult?: string;
  recipe?: string[];
  commandsFile?: string;
  caseId?: string;
  rollback: boolean;
}

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/sweep.ts <fetch|ff-main|scan|stop-points|merge|verify|record|status|validate-registry|route|replay> [--repo <path>] [--state-branch <name>] [--execute] [flags]';

function parseCli(argv: string[]): Cli {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.error(USAGE);
    process.exit(2);
  }
  const cli: Cli = {
    cmd,
    repo: process.cwd(),
    stateBranch: DEFAULT_STATE_BRANCH,
    execute: false,
    upstream: DEFAULT_UPSTREAM_REF,
    branches: [],
    rollback: false,
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
      case '--state-branch':
        cli.stateBranch = need();
        break;
      case '--execute':
        cli.execute = true;
        break;
      case '--upstream':
        cli.upstream = need();
        break;
      case '--base':
        cli.base = need();
        break;
      case '--branch':
        cli.branches.push(need());
        break;
      case '--out':
        cli.out = need();
        break;
      case '--report':
        cli.report = need();
        break;
      case '--outcomes':
        cli.outcomes = need();
        break;
      case '--verify-result':
        cli.verifyResult = need();
        break;
      case '--recipe':
        cli.recipe = need().split(',').filter(Boolean);
        break;
      case '--commands-file':
        cli.commandsFile = need();
        break;
      case '--case':
        cli.caseId = need();
        break;
      case '--rollback':
        cli.rollback = true;
        break;
      default:
        console.error(`Unknown flag ${flag}\n${USAGE}`);
        process.exit(2);
    }
  }
  return cli;
}

function emit(cli: Cli, artifact: unknown): void {
  const json = JSON.stringify(artifact, null, 2);
  if (cli.out) {
    writeFileSync(cli.out, json + '\n');
    console.log(`wrote ${cli.out}`);
  } else {
    console.log(json);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Scope from registry; namespace-enumeration fallback while the registry is being seeded. */
async function scopeBranches(cli: Cli): Promise<{ scope: ScopeResult; warnings: string[] }> {
  const registry = await loadRegistry(cli.repo, cli.stateBranch);
  const warnings = [...registry.warnings];
  let scope = await resolveScope(cli.repo, registry.features, registry.scope);
  if (scope.ordered.length === 0) {
    warnings.push(
      'registry produced an empty scope — falling back to module/*|feat/*|edition/* + main_patched enumeration',
    );
    const branches = (await localBranches(cli.repo)).filter(
      (b) => (/^(module|feat|edition)\//.test(b) || b === 'main_patched') && !globMatchAny(EXCLUDED_BRANCH_GLOBS, b),
    );
    scope = {
      ordered: [
        ...(branches.includes('main_patched') ? ['main_patched'] : []),
        ...branches.filter((b) => b !== 'main_patched').sort(),
      ],
      edges: {},
      warnings: [],
    };
  }
  warnings.push(...scope.warnings);
  if (cli.branches.length > 0) {
    scope = { ...scope, ordered: scope.ordered.filter((b) => cli.branches.includes(b)) };
  }
  return { scope, warnings };
}

async function resolveRangeBase(cli: Cli): Promise<string> {
  if (cli.base) return cli.base;
  const state = await readSweepState(cli.repo, cli.stateBranch);
  if (state.lastSweep?.upstreamTip && (await refExists(cli.repo, state.lastSweep.upstreamTip))) {
    return state.lastSweep.upstreamTip;
  }
  const res = await git(cli.repo, ['merge-base', 'main', cli.upstream]);
  return res.stdout.trim();
}

async function cmdFetch(cli: Cli): Promise<number> {
  if (!cli.execute) {
    console.log(`DRY-RUN: would run: git fetch upstream origin --prune  (repo: ${cli.repo})`);
    return 0;
  }
  await git(cli.repo, ['fetch', 'upstream', 'origin', '--prune']);
  const tip = await revParse(cli.repo, cli.upstream);
  const state = await readSweepState(cli.repo, cli.stateBranch);
  const open = state.openPois.filter((p) => p.state === 'open').length;
  console.log(`${cli.upstream} = ${tip}`);
  if (state.lastSweep?.upstreamTip === tip && open === 0) {
    console.log('up to date with last sweep and no open PoIs — nothing to do');
  }
  return 0;
}

async function cmdFfMain(cli: Cli): Promise<number> {
  const mainTip = await revParse(cli.repo, 'main');
  const upstreamTip = await revParse(cli.repo, cli.upstream);
  if (mainTip === upstreamTip) {
    console.log('main already at upstream tip');
    return 0;
  }
  if (!(await isAncestor(cli.repo, 'main', cli.upstream))) {
    console.error(
      `FATAL: main (${mainTip.slice(0, 12)}) is not an ancestor of ${cli.upstream} — mirror invariant violated; STOP and alert the owner`,
    );
    return 1;
  }
  if (!cli.execute) {
    console.log(`DRY-RUN: would fast-forward main ${mainTip.slice(0, 12)} -> ${upstreamTip.slice(0, 12)}`);
    return 0;
  }
  const checkedOut = await worktreeBranches(cli.repo);
  const wt = checkedOut.get('main');
  if (wt) await git(cli.repo, ['merge', '--ff-only', cli.upstream], { cwd: wt });
  else await git(cli.repo, ['update-ref', 'refs/heads/main', upstreamTip, mainTip]);
  console.log(`main fast-forwarded to ${upstreamTip}`);
  return 0;
}

async function cmdScan(cli: Cli): Promise<number> {
  const { scope, warnings } = await scopeBranches(cli);
  const rangeBase = await resolveRangeBase(cli);
  // Scan tuning from routing.yaml (registry is the tuning surface, not code).
  const { routing } = await loadRoutingConfig(cli.repo, cli.stateBranch);
  const opts: BuildReportOptions = {};
  if (routing.largeNewFileKb !== undefined) {
    opts.largeSourceBytes = routing.largeNewFileKb * 1024;
    opts.largeAnyBytes = Math.max(routing.largeNewFileKb * 1024, LARGE_ANY_BYTES);
  }
  if (routing.sensitiveSurfaces) opts.sensitivePaths = [...SENSITIVE_PATHS, ...routing.sensitiveSurfaces];
  const report = await buildReport(cli.repo, scope.ordered, cli.upstream, rangeBase, opts, warnings);
  emit(cli, report);
  return 0;
}

async function cmdStopPoints(cli: Cli): Promise<number> {
  const { scope } = await scopeBranches(cli);
  const results = [];
  for (const branch of scope.ordered) results.push(await findStopPoint(cli.repo, branch, cli.upstream));
  emit(cli, results);
  return 0;
}

async function cmdMerge(cli: Cli): Promise<number> {
  const state = await readSweepState(cli.repo, cli.stateBranch);
  let targets: { branch: string; stopPoint: string | null; upToDate: boolean }[];
  if (cli.report) {
    const report = readJson<SweepReport>(cli.report);
    targets = Object.values(report.branches)
      .filter((b) => cli.branches.length === 0 || cli.branches.includes(b.branch))
      .map((b) => ({ branch: b.branch, stopPoint: b.stopPoint, upToDate: b.upToDate }));
  } else {
    const { scope } = await scopeBranches(cli);
    targets = [];
    for (const branch of scope.ordered) {
      const sp = await findStopPoint(cli.repo, branch, cli.upstream);
      targets.push({ branch, stopPoint: sp.stopPoint, upToDate: sp.upToDate });
    }
  }
  const plan = await planMerges(cli.repo, targets, state);
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): merge plan follows');
    emit(cli, plan);
    return 0;
  }
  const { outcomes, rrCacheExport } = await executeMerges(cli.repo, plan, cli.stateBranch);
  // Journal the merge action (+ any new rerere resolutions) immediately.
  const st = await readSweepState(cli.repo, cli.stateBranch);
  await writeSweepState(
    cli.repo,
    cli.stateBranch,
    st,
    {
      action: 'merge',
      merged: outcomes
        .filter((o) => o.result === 'merged')
        .map((o) => ({ branch: o.branch, pre: o.preRef, post: o.newRef })),
      gated: outcomes.filter((o) => o.result === 'gated').map((o) => o.branch),
      rrCacheNewFiles: Object.keys(rrCacheExport).length,
    },
    rrCacheExport,
    'sweep: merge journal + rr-cache export',
  );
  emit(cli, outcomes);
  return outcomes.some((o) => o.result === 'gated' || o.result === 'dirty-worktree') ? 1 : 0;
}

async function cmdVerify(cli: Cli): Promise<number> {
  const registry = await loadRegistry(cli.repo, cli.stateBranch);
  const recipe = cli.recipe ?? registry.scope.recipe ?? [];
  if (recipe.length === 0) {
    console.error('verify: no recipe (pass --recipe a,b,c or add `recipe:` to fork-registry/sweep-scope.yaml)');
    return 2;
  }
  const commands: VerifyCommand[] = cli.commandsFile ? readJson<VerifyCommand[]>(cli.commandsFile) : VERIFY_COMMANDS;
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): would rebuild + test in a temp worktree');
    emit(cli, { baseRef: 'main', recipe, commands });
    return 0;
  }
  const result = await verifyEverything(cli.repo, { recipe, commands });
  if (!result.ok && result.offender && cli.rollback) {
    if (!cli.outcomes) {
      console.error('verify --rollback needs --outcomes <file> (merge stage output) to know pre-merge refs');
      return 2;
    }
    const outcomes = readJson<MergeOutcome[]>(cli.outcomes);
    const offender = outcomes.find((o) => o.branch === result.offender && o.result === 'merged');
    if (offender) {
      await rollbackBranch(cli.repo, offender);
      console.error(
        `rolled back ${offender.branch} to ${offender.preRef.slice(0, 12)} (demote to gate in record stage)`,
      );
    }
  }
  emit(cli, result);
  return result.ok ? 0 : 1;
}

async function cmdRecord(cli: Cli): Promise<number> {
  if (!cli.report) {
    console.error('record: --report <sweep-report.json> is required');
    return 2;
  }
  const report = readJson<SweepReport>(cli.report);
  const outcomes = cli.outcomes ? readJson<MergeOutcome[]>(cli.outcomes) : undefined;
  const verify = cli.verifyResult ? readJson<VerifyResult>(cli.verifyResult) : undefined;
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): would commit state update to ' + cli.stateBranch);
    const { applyRecord } = await import('./record.js');
    const prev = await readSweepState(cli.repo, cli.stateBranch);
    emit(cli, applyRecord(prev, { report, outcomes, verify }));
    return 0;
  }
  const { state, commit } = await recordSweep(cli.repo, cli.stateBranch, { report, outcomes, verify });
  console.error(`state committed: ${commit} on ${cli.stateBranch}`);
  emit(cli, state);
  return 0;
}

async function cmdStatus(cli: Cli): Promise<number> {
  const state = await readSweepState(cli.repo, cli.stateBranch);
  const upstreamTip = (await refExists(cli.repo, cli.upstream)) ? await revParse(cli.repo, cli.upstream) : null;
  console.log(`state branch: ${cli.stateBranch}`);
  console.log(
    state.lastSweep?.upstreamTip
      ? `last sweep:   ${state.lastSweep.id} -> ${state.lastSweep.upstreamTip.slice(0, 12)} (${state.lastSweep.result})`
      : 'last sweep:   never',
  );
  if (upstreamTip) {
    const pending = state.lastSweep?.upstreamTip && upstreamTip !== state.lastSweep.upstreamTip;
    console.log(
      `${cli.upstream}: ${upstreamTip.slice(0, 12)}${pending ? '  ** NEW upstream commits since last sweep **' : ''}`,
    );
  }
  const branches = Object.entries(state.branches);
  console.log(`branches tracked: ${branches.length}`);
  for (const [name, bs] of branches) {
    const merged = bs.lastMergedUpstream ? bs.lastMergedUpstream.slice(0, 12) : 'never';
    const extras = [bs.frozenBy ? `frozen by ${bs.frozenBy}` : '', bs.notes].filter(Boolean).join('; ');
    console.log(`  ${bs.status.padEnd(8)} ${name}  lastMerged=${merged}${extras ? `  [${extras}]` : ''}`);
  }
  const open = state.openPois.filter((p) => p.state === 'open');
  console.log(`open PoIs: ${open.length}`);
  for (const p of open)
    console.log(`  [${p.class}/${p.type}] ${p.id}${p.branches.length ? ` branches=${p.branches.join(',')}` : ''}`);
  return 0;
}

async function cmdValidateRegistry(cli: Cli): Promise<number> {
  const registry = await loadRegistry(cli.repo, cli.stateBranch);
  for (const w of registry.warnings) console.error(`LOAD WARN: ${w}`);
  const result = await validateRegistry(cli.repo, registry.features);
  emit(cli, result);
  return result.ok ? 0 : 1;
}

async function cmdRoute(cli: Cli): Promise<number> {
  if (!cli.report) {
    console.error('route: --report <sweep-report.json> is required');
    return 2;
  }
  const report = readJson<SweepReport>(cli.report);
  const registry = await loadRegistry(cli.repo, cli.stateBranch);
  const validation = await validateRegistry(cli.repo, registry.features);
  const pois = await enrichPois(cli.repo, report);
  const outcome = routePois(pois, registry.features, registry.routing, validation.alertedFeatureIds);
  emit(cli, { validationAlerts: validation.alertedFeatureIds, ...outcome });
  return 0;
}

async function cmdReplay(cli: Cli): Promise<number> {
  const { cases, warnings } = await loadReplayCases(cli.repo, cli.stateBranch);
  for (const w of warnings) console.error(`LOAD WARN: ${w}`);
  if (cases.length === 0) {
    console.error(`replay: no cases found on ${cli.stateBranch}:fork-registry/test-cases/`);
    return 2;
  }
  const results = await replayCases(cli.repo, cases, cli.caseId);
  if (cli.caseId && results.length === 0) {
    console.error(`replay: case '${cli.caseId}' not found`);
    return 2;
  }
  emit(cli, results);
  return results.every((r) => r.pass) ? 0 : 1;
}

const HANDLERS: Record<string, (cli: Cli) => Promise<number>> = {
  fetch: cmdFetch,
  'ff-main': cmdFfMain,
  scan: cmdScan,
  'stop-points': cmdStopPoints,
  merge: cmdMerge,
  verify: cmdVerify,
  record: cmdRecord,
  status: cmdStatus,
  'validate-registry': cmdValidateRegistry,
  route: cmdRoute,
  replay: cmdReplay,
};

const cli = parseCli(process.argv.slice(2));
const handler = HANDLERS[cli.cmd];
if (!handler) {
  console.error(`Unknown subcommand '${cli.cmd}'\n${USAGE}`);
  process.exit(2);
}
handler(cli).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
