/**
 * scripts/sweep/registry.ts — load the fork feature inventory + tooling
 * config from the LOCAL WORKING TREE. The live inventory is
 * scripts/sweep/inventory/*.yaml — strict config tracked in the fork repo,
 * loaded by default; `--inventory` overrides it for tests/fixtures.
 * Routing/scope config live in scripts/sweep/registry/.
 *
 * The loader itself is per-entry fail-soft: a malformed entry never crashes a
 * load — it is dropped and surfaced as a load warning, and the router treats
 * its PoIs via catch-all. `sweep start` is fail-closed on top of that: ANY
 * entry warning is fatal there (ERR46_INVENTORY_INVALID).
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

// ---------------------------------------------------------------------------
// Strict config schema. The inventory is CONFIGURATION ONLY: every key
// must be a declared config field with a well-shaped value; anything else is
// an entry ERROR, and `sweep start` fails hard on entry errors.
// ---------------------------------------------------------------------------

const isStr = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isStrArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ENTRY_KEYS: Record<string, (v: unknown) => boolean> = {
  id: isStr,
  name: isStr,
  kind: (v) => typeof v === 'string' && KINDS.has(v),
  branch: isStr,
  parents: isStrArray,
  dependents: isStrArray,
  summary: isStr,
  owned_paths: isStrArray,
  key_symbols: isStrArray,
  design_docs: isStrArray,
  test_anchors: isStrArray,
  scope_guard: (v) => v === 'same-files' || v === 'conflict-hunks',
  stack_cap: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
  tier_floor: (v) => v === 'judged',
  always_merge: (v) => typeof v === 'boolean',
  routing: (v) =>
    isMapping(v) &&
    Object.entries(v).every(([k, val]) => (k === 'keywords' || k === 'always_check_on') && isStrArray(val)),
};

export function parseFeatureEntry(raw: string, sourceName: string): { entry?: FeatureEntry; error?: string } {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    return { error: `${sourceName}: YAML parse error: ${(err as Error).message}` };
  }
  if (!isMapping(doc)) {
    return { error: `${sourceName}: not a mapping` };
  }
  for (const [key, value] of Object.entries(doc)) {
    const check = ENTRY_KEYS[key];
    if (!check) return { error: `${sourceName}: unknown key '${key}' (the inventory is strict config only)` };
    if (!check(value)) return { error: `${sourceName}: bad value for '${key}'` };
  }
  const e = doc as unknown as FeatureEntry;
  if (!e.id || !e.name || !e.kind) {
    return { error: `${sourceName}: missing required field (id/name/kind)` };
  }
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
  /** undefined = use the default inventory dir; null = no inventory. */
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
