/**
 * Indicator emoji resolution and the kill switch.
 *
 * The animated experience depends on a workspace artifact the host cannot
 * provision — a ≤128 KB, 128×128 animated GIF uploaded as a custom emoji — so
 * the name has to be per-install configurable. The default is a built-in
 * Unicode emoji, so a fresh install shows a correct (static) indicator with no
 * setup at all.
 *
 * The emoji name is read once at module load, so each arm loads a fresh copy
 * of the module against a different .env.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing-emoji' };
});

type ReactionCall = { channelType: string; messageId: string; emoji: string; on: boolean };

/**
 * Load a fresh typing module with `.env` resolving to `env`. A key present
 * with an empty string models `KEY=` in the file; a key absent models an
 * unset key. (readEnvFile's own handling of that distinction is covered in
 * src/env.test.ts.)
 */
async function loadTyping(env: Record<string, string>) {
  vi.resetModules();
  // Mirrors readEnvFile's real semantics, including the drop-empty default —
  // otherwise dropping `{ keepEmpty: true }` from the production call site
  // would break the kill switch without failing anything here.
  vi.doMock('../../env.js', () => ({
    readEnvFile: (keys: string[], opts?: { keepEmpty?: boolean }) =>
      Object.fromEntries(
        keys.filter((k) => k in env && (env[k] !== '' || opts?.keepEmpty)).map((k) => [k, env[k]] as const),
      ),
  }));
  const mod = await import('./index.js');

  const reactions: ReactionCall[] = [];
  const typing: string[] = [];
  mod.setTypingAdapter({
    async setTyping(channelType) {
      typing.push(channelType);
    },
    async pulseReaction(channelType, _platformId, messageId, emoji, on) {
      reactions.push({ channelType, messageId, emoji, on });
      return 'ok';
    },
  });
  return { mod, reactions, typing };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('../../env.js');
  vi.resetModules();
});

describe('indicator emoji configuration', () => {
  it('falls back to a built-in Unicode emoji when nothing is configured', async () => {
    const { mod, reactions } = await loadTyping({});
    mod.startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([{ channelType: 'slack', messageId: 'ts-1', emoji: 'hourglass_flowing_sand', on: true }]);
    mod.stopTypingRefresh('sess-1');
  });

  it('passes a configured name through verbatim', async () => {
    const { mod, reactions } = await loadTyping({ SLACK_TYPING_EMOJI: 'claw-working' });
    mod.startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([{ channelType: 'slack', messageId: 'ts-1', emoji: 'claw-working', on: true }]);
    mod.stopTypingRefresh('sess-1');
  });

  it('treats an explicitly empty value as off — no reaction calls at all', async () => {
    // This is the kill switch the production canary depends on: turn the
    // feature off in .env and restart, no redeploy.
    const { mod, reactions, typing } = await loadTyping({ SLACK_TYPING_EMOJI: '' });
    mod.startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, undefined, 'ts-1');
    await vi.advanceTimersByTimeAsync(12_500);
    expect(reactions).toHaveLength(0);

    // …and every other channel is untouched by the switch.
    mod.startTypingRefresh('sess-2', 'ag-1', 'telegram', 'tg:1', null, undefined, 'tg-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(typing).toContain('telegram');

    mod.stopTypingRefresh('sess-1');
    mod.stopTypingRefresh('sess-2');
    expect(reactions).toHaveLength(0);
  });
});
