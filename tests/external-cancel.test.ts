import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncExternalBooking } from '../src/domain/external-sync.js';
import { createExternalBooking, findBookingById } from '../src/domain/bookings.js';
import { setProviders } from '../src/providers/index.js';
import type { Provider, ExternalMatch } from '../src/providers/types.js';
import { GROUP, freshDb, user } from './helpers.js';

const future = () => DateTime.utc().plus({ days: 3 }).set({ hour: 18 }).toISO()!;

function match(status: string): ExternalMatch {
  return {
    providerMatchId: 'm1', provider: 'Padelcity', url: 'https://padelcity.go.link/playtab/play/match/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    venueName: 'Club', address: null, court: 'C1', startsAtIso: future(), endsAtIso: null, timezone: null,
    sport: 'PADEL', status, players: ['A'], slotsTotal: 4, slotsFree: 3, priceLabel: null,
  };
}

function provider(fetchResult: () => Promise<{ ok: true; match: ExternalMatch } | { ok: false; reason: string }>): Provider {
  return {
    key: 'padelcity', label: 'Padelcity',
    matches: (u) => u.includes('padelcity'), extractId: () => 'm1',
    fetch: vi.fn(fetchResult),
  };
}

function makeBooking() {
  const gui = user('Gui');
  const r = createExternalBooking({
    groupId: GROUP, creator: gui, provider: 'Padelcity',
    url: 'https://padelcity.go.link/playtab/play/match/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    startsAtIso: future(),
  });
  if (!r.ok) throw new Error('setup failed');
  return r.booking;
}

beforeEach(() => freshDb());

describe('external cancellation detection', () => {
  it('cancels + flags when the platform reports the match cancelled', async () => {
    setProviders([provider(async () => ({ ok: true, match: match('CANCELLED') }))]);
    const b = makeBooking();
    const out = await syncExternalBooking(findBookingById(b.id)!);
    expect(out.cancelled).toBe(true);
    expect(findBookingById(b.id)!.status).toBe('CANCELLED');
  });

  it('does NOT cancel on a single 404 (transient guard), but does on the second', async () => {
    setProviders([provider(async () => ({ ok: false, reason: 'not_found' }))]);
    const b = makeBooking();

    const first = await syncExternalBooking(findBookingById(b.id)!);
    expect(first.cancelled).toBeFalsy();
    expect(findBookingById(b.id)!.status).toBe('OPEN');          // still open after one miss
    expect(findBookingById(b.id)!.external_sync_error).toBe('not_found');

    const second = await syncExternalBooking(findBookingById(b.id)!);
    expect(second.cancelled).toBe(true);
    expect(findBookingById(b.id)!.status).toBe('CANCELLED');     // gone after two
  });

  it('leaves a healthy match open', async () => {
    setProviders([provider(async () => ({ ok: true, match: match('CONFIRMING') }))]);
    const b = makeBooking();
    const out = await syncExternalBooking(findBookingById(b.id)!);
    expect(out.cancelled).toBeFalsy();
    expect(findBookingById(b.id)!.status).toBe('OPEN');
  });
});
