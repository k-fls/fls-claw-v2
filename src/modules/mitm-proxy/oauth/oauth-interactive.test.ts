import { describe, expect, it } from 'vitest';

import { parseCallbackUrl } from './oauth-interactive.js';

describe('parseCallbackUrl', () => {
  it('extracts code, state, and port from a localhost callback URL', () => {
    expect(parseCallbackUrl('http://localhost:54321/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
      port: 54321,
    });
  });

  it('unwraps Slack-style <…> and &amp; encoding', () => {
    expect(parseCallbackUrl('<http://localhost:1234/cb?code=a&amp;state=b>')).toEqual({
      code: 'a',
      state: 'b',
      port: 1234,
    });
  });

  it('returns null when code, state, or port is missing', () => {
    expect(parseCallbackUrl('http://localhost:1234/cb?code=a')).toBeNull(); // no state
    expect(parseCallbackUrl('http://localhost/cb?code=a&state=b')).toBeNull(); // no port
    expect(parseCallbackUrl('not a url')).toBeNull();
  });
});
