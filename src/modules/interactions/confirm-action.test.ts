/**
 * Unit tests for confirmAction. We mock pickFromButtons since confirmAction
 * is a thin label/value mapping over it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./pick-from-buttons.js', () => ({
  pickFromButtons: vi.fn(),
}));

import { pickFromButtons } from './pick-from-buttons.js';
import { confirmAction } from './confirm-action.js';
import type { Session } from '../../types.js';

const SESSION: Session = { id: 's', agent_group_id: 'ag-1', messaging_group_id: 'mg-1' } as unknown as Session;

beforeEach(() => {
  vi.mocked(pickFromButtons).mockReset();
});

describe('confirmAction', () => {
  it('returns "confirmed" when pickFromButtons resolves with value="confirm"', async () => {
    vi.mocked(pickFromButtons).mockResolvedValue({ value: 'confirm', reason: 'picked' });
    const result = await confirmAction({
      session: SESSION,
      agentName: 'a',
      title: 't',
      question: 'do it?',
    });
    expect(result).toBe('confirmed');
  });

  it('returns "cancelled" when pickFromButtons resolves with value="cancel"', async () => {
    vi.mocked(pickFromButtons).mockResolvedValue({ value: 'cancel', reason: 'picked' });
    const result = await confirmAction({
      session: SESSION,
      agentName: 'a',
      title: 't',
      question: 'do it?',
    });
    expect(result).toBe('cancelled');
  });

  it('returns "cancelled" on a declined pick', async () => {
    vi.mocked(pickFromButtons).mockResolvedValue({ value: null, reason: 'declined' });
    const result = await confirmAction({
      session: SESSION,
      agentName: 'a',
      title: 't',
      question: 'do it?',
    });
    expect(result).toBe('cancelled');
  });

  it('appends the optional URL into the question body and uses default labels', async () => {
    vi.mocked(pickFromButtons).mockResolvedValue({ value: 'confirm', reason: 'picked' });
    await confirmAction({
      session: SESSION,
      agentName: 'a',
      title: 't',
      question: 'Open this link?',
      url: 'https://example.com/x',
    });
    const args = vi.mocked(pickFromButtons).mock.calls[0][0];
    expect(args.question).toBe('Open this link?\n\nhttps://example.com/x');
    expect(args.options).toEqual([
      { value: 'confirm', label: 'Confirm' },
      { value: 'cancel', label: 'Cancel' },
    ]);
  });

  it('honours custom confirm/cancel labels', async () => {
    vi.mocked(pickFromButtons).mockResolvedValue({ value: 'confirm', reason: 'picked' });
    await confirmAction({
      session: SESSION,
      agentName: 'a',
      title: 't',
      question: 'q',
      confirmLabel: 'Yes!',
      cancelLabel: 'No way',
    });
    const args = vi.mocked(pickFromButtons).mock.calls[0][0];
    expect(args.options).toEqual([
      { value: 'confirm', label: 'Yes!' },
      { value: 'cancel', label: 'No way' },
    ]);
  });
});
