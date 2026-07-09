/**
 * scripts/sweep/globs.ts — minimal gitignore-style glob matcher.
 *
 * Implemented in-repo instead of adding micromatch (not currently a
 * dependency; the registry only needs `**`, `*`, `?` and `{a,b}` semantics).
 *
 * Semantics:
 *   `**`    — any number of path segments (including none when followed by `/`)
 *   `*`     — any run of non-separator characters
 *   `?`     — one non-separator character
 *   `{a,b}` — alternation (no nesting)
 *   literal — exact path match; a literal DIRECTORY prefix also matches its
 *             contents when the pattern ends with `/`.
 */

function expandBraces(pattern: string): string[] {
  const m = pattern.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [pattern];
  const [, pre, body, post] = m;
  const out: string[] = [];
  for (const alt of body.split(',')) {
    for (const rest of expandBraces(pre + alt + post)) out.push(rest);
  }
  return out;
}

function segmentToRegex(pattern: string): string {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — collapse any following slash into the wildcard.
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return re;
}

const regexCache = new Map<string, RegExp>();

export function globToRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    const alts = expandBraces(pattern).map(segmentToRegex);
    re = new RegExp(`^(?:${alts.join('|')})$`);
    regexCache.set(pattern, re);
  }
  return re;
}

/** Match one path against one glob pattern. */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.endsWith('/')) pattern += '**';
  return globToRegex(pattern).test(path);
}

/** Match one path against any of the patterns. */
export function globMatchAny(patterns: string[], path: string): boolean {
  return patterns.some((p) => globMatch(p, path));
}

/** Paths (of the given list) matching the pattern. */
export function globFilter(pattern: string, paths: string[]): string[] {
  return paths.filter((p) => globMatch(pattern, p));
}
