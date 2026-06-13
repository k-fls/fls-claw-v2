import { describe, it, expect } from 'vitest';
import { registrableDomain, sameRegistrableDomain, isMultiLabelHost } from './domain.js';

describe('registrableDomain', () => {
  it('takes the last two labels', () => {
    expect(registrableDomain('api.acme.com')).toBe('acme.com');
    expect(registrableDomain('auth.acme.com')).toBe('acme.com');
    expect(registrableDomain('a.b.c.acme.com')).toBe('acme.com');
    expect(registrableDomain('acme.com')).toBe('acme.com');
  });

  it('strips a single FQDN trailing dot', () => {
    expect(registrableDomain('api.acme.com.')).toBe('acme.com');
    expect(registrableDomain('acme.com.')).toBe('acme.com');
  });

  it('returns a single label unchanged', () => {
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('sameRegistrableDomain', () => {
  it('matches hosts sharing the last two labels (the capture/use split)', () => {
    expect(sameRegistrableDomain('auth.acme.com', 'api.acme.com')).toBe(true);
    expect(sameRegistrableDomain('acme.com', 'api.acme.com')).toBe(true);
  });

  it('rejects different registrable domains', () => {
    expect(sameRegistrableDomain('api.acme.com', 'evil.com')).toBe(false);
    expect(sameRegistrableDomain('api.acme.com', 'acme.evil.com')).toBe(false);
  });
});

describe('letter-case convention (helpers assume already-lowercase input)', () => {
  it('registrableDomain does not lowercase — normalization is the boundary’s job', () => {
    expect(registrableDomain('API.ACME.COM')).toBe('ACME.COM');
  });

  it('sameRegistrableDomain is case-sensitive (so callers must pre-lowercase)', () => {
    // Differing case in the registrable part → not equal: the system
    // lowercases hosts at every input boundary, so by the time the guard
    // compares, both are already lowercase.
    expect(sameRegistrableDomain('api.ACME.com', 'api.acme.com')).toBe(false);
    expect(sameRegistrableDomain('api.acme.com', 'api.acme.com')).toBe(true);
  });
});

describe('isMultiLabelHost', () => {
  it('accepts x.y or deeper', () => {
    expect(isMultiLabelHost('acme.com')).toBe(true);
    expect(isMultiLabelHost('api.acme.com')).toBe(true);
  });

  it('rejects a bare single label and degenerate dots', () => {
    expect(isMultiLabelHost('com')).toBe(false);
    expect(isMultiLabelHost('localhost')).toBe(false);
    expect(isMultiLabelHost('.com')).toBe(false); // leading dot
    expect(isMultiLabelHost('com.')).toBe(false); // trailing dot only
  });
});
