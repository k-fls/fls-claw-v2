/**
 * readEnvFile — value resolution, and the opt-in that preserves an
 * explicitly-empty value.
 *
 * By default an empty value is indistinguishable from an absent key, which is
 * right for a credential (an empty token is not a token). A feature switch
 * needs the opposite: `KEY=` is the operator saying "off", and collapsing it
 * into "unset" would silently hand back the default instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, afterEach, vi } from 'vitest';

import { readEnvFile } from './env.js';

/** Point process.cwd() at a throwaway dir holding the given .env contents. */
function withEnvFile(contents: string | null): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  if (contents !== null) fs.writeFileSync(path.join(dir, '.env'), contents);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readEnvFile', () => {
  it('reads requested keys, trims, and strips matched quotes', () => {
    withEnvFile('A=one\nB = "two" \nC=\'three\'\nIGNORED=nope\n');
    expect(readEnvFile(['A', 'B', 'C'])).toEqual({ A: 'one', B: 'two', C: 'three' });
  });

  it('skips comments and lines without an "="', () => {
    withEnvFile('# A=commented\nnot-a-pair\nA=real\n');
    expect(readEnvFile(['A'])).toEqual({ A: 'real' });
  });

  it('returns {} when there is no .env at all', () => {
    withEnvFile(null);
    expect(readEnvFile(['A'])).toEqual({});
  });

  it('drops an empty value by default', () => {
    withEnvFile('A=\nB=""\n');
    expect(readEnvFile(['A', 'B'])).toEqual({});
  });

  it('preserves an empty value under keepEmpty, so "set to nothing" stays distinguishable from unset', () => {
    withEnvFile('A=\nB=""\n');
    expect(readEnvFile(['A', 'B', 'MISSING'], { keepEmpty: true })).toEqual({ A: '', B: '' });
  });
});
