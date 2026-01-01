/**
 * CRUD registration helper.
 *
 * Takes a declarative resource definition (table, columns, access levels)
 * and auto-registers list/get/create/update/delete commands in the CLI
 * registry. Column metadata doubles as documentation — `ncl <resource> help`
 * is generated from the same definitions.
 */
import { randomUUID } from 'crypto';

import { getDb } from '../db/connection.js';
import { renderVerbHelp } from './help-render.js';
import { register } from './registry.js';
import type { CallerContext } from './frame.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Access = 'open' | 'approval' | 'hidden';

export interface ColumnDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  description: string;
  /** Auto-set on create — not user-provided. */
  generated?: boolean;
  /** Must be provided on create (ignored if generated). */
  required?: boolean;
  /** Can be changed via update. */
  updatable?: boolean;
  /** Default value on create when not provided. */
  default?: unknown;
  /** Default to another column's resolved value on create when not provided. */
  defaultFrom?: string;
  /** Allowed values (shown in help). */
  enum?: string[];
}

export interface CustomOperation {
  access: Access;
  description: string;
  args?: ColumnDef[];
  examples?: string[];
  hostOnly?: boolean;
  formatHuman?: (rows: unknown) => string;
  handler: (args: Record<string, unknown>, ctx: CallerContext) => Promise<unknown>;
}

export interface ResourceDef {
  /** Singular name: 'group'. */
  name: string;
  /** Plural name: 'groups'. Used in command names. */
  plural: string;
  /** DB table name. */
  table: string;
  /** One-line description shown in help. */
  description: string;
  /** Primary key column name. */
  idColumn: string;
  /**
   * Column that carries the agent group ID for group-scope enforcement.
   * Required on every resource in the CLI whitelist (groups, sessions,
   * destinations, members). When absent, post-handler filtering fails closed.
   */
  scopeField?: string;
  columns: ColumnDef[];
  /** Which standard CRUD operations are enabled. */
  operations: {
    list?: Access;
    get?: Access;
    create?: Access;
    update?: Access;
    delete?: Access;
  };
  /** Non-standard verbs (grant, revoke, add, remove, restart, etc.). */
  customOperations?: Record<string, CustomOperation>;
  /**
   * Hook run after a successful generic create, with the inserted row's values.
   * For dependent rows the single-table INSERT can't seed (e.g. a group's
   * container_configs row).
   */
  afterCreate?: (created: Record<string, unknown>) => void | Promise<void>;
  naturalKey?: string[];
  resolveDefaults?: (values: Record<string, unknown>) => void | Promise<void>;
  preUpdate?: (updates: Record<string, unknown>, current: Record<string, unknown>) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Resource registry (for help introspection)
// ---------------------------------------------------------------------------

const resources = new Map<string, ResourceDef>();

export function getResources(): ResourceDef[] {
  return [...resources.values()].sort((a, b) => a.plural.localeCompare(b.plural));
}

export function getResource(plural: string): ResourceDef | undefined {
  return resources.get(plural);
}

// ---------------------------------------------------------------------------
// Generic SQL handlers
// ---------------------------------------------------------------------------

function visibleColumns(def: ResourceDef): string[] {
  return def.columns.map((c) => c.name);
}

function genericList(def: ResourceDef) {
  const cols = visibleColumns(def).join(', ');
  const filterableNames = new Set(def.columns.filter((c) => !c.generated).map((c) => c.name));
  return async (args: Record<string, unknown>) => {
    const limit = args.limit !== undefined ? Math.max(1, Number(args.limit)) : 200;
    const filters: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(args)) {
      if (k === 'id' || k === 'limit') continue;
      if (filterableNames.has(k)) {
        filters.push(`${k} = ?`);
        params.push(v);
      }
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    params.push(limit);
    return getDb()
      .prepare(`SELECT ${cols} FROM ${def.table}${where} LIMIT ?`)
      .all(...params);
  };
}

function genericGet(def: ResourceDef) {
  const cols = visibleColumns(def).join(', ');
  return async (args: Record<string, unknown>) => {
    const id = args.id as string;
    if (!id) throw new Error(`${def.name} id is required`);
    const row = getDb().prepare(`SELECT ${cols} FROM ${def.table} WHERE ${def.idColumn} = ?`).get(id);
    if (!row) throw new Error(`${def.name} not found: ${id}`);
    return row;
  };
}

function genericCreate(def: ResourceDef) {
  return async (args: Record<string, unknown>) => {
    const values: Record<string, unknown> = {};

    // Pass 1: generated fields + explicit args + required checks.
    for (const col of def.columns) {
      if (col.generated) {
        if (col.name === def.idColumn) {
          values[col.name] = randomUUID();
        } else if (col.name.endsWith('_at')) {
          values[col.name] = new Date().toISOString();
        }
        continue;
      }

      const v = args[col.name];
      if (v !== undefined) {
        if (col.enum && !col.enum.includes(String(v))) {
          throw new Error(`${col.name} must be one of: ${col.enum.join(', ')}`);
        }
        values[col.name] = col.type === 'number' ? Number(v) : v;
      } else if (col.required) {
        throw new Error(`--${col.name.replace(/_/g, '-')} is required`);
      }
    }

    // Pass 2: resolveDefaults hook — runs after explicit args, before static defaults.
    if (def.resolveDefaults) await def.resolveDefaults(values);

    // Pass 3: static defaults for columns still unset.
    for (const col of def.columns) {
      if (col.generated || values[col.name] !== undefined) continue;
      if (col.default !== undefined) {
        values[col.name] = col.default;
      } else if (col.defaultFrom !== undefined && values[col.defaultFrom] !== undefined) {
        values[col.name] = values[col.defaultFrom];
      }
    }

    const colNames = Object.keys(values);
    const placeholders = colNames.map((c) => `@${c}`);
    getDb()
      .prepare(`INSERT INTO ${def.table} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`)
      .run(values);
    if (def.afterCreate) await def.afterCreate(values);
    return values;
  };
}

function genericUpdate(def: ResourceDef) {
  const updatableCols = def.columns.filter((c) => c.updatable);
  return async (args: Record<string, unknown>) => {
    const id = args.id as string;
    if (!id) throw new Error(`${def.name} id is required`);

    const updates: Record<string, unknown> = {};
    for (const col of updatableCols) {
      const v = args[col.name];
      if (v !== undefined) {
        if (col.enum && !col.enum.includes(String(v))) {
          throw new Error(`${col.name} must be one of: ${col.enum.join(', ')}`);
        }
        updates[col.name] = col.type === 'number' ? Number(v) : v;
      }
    }
    if (Object.keys(updates).length === 0) {
      throw new Error(
        `nothing to update — provide at least one of: ${updatableCols.map((c) => '--' + c.name.replace(/_/g, '-')).join(', ')}`,
      );
    }

    if (def.preUpdate) {
      const cols = visibleColumns(def).join(', ');
      const current = getDb()
        .prepare(`SELECT ${cols} FROM ${def.table} WHERE ${def.idColumn} = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (!current) throw new Error(`${def.name} not found: ${id}`);
      await def.preUpdate(updates, current);
    }

    const setClause = Object.keys(updates)
      .map((k) => `${k} = @${k}`)
      .join(', ');
    const result = getDb()
      .prepare(`UPDATE ${def.table} SET ${setClause} WHERE ${def.idColumn} = @_id`)
      .run({ ...updates, _id: id });
    if (result.changes === 0) throw new Error(`${def.name} not found: ${id}`);

    const cols = visibleColumns(def).join(', ');
    return getDb().prepare(`SELECT ${cols} FROM ${def.table} WHERE ${def.idColumn} = ?`).get(id);
  };
}

function genericDelete(def: ResourceDef) {
  return async (args: Record<string, unknown>) => {
    const id = args.id as string;
    if (!id) throw new Error(`${def.name} id is required`);
    const result = getDb().prepare(`DELETE FROM ${def.table} WHERE ${def.idColumn} = ?`).run(id);
    if (result.changes === 0) throw new Error(`${def.name} not found: ${id}`);
    return { deleted: id };
  };
}

// ---------------------------------------------------------------------------
// parseArgs helper: normalizes --hyphen-keys to underscore_keys
// ---------------------------------------------------------------------------

function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.replace(/-/g, '_')] = v;
  }
  return out;
}

const DISPATCH_INJECTED_KEYS = new Set(['id', 'agent_group_id', 'group']);

export function validateArgs(defs: ColumnDef[], args: Record<string, unknown>): Record<string, unknown> {
  const knownNames = new Set(defs.map((d) => d.name));
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(args)) {
    if (DISPATCH_INJECTED_KEYS.has(k)) {
      out[k] = v;
    } else if (!knownNames.has(k)) {
      throw new Error(`unknown flag --${k.replace(/_/g, '-')}`);
    }
  }

  for (const def of defs) {
    const raw = args[def.name];
    if (raw === undefined) {
      if (def.required) throw new Error(`--${def.name.replace(/_/g, '-')} is required`);
      if (def.default !== undefined) out[def.name] = def.default;
      continue;
    }
    if (typeof raw === 'boolean') {
      if (def.type !== 'boolean') throw new Error(`--${def.name.replace(/_/g, '-')} requires a value`);
      out[def.name] = raw;
      continue;
    }
    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        if (isNaN(n)) throw new Error(`--${def.name.replace(/_/g, '-')} must be a number`);
        out[def.name] = n;
        break;
      }
      case 'boolean':
        out[def.name] = raw === 'true' || raw === '1';
        break;
      case 'json':
        try {
          out[def.name] = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          throw new Error(`--${def.name.replace(/_/g, '-')} must be valid JSON`);
        }
        break;
      default: {
        const s = String(raw);
        if (def.enum && !def.enum.includes(s)) {
          throw new Error(`--${def.name.replace(/_/g, '-')} must be one of: ${def.enum.join(', ')}`);
        }
        out[def.name] = s;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// registerResource
// ---------------------------------------------------------------------------

export function registerResource(def: ResourceDef): void {
  resources.set(def.plural, def);

  if (def.operations.list) {
    register({
      name: `${def.plural}-list`,
      description: `List all ${def.plural}.`,
      access: def.operations.list,
      resource: def.plural,
      generic: 'list',
      parseArgs: (raw) => normalizeArgs(raw),
      handler: genericList(def),
    });
  }

  if (def.operations.get) {
    register({
      name: `${def.plural}-get`,
      description: `Get a ${def.name} by ID.`,
      access: def.operations.get,
      resource: def.plural,
      generic: 'get',
      parseArgs: (raw) => normalizeArgs(raw),
      handler: genericGet(def),
    });
  }

  if (def.operations.create) {
    register({
      name: `${def.plural}-create`,
      description: `Create a new ${def.name}.`,
      access: def.operations.create,
      resource: def.plural,
      parseArgs: (raw) => normalizeArgs(raw),
      handler: genericCreate(def),
    });
  }

  if (def.operations.update) {
    register({
      name: `${def.plural}-update`,
      description: `Update a ${def.name}.`,
      access: def.operations.update,
      resource: def.plural,
      parseArgs: (raw) => normalizeArgs(raw),
      handler: genericUpdate(def),
    });
  }

  if (def.operations.delete) {
    register({
      name: `${def.plural}-delete`,
      description: `Delete a ${def.name}.`,
      access: def.operations.delete,
      resource: def.plural,
      parseArgs: (raw) => normalizeArgs(raw),
      handler: genericDelete(def),
    });
  }

  // Custom operations
  if (def.customOperations) {
    for (const [verb, op] of Object.entries(def.customOperations)) {
      const opArgs = op.args;
      register({
        name: `${def.plural}-${verb.replace(/ /g, '-')}`,
        description: op.description,
        access: op.access,
        resource: def.plural,
        parseArgs: opArgs
          ? (raw) => {
              const normalized = normalizeArgs(raw);
              try {
                return validateArgs(opArgs, normalized);
              } catch (e) {
                const usageBlock = renderVerbHelp(def, verb) ?? '';
                throw new Error(`${(e as Error).message}\n\n${usageBlock}`);
              }
            }
          : (raw) => normalizeArgs(raw),
        handler: async (args, ctx) => op.handler(args as Record<string, unknown>, ctx),
      });
    }
  }
}
