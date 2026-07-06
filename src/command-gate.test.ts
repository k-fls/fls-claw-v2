import { describe, expect, it } from 'vitest';

import { gateCommand } from './command-gate.js';

/**
 * These cases exercise only the FILTERED / pass classification paths, which
 * never touch the DB (no `isAdmin` lookup). The mention-prefix handling is
 * the focus: a slash command that arrives @-mention-prefixed in a group
 * channel must classify from the boundary the channel layer marked
 * (`mentionPrefixEnd`), not from the raw '@…' text.
 */
describe('gateCommand — mention-prefixed slash commands', () => {
  it('classifies a mention-prefixed filtered command when mentionPrefixEnd is set', () => {
    // "@U0AKKG67T7X " is 13 chars → content resumes at "/help".
    const content = JSON.stringify({ text: '@U0AKKG67T7X /help', mentionPrefixEnd: 13 });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('without the annotation, the mention-prefixed command falls through (the bug)', () => {
    // Documents why the boundary annotation is load-bearing: raw text starts
    // with '@', not '/', so the gate cannot see the command and passes it on.
    const content = JSON.stringify({ text: '@U0AKKG67T7X /help' });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('still classifies a plain (DM-style) filtered command with no mention', () => {
    const content = JSON.stringify({ text: '/help' });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('passes ordinary chatter through', () => {
    const content = JSON.stringify({ text: '@U0AKKG67T7X how are you?', mentionPrefixEnd: 13 });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('ignores an out-of-range mentionPrefixEnd rather than throwing', () => {
    const content = JSON.stringify({ text: '/help', mentionPrefixEnd: 999 });
    expect(gateCommand(content, 'slack:U1', 'ag-1')).toEqual({ action: 'filter' });
  });
});
