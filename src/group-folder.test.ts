import path from 'path';

import { describe, expect, it } from 'vitest';

import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  // `setup/auto.ts` provisions the CLI ping agent with this exact folder, so
  // rejecting it made every spawn of that group fail: the credential-availability
  // check throws before the container is ever built.
  it('accepts the leading-underscore folder setup itself creates', () => {
    expect(isValidGroupFolder('_ping-test')).toBe(true);
    expect(isValidGroupFolder('_')).toBe(true);
  });

  it('still rejects a leading dash or dot, which argv and traversal care about', () => {
    expect(isValidGroupFolder('-rf')).toBe(false);
    expect(isValidGroupFolder('.hidden')).toBe(false);
    expect(isValidGroupFolder('..')).toBe(false);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
  });
});
