/**
 * OAuth auth-bridge — the host side of the browser-auth (setup_token /
 * auth_login) flow's container↔user rendezvous.
 *
 * A dedicated short-lived **auth container** (spawned mitm-free, P3) runs the
 * `claude` CLI and drives its interactive stdio over host-rpc — the container
 * is always the caller, so no host→container stdin piping (v2 invariant). This
 * module owns the host end of that bridge:
 *
 *   POST /auth/url   { nonce, url, instructions? }
 *       → relay the OAuth URL to the user (open an interaction on the
 *         episode's origin) and start capturing their pasted code. 200 once
 *         the prompt is shown; the container moves on to poll for the code.
 *   POST /auth/code  { nonce }
 *       → long-poll: resolves with { code } when the user pastes, or
 *         { cancelled: true } on cancel / timeout / episode teardown. The
 *         auth-runner feeds that code to the CLI's local stdin.
 *
 * The `/auth/*` surface is **exclusive to the auth container**. IP→scope
 * (host-rpc's built-in authorization) is too coarse — an agent session
 * container shares the group's folder scope — so the provider seeds a
 * per-episode **nonce** when it spawns the auth container; the runner echoes
 * it on every call and the handler serves a request only when (a) an auth
 * episode is in-flight for the caller's scope AND (b) the nonce matches. A
 * normal agent container has neither, so it is rejected.
 *
 * Episodes are in-memory and keyed by the group folder (one at a time per
 * scope) — same rationale as the reauth dispatcher's in-flight set: a host
 * restart drops the episode and the next 401 simply re-prompts.
 *
 * The resulting credential is NOT returned through this bridge — it comes back
 * via a scope-private mount the host reads after the auth container exits (the
 * secret rides a host-owned file, not an rpc body). This module brokers only
 * the non-secret URL and the one-time auth code.
 */
import { registerHostRpc, type HostRpcRequest } from '../host-rpc/index.js';
import { pastePlainOn } from '../interactions/index.js';
import { BeginInteractionConflictError, type InteractionOrigin } from '../../host-interactions.js';
import { log } from '../../log.js';
import type { ContainerScope } from '../container-bootstrap/index.js';

/** Resolution of the user-pasted OAuth code, handed back to the auth container. */
export type AuthCodeResult = { code: string } | { cancelled: true };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface AuthEpisode {
  scopeFolder: string;
  nonce: string;
  origin: InteractionOrigin;
  /** Resolved by the code-capture interaction or by teardown. */
  code: Deferred<AuthCodeResult>;
  /** Guard so a re-POSTed /auth/url opens the user prompt only once. */
  urlPrompted: boolean;
}

/** Returned to the provider so it can tear the episode down when its auth container exits. */
export interface AuthEpisodeHandle {
  readonly nonce: string;
  readonly scopeFolder: string;
  /** Idempotent: removes the episode and unblocks any pending /auth/code poll. */
  end(): void;
}

const episodes = new Map<string, AuthEpisode>();

/**
 * Open an auth episode for a group scope. The provider passes the `nonce` it
 * also seeds into the auth container's env, and the `origin` to prompt the
 * user on. Replaces (and cancels) any existing episode for the same scope.
 */
export function startAuthEpisode(args: {
  scopeFolder: string;
  nonce: string;
  origin: InteractionOrigin;
}): AuthEpisodeHandle {
  const { scopeFolder, nonce, origin } = args;
  const existing = episodes.get(scopeFolder);
  if (existing) {
    log.warn('auth-bridge: replacing in-flight auth episode', { scopeFolder });
    existing.code.resolve({ cancelled: true });
  }
  const episode: AuthEpisode = { scopeFolder, nonce, origin, code: deferred<AuthCodeResult>(), urlPrompted: false };
  episodes.set(scopeFolder, episode);
  log.info('auth-bridge: episode started', { scopeFolder });
  return {
    nonce,
    scopeFolder,
    end: () => endEpisode(scopeFolder, episode),
  };
}

/** Remove `episode` for `scopeFolder` (only if still the current one) and unblock pollers. */
function endEpisode(scopeFolder: string, episode: AuthEpisode): void {
  if (episodes.get(scopeFolder) !== episode) return; // already replaced / ended
  episodes.delete(scopeFolder);
  episode.code.resolve({ cancelled: true }); // idempotent if already resolved
  log.info('auth-bridge: episode ended', { scopeFolder });
}

/**
 * Open the user-facing code-capture interaction for an episode. Idempotent
 * per episode (a duplicate /auth/url POST is a no-op). The pasted code never
 * enters `messages_in` — the router intercepts active-interaction inbounds
 * before any session-DB write.
 */
function promptForCode(episode: AuthEpisode, url: string, instructions: string | undefined): void {
  if (episode.urlPrompted) return;
  episode.urlPrompted = true;

  const prompt =
    'Claude sign-in — open this URL in your browser and authorize:\n\n' +
    `${url}\n\n` +
    (instructions ?? 'After authorizing, copy the resulting code (or callback URL) and paste it back here.') +
    '\n\nOr reply "cancel".';

  pastePlainOn(episode.origin, {
    prompt,
    validate: (text) => (text.trim().length > 0 ? null : 'That looked empty — paste the code, or reply "cancel".'),
  }).then(
    (r) => {
      episode.code.resolve(r.reason === 'submitted' && r.text ? { code: r.text.trim() } : { cancelled: true });
    },
    (err) => {
      // The only expected rejection is a slot conflict (another interaction
      // owns the address). Treat as a cancel so the auth container unblocks.
      if (!(err instanceof BeginInteractionConflictError)) {
        log.error('auth-bridge: code-capture interaction failed', { scopeFolder: episode.scopeFolder, err });
      } else {
        log.warn('auth-bridge: interaction slot busy, cancelling auth code capture', {
          scopeFolder: episode.scopeFolder,
        });
      }
      episode.code.resolve({ cancelled: true });
    },
  );
}

function nonceOf(body: unknown): string | null {
  if (body && typeof body === 'object' && typeof (body as { nonce?: unknown }).nonce === 'string') {
    return (body as { nonce: string }).nonce;
  }
  return null;
}

/**
 * Host-rpc handler for `/auth/*`. `scope` is the caller's resolved
 * `ContainerScope` (= group folder); the nonce in the body must match the
 * in-flight episode for that scope or the call is rejected. Method-agnostic:
 * routes on the sub-path so the nonce can ride a JSON body on any verb.
 */
async function handleAuthRpc(req: HostRpcRequest, scope: ContainerScope): Promise<unknown> {
  const folder = String(scope);
  const episode = episodes.get(folder);
  const nonce = nonceOf(req.body);
  if (!episode || !nonce || nonce !== episode.nonce) {
    log.warn('auth-bridge: rejected /auth call (no episode or nonce mismatch)', {
      folder,
      path: req.path,
      hasEpisode: episode != null,
    });
    throw new Error('no-active-auth-episode');
  }

  const sub = req.path.slice('/auth'.length) || '/';
  if (sub === '/url') {
    const body = req.body as { url?: unknown; instructions?: unknown };
    if (typeof body.url !== 'string' || body.url.length === 0) throw new Error('missing-url');
    promptForCode(episode, body.url, typeof body.instructions === 'string' ? body.instructions : undefined);
    return { relayed: true };
  }
  if (sub === '/code') {
    return await episode.code.promise; // long-poll until paste / cancel / teardown
  }
  throw new Error('unknown-auth-path');
}

registerHostRpc('/auth', handleAuthRpc);

/** Test hook — drops all episodes between cases. */
export function _resetAuthBridgeForTests(): void {
  for (const ep of episodes.values()) ep.code.resolve({ cancelled: true });
  episodes.clear();
}
