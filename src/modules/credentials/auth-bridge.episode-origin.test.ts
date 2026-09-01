/**
 * Episode↔auth-container binding.
 *
 * An auth container is deliberately session-less, so the interactive OAuth
 * handlers cannot resolve its user the way they do for a session container.
 * These cover the binding that lets a device code reach the person who actually
 * accepted the sign-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { InteractionOrigin } from '../../host-interactions.js';

import {
  _resetAuthBridgeForTests,
  authEpisodeOriginByContainerIP,
  bindAuthEpisodeContainerIP,
  startAuthEpisode,
} from './auth-bridge.js';

function origin(label: string): InteractionOrigin {
  return {
    key: label as unknown as InteractionOrigin['key'],
    agentGroupId: `ag-${label}`,
    messagingGroupId: `mg-${label}`,
    replyAddr: { label } as unknown as InteractionOrigin['replyAddr'],
    writeReply: vi.fn(),
  };
}

afterEach(() => {
  _resetAuthBridgeForTests();
});

describe('auth episode container-IP binding', () => {
  it('resolves a session-less auth container to the origin that accepted the sign-in', () => {
    const accepted = origin('alice');
    startAuthEpisode({ scopeFolder: 'grp', nonce: 'n1', origin: accepted });

    bindAuthEpisodeContainerIP('n1', '10.0.0.5');

    expect(authEpisodeOriginByContainerIP('10.0.0.5')).toBe(accepted);
  });

  // The reason the binding is keyed on the container's IP and not its scope.
  // `startAuthEpisode` replaces the episode for a scope, but the replaced
  // episode's container can still be polling — a scope-keyed lookup would hand
  // its code to whoever opened the second episode.
  it('keeps two episodes on one scope apart, so neither user gets the other’s code', () => {
    const alice = origin('alice');
    startAuthEpisode({ scopeFolder: 'grp', nonce: 'n1', origin: alice });
    bindAuthEpisodeContainerIP('n1', '10.0.0.5');

    const bob = origin('bob');
    startAuthEpisode({ scopeFolder: 'grp', nonce: 'n2', origin: bob });
    bindAuthEpisodeContainerIP('n2', '10.0.0.6');

    expect(authEpisodeOriginByContainerIP('10.0.0.6')).toBe(bob);
    // Alice's episode was replaced, so her stale container resolves to nobody
    // rather than to Bob.
    expect(authEpisodeOriginByContainerIP('10.0.0.5')).toBeNull();
  });

  it('unbinds the IP when the episode ends', () => {
    const handle = startAuthEpisode({ scopeFolder: 'grp', nonce: 'n1', origin: origin('alice') });
    bindAuthEpisodeContainerIP('n1', '10.0.0.5');

    handle.end();

    expect(authEpisodeOriginByContainerIP('10.0.0.5')).toBeNull();
  });

  it('resolves nothing for an IP that belongs to no episode', () => {
    expect(authEpisodeOriginByContainerIP('10.0.0.9')).toBeNull();
  });

  it('binds nothing when the nonce matches no live episode', () => {
    bindAuthEpisodeContainerIP('no-such-nonce', '10.0.0.5');

    expect(authEpisodeOriginByContainerIP('10.0.0.5')).toBeNull();
  });

  it('is inert for an ordinary session container, which never binds an IP', () => {
    startAuthEpisode({ scopeFolder: 'grp', nonce: 'n1', origin: origin('alice') });

    // No bind call — a session container resolves through its session instead.
    expect(authEpisodeOriginByContainerIP('10.0.0.7')).toBeNull();
  });
});
