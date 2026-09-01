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
import { registerScopedHostRpc, type HostRpcRequest } from '../host-rpc/index.js';
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
  /** Set once the episode's auth container has an allocated IP. */
  containerIP?: string;
  /** Set alongside `containerIP`; the target for a callback delivery. */
  containerName?: string;
  /**
   * How the user's paste reaches the CLI. `paste` resolves the `/auth/code`
   * long-poll the runner is waiting on; `callback` is for a CLI that reads no
   * code from stdin and is instead listening on its own localhost port, so the
   * host delivers the browser's redirect into the container.
   */
  codeDelivery: 'paste' | 'callback';
  /** Names the service in the sign-in prompt. */
  label: string;
  /** Authorize URL the CLI emitted; carries the callback target for delivery. */
  authUrl?: string;
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
 * Auth-container IP → episode, so a request from a container that has no
 * session still resolves to the user who accepted that sign-in.
 *
 * Deliberately not keyed by scope. `startAuthEpisode` replaces the episode for
 * a scope, but the replaced episode's container can still be polling — a
 * scope-keyed lookup would hand that container's device code to whoever opened
 * the second episode.
 */
const episodesByContainerIP = new Map<string, AuthEpisode>();

/**
 * Bind a spawned auth container's IP to its episode, identified by the nonce
 * both were created with. No-op when the nonce matches no live episode.
 */
export function bindAuthEpisodeContainerIP(nonce: string, ip: string, containerName?: string): void {
  const episode = [...episodes.values()].find((e) => e.nonce === nonce);
  if (!episode) {
    log.warn('auth-bridge: no live episode for nonce — container IP not bound', { ip });
    return;
  }
  episode.containerIP = ip;
  episode.containerName = containerName;
  episodesByContainerIP.set(ip, episode);
}

/**
 * Delivers a browser callback the user pasted into the episode's auth
 * container. Injected because parsing and `docker exec` live in the mitm-proxy
 * module, which already imports this one. Returns false when the paste is not a
 * usable callback URL, so the prompt can ask again.
 */
export type AuthCallbackDeliverer = (containerName: string, pasted: string, authUrl: string) => Promise<boolean>;

let callbackDeliverer: AuthCallbackDeliverer | null = null;

/** Wire the callback deliverer. Called once at boot. */
export function setAuthCallbackDeliverer(fn: AuthCallbackDeliverer): void {
  callbackDeliverer = fn;
}

/**
 * The origin that accepted the sign-in whose auth container holds `ip`, or null.
 * Read-only: this resolves a recipient, it never authorizes anything. The
 * bridge's own nonce gate is unchanged.
 */
export function authEpisodeOriginByContainerIP(ip: string): InteractionOrigin | null {
  return episodesByContainerIP.get(ip)?.origin ?? null;
}

/**
 * Open an auth episode for a group scope. The provider passes the `nonce` it
 * also seeds into the auth container's env, and the `origin` to prompt the
 * user on. Replaces (and cancels) any existing episode for the same scope.
 */
export function startAuthEpisode(args: {
  scopeFolder: string;
  nonce: string;
  origin: InteractionOrigin;
  codeDelivery?: 'paste' | 'callback';
  label?: string;
}): AuthEpisodeHandle {
  const { scopeFolder, nonce, origin } = args;
  const existing = episodes.get(scopeFolder);
  if (existing) {
    log.warn('auth-bridge: replacing in-flight auth episode', { scopeFolder });
    if (existing.containerIP) episodesByContainerIP.delete(existing.containerIP);
    existing.code.resolve({ cancelled: true });
  }
  const episode: AuthEpisode = {
    scopeFolder,
    nonce,
    origin,
    code: deferred<AuthCodeResult>(),
    urlPrompted: false,
    codeDelivery: args.codeDelivery ?? 'paste',
    label: args.label ?? 'Claude',
  };
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
  if (episode.containerIP) episodesByContainerIP.delete(episode.containerIP);
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
  episode.authUrl = url;

  const wantsCallback = episode.codeDelivery === 'callback';
  const fallback = wantsCallback
    ? 'Your browser will then fail to load a `localhost` page — that is expected. ' +
      'Copy the full URL from the address bar and paste it back here.'
    : 'After authorizing, copy the resulting code (or callback URL) and paste it back here.';
  const prompt =
    `${episode.label} sign-in — open this URL in your browser and authorize:\n\n` +
    `${url}\n\n` +
    (instructions ?? fallback) +
    '\n\nOr reply "cancel".';

  pastePlainOn(episode.origin, {
    prompt,
    validate: (text) => (text.trim().length > 0 ? null : 'That looked empty — paste the code, or reply "cancel".'),
  }).then(
    (r) => {
      const submitted = r.reason === 'submitted' && r.text ? r.text.trim() : null;
      if (wantsCallback) {
        void completeCallback(episode, submitted);
        return;
      }
      episode.code.resolve(submitted ? { code: submitted } : { cancelled: true });
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

/**
 * Deliver a pasted browser callback into the episode's auth container. The CLI
 * is blocked on its own localhost listener, so this — not the `/auth/code`
 * long-poll — is what completes the flow. The episode is resolved either way,
 * which unblocks teardown; success is still decided by whether a credential
 * lands, never by this.
 */
async function completeCallback(episode: AuthEpisode, pasted: string | null): Promise<void> {
  if (!pasted) {
    episode.code.resolve({ cancelled: true });
    return;
  }
  if (!callbackDeliverer || !episode.containerName || !episode.authUrl) {
    log.error('auth-bridge: no callback deliverer or container for episode', { scopeFolder: episode.scopeFolder });
    episode.origin.writeReply('Could not complete the sign-in — the auth container is gone. Try again.');
    episode.code.resolve({ cancelled: true });
    return;
  }
  let delivered = false;
  try {
    delivered = await callbackDeliverer(episode.containerName, pasted, episode.authUrl);
    // eslint-disable-next-line no-catch-all/no-catch-all -- any failure is "not delivered"
  } catch (err) {
    log.error('auth-bridge: callback delivery threw', { scopeFolder: episode.scopeFolder, err });
  }
  if (!delivered) {
    episode.origin.writeReply(
      'That did not look like the callback URL. It looks like ' +
        '`http://localhost:1455/auth/callback?code=...&state=...`. Run the sign-in again to retry.',
    );
  }
  episode.code.resolve({ cancelled: true });
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

// Scope-only: the auth container reaches /auth/* with a resolved scope but no
// session (it allocates its IP via `allocateContainerIP(scope)`). A session-bound
// registration would 403 it as "unknown caller IP". See host-rpc #9.
registerScopedHostRpc('/auth', handleAuthRpc);

/** Test hook — drops all episodes between cases. */
export function _resetAuthBridgeForTests(): void {
  for (const ep of episodes.values()) ep.code.resolve({ cancelled: true });
  episodes.clear();
  episodesByContainerIP.clear();
}
