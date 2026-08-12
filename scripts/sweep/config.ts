/**
 * scripts/sweep/config.ts — static defaults for the sweep toolkit.
 *
 * Durable tooling config (routing.yaml, scope.yaml, prompts, schema, test
 * cases, the inventory) lives in this directory and is read from the LOCAL
 * WORKING TREE. Live state is derived (from git/origin) or group-owned (files
 * in the sweep workspace) — there is no state branch.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory this toolkit lives in (module-relative config resolution). */
export const SWEEP_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ROUTING_FILE = join(SWEEP_DIR, 'registry', 'routing.yaml');
export const DEFAULT_SCOPE_FILE = join(SWEEP_DIR, 'registry', 'scope.yaml');

/**
 * Owner-approved CUT-POINT EXCEPTIONS (cut-points.ts) — facts about this fork's
 * GIT HISTORY that topology alone cannot express (a rebase copy of another
 * branch's commit; a branch its parent has already merged down).
 *
 * HOME: `scripts/sweep/`, beside checks.json — NOT `registry/`, NOT the
 * generator's seeds. It is DRIVER-read config that blame consumes, exactly like
 * checks.json is driver-read config that the checks gate consumes. `registry/`
 * holds the inventory's own JUDGEMENT (driver levers, scope policy) and
 * `.claude/skills/fork-registry-generate/seeds.yaml` feeds the GENERATOR, which
 * never runs in the driver's path; putting measured history facts in either
 * would make the driver depend on a file its own consumers do not own. Resolved
 * module-relative from the version-controlled toolkit tree, like every other
 * durable config here (see the header).
 */
export const DEFAULT_CUT_POINT_EXCEPTIONS_FILE = join(SWEEP_DIR, 'cut-point-exceptions.yaml');

/**
 * The inventory = `scripts/sweep/inventory/` — config tracked in the fork
 * repo. `--inventory` overrides it for tests/fixtures only; an inventory dir
 * at the group root is start-guard residue, not an input.
 */
export function defaultInventoryDir(): string | null {
  const inventory = join(SWEEP_DIR, 'inventory');
  return existsSync(inventory) ? inventory : null;
}

/** Group-workspace file/dir names (all under --workspace, default cwd). */
export const RR_CACHE_DIRNAME = 'rr-cache';

export const DEFAULT_UPSTREAM_REF = 'upstream/main';

/**
 * Fork point (nanocoai v2.1.1) — bounds the fork-era merge-edge walk of the
 * transitive edition-composition closure. Repos without this commit (fixtures)
 * walk unbounded.
 */
export const FORK_POINT = 'd85efea229ea63fb0bd4f57a039f4ef73ece563b';

/**
 * Case-stacking cap (DRIVER.md §4.4): a case is the maximal run of consecutive
 * path-intersecting conflicting heights, capped here by default. The lever:
 * global `stack_cap` in registry/routing.yaml; per-feature `stack_cap` on the
 * inventory entry (mirroring the scope-guard lever).
 */
export const DEFAULT_STACK_CAP = 5;

/**
 * Branch name globs never swept, never merged into, never enumerated as
 * scope. NOTE: fix/* (upstream-PR candidates) and docs/notes ARE swept in
 * this fork's practice — they enter scope via the transitive
 * edition-composition closure, so they must not be excluded here (only
 * fix/sweep/* is ours).
 */
export const EXCLUDED_BRANCH_GLOBS = [
  'everything*',
  'experimental/**',
  'wip/**',
  'worktree-agent-*',
  'integration/**',
  'test/**',
  'design/**',
  'maint/**',
  'sweep/**',
  'fix/sweep/**',
];

/** Branch namespaces expected to have a registry entry (validator rule 5). */
export const REGISTRY_REQUIRED_GLOBS = ['module/**', 'feat/**', 'edition/**'];

/** Authoritative CI verification commands (pipeline spec, placement section). */
export const VERIFY_COMMANDS: { cmd: string; cwd?: string }[] = [
  { cmd: 'pnpm install --frozen-lockfile' },
  { cmd: 'bun install --frozen-lockfile', cwd: 'container/agent-runner' },
  { cmd: 'pnpm run format:check' },
  { cmd: 'pnpm exec tsc --noEmit' },
  { cmd: 'pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit' },
  { cmd: 'pnpm exec vitest run' },
  { cmd: 'bun test', cwd: 'container/agent-runner' },
];
