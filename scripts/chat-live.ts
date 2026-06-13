/**
 * ncl live — a persistent terminal chat with your NanoClaw agent.
 *
 * Unlike `chat.ts` (one-shot: send one message, print replies, exit), this
 * keeps the CLI-socket connection OPEN: it prints every message the host
 * delivers (including async pushes that arrive seconds later, e.g. an OAuth
 * URL from a spawned auth container) and sends each line you type. Stay in it
 * for multi-turn flows — menus, paste-back, browser-auth.
 *
 * Usage:  pnpm run chat:live      (then type messages; Ctrl-C or "/quit" to exit)
 *
 * Preconditions: host running, an agent wired to cli/local.
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

import { DATA_DIR } from '../src/config.js';

const socketPath = path.join(DATA_DIR, 'cli.sock');
const socket = net.connect(socketPath);

socket.on('error', (err) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
    console.error(`NanoClaw not reachable at ${socketPath}. Is the host running?`);
  } else {
    console.error('CLI socket error:', err);
  }
  process.exit(2);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

socket.on('connect', () => {
  console.error('[connected - type a message, Ctrl-C to quit]');
  rl.prompt();
});

let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.text === 'string') {
        // Newline-prefixed so an async push doesn't smear the input prompt.
        process.stdout.write(`\n<<< ${msg.text}\n`);
        rl.prompt();
      }
    } catch {
      /* ignore non-JSON */
    }
  }
});

rl.on('line', (input) => {
  const text = input.trim();
  if (text === '/quit' || text === '/exit') {
    socket.end();
    process.exit(0);
  }
  if (text.length > 0) socket.write(JSON.stringify({ text }) + '\n');
  rl.prompt();
});

rl.on('SIGINT', () => {
  socket.end();
  process.exit(0);
});

socket.on('close', () => {
  console.error('\n[connection closed]');
  process.exit(0);
});
