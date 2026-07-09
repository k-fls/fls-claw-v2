/**
 * scripts/sweep/config.ts — static defaults for the sweep toolkit.
 *
 * Everything here is overridable: thresholds/sensitive paths via ScanOptions,
 * routing weights via fork-registry/routing.yaml, scope via
 * fork-registry/sweep-scope.yaml on the state branch.
 */

export const DEFAULT_STATE_BRANCH = 'maint/fork-registry';

/** Directory prefixes on the state branch. */
export const STATE_DIR = 'sweep-state';
export const REGISTRY_DIR = 'fork-registry';
export const STATE_FILE = `${STATE_DIR}/sweep-state.json`;
export const LOG_FILE = `${STATE_DIR}/sweep-log.jsonl`;
export const RR_CACHE_DIR = `${STATE_DIR}/rr-cache`;
export const REPORTS_DIR = `${STATE_DIR}/reports`;

export const DEFAULT_UPSTREAM_REF = 'upstream/main';

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

/** Branch name globs never swept, never merged into, never enumerated as scope. */
export const EXCLUDED_BRANCH_GLOBS = [
  'everything*',
  'experimental/**',
  'wip/**',
  'worktree-agent-*',
  'integration/**',
  'test/**',
  'design/**',
  'docs/**',
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
