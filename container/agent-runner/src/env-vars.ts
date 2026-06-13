/**
 * Container env-var publishing.
 *
 * Appends `export NAME=value` lines to the file referenced by BASH_ENV
 * (default `~/.env-vars`), which the entrypoint set so every non-interactive
 * bash the agent spawns sources it. Lets a runtime action (e.g. get_credential
 * with `envVar`) make a value visible to subsequent Bash tool calls in the
 * session. This is independent of the credential proxy — it's a generic env
 * substrate; the proxy is just one producer of values.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function envVarsFilePath(): string {
  return process.env.BASH_ENV || path.join(process.env.HOME || os.homedir(), '.env-vars');
}

/**
 * Set up the BASH_ENV file at agent-runner startup — entirely agent-side, so
 * the entrypoint touches nothing:
 *   - point `BASH_ENV` at the file on this process's env, which the SDK passes
 *     through to the Bash tool's shells (`env: { ...process.env }`), so every
 *     non-interactive `bash -c` sources it;
 *   - create the file (empty) as the agent uid — no root/chown concern — so
 *     `bash` doesn't print "No such file or directory" before the first publish.
 * `get_credential`'s `--envVar` appends `export` lines here at runtime.
 */
export function ensureEnvVarsFile(): void {
  const file = envVarsFilePath();
  process.env.BASH_ENV = file;
  try {
    fs.closeSync(fs.openSync(file, 'a')); // create if missing, leave existing content
  } catch {
    /* best effort — publishEnvVar also creates it on first write */
  }
}

/**
 * Publish (or overwrite) an env var in the BASH_ENV file. Last write wins for a
 * given name. The value is single-quoted so shell metacharacters in a token are
 * inert. Also sets it on this process's env for any in-process consumer. Throws
 * on an invalid name.
 */
export function publishEnvVar(name: string, value: string): void {
  if (!ENV_NAME_RE.test(name)) throw new Error(`invalid env var name: ${name}`);

  const file = envVarsFilePath();
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    /* file may not exist yet — entrypoint touches it, but be defensive */
  }

  const prefix = `export ${name}=`;
  const escaped = `'${value.replace(/'/g, `'\\''`)}'`;
  const next = lines.filter((l) => l.length > 0 && !l.startsWith(prefix));
  next.push(`${prefix}${escaped}`);

  fs.writeFileSync(file, next.join('\n') + '\n');
  process.env[name] = value;
}
