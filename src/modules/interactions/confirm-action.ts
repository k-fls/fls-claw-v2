/**
 * confirmAction — confirm / cancel button pair. Wraps pickFromButtons
 * with a fixed two-option set and maps the chosen value back to a
 * literal result.
 */
import type { Session } from '../../types.js';
import { pickFromButtons } from './pick-from-buttons.js';

export interface ConfirmActionOptions {
  session: Session;
  agentName: string;
  title: string;
  question: string;
  /** Optional URL appended to the question body for the approver to inspect. */
  url?: string;
  /** Default 'Confirm'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
}

export type ConfirmResult = 'confirmed' | 'cancelled' | 'timeout';

export async function confirmAction(opts: ConfirmActionOptions): Promise<ConfirmResult> {
  const confirmLabel = opts.confirmLabel ?? 'Confirm';
  const cancelLabel = opts.cancelLabel ?? 'Cancel';
  const question = opts.url ? `${opts.question}\n\n${opts.url}` : opts.question;

  const result = await pickFromButtons({
    session: opts.session,
    agentName: opts.agentName,
    title: opts.title,
    question,
    options: [
      { value: 'confirm', label: confirmLabel },
      { value: 'cancel', label: cancelLabel },
    ],
  });

  if (result.reason === 'picked' && result.value === 'confirm') return 'confirmed';
  return 'cancelled';
}
