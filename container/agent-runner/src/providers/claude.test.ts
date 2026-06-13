import { describe, it, expect } from 'bun:test';

import { ClaudeProvider, classifyClaudeError, classifyResultMessage } from './claude.js';

describe('classifyClaudeError', () => {
  it('classifies a structured 401 API error as auth-invalid', () => {
    const msg =
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"},"request_id":"req_abc"}';
    expect(classifyClaudeError(new Error(msg))).toBe('auth-invalid');
  });

  it('classifies a structured 403 API error as auth-invalid', () => {
    const msg =
      'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"forbidden"}}';
    expect(classifyClaudeError(msg)).toBe('auth-invalid');
  });

  it('matches even when the SDK/CLI wraps the message (unanchored)', () => {
    const msg =
      'Claude Code process exited with code 1: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"x"},"request_id":"req_1"}';
    expect(classifyClaudeError(new Error(msg))).toBe('auth-invalid');
  });

  it('classifies SDK synthetic auth phrases as auth-invalid', () => {
    expect(classifyClaudeError(new Error('Invalid API key · Fix external API key'))).toBe('auth-invalid');
    expect(classifyClaudeError('authentication_failed')).toBe('auth-invalid');
  });

  it('returns undefined for a non-auth API error (500)', () => {
    const msg = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"overloaded"}}';
    expect(classifyClaudeError(new Error(msg))).toBeUndefined();
  });

  it('classifies a 401 frame regardless of body shape', () => {
    // The body is deliberately NOT required to parse: live runs (2026-06-10,
    // claude-code 2.1.x) produced the same 401 in several textual shapes,
    // including plain-text remainders. The status code decides.
    expect(classifyClaudeError(new Error('API Error: 401 {not valid json}'))).toBe('auth-invalid');
  });

  it('classifies the live-observed auth texts (THROW path — err.message is SDK-authored, not model prose)', () => {
    // Byte-for-byte the failure texts observed live (2026-06-10). These only
    // matter for *thrown* errors now — result messages classify by their
    // structured fields (see classifyResultMessage), never by text.
    const shapes = [
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_011CbuT3TUV3QMQY6ERoNytq"}',
      'Failed to authenticate. API Error: 401 Invalid bearer token',
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    ];
    for (const s of shapes) expect(classifyClaudeError(s)).toBe('auth-invalid');
  });

  it('returns undefined for unrelated errors', () => {
    expect(classifyClaudeError(new Error('ECONNRESET socket hang up'))).toBeUndefined();
    expect(classifyClaudeError('boom')).toBeUndefined();
    expect(classifyClaudeError(undefined)).toBeUndefined();
  });
});

describe('classifyResultMessage (structured fields only — result text never decides)', () => {
  it('classifies the live-observed 401 shape (subtype=success, is_error=true, api_error_status=401)', () => {
    expect(classifyResultMessage({ is_error: true, api_error_status: 401 })).toBe('auth-invalid');
    expect(classifyResultMessage({ is_error: true, api_error_status: 403 })).toBe('auth-invalid');
  });

  it('does NOT classify when is_error is false — regardless of what the text said', () => {
    // The regression this whole design exists for: an agent ANSWER quoting
    // "API Error: 401 …" arrives with is_error=false and must pass through
    // untouched. Text is not even an input to this function.
    expect(classifyResultMessage({ is_error: false, api_error_status: 401 })).toBeUndefined();
    expect(classifyResultMessage({ is_error: false })).toBeUndefined();
    expect(classifyResultMessage({})).toBeUndefined();
  });

  it('does NOT classify non-auth or missing statuses', () => {
    expect(classifyResultMessage({ is_error: true, api_error_status: 500 })).toBeUndefined();
    expect(classifyResultMessage({ is_error: true, api_error_status: null })).toBeUndefined();
    expect(classifyResultMessage({ is_error: true })).toBeUndefined();
  });
});

describe('ClaudeProvider.classifyError', () => {
  it('delegates to classifyClaudeError', () => {
    const p = new ClaudeProvider();
    const msg =
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"x"}}';
    expect(p.classifyError(new Error(msg))).toBe('auth-invalid');
    expect(p.classifyError(new Error('nope'))).toBeUndefined();
  });

  it('classification is independent of isSessionInvalid (separate channels)', () => {
    const p = new ClaudeProvider();

    // A stale-session error is recoverable-by-clearing but NOT an auth tag.
    const stale = new Error('No conversation found with session ID: abc');
    expect(p.isSessionInvalid(stale)).toBe(true);
    expect(p.classifyError(stale)).toBeUndefined();

    // An auth error is classified but is NOT a stale session.
    const auth = new Error(
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"x"}}',
    );
    expect(p.isSessionInvalid(auth)).toBe(false);
    expect(p.classifyError(auth)).toBe('auth-invalid');
  });
});
