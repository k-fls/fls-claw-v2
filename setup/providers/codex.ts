/**
 * Codex provider setup on the MITM credential edition — credential status,
 * install verification, and the Codex-CLI failure assist.
 *
 * Owned here rather than copied from the payload: upstream's version binds the
 * ChatGPT session by writing a whole `auth.json` into the OneCLI vault, and
 * this edition has no vault. `setup/add-codex.sh` drops this path from its copy
 * list so a re-install cannot restore that one.
 *
 * On this edition a Codex credential is bound by the running host, in the
 * group's own channel: the wake-time acquisition gate offers the sign-in to a
 * group admin, a short-lived auth container runs the device login, and the
 * credential proxy captures the real tokens out of the token exchange. Setup
 * therefore verifies and reports; it never holds a credential of its own. See
 * `src/providers/codex-credential.ts`.
 *
 * Session-isolation invariant, unchanged and now evidenced: the bot's ChatGPT
 * session must be dedicated to it. OpenAI rotates refresh tokens and detects
 * reuse, so two consumers sharing one OAuth session invalidate the whole
 * session family for both — which is why nothing here ever copies an existing
 * `~/.codex/auth.json`.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { listScopes, readKeysFile } from '../../src/modules/credentials/index.js';
import { type AssistContext, BIG_PICTURE_FILES, STEP_FILES } from '../lib/claude-assist.js';
import { brandBody, note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { type FailureAssistResult, registerSetupProvider } from './registry.js';

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

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

/**
 * The Codex CLI can debug a setup failure only if the binary runs AND the
 * operator's own `~/.codex/auth.json` exists — the bot's credential lives in
 * the host credential store, which the host-side CLI cannot read.
 */
export function isCodexCliUsable(): boolean {
  const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (codexCheck.status !== 0) return false;
  return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
}

/**
 * Failure prompt handed to the interactive Codex session — same content as
 * the dispatcher's Claude system prompt: what failed, the job ("diagnose and
 * fix, be concise, exit when done"), and a de-duped file reference list.
 */
export function buildCodexFailurePrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath ? path.relative(projectRoot, ctx.rawLogPath) : 'logs/setup-steps/',
  ].filter((v, i, a) => a.indexOf(v) === i);

  const lines: string[] = [
    "The user is running NanoClaw's interactive setup flow and hit a failure.",
    '',
    `Failed step: ${ctx.stepName}`,
    `Error: ${ctx.msg}`,
  ];

  if (ctx.hint) lines.push(`Hint: ${ctx.hint}`);

  lines.push(
    '',
    'Your job: help them diagnose and fix this issue. Read the referenced files',
    'and logs to understand what went wrong, then help them fix it. You can read',
    'files, run commands, check logs, and explain what happened. Be concise.',
    "When they're ready to resume setup, tell them to exit Codex.",
    '',
    'Relevant files (read as needed):',
  );
  for (const f of references) lines.push(`  - ${f}`);

  return lines.join('\n');
}

/**
 * Registry hook: offer to debug a setup failure with the Codex CLI. Returns
 * 'unavailable' when the CLI can't run here so the dispatcher can fall back
 * to its guarded Claude offer.
 */
export async function offerCodexFailureAssist(ctx: AssistContext, projectRoot: string): Promise<FailureAssistResult> {
  if (!isCodexCliUsable()) return 'unavailable';

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want to debug this with Codex?',
      initialValue: true,
    }),
  );
  if (!want) return 'declined';

  const prompt = buildCodexFailurePrompt(ctx, projectRoot);

  note(
    [
      'Launching Codex to help debug this failure.',
      'It has the context of what went wrong.',
      '',
      k.dim("Exit Codex (Ctrl-C or /quit) when you're ready to come back to setup."),
    ].join('\n'),
    'Handing off to Codex',
  );

  return new Promise<FailureAssistResult>((resolve) => {
    // codex accepts a positional initial prompt for the interactive TUI.
    const child = spawn('codex', [prompt], { cwd: projectRoot, stdio: 'inherit' });
    child.on('close', () => {
      p.log.success(brandBody("Back from Codex. Let's continue."));
      resolve('launched');
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Codex.");
      resolve('unavailable');
    });
  });
}

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
  offerFailureAssist: offerCodexFailureAssist,
});
