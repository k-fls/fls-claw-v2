/**
 * Default `SubstitutesSpec` factory.
 *
 * Boring providers compose `defaultSubstitutes({...})` to get the
 * canonical implementations of the four `SubstitutesSpec` methods.
 * Providers that need custom behavior write their own methods directly.
 *
 * Internals (`randomCharSameClass`, format-preserving generator,
 * binding-based env helpers) are PRIVATE to this module. The default
 * factory is the only public surface; everything else is implementation
 * detail. If a future provider needs to reuse a piece, lift it back out
 * deliberately rather than re-exporting helpers that would tempt direct
 * use.
 */
import { randomInt } from 'crypto';

import { logger } from './logger.js';
import type {
  Credential,
  CredentialFormatSpec,
  EnvVarBinding,
  HostRule,
  SubstituteConfig,
  SubstitutesSpec,
} from './types.js';
import { DEFAULT_ALNUM_SUBSTITUTE_CONFIG, DEFAULT_SUBSTITUTE_CONFIG, MIN_RANDOM_CHARS } from './types.js';

// ── Character-class helpers (private) ────────────────────────────────

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';
const ALNUM = LOWER + UPPER + DIGIT;
const ALNUM_ONLY_RE = /^[A-Za-z0-9]+$/;

function randomCharSameClass(ch: string, delimiters: string): string {
  if (delimiters.includes(ch)) return ch;
  if (LOWER.includes(ch)) return LOWER[randomInt(LOWER.length)];
  if (UPPER.includes(ch)) return UPPER[randomInt(UPPER.length)];
  if (DIGIT.includes(ch)) return DIGIT[randomInt(DIGIT.length)];
  return ALNUM[randomInt(ALNUM.length)];
}

/** Pick a shape-aware default substitute config for a given real token. */
function pickSubstituteConfigForToken(token: string): SubstituteConfig {
  return ALNUM_ONLY_RE.test(token) ? DEFAULT_ALNUM_SUBSTITUTE_CONFIG : DEFAULT_SUBSTITUTE_CONFIG;
}

/**
 * Generate one format-preserving substitute candidate. Returns `null`
 * when the token is too short or has too few randomizable chars for
 * the chosen config. Engine handles collision-retry; this function
 * produces one candidate per call.
 */
function generateFormatPreserving(
  realToken: string,
  baseConfig: SubstituteConfig,
  credentialPath: string,
  providerIdForLog: string,
): string | null {
  const config = baseConfig === DEFAULT_SUBSTITUTE_CONFIG ? pickSubstituteConfigForToken(realToken) : baseConfig;

  const { prefixLen, suffixLen, delimiters } = config;
  const minRandom = config.minRandomChars ?? MIN_RANDOM_CHARS;

  if (realToken.length <= prefixLen + suffixLen) {
    logger.warn(
      {
        providerId: providerIdForLog,
        credentialPath,
        tokenLen: realToken.length,
        prefixLen,
        suffixLen,
      },
      'Token too short for substitute config (prefix+suffix >= length); no substitute created',
    );
    return null;
  }

  const prefix = realToken.slice(0, prefixLen);
  const suffix = suffixLen > 0 ? realToken.slice(-suffixLen) : '';
  const middle = suffixLen > 0 ? realToken.slice(prefixLen, -suffixLen) : realToken.slice(prefixLen);

  let randomizable = 0;
  for (const ch of middle) {
    if (!delimiters.includes(ch)) randomizable++;
  }
  if (randomizable < minRandom) {
    logger.warn(
      {
        providerId: providerIdForLog,
        credentialPath,
        tokenLen: realToken.length,
        prefixLen,
        suffixLen,
        randomizable,
        minRandom,
      },
      'Token has too few randomizable chars for substitute config; no substitute created.',
    );
    return null;
  }

  const randomizedMiddle = Array.from(middle)
    .map((ch) => randomCharSameClass(ch, delimiters))
    .join('');
  return prefix + randomizedMiddle + suffix;
}

// ── Binding-based env helpers (private) ──────────────────────────────

function bindingsFor(bindings: readonly EnvVarBinding[], credentialPath: string): EnvVarBinding[] {
  return bindings.filter((b) => b.credentialPath === credentialPath);
}

function formatFor(
  formats: Record<string, CredentialFormatSpec> | undefined,
  credentialPath: string,
): CredentialFormatSpec {
  return formats?.[credentialPath] ?? {};
}

function materializeOne(binding: EnvVarBinding, substitute: string, format: CredentialFormatSpec): string | null {
  if (binding.slice === undefined) return substitute;
  const sep = format.sep;
  if (!sep) return null;
  const parts = substitute.split(sep);
  if (binding.slice >= parts.length) return null;
  return parts[binding.slice];
}

// ── Factory inputs ───────────────────────────────────────────────────

/**
 * Declarative inputs for `defaultSubstitutes`. None of these are part
 * of the `SubstitutesSpec` contract — they are factory inputs only.
 * A provider that doesn't use this factory never sees them.
 */
export interface DefaultSubstitutesInput {
  /**
   * Base config for format-preserving substitution. Defaults to
   * `DEFAULT_SUBSTITUTE_CONFIG`. The same config applies to every
   * credentialPath under this provider; differentiate paths by
   * supplying your own `generateSubstitute` instead.
   */
  substituteConfig?: SubstituteConfig;
  /** Env var declarations. */
  envBindings?: EnvVarBinding[];
  /** Per-credentialPath wire format (sep, encoding). */
  credentialFormat?: Record<string, CredentialFormatSpec>;
  /** Host rules to register with the proxy's anchor index. */
  hostRules?: HostRule[];
}

// ── Public factory ───────────────────────────────────────────────────

/**
 * Build a `SubstitutesSpec` from the declarative bag. The returned
 * object closes over the input — pass everything in one call.
 */
export function defaultSubstitutes(input: DefaultSubstitutesInput): SubstitutesSpec {
  const substituteConfig = input.substituteConfig ?? DEFAULT_SUBSTITUTE_CONFIG;
  const envBindings = input.envBindings ?? [];
  const credentialFormat = input.credentialFormat;
  const hostRules = input.hostRules ?? [];

  return {
    generateSubstitute(realValue, credentialPath) {
      return generateFormatPreserving(realValue, substituteConfig, credentialPath, 'default-factory');
    },

    envNamesFor(credentialPath) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const b of envBindings) {
        if (b.credentialPath !== credentialPath) continue;
        if (seen.has(b.envName)) continue;
        seen.add(b.envName);
        out.push(b.envName);
      }
      return out;
    },

    envValueFor(envName, substitute, _credential) {
      // Default impl ignores the resolved credential — the substitute is
      // the value, optionally sliced via the format's `sep`. Providers
      // whose env values are derived from the credential itself supply
      // their own envValueFor.
      const binding = envBindings.find((b) => b.envName === envName);
      if (!binding) return null;
      return materializeOne(binding, substitute, formatFor(credentialFormat, binding.credentialPath));
    },

    envBindings() {
      return envBindings;
    },

    credentialFormatFor(credentialPath) {
      return formatFor(credentialFormat, credentialPath);
    },

    hostRules() {
      return hostRules;
    },
  };
}
