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
 * Mounts produced (all read-only):
 *   - snapshot `entrypoint.sh` → `/app/entrypoint.sh`
 *   - snapshot `agent-runner/src` → `/app/src`
 *   - snapshot `skills` → `/app/skills`
 *   - snapshot `CLAUDE.md` → `/app/CLAUDE.md` (if present)
 */
export function defaultLaunchShape(): LaunchShape {
  const mounts: VolumeMount[] = [];

  const entrypoint = snapshotPath('entrypoint.sh');
  if (fs.existsSync(entrypoint)) {
    mounts.push({ hostPath: entrypoint, containerPath: '/app/entrypoint.sh', readonly: true });
  }

  const agentRunnerSrc = snapshotPath('agent-runner/src');
  if (fs.existsSync(agentRunnerSrc)) {
    mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });
  }

  const skills = snapshotPath('skills');
  if (fs.existsSync(skills)) {
    mounts.push({ hostPath: skills, containerPath: '/app/skills', readonly: true });
  }

  const claudeMd = snapshotPath('CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    mounts.push({ hostPath: claudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  return { mounts };
}
