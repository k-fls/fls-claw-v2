/**
 * Adapter: `OAuthProvider` (discovery shape) → `SubstitutingProvider`
 * (the proxy / engine contract).
 *
 * Builds:
 *   - `substitutes` via `defaultSubstitutes(...)` — gets canonical
 *     generate / envNamesFor / envValueFor for free.
 *   - `hostRules()` from `provider.rules`, attaching the right
 *     `HostHandler` per mode and carrying through the explicit anchor
 *     for templated hosts.
 *   - The `CredentialProvider` lifecycle hooks (`buildManifest`,
 *     `onManifestWritten`, `onManifestDeleted`) — minimal stubs;
 *     manifest publishing is the credentials-UI surface and belongs
 *     elsewhere.
 */
import type { CredentialProvider } from '../../credentials/providers/registry.js';
import type { CredentialScope, SubstitutingProvider } from '../types.js';
import { defaultSubstitutes } from '../defaults.js';

import { buildHandlerForRule } from './handlers/index.js';
import type { HandlerContext } from './handler-context.js';
import type { OAuthProvider } from './types.js';

const lifecycleStub: Pick<CredentialProvider, 'buildManifest' | 'onManifestWritten' | 'onManifestDeleted'> = {
  // OAuth providers don't publish a manifest in this first cut. The
  // credentials-UI surface is out of scope; if/when it lands it can
  // grow a real implementation here. The empty-array contract is
  // deliberately benign — `ensureRegenOnce` writes an empty file and
  // moves on.
  buildManifest(_scope: CredentialScope): string[] {
    return [];
  },
  onManifestWritten(_scope: CredentialScope): void {
    /* noop */
  },
  onManifestDeleted(_scope: CredentialScope): void {
    /* noop */
  },
};

/**
 * Wrap an OAuthProvider as a SubstitutingProvider the proxy / engine
 * already know how to drive.
 */
export function toSubstitutingProvider(p: OAuthProvider, ctx: HandlerContext): SubstitutingProvider {
  const substitutes = defaultSubstitutes({
    substituteConfig: p.substituteConfig,
    envBindings: p.envBindings ?? [],
    credentialFormat: p.credentialFormat,
    hostRules: [], // filled in via the override below
  });

  // Build host rules with their handlers; skip rules whose handler is
  // deferred so the proxy never sees a half-wired entry.
  const rules = p.rules.flatMap((rule) => {
    const handler = buildHandlerForRule(p, rule, ctx);
    if (!handler) return [];
    // Synthesize a hostPattern when the discovery rule didn't supply one
    // (fixed-host case). Anchor is always set on InterceptRule.
    const hostPattern = rule.hostPattern ?? new RegExp(`^${rule.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    return [
      {
        anchor: rule.anchor,
        hostPattern,
        pathPattern: rule.pathPattern,
        handler,
      },
    ];
  });

  return {
    id: p.id,
    ...lifecycleStub,
    substitutes: {
      generateSubstitute: substitutes.generateSubstitute,
      envNamesFor: substitutes.envNamesFor,
      envValueFor: substitutes.envValueFor,
      envBindings: substitutes.envBindings,
      credentialFormatFor: substitutes.credentialFormatFor,
      hostRules: () => rules,
    },
  };
}
