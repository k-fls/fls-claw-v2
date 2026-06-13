/**
 * Runtime-CLI updater — the *mechanism* for installing a provider's agent-CLI
 * binary on the host so it can be updated **without an image rebuild**
 * (inventory F2/F4; generalizes the fork's claude-only `claude-updater`).
 *
 * Scope is deliberately tiny: install a version, return the host directory it
 * lives in. Each version installs into its own immutable directory
 * (`<DATA_DIR>/runtime-cli/<provider>/<version>/`), so there is no in-place
 * swap and no lock — a spawn only ever binds a fully-installed, never-mutated
 * dir, and a different version installs alongside. How that directory is
 * mounted into a container and wired to the runtime's CLI path is the
 * provider's concern (runtime-specific). Which version to run and on what
 * cadence is policy, owned by the update manager (`manager.ts`).
 *
 * Divergence from the fork (deliberate): v1 mounted the updated package *over*
 * the image-baked global package dir (`/usr/local/lib/node_modules/...`),
 * relying on the image's `claude` symlink resolving into it, and overwrote in
 * place (hence its RW-lock). v2's image installs CLIs via **pnpm global** at
 * `/pnpm`, whose internal store layout is fragile to target. Instead v2
 * installs a **self-contained** copy with `npm install --prefix` (deterministic
 * `node_modules/<pkg>/` layout, native-binary postinstall runs), mounts it at
 * its own path, and names the executable explicitly — no dependence on pnpm
 * internals. The throwaway install runs the same image, so the native binary
 * variant matches the agent container.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR } from '../../config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from '../../container-runtime.js';
import { log } from '../../log.js';
import type { RuntimeUpdaterExt } from '../credentials/providers/types.js';

/**
 * Newest version from a list by numeric `x.y.z` comparison, or null if empty.
 * Used to resolve a `latest` selection to the newest *fetched* version (the
 * consumer's policy choice — not an updater concern). Non-numeric segments
 * fall back to a string compare so unexpected tags still order deterministically.
 */
export function maxSemver(versions: string[]): string | null {
  if (versions.length === 0) return null;
  const cmp = (a: string, b: string): number => {
    const pa = a.split('.');
    const pb = b.split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = Number(pa[i]);
      const nb = Number(pb[i]);
      if (Number.isInteger(na) && Number.isInteger(nb)) {
        if (na !== nb) return na - nb;
      } else {
        const sc = (pa[i] ?? '').localeCompare(pb[i] ?? '');
        if (sc !== 0) return sc;
      }
    }
    return 0;
  };
  return versions.reduce((best, v) => (cmp(v, best) > 0 ? v : best));
}

export interface RuntimeCliUpdaterOptions {
  /** Provider id — keys the install dir. */
  providerId: string;
  /** Human label for status output (e.g. "Claude Code"). */
  label: string;
  /** npm package to install (e.g. "@anthropic-ai/claude-code"). */
  packageName: string;
  /** Test seam: override the install runner. */
  installRunner?: (targetDir: string, packageSpec: string) => boolean;
  /** Test seam: override the latest-version lookup. */
  latestVersionLookup?: () => string | null;
}

/** One updater per provider. Pure install+locate mechanism — no policy/state. */
export class RuntimeCliUpdater implements RuntimeUpdaterExt {
  readonly label: string;
  readonly packageName: string;

  private readonly opts: RuntimeCliUpdaterOptions;
  /** Host root for this provider's versioned installs. */
  private readonly root: string;

  constructor(opts: RuntimeCliUpdaterOptions) {
    this.opts = opts;
    this.label = opts.label;
    this.packageName = opts.packageName;
    this.root = path.join(DATA_DIR, 'runtime-cli', opts.providerId);
  }

  private versionDir(version: string): string {
    return path.join(this.root, version);
  }

  private pkgJsonPath(version: string): string {
    return path.join(this.versionDir(version), 'node_modules', this.packageName, 'package.json');
  }

  private isInstalled(version: string): boolean {
    return fs.existsSync(this.pkgJsonPath(version));
  }

  /** Versions with a complete install on disk (each version is its own dir). */
  installedVersions(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return []; // root doesn't exist yet
    }
    return entries.filter((e) => e.isDirectory() && this.isInstalled(e.name)).map((e) => e.name);
  }

  /** Remove an installed version's directory. No-op if absent. */
  remove(version: string): void {
    const dir = this.versionDir(version);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log.info('Removed runtime CLI version', { version, packageName: this.packageName });
    }
  }

  latestVersion(): string | null {
    if (this.opts.latestVersionLookup) return this.opts.latestVersionLookup();
    try {
      return execSync(`npm view ${this.packageName} version`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      }).trim();
    } catch (err) {
      log.warn('Failed to query latest runtime CLI version', { packageName: this.packageName, err });
      return null;
    }
  }

  /** Sync: the host directory of an already-installed version, or null. */
  installedDir(version: string): string | null {
    return this.isInstalled(version) ? this.versionDir(version) : null;
  }

  /**
   * Ensure `version` is installed (install it into its own dir if absent) and
   * return its host directory. Throws if the install fails.
   */
  async fetch(version: string): Promise<string> {
    if (!this.isInstalled(version)) {
      const ok = this.runInstallContainer(this.versionDir(version), `${this.packageName}@${version}`);
      if (!ok || !this.isInstalled(version)) {
        this.remove(version); // drop the partial dir so a retry starts clean
        throw new Error(`Failed to install ${this.packageName}@${version}`);
      }
    }
    return this.versionDir(version);
  }

  /** Run `npm install --prefix <targetDir> <packageSpec>` in a throwaway container. */
  private runInstallContainer(targetDir: string, packageSpec: string): boolean {
    if (this.opts.installRunner) return this.opts.installRunner(targetDir, packageSpec);
    fs.mkdirSync(targetDir, { recursive: true });

    const args = [
      'run',
      '--rm',
      '-v',
      `${targetDir}:/mount`,
      ...hostGatewayArgs(),
      '--entrypoint',
      'npm',
      CONTAINER_IMAGE,
      'install',
      '--prefix',
      '/mount',
      packageSpec,
    ];

    try {
      log.info('Running runtime CLI install container', { packageSpec });
      execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });
      return true;
    } catch (err) {
      log.error('Runtime CLI install container failed', { packageSpec, err });
      return false;
    }
  }
}
