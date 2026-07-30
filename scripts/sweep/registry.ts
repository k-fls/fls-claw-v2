/**
 * scripts/sweep/registry.ts — load the fork feature inventory + tooling
 * config from the LOCAL WORKING TREE (no state branch; dissolved
 * 2026-07-10). The live inventory is a directory of <id>.yaml entries
 * (--inventory; default = the committed bootstrap snapshot), routing/scope
 * config live in scripts/sweep/registry/.
 *
 * Fail-closed loader in the feat/ops-registry idiom: a malformed entry never
 * crashes the sweep — it is dropped and surfaced as a load warning, and the
 * router treats its PoIs via catch-all.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { DEFAULT_ROUTING_FILE, DEFAULT_SCOPE_FILE, defaultInventoryDir } from './config.js';
import type { FeatureEntry, RoutingConfig, SweepScope } from './types.js';

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

/** Load all feature entries from an inventory directory. */
export function loadFeatures(inventoryDir: string | null): { features: FeatureEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const features: FeatureEntry[] = [];
  if (!inventoryDir || !existsSync(inventoryDir)) {
    if (inventoryDir) warnings.push(`inventory directory '${inventoryDir}' does not exist`);
    return { features, warnings };
  }
  const files = readdirSync(inventoryDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(inventoryDir, file), 'utf8');
    const { entry, error } = parseFeatureEntry(raw, file);
    if (error) warnings.push(error);
    else if (entry) features.push(entry);
  }
  return { features, warnings };
}

export function loadRoutingConfig(routingFile: string = DEFAULT_ROUTING_FILE): {
  routing: RoutingConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const routing: RoutingConfig = {};
  if (existsSync(routingFile)) {
    try {
      const doc = parse(readFileSync(routingFile, 'utf8')) as
        | { scope_guard_mode?: string; stack_cap?: number }
        | null;
      if (doc && typeof doc === 'object') {
        if (doc.scope_guard_mode === 'same-files' || doc.scope_guard_mode === 'conflict-hunks')
          routing.scopeGuardMode = doc.scope_guard_mode;
        if (typeof doc.stack_cap === 'number' && Number.isInteger(doc.stack_cap) && doc.stack_cap >= 1)
          routing.stackCap = doc.stack_cap;
      }
    } catch (err) {
      warnings.push(`${routingFile}: parse error, using defaults: ${(err as Error).message}`);
    }
  }
  return { routing, warnings };
}

export function loadScopeConfig(scopeFile: string = DEFAULT_SCOPE_FILE): { scope: SweepScope; warnings: string[] } {
  const warnings: string[] = [];
  let scope: SweepScope = {};
  if (existsSync(scopeFile)) {
    try {
      const doc = parse(readFileSync(scopeFile, 'utf8')) as SweepScope | null;
      if (doc && typeof doc === 'object') scope = doc;
    } catch (err) {
      warnings.push(`${scopeFile}: parse error, ignoring: ${(err as Error).message}`);
    }
  }
  return { scope, warnings };
}

export interface LoadRegistryOptions {
  /** undefined = use the bootstrap snapshot; null = no inventory. */
  inventoryDir?: string | null;
  routingFile?: string;
  scopeFile?: string;
}

export function loadRegistry(opts: LoadRegistryOptions = {}): RegistryLoad {
  const feat = loadFeatures(opts.inventoryDir !== undefined ? opts.inventoryDir : defaultInventoryDir());
  const routing = loadRoutingConfig(opts.routingFile);
  const scope = loadScopeConfig(opts.scopeFile);
  return {
    features: feat.features,
    routing: routing.routing,
    scope: scope.scope,
    warnings: [...feat.warnings, ...routing.warnings, ...scope.warnings],
  };
}
