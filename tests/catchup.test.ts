import { describe, expect, it } from 'vitest';
import { CATCH_UP_WINDOW_MINUTES, isWithinCatchUpWindow } from '../src/whatsapp/client.js';

const NOW_MS = Date.parse('2026-08-27T19:00:00Z');
const secondsAgo = (n: number) => NOW_MS / 1000 - n;

describe('offline catch-up window', () => {
  it('accepts a message from a reconnect a few minutes later', () => {
    // The reported failure: the bot was down for 23 minutes and the command
    // sent during that window was dropped on redelivery.
    expect(isWithinCatchUpWindow(secondsAgo(23 * 60), NOW_MS)).toBe(true);
  });

  it('accepts a live message', () => {
    expect(isWithinCatchUpWindow(secondsAgo(2), NOW_MS)).toBe(true);
  });

  it('ignores old history sync so the bot never answers last week', () => {
    expect(isWithinCatchUpWindow(secondsAgo(7 * 24 * 3600), NOW_MS)).toBe(false);
    expect(isWithinCatchUpWindow(secondsAgo(CATCH_UP_WINDOW_MINUTES * 60 + 120), NOW_MS)).toBe(false);
  });

  it('handles the Long objects Baileys sometimes supplies', () => {
    const asLong = { toNumber: () => secondsAgo(60) };
    expect(isWithinCatchUpWindow(asLong, NOW_MS)).toBe(true);

    const oldLong = { toNumber: () => secondsAgo(3 * 3600) };
    expect(isWithinCatchUpWindow(oldLong, NOW_MS)).toBe(false);
  });

  it('treats an unusable timestamp as live rather than dropping it', () => {
    // Answering twice is recoverable; ignoring someone silently is not.
    for (const bad of [undefined, null, 0, NaN, 'nonsense', {}]) {
      expect(isWithinCatchUpWindow(bad, NOW_MS)).toBe(true);
    }
  });

  it('does not reject a message from a slightly fast clock', () => {
    expect(isWithinCatchUpWindow(secondsAgo(-90), NOW_MS)).toBe(true);
  });
});
