/**
 * scripts/sweep/registry.ts — read the fork feature registry from the state
 * branch (fork-registry/**) without checking it out.
 *
 * Fail-closed loader in the feat/ops-registry idiom: a malformed entry never
 * crashes the sweep — it is dropped and surfaced as a load warning, and the
 * router treats its PoIs via catch-all.
 */
import { parse } from 'yaml';

import { DEFAULT_ROUTING, REGISTRY_DIR } from './config.js';
import { listTreePaths, readFileFromBranch } from './git.js';
import type { FeatureEntry, ReplayCase, RoutingConfig, SweepScope } from './types.js';

export interface RegistryLoad {
  features: FeatureEntry[];
  routing: RoutingConfig;
  scope: SweepScope;
  warnings: string[];
}

const KINDS = new Set(['module', 'feat', 'edition', 'fix', 'planned']);
const STATUSES = new Set(['planned', 'in-progress', 'shipped', 'experimental', 'absorbed', 'retired']);

export function parseFeatureEntry(raw: string, sourceName: string): { entry?: FeatureEntry; error?: string } {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    return { error: `${sourceName}: YAML parse error: ${(err as Error).message}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { error: `${sourceName}: not a mapping` };
  }
  const e = doc as FeatureEntry;
  if (!e.id || !e.name || !e.kind || !e.status) {
    return { error: `${sourceName}: missing required field (id/name/kind/status)` };
  }
  if (!KINDS.has(e.kind)) return { error: `${sourceName}: bad kind '${e.kind}'` };
  if (!STATUSES.has(e.status)) return { error: `${sourceName}: bad status '${e.status}'` };
  if (e.status !== 'planned' && !e.branch) return { error: `${sourceName}: branch required unless status=planned` };
  return { entry: e };
}

export async function loadFeatures(
  repo: string,
  stateBranch: string,
): Promise<{ features: FeatureEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  const features: FeatureEntry[] = [];
  const paths = await listTreePaths(repo, stateBranch, `${REGISTRY_DIR}/features`);
  for (const path of paths.filter((p) => p.endsWith('.yaml') || p.endsWith('.yml'))) {
    const raw = await readFileFromBranch(repo, stateBranch, path);
    if (raw === null) continue;
    const { entry, error } = parseFeatureEntry(raw, path);
    if (error) warnings.push(error);
    else if (entry) features.push(entry);
  }
  return { features, warnings };
}

export async function loadRoutingConfig(
  repo: string,
  stateBranch: string,
): Promise<{ routing: RoutingConfig; warnings: string[] }> {
  const warnings: string[] = [];
  const raw = await readFileFromBranch(repo, stateBranch, `${REGISTRY_DIR}/routing.yaml`);
  let routing: RoutingConfig = { ...DEFAULT_ROUTING, weights: { ...DEFAULT_ROUTING.weights } };
  if (raw !== null) {
    try {
      const doc = parse(raw) as
        | (Partial<RoutingConfig> & {
            catch_all?: { always_include?: string[] };
            large_new_file_kb?: number;
            sensitive_surfaces?: string[];
          })
        | null;
      if (doc && typeof doc === 'object') {
        routing = {
          weights: { ...routing.weights, ...(doc.weights ?? {}) },
          threshold: typeof doc.threshold === 'number' ? doc.threshold : routing.threshold,
          top_k: typeof doc.top_k === 'number' ? doc.top_k : routing.top_k,
        };
        if (Array.isArray(doc.catch_all?.always_include)) routing.catchAllAlwaysInclude = doc.catch_all.always_include;
        if (typeof doc.large_new_file_kb === 'number') routing.largeNewFileKb = doc.large_new_file_kb;
        if (Array.isArray(doc.sensitive_surfaces)) routing.sensitiveSurfaces = doc.sensitive_surfaces;
      }
    } catch (err) {
      warnings.push(`routing.yaml: parse error, using defaults: ${(err as Error).message}`);
    }
  }
  return { routing, warnings };
}

export async function loadSweepScope(
  repo: string,
  stateBranch: string,
): Promise<{ scope: SweepScope; warnings: string[] }> {
  const warnings: string[] = [];
  const raw = await readFileFromBranch(repo, stateBranch, `${REGISTRY_DIR}/sweep-scope.yaml`);
  let scope: SweepScope = {};
  if (raw !== null) {
    try {
      const doc = parse(raw) as SweepScope | null;
      if (doc && typeof doc === 'object') scope = doc;
    } catch (err) {
      warnings.push(`sweep-scope.yaml: parse error, ignoring: ${(err as Error).message}`);
    }
  }
  return { scope, warnings };
}

export async function loadRegistry(repo: string, stateBranch: string): Promise<RegistryLoad> {
  const [feat, routing, scope] = [
    await loadFeatures(repo, stateBranch),
    await loadRoutingConfig(repo, stateBranch),
    await loadSweepScope(repo, stateBranch),
  ];
  return {
    features: feat.features,
    routing: routing.routing,
    scope: scope.scope,
    warnings: [...feat.warnings, ...routing.warnings, ...scope.warnings],
  };
}

/** Replay cases from fork-registry/test-cases/*.yaml (one case or a list per file). */
export async function loadReplayCases(
  repo: string,
  stateBranch: string,
): Promise<{ cases: ReplayCase[]; warnings: string[] }> {
  const warnings: string[] = [];
  const cases: ReplayCase[] = [];
  const paths = await listTreePaths(repo, stateBranch, `${REGISTRY_DIR}/test-cases`);
  for (const path of paths.filter((p) => p.endsWith('.yaml') || p.endsWith('.yml'))) {
    const raw = await readFileFromBranch(repo, stateBranch, path);
    if (raw === null) continue;
    try {
      const doc = parse(raw) as ReplayCase | ReplayCase[] | null;
      const list = Array.isArray(doc) ? doc : doc ? [doc] : [];
      for (const c of list) {
        if (!c.id || !c.fork_branch || !c.expected || (!c.upstream_range && !c.merge_source)) {
          warnings.push(
            `${path}: case missing required fields (id/fork_branch/expected + upstream_range|merge_source)`,
          );
          continue;
        }
        cases.push(c);
      }
    } catch (err) {
      warnings.push(`${path}: YAML parse error: ${(err as Error).message}`);
    }
  }
  return { cases, warnings };
}
