import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomic read-modify-write of a JSON file.
 * Holds the fd open between read and write to prevent partial reads.
 * No advisory lock (flock) — safe within a single Node process,
 * not across multiple.
 *
 * Creates parent dirs and the file (mode 0600) if missing. Missing or
 * empty files are treated as `{}`.
 */
export function updateJsonFile<T extends object>(filePath: string, update: (data: T) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let fd: number;
  let data = {} as T;

  try {
    fd = fs.openSync(filePath, 'r+');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
  }

  try {
    const content = fs.readFileSync(fd, 'utf-8');
    if (content.trim()) data = JSON.parse(content);
  } catch (err: any) {
    // EBADF = opened write-only (new file) — data stays {}
    if (err.code !== 'EBADF') {
      fs.closeSync(fd);
      throw err;
    }
  }

  try {
    update(data);

    const buf = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
}
