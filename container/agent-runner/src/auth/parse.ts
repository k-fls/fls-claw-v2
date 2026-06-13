/**
 * Pure parsing helpers for the browser-auth runner — kept separate from the
 * imperative PTY/host-rpc orchestration so they're unit-testable without the
 * `claude` CLI. The CLI emits a TUI (Ink); we scrape only the OAuth URL out of
 * it. The credential itself is NOT captured here — it's captured host-side by
 * the MITM proxy intercepting the CLI's token-exchange (see auth-container.ts).
 */

/**
 * Strip ANSI/VT escape sequences (colour, cursor moves) from TUI output.
 * Every branch is anchored to the ESC byte () so normal text — URLs,
 * tokens, brackets — is never touched: CSI sequences (ESC [ params final) and
 * two-char escapes (ESC <single>).
 */
export function stripAnsi(s: string): string {
  // Built from the ESC code so the anchor is unambiguous: CSI sequences
  // (ESC [ params final-byte) + two-char escapes (ESC <single>). Anchoring to
  // ESC means normal text — URLs, tokens, brackets — is never touched.
  const esc = String.fromCharCode(27);
  const re = new RegExp(`${esc}\\[[0-9;?]*[ -/]*[@-~]|${esc}[@-Z\\\\-_]`, 'g');
  return s.replace(re, '');
}

/**
 * OAuth authorize-URL emitted by `claude setup-token` / `auth login` on one of
 * Anthropic's auth domains. Ported from v1 `OAUTH_URL_RE`; trailing
 * punctuation/whitespace is trimmed so a URL wrapped by surrounding prose
 * still parses (the wide PTY prevents mid-URL wrapping).
 */
const OAUTH_URL_RE =
  /https:\/\/(?:console\.anthropic\.com|claude\.ai|platform\.claude\.com|claude\.com\/cai\/oauth)\S+/;

export function extractOAuthUrl(output: string): string | null {
  const m = stripAnsi(output).match(OAUTH_URL_RE);
  if (!m) return null;
  // Drop trailing chars the TUI may append after the URL (quotes, parens, …).
  return m[0].replace(/["').,\]]+$/, '');
}
