import { describe, expect, it, vi } from 'vitest';
import { PlaytomicProvider, normalise } from '../src/providers/playtomic.js';

/** The shape the live API returns, trimmed to what we read. */
const SAMPLE = {
  start_date: '2026-10-11T10:00:00',
  end_date: '2026-10-11T11:30:00',
  sport_id: 'PADEL',
  game_status: 'PENDING',
  resource_name: 'Court 2',
  price: '15 EUR',
  location_info: {
    name: 'Ocean Athletics Club',
    address: { street: 'Jean-Gardner-Batten-Straße 1', city: 'Frankfurt am Main', timezone: 'Europe/Berlin' },
  },
  teams: [
    { min_players: 2, max_players: 2, players: [{ name: 'André L' }, { name: 'Roman G' }] },
    { min_players: 2, max_players: 2, players: [] },
  ],
};

/** A fetch stub: maps URL+method to a canned Response. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown; url?: string }>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url}`;
    const match =
      routes[key] ??
      routes[url] ??
      Object.entries(routes).find(([k]) => url.includes(k.replace(/^\w+ /, '')))?.[1];
    if (!match) return new Response('not stubbed', { status: 500 });
    const res = new Response(match.body == null ? '' : JSON.stringify(match.body), {
      status: match.status ?? 200,
    });
    if (match.url) Object.defineProperty(res, 'url', { value: match.url });
    return res;
  }) as unknown as typeof fetch;
}

const creds = { email: 'dummy@example.com', password: 'x' };

describe('Playtomic link recognition', () => {
  const p = new PlaytomicProvider(creds);
  it('recognises deep links and short links, rejects the rest', () => {
    expect(p.matches('https://app.playtomic.com/matches/cbaa2abf-6f39-4940-abc7-649542bd3da0')).toBe(true);
    expect(p.matches('https://app.playtomic.com/t/LxI29GHG')).toBe(true);
    expect(p.matches('https://app.playtomic.com/matches/cbaa2abf?utm_source=share')).toBe(true);
    expect(p.matches('https://padelcity.go.link/x')).toBe(false);
    expect(p.matches('https://example.com')).toBe(false);
  });
  it('extracts the UUID from a deep link', () => {
    expect(p.extractId('https://app.playtomic.com/matches/cbaa2abf-6f39-4940-abc7-649542bd3da0'))
      .toBe('cbaa2abf-6f39-4940-abc7-649542bd3da0');
  });
});

describe('normalise', () => {
  it('maps the provider shape to the neutral match, computing open slots', () => {
    const m = normalise(SAMPLE as never, 'abc', 'https://app.playtomic.com/matches/abc');
    expect(m.venueName).toBe('Ocean Athletics Club');
    expect(m.address).toBe('Jean-Gardner-Batten-Straße 1, Frankfurt am Main');
    expect(m.players).toEqual(['André L', 'Roman G']);
    expect(m.slotsTotal).toBe(4);
    expect(m.slotsFree).toBe(2); // 4 capacity − 2 in
    expect(m.priceLabel).toBe('15 EUR');
    expect(m.sport).toBe('PADEL');
  });
});

describe('fetch flow', () => {
  const ID = 'cbaa2abf-6f39-4940-abc7-649542bd3da0';

  it('logs in, then reads the match', async () => {
    const fetchImpl = stubFetch({
      [`POST https://api.app.playtomic.io/v3/auth/login`]: {
        body: { access_token: 'tok', refresh_token: 'ref', access_token_expiration: '2999-01-01T00:00:00' },
      },
      [`/v1/matches/${ID}`]: { body: SAMPLE },
    });
    const p = new PlaytomicProvider(creds, fetchImpl);
    const r = await p.fetch(`https://app.playtomic.com/matches/${ID}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.players).toHaveLength(2);
  });

  it('refreshes once on a 401, then succeeds', async () => {
    let matchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v3/auth/login'))
        return new Response(JSON.stringify({ access_token: 't', refresh_token: 'r', access_token_expiration: '2999-01-01T00:00:00' }), { status: 200 });
      if (url.includes('/v1/matches/')) {
        matchCalls++;
        return matchCalls === 1
          ? new Response(JSON.stringify({ status: 'UNAUTHORIZED' }), { status: 401 })
          : new Response(JSON.stringify(SAMPLE), { status: 200 });
      }
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    const p = new PlaytomicProvider(creds, fetchImpl);
    const r = await p.fetch(`https://app.playtomic.com/matches/${ID}`);
    expect(r.ok).toBe(true);
    expect(matchCalls).toBe(2); // first 401, retried after re-login
  });

  it('reports auth_failed when login is rejected', async () => {
    const fetchImpl = stubFetch({
      [`POST https://api.app.playtomic.io/v3/auth/login`]: { status: 400, body: { status: 'INVALID' } },
    });
    const p = new PlaytomicProvider(creds, fetchImpl);
    const r = await p.fetch(`https://app.playtomic.com/matches/${ID}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth_failed');
  });

  it('reports not_found for a missing match', async () => {
    const fetchImpl = stubFetch({
      [`POST https://api.app.playtomic.io/v3/auth/login`]: {
        body: { access_token: 't', refresh_token: 'r', access_token_expiration: '2999-01-01T00:00:00' },
      },
      [`/v1/matches/${ID}`]: { status: 404 },
    });
    const p = new PlaytomicProvider(creds, fetchImpl);
    const r = await p.fetch(`https://app.playtomic.com/matches/${ID}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('is unavailable with no credentials, never crashing', async () => {
    const p = new PlaytomicProvider(null);
    expect(p.configured).toBe(false);
    const r = await p.fetch(`https://app.playtomic.com/matches/${ID}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unavailable');
  });

  it('resolves a short link through its redirect', async () => {
    const fetchImpl = stubFetch({
      [`HEAD https://app.playtomic.com/t/LxI29GHG`]: { url: `https://app.playtomic.com/matches/${ID}` },
      [`POST https://api.app.playtomic.io/v3/auth/login`]: {
        body: { access_token: 't', refresh_token: 'r', access_token_expiration: '2999-01-01T00:00:00' },
      },
      [`/v1/matches/${ID}`]: { body: SAMPLE },
    });
    const p = new PlaytomicProvider(creds, fetchImpl);
    const r = await p.fetch('https://app.playtomic.com/t/LxI29GHG');
    expect(r.ok).toBe(true);
  });
});
