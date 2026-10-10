import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExternalBooking, findBookingById } from '../src/domain/bookings.js';
import { externalPlayers, syncExternalBooking } from '../src/domain/external-sync.js';
import { setProviders } from '../src/providers/index.js';
import type { ExternalMatch, Provider } from '../src/providers/types.js';
import { runExternalSync, type Notifier } from '../src/scheduler/jobs.js';
import { bookingCard } from '../src/bot/render.js';
import { t } from '../src/i18n/index.js';
import { getSettings } from '../src/domain/settings.js';
import { GROUP, freshDb, inHours, user } from './helpers.js';

/** A provider returning canned data, so these tests make no network calls. */
function mockProvider(match: Partial<ExternalMatch> = {}): Provider {
  return {
    key: 'playtomic',
    label: 'Playtomic',
    matches: (u) => u.includes('playtomic'),
    extractId: () => 'abc',
    fetch: vi.fn(async (url: string) => ({
      ok: true as const,
      match: {
        providerMatchId: 'abc',
        provider: 'Playtomic',
        url,
        venueName: 'Ocean Athletics Club',
        address: 'Jean-Gardner-Batten-Straße 1, Frankfurt',
        court: 'Court 2',
        startsAtIso: inHours(26),
        endsAtIso: inHours(27.5),
        timezone: 'Europe/Berlin',
        sport: 'PADEL',
        status: 'PENDING',
        players: ['André L', 'Roman G'],
        slotsTotal: 4,
        slotsFree: 2,
        priceLabel: '15 EUR',
        ...match,
      },
    })),
  };
}

function addExternal(creator = user('Alice')) {
  const r = createExternalBooking({
    groupId: GROUP,
    creator,
    provider: 'Playtomic',
    url: 'https://app.playtomic.com/t/LxI29GHG',
    startsAtIso: inHours(26),
  });
  if (!r.ok) throw new Error('setup failed');
  return r.booking;
}

beforeEach(() => freshDb());

describe('external booking enrichment', () => {
  it('stores the live roster, slots and venue on sync', async () => {
    setProviders([mockProvider()]);
    const b = addExternal();
    const result = await syncExternalBooking(b);
    expect(result.ok).toBe(true);

    const fresh = findBookingById(b.id)!;
    expect(externalPlayers(fresh)).toEqual(['André L', 'Roman G']);
    expect(fresh.external_slots_free).toBe(2);
    expect(fresh.external_slots_total).toBe(4);
    expect(fresh.external_status).toBe('PENDING');
    expect(fresh.external_synced_at).not.toBeNull();
  });

  it('never creates ledger entries for an external booking', async () => {
    setProviders([mockProvider()]);
    const b = addExternal();
    await syncExternalBooking(b);
    // External bookings have no cost and no charges — money stays on-platform.
    expect(findBookingById(b.id)!.total_cost_cents).toBe(0);
  });

  it('records the error but keeps old data when a sync fails', async () => {
    const failing: Provider = {
      key: 'playtomic', label: 'Playtomic',
      matches: (u) => u.includes('playtomic'), extractId: () => 'abc',
      fetch: vi.fn(async () => ({ ok: false as const, reason: 'auth_failed' as const })),
    };
    setProviders([failing]);
    const b = addExternal();
    const r = await syncExternalBooking(b);
    expect(r.ok).toBe(false);
    expect(findBookingById(b.id)!.external_sync_error).toBe('auth_failed');
  });

  it('shows the live roster on the booking card', async () => {
    setProviders([mockProvider()]);
    const b = addExternal();
    await syncExternalBooking(b);
    const card = bookingCard(findBookingById(b.id)!, t('en'), getSettings(GROUP));
    expect(card).toContain('André L');
    expect(card).toContain('Roman G');
    expect(card).toContain('Playtomic');
  });
});

describe('scheduler external sync', () => {
  function recorder() {
    const sent: string[] = [];
    const notifier: Notifier = {
      async sendToGroup(text) { sent.push(text); },
      async sendToUser() {},
    };
    return { notifier, sent };
  }

  it('enriches a new booking and announces it once', async () => {
    setProviders([mockProvider()]);
    addExternal();
    const { notifier, sent } = recorder();

    expect(await runExternalSync(notifier)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('André L'); // enriched card announced

    // A second pass within the refresh window does not re-announce.
    expect(await runExternalSync(notifier)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('leaves managed bookings untouched', async () => {
    setProviders([mockProvider()]);
    const { notifier } = recorder();
    // No external bookings => nothing to do.
    expect(await runExternalSync(notifier)).toBe(0);
  });
});
