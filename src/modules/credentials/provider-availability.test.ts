/**
 * Unit tests for borrow-aware provider availability. store + grants are mocked
 * so we assert only the combination logic (own ∪ borrowed-when-accessible).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  byScope: new Map<string, string[]>(), // scope → provider ids
  borrowSource: null as string | null,
  canAccess: true,
}));

vi.mock('./store.js', () => ({
  listProviderIds: (scope: string) => h.byScope.get(scope) ?? [],
}));
vi.mock('./grants.js', () => ({
  getBorrowSource: () => h.borrowSource,
  canAccess: () => h.canAccess,
}));
vi.mock('./types.js', () => ({ asCredentialScope: (s: string) => s }));

import { availableProviderIds } from './provider-availability.js';

beforeEach(() => {
  h.byScope = new Map();
  h.borrowSource = null;
  h.canAccess = true;
});

describe('availableProviderIds', () => {
  it('returns the own-scope providers when not borrowing', () => {
    h.byScope.set('me', ['claude', 'github']);
    expect([...availableProviderIds('me')].sort()).toEqual(['claude', 'github']);
  });

  it('includes a borrowed provider when the grantor has it and canAccess passes', () => {
    h.byScope.set('me', []); // own scope empty (own keys gone)
    h.byScope.set('grantor', ['claude']);
    h.borrowSource = 'grantor';
    h.canAccess = true;
    expect([...availableProviderIds('me')]).toEqual(['claude']);
  });

  it('unions own + borrowed providers', () => {
    h.byScope.set('me', ['github']);
    h.byScope.set('grantor', ['claude']);
    h.borrowSource = 'grantor';
    expect([...availableProviderIds('me')].sort()).toEqual(['claude', 'github']);
  });

  it('excludes the grantor providers when canAccess fails', () => {
    h.byScope.set('me', []);
    h.byScope.set('grantor', ['claude']);
    h.borrowSource = 'grantor';
    h.canAccess = false;
    expect([...availableProviderIds('me')]).toEqual([]);
  });

  it('ignores borrow state when there is no borrow source', () => {
    h.byScope.set('me', ['github']);
    h.byScope.set('grantor', ['claude']);
    h.borrowSource = null;
    expect([...availableProviderIds('me')]).toEqual(['github']);
  });
});
