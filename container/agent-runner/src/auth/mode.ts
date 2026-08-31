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

export type AuthMode = 'setup_token' | 'auth_login' | 'codex_device';

export interface AuthModeSpec {
  /** Command line run under the PTY. */
  command: string;
  /**
   * Whether the flow needs the runner to relay a URL out and feed a pasted
   * code back. False for a device flow: the CLI polls the provider itself and
   * the proxy relays the user code from the device-authorization response, so
   * the runner only has to wait for the CLI to exit.
   */
  relaysCode: boolean;
  /** How long to wait for the CLI to exit once the flow is under way. */
  exitWaitMs: number;
}

const CODE_RELAY_EXIT_WAIT_MS = 30_000;
/**
 * A device flow spends its whole life waiting for a human to open a link and
 * type a code. Must stay under the host's container lifetime backstop so the
 * host, not this timer, decides the episode is over.
 */
const DEVICE_EXIT_WAIT_MS = 10 * 60_000;

const SPECS: Record<AuthMode, AuthModeSpec> = {
  setup_token: { command: 'claude setup-token', relaysCode: true, exitWaitMs: CODE_RELAY_EXIT_WAIT_MS },
  auth_login: { command: 'claude auth login', relaysCode: true, exitWaitMs: CODE_RELAY_EXIT_WAIT_MS },
  codex_device: { command: 'codex login --device-auth', relaysCode: false, exitWaitMs: DEVICE_EXIT_WAIT_MS },
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
