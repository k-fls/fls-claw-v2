/**
 * `/oauth/browser-open` host-rpc endpoint unit tests.
 *
 * The proxy / oauth-module / interactive deps are mocked so we exercise the
 * handler's routing decisions in isolation; importing the module registers
 * the handler, which we then pull from the host-rpc registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./oauth/index.js', () => ({ matchAuthorizeUrl: vi.fn() }));
vi.mock('./oauth/oauth-interactive.js', () => ({
  oauthInteractive: { beginAuthorizeStub: vi.fn(), notifyDeviceCode: vi.fn() },
  dockerExecDeliver: vi.fn(),
}));
vi.mock('./credential-proxy.js', () => ({
  hasProxyInstance: vi.fn(() => true),
  getProxy: vi.fn(() => ({ resolveScope: vi.fn(() => 'grp') })),
}));

import { asContainerScope } from '../container-bootstrap/index.js';
import { matchHostRpc } from '../host-rpc/index.js';
import type { HostRpcRequest } from '../host-rpc/index.js';

import './browser-open-action.js';
import { matchAuthorizeUrl } from './oauth/index.js';
import { oauthInteractive } from './oauth/oauth-interactive.js';

const matchAuthorizeUrlMock = vi.mocked(matchAuthorizeUrl);
const beginAuthorizeStubMock = vi.mocked(oauthInteractive.beginAuthorizeStub);

function invoke(body: unknown, method = 'POST', callerIP = '10.0.0.7') {
  const entry = matchHostRpc('/oauth/browser-open');
  if (!entry) throw new Error('handler not registered');
  const req: HostRpcRequest = { method, path: '/oauth/browser-open', body, callerIP };
  return entry.invoke(req, asContainerScope('grp'), 'test-session');
}

beforeEach(() => {
  matchAuthorizeUrlMock.mockReset();
  beginAuthorizeStubMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('/oauth/browser-open handler', () => {
  it('queues a known authorize URL and returns exit_code 0 + interactionId', async () => {
    matchAuthorizeUrlMock.mockReturnValue('google');
    beginAuthorizeStubMock.mockReturnValue('google:9999:ab');

    const res = await invoke({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' });

    expect(res).toEqual({ exit_code: 0, interactionId: 'google:9999:ab' });
    expect(matchAuthorizeUrlMock).toHaveBeenCalledWith('accounts.google.com', '/o/oauth2/v2/auth');
    expect(beginAuthorizeStubMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIP: '10.0.0.7', providerId: 'google' }),
    );
  });

  it('passes through (empty) for a non-OAuth URL', async () => {
    matchAuthorizeUrlMock.mockReturnValue(null);
    const res = await invoke({ url: 'https://example.com/not-oauth' });
    expect(res).toEqual({});
    expect(beginAuthorizeStubMock).not.toHaveBeenCalled();
  });

  it('passes through when the flow cannot prompt anyone (null interactionId)', async () => {
    matchAuthorizeUrlMock.mockReturnValue('google');
    beginAuthorizeStubMock.mockReturnValue(null);
    const res = await invoke({ url: 'https://accounts.google.com/o/oauth2/v2/auth' });
    expect(res).toEqual({});
  });

  it('ignores non-POST, missing url, and unparseable url', async () => {
    expect(await invoke({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }, 'GET')).toEqual({});
    expect(await invoke({})).toEqual({});
    expect(await invoke({ url: 'not a url' })).toEqual({});
    expect(matchAuthorizeUrlMock).not.toHaveBeenCalled(); // GET/no-url bail before matching
    expect(beginAuthorizeStubMock).not.toHaveBeenCalled();
  });
});
