/**
 * pickFromButtons — "pick one of N" via a button card delivered to an
 * eligible approver's DM. Composes the approvals primitives (`pickApprover`,
 * `pickApprovalDelivery`) and the chat-sdk `ask_question` payload, but
 * does NOT touch `pending_approvals`: the approvals primitive hardcodes
 * a two-option Approve/Reject card and rejects any non-`approve` value,
 * which would make N-option picks impossible.
 *
 * Instead, this module keeps its own in-memory pending map and lazily
 * registers a response handler that intercepts its question IDs before
 * the approvals response handler sees them. No DB tables, no persistence —
 * a process restart drops in-flight picks (acceptable per §5).
 */
import { normalizeOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import type { Session } from '../../types.js';
import { pickApprover, pickApprovalDelivery } from '../approvals/primitive.js';

export interface PickOption {
  value: string;
  label: string;
}

export interface PickFromButtonsOptions {
  session: Session;
  agentName: string;
  title: string;
  question: string;
  options: PickOption[];
}

export interface PickResult {
  value: string | null;
  reason: 'picked' | 'declined' | 'timeout';
}

interface PendingPick {
  options: PickOption[];
  resolve: (r: PickResult) => void;
}

const pending = new Map<string, PendingPick>();
let responseHandlerRegistered = false;

function ensureResponseHandler(): void {
  if (responseHandlerRegistered) return;
  responseHandlerRegistered = true;
  registerResponseHandler(async (payload: ResponsePayload): Promise<boolean> => {
    const p = pending.get(payload.questionId);
    if (!p) return false;
    pending.delete(payload.questionId);
    const match = p.options.find((o) => o.value === payload.value);
    if (match) {
      p.resolve({ value: match.value, reason: 'picked' });
    } else {
      log.warn('pickFromButtons response value not in options — treating as declined', {
        questionId: payload.questionId,
        value: payload.value,
      });
      p.resolve({ value: null, reason: 'declined' });
    }
    return true;
  });
}

/** Test-only: drop in-flight picks without resolving them. */
export function _resetPickFromButtonsForTesting(): void {
  pending.clear();
}

export async function pickFromButtons(opts: PickFromButtonsOptions): Promise<PickResult> {
  ensureResponseHandler();
  const { session, title, question, options } = opts;

  if (options.length === 0) {
    return { value: null, reason: 'declined' };
  }

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    return { value: null, reason: 'declined' };
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    return { value: null, reason: 'declined' };
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    return { value: null, reason: 'declined' };
  }

  const questionId = `interactions-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalized = options.map((o) => normalizeOption({ label: o.label, value: o.value }));

  return new Promise<PickResult>((resolve) => {
    pending.set(questionId, { options, resolve });
    adapter
      .deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ type: 'ask_question', questionId, title, question, options: normalized }),
      )
      .catch((err) => {
        log.error('pickFromButtons failed to deliver card', { questionId, err });
        if (pending.delete(questionId)) {
          resolve({ value: null, reason: 'declined' });
        }
      });
  });
}
