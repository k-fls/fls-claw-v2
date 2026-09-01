import { describe, test, expect } from 'bun:test';

import { stripAnsi, extractOAuthUrl, CLAUDE_OAUTH_URL_RE, CODEX_OAUTH_URL_RE } from './parse.js';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  test('removes colour/CSI sequences but preserves normal text', () => {
    const colored = `${ESC}[31mHELLO ABC [brackets] back\\slash${ESC}[0m`;
    expect(stripAnsi(colored)).toBe('HELLO ABC [brackets] back\\slash');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('https://claude.ai/oauth?code_challenge=AbC-_9')).toBe(
      'https://claude.ai/oauth?code_challenge=AbC-_9',
    );
  });
});

describe('extractOAuthUrl', () => {
  test('pulls an Anthropic OAuth URL out of colourised TUI output', () => {
    const out = `${ESC}[2mOpen this URL:${ESC}[0m\n${ESC}[34mhttps://claude.ai/oauth/authorize?code=xyz&state=1${ESC}[0m\n`;
    expect(extractOAuthUrl(out, CLAUDE_OAUTH_URL_RE)).toBe('https://claude.ai/oauth/authorize?code=xyz&state=1');
  });

  test('trims trailing punctuation', () => {
    expect(extractOAuthUrl('go to (https://console.anthropic.com/oauth?x=1).', CLAUDE_OAUTH_URL_RE)).toBe(
      'https://console.anthropic.com/oauth?x=1',
    );
  });

  test('returns null when no auth URL is present', () => {
    expect(extractOAuthUrl('https://example.com/not-anthropic', CLAUDE_OAUTH_URL_RE)).toBeNull();
    expect(extractOAuthUrl('no url here', CLAUDE_OAUTH_URL_RE)).toBeNull();
  });
});

describe('extractOAuthUrl — per-CLI patterns', () => {
  // `codex login` prints the authorize URL and then a device-auth hint. The
  // Claude pattern matched neither, so the URL was scraped as "missing" and the
  // sign-in died before the user ever saw a link.
  const CODEX_OUT =
    'Starting local login server on http://localhost:1455.\n' +
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&state=abc\n' +
    'On a remote or headless machine? Use `codex login --device-auth` instead.';

  test('extracts the Codex authorize URL', () => {
    expect(extractOAuthUrl(CODEX_OUT, CODEX_OAUTH_URL_RE)).toBe(
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&state=abc',
    );
  });

  test('does not match the Codex URL with the Claude pattern, or the reverse', () => {
    expect(extractOAuthUrl(CODEX_OUT, CLAUDE_OAUTH_URL_RE)).toBeNull();
    expect(extractOAuthUrl('https://claude.ai/oauth/authorize?x=1', CODEX_OAUTH_URL_RE)).toBeNull();
  });

  test('ignores the local login-server URL the CLI also prints', () => {
    expect(extractOAuthUrl(CODEX_OUT, CODEX_OAUTH_URL_RE)).not.toContain('localhost');
  });
});
