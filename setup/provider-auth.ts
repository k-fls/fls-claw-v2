/**
 * Standalone provider auth — the late-adopter entry point.
 *
 * Fresh installs reach a provider's auth walk-through via the setup picker;
 * an existing install adding a provider later runs THIS instead:
 *
 *   pnpm exec tsx setup/index.ts --step provider-auth codex
 *
 * Same walk-through, idempotent (each provider's runAuth short-circuits when
 * its credential is already bound) — and unlike re-running full setup, it
 * touches nothing else: no install-wide default provider rewrite, no service
 * changes. Provider install skills call this as their auth step so there is
 * exactly one auth implementation per provider.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getSetupProvider, listSetupProviders } from './providers/registry.js';
// Provider payloads self-register on import.
import './providers/index.js';

// Hard-wired install scripts — the audited control surface (no branch
// enumeration). Each setup/add-<name>.sh is idempotent and self-skips when the
// payload is already wired. Codex is the only manifest-style provider today.
const INSTALL_SCRIPTS: Record<string, string> = {
  codex: 'setup/add-codex.sh',
};

export async function run(args: string[]): Promise<void> {
  const name = args[0]?.trim().toLowerCase();
  const withAuth = listSetupProviders().filter((entry) => entry.runAuth);

  if (!name) {
    console.error(
      `Usage: pnpm exec tsx setup/index.ts --step provider-auth <provider>\n` +
        `Providers with an auth step: ${withAuth.map((entry) => entry.value).join(', ') || '(none installed)'}`,
    );
    process.exit(1);
  }

  let entry = getSetupProvider(name);
  const script = INSTALL_SCRIPTS[name];
  if (script) {
    // Install OR refresh: the script is idempotent and is also the upgrade
    // path — payload files resync and a bumped CLI pin replaces the local one.
    // Rebuild the image only when something baked into it changed (payload code
    // is mounted, not baked). A provider CLI pin lands in the global-CLI
    // manifest rather than the Dockerfile, so watching the Dockerfile alone
    // leaves the image without the binary the provider is about to launch.
    const bakedFiles = ['container/Dockerfile', 'container/cli-tools.json'].map((rel) => path.join(process.cwd(), rel));
    const bakedBefore = bakedFiles.map((file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null));
    console.log(`${entry ? 'Refreshing' : 'Installing'} ${name}…`);
    execSync(`bash ${script}`, { stdio: 'inherit' });
    const changed = bakedFiles.filter(
      (file, i) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null) !== bakedBefore[i],
    );
    if (changed.length > 0) {
      console.log(`${changed.map((f) => path.basename(f)).join(', ')} changed — rebuilding the container image…`);
      execSync('./container/build.sh', { stdio: 'inherit' });
    }
    if (!entry) {
      await import(`./providers/${name}.js`);
      entry = getSetupProvider(name);
    }
    if (!entry) {
      console.error(`Install completed but ${name} did not register — check setup/providers/${name}.ts`);
      process.exit(1);
    }
  } else if (!entry) {
    console.error(
      `Unknown provider: ${name}. Installed: ${listSetupProviders()
        .map((e) => e.value)
        .join(', ')}.`,
    );
    process.exit(1);
  }
  if (!entry.runAuth) {
    console.error(`Provider "${name}" uses the standard auth flow — run the full setup, or /add-${name}'s steps.`);
    process.exit(1);
  }

  await entry.runAuth();
  await entry.runInstallCheck?.();
}
