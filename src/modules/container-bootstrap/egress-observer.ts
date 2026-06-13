/**
 * Internal container-bootstrap observer: egress lockdown.
 *
 * When NANOCLAW_EGRESS_LOCKDOWN=true, contributes the docker flags + env that
 * let the root entrypoint install an in-container egress firewall, and forces
 * the root-drop launch mode so that entrypoint actually runs as root. The
 * firewall itself lives in `container/entrypoint.sh`; the policy lives in
 * `src/egress-lockdown.ts`. No-op when lockdown is disabled.
 *
 * Composes with the `container-ip` observer: that one supplies
 * `--network nanoclaw --ip <ip>` (kept intact — the fork does NOT remove the
 * host route the way upstream's `--internal` net does), this one layers the
 * capability + sysctl flags and the lockdown env on top.
 *
 * Self-registers at module load via the barrel side-effect import.
 */
import { egressLockdownEnabled, egressSpawnArgs, egressSpawnEnv } from '../../egress-lockdown.js';
import { registerContainerLifecycleObserver } from './registry.js';

registerContainerLifecycleObserver('egress', {
  onSpawnPre() {
    if (!egressLockdownEnabled()) return;
    return {
      args: egressSpawnArgs(),
      env: egressSpawnEnv(),
      needsRootEntrypoint: true,
    };
  },
});
