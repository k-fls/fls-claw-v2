/**
 * scripts/sweep/sweep.ts — upstream-sweep pipeline CLI (thin dispatcher).
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/sweep.ts <subcommand> [flags]
 *
 * Subcommands (pipeline spec §5; read-only unless marked MUTATES):
 *   fetch              git fetch upstream origin --prune          (MUTATES remotes state)
 *   ff-main            fast-forward main to upstream/main         (MUTATES)
 *   scan               conflict scan vs ACTUAL merge sources + stop points + PoIs -> sweep-report.json
 *   stop-points        largest clean first-parent prefix (upstream-chain branches only)
 *   merge              DAG-ordered propagation: parents' tips for inventory
 *                      branches, upstream stop point for main_patched/edition-
 *                      ancestors (MUTATES)
 *   verify             everything rebuild + test matrix in a temp worktree
 *   record             fold report/outcomes/verify into the workspace ledger (writes files)
 *   status             sweep summary: derived merge-base + ledger overrides
 *                      (--report adds per-branch scan verdicts)
 *   validate-registry  6-rule inventory validator (exit 1 on ALERTs)
 *   route              score report PoIs against feature entries
 *   replay             replay test-cases from the local tree (exit 1 on failure)
 *   seed-rerere        rebuild the workspace rr-cache from pinned resolution cases (MUTATES .git/rr-cache)
 *
 * Common flags:
 *   --repo <path>          repo to operate on              (default: cwd)
 *   --workspace <dir>      group workspace for ledger/log/reports/rr-cache (default: cwd)
 *   --inventory <dir>      live feature inventory           (default: latest scripts/sweep/bootstrap snapshot)
 *   --ledger <file>        group-owned ledger JSON          (default: <workspace>/sweep-ledger.json)
 *   --scope-config <file>  scope policy                     (default: scripts/sweep/registry/scope.yaml)
 *   --routing-config <file> router/scan tuning              (default: scripts/sweep/registry/routing.yaml)
 *   --cases <dir>          replay cases                     (default: scripts/sweep/test-cases/cases)
 *   --execute              actually perform mutations; WITHOUT it every
 *                          mutating subcommand only prints its plan (dry-run)
 *   --upstream <ref>       upstream ref                     (default: upstream/main)
 *   --base <ref>           PoI range base                   (default: ledger lastSweep.upstreamTip, else merge-base(main, upstream))
 *   --branch <name>        restrict to one branch (repeatable)
 *   --out <file>           write the subcommand's JSON artifact to a file
 *   --report <file>        input sweep-report.json          (merge/route/record/status)
 *   --outcomes <file>      input merge-outcomes JSON        (record/verify --rollback)
 *   --verify-result <file> input verify result JSON         (record)
 *   --recipe <a,b,c>       verify recipe override           (default: scope.yaml recipe)
 *   --commands-file <file> verify command list JSON [{cmd, cwd?}] (test injection)
 *   --case <id>            replay/seed a single case
 *
 * Safety model: mutating stages are dry-run by default; `main` only ever
 * fast-forwards; everything* / design/* / maint/* branches are never merge
 * targets (fix/* and docs/notes ARE swept — upstream-PR candidates); all
 * state writes are plain files in the group workspace — no state branch
 * exists (dissolved 2026-07-10). See scripts/sweep/README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_UPSTREAM_REF,
  EXCLUDED_BRANCH_GLOBS,
  LARGE_ANY_BYTES,
  LEDGER_FILENAME,
  RR_CACHE_DIRNAME,
  SENSITIVE_PATHS,
  VERIFY_COMMANDS,
  defaultInventoryDir,
} from './config.js';
import { git, isAncestor, localBranches, refExists, revParse, worktreeBranches } from './git.js';
import { globMatchAny } from './globs.js';
import { appendSweepLog, derivedLastMerged, readLedger } from './ledger.js';
import {
  executeMerges,
  planMerges,
  rollbackBranch,
  writeRrCacheDir,
  type MergeOutcome,
  type MergeTarget,
} from './merge.js';
import { applyRecord, recordSweep } from './record.js';
import { loadFeatures, loadRegistry, loadReplayCases, loadRoutingConfig } from './registry.js';
import { replayCases, seedableCases, seedRerereFromCases } from './replay.js';
import { routePois } from './routing.js';
import { buildReport, enrichPois, type BuildReportOptions } from './scan.js';
import { resolveScope, type ScopeResult } from './scope.js';
import { findStopPoint } from './stop-points.js';
import type { SweepReport } from './types.js';
import { validateRegistry } from './validate.js';
import { verifyEverything, type VerifyCommand, type VerifyResult } from './verify.js';

interface Cli {
  cmd: string;
  repo: string;
  workspace: string;
  inventory: string | null;
  ledgerPath: string;
  scopeFile?: string;
  routingFile?: string;
  casesDir?: string;
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
  'Usage: pnpm exec tsx scripts/sweep/sweep.ts <fetch|ff-main|scan|stop-points|merge|verify|record|status|validate-registry|route|replay|seed-rerere> [--repo <path>] [--workspace <dir>] [--inventory <dir>] [--execute] [flags]';

function parseCli(argv: string[]): Cli {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.error(USAGE);
    process.exit(2);
  }
  const raw: Record<string, string | undefined> = {};
  const cli: Cli = {
    cmd,
    repo: process.cwd(),
    workspace: process.cwd(),
    inventory: null,
    ledgerPath: '',
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
      case '--workspace':
        cli.workspace = resolve(need());
        break;
      case '--inventory':
        raw.inventory = need();
        break;
      case '--ledger':
        raw.ledger = need();
        break;
      case '--scope-config':
        cli.scopeFile = need();
        break;
      case '--routing-config':
        cli.routingFile = need();
        break;
      case '--cases':
        cli.casesDir = need();
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
  cli.inventory = raw.inventory !== undefined ? resolve(raw.inventory) : defaultInventoryDir();
  cli.ledgerPath = raw.ledger !== undefined ? resolve(raw.ledger) : join(cli.workspace, LEDGER_FILENAME);
  return cli;
}

function rrDirOf(cli: Cli): string {
  return join(cli.workspace, RR_CACHE_DIRNAME);
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

/** Scope from the inventory + scope config; namespace fallback while the inventory is empty. */
async function scopeBranches(cli: Cli): Promise<{ scope: ScopeResult; warnings: string[] }> {
  const registry = loadRegistry({
    inventoryDir: cli.inventory,
    scopeFile: cli.scopeFile,
    routingFile: cli.routingFile,
  });
  const warnings = [...registry.warnings];
  let scope = await resolveScope(cli.repo, registry.features, registry.scope);
  if (!scope.ordered.some((e) => e.kind === 'inventory')) {
    warnings.push('inventory produced no in-scope branches — falling back to module/*|feat/*|edition/* enumeration');
    const namespaceBranches = (await localBranches(cli.repo)).filter(
      (b) => /^(module|feat|edition)\//.test(b) && !globMatchAny(EXCLUDED_BRANCH_GLOBS, b),
    );
    const namespaceSet = new Set(namespaceBranches);
    const hasMainPatched = scope.ordered.some((e) => e.branch === 'main_patched');
    scope = {
      ordered: [
        // keep the structural + edition-ancestor entries the partition already found
        ...scope.ordered.filter((e) => !namespaceSet.has(e.branch)),
        ...namespaceBranches.sort().map((b) => ({
          branch: b,
          kind: 'inventory' as const,
          mergeModel: hasMainPatched ? ('parents' as const) : ('upstream-chain' as const),
          parents: hasMainPatched ? ['main_patched'] : [],
        })),
      ],
      ignored: scope.ignored.filter((b) => !namespaceSet.has(b)),
      edges: {},
      warnings: scope.warnings,
    };
  }
  warnings.push(...scope.warnings);
  if (cli.branches.length > 0) {
    scope = { ...scope, ordered: scope.ordered.filter((e) => cli.branches.includes(e.branch)) };
  }
  return { scope, warnings };
}

async function resolveRangeBase(cli: Cli): Promise<string> {
  if (cli.base) return cli.base;
  const ledger = readLedger(cli.ledgerPath);
  if (ledger.lastSweep?.upstreamTip && (await refExists(cli.repo, ledger.lastSweep.upstreamTip))) {
    return ledger.lastSweep.upstreamTip;
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
  const ledger = readLedger(cli.ledgerPath);
  const open = ledger.openPois.filter((p) => p.state === 'open').length;
  console.log(`${cli.upstream} = ${tip}`);
  if (ledger.lastSweep?.upstreamTip === tip && open === 0) {
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
  // Scan tuning from routing.yaml (the registry config is the tuning surface, not code).
  const { routing } = loadRoutingConfig(cli.routingFile);
  const opts: BuildReportOptions = {};
  if (routing.largeNewFileKb !== undefined) {
    opts.largeSourceBytes = routing.largeNewFileKb * 1024;
    opts.largeAnyBytes = Math.max(routing.largeNewFileKb * 1024, LARGE_ANY_BYTES);
  }
  if (routing.sensitiveSurfaces) opts.sensitivePaths = [...SENSITIVE_PATHS, ...routing.sensitiveSurfaces];
  const report = await buildReport(cli.repo, scope.ordered, cli.upstream, rangeBase, opts, warnings, scope.ignored);
  emit(cli, report);
  return 0;
}

async function cmdStopPoints(cli: Cli): Promise<number> {
  const { scope } = await scopeBranches(cli);
  // Only upstream-chain branches (main_patched + edition-ancestors) bisect the
  // upstream first-parent chain; inventory branches inherit via parent merges.
  const results = [];
  for (const entry of scope.ordered) {
    if (entry.mergeModel !== 'upstream-chain') continue;
    results.push(await findStopPoint(cli.repo, entry.branch, cli.upstream));
  }
  emit(cli, results);
  return 0;
}

async function cmdMerge(cli: Cli): Promise<number> {
  const ledger = readLedger(cli.ledgerPath);
  let targets: MergeTarget[];
  if (cli.report) {
    const report = readJson<SweepReport>(cli.report);
    targets = Object.values(report.branches)
      .filter((b) => cli.branches.length === 0 || cli.branches.includes(b.branch))
      .map((b) => ({
        branch: b.branch,
        mergeModel: b.mergeModel,
        stopPoint: b.stopPoint,
        parents: b.parents,
        upToDate: b.upToDate,
      }));
  } else {
    const { scope } = await scopeBranches(cli);
    targets = [];
    for (const entry of scope.ordered) {
      if (entry.mergeModel === 'upstream-chain') {
        const sp = await findStopPoint(cli.repo, entry.branch, cli.upstream);
        targets.push({
          branch: entry.branch,
          mergeModel: 'upstream-chain',
          stopPoint: sp.stopPoint,
          parents: [],
          upToDate: sp.upToDate,
        });
      } else {
        // parents model: execution probes the parents' tips itself.
        targets.push({
          branch: entry.branch,
          mergeModel: 'parents',
          stopPoint: null,
          parents: entry.parents,
          upToDate: false,
        });
      }
    }
  }
  const plan = await planMerges(cli.repo, targets, ledger);
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): merge plan follows');
    emit(cli, plan);
    return 0;
  }
  const { outcomes, rrCacheExport } = await executeMerges(cli.repo, plan, rrDirOf(cli));
  const rrCacheNewFiles = writeRrCacheDir(rrDirOf(cli), rrCacheExport);
  appendSweepLog(cli.workspace, {
    action: 'merge',
    merged: outcomes
      .filter((o) => o.result === 'merged')
      .map((o) => ({ branch: o.branch, pre: o.preRef, post: o.newRef })),
    gated: outcomes.filter((o) => o.result === 'gated').map((o) => o.branch),
    rrCacheNewFiles,
  });
  emit(cli, outcomes);
  return outcomes.some((o) => o.result === 'gated' || o.result === 'dirty-worktree') ? 1 : 0;
}

async function cmdVerify(cli: Cli): Promise<number> {
  const registry = loadRegistry({ inventoryDir: cli.inventory, scopeFile: cli.scopeFile });
  const recipe = cli.recipe ?? registry.scope.recipe ?? [];
  if (recipe.length === 0) {
    console.error('verify: no recipe (pass --recipe a,b,c or add `recipe:` to registry/scope.yaml)');
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
    console.error(
      `DRY-RUN (no --execute): would write ledger ${cli.ledgerPath} + report archive under ${cli.workspace}`,
    );
    const prev = readLedger(cli.ledgerPath);
    emit(cli, applyRecord(prev, { report, outcomes, verify }));
    return 0;
  }
  const { ledger, reportPath } = recordSweep(cli.workspace, cli.ledgerPath, { report, outcomes, verify });
  console.error(`ledger written: ${cli.ledgerPath}; report archived: ${reportPath}`);
  emit(cli, ledger);
  return 0;
}

async function cmdStatus(cli: Cli): Promise<number> {
  const ledger = readLedger(cli.ledgerPath);
  const upstreamTip = (await refExists(cli.repo, cli.upstream)) ? await revParse(cli.repo, cli.upstream) : null;
  console.log(`workspace:    ${cli.workspace}`);
  console.log(`ledger:       ${cli.ledgerPath}`);
  console.log(`inventory:    ${cli.inventory ?? '(none)'}`);
  console.log(
    ledger.lastSweep?.upstreamTip
      ? `last sweep:   ${ledger.lastSweep.id} -> ${ledger.lastSweep.upstreamTip.slice(0, 12)} (${ledger.lastSweep.result})`
      : 'last sweep:   never',
  );
  if (upstreamTip) {
    const pending = ledger.lastSweep?.upstreamTip && upstreamTip !== ledger.lastSweep.upstreamTip;
    console.log(
      `${cli.upstream}: ${upstreamTip.slice(0, 12)}${pending ? '  ** NEW upstream commits since last sweep **' : ''}`,
    );
  }
  // Branch set: scope union report union ledger overrides.
  const report = cli.report ? readJson<SweepReport>(cli.report) : null;
  const { scope } = await scopeBranches(cli);
  const kindOf = new Map(scope.ordered.map((e) => [e.branch, e]));
  const names = [
    ...new Set([
      ...scope.ordered.map((e) => e.branch),
      ...Object.keys(report?.branches ?? {}),
      ...Object.keys(ledger.branches),
    ]),
  ].sort();
  console.log(`branches in scope: ${names.length}`);
  for (const name of names) {
    const bs = ledger.branches[name];
    const entry = kindOf.get(name);
    // DERIVED state: merge-base(branch, upstream) replaces stored lastMergedUpstream.
    const mergeBase = (await refExists(cli.repo, name)) ? await derivedLastMerged(cli.repo, name, cli.upstream) : null;
    const merged = mergeBase ? mergeBase.slice(0, 12) : 'n/a';
    const ms = bs?.merge_status;
    const blockedLabel = ms?.state === 'PR_ID' ? `held by ${ms.caseId}` : ms?.state === 'DEFERRED' ? 'deferred' : '';
    const extras = [blockedLabel, bs?.notes ?? ''].filter(Boolean).join('; ');
    const scan = report?.branches[name];
    const model = entry ?? scan;
    const sourceLabel =
      model?.mergeModel === 'parents' ? `parents: ${(model.parents ?? []).join(', ')}` : 'upstream chain';
    let verdict = '';
    if (scan) {
      if (scan.upToDate) verdict = '  => up-to-date';
      else if (scan.clean)
        verdict =
          scan.mergeModel === 'parents'
            ? '  => clean, ready to merge parents'
            : `  => clean, ready to merge ${report!.upstreamTip.slice(0, 12)}`;
      else if (scan.mergeModel === 'parents')
        verdict = `  => gated on parent merge (${scan.conflictFiles.length} conflict files)`;
      else if (scan.stopPoint)
        verdict = `  => gated at stop point ${scan.stopPoint.slice(0, 12)} (${scan.conflictFiles.length} conflict files beyond)`;
      else verdict = `  => fully gated (first pending commit conflicts: ${scan.conflictFiles.length} files at tip)`;
    }
    console.log(
      `  ${(bs?.status ?? 'active').padEnd(8)} ${(entry?.kind ?? '-').padEnd(16)} ${name}  mergeBase=${merged}  [${sourceLabel}]${extras ? `  [${extras}]` : ''}${verdict}`,
    );
  }
  const ignoredList = report?.ignoredBranches ?? scope.ignored;
  console.log(
    `ignored (no inventory entry, not in any edition composition): ${ignoredList.length}${ignoredList.length ? ` — ${ignoredList.join(', ')}` : ''}`,
  );
  const open = ledger.openPois.filter((p) => p.state === 'open');
  console.log(`open PoIs: ${open.length}`);
  for (const p of open)
    console.log(`  [${p.class}/${p.type}] ${p.id}${p.branches.length ? ` branches=${p.branches.join(',')}` : ''}`);
  return 0;
}

async function cmdValidateRegistry(cli: Cli): Promise<number> {
  const { features, warnings } = loadFeatures(cli.inventory);
  for (const w of warnings) console.error(`LOAD WARN: ${w}`);
  const result = await validateRegistry(cli.repo, features);
  emit(cli, result);
  return result.ok ? 0 : 1;
}

async function cmdRoute(cli: Cli): Promise<number> {
  if (!cli.report) {
    console.error('route: --report <sweep-report.json> is required');
    return 2;
  }
  const report = readJson<SweepReport>(cli.report);
  const { features, warnings } = loadFeatures(cli.inventory);
  for (const w of warnings) console.error(`LOAD WARN: ${w}`);
  const { routing } = loadRoutingConfig(cli.routingFile);
  const validation = await validateRegistry(cli.repo, features);
  const pois = await enrichPois(cli.repo, report);
  const outcome = routePois(pois, features, routing, validation.alertedFeatureIds);
  emit(cli, { validationAlerts: validation.alertedFeatureIds, ...outcome });
  return 0;
}

async function cmdReplay(cli: Cli): Promise<number> {
  const { cases, warnings } = loadReplayCases(cli.casesDir);
  for (const w of warnings) console.error(`LOAD WARN: ${w}`);
  if (cases.length === 0) {
    console.error('replay: no cases found');
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

async function cmdSeedRerere(cli: Cli): Promise<number> {
  const { cases, warnings } = loadReplayCases(cli.casesDir);
  for (const w of warnings) console.error(`LOAD WARN: ${w}`);
  const selected = cli.caseId ? cases.filter((c) => c.id === cli.caseId) : cases;
  const seedable = seedableCases(selected);
  if (seedable.length === 0) {
    console.error('seed-rerere: no cases with merge_source + resolution_ref');
    return 2;
  }
  if (!cli.execute) {
    console.error('DRY-RUN (no --execute): would seed rr-cache from these cases');
    emit(
      cli,
      seedable.map((c) => ({ id: c.id, fork_base_commit: c.fork_base_commit, resolution_ref: c.resolution_ref })),
    );
    return 0;
  }
  const results = await seedRerereFromCases(cli.repo, seedable, rrDirOf(cli));
  appendSweepLog(cli.workspace, { action: 'seed-rerere', results });
  emit(cli, results);
  return results.every((r) => r.status === 'seeded' || r.status === 'no-conflict') ? 0 : 1;
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
  'seed-rerere': cmdSeedRerere,
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
