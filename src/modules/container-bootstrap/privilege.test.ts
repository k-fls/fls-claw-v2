import { describe, expect, it } from 'vitest';

import { resolveLaunchMode } from './privilege.js';

describe('resolveLaunchMode', () => {
  it('rootless with --user UID:GID for a normal host uid', () => {
    expect(resolveLaunchMode(false, { uid: 1234, gid: 1234 })).toEqual({
      kind: 'rootless',
      userArg: '1234:1234',
    });
  });

  it('rootless without --user when host runs as root (UID 0)', () => {
    expect(resolveLaunchMode(false, { uid: 0, gid: 0 })).toEqual({ kind: 'rootless', userArg: null });
  });

  it('rootless without --user when host UID is the image default 1000', () => {
    expect(resolveLaunchMode(false, { uid: 1000, gid: 1000 })).toEqual({ kind: 'rootless', userArg: null });
  });

  it('rootless without --user on platforms with no uid/gid', () => {
    expect(resolveLaunchMode(false, { uid: null, gid: null })).toEqual({ kind: 'rootless', userArg: null });
  });

  it('root-drop with HOST_UID/HOST_GID env when needsRoot=true', () => {
    expect(resolveLaunchMode(true, { uid: 1234, gid: 1234 })).toEqual({
      kind: 'root-drop',
      envVars: { HOST_UID: '1234', HOST_GID: '1234' },
    });
  });

  it('falls back to rootless when needsRoot=true but host has no uid/gid', () => {
    expect(resolveLaunchMode(true, { uid: null, gid: null })).toEqual({ kind: 'rootless', userArg: null });
  });
});
