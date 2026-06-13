/**
 * pastePgp — capture a PGP-encrypted blob, normalize armor whitespace,
 * decrypt against the caller-provided GNUPGHOME, and optionally validate
 * the cleartext.
 *
 * Retry on bad input is internal: a non-PGP paste, a decrypt failure, or
 * a validator rejection re-prompts the user inside the same A1a slot.
 * The promise only resolves when the user submits a valid value, cancels
 * (keyword), or the A1a slot times out. Result shape mirrors pastePlain
 * — consumers don't see a `'decrypt-failed'` reason because the helper
 * never gives up on the user's behalf.
 *
 * Inbound messages routed to this interaction are intercepted in the
 * router before any session-inbound write, so the ciphertext never
 * lands in `messages_in`.
 */
import type { HostCommandContext } from '../../command-gate.js';
import type { HostInteractionContext } from '../../host-interactions.js';
import { gpgDecryptAt, isPgpMessage, normalizeArmoredBlock } from '../crypto/gpg.js';
import { log } from '../../log.js';
import { extractInboundText } from './paste-plain.js';

export interface PastePgpOptions {
  ctx: HostCommandContext;
  /** Initial message sent to the user when the slot opens. */
  prompt: string;
  /** Slot timeout in ms. Default is A1a's default (10 min). */
  timeoutMs?: number;
  /** Case-insensitive cancel words. Default: ['cancel', '/cancel', 'stop']. */
  cancelKeywords?: string[];
  /** Absolute path to a GNUPGHOME directory containing the private key. */
  gpgHome: string;
  /**
   * Optional validator applied to the decrypted cleartext. Return `null`
   * to accept; return a user-facing error string to reject and re-prompt.
   */
  validate?: (plaintext: string) => string | null;
}

export interface PastePgpResult {
  text: string | null;
  reason: 'submitted' | 'cancelled' | 'timeout';
}

const DEFAULT_CANCEL_KEYWORDS = ['cancel', '/cancel', 'stop'];

export function pastePgp(opts: PastePgpOptions): Promise<PastePgpResult> {
  const cancelSet = new Set((opts.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS).map((k) => k.trim().toLowerCase()));

  return new Promise<PastePgpResult>((resolve) => {
    const handler = (hctx: HostInteractionContext): void => {
      const raw = extractInboundText(hctx.inboundContent);
      const trimmed = raw.trim();

      if (cancelSet.has(trimmed.toLowerCase())) {
        hctx.finish();
        resolve({ text: null, reason: 'cancelled' });
        return;
      }

      if (!isPgpMessage(raw)) {
        hctx.ask(
          "That doesn't look like a PGP-encrypted message (missing the BEGIN/END headers). " +
            'Paste the encrypted block, or type "cancel".',
        );
        return;
      }

      const normalized = normalizeArmoredBlock(raw);

      let cleartext: string;
      try {
        cleartext = gpgDecryptAt(opts.gpgHome, normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('pastePgp decrypt failed — re-prompting', { gpgHome: opts.gpgHome, err: msg });
        hctx.ask(`PGP decrypt failed: ${msg}. Paste the encrypted block again, or type "cancel".`);
        return;
      }

      if (opts.validate) {
        const verr = opts.validate(cleartext);
        if (verr != null) {
          hctx.ask(`${verr} Paste the encrypted block again, or type "cancel".`);
          return;
        }
      }

      hctx.finish();
      resolve({ text: cleartext, reason: 'submitted' });
    };

    opts.ctx.beginInteraction({
      handler,
      initialPrompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      onTimeout: () => resolve({ text: null, reason: 'timeout' }),
    });
  });
}
