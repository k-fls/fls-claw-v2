import { describe, expect, it } from 'vitest';

import { parseCallbackUrl, shadowWarning } from './oauth-interactive.js';

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
