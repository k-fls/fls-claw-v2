/**
 * Codex setup-provider guards.
 *
 * This edition owns `setup/providers/codex.ts` — upstream's binds the ChatGPT
 * session into the OneCLI vault, which this fork removed. The guards below pin
 * the two properties that make the replacement safe to keep: the registry entry
 * is shaped exactly as the setup flow expects, and no path through the module
 * reaches a vault or reads an OpenAI key out of the install configuration.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asCredentialScope, writeKeysFile } from '../../src/modules/credentials/index.js';

import { getSetupProvider, listSetupProviders } from './registry.js';
import { scopesWithCodexCredential, verifyCodexInstall } from './codex.js';

const MODULE_PATH = path.join(process.cwd(), 'setup', 'providers', 'codex.ts');
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf-8');

let tmpHome = '';
let prevXdg: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-setup-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpHome;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('registration', () => {
  it('registers under the codex id with the hooks the setup flow binds to', () => {
    const entry = getSetupProvider('codex');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('codex');
    expect(entry!.runAuth).toBeTypeOf('function');
    expect(entry!.runInstallCheck).toBeTypeOf('function');
    expect(entry!.offerFailureAssist).toBeTypeOf('function');
    // Claude stays the built-in default and the first option in the picker.
    expect(listSetupProviders()[0]!.value).toBe('claude');
  });

  it('is reachable from the setup barrel, which the picker imports by path', () => {
    const barrel = fs.readFileSync(path.join(process.cwd(), 'setup', 'providers', 'index.ts'), 'utf-8');
    expect(barrel).toContain("import './codex.js';");
  });
});

describe('credential status', () => {
  it('reports a scope holding an access token, a refresh token and an account id', () => {
    writeKeysFile(asCredentialScope('signed-in'), 'codex', {
      oauth: { value: 'ACCESS', refresh: { value: 'REFRESH' } },
      account_id: { value: '8a1e0d3c-0000-4000-8000-000000000000' },
    });
    expect(scopesWithCodexCredential()).toEqual(['signed-in']);
  });

  it('treats a credential without a refresh token as absent', () => {
    writeKeysFile(asCredentialScope('partial-a'), 'codex', {
      oauth: { value: 'ACCESS' },
      account_id: { value: '8a1e0d3c-0000-4000-8000-000000000000' },
    });
    expect(scopesWithCodexCredential()).toEqual([]);
  });

  it('treats a credential without an account id as absent', () => {
    // The account id is swapped in lockstep with the bearer; without it the
    // substitute auth file cannot be written, so the sign-in must still run.
    writeKeysFile(asCredentialScope('partial-b'), 'codex', {
      oauth: { value: 'ACCESS', refresh: { value: 'REFRESH' } },
    });
    expect(scopesWithCodexCredential()).toEqual([]);
  });

  it('reports nothing when no scope holds a codex keys file', () => {
    writeKeysFile(asCredentialScope('other-provider'), 'claude', { oauth: { value: 'ACCESS' } });
    expect(scopesWithCodexCredential()).toEqual([]);
  });
});

describe('install verification', () => {
  it('passes on this tree, where the payload and both barrels are wired', () => {
    const { ok, problems } = verifyCodexInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it('names the CLI pin as a problem when the container manifest lacks it', () => {
    const manifestPath = path.join(process.cwd(), 'container', 'cli-tools.json');
    const original = fs.readFileSync(manifestPath, 'utf-8');
    const tools = (JSON.parse(original) as Array<{ name?: string }>).filter((t) => t.name !== '@openai/codex');
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(tools));
      const { ok, problems } = verifyCodexInstall();
      expect(ok).toBe(false);
      expect(problems).toContain('container/cli-tools.json missing the @openai/codex CLI entry');
    } finally {
      fs.writeFileSync(manifestPath, original);
    }
  });
});

describe('no vault path survives on this edition', () => {
  it('invokes no vault binary', () => {
    // The binary name as an argument, not the word in prose — the header
    // explains why this file is fork-owned and has to be able to say so.
    expect(SOURCE).not.toMatch(/['"]onecli['"]/);
    expect(SOURCE).not.toMatch(/['"]secrets['"]/);
  });

  it('reads no OpenAI key from anywhere and offers no api-key branch', () => {
    expect(SOURCE).not.toContain('OPENAI_API_KEY');
    expect(SOURCE).not.toMatch(/sk-/);
  });

  it('never runs `codex login`, which would write a credential setup cannot hold', () => {
    expect(SOURCE).not.toMatch(/'login'/);
    expect(SOURCE).not.toContain('--device-auth');
  });
});

describe('the install path holds one pin and describes one credential path', () => {
  const SCRIPT = fs.readFileSync(path.join(process.cwd(), 'setup', 'add-codex.sh'), 'utf-8');
  const SKILL = fs.readFileSync(path.join(process.cwd(), '.claude', 'skills', 'add-codex', 'SKILL.md'), 'utf-8');
  const REMOVE = fs.readFileSync(path.join(process.cwd(), '.claude', 'skills', 'add-codex', 'REMOVE.md'), 'utf-8');

  it("the install script's pin is the version the container manifest carries", () => {
    const scriptPin = /^CODEX_VERSION="([^"]+)"$/m.exec(SCRIPT)?.[1];
    expect(scriptPin).toMatch(/^\d+\.\d+\.\d+/);
    const tools = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'container', 'cli-tools.json'), 'utf-8'),
    ) as Array<{
      name?: string;
      version?: string;
    }>;
    expect(tools.find((t) => t.name === '@openai/codex')?.version).toBe(scriptPin);
  });

  it('the skill holds no second copy of the pin to drift from', () => {
    // One canonical prose home (the script) is what makes "held identical"
    // true by construction rather than by review.
    expect(SKILL).not.toMatch(/@openai\/codex", version: "\d/);
    expect(SKILL).toContain('CODEX_VERSION');
  });

  it('the skill and the removal note describe the proxy path, not a vault', () => {
    for (const [name, text] of [
      ['SKILL.md', SKILL],
      ['REMOVE.md', REMOVE],
    ] as const) {
      expect(text, name).not.toMatch(/vault-only/i);
      expect(text, name).not.toMatch(/onecli secrets/i);
      expect(text, name).not.toMatch(/auth\.json.{0,20}stub/i);
    }
    expect(SKILL).toContain('MITM credential proxy');
  });

  it('the skill names no remote this fork has no payload branch on', () => {
    // `origin` here is the fork; the payload lives on the nanoclaw remote, which
    // the install script resolves rather than assumes.
    expect(SKILL).not.toContain('git fetch origin providers');
    expect(SKILL).toContain('resolve_channels_remote');
  });

  it('the removal note reverses the credential-provider registration in the entry point', () => {
    // The credential registry is deliberately not barrel-driven, so deleting the
    // file without this line breaks host boot.
    expect(REMOVE).toContain('registerCodexCredentialProvider');
  });
});
