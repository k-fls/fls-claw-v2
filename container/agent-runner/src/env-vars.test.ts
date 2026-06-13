/**
 * publishEnvVar: append/overwrite export lines in the BASH_ENV file,
 * last-write-wins, with shell-safe quoting and name validation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureEnvVarsFile, publishEnvVar } from './env-vars.js';

let file: string;
let prevBashEnv: string | undefined;

beforeEach(() => {
  file = path.join(os.tmpdir(), `env-vars-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  prevBashEnv = process.env.BASH_ENV;
  process.env.BASH_ENV = file;
  fs.writeFileSync(file, '');
});

afterEach(() => {
  if (prevBashEnv === undefined) delete process.env.BASH_ENV;
  else process.env.BASH_ENV = prevBashEnv;
  fs.rmSync(file, { force: true });
});

describe('publishEnvVar', () => {
  it('writes an export line and sets process.env', () => {
    publishEnvVar('GH_TOKEN', 'ghp_subABC');
    expect(fs.readFileSync(file, 'utf8')).toContain("export GH_TOKEN='ghp_subABC'");
    expect(process.env.GH_TOKEN).toBe('ghp_subABC');
  });

  it('overwrites a prior value for the same name (last write wins)', () => {
    publishEnvVar('TOK', 'one');
    publishEnvVar('TOK', 'two');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain("export TOK='two'");
    expect(body).not.toContain("export TOK='one'");
    expect(body.match(/export TOK=/g)?.length).toBe(1);
  });

  it('keeps multiple distinct names', () => {
    publishEnvVar('A_TOK', '1');
    publishEnvVar('B_TOK', '2');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain("export A_TOK='1'");
    expect(body).toContain("export B_TOK='2'");
  });

  it('single-quote-escapes values containing quotes', () => {
    publishEnvVar('Q', "a'b");
    expect(fs.readFileSync(file, 'utf8')).toContain("export Q='a'\\''b'");
  });

  it('rejects invalid names', () => {
    expect(() => publishEnvVar('lower', 'x')).toThrow();
    expect(() => publishEnvVar('3LEAD', 'x')).toThrow();
  });
});

describe('ensureEnvVarsFile', () => {
  it('creates the BASH_ENV file and sets process.env.BASH_ENV', () => {
    const f = path.join(os.tmpdir(), `ensure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.BASH_ENV = f;
    expect(fs.existsSync(f)).toBe(false);
    ensureEnvVarsFile();
    expect(fs.existsSync(f)).toBe(true);
    expect(process.env.BASH_ENV).toBe(f);
    fs.rmSync(f, { force: true });
  });

  it('leaves existing content intact', () => {
    process.env.BASH_ENV = file;
    fs.writeFileSync(file, "export KEEP='1'\n");
    ensureEnvVarsFile();
    expect(fs.readFileSync(file, 'utf8')).toContain("export KEEP='1'");
  });
});
