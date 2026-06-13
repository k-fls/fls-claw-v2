import { describe, expect, it } from 'vitest';

import { parseBody, replaceJsonStringValue } from './oauth-interceptor.js';

describe('parseBody', () => {
  it('parses a JSON body and preserves serialization byte-for-byte', () => {
    const raw = '{"grant_type":"refresh_token","refresh_token":"abc"}';
    const parsed = parseBody(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.grant_type).toBe('refresh_token');
    expect(parsed!.fields.refresh_token).toBe('abc');
    expect(parsed!.serialize()).toBe(raw);
  });

  it('replaces a JSON field in-place without disturbing order', () => {
    const raw = '{"grant_type":"refresh_token","refresh_token":"abc","client_id":"x"}';
    const parsed = parseBody(raw)!;
    parsed.set('refresh_token', 'REAL_REFRESH_VALUE');
    expect(parsed.serialize()).toBe(
      '{"grant_type":"refresh_token","refresh_token":"REAL_REFRESH_VALUE","client_id":"x"}',
    );
    expect(parsed.fields.refresh_token).toBe('REAL_REFRESH_VALUE');
  });

  it('parses a form-encoded body', () => {
    const raw = 'grant_type=refresh_token&refresh_token=abc';
    const parsed = parseBody(raw)!;
    expect(parsed.fields.grant_type).toBe('refresh_token');
    expect(parsed.fields.refresh_token).toBe('abc');
    expect(parsed.serialize()).toBe(raw);
  });

  it('replaces a form-encoded field', () => {
    const raw = 'grant_type=refresh_token&refresh_token=abc';
    const parsed = parseBody(raw)!;
    parsed.set('refresh_token', 'REAL');
    expect(parsed.serialize()).toBe('grant_type=refresh_token&refresh_token=REAL');
  });

  it('returns null for an unparseable body', () => {
    expect(parseBody('not json or form')).toBeNull();
    expect(parseBody('{invalid:json')).toBeNull();
  });
});

describe('replaceJsonStringValue', () => {
  it('escapes newlines and quotes in the replacement', () => {
    const out = replaceJsonStringValue('{"x":"old"}', 'x', 'has "quote" and\nnewline');
    expect(JSON.parse(out).x).toBe('has "quote" and\nnewline');
  });

  it('leaves the input unchanged if the key is not present', () => {
    const out = replaceJsonStringValue('{"a":"1"}', 'b', 'X');
    expect(out).toBe('{"a":"1"}');
  });
});
