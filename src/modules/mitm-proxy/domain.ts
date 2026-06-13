/**
 * Host/domain helpers for the credential bound-domain guard.
 *
 * Convention: hosts passed in are already lowercase (the proxy lowercases at
 * the boundary). These helpers do not re-lowercase.
 *
 * Deliberately PSL-free (no public-suffix list): the registrable domain is
 * approximated as the last two dot-labels. Exact for `acme.com`-style hosts;
 * the agreed trade-off (see `docs/fls/specs/per-group-oauth-providers.md`) is
 * that hosts sharing a two-label public suffix — `a.herokuapp.com` vs
 * `b.herokuapp.com` — count as the same domain. Container anchors are required
 * to be ≥2 labels so there are always two labels to take.
 */

/** Last two dot-labels of a host (registrable-domain approximation). */
export function registrableDomain(host: string): string {
  const end = host.endsWith('.') ? host.length - 1 : host.length; // FQDN trailing dot
  const lastDot = host.lastIndexOf('.', end - 1);
  if (lastDot < 1) return host.slice(0, end); // single label
  const prevDot = host.lastIndexOf('.', lastDot - 1);
  return host.slice(prevDot + 1, end); // prevDot === -1 → from start
}

/** True iff two hosts share the same registrable domain. */
export function sameRegistrableDomain(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

/** True iff a host has at least two labels (`x.y` or deeper). */
export function isMultiLabelHost(host: string): boolean {
  const i = host.indexOf('.');
  return i > 0 && i < host.length - 1;
}
