/**
 * pastePlain — free-form text capture composed over A1a.
 *
 * Opens a host interaction on the originating slot. The first inbound
 * reply that passes `validate` (or any reply, if no validator is given)
 * resolves the promise. Cancel keywords (case-insensitive, trimmed)
 * resolve with `reason: 'cancelled'`; the A1a timeout resolves with
 * `reason: 'timeout'`.
 *
 * Validator failures keep the slot open and re-prompt the user with the
 * validator's error message — the retry loop is internal so consumers
 * never see partial state.
 *
 * Carries no credential or paste-target semantics — consumers (`/auth
 * import`, `/ssh add`, etc.) interpret the returned text themselves.
 */
import type { HostCommandContext } from '../../command-gate.js';
import type { HostInteractionContext } from '../../host-interactions.js';

export interface PastePlainOptions {
  ctx: HostCommandContext;
  /** Initial message sent to the user when the slot opens. */
  prompt: string;
  /** Slot timeout in ms. Default is A1a's default (10 min). */
  timeoutMs?: number;
  /** Case-insensitive cancel words. Default: ['cancel', '/cancel', 'stop']. */
  cancelKeywords?: string[];
  /**
   * Optional validator. Return `null` to accept and resolve; return a
   * user-facing error string to reject — the slot stays open and the user
   * is re-prompted with the error.
   */
  validate?: (text: string) => string | null;
}

export interface PasteResult {
  text: string | null;
  reason: 'submitted' | 'cancelled' | 'timeout';
}

const DEFAULT_CANCEL_KEYWORDS = ['cancel', '/cancel', 'stop'];

/** Unwrap the chat `{text}` envelope; falls back to the raw string. */
export function extractInboundText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === 'string') return parsed.text;
  } catch {
    /* not JSON — treat as raw */
  }
  return raw;
}

export function pastePlain(opts: PastePlainOptions): Promise<PasteResult> {
  const cancelSet = new Set((opts.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS).map((k) => k.trim().toLowerCase()));

  return new Promise<PasteResult>((resolve) => {
    const handler = (hctx: HostInteractionContext): void => {
      const text = extractInboundText(hctx.inboundContent);
      const trimmed = text.trim();
      if (cancelSet.has(trimmed.toLowerCase())) {
        hctx.finish();
        resolve({ text: null, reason: 'cancelled' });
        return;
      }
      if (opts.validate) {
        const err = opts.validate(text);
        if (err != null) {
          hctx.ask(err);
          return;
        }
      }
      hctx.finish();
      resolve({ text, reason: 'submitted' });
    };

    opts.ctx.beginInteraction({
      handler,
      initialPrompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      onTimeout: () => resolve({ text: null, reason: 'timeout' }),
    });
  });
}
