/**
 * Auth-container modes: the union, the env read, and the command each mode
 * runs.
 *
 * Extracted from `auth-runner.ts` because that module exports nothing and exits
 * the process on import, so none of this is reachable from a test while it
 * lives there. The container snapshot copies the whole tree, so a new file here
 * needs no registration.
 *
 * The union is duplicated host-side in `src/auth-container.ts` (it crosses the
 * boundary as `NANOCLAW_AUTH_MODE`), so the two move together.
 */

export type AuthMode = 'setup_token' | 'auth_login' | 'codex_device' | 'codex_login';

import { CLAUDE_OAUTH_URL_RE, CODEX_OAUTH_URL_RE } from './parse.js';

export interface AuthModeSpec {
  /** Command line run under the PTY. */
  command: string;
  /**
   * Which authorize URL to scrape, and — by its presence — whether the runner
   * relays one at all. A device flow omits it: the proxy relays the user code
   * out of the device-authorization response instead.
   *
   * The pattern is per-CLI because each prints other links alongside the
   * authorize URL (`codex login` also prints a device-auth hint), so matching
   * the first URL would relay a page the user cannot authorize on. Carrying the
   * flag on the pattern rather than beside it keeps a mode from claiming to
   * relay a URL while naming no shape to look for.
   */
  authUrlPattern?: RegExp;
  /**
   * How the authorization gets back to the CLI.
   *
   *  - `stdin`    — the runner long-polls the host for a code and types it in.
   *  - `callback` — the CLI is waiting on its own localhost HTTP listener, so
   *                 the HOST delivers the callback into this container and the
   *                 runner only waits for the CLI to exit.
   *  - `none`     — the CLI polls the provider itself.
   */
  codeReturn: 'stdin' | 'callback' | 'none';
  /** How long to wait for the CLI to exit once the flow is under way. */
  exitWaitMs: number;
}

const CODE_RELAY_EXIT_WAIT_MS = 30_000;
/**
 * A browser or device flow spends its whole life waiting for a human to open a
 * link. Must stay under the host's container lifetime backstop so the host, not
 * this timer, decides the episode is over.
 */
const DEVICE_EXIT_WAIT_MS = 10 * 60_000;

const SPECS: Record<AuthMode, AuthModeSpec> = {
  setup_token: {
    command: 'claude setup-token',
    authUrlPattern: CLAUDE_OAUTH_URL_RE,
    codeReturn: 'stdin',
    exitWaitMs: CODE_RELAY_EXIT_WAIT_MS,
  },
  auth_login: {
    command: 'claude auth login',
    authUrlPattern: CLAUDE_OAUTH_URL_RE,
    codeReturn: 'stdin',
    exitWaitMs: CODE_RELAY_EXIT_WAIT_MS,
  },
  codex_device: {
    command: 'codex login --device-auth',
    codeReturn: 'none',
    exitWaitMs: DEVICE_EXIT_WAIT_MS,
  },
  // `codex login` prints its authorize URL and waits on http://localhost:1455.
  // It reads no code from stdin, so the host delivers the browser's callback
  // into this container instead. Unlike the device flow it needs no
  // workspace-level device-code authorization.
  codex_login: {
    command: 'codex login',
    authUrlPattern: CODEX_OAUTH_URL_RE,
    codeReturn: 'callback',
    exitWaitMs: DEVICE_EXIT_WAIT_MS,
  },
};

export function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SPECS, value);
}

/** Throws on an unrecognized mode rather than falling back to a CLI command. */
export function specFor(mode: AuthMode): AuthModeSpec {
  const spec = SPECS[mode];
  if (!spec) throw new Error(`unknown auth mode: ${String(mode)}`);
  return spec;
}

export interface AuthEnv {
  mode: AuthMode;
  nonce: string;
  port: string;
}

/**
 * Validate the three env vars the host sets. Returns the reason rather than
 * exiting, so the caller owns process exit and this stays testable.
 */
export function readAuthEnv(env: Record<string, string | undefined>): AuthEnv | { error: string } {
  const mode = env.NANOCLAW_AUTH_MODE;
  if (!isAuthMode(mode)) return { error: `bad NANOCLAW_AUTH_MODE: ${String(mode)}` };
  const nonce = env.NANOCLAW_AUTH_NONCE;
  if (!nonce) return { error: 'NANOCLAW_AUTH_NONCE not set' };
  const port = env.NANOCLAW_HOST_RPC_PORT;
  if (!port) return { error: 'NANOCLAW_HOST_RPC_PORT not set' };
  return { mode, nonce, port };
}
