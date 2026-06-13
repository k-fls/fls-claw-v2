import { describe, test, expect } from 'bun:test';

import { stripAnsi, extractOAuthUrl } from './parse.js';

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
    expect(extractOAuthUrl(out)).toBe('https://claude.ai/oauth/authorize?code=xyz&state=1');
  });

  test('trims trailing punctuation', () => {
    expect(extractOAuthUrl('go to (https://console.anthropic.com/oauth?x=1).')).toBe(
      'https://console.anthropic.com/oauth?x=1',
    );
  });

  test('returns null when no auth URL is present', () => {
    expect(extractOAuthUrl('https://example.com/not-anthropic')).toBeNull();
    expect(extractOAuthUrl('no url here')).toBeNull();
  });
});
