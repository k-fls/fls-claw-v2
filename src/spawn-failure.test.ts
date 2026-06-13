import { afterEach, describe, expect, it } from 'vitest';

import {
  FatalSpawnError,
  _resetSpawnPoisonForTesting,
  clearSpawnPoison,
  isSpawnPoisoned,
  markSpawnPoisoned,
} from './spawn-failure.js';

afterEach(() => {
  _resetSpawnPoisonForTesting();
});

describe('FatalSpawnError', () => {
  it('is an Error instance with a stable name', () => {
    const err = new FatalSpawnError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FatalSpawnError);
    expect(err.name).toBe('FatalSpawnError');
    expect(err.message).toBe('boom');
  });

  it('preserves cause when provided', () => {
    const inner = new Error('inner');
    const err = new FatalSpawnError('outer', { cause: inner });
    expect(err.cause).toBe(inner);
  });
});

describe('spawn poison set', () => {
  it('is empty by default', () => {
    expect(isSpawnPoisoned('s1')).toBe(false);
  });

  it('marks and tests', () => {
    markSpawnPoisoned('s1');
    expect(isSpawnPoisoned('s1')).toBe(true);
    expect(isSpawnPoisoned('s2')).toBe(false);
  });

  it('clears returning whether it was set', () => {
    markSpawnPoisoned('s1');
    expect(clearSpawnPoison('s1')).toBe(true);
    expect(clearSpawnPoison('s1')).toBe(false);
    expect(isSpawnPoisoned('s1')).toBe(false);
  });
});
