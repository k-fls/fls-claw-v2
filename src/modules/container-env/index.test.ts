/**
 * container-env curation: parse + validate `env-custom.jsonl`, enforcing name
 * format, the reserved-name deny set, and last-write-wins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { reserveEnvName } from '../container-bootstrap/index.js';

import { loadCustomEnv } from './index.js';

const FOLDER = 'container-env-test-group';
let groupDir: string;

function writeJsonl(lines: object[]): void {
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'env-custom.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

beforeEach(() => {
  groupDir = path.resolve(GROUPS_DIR, FOLDER);
});

afterEach(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
});

describe('loadCustomEnv', () => {
  it('returns {} when no file exists', () => {
    expect(loadCustomEnv(FOLDER)).toEqual({});
  });

  it('loads valid name/value pairs', () => {
    writeJsonl([
      { name: 'FOO', value: 'bar' },
      { name: 'BAZ_QUX', value: '123' },
    ]);
    expect(loadCustomEnv(FOLDER)).toEqual({ FOO: 'bar', BAZ_QUX: '123' });
  });

  it('last write wins for a duplicated name', () => {
    writeJsonl([
      { name: 'FOO', value: 'first' },
      { name: 'FOO', value: 'second' },
    ]);
    expect(loadCustomEnv(FOLDER)).toEqual({ FOO: 'second' });
  });

  it('skips invalid names, unparseable lines, and missing fields', () => {
    writeJsonl([
      { name: 'lowercase', value: 'x' }, // bad format
      { name: '3LEADING_DIGIT', value: 'x' }, // bad format
      { name: 'NO_VALUE' }, // missing value
      { value: 'no name' }, // missing name
      { name: 'GOOD', value: 'ok' },
    ]);
    // plus a raw non-JSON line
    fs.appendFileSync(path.join(groupDir, 'env-custom.jsonl'), 'not json\n');
    expect(loadCustomEnv(FOLDER)).toEqual({ GOOD: 'ok' });
  });

  it('skips host-reserved names', () => {
    reserveEnvName('CONTAINER_ENV_RESERVED_TEST', 'test');
    writeJsonl([
      { name: 'CONTAINER_ENV_RESERVED_TEST', value: 'x' },
      { name: 'ALLOWED', value: 'y' },
    ]);
    expect(loadCustomEnv(FOLDER)).toEqual({ ALLOWED: 'y' });
  });
});
