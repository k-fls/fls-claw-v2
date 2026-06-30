/**
 * `/creds` host command.
 *
 * Unified credential surface for both skills (group-oauth and ssh-auth):
 *
 *  - Sharing verbs (C7s): `share` / `borrow` / `revoke` / `stop-borrowing`
 *    and no-arg sharing status. Manipulate grant/borrow state on the
 *    filesystem and fire the manifest pipeline + scope invalidators. Never
 *    touch the proxy directly — the proxy plugs in via
 *    `registerScopeInvalidator`.
 *  - Credential-setting verbs (C7o): `set-key` / `import` (GPG-encrypted
 *    paste) / `delete` / `list` / `status`. Write the per-scope credential
 *    store through the resolver (which encrypts secret fields at rest); the
 *    MITM proxy resolves + swaps them per request.
 *  - Public-key export (C7g): `gpg` prints the group's ASCII-armored GPG
 *    public key + an encrypt link — load-bearing for the encrypted paste UX
 *    (the operator encrypts the secret to this key before `set-key`/`import`).
 *
 * Registered with `scope: 'agent'` so the handler can resolve the current
 * agent group via `ctx.agentGroupId`.
 */
import { getAgentGroup, getAgentGroupByFolder } from '../../../db/agent-groups.js';
import type { HostCommandContext } from '../../../command-gate.js';
import { pastePgp } from '../../interactions/index.js';

import {
  addGrantee,
  clearBorrowSource,
  getBorrowSource,
  isGrantee,
  listGrantees,
  removeGrantee,
  setBorrowSource,
} from '../grants.js';
import { planCredentialImport, type ImportToken } from '../import-resolver.js';
import { buildPgpEncryptUrl, ensureGpgKey, exportPublicKey, gpgHomeForScope, isGpgAvailable } from '../gpg.js';
import { distributeAllManifests, revokeGranteeManifests } from '../manifest.js';
import { getAllCredentialProviders, getCredentialProvider } from '../providers/registry.js';
import { getOrCreateResolverForAgentGroup } from '../resolver.js';
import { invalidateScope } from '../scope-invalidator.js';
import { listEntries, listProviderIds } from '../store.js';
import { asCredentialScope, type CredentialScope } from '../types.js';

/**
 * Default credential id used when `set-key` / `import` omits one. Matches
 * the proxy's `CRED_OAUTH` ('oauth'); kept as a local literal to avoid a
 * credentials → mitm-proxy import cycle.
 */
const DEFAULT_CREDENTIAL_ID = 'oauth';

const USAGE = [
  'Unknown subcommand. Usage:',
  '`/creds` — show sharing status',
  '*Sharing:*',
  '`/creds share <target>` — grant access',
  '`/creds borrow <source>` — borrow credentials',
  '`/creds revoke <target>` — revoke access',
  '`/creds stop-borrowing` — stop borrowing',
  '*Credentials:*',
  '`/creds set-key <provider> [id] [expiry=<ts>]` — store a key (GPG-encrypted paste)',
  '`/creds import [provider]` — bulk import `[provider:]id=value` lines (GPG-encrypted paste)',
  '`/creds delete <provider>` — delete a provider’s stored credentials',
  '`/creds list` — list providers with stored credentials',
  '`/creds status` — credential + sharing summary',
  '`/creds gpg` — print this group’s GPG public key for encrypting secrets',
].join('\n');

export const CREDS_HELP =
  'Manage credentials — /creds [share|borrow|revoke|stop-borrowing|set-key|import|delete|list|status|gpg]';

export function handleCredsCommand(ctx: HostCommandContext): void {
  if (!ctx.agentGroupId) {
    ctx.replyText('/creds must be invoked against an agent group.');
    return;
  }

  const self = getAgentGroup(ctx.agentGroupId);
  if (!self) {
    ctx.replyText('/creds: agent group not found.');
    return;
  }
  const selfFolder = self.folder;
  const scope = asCredentialScope(selfFolder);

  const sub = (ctx.args[0] ?? '').toLowerCase();
  const target = ctx.args[1];

  if (!sub) return replyStatus(ctx, selfFolder);

  switch (sub) {
    // ── Sharing (C7s) ────────────────────────────────────────────────────────
    case 'share':
      return replyShare(ctx, selfFolder, target);
    case 'borrow':
      return replyBorrow(ctx, selfFolder, target);
    case 'revoke':
      return replyRevoke(ctx, selfFolder, target);
    case 'stop-borrowing':
      return replyStopBorrowing(ctx, selfFolder);
    // ── Credential-setting (C7o) ───────────────────────────────────────────────
    case 'set-key':
      return replySetKey(ctx, scope);
    case 'import':
      return replyImport(ctx, scope);
    case 'delete':
      return replyDelete(ctx, scope, target);
    case 'list':
      return replyList(ctx, scope);
    case 'status':
      return replyCredentialStatus(ctx, selfFolder, scope);
    // ── Public key export (C7g) ─────────────────────────────────────────────────
    case 'gpg':
      return replyGpg(ctx, scope);
    default:
      ctx.replyText(USAGE);
  }
}

// ── Sharing subcommands (C7s) ─────────────────────────────────────────────────

function replyStatus(ctx: HostCommandContext, selfFolder: string): void {
  const source = getBorrowSource(selfFolder);
  const grantees = listGrantees(selfFolder);

  const lines: string[] = [`*Credentials for ${selfFolder}*`, ''];
  lines.push(source ? `Borrowing from: *${source}*` : 'Borrowing from: (none)');
  lines.push(
    grantees.length > 0 ? `Sharing with: ${grantees.map((g) => `*${g}*`).join(', ')}` : 'Sharing with: (none)',
  );
  ctx.replyText(lines.join('\n'));
}

function replyShare(ctx: HostCommandContext, selfFolder: string, target: string | undefined): void {
  if (!target) {
    ctx.replyText('Usage: /creds share <target-group-folder>');
    return;
  }
  if (target === selfFolder) {
    ctx.replyText('Cannot share with yourself.');
    return;
  }
  if (!getAgentGroupByFolder(target)) {
    ctx.replyText(`Unknown group folder: ${target}`);
    return;
  }
  if (isGrantee(selfFolder, target)) {
    ctx.replyText(`*${target}* is already in the grantee list.`);
    return;
  }

  addGrantee(selfFolder, target);
  distributeAllManifests(selfFolder, target);

  ctx.replyText(
    `Granted *${target}* access to *${selfFolder}* credentials.\n` +
      `The target group must run \`/creds borrow ${selfFolder}\` to activate.`,
  );
}

function replyBorrow(ctx: HostCommandContext, selfFolder: string, source: string | undefined): void {
  if (!source) {
    ctx.replyText('Usage: /creds borrow <source-group-folder>');
    return;
  }
  if (source === selfFolder) {
    ctx.replyText('Cannot borrow from yourself.');
    return;
  }
  if (!getAgentGroupByFolder(source)) {
    ctx.replyText(`Unknown group folder: ${source}`);
    return;
  }

  const current = getBorrowSource(selfFolder);
  if (current && current !== source) {
    ctx.replyText(`Already borrowing from *${current}*. Run \`/creds stop-borrowing\` first.`);
    return;
  }

  setBorrowSource(selfFolder, source);
  // Always invalidate — even when re-running borrow against the same
  // source, the cache may still hold a stale substitute from a prior
  // session. Cheap to recompute; expensive to be wrong.
  invalidateScope(asCredentialScope(selfFolder));

  if (isGrantee(source, selfFolder)) {
    ctx.replyText(`Now borrowing credentials from *${source}*. Active immediately.`);
    return;
  }

  ctx.replyText(
    `Credential source set to *${source}*, but access is *pending* — ` +
      `the source group must run \`/creds share ${selfFolder}\`.`,
  );
}

function replyRevoke(ctx: HostCommandContext, selfFolder: string, target: string | undefined): void {
  if (!target) {
    ctx.replyText('Usage: /creds revoke <target-group-folder>');
    return;
  }
  if (!isGrantee(selfFolder, target)) {
    ctx.replyText(`*${target}* is not in the grantee list.`);
    return;
  }

  removeGrantee(selfFolder, target);
  revokeGranteeManifests(selfFolder, target);

  // If the target was actively borrowing from us, clear their link too —
  // matches fork behavior: revoke severs the runtime path immediately.
  if (getBorrowSource(target) === selfFolder) {
    clearBorrowSource(target);
    invalidateScope(asCredentialScope(target));
  }

  ctx.replyText(`Revoked *${target}*'s access to *${selfFolder}* credentials.`);
}

function replyStopBorrowing(ctx: HostCommandContext, selfFolder: string): void {
  const source = getBorrowSource(selfFolder);
  if (!source) {
    ctx.replyText('Not borrowing from any group.');
    return;
  }
  clearBorrowSource(selfFolder);
  invalidateScope(asCredentialScope(selfFolder));
  ctx.replyText(`Stopped borrowing from *${source}*.`);
}

// ── Credential-setting subcommands (C7o) ──────────────────────────────────────

/** Validate a provider id against the registry. Returns a user-facing error or null. */
function unknownProviderError(providerId: string, scope: CredentialScope): string | null {
  // Scope-aware: recognizes per-group `.auth-discovery/` providers (scope tier)
  // alongside the global set.
  if (getCredentialProvider(providerId, scope)) return null;
  const known = getAllCredentialProviders(scope).map((p) => p.id);
  // The discovery set is large; only hint with a count, not the whole list.
  return `Unknown provider: *${providerId}* (${known.length} providers registered). Check the provider id.`;
}

/**
 * `/creds set-key <provider> [id] [expiry=<ts>]` — store one credential via a
 * GPG-encrypted paste. The decrypted value never travels through chat in
 * cleartext. Launches the paste interaction and returns immediately (the
 * router must not block on the multi-turn flow).
 */
function replySetKey(ctx: HostCommandContext, scope: CredentialScope): void {
  if (!isGpgAvailable()) {
    ctx.replyText('GPG is not available on the host. Install gnupg first.');
    return;
  }
  const providerId = ctx.args[1];
  if (!providerId) {
    ctx.replyText('Usage: /creds set-key <provider> [id] [expiry=<ts>]');
    return;
  }
  const provErr = unknownProviderError(providerId, scope);
  if (provErr) {
    ctx.replyText(provErr);
    return;
  }

  // Tokens after the provider: optional credential id + optional expiry=<ts>.
  let credentialId: string | undefined;
  let expiresTs = 0;
  for (const tok of ctx.args.slice(2)) {
    if (tok.startsWith('expiry=')) {
      const v = parseInt(tok.slice(7), 10);
      if (!Number.isNaN(v)) expiresTs = v;
    } else if (!credentialId) {
      credentialId = tok;
    }
  }
  const credId = credentialId ?? DEFAULT_CREDENTIAL_ID;

  ensureGpgKey(scope);
  void pastePgp({
    ctx,
    prompt:
      `Storing a *${providerId}* credential (*${credId}*), **GPG-encrypted** — never pasted in cleartext.\n\n` +
      `1. Encrypt the secret for this group here: ${buildPgpEncryptUrl(scope)}\n` +
      '2. Paste the resulting `-----BEGIN PGP MESSAGE-----` block back here.\n\n' +
      'Or reply `cancel`.',
    gpgHome: gpgHomeForScope(scope),
    validate: (plaintext) => (plaintext.trim().length > 0 ? null : 'The decrypted value is empty.'),
  }).then((r) => {
    if (r.reason !== 'submitted' || !r.text) {
      ctx.replyText(
        r.reason === 'cancelled' ? 'Cancelled — no credential stored.' : 'Timed out — no credential stored.',
      );
      return;
    }
    getOrCreateResolverForAgentGroup(scope).store(scope, providerId, credId, {
      value: r.text.trim(),
      updated_ts: Date.now(),
      expires_ts: expiresTs,
    });
    ctx.replyText(`Key stored for *${providerId}* (*${credId}*).`);
  });
}

/**
 * `/creds import [provider]` — bulk import via a GPG-encrypted paste of
 * `[provider:]KEY=value` lines. With an explicit `<provider>`, un-prefixed
 * lines attribute to it (single-provider form). Without it (bulk form), a
 * line carries a `provider:` prefix, or — when the key is an `ALL_CAPS`
 * env-var name — auto-resolves to the provider that declares it (the I2
 * reverse index, via the mitm-proxy planner). A matched env-var key is
 * stored under its binding's credentialPath (composite slices joined), not
 * the literal name.
 */
function replyImport(ctx: HostCommandContext, scope: CredentialScope): void {
  if (!isGpgAvailable()) {
    ctx.replyText('GPG is not available on the host. Install gnupg first.');
    return;
  }
  const defaultProviderId = ctx.args[1] ?? null;
  if (defaultProviderId) {
    const provErr = unknownProviderError(defaultProviderId, scope);
    if (provErr) {
      ctx.replyText(provErr);
      return;
    }
  }

  ensureGpgKey(scope);
  void pastePgp({
    ctx,
    prompt:
      'Bulk credential import, **GPG-encrypted** — never pasted in cleartext.\n\n' +
      `1. Encrypt your ${defaultProviderId ? `\`KEY=value\` lines for *${defaultProviderId}*` : '`[provider:]KEY=value` lines'} ` +
      `here: ${buildPgpEncryptUrl(scope)}\n` +
      '2. Paste the resulting `-----BEGIN PGP MESSAGE-----` block back here.\n\n' +
      (defaultProviderId ? '' : 'Un-prefixed `ALL_CAPS` env-var names auto-resolve to their provider. ') +
      '(Lines starting with `#` are ignored.) Or reply `cancel`.',
    gpgHome: gpgHomeForScope(scope),
    validate: (plaintext) =>
      tokenizeImportLines(plaintext).tokens.length > 0
        ? null
        : 'No valid `KEY=value` lines found in the decrypted message.',
  }).then((r) => {
    if (r.reason !== 'submitted' || !r.text) {
      ctx.replyText(r.reason === 'cancelled' ? 'Cancelled — nothing imported.' : 'Timed out — nothing imported.');
      return;
    }
    const { tokens, warnings: lineWarnings } = tokenizeImportLines(r.text);
    const resolver = getOrCreateResolverForAgentGroup(scope);
    const now = Date.now();
    const perProvider = new Map<string, number>();

    // Prefer the binding-aware planner (mitm-proxy): reverse index for
    // un-prefixed env-var names + binding credentialPath resolution +
    // composite joining. Falls back to literal storage when no planner is
    // registered (mitm-proxy not loaded).
    const plan = planCredentialImport(tokens, defaultProviderId, scope);
    if (plan) {
      for (const s of plan.stores) {
        resolver.store(scope, s.providerId, s.credentialId, { value: s.value, updated_ts: now, expires_ts: 0 });
        perProvider.set(s.providerId, (perProvider.get(s.providerId) ?? 0) + 1);
      }
      ctx.replyText(
        renderImportSummary(
          perProvider,
          plan.unknownProviders,
          [...lineWarnings, ...plan.warnings],
          plan.envVarsByProvider,
        ),
      );
      return;
    }

    // Fallback: store each line under its literal key as the credential id.
    const unknown = new Set<string>();
    const warnings = [...lineWarnings];
    for (const t of tokens) {
      if (defaultProviderId !== null && t.prefix !== null && t.prefix !== defaultProviderId) {
        // Never echo the value — these warnings are rendered back into chat.
        warnings.push(`ignored (${t.prefix} ≠ ${defaultProviderId}): ${t.key} (line ${t.line})`);
        continue;
      }
      const providerId = t.prefix ?? defaultProviderId;
      if (!providerId) {
        warnings.push(`no provider: ${t.key} (line ${t.line})`);
        continue;
      }
      if (unknownProviderError(providerId, scope)) {
        unknown.add(providerId);
        continue;
      }
      resolver.store(scope, providerId, t.key, { value: t.value, updated_ts: now, expires_ts: 0 });
      perProvider.set(providerId, (perProvider.get(providerId) ?? 0) + 1);
    }
    ctx.replyText(renderImportSummary(perProvider, [...unknown], warnings, {}));
  });
}

/**
 * Tokenize `[provider:]KEY=value` lines into raw tokens (prefix preserved).
 * A `provider:` prefix is recognized only when `:` appears before the first
 * `=`. Lines without a usable `KEY=value` are dropped with a warning;
 * blank / `#` lines are skipped. Ported from v1 `tokenizeImportLines`.
 */
function tokenizeImportLines(plaintext: string): { tokens: ImportToken[]; warnings: string[] } {
  const tokens: ImportToken[] = [];
  const warnings: string[] = [];
  // 1-based line number in the original paste — count every raw line, including
  // the blank / `#` lines we skip, so the number a warning cites matches what
  // the operator sees in their editor.
  let lineNo = 0;
  for (const raw of plaintext.split('\n')) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    const colonIdx = line.indexOf(':');
    const hasPrefix = colonIdx > 0 && (eqIdx < 0 || colonIdx < eqIdx);
    const prefix = hasPrefix ? line.slice(0, colonIdx).trim() : null;
    const rest = hasPrefix ? line.slice(colonIdx + 1).trim() : line;

    const restEq = rest.indexOf('=');
    const key = restEq >= 0 ? rest.slice(0, restEq).trim() : '';
    const value = restEq >= 0 ? rest.slice(restEq + 1).trim() : '';

    if (!key || !value) {
      // Don't echo the raw line — a bare token or `=secret` could be the
      // value itself. Report the key when we parsed one; otherwise stay
      // content-free. (Warnings are rendered back into chat.)
      warnings.push(
        key ? `malformed (no value): ${key} (line ${lineNo})` : `malformed: line ${lineNo} (expected KEY=value)`,
      );
      continue;
    }
    tokens.push({ prefix, key, value, line: lineNo });
  }
  return { tokens, warnings };
}

function renderImportSummary(
  perProvider: Map<string, number>,
  unknown: string[],
  warnings: string[],
  envVarsByProvider: Record<string, string[]>,
): string {
  const total = [...perProvider.values()].reduce((s, n) => s + n, 0);
  const parts: string[] = [];
  if (total === 0) {
    parts.push('Imported 0 credentials.');
  } else {
    parts.push(
      `Imported ${total} credential${total !== 1 ? 's' : ''} across ${perProvider.size} provider${perProvider.size !== 1 ? 's' : ''}.`,
    );
    for (const [id, n] of perProvider) {
      const envNames = envVarsByProvider[id];
      const envSeg = envNames && envNames.length > 0 ? ` | env: ${envNames.join(', ')}` : '';
      parts.push(`  - *${id}*: ${n} key${n !== 1 ? 's' : ''}${envSeg}`);
    }
  }
  if (unknown.length) parts.push(`Skipped unknown provider${unknown.length !== 1 ? 's' : ''}: ${unknown.join(', ')}`);
  if (warnings.length) parts.push(`Skipped lines:\n${warnings.map((w) => `  - ${w}`).join('\n')}`);
  return parts.join('\n');
}

/** `/creds delete <provider>` — drop a provider's stored credentials for this scope. */
function replyDelete(ctx: HostCommandContext, scope: CredentialScope, providerId: string | undefined): void {
  if (!providerId) {
    ctx.replyText('Usage: /creds delete <provider>');
    return;
  }
  const count = listEntries(scope, providerId).length;
  if (count === 0) {
    ctx.replyText(`No stored credentials for *${providerId}*.`);
    return;
  }
  getOrCreateResolverForAgentGroup(scope).delete(scope, providerId);
  ctx.replyText(`Deleted *${providerId}* credentials (${count} entr${count !== 1 ? 'ies' : 'y'} removed).`);
}

/** `/creds list` — providers with stored credentials + their entry ids. */
function replyList(ctx: HostCommandContext, scope: CredentialScope): void {
  const providers = listProviderIds(scope);
  if (providers.length === 0) {
    ctx.replyText('No credentials stored for this group.');
    return;
  }
  const lines: string[] = ['*Stored credentials*', ''];
  for (const p of providers.sort()) {
    const ids = listEntries(scope, p).sort();
    lines.push(`*${p}*: ${ids.length > 0 ? ids.join(', ') : '(empty)'}`);
  }
  ctx.replyText(lines.join('\n'));
}

/** `/creds status` — credential presence + sharing summary in one view. */
function replyCredentialStatus(ctx: HostCommandContext, selfFolder: string, scope: CredentialScope): void {
  const providers = listProviderIds(scope);
  const source = getBorrowSource(selfFolder);
  const grantees = listGrantees(selfFolder);

  const lines: string[] = [`*Credential status for ${selfFolder}*`, ''];
  if (providers.length === 0) {
    lines.push('Stored: (none)');
  } else {
    lines.push(
      `Stored: ${providers
        .sort()
        .map((p) => `*${p}* (${listEntries(scope, p).length})`)
        .join(', ')}`,
    );
  }
  lines.push(source ? `Borrowing from: *${source}*` : 'Borrowing from: (none)');
  lines.push(
    grantees.length > 0 ? `Sharing with: ${grantees.map((g) => `*${g}*`).join(', ')}` : 'Sharing with: (none)',
  );
  ctx.replyText(lines.join('\n'));
}

// ── Public key export (C7g) ───────────────────────────────────────────────────

/**
 * `/creds gpg` — print the group's ASCII-armored GPG public key plus an
 * encrypt link. The operator needs this to encrypt a secret before
 * `set-key` / `import` (the cleartext never enters chat).
 */
function replyGpg(ctx: HostCommandContext, scope: CredentialScope): void {
  if (!isGpgAvailable()) {
    ctx.replyText('GPG is not available on the host. Install gnupg first.');
    return;
  }
  ensureGpgKey(scope);
  ctx.replyText(
    `*GPG public key for this group* — encrypt secrets to it before \`/creds set-key\` / \`/creds import\`.\n\n` +
      `One-click encrypt: ${buildPgpEncryptUrl(scope)}\n\n` +
      'Or import the armored key below into your own GPG:\n\n' +
      exportPublicKey(scope),
  );
}
