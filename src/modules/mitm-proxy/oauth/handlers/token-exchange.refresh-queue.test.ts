/**
 * Refresh serialization for the container-originated token exchange.
 *
 * The credential store is per group while containers are per session, so a
 * group's concurrent sessions share one refresh substitute. Two simultaneous
 * refreshes both resolve it to the same real token, one wins the rotation, and
 * the other sends a spent token — which providers that rotate refresh tokens
 * treat as reuse and answer by invalidating the whole session family for the
 * group.
 *
 * Unlike the sibling suite, `proxyBuffered` here *drives* both transforms, so a
 * handler call spans the whole exchange and two of them can genuinely overlap.
 * A stateful engine models the rotation: `resolveSubstitute` reads whatever the
 * store currently holds, so a caller that resolved before its predecessor's
 * write would send the spent token, and the assertion sees it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialResolver } from '../../../credentials/index.js';
import { asCredentialScope, asGroupScope, type CredentialScope, type GroupScope } from '../../types.js';
import type { TokenSubstituteEngine } from '../../token-substitute.js';
import type { HandlerContext } from '../handler-context.js';
import type { InterceptRule, OAuthProvider } from '../types.js';

import { buildTokenExchangeHandler } from './token-exchange.js';

vi.mock('../../../credentials/auth-bridge.js', () => ({
  // Rotation is deliberately ungated; nothing here binds a new credential.
  isAuthEpisodeContainer: () => false,
}));

/**
 * Scripted `proxyBuffered`: run the request transform, wait for the test to
 * release the upstream leg, then run the response transform. `sentTokens`
 * records what each exchange would have put on the wire.
 */
const pb = vi.hoisted(() => ({
  sentTokens: [] as string[],
  /** Resolves the pending upstream leg of exchange `i`, in call order. */
  releases: [] as Array<() => void>,
  respond: null as null | ((call: number) => string),
}));

vi.mock('../../credential-proxy.js', () => ({
  proxyBuffered: async (
    _req: unknown,
    _res: unknown,
    _host: string,
    _port: number,
    _injectHeaders: (h: Record<string, unknown>) => void,
    transformRequest: (body: string) => string | Promise<string>,
    transformResponse: (body: string, status: number) => string,
  ) => {
    const sent = await transformRequest(JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'SUB_REFRESH' }));
    const call = pb.sentTokens.length;
    pb.sentTokens.push(JSON.parse(sent).refresh_token as string);
    await new Promise<void>((resolve) => pb.releases.push(resolve));
    transformResponse(pb.respond!(call), 200);
  },
}));

const SCOPE: GroupScope = asGroupScope('group-a');
const OTHER_SCOPE: GroupScope = asGroupScope('group-b');

function provider(): OAuthProvider {
  return {
    id: 'example',
    rules: [],
    scopeKeys: [],
    substituteConfig: { prefixLen: 4, suffixLen: 4, delimiters: '-._~' },
    refreshStrategy: 'redirect',
  } as OAuthProvider;
}

function rule(): InterceptRule {
  return { anchor: 'api.example.com', pathPattern: /^\/oauth\/token$/, mode: 'token-exchange' };
}

/**
 * One engine + resolver pair over a shared credential map. The refresh
 * substitute is stable across rotations (as in production), so what it resolves
 * to depends entirely on what has been stored by the time it is read.
 */
function makeWorld() {
  const refreshByScope = new Map<string, string>();
  const stored: Array<{ scope: string; value: string }> = [];

  const engine = {
    resolveSubstitute: (sub: string, scope: GroupScope) => {
      if (sub !== 'SUB_REFRESH') return null;
      const credentialScope = asCredentialScope(String(scope) as unknown as CredentialScope & string);
      return { realToken: refreshByScope.get(String(scope))!, mapping: { credentialScope } };
    },
    getOrCreateSubstitute: () => 'SUB_ACCESS',
    getSubstitute: () => null,
  } as unknown as TokenSubstituteEngine;

  const resolverFor = (_scope: GroupScope): CredentialResolver =>
    ({
      store: (target: CredentialScope, _pid: string, _cid: string, credential: { refresh?: { value: string } }) => {
        if (credential.refresh) refreshByScope.set(String(target), credential.refresh.value);
        stored.push({ scope: String(target), value: credential.refresh?.value ?? '' });
      },
      changeScope: (s: CredentialScope) => resolverFor(s as unknown as GroupScope),
    }) as unknown as CredentialResolver;

  const ctx: HandlerContext = {
    tokenEngine: engine,
    resolverFor,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    inFlightRefresh: new Map(),
  };
  return { ctx, refreshByScope, stored };
}

function run(ctx: HandlerContext, scope: GroupScope, sourceIP: string): Promise<void> {
  const handler = buildTokenExchangeHandler(provider(), rule(), ctx);
  return handler({} as never, {} as never, 'api.example.com', 443, scope, sourceIP);
}

/** Let queued microtasks settle so a blocked handler has had its chance to run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  pb.sentTokens = [];
  pb.releases = [];
  pb.respond = null;
  vi.clearAllMocks();
});

describe('container-originated refresh, serialized per (owning scope, provider)', () => {
  it('holds the second refresh until the first has rotated, then sends the rotated token', async () => {
    const { ctx, refreshByScope, stored } = makeWorld();
    refreshByScope.set('group-a', 'REFRESH_1');
    pb.respond = (call) =>
      JSON.stringify({ access_token: `ACCESS_${call + 2}`, refresh_token: `REFRESH_${call + 2}`, expires_in: 3600 });

    const first = run(ctx, SCOPE, '172.29.0.4');
    const second = run(ctx, SCOPE, '172.29.0.5');
    await settle();

    // Only the first exchange has reached the wire; the second is queued.
    expect(pb.sentTokens).toEqual(['REFRESH_1']);

    pb.releases[0]();
    await first;
    await settle();
    pb.releases[1]();
    await second;

    // The second sent the rotated token, never the one the first spent.
    expect(pb.sentTokens).toEqual(['REFRESH_1', 'REFRESH_2']);
    expect(stored.map((s) => s.value)).toEqual(['REFRESH_2', 'REFRESH_3']);
  });

  it('does not serialize refreshes belonging to two different groups', async () => {
    const { ctx, refreshByScope } = makeWorld();
    refreshByScope.set('group-a', 'A_REFRESH_1');
    refreshByScope.set('group-b', 'B_REFRESH_1');
    pb.respond = () => JSON.stringify({ access_token: 'ACCESS', refresh_token: 'ROTATED', expires_in: 3600 });

    const a = run(ctx, SCOPE, '172.29.0.4');
    const b = run(ctx, OTHER_SCOPE, '172.29.0.6');
    await settle();

    // Both are on the wire at once — one group cannot stall another.
    expect(pb.sentTokens.sort()).toEqual(['A_REFRESH_1', 'B_REFRESH_1']);

    pb.releases[0]();
    pb.releases[1]();
    await Promise.all([a, b]);
  });

  it('releases the queue when an exchange yields no credential, so the next attempt is not blocked', async () => {
    const { ctx, refreshByScope, stored } = makeWorld();
    refreshByScope.set('group-a', 'REFRESH_1');
    // First upstream leg answers with an error body — no access_token, so the
    // response transform stores nothing.
    pb.respond = (call) =>
      call === 0
        ? JSON.stringify({ error: 'invalid_grant' })
        : JSON.stringify({ access_token: 'ACCESS_2', refresh_token: 'REFRESH_2', expires_in: 3600 });

    const first = run(ctx, SCOPE, '172.29.0.4');
    await settle();
    pb.releases[0]();
    await first;

    expect(stored).toEqual([]);
    expect(ctx.inFlightRefresh.size).toBe(0);

    const second = run(ctx, SCOPE, '172.29.0.5');
    await settle();
    expect(pb.sentTokens).toEqual(['REFRESH_1', 'REFRESH_1']);
    pb.releases[1]();
    await second;
    expect(stored.map((s) => s.value)).toEqual(['REFRESH_2']);
  });

  it('serializes a third refresh behind the second, not behind the first', async () => {
    const { ctx, refreshByScope } = makeWorld();
    refreshByScope.set('group-a', 'REFRESH_1');
    pb.respond = (call) =>
      JSON.stringify({ access_token: `ACCESS_${call + 2}`, refresh_token: `REFRESH_${call + 2}`, expires_in: 3600 });

    const first = run(ctx, SCOPE, '172.29.0.4');
    const second = run(ctx, SCOPE, '172.29.0.5');
    const third = run(ctx, SCOPE, '172.29.0.7');
    await settle();
    expect(pb.sentTokens).toEqual(['REFRESH_1']);

    pb.releases[0]();
    await first;
    await settle();
    // The third must still be waiting — chaining on the first would have let it
    // race the second with the same spent token.
    expect(pb.sentTokens).toEqual(['REFRESH_1', 'REFRESH_2']);

    pb.releases[1]();
    await second;
    await settle();
    expect(pb.sentTokens).toEqual(['REFRESH_1', 'REFRESH_2', 'REFRESH_3']);

    pb.releases[2]();
    await third;
    expect(ctx.inFlightRefresh.size).toBe(0);
  });
});
