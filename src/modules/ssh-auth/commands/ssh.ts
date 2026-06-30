/**
 * SSH credential management commands — /ssh and /pem.
 *
 * /ssh add|delete|gen|test|reset-host|clear-pending
 * /pem add|delete
 *
 * Ported from the v1 fork's `commands/ssh-commands.ts`. The handler bodies
 * are structurally identical; only the wrapper changed: ChatIO/brandChat
 * → HostCommandContext + reply helper. PGP-encrypted secret capture now
 * uses `pastePgp` (interactions/A1a slot) instead of v1's
 * `promptGpgEncrypt`.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../../log.js';
import { registerHostCommand, type HostCommandContext } from '../../../command-gate.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { notifyAgent } from '../../approvals/primitive.js';
import {
  asCredentialScope,
  asGroupScope,
  ensureGpgKey,
  getOrCreateResolverForAgentGroup,
  gpgDecrypt,
  gpgHomeForScope,
  isPgpMessage,
  keysFilePath,
  normalizeArmoredBlock,
  updateKeysFile,
  type Credential,
  type CredentialResolver as V2CredentialResolver,
  type CredentialScope,
  type GroupScope,
} from '../../credentials/index.js';
import { pastePgp } from '../../interactions/index.js';
import { getSSHManager } from '../init.js';
import {
  isFingerprint,
  isValidAlias,
  parseConnectionString,
  PEM_PASSWORDS_PROVIDER_ID,
  SSH_PROVIDER_ID,
  sshFromCredential,
  sshToCredential,
} from '../types.js';
import type { SSHCredentialMeta } from '../types.js';
import { SSHError, SSHHostKeyMismatchError } from '../manager.js';
import { clearAllPending, takePendingForAlias } from '../pending.js';
import { getSession } from '../../../db/sessions.js';

// ── Helpers ───────────────────────────────────────────────────────

const SSH_BRAND = '🔑';

interface CommandScope {
  groupScope: GroupScope;
  credScope: CredentialScope;
  agentGroupId: string;
  resolver: V2CredentialResolver;
}

/**
 * Resolve the agent-group's folder-derived scopes and a v2 resolver from
 * the host-command ctx. Replies with an error message and returns null
 * when the agent group can't be looked up.
 */
function commandScope(ctx: HostCommandContext): CommandScope | null {
  if (!ctx.agentGroupId) {
    ctx.replyText(`${SSH_BRAND} must be invoked against an agent group.`);
    return null;
  }
  const ag = getAgentGroup(ctx.agentGroupId);
  if (!ag) {
    ctx.replyText(`${SSH_BRAND} agent group not found.`);
    return null;
  }
  const groupScope = asGroupScope(ag.folder);
  const credScope = asCredentialScope(ag.folder);
  return {
    groupScope,
    credScope,
    agentGroupId: ag.id,
    resolver: getOrCreateResolverForAgentGroup(ag.folder),
  };
}

function reply(ctx: HostCommandContext, text: string): void {
  ctx.replyText(`${SSH_BRAND} ${text}`);
}

/**
 * Push a system message to the specific session that originally requested
 * the credential. Session id is globally unique; if the session is gone,
 * drop the notification silently.
 */
function notifyAgentSession(sessionId: string, text: string): boolean {
  const session = getSession(sessionId);
  if (!session) return false;
  notifyAgent(session, text);
  return true;
}

/**
 * Extract a PGP/PEM block from text (possibly after command args).
 * Returns the block or null.
 */
function extractSecretBlock(text: string): string | null {
  // PGP message
  const pgpMatch = text.match(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/);
  if (pgpMatch) return normalizeArmoredBlock(pgpMatch[0]);

  // OpenSSH private key
  const sshMatch = text.match(/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/);
  if (sshMatch) return normalizeArmoredBlock(sshMatch[0]);

  // RSA private key
  const rsaMatch = text.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/);
  if (rsaMatch) return normalizeArmoredBlock(rsaMatch[0]);

  return null;
}

/**
 * Detect if a PEM is passphrase-encrypted.
 */
function isPemEncrypted(pem: string): boolean {
  if (pem.includes('ENCRYPTED')) return true;
  // OpenSSH format: try parsing — if ssh-keygen -y fails without passphrase, it's encrypted
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pem-'));
  const tmpFile = path.join(tmpDir, 'key');
  try {
    fs.writeFileSync(tmpFile, pem, { mode: 0o600 });
    execFileSync('ssh-keygen', ['-y', '-P', '', '-f', tmpFile], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return false; // No passphrase needed
  } catch {
    return true; // Needs passphrase
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Try to strip passphrase from an encrypted PEM using stored passphrases.
 * Returns { strippedPem, publicKey } on success, null on failure.
 */
function tryStripPassphrase(
  pem: string,
  cs: CommandScope,
  hintId?: string,
): { strippedPem: string; publicKey: string } | null {
  const { credScope, resolver } = cs;

  // Load PEM password candidates
  const candidates: Array<{ id: string; passphrase: string }> = [];
  if (hintId) {
    const cred = resolver.resolve(credScope, PEM_PASSWORDS_PROVIDER_ID, hintId);
    if (cred) candidates.push({ id: hintId, passphrase: cred.value });
  } else {
    // Scan all stored passphrases in scope
    const keysFile = keysFilePath(credScope, PEM_PASSWORDS_PROVIDER_ID);
    try {
      const raw = fs.readFileSync(keysFile, 'utf-8');
      const data = JSON.parse(raw) as Record<string, any>;
      for (const [id, entry] of Object.entries(data)) {
        if (id === 'v' || !entry?.value) continue;
        const cred = resolver.resolve(credScope, PEM_PASSWORDS_PROVIDER_ID, id);
        if (cred) candidates.push({ id, passphrase: cred.value });
      }
    } catch {
      // No PEM passwords stored
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-strip-'));
  const tmpFile = path.join(tmpDir, 'key');
  try {
    for (const { passphrase } of candidates) {
      fs.writeFileSync(tmpFile, pem, { mode: 0o600 });
      try {
        // Try extracting public key with this passphrase
        const pubKey = execFileSync('ssh-keygen', ['-y', '-P', passphrase, '-f', tmpFile], {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();

        // Strip passphrase
        execFileSync('ssh-keygen', ['-p', '-P', passphrase, '-N', '', '-f', tmpFile], { timeout: 5000 });

        const strippedPem = fs.readFileSync(tmpFile, 'utf-8');
        return { strippedPem, publicKey: pubKey };
      } catch {
        // Wrong passphrase, try next
        continue;
      }
    }
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Derive public key from an unencrypted PEM.
 */
function derivePublicKey(pem: string): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pub-'));
  const tmpFile = path.join(tmpDir, 'key');
  try {
    fs.writeFileSync(tmpFile, pem, { mode: 0o600 });
    return execFileSync('ssh-keygen', ['-y', '-f', tmpFile], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Parse /ssh add args: alias user@host[:port] [hostKey=*|<fp>] [pem=<id>] [secret block...]
 */
function parseSshAddArgs(args: string): {
  alias: string;
  connStr?: string;
  hostKeyOverride?: string;
  pemHint?: string;
  rest: string;
} | null {
  const firstLine = args.split('\n')[0];
  const parts = firstLine.trim().split(/\s+/);
  if (parts.length < 1) return null;

  const alias = parts[0];
  let connStr: string | undefined;
  let hostKeyOverride: string | undefined;
  let pemHint: string | undefined;
  let restStart = alias.length;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('hostKey=')) {
      hostKeyOverride = p.slice(8);
    } else if (p.startsWith('pem=')) {
      pemHint = p.slice(4);
    } else if (!connStr && p.includes('@')) {
      connStr = p;
    }
    restStart = args.indexOf(p, restStart) + p.length;
  }

  return {
    alias,
    connStr,
    hostKeyOverride,
    pemHint,
    rest: args.slice(restStart),
  };
}

// ── /ssh command ──────────────────────────────────────────────────

const SSH_HELP = 'SSH credential management — /ssh add|delete|gen|test|reset-host|clear-pending';

registerHostCommand(
  '/ssh',
  async (ctx) => {
    if (ctx.argsRaw.trim().length === 0) {
      reply(
        ctx,
        '*SSH Commands*\n' +
          '`/ssh add <alias> user@host[:port] [hostKey=*|<fingerprint>] [pem=<id>] [GPG/PEM block]`\n' +
          '`/ssh delete <alias>`\n' +
          '`/ssh gen <alias> user@host[:port]`\n' +
          '`/ssh test <alias> [pin] [timeout=N]`\n' +
          '`/ssh reset-host <alias> [hostKey=*|<fingerprint>]`\n' +
          '`/ssh clear-pending`',
      );
      return;
    }

    const cs = commandScope(ctx);
    if (!cs) return;

    const args = ctx.argsRaw;
    const trimmed = args.trim();
    const parts = trimmed.split(/\s+/);
    const subcommand = parts[0];
    const subArgs = args.slice(args.indexOf(subcommand) + subcommand.length).trim();

    switch (subcommand) {
      case 'add':
        return handleSshAdd(ctx, cs, subArgs);
      case 'delete':
        return handleSshDelete(ctx, cs, subArgs);
      case 'gen':
        return handleSshGen(ctx, cs, subArgs);
      case 'test':
        return handleSshTest(ctx, cs, subArgs);
      case 'reset-host':
        return handleSshResetHost(ctx, cs, subArgs);
      case 'clear-pending':
        return handleSshClearPending(ctx, cs);
      default:
        reply(ctx, `Unknown subcommand: ${subcommand}. Use \`/ssh\` for help.`);
    }
  },
  { scope: 'agent', help: SSH_HELP },
);

async function handleSshAdd(ctx: HostCommandContext, cs: CommandScope, args: string): Promise<void> {
  const parsed = parseSshAddArgs(args);
  if (!parsed || !parsed.alias) {
    reply(ctx, 'Usage: `/ssh add <alias> user@host[:port] [GPG/PEM block]`');
    return;
  }
  if (!isValidAlias(parsed.alias)) {
    reply(ctx, 'Invalid alias. Use alphanumeric, hyphens, underscores. Max 60 chars.');
    return;
  }

  // Check if already exists
  const existing = cs.resolver.resolve(cs.credScope, SSH_PROVIDER_ID, parsed.alias);
  if (existing) {
    reply(ctx, `Credential '${parsed.alias}' already exists. Delete first with \`/ssh delete ${parsed.alias}\`.`);
    return;
  }

  if (!parsed.connStr) {
    reply(ctx, 'Connection string required: `/ssh add <alias> user@host[:port]`');
    return;
  }
  const conn = parseConnectionString(parsed.connStr);
  if (!conn) {
    reply(ctx, 'Invalid connection string. Use `user@host[:port]` format.');
    return;
  }

  // Check for inline secret
  const secretBlock = extractSecretBlock(args);

  if (secretBlock) {
    // Inline secret — process immediately
    const result = processSecret(cs, secretBlock, parsed.alias, conn, parsed.hostKeyOverride, parsed.pemHint);
    reply(ctx, result);
    return;
  }

  // No inline secret — prompt for it via GPG-encrypted paste
  ensureGpgKey(cs.credScope);
  const res = await pastePgp({
    ctx,
    prompt:
      `${SSH_BRAND} Paste your SSH password or private key as a PGP-encrypted block. ` +
      `Use the helper at ${gpgHomeForScope(cs.credScope)} or type "cancel".`,
    gpgHome: gpgHomeForScope(cs.credScope),
  });
  if (res.text == null) return;

  const result = processSecret(cs, res.text, parsed.alias, conn, parsed.hostKeyOverride, parsed.pemHint);
  reply(ctx, result);
}

function processSecret(
  cs: CommandScope,
  block: string,
  alias: string,
  conn: { username: string; host: string; port: number },
  hostKeyOverride?: string,
  pemHint?: string,
): string {
  let secret: string;
  let authType: 'password' | 'key';
  let publicKey: string | undefined;

  // Decrypt if PGP-wrapped, otherwise treat as already-decrypted plaintext
  // (from pastePgp or raw PEM input)
  const wasPgp = isPgpMessage(block);
  const plaintext = wasPgp ? gpgDecrypt(cs.credScope, block) : block;

  if (plaintext.includes('PRIVATE KEY')) {
    if (isPemEncrypted(plaintext)) {
      const stripped = tryStripPassphrase(plaintext, cs, pemHint);
      if (!stripped) {
        return 'Key is passphrase-protected but no stored passphrase matches. Register with `/pem add <id>` then retry.';
      }
      secret = stripped.strippedPem;
      publicKey = stripped.publicKey;
    } else if (wasPgp) {
      // Unencrypted PEM inside GPG envelope — accept
      secret = plaintext;
      publicKey = derivePublicKey(plaintext) || undefined;
    } else {
      // Raw unencrypted PEM — reject unless it came from the PGP paste flow
      return 'Unencrypted private key rejected. Encrypt with GPG or protect with a passphrase.';
    }
    authType = 'key';
  } else {
    // Not a PEM — treat as password
    secret = plaintext.trim();
    authType = 'password';
  }

  // Build credential metadata
  let hostKey: string | null = null;
  if (hostKeyOverride === '*') {
    hostKey = '*';
  } else if (hostKeyOverride) {
    if (!isFingerprint(hostKeyOverride)) {
      return 'Invalid hostKey. Use `*` or a fingerprint (`SHA256:...` / `MD5:...`).';
    }
    hostKey = hostKeyOverride;
  }

  const meta: SSHCredentialMeta = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    authType,
    publicKey,
    hostKey,
  };

  cs.resolver.store(cs.credScope, SSH_PROVIDER_ID, alias, sshToCredential(secret, meta));
  log.info('ssh.credential_stored', { alias, scope: cs.groupScope, authType });

  let msg = `SSH credential '${alias}' stored (${authType}).`;
  if (publicKey) msg += `\nPublic key: \`${publicKey}\``;
  if (hostKey === '*') msg += '\n⚠️ Host key verification disabled for this alias.';

  // Drain any pending requests for this alias and notify each requesting
  // session. Same alias can be requested independently from multiple
  // sessions; each must hear back.
  const pending = takePendingForAlias(cs.groupScope, alias);
  if (pending.length > 0) {
    log.info('ssh.pending_fulfilled', {
      alias,
      scope: cs.groupScope,
      requesters: pending.length,
    });
    let agentMsg = `SSH credential '${alias}' added.`;
    if (publicKey) agentMsg += ` Public key: ${publicKey}`;
    let delivered = 0;
    for (const entry of pending) {
      if (notifyAgentSession(entry.sessionId, agentMsg)) {
        delivered++;
      }
    }
    if (delivered > 0) {
      msg += `\nPending agent request fulfilled (${delivered}/${pending.length}).`;
    }
  }

  return msg;
}

async function handleSshDelete(ctx: HostCommandContext, cs: CommandScope, args: string): Promise<void> {
  const alias = args.trim().split(/\s+/)[0];
  if (!alias || !isValidAlias(alias)) {
    reply(ctx, 'Usage: `/ssh delete <alias>`');
    return;
  }

  const sshManager = getSSHManager();

  // Disconnect if active
  await sshManager.disconnect(cs.groupScope, alias);

  // Delete from keys file (atomic merge through credentials/store)
  updateKeysFile(cs.credScope, SSH_PROVIDER_ID, (data) => {
    delete data[alias];
  });

  // Flush cache (resolver.unloadCache is also fired by invalidateScope,
  // but this keeps the v1 call shape explicit).
  cs.resolver.unloadCache(cs.credScope, SSH_PROVIDER_ID);
  log.info('ssh.credential_deleted', { alias, scope: cs.groupScope });

  reply(ctx, `SSH credential '${alias}' deleted.`);
}

async function handleSshGen(ctx: HostCommandContext, cs: CommandScope, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const alias = parts[0];
  const connStr = parts[1];

  if (!alias || !isValidAlias(alias)) {
    reply(ctx, 'Usage: `/ssh gen <alias> user@host[:port]`');
    return;
  }
  if (!connStr) {
    reply(ctx, 'Connection string required: `/ssh gen <alias> user@host[:port]`');
    return;
  }

  const conn = parseConnectionString(connStr);
  if (!conn) {
    reply(ctx, 'Invalid connection string.');
    return;
  }

  // Check if already exists
  const existing = cs.resolver.resolve(cs.credScope, SSH_PROVIDER_ID, alias);
  if (existing) {
    reply(ctx, `Credential '${alias}' already exists.`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-keygen-'));
  const keyPath = path.join(tmpDir, 'key');
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `nanoclaw-${alias}`], {
      timeout: 10000,
    });

    const privateKey = fs.readFileSync(keyPath, 'utf-8');
    const publicKey = fs.readFileSync(keyPath + '.pub', 'utf-8').trim();

    const meta: SSHCredentialMeta = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authType: 'key',
      publicKey,
      hostKey: null,
    };

    cs.resolver.store(cs.credScope, SSH_PROVIDER_ID, alias, sshToCredential(privateKey, meta));
    log.info('ssh.credential_stored', {
      alias,
      scope: cs.groupScope,
      authType: 'key',
    });

    reply(
      ctx,
      `SSH keypair generated for '${alias}'.\n` +
        `Add this public key to the remote server's \`authorized_keys\`:\n\n\`${publicKey}\``,
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function handleSshTest(ctx: HostCommandContext, cs: CommandScope, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const alias = parts[0];
  if (!alias || !isValidAlias(alias)) {
    reply(ctx, 'Usage: `/ssh test <alias> [pin] [timeout=N]`');
    return;
  }

  const pinFlag = parts.includes('pin');
  let timeout = 5;
  for (const p of parts) {
    if (p.startsWith('timeout=')) {
      timeout = parseInt(p.slice(8), 10) || 5;
    }
  }

  const sshManager = getSSHManager();
  try {
    const conn = await sshManager.connect(cs.groupScope, alias, {
      timeout,
      pinAllowed: pinFlag,
    });
    await sshManager.disconnect(cs.groupScope, alias);
    const hkStatus = conn.hostKeyFingerprint
      ? `Host key: ${conn.hostKeyFingerprint} (${conn.hostKeyAction})`
      : `Host key: (${conn.hostKeyAction})`;
    reply(ctx, `Connection test for '${alias}' (${conn.username}@${conn.host}:${conn.port}): ✓ Success\n${hkStatus}`);
  } catch (err) {
    if (err instanceof SSHHostKeyMismatchError) {
      reply(
        ctx,
        `HOST KEY MISMATCH for '${err.alias}' (${err.host}:${err.port}).\n` +
          `Stored: ${err.storedFingerprint}\nScanned: ${err.scannedFingerprint}`,
      );
      return;
    }
    if (err instanceof SSHError) {
      reply(ctx, `Connection test for '${alias}' failed: ${err.message}`);
      return;
    }
    reply(ctx, `Connection test for '${alias}' failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

function handleSshResetHost(ctx: HostCommandContext, cs: CommandScope, args: string): void {
  const parts = args.trim().split(/\s+/);
  const alias = parts[0];
  if (!alias || !isValidAlias(alias)) {
    reply(ctx, 'Usage: `/ssh reset-host <alias> [hostKey=*|<fingerprint>]`');
    return;
  }

  let newHostKey: string | null = null;
  for (const p of parts.slice(1)) {
    if (p.startsWith('hostKey=')) {
      const val = p.slice(8);
      if (val !== '*' && !isFingerprint(val)) {
        reply(ctx, 'Invalid hostKey. Use `*` or a fingerprint (`SHA256:...` / `MD5:...`).');
        return;
      }
      newHostKey = val;
    }
  }

  const cred = cs.resolver.resolve(cs.credScope, SSH_PROVIDER_ID, alias);
  if (!cred) {
    reply(ctx, `No credential found for '${alias}'.`);
    return;
  }

  const parsed = sshFromCredential(cred);
  if (!parsed) {
    reply(ctx, `Invalid credential format for '${alias}'.`);
    return;
  }

  // Update hostKey
  parsed.meta.hostKey = newHostKey;
  cs.resolver.store(cs.credScope, SSH_PROVIDER_ID, alias, sshToCredential(parsed.secret, parsed.meta));

  let msg = `Host key cleared for '${alias}'. Next connection will re-verify (TOFU).`;
  if (newHostKey === '*') {
    msg = `⚠️ Host key verification disabled for '${alias}'. All future connections will skip verification.`;
  } else if (newHostKey) {
    msg = `Host key pinned for '${alias}'.`;
  }

  reply(ctx, msg);
}

function handleSshClearPending(ctx: HostCommandContext, cs: CommandScope): void {
  const count = clearAllPending(cs.groupScope);
  reply(ctx, `Cleared ${count} pending SSH credential request(s).`);
}

// ── /pem command ──────────────────────────────────────────────────

const PEM_HELP = 'PEM passphrase management — /pem add|delete';

registerHostCommand(
  '/pem',
  async (ctx) => {
    if (ctx.argsRaw.trim().length === 0) {
      reply(ctx, '*PEM Passphrase Commands*\n' + '`/pem add <id> [GPG block]`\n' + '`/pem delete <id>`');
      return;
    }

    const cs = commandScope(ctx);
    if (!cs) return;

    const args = ctx.argsRaw;
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0];
    const subArgs = args.slice(args.indexOf(subcommand) + subcommand.length).trim();

    switch (subcommand) {
      case 'add':
        return handlePemAdd(ctx, cs, subArgs);
      case 'delete':
        return handlePemDelete(ctx, cs, subArgs);
      default:
        reply(ctx, `Unknown subcommand: ${subcommand}. Use \`/pem\` for help.`);
    }
  },
  { scope: 'agent', help: PEM_HELP },
);

async function handlePemAdd(ctx: HostCommandContext, cs: CommandScope, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const id = parts[0];
  if (!id || !isValidAlias(id)) {
    reply(ctx, 'Usage: `/pem add <id> [GPG block]`');
    return;
  }

  // Check if already exists
  const existing = cs.resolver.resolve(cs.credScope, PEM_PASSWORDS_PROVIDER_ID, id);
  if (existing) {
    reply(ctx, `PEM passphrase '${id}' already exists. Delete first with \`/pem delete ${id}\`.`);
    return;
  }

  const storePassphrase = (passphrase: string): void => {
    const cred: Credential = {
      value: passphrase,
      expires_ts: 0,
      updated_ts: Date.now(),
    };
    cs.resolver.store(cs.credScope, PEM_PASSWORDS_PROVIDER_ID, id, cred);
    reply(ctx, `PEM passphrase '${id}' stored.`);
  };

  // Check for inline GPG block
  const inlineBlock = extractSecretBlock(args);

  if (inlineBlock) {
    if (!isPgpMessage(inlineBlock)) {
      reply(ctx, 'Expected a GPG-encrypted block.');
      return;
    }
    storePassphrase(gpgDecrypt(cs.credScope, inlineBlock).trim());
    return;
  }

  // Prompt for GPG-encrypted passphrase
  ensureGpgKey(cs.credScope);
  const res = await pastePgp({
    ctx,
    prompt: `${SSH_BRAND} Paste the PEM passphrase as a PGP-encrypted block, or type "cancel".`,
    gpgHome: gpgHomeForScope(cs.credScope),
  });
  if (res.text == null) return;
  storePassphrase(res.text);
}

function handlePemDelete(ctx: HostCommandContext, cs: CommandScope, args: string): void {
  const id = args.trim().split(/\s+/)[0];
  if (!id || !isValidAlias(id)) {
    reply(ctx, 'Usage: `/pem delete <id>`');
    return;
  }

  updateKeysFile(cs.credScope, PEM_PASSWORDS_PROVIDER_ID, (data) => {
    delete data[id];
  });

  cs.resolver.unloadCache(cs.credScope, PEM_PASSWORDS_PROVIDER_ID);

  reply(ctx, `PEM passphrase '${id}' deleted.`);
}
