/**
 * Launch-mode resolution.
 *
 * Pure function over the aggregate `needsRootEntrypoint` flag from
 * `fireSpawnPre()` + A3 contributions.
 *
 *   rootless  → `--user UID:GID`. Default. Skips when host runs as
 *               root (UID 0) or the image's baked-in 1000 — matches
 *               the pre-A4 conditional in container-runner.
 *   root-drop → omits `--user`, passes HOST_UID / HOST_GID env. The
 *               entrypoint runs its root-only blocks, then setpriv-drops
 *               before exec-ing bun. Combined with host-side
 *               `--security-opt=no-new-privileges`, no privilege regain
 *               is possible after the drop.
 */

export type LaunchMode =
  | { kind: 'rootless'; userArg: string | null }
  | { kind: 'root-drop'; envVars: { HOST_UID: string; HOST_GID: string } };

export interface HostIds {
  uid: number | null;
  gid: number | null;
}

function readHostIds(): HostIds {
  return {
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
  };
}

export function resolveLaunchMode(needsRoot: boolean, ids: HostIds = readHostIds()): LaunchMode {
  if (needsRoot) {
    // Cannot resolve HOST_UID/GID if the platform doesn't expose them — fall
    // back to rootless rather than letting setpriv get a confusing empty arg.
    if (ids.uid == null || ids.gid == null) {
      return { kind: 'rootless', userArg: null };
    }
    return {
      kind: 'root-drop',
      envVars: { HOST_UID: String(ids.uid), HOST_GID: String(ids.gid) },
    };
  }

  // Rootless. Match pre-A4 behavior: only emit --user when host UID isn't
  // 0 (root) or 1000 (image default). On non-POSIX hosts where uid/gid are
  // undefined, omit --user entirely.
  if (ids.uid == null || ids.gid == null) return { kind: 'rootless', userArg: null };
  if (ids.uid === 0 || ids.uid === 1000) return { kind: 'rootless', userArg: null };
  return { kind: 'rootless', userArg: `${ids.uid}:${ids.gid}` };
}
