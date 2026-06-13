/**
 * Runtime-CLI updater module (inventory F2/F4).
 *
 * Two clean halves:
 *   - `updater.ts` — the *mechanism*: install a version into its own immutable
 *     dir, list/remove installed versions, return a container mount. A provider
 *     instantiates one and exposes it as its `RUNTIME_UPDATER` extension.
 *   - `manager.ts` — the *policy*: the global, per-provider auto-update cadence
 *     (DB-persisted) and the periodic timer that fetches the latest CLI. Boot/
 *     shutdown and the command's global-admin verbs go through the registry.
 *     Per-group *selection* is not here — it rides the provider identity string
 *     and is resolved on the spawn path against the updater directly.
 */
export { RuntimeCliUpdater, maxSemver } from './updater.js';
export type { RuntimeCliUpdaterOptions } from './updater.js';
export {
  RuntimeUpdateManager,
  parseRuntimeUpdate,
  startRuntimeUpdaters,
  stopRuntimeUpdaters,
  getRuntimeUpdateManager,
  resolveSelectedVersion,
  markCliVersionInUse,
  releaseCliVersionInUse,
  cliVersionsInUse,
  canRemoveVersion,
  _resetRuntimeUpdatersForTests,
} from './manager.js';
export type { RuntimeUpdateConfig } from './manager.js';
