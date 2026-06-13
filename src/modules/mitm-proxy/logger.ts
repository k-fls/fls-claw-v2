/**
 * Pino-style logger shim for the mitm-proxy module.
 *
 * The v1 source uses `logger.<level>(data, msg)` (pino API). v2's
 * canonical logger at `src/log.ts` uses `log.<level>(msg, data)`. This
 * shim adapts the v1 sites without rewriting every call.
 */
import { log } from '../../log.js';

type Data = Record<string, unknown> | undefined;

function adapt(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal') {
  return (a?: unknown, b?: string): void => {
    if (typeof a === 'string') {
      log[level](a, b as unknown as Data);
      return;
    }
    log[level]((b ?? '') as string, a as Data);
  };
}

export const logger = {
  debug: adapt('debug'),
  info: adapt('info'),
  warn: adapt('warn'),
  error: adapt('error'),
  fatal: adapt('fatal'),
};
