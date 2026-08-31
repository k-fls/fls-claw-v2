/**
 * Browser-auth runner — alternate container entrypoint.
 *
 * The host mounts this over /app/src/index.ts for a short-lived auth container,
 * so the normal entrypoint's `bun run /app/src/index.ts` runs it. It runs the
 * provider's auth CLI under a very wide PTY (so an Ink TUI never wraps the OAuth
 * URL). Two flow shapes, selected by the mode's spec:
 *
 * Code-relay (`claude setup-token` / `claude auth login`) — the container is the
 * caller, so there is no host→container stdin:
 *
 *   1. spawn the CLI under `script` (allocates the PTY; `stty columns 500`)
 *   2. scrape the OAuth URL from stdout → POST it to the host (/auth/url)
 *   3. long-poll the host (/auth/code) for the code the user pasted in chat
 *   4. write that code to the CLI's local stdin
 *   5. wait for the CLI to finish the token-exchange and exit
 *
 * Device (`codex login --device-auth`) — the CLI polls the provider itself and
 * the proxy relays the user code out of the device-authorization response, so
 * the runner only spawns and waits. No scrape, no long-poll, no write-back.
 *
 * It does NOT capture the credential: the auth container routes through the
 * MITM proxy, which intercepts the CLI's token-exchange and stores the real
 * token host-side. The runner only drives the UX; the host decides success by
 * checking whether a credential now exists for the scope.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { makeAuthRpcClient } from './auth/rpc-client.js';
import { extractOAuthUrl } from './auth/parse.js';
import { readAuthEnv, specFor, type AuthMode } from './auth/mode.js';

const URL_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

function fail(msg: string): never {
  console.error(`auth-runner: ${msg}`);
  process.exit(1);
}

function readEnv() {
  const parsed = readAuthEnv(process.env);
  if ('error' in parsed) fail(parsed.error);
  return parsed;
}

/** Drives the CLI subprocess: accumulates PTY output and waits on patterns. */
class CliSession {
  output = '';
  private exited = false;
  private exitWaiters: Array<() => void> = [];

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (d) => {
      this.output += d.toString();
    });
    proc.stderr.on('data', (d) => {
      this.output += d.toString();
    });
    proc.on('close', () => {
      this.exited = true;
      for (const w of this.exitWaiters) w();
      this.exitWaiters = [];
    });
  }

  /** Resolve with the match once `re` appears, or null on timeout / early exit. */
  waitFor(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray | null> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const m = this.output.match(re);
        if (m) return resolve(m);
        if (this.exited || Date.now() > deadline) return resolve(null);
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      tick();
    });
  }

  /** Feed input to the CLI. Ink reads keystrokes async, so send text then \r. */
  send(text: string): void {
    this.proc.stdin.write(text);
    setTimeout(() => this.proc.stdin.write('\r'), 200);
  }

  waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  kill(): void {
    if (!this.exited) this.proc.kill('SIGKILL');
  }
}

function spawnCli(mode: AuthMode): CliSession {
  const cliCommand = specFor(mode).command;
  // `script` allocates the PTY; the wide column count stops Ink from wrapping
  // (a wrapped URL is corrupted by the \r overwrites). Ported from v1.
  const proc = spawn('script', ['-qc', `stty columns 500 && ${cliCommand}`, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new CliSession(proc as ChildProcessWithoutNullStreams);
}

async function main(): Promise<void> {
  const { mode, nonce, port } = readEnv();
  const spec = specFor(mode);
  const cli = spawnCli(mode);

  if (!spec.relaysCode) {
    // The proxy relays the user code; nothing to scrape and nothing to feed
    // back. Just let the CLI finish its own polling.
    await cli.waitExit(spec.exitWaitMs);
    cli.kill();
    console.error(`auth-runner: ${mode} flow complete`);
    process.exit(0);
  }

  const client = makeAuthRpcClient({ baseUrl: `http://host.docker.internal:${port}`, nonce });

  const urlMatch = await cli.waitFor(/https?:\/\/\S+/, URL_WAIT_MS);
  const url = urlMatch ? extractOAuthUrl(cli.output) : null;
  if (!url) {
    cli.kill();
    fail('CLI exited or timed out before emitting an OAuth URL');
  }

  await client.postUrl(url);
  const code = await client.pollCode();
  if ('cancelled' in code) {
    cli.kill();
    fail('user cancelled or timed out');
  }

  cli.send(code.code);

  // Wait for the CLI to complete the token-exchange (intercepted + captured by
  // the host proxy) and exit. No local capture — the proxy owns it.
  await cli.waitExit(spec.exitWaitMs);
  cli.kill();
  console.error(`auth-runner: ${mode} flow complete`);
  process.exit(0);
}

void main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
