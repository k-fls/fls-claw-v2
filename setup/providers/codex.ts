/**
 * Codex provider setup on the MITM credential edition — credential status and
 * install verification.
 *
 * Owned here rather than copied from the payload: upstream's version binds the
 * ChatGPT session by writing a whole `auth.json` into the OneCLI vault, and
 * this edition has no vault. `setup/add-codex.sh` drops this path from its copy
 * list so a re-install cannot restore that one.
 *
 * On this edition a Codex credential is bound by the running host, in the
 * group's own channel: the wake-time acquisition gate offers the sign-in to a
 * group admin, a short-lived auth container runs the chosen login route, and the
 * credential proxy captures the real tokens out of the token exchange. Setup
 * therefore verifies and reports; it never holds a credential of its own. See
 * `src/providers/codex-credential.ts`.
 *
 * The bot's ChatGPT session must be dedicated to it: OpenAI rotates refresh
 * tokens and detects reuse, so two consumers sharing one OAuth session
 * invalidate the whole session family for both. Nothing here ever copies an
 * existing `~/.codex/auth.json`.
 */
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { listScopes, readKeysFile } from '../../src/modules/credentials/index.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

const PROVIDER_ID = 'codex';

// ─── credential status ───────────────────────────────────────────────────

/**
 * Scopes holding a *complete* Codex credential. Presence in the store is
 * file-granular, so a keys file alone proves nothing: the substitute auth file
 * needs an access token, a refresh token and the ChatGPT account identifier,
 * and a credential missing any of them leaves the container with no usable
 * `auth.json`. Reported as absent so the in-channel sign-in still runs.
 */
export function scopesWithCodexCredential(): string[] {
  const complete: string[] = [];
  for (const scope of listScopes()) {
    let entries: Record<string, unknown>;
    try {
      entries = readKeysFile(scope, PROVIDER_ID);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt keys file is "not bound", not a setup failure
    } catch {
      continue;
    }
    const oauth = entries['oauth'] as { value?: unknown; refresh?: { value?: unknown } } | undefined;
    const accountId = entries['account_id'] as { value?: unknown } | undefined;
    if (oauth?.value && oauth.refresh?.value && accountId?.value) complete.push(String(scope));
  }
  return complete;
}

/**
 * Registry `runAuth` hook. Reports whether any group is already signed in and
 * explains where the sign-in happens; it binds nothing itself.
 *
 * Deliberately non-interactive: the sign-in needs a running host, a wired
 * channel and an identified group admin, none of which exist yet at this point
 * in setup. Offering a host-side login here would have to write a credential
 * somewhere setup can reach, which is the vault path this edition removed.
 */
export async function runCodexAuthStep(): Promise<void> {
  const signedIn = scopesWithCodexCredential();
  if (signedIn.length > 0) {
    setupLog.step('auth', 'skipped', 0, {
      REASON: 'codex-credential-already-bound',
      PROVIDER: PROVIDER_ID,
      SCOPES: signedIn.join(','),
    });
    p.log.success(brandBody(`Codex is already signed in for: ${signedIn.join(', ')}.`));
    return;
  }

  setupLog.step('auth', 'skipped', 0, { REASON: 'codex-signs-in-from-chat', PROVIDER: PROVIDER_ID });
  note(
    [
      'Codex signs in from chat, not from here.',
      '',
      'Send the first message to a Codex group and NanoClaw offers the ChatGPT',
      'sign-in to an admin of that group: a link and a pairing code arrive in',
      'their DM, they authorize at OpenAI, and the real tokens are captured on',
      'the host. The container only ever holds a substitute.',
      '',
      k.dim('Use a ChatGPT account dedicated to the bot — signing in with an'),
      k.dim('account you also use from your own Codex CLI evicts one of the two.'),
    ].join('\n'),
    'Connecting Codex',
  );
}

// ─── failure assist ──────────────────────────────────────────────────────

// ─── install verification ────────────────────────────────────────────────

/**
 * Verify the Codex payload is wired — the same pre-flight the `/add-codex`
 * skill checks. The CLI pin lives in the container manifest, not the
 * Dockerfile, which is what makes the image rebuild decision reachable.
 */
export function verifyCodexInstall(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const root = process.cwd();

  const requiredFiles = [
    'src/providers/codex.ts',
    'src/providers/codex-agents-md.ts',
    'src/providers/codex-credential.ts',
    'container/agent-runner/src/providers/codex.ts',
    'container/agent-runner/src/providers/codex-app-server.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of ['src/providers/index.ts', 'container/agent-runner/src/providers/index.ts']) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './codex.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const manifestPath = path.join(root, 'container', 'cli-tools.json');
  let hasCodexCli = false;
  if (fs.existsSync(manifestPath)) {
    try {
      const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Array<{ name?: string }>;
      hasCodexCli = Array.isArray(tools) && tools.some((t) => t.name === '@openai/codex');
      // eslint-disable-next-line no-catch-all/no-catch-all -- unparseable manifest means "pin absent"
    } catch {
      hasCodexCli = false;
    }
  }
  if (!hasCodexCli) {
    problems.push('container/cli-tools.json missing the @openai/codex CLI entry');
  }

  return { ok: problems.length === 0, problems };
}

export async function runCodexInstallCheck(): Promise<void> {
  p.log.step(brandBody('Checking the Codex provider install…'));
  const { ok, problems } = verifyCodexInstall();
  if (ok) {
    setupLog.step('codex-install', 'success', 0, {});
    p.log.success(brandBody('Codex installed properly.'));
    return;
  }

  setupLog.step('codex-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The Codex provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open Codex CLI or Claude Code in this repo and run the /add-codex skill. Setup will continue — Codex groups will work once the install completes.',
    ),
  );
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry — this call is codex's only reach-in to the setup
// flow (guarded by the barrel-driven registration test).
registerSetupProvider({
  value: PROVIDER_ID,
  label: 'Codex',
  hint: 'OpenAI — ChatGPT subscription, signed in from chat',
  runAuth: runCodexAuthStep,
  runInstallCheck: runCodexInstallCheck,
});
