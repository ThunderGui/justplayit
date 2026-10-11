import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMessage } from '../src/bot/parser.js';
import { field } from '../src/bot/parser.js';
import { prefillExternalFromLink } from '../src/whatsapp/dispatcher.js';
import { setProviders } from '../src/providers/index.js';
import type { Provider } from '../src/providers/types.js';

function mockProvider(startsAtIso: string, court = 'Court 2'): Provider {
  return {
    key: 'playtomic', label: 'Playtomic',
    matches: (u) => u.includes('playtomic'),
    extractId: () => 'abc',
    fetch: vi.fn(async (url) => ({
      ok: true as const,
      match: {
        providerMatchId: 'abc', provider: 'Playtomic', url,
        venueName: 'Ocean', address: null, court,
        startsAtIso, endsAtIso: null, timezone: 'Europe/Berlin',
        sport: 'PADEL', status: 'PENDING', players: [], slotsTotal: 4, slotsFree: 4, priceLabel: null,
      },
    })),
  };
}

function parse(text: string) {
  const p = parseMessage(text, { prefix: '!', prefixOptional: true });
  if (p.kind !== 'command') throw new Error('not a command');
  return p.command;
}

afterEach(() => setProviders([])); // reset registry

describe('Playtomic date/time pre-fill from the link', () => {
  it('fills date, time and court from the match', async () => {
    setProviders([mockProvider('2026-09-03T17:00:00Z')]); // 19:00 Berlin
    const cmd = parse('!playtomic url: https://playtomic.io/m/abc');
    await prefillExternalFromLink(cmd, 'Europe/Berlin');

    expect(field(cmd.fields, 'date')).toBe('2026-09-03');
    expect(field(cmd.fields, 'time')).toBe('19:00');
    expect(field(cmd.fields, 'court')).toBe('Court 2');
  });

  it('respects a date/time the user typed explicitly', async () => {
    setProviders([mockProvider('2026-09-03T17:00:00Z')]);
    const cmd = parse(['!playtomic', 'url: https://playtomic.io/m/abc', 'date: 05/09', 'time: 20:30'].join('\n'));
    await prefillExternalFromLink(cmd, 'Europe/Berlin');

    // User's values win; the fetch does not overwrite them.
    expect(field(cmd.fields, 'date')).toBe('05/09');
    expect(field(cmd.fields, 'time')).toBe('20:30');
  });

  it('leaves fields empty when the link is not a known provider', async () => {
    setProviders([mockProvider('2026-09-03T17:00:00Z')]);
    const cmd = parse('!playtomic url: https://example.com/x');
    await prefillExternalFromLink(cmd, 'Europe/Berlin');
    expect(field(cmd.fields, 'date')).toBeUndefined();
  });

  it('leaves fields empty when the fetch fails', async () => {
    const failing: Provider = {
      key: 'playtomic', label: 'Playtomic',
      matches: (u) => u.includes('playtomic'), extractId: () => 'abc',
      fetch: vi.fn(async () => ({ ok: false as const, reason: 'auth_failed' as const })),
    };
    setProviders([failing]);
    const cmd = parse('!playtomic url: https://playtomic.io/m/abc');
    await prefillExternalFromLink(cmd, 'Europe/Berlin');
    expect(field(cmd.fields, 'date')).toBeUndefined();
  });
});
