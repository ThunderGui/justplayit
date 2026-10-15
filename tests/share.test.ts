import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSharedMatch, findShareLink, matchKey } from '../src/bot/share.js';
import { autoAddFromShare } from '../src/bot/commands.js';
import { findBookingByCode, listUpcoming } from '../src/domain/bookings.js';
import { getSettings } from '../src/domain/settings.js';
import { setProviders } from '../src/providers/index.js';
import type { Provider } from '../src/providers/types.js';
import { t } from '../src/i18n/index.js';
import { GROUP, freshDb, user } from './helpers.js';

const NOW = DateTime.fromISO('2026-10-01T00:00:00', { zone: 'Europe/Berlin' });

const PC_EN = `*OPEN MATCH IN PADELCITY FRANKFURT*

📅  Sun, 18 October, 13:00 - 14:30 (90 min.)
📍 PadelCity Frankfurt
🎾 Padel Court 3
☀️ OUTDOOR / DOUBLE
✅ Gustavo  (3)
✅ Deepak (3)
❓ Free (null)
❓ Free (null)
https://padelcity.go.link/playtab/play/match/8b544083-9696-49eb-99f7-b94c646a384a?adj_t=17u0p26p&deeplink_js=1`;

const PC_DE = `*OPEN MATCH IN PADELCITY FRANKFURT*

📅  Fr., 9. Oktober, 15:00 - 16:30 (90 Min.)
📍 PadelCity Frankfurt
🎾 Padel Court 3
✅ Rolando (3)
✅ Alex (3)
https://padelcity.go.link/playtab/play/match/81325709-15a8-4533-bbe2-45c750449a64?adj_t=1&deeplink_js=1`;

const PT_DE = `*MATCH IN EINTRACHT FRANKFURT E.V.*

 📅 Freitag, 23. Okt., 16:00 (90min)
 📍 Frankfurt am Main
 ✅ Henk Meijer (3,3)
 ⚪ ??
 ⚪ ??
 ⚪ ??
https://app.playtomic.com/t/bwCgsxci`;

function at(iso: string | null): string {
  return iso ? DateTime.fromISO(iso, { zone: 'utc' }).setZone('Europe/Berlin').toFormat('yyyy-LL-dd HH:mm') : 'null';
}

describe('parsing a shared match (language-independent)', () => {
  it('reads an English Padelcity share', () => {
    const m = parseSharedMatch(PC_EN, 'Europe/Berlin', NOW)!;
    expect(m.platform).toBe('Padelcity');
    expect(at(m.startsAtIso)).toBe('2026-10-18 13:00');
    expect(m.venue).toBe('PadelCity Frankfurt');
    expect(m.court).toBe('Padel Court 3');
    expect(m.players).toEqual(['Gustavo', 'Deepak']);
    expect([m.slotsFree, m.slotsTotal]).toEqual([2, 4]);
    expect(m.durationMin).toBe(90);
  });

  it('reads a German Padelcity share (month "Oktober")', () => {
    const m = parseSharedMatch(PC_DE, 'Europe/Berlin', NOW)!;
    expect(at(m.startsAtIso)).toBe('2026-10-09 15:00');
    expect(m.players).toEqual(['Rolando', 'Alex']);
  });

  it('reads a German Playtomic share (month "Okt.") and ignores the level line', () => {
    const m = parseSharedMatch(PT_DE, 'Europe/Berlin', NOW)!;
    expect(m.platform).toBe('Playtomic');
    expect(at(m.startsAtIso)).toBe('2026-10-23 16:00');
    expect(m.players).toEqual(['Henk Meijer']);
    expect([m.slotsFree, m.slotsTotal]).toEqual([3, 4]);
  });

  it('returns null for a message with no match link', () => {
    expect(parseSharedMatch('just chatting here', 'Europe/Berlin', NOW)).toBeNull();
  });

  it('dedup key is stable across tracking query params', () => {
    expect(matchKey('https://app.playtomic.com/t/bwCgsxci')).toBe('bwCgsxci');
    expect(matchKey('https://padelcity.go.link/playtab/play/match/81325709-15a8-4533-bbe2-45c750449a64?adj_t=1'))
      .toBe('81325709-15a8-4533-bbe2-45c750449a64');
  });
});

describe('auto-adding a shared match', () => {
  const ctx = () => ({ groupId: GROUP, user: user('Gustavo'), dict: t('en'), settings: getSettings(GROUP) });
  beforeEach(() => { freshDb(); setProviders([]); });

  it('adds a Padelcity share as a booking owned by the sharer', async () => {
    const me = user('Gustavo');
    const out = await autoAddFromShare(parseSharedMatch(PC_EN, 'Europe/Berlin', DateTime.now())!, { ...ctx(), user: me });
    expect(out).toHaveLength(1);
    const text = out[0]!.text;
    expect(text).toContain('Padelcity');
    expect(text).toContain('PadelCity Frankfurt');
    const upcoming = listUpcoming(GROUP);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.creator_id).toBe(me.id); // sharer owns it → can cancel
  });

  it('does not add the same match twice (re-share)', async () => {
    const c = ctx();
    const share = () => parseSharedMatch(PC_EN, 'Europe/Berlin', DateTime.now())!;
    expect(await autoAddFromShare(share(), c)).toHaveLength(1);
    expect(await autoAddFromShare(share(), c)).toHaveLength(0); // ignored
    expect(listUpcoming(GROUP)).toHaveLength(1);
  });

  it('uses the real provider fetch for a Playtomic share', async () => {
    const future = DateTime.utc().plus({ days: 4 }).set({ hour: 17, minute: 0 }).toISO()!;
    const provider: Provider = {
      key: 'playtomic', label: 'Playtomic',
      matches: (u) => u.includes('playtomic'), extractId: () => 'bwCgsxci',
      fetch: vi.fn(async (url) => ({
        ok: true as const,
        match: { providerMatchId: 'bwCgsxci', provider: 'Playtomic', url, venueName: 'Eintracht Frankfurt',
          address: null, court: 'Court 1', startsAtIso: future, endsAtIso: null, timezone: 'Europe/Berlin',
          sport: 'PADEL', status: 'PENDING', players: ['Henk Meijer'], slotsTotal: 4, slotsFree: 3, priceLabel: null },
      })),
    };
    setProviders([provider]);
    const out = await autoAddFromShare(parseSharedMatch(PT_DE, 'Europe/Berlin', DateTime.now())!, ctx());
    expect(out[0]!.text).toContain('Eintracht Frankfurt'); // from the fetch, not the "Frankfurt am Main" text
    expect(provider.fetch).toHaveBeenCalled();
  });

  it('stays silent when the share carries no readable date', async () => {
    const noDate = 'check it out https://padelcity.go.link/playtab/play/match/zzzz-1111-2222-3333-444455556666';
    const share = parseSharedMatch(noDate, 'Europe/Berlin', DateTime.now())!;
    expect(share.startsAtIso).toBeNull();
    const out = await autoAddFromShare(share, ctx());
    expect(out).toHaveLength(0);
    expect(listUpcoming(GROUP)).toHaveLength(0);
  });
});
