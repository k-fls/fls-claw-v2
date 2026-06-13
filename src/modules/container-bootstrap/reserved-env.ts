/**
 * Reserved container env-var registry.
 *
 * Single source of truth for "which env-var names is the host
 * already injecting into containers." Consumed by the mitm-proxy
 * substitute endpoint (and any future runtime-substitute path) to
 * reject `?envVar=NAME` overrides that would silently shadow a
 * host-controlled var.
 *
 * Each contributor of `-e` flags reserves the names it injects, at
 * module load:
 *
 *   reserveEnvName('HTTP_PROXY', 'mitm-proxy');
 *
 * The container-runner registers its own statics
 * (`TZ`, `HOME`, `HOST_UID`, `HOST_GID`) below.
 *
 * Dangerous shell/runtime vars are always reserved — they aren't
 * injected by anyone, but allowing them via the substitute endpoint
 * would invite container escape via `LD_PRELOAD` and friends.
 */

const reserved = new Map<string, string>(); // name → owner (for debugging)

/** Names dangerous to the container regardless of contributor. */
const DANGEROUS = [
  'PATH',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'TERM',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'IFS',
  'CDPATH',
  'ENV',
  'NODE_OPTIONS',
];
for (const n of DANGEROUS) reserved.set(n, 'dangerous');

/**
 * Reserve an env-var name as injected/controlled by the host.
 * Re-registration by the same owner is a no-op; by a different owner
 * is logged at warn (caller decides whether to throw).
 */
export function reserveEnvName(name: string, owner: string): void {
  const existing = reserved.get(name);
  if (existing && existing !== owner) {
    // Don't import logger to avoid bootstrap circularity; stderr is fine.
    process.stderr.write(
      `[reserved-env] '${name}' already reserved by '${existing}', '${owner}' attempted to re-reserve\n`,
    );
    return;
  }
  reserved.set(name, owner);
}

/** Is this env-var name reserved by any contributor? */
export function isEnvNameReserved(name: string): boolean {
  return reserved.has(name);
}

/** Snapshot of the reserved set. */
export function reservedEnvNames(): ReadonlySet<string> {
  return new Set(reserved.keys());
}

/** @internal */
export function _resetReservedEnvForTests(): void {
  reserved.clear();
  for (const n of DANGEROUS) reserved.set(n, 'dangerous');
}

// ── Container-runner statics ───────────────────────────────────────────────
//
// These names are injected unconditionally by `src/container-runner.ts`
// at every spawn (see the -e args around line 538-586). Reserved here
// rather than at the call site so the registry is populated at module
// load — before any observer has a chance to query it.

reserveEnvName('TZ', 'container-runner');
reserveEnvName('HOME', 'container-runner');
reserveEnvName('HOST_UID', 'container-runner');
reserveEnvName('HOST_GID', 'container-runner');

// Entrypoint env-gate (passwd shim block in container/entrypoint.sh).
reserveEnvName('ENSURE_PASSWD_ENTRY', 'container-bootstrap');
