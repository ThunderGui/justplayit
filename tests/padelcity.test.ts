import { describe, expect, it, vi } from 'vitest';
import { PadelcityProvider } from '../src/providers/padelcity.js';

// The real single-match response the user captured (trimmed to the fields we read).
const MATCH = {
  id: 'ac341f0e-f567-4ec5-8b06-3913795e8f50',
  kind: 'OPEN',
  phase: 'CONFIRMING',
  matchPeriod: { startsAt: '2026-10-18T10:30:00+00:00', endsAt: '2026-10-18T12:00:00+00:00', durationInSeconds: 5400 },
  court: { name: 'Padel Court 05', locationType: 'INDOOR', courtType: 'DOUBLE', sportType: 'PADEL' },
  club: {
    name: 'PadelCity Cadolzburg',
    address: { streetName: 'Schwadermühlstraße', buildingNumber: '12', postalCode: '90556', localityName: 'Cadolzburg' },
  },
  slots: [
    { index: 1, player: '/players/x', playerContext: { userId: 'a', firstName: 'Katharina', lastName: 'Barth', performanceClass: 2, isHost: true } },
    { index: 2, player: '/players/y', playerContext: { userId: 'b', firstName: 'Jörg ', lastName: 'Heid ', performanceClass: 3, isHost: false } },
    { index: 3, player: null, playerContext: null },
    { index: 4, player: null, playerContext: null },
  ],
  slotFee: { amount: '1425', currency: 'EUR', symbol: '€' },
};

function provider(fetchImpl: typeof fetch) {
  return new PadelcityProvider({ email: 'e@x.com', password: 'p', clientSecret: 'cs' }, fetchImpl);
}

describe('PadelcityProvider', () => {
  it('recognises a shared go.link match URL and extracts the uuid', () => {
    const p = provider(vi.fn());
    const url = 'https://padelcity.go.link/playtab/play/match/ac341f0e-f567-4ec5-8b06-3913795e8f50?adj_t=x';
    expect(p.matches(url)).toBe(true);
    expect(p.extractId(url)).toBe('ac341f0e-f567-4ec5-8b06-3913795e8f50');
    expect(p.matches('https://app.playtomic.com/t/abc')).toBe(false);
  });

  it('logs in once, reads the match, and normalises it', async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.includes('openid-connect/token')) {
        expect(String(init?.body)).toContain('grant_type=password');
        expect(String(init?.body)).toContain('client_id=padel-city-internal');
        return new Response(JSON.stringify({ access_token: 'TOK', expires_in: 300 }), { status: 200 });
      }
      // the match read must carry the Bearer + x-app headers, no API key
      const h = new Headers(init?.headers);
      expect(h.get('authorization')).toBe('Bearer TOK');
      expect(h.get('x-app-os')).toBe('android');
      expect(u).toContain('/matches/ac341f0e-f567-4ec5-8b06-3913795e8f50');
      return new Response(JSON.stringify(MATCH), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await provider(fetchImpl).fetch(
      'https://padelcity.go.link/playtab/play/match/ac341f0e-f567-4ec5-8b06-3913795e8f50',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = res.match;
    expect(m.provider).toBe('Padelcity');
    expect(m.venueName).toBe('PadelCity Cadolzburg');
    expect(m.court).toBe('Padel Court 05');
    expect(m.address).toContain('Cadolzburg');
    expect(m.players).toEqual(['Katharina Barth', 'Jörg Heid']); // trailing spaces trimmed
    expect([m.slotsFree, m.slotsTotal]).toEqual([2, 4]);
    expect(m.sport).toBe('PADEL');
    expect(m.priceLabel).toBe('€14.25');
    // startsAt normalised to UTC
    expect(m.startsAtIso).toBe('2026-10-18T10:30:00.000Z');
  });

  it('is unavailable without credentials', async () => {
    const p = new PadelcityProvider(null);
    const res = await p.fetch('https://padelcity.go.link/playtab/play/match/ac341f0e-f567-4ec5-8b06-3913795e8f50');
    expect(res.ok).toBe(false);
  });
});
