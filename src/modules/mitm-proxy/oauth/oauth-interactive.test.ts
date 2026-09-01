import { describe, expect, it } from 'vitest';

import { callbackQueryFrom, parseCallbackUrl, redactCallbackShape, shadowWarning } from './oauth-interactive.js';

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

  // Slack escapes `&` in message text and does not linkify `localhost`, so the
  // callback arrives escaped but unwrapped. Read literally, `&amp;state=` is a
  // parameter named `amp;state` and `state` looks absent — which silently
  // rejected every Slack sign-in.
  it('decodes &amp; even when the URL is not wrapped', () => {
    expect(parseCallbackUrl('http://localhost:1455/auth/callback?code=a&amp;state=b')).toEqual({
      code: 'a',
      state: 'b',
      port: 1455,
    });
  });

  it("drops the label from Slack's <url|label> form rather than reading it as state", () => {
    expect(parseCallbackUrl('<http://localhost:1455/cb?code=a&amp;state=b|localhost:1455>')).toEqual({
      code: 'a',
      state: 'b',
      port: 1455,
    });
  });

  it('returns null when code, state, or port is missing', () => {
    expect(parseCallbackUrl('http://localhost:1234/cb?code=a')).toBeNull(); // no state
    expect(parseCallbackUrl('http://localhost/cb?code=a&state=b')).toBeNull(); // no port
    expect(parseCallbackUrl('not a url')).toBeNull();
  });
});

describe('callbackQueryFrom', () => {
  // The real Codex callback, which carries `scope` alongside code and state.
  const REAL =
    'http://localhost:1455/auth/callback?code=ac_16a_HcNheghQ.la6Teqpyj5DXTLSn6gqoak05g5SZ' +
    '&scope=openid+profile+email+offline_access' +
    '&state=gbs9SzWnAvIZjGUAM1T7eNXl7c6TRIB4ouXNraJ-iaY';
  const escaped = REAL.replace(/&/g, '&amp;');

  it.each([
    ['raw', REAL],
    ['escaped', escaped],
    ['wrapped', `<${escaped}>`],
    ['wrapped with a label', `<${escaped}|localhost:1455>`],
    // Slack renders the link without its scheme or port; the target comes from
    // the authorize URL, so the paste does not have to carry a host at all.
    ['no scheme or port', escaped.replace('http://localhost:1455', 'localhost')],
  ])('reads code and state from the %s form', (_name, input) => {
    const q = callbackQueryFrom(input);

    expect(q?.get('state')).toBe('gbs9SzWnAvIZjGUAM1T7eNXl7c6TRIB4ouXNraJ-iaY');
    expect(q?.get('code')).toBe('ac_16a_HcNheghQ.la6Teqpyj5DXTLSn6gqoak05g5SZ');
    // Forwarded too — the CLI put it in its own redirect_uri.
    expect(q?.get('scope')).toContain('openid');
  });

  it('returns null without both code and state', () => {
    expect(callbackQueryFrom('http://localhost:1455/cb?code=a')).toBeNull();
    expect(callbackQueryFrom('no url here')).toBeNull();
  });
});

describe('redactCallbackShape', () => {
  it('keeps the decoration that explains a refusal and drops the values', () => {
    const shape = redactCallbackShape(
      '<http://localhost:1455/auth/callback?code=AbCdEfGhIjKlMnOp&amp;state=XyZwVuTsRqPoNm|localhost:1455>',
    );

    expect(shape).toBe('<http://localhost:1455/auth/callback?code=…&amp;state=…|localhost:1455>');
    expect(shape).not.toContain('AbCdEfGhIjKlMnOp');
  });
});

describe('shadowWarning', () => {
  it('is empty when the group is not borrowing', () => {
    expect(shadowWarning('claude', undefined)).toBe('');
  });

  it('names the provider and grantor and flags shadowing when borrowing', () => {
    const w = shadowWarning('claude', 'slack_flsclaw-ai-native-marketing');
    expect(w).toContain('borrowing');
    expect(w).toContain('claude');
    expect(w).toContain('slack_flsclaw-ai-native-marketing');
    expect(w).toContain('shadow');
    expect(w.endsWith('\n\n')).toBe(true); // renders as a leading block before the prompt
  });
});
