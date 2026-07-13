/**
 * scripts/sweep/config.ts — static defaults for the sweep toolkit.
 *
 * Durable tooling config (routing.yaml, scope.yaml, prompts, schema, test
 * cases, bootstrap inventory snapshot) lives in this directory and is read
 * from the LOCAL WORKING TREE. Live state is derived (merge-base) or
 * group-owned (the ledger file in the sweep workspace). There is no state
 * branch (dissolved 2026-07-10 by owner decision).
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory this toolkit lives in (module-relative config resolution). */
export const SWEEP_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ROUTING_FILE = join(SWEEP_DIR, 'registry', 'routing.yaml');
export const DEFAULT_SCOPE_FILE = join(SWEEP_DIR, 'registry', 'scope.yaml');
export const DEFAULT_CASES_DIR = join(SWEEP_DIR, 'test-cases', 'cases');

/**
 * Default live inventory = the latest committed bootstrap snapshot
 * (scripts/sweep/bootstrap/fork-registry@<hash>/features). Groups pass
 * --inventory to point at a regenerated inventory in their workspace.
 */
export function defaultInventoryDir(): string | null {
  const bootstrap = join(SWEEP_DIR, 'bootstrap');
  if (!existsSync(bootstrap)) return null;
  const snapshots = readdirSync(bootstrap)
    .filter((name) => name.startsWith('fork-registry@'))
    .sort();
  if (snapshots.length === 0) return null;
  const features = join(bootstrap, snapshots[snapshots.length - 1], 'features');
  return existsSync(features) ? features : null;
}

/** Group-workspace file/dir names (all under --workspace, default cwd). */
export const LEDGER_FILENAME = 'sweep-ledger.json';
export const LOG_FILENAME = 'sweep-log.jsonl';
export const RR_CACHE_DIRNAME = 'rr-cache';
export const REPORTS_DIRNAME = 'reports';

export const DEFAULT_UPSTREAM_REF = 'upstream/main';

/**
 * Fork point (nanocoai v2.1.1) — bounds the fork-era merge-edge walk of the
 * D-033 edition-composition closure. Repos without this commit (fixtures)
 * walk unbounded.
 */
export const FORK_POINT = 'd85efea229ea63fb0bd4f57a039f4ef73ece563b';

/** New-file size thresholds (spec D-002; annotate-PoI "large file"). */
export const LARGE_SOURCE_BYTES = 15 * 1024;
export const LARGE_ANY_BYTES = 40 * 1024;
export const SOURCE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.sh', '.go', '.rs', '.c', '.h', '.sql'];

/** Roots under which a new directory containing SKILL.md counts as a new skill. */
export const SKILL_ROOTS = ['.claude/skills/', 'container/skills/', '.agents/skills/'];

/**
 * Sensitive surfaces (spec D-002): upstream touches to these paths always
 * produce an annotate-PoI of type sensitive-surface-touch.
 */
export const SENSITIVE_PATHS = [
  // credentials / auth
  '**/*credential*',
  '**/*oauth*',
  '**/auth/**',
  'src/providers/**',
  // mitm proxy / egress / firewall
  '**/*mitm*',
  '**/egress*',
  '**/*firewall*',
  // container spawn surface
  'src/container-runner.ts',
  'src/container-runtime.ts',
  'src/container-config.ts',
  'container/Dockerfile',
  'container/entrypoint.sh',
  'container/shims/**',
  // host-rpc auth surface
  'src/host-rpc/**',
  'src/mcp-tools/**',
];

/** Paths whose change counts as a dependency/SDK bump PoI. */
export const DEP_PATHS = ['package.json', '**/package.json', 'pnpm-lock.yaml', '**/bun.lock', '**/bun.lockb'];

/**
 * Branch name globs never swept, never merged into, never enumerated as
 * scope. NOTE: fix/* (upstream-PR candidates) and docs/notes ARE swept in
 * this fork's practice — they enter scope via registry/scope.yaml include
 * globs, so they must not be excluded here (only fix/sweep/* is ours).
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

export const DEFAULT_ROUTING = {
  weights: { owned: 10, touch: 6, symbol: 3, keyword: 1 },
  threshold: 6,
  top_k: 4,
};

/** Cap on diff text fetched per PoI for symbol_watch matching. */
export const DIFF_TEXT_CAP_BYTES = 64 * 1024;

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
