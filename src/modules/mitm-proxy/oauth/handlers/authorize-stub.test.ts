/**
 * Authorize-stub handler unit tests — the stub-write decision path (no
 * upstream needed: when `oauthEvents.beginAuthorizeStub` returns an id the
 * handler writes the intercept stub and never forwards).
 */
import type { IncomingMessage, ServerResponse } from 'http';

import { describe, expect, it, vi } from 'vitest';

import { asGroupScope } from '../../types.js';
import type { GroupScope } from '../../types.js';
import type { AuthCodeDeliver, HandlerContext, OAuthEvents } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildAuthorizeStubHandler } from './authorize-stub.js';

const SCOPE: GroupScope = asGroupScope('stub-test');
const noopDeliver: AuthCodeDeliver = async () => {};

function ctxWith(oauthEvents?: OAuthEvents, deliverCallback?: AuthCodeDeliver): HandlerContext {
  return {
    tokenEngine: {} as HandlerContext['tokenEngine'],
    resolverFor: () => ({}) as ReturnType<HandlerContext['resolverFor']>,
    fetchImpl: globalThis.fetch,
    inFlightRefresh: new Map(),
    oauthEvents,
    deliverCallback,
  };
}

const provider = { id: 'acme' } as OAuthProvider;
const rule: InterceptRule = {
  anchor: 'auth.acme.com',
  hostPattern: /^auth\.acme\.com$/,
  pathPattern: /^\/authorize/,
  mode: 'authorize-stub',
};

/** Minimal ServerResponse double capturing the written status + body. */
function fakeRes(): { res: ServerResponse; written: { status?: number; body: string } } {
  const written: { status?: number; body: string } = { body: '' };
  const res = {
    writeHead(status: number) {
      written.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) written.body += chunk;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, written };
}

describe('buildAuthorizeStubHandler', () => {
  it('writes the intercept stub when a user can be prompted, reconstructing the authorize URL and forwarding deliverCallback', async () => {
    const beginAuthorizeStub = vi.fn().mockReturnValue('acme:54321:abcd');
    const handler = buildAuthorizeStubHandler(
      provider,
      rule,
      ctxWith({ beginAuthorizeStub, notifyDeviceCode: () => {} }, noopDeliver),
    );

    const req = {
      url: '/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcb',
    } as IncomingMessage;
    const { res, written } = fakeRes();

    await handler(req, res, 'auth.acme.com', 443, SCOPE, '10.0.0.5');

    expect(beginAuthorizeStub).toHaveBeenCalledWith({
      sourceIP: '10.0.0.5',
      providerId: 'acme',
      authUrl: 'https://auth.acme.com/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcb',
      deliverCallback: noopDeliver,
    });
    expect(written.status).toBe(200);
    const body = JSON.parse(written.body) as Record<string, unknown>;
    expect(body.status).toBe('intercepted');
    expect(body.url).toContain('/authorize?');
    expect(body.interactionId).toBe('acme:54321:abcd');
    expect(body.statusUrl).toBe('/interaction/acme%3A54321%3Aabcd/status');
  });

  it('falls through to a plain forward when the surface is half-wired (needs both oauthEvents and deliverCallback)', async () => {
    // Either piece missing → proxyPipe is invoked, no stub written. We stub
    // proxyPipe so the test never touches the network.
    const proxyMod = await import('../../credential-proxy.js');
    const beginAuthorizeStub = vi.fn().mockReturnValue('should-not-be-called');
    const cases: HandlerContext[] = [
      ctxWith(undefined, undefined), // nothing wired
      ctxWith(undefined, noopDeliver), // deliver only
      ctxWith({ beginAuthorizeStub, notifyDeviceCode: () => {} }, undefined), // events only
    ];
    for (const ctx of cases) {
      const spy = vi.spyOn(proxyMod, 'proxyPipe').mockImplementation(() => {});
      const handler = buildAuthorizeStubHandler(provider, rule, ctx);
      const req = { url: '/authorize?client_id=x' } as IncomingMessage;
      const { res, written } = fakeRes();
      await handler(req, res, 'auth.acme.com', 443, SCOPE, '10.0.0.5');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(written.status).toBeUndefined();
      expect(written.body).toBe('');
      spy.mockRestore();
    }
    expect(beginAuthorizeStub).not.toHaveBeenCalled();
  });
});
