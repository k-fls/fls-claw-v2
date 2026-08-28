/**
 * Host implementation of the interactive OAuth surface
 * (`OAuthEvents` from the mitm-proxy oauth module).
 *
 * The OAuth handlers run inside the proxy request path with only a source
 * IP in hand. This module turns that into a human conversation:
 *
 *   - `notifyDeviceCode` — one-shot chat message ("open <uri>, enter
 *     <code>"). The container polls the token endpoint itself, so nothing
 *     comes back through the host.
 *   - `beginAuthorizeStub` — open an interaction that shows the authorize
 *     URL, captures the user's reply (a localhost callback URL), and hands
 *     the code to the injected `deliverCallback` (which `docker exec`s it
 *     into the container's own callback listener). The library that opened
 *     the listener then completes the flow as if the browser had hit it.
 *
 * Both resolve the calling container from its source IP (container↔IP↔
 * session is 1:1 — the scope is derivable, so it isn't passed in) and reuse
 * `deriveOrigin` to find who/where to prompt — the same machinery the reauth
 * dispatcher uses. The delivery mechanism is injected (`deliverCallback`)
 * rather than hardwired; `dockerExecDeliver` below is the production default
 * the host wires at boot. Behavioural port of v1's `oauth-flow.ts` +
 * `providers/claude.ts` `callbackHandler`, on v2's host-interactions primitive.
 */
import { execFile } from 'child_process';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { getSession } from '../../../db/sessions.js';
import { getContainerName } from '../../../container-runner.js';
import { CONTAINER_RUNTIME_BIN } from '../../../container-runtime.js';
import {
  BeginInteractionConflictError,
  beginInteractionOn,
  deriveOrigin,
  type HostInteractionContext,
  type InteractionOrigin,
} from '../../../host-interactions.js';
import { log } from '../../../log.js';
import { lookupContainerSession } from '../../container-bootstrap/index.js';
import { openInboundDb } from '../../../session-manager.js';

import { authEpisodeOriginByContainerIP, endAuthEpisodeByContainerIP } from '../../credentials/auth-bridge.js';
import type { AuthCodeDeliver, OAuthEvents } from './handler-context.js';

/** Time budget for the `docker exec … curl` callback delivery. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Resolve the chat origin for the container at `sourceIP`. Opens the
 * session's inbound DB just long enough to scan for a sender, then closes
 * it. Returns the origin plus the resolved session/agent-group ids (the
 * caller needs the session id to look up the container name).
 */
function resolveContainerOrigin(sourceIP: string | undefined): { origin: InteractionOrigin; sessionId: string } | null {
  if (!sourceIP) return null;
  const sessionId = lookupContainerSession(sourceIP);
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session) return null;
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return null;

  let origin: InteractionOrigin | null = null;
  let inDb;
  try {
    inDb = openInboundDb(session.agent_group_id, session.id);
  } catch {
    return null;
  }
  try {
    origin = deriveOrigin(session, agentGroup, inDb);
  } finally {
    inDb.close();
  }
  return origin ? { origin, sessionId } : null;
}

/**
 * Origin for a device-code relay. A session container resolves through its
 * session as usual; an auth container has none by design, so it falls back to
 * the sign-in episode its IP is bound to.
 *
 * The fallback is keyed on the container's IP — the episode's own identity —
 * never on its scope. `startAuthEpisode` replaces the episode for a scope, so a
 * scope-keyed lookup would hand a still-polling container's code to whoever
 * opened the second episode.
 *
 * Device-code only. The authorize-stub path additionally needs a session id to
 * deliver the captured code back into the container, so it keeps the
 * session-only resolution.
 */
function resolveDeviceCodeOrigin(
  sourceIP: string | undefined,
): { origin: InteractionOrigin; recipient: string; via: 'session' | 'episode' } | null {
  const session = resolveContainerOrigin(sourceIP);
  if (session) return { origin: session.origin, recipient: session.sessionId, via: 'session' };
  if (!sourceIP) return null;
  const episodeOrigin = authEpisodeOriginByContainerIP(sourceIP);
  return episodeOrigin ? { origin: episodeOrigin, recipient: sourceIP, via: 'episode' } : null;
}

/**
 * Parse a localhost callback URL into code + state + port. Accepts the
 * raw URL the user copies from their browser address bar; tolerant of the
 * Slack `<…>` / `&amp;` wrapping as a precaution. Port from v1.
 */
export function parseCallbackUrl(input: string): { code: string; state: string; port: number } | null {
  let trimmed = input.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    trimmed = trimmed.slice(1, -1).replace(/&amp;/g, '&');
  }
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const port = url.port ? parseInt(url.port, 10) : null;
    if (code && state && port) return { code, state, port };
  } catch {
    /* not a valid URL */
  }
  return null;
}

/**
 * Production `AuthCodeDeliver`: `docker exec <name> curl -sf <url>` to hit
 * the container's own localhost callback. Exported so the host can wire it
 * into the OAuth module at boot (and tests can substitute a fake).
 */
export const dockerExecDeliver: AuthCodeDeliver = (containerName, callbackUrl) =>
  new Promise((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      ['exec', containerName, 'curl', '-sf', callbackUrl],
      { timeout: DELIVERY_TIMEOUT_MS },
      (err) => (err ? reject(err) : resolve()),
    );
  });

/** Parse the authorize URL's `redirect_uri` to find the localhost callback target. */
function localhostCallbackFromAuthUrl(authUrl: string): { port: number; path: string } | null {
  try {
    const redirectUri = new URL(authUrl).searchParams.get('redirect_uri');
    if (!redirectUri) return null;
    const r = new URL(redirectUri);
    const isLocal =
      r.hostname === 'localhost' || r.hostname === '127.0.0.1' || r.hostname === '[::1]' || r.hostname === '::1';
    if (!isLocal || !r.port) return null;
    return { port: parseInt(r.port, 10), path: r.pathname || '/callback' };
  } catch {
    return null;
  }
}

function interactionIdFor(providerId: string, authUrl: string, port: number): string {
  try {
    const state = new URL(authUrl).searchParams.get('state') || authUrl;
    // Cheap, dependency-free state digest — just a stable short tag.
    let h = 0;
    for (let i = 0; i < state.length; i++) h = (h * 31 + state.charCodeAt(i)) | 0;
    return `${providerId}:${port}:${(h >>> 0).toString(36)}`;
  } catch {
    return `${providerId}:${port}:0`;
  }
}

/**
 * A leading warning shown when the calling group is currently *borrowing* this
 * credential from another scope: authenticating here mints the group's own
 * credential, which shadows the borrowed one. Empty when not borrowing.
 */
export function shadowWarning(providerId: string, borrowedFrom?: string): string {
  if (!borrowedFrom) return '';
  return (
    `⚠️ This group is *borrowing* the \`${providerId}\` credential from \`${borrowedFrom}\`. ` +
    `Authenticating here creates this group's own credential and will *shadow* the borrowed one — ` +
    `this group will stop using \`${borrowedFrom}\`'s.\n\n`
  );
}

export const oauthInteractive: OAuthEvents = {
  notifyDeviceCode({ sourceIP, providerId, userCode, verificationUri, borrowedFrom }) {
    const resolved = resolveDeviceCodeOrigin(sourceIP);
    if (!resolved) {
      // Warning, not info: this is "the code never reached anyone", which is
      // indistinguishable from "the user ignored it" unless it is logged loudly.
      log.warn('oauth.device-code: no identifiable user to notify — code not relayed', { sourceIP, providerId });
      if (sourceIP) endAuthEpisodeByContainerIP(sourceIP);
      return;
    }
    try {
      resolved.origin.writeReply(
        shadowWarning(providerId, borrowedFrom) +
          `🔐 *${providerId}* wants to authorize.\n\n` +
          `Open ${verificationUri} and enter this code:\n\n\`${userCode}\`\n\n` +
          'Once you approve in the browser, the agent will pick up the credential automatically.',
      );
      log.info('oauth.device-code: relayed', { providerId, recipient: resolved.recipient, via: resolved.via });
      // eslint-disable-next-line no-catch-all/no-catch-all -- delivery failure must end the episode, whatever its cause
    } catch (err) {
      // Best-effort delivery that silently drops would leave the user waiting
      // out the auth container's lifetime cap with no explanation.
      log.warn('oauth.device-code: could not deliver the code — ending the episode', { providerId, sourceIP, err });
      if (sourceIP) endAuthEpisodeByContainerIP(sourceIP);
    }
  },

  beginAuthorizeStub({ sourceIP, providerId, authUrl, deliverCallback, borrowedFrom }) {
    const resolved = resolveContainerOrigin(sourceIP);
    if (!resolved) {
      log.info('oauth.authorize-stub: no identifiable user to prompt — passing through', {
        sourceIP,
        providerId,
      });
      return null;
    }
    const { origin, sessionId } = resolved;

    const callback = localhostCallbackFromAuthUrl(authUrl);
    if (!callback) {
      // Non-localhost (or unparseable) redirect: the provider will redirect
      // the user's browser straight to the app's real endpoint, so there's
      // no code for the host to relay. Show the URL and close.
      const id = interactionIdFor(providerId, authUrl, 0);
      try {
        beginInteractionOn(origin, {
          initialPrompt:
            shadowWarning(providerId, borrowedFrom) +
            `🔐 *${providerId}* wants to authorize.\n\n` +
            `Open this URL and complete the sign-in:\n${authUrl}\n\n` +
            'No code needs to come back here — your browser is redirected automatically. ' +
            'Reply with anything (or "cancel") to dismiss this.',
          handler: (ctx: HostInteractionContext) => ctx.finish(),
        });
      } catch (err) {
        if (err instanceof BeginInteractionConflictError) return null;
        throw err;
      }
      return id;
    }

    const { port, path: cbPath } = callback;
    const id = interactionIdFor(providerId, authUrl, port);

    const handler = async (ctx: HostInteractionContext): Promise<void> => {
      const reply = ctx.inboundContent.trim();
      if (/^cancel$/i.test(reply)) {
        ctx.cancel('Authorization cancelled.');
        return;
      }
      const parsed = parseCallbackUrl(reply);
      if (!parsed) {
        ctx.ask(
          'Could not parse that. Paste the *full* URL from your browser address bar — ' +
            `it looks like \`http://localhost:${port}${cbPath}?code=...&state=...\` (or reply "cancel").`,
        );
        return;
      }
      if (parsed.port !== port) {
        ctx.ask(
          `That URL has port ${parsed.port} but this flow expects ${port}. ` +
            'Make sure you copied the right URL (or reply "cancel").',
        );
        return;
      }
      const containerName = getContainerName(sessionId);
      if (!containerName) {
        ctx.cancel('The agent container is no longer running — start a new authorization.');
        return;
      }
      const callbackUrl =
        `http://localhost:${port}${cbPath}` +
        `?code=${encodeURIComponent(parsed.code)}&state=${encodeURIComponent(parsed.state)}`;
      try {
        await deliverCallback(containerName, callbackUrl);
        ctx.finish('✅ Authorization delivered to the agent.');
      } catch (err) {
        log.warn('oauth.authorize-stub: callback delivery failed', { providerId, sessionId, err });
        ctx.finish(
          'Delivered, but the agent may not have accepted it. If the tool still reports an ' +
            'auth error, retry the authorization.',
        );
      }
    };

    try {
      beginInteractionOn(origin, {
        initialPrompt:
          shadowWarning(providerId, borrowedFrom) +
          `🔐 *${providerId}* wants to authorize.\n\n` +
          `1. Open this URL and approve:\n${authUrl}\n\n` +
          '2. Your browser will then redirect to a *localhost* URL and show a ' +
          '"connection refused" / "can\'t reach this page" error — that is expected, ' +
          'do not close the tab.\n\n' +
          `3. Copy the full URL from the address bar (\`http://localhost:${port}${cbPath}?code=...\`) ` +
          'and paste it here (or reply "cancel").',
        handler,
      });
    } catch (err) {
      if (err instanceof BeginInteractionConflictError) return null;
      throw err;
    }
    return id;
  },
};
