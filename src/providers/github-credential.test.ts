import { describe, expect, it } from 'vitest';

import { githubTransportCodec as codec } from './github-credential.js';

const basicCtx = {
  credentialName: 'oauth',
  scheme: 'Basic',
  headerName: 'authorization',
  targetHost: 'github.com',
};
const bearerCtx = {
  credentialName: 'oauth',
  scheme: 'Bearer',
  headerName: 'authorization',
  targetHost: 'api.github.com',
};

describe('githubTransportCodec', () => {
  it('git HTTPS Basic: extracts the password half, re-encodes with x-access-token', () => {
    // git's credential helper sends `base64("<user>:<pat>")`.
    const wire = 'Basic ' + Buffer.from('someuser:SUB-TOKEN', 'utf8').toString('base64');
    expect(codec.fromTransport(wire, basicCtx)).toBe('SUB-TOKEN');
    expect(codec.toTransport('REAL-TOKEN', basicCtx)).toBe(
      'Basic ' + Buffer.from('x-access-token:REAL-TOKEN', 'utf8').toString('base64'),
    );
  });

  it('API Bearer: passes the bare token through both directions', () => {
    expect(codec.fromTransport('Bearer SUB-TOKEN', bearerCtx)).toBe('SUB-TOKEN');
    expect(codec.toTransport('REAL-TOKEN', bearerCtx)).toBe('Bearer REAL-TOKEN');
  });

  it('Basic without a colon is not a git credential → null', () => {
    const wire = 'Basic ' + Buffer.from('justtoken', 'utf8').toString('base64');
    expect(codec.fromTransport(wire, basicCtx)).toBeNull();
  });

  it('round-trips on Basic: fromTransport(toTransport(real)) recovers the token', () => {
    const wire = codec.toTransport('REAL-TOKEN', basicCtx);
    expect(codec.fromTransport(wire, basicCtx)).toBe('REAL-TOKEN');
  });
});
