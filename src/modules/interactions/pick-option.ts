/**
 * pickOptionOn — origin-driven numbered-choice picker composed over A1a.
 *
 * Presents a numbered list and resolves with the chosen 0-based index when
 * the user replies with a valid number. A non-numeric / out-of-range reply
 * keeps the slot open and re-prompts; cancel keywords resolve `cancelled`;
 * the A1a timeout resolves `timeout`. This is the channel-agnostic
 * counterpart to `pickFromButtons` (which is session-bound and renders
 * platform buttons) — used where only an `InteractionOrigin` is available,
 * e.g. the Claude auth-mode menu at reauth time.
 */
import {
  beginInteractionOn,
  onInteractionRelease,
  type HostInteractionContext,
  type InteractionOrigin,
} from '../../host-interactions.js';
import { extractInboundText } from './paste-plain.js';

export interface PickOptionOnOptions {
  /** Header text shown above the numbered list. */
  prompt: string;
  /** Option labels, presented to the user as 1..N (display order preserved). */
  options: string[];
  /** Slot timeout in ms. Default is A1a's default (10 min). */
  timeoutMs?: number;
  /** Case-insensitive cancel words. Default: ['cancel', '/cancel', 'stop']. */
  cancelKeywords?: string[];
}

export interface PickOptionResult {
  /** 0-based index into `options`, or null when cancelled / timed out. */
  index: number | null;
  reason: 'submitted' | 'cancelled' | 'timeout';
}

const DEFAULT_CANCEL_KEYWORDS = ['cancel', '/cancel', 'stop'];

function renderMenu(prompt: string, options: string[]): string {
  const lines = options.map((label, i) => `${i + 1}. ${label}`);
  return `${prompt}\n\n${lines.join('\n')}\n\nReply with a number (1–${options.length}), or "cancel".`;
}

export function pickOptionOn(origin: InteractionOrigin, opts: PickOptionOnOptions): Promise<PickOptionResult> {
  if (opts.options.length === 0) throw new Error('pickOptionOn requires at least one option');
  const cancelSet = new Set((opts.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS).map((k) => k.trim().toLowerCase()));
  const n = opts.options.length;

  return new Promise<PickOptionResult>((resolve) => {
    beginInteractionOn(origin, {
      initialPrompt: renderMenu(opts.prompt, opts.options),
      timeoutMs: opts.timeoutMs,
      onTimeout: () => resolve({ index: null, reason: 'timeout' }),
      handler: (hctx: HostInteractionContext): void => {
        const trimmed = extractInboundText(hctx.inboundContent).trim();
        let result: PickOptionResult;
        if (cancelSet.has(trimmed.toLowerCase())) {
          result = { index: null, reason: 'cancelled' };
        } else {
          // Accept a bare integer only — reject "1." / "option 2" etc. so an
          // ambiguous reply re-prompts rather than silently picking.
          const choice = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
          if (!Number.isInteger(choice) || choice < 1 || choice > n) {
            hctx.ask(`Please reply with a number between 1 and ${n}, or "cancel".`);
            return;
          }
          result = { index: choice - 1, reason: 'submitted' };
        }
        // Resolve only AFTER the slot is released (finish → post-handler
        // release fires this), so the caller can open a follow-up interaction
        // on the same key without a begin-conflict.
        hctx.finish();
        onInteractionRelease(hctx.key, () => resolve(result));
      },
    });
  });
}
