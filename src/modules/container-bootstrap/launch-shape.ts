/**
 * Default launch shape — the snapshot-derived mounts every container gets.
 *
 * Per-spawn dynamic mounts (session dir, group dir, `.claude-shared`,
 * additional container.json mounts, provider mounts, group contributions)
 * stay in `container-runner.buildMounts`. This file owns only the bits
 * that ride on the snapshot.
 */
import fs from 'fs';

import type { VolumeMount } from '../../providers/provider-container-registry.js';
import { snapshotPath } from './snapshot.js';

export interface LaunchShape {
  mounts: VolumeMount[];
}

/**
 * Provider-agnostic launch infrastructure (all read-only):
 *   - snapshot `entrypoint.sh` → `/app/entrypoint.sh`
 *   - snapshot `agent-runner/src` → `/app/src`
 *   - snapshot `skills` → `/app/skills`
 *   - snapshot `shims/xdg-open` → `/usr/local/bin/xdg-open` + `/usr/bin/xdg-open` (if present)
 *
 * The Claude base doc (`/app/CLAUDE.md`) is intentionally NOT here — it is an
 * agent *surface*, gated by `providesAgentSurfaces` at the buildMounts caller.
 * See `snapshotAgentSurfaces()`.
 */
export function defaultLaunchShape(): LaunchShape {
  const mounts: VolumeMount[] = [];

  const entrypoint = snapshotPath('entrypoint.sh');
  if (fs.existsSync(entrypoint)) {
    mounts.push({ hostPath: entrypoint, containerPath: '/app/entrypoint.sh', readonly: true });
  }

  // OAuth browser-launch interceptor. Mounted at BOTH the PATH location and
  // the absolute /usr/bin path (v1 parity) — some tools `xdg-open` via PATH,
  // others invoke /usr/bin/xdg-open directly. Relays known OAuth authorize
  // URLs to the host (see `mitm-proxy/browser-open-action.ts`); harmless if a
  // tool never calls it.
  const xdgOpen = snapshotPath('shims/xdg-open');
  if (fs.existsSync(xdgOpen)) {
    mounts.push({ hostPath: xdgOpen, containerPath: '/usr/local/bin/xdg-open', readonly: true });
    mounts.push({ hostPath: xdgOpen, containerPath: '/usr/bin/xdg-open', readonly: true });
  }

  const agentRunnerSrc = snapshotPath('agent-runner/src');
  if (fs.existsSync(agentRunnerSrc)) {
    mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });
  }

  const skills = snapshotPath('skills');
  if (fs.existsSync(skills)) {
    mounts.push({ hostPath: skills, containerPath: '/app/skills', readonly: true });
  }

  return { mounts };
}

/**
 * Snapshot-derived default *agent surfaces* (read-only). Split out of
 * `defaultLaunchShape` so the caller can withhold them for a provider that
 * owns its own surfaces (`providesAgentSurfaces`):
 *   - snapshot `CLAUDE.md` → `/app/CLAUDE.md` (if present)
 */
export function snapshotAgentSurfaces(): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  const claudeMd = snapshotPath('CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    mounts.push({ hostPath: claudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  return mounts;
}
