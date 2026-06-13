import type { ServerResponse } from 'http';

import { describe, expect, it } from 'vitest';

import { writeInterceptStub } from './intercept-stub.js';

function fakeRes(): { res: ServerResponse; written: { status?: number; headers?: unknown; body: string } } {
  const written: { status?: number; headers?: unknown; body: string } = { body: '' };
  const res = {
    writeHead(status: number, headers?: unknown) {
      written.status = status;
      written.headers = headers;
      return this;
    },
    end(chunk?: string) {
      if (chunk) written.body += chunk;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, written };
}

describe('writeInterceptStub', () => {
  it('includes tracking URLs (encoded) when an interaction id is present', () => {
    const { res, written } = fakeRes();
    writeInterceptStub(res, 'https://auth.acme.com/authorize?x=1', 'acme:0:zz');
    expect(written.status).toBe(200);
    const body = JSON.parse(written.body) as Record<string, unknown>;
    expect(body.status).toBe('intercepted');
    expect(body.url).toBe('https://auth.acme.com/authorize?x=1');
    expect(body.interactionId).toBe('acme:0:zz');
    expect(body.statusUrl).toBe('/interaction/acme%3A0%3Azz/status');
    expect(body.eventsUrl).toBe('/interaction/acme%3A0%3Azz/events');
  });

  it('omits tracking URLs when there is no interaction id', () => {
    const { res, written } = fakeRes();
    writeInterceptStub(res, 'https://auth.acme.com/authorize', null);
    const body = JSON.parse(written.body) as Record<string, unknown>;
    expect(body.status).toBe('intercepted');
    expect(body.interactionId).toBeUndefined();
    expect(body.statusUrl).toBeUndefined();
    expect(body.eventsUrl).toBeUndefined();
  });
});
