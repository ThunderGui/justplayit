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

/* The eight further real shares the user supplied (en + de, both apps,
   including a 12h "7:30 pm" time, "Sept."/"Okt." months, free slots between
   players, and preamble/trailing chatter). now=2026-09-20 so all are future. */
const NOW2 = DateTime.fromISO('2026-09-20T00:00:00', { zone: 'Europe/Berlin' });
const CASES: [string, string, {platform:string; at:string; venue:string; court:string|null; players:number; free:number; total:number; dur:number}][] = [
  ['1 PT de Sept', `*MATCH IN PADEL MOVE -> FRIEDBERG HESSEN*\n\n 📅 Sonntag, 27. Sept., 14:30 (90min)\n 📍 Friedberg (Hessen)\n ✅ Marc Kinder (3,2)\n ✅ Philipp Ewald (3,3)\n ✅ Anne  (2,2)\n ⚪ ??\nhttps://app.playtomic.com/t/2yKCiK2X`,
    {platform:'Playtomic', at:'2026-09-27 14:30', venue:'Friedberg (Hessen)', court:null, players:3, free:1, total:4, dur:90}],
  ['2 PT en 7:30pm', `*Looking for a fourth player today*\n\n*MATCH IN PADEL FRANKFURT*\n\n 📅 Monday, Sep 28, 7:30 pm (90min)\n 📍 Frankfurt am Main\n ✅ j jaro (4)\n ✅ Jan Kortler (3.6)\n ✅ Ivan Cruz (3.4)\n ⚪ ??\nhttps://app.playtomic.com/t/d8u2aMM9`,
    {platform:'Playtomic', at:'2026-09-28 19:30', venue:'Frankfurt am Main', court:null, players:3, free:1, total:4, dur:90}],
  ['3 PC de 120', `*OPEN MATCH IN PADELCITY WIESBADEN*\n\n📅  Do., 1. Oktober, 16:00 - 18:00 (120 Min.)\n📍 PadelCity Wiesbaden\n🎾 Padel Court 7\n🌧️ INDOOR / DOPPEL\n📊 Level 2 - 3\n✅ Caner (2)\n✅ Beata (3)\n❓ Frei (null)\n❓ Frei (null)\nhttps://padelcity.go.link/playtab/play/match/4d00e88b-86d5-4ad9-bd40-f361c92125f1?adj_t=x&deeplink_js=1`,
    {platform:'Padelcity', at:'2026-10-01 16:00', venue:'PadelCity Wiesbaden', court:'Padel Court 7', players:2, free:2, total:4, dur:120}],
  ['4 PT de level', `*MATCH IN SPORTPARK FRANKFURT*\n\n 📅 Sonntag, 04. Okt., 14:00 (90min)\n 📍 Frankfurt am Main\n 📊 Level 0.55 - 1.55\n 🚻 Gemischt\n ✅ Paul S (1,7)\n ✅ Muriel Pistor (0,9)\n ✅ Maik-Henrik (0,9)\n ⚪ ??\nhttps://app.playtomic.com/t/FfT9epww`,
    {platform:'Playtomic', at:'2026-10-04 14:00', venue:'Frankfurt am Main', court:null, players:3, free:1, total:4, dur:90}],
  ['5 PT de interleaved', `New Upload \n\n*MATCH IN THE PADELLERS *\n\n 📅 Samstag, 03. Okt., 19:30 (90min)\n 📍 The Padellers \n 📊 Level 2.53 - 3.53\n ✅ Torben (2,7)\n ⚪ ??\n ✅ Hanno Güllicher (2,1)\n ✅ alexander (2,4)\nhttps://app.playtomic.com/t/nWE6tQBK`,
    {platform:'Playtomic', at:'2026-10-03 19:30', venue:'The Padellers', court:null, players:3, free:1, total:4, dur:90}],
  ['6 PT de trailing', `*MATCH IN MAKKABI CAMPUS BY TUS MAKKABI FRANKFURT E.V. *\n\n 📅 Montag, 05. Okt., 17:30 (90min)\n 📍 Frankfurt am Main\n ✅ Henk Meijer (3,3)\n ✅ Raphael Reiner (3,9)\n ⚪ ??\n ⚪ ??\nhttps://app.playtomic.com/t/0zS6fgs1\n\nWer hat Lust? 2 Spieler gesucht!`,
    {platform:'Playtomic', at:'2026-10-05 17:30', venue:'Frankfurt am Main', court:null, players:2, free:2, total:4, dur:90}],
  ['7 PT de 120 solo', `*MATCH IN PADEL WALLAU*\n\n 📅 Donnerstag, 08. Okt., 14:30 (120min)\n 📍 Wallau\n ✅ Daniel Klein (3,9)\n ⚪ ??\n ⚪ ??\n ⚪ ??\nhttps://app.playtomic.com/t/pCJA4TxJ`,
    {platform:'Playtomic', at:'2026-10-08 14:30', venue:'Wallau', court:null, players:1, free:3, total:4, dur:120}],
  ['8 PC de free mid', `*OPEN MATCH IN PADELCITY FRANKFURT*\n\n📅  Fr., 9. Oktober, 15:00 - 16:30 (90 Min.)\n📍 PadelCity Frankfurt\n🎾 Padel Court 3\n☀️ OUTDOOR / DOPPEL\n📊 Level 3\n✅ Rolando (3)\n✅ Alex (3)\n❓ Frei (null)\n✅ Ric (3)\nhttps://padelcity.go.link/playtab/play/match/81325709-15a8-4533-bbe2-45c750449a64?adj_t=x&deeplink_js=1`,
    {platform:'Padelcity', at:'2026-10-09 15:00', venue:'PadelCity Frankfurt', court:'Padel Court 3', players:3, free:1, total:4, dur:90}],
];

describe('parses every real share correctly', () => {
  it.each(CASES)('%s', (_label, text, exp) => {
    const m = parseSharedMatch(text, 'Europe/Berlin', NOW2)!;
    expect(m.platform).toBe(exp.platform);
    expect(at(m.startsAtIso)).toBe(exp.at);
    expect(m.venue).toBe(exp.venue);
    expect(m.court).toBe(exp.court);
    expect(m.players).toHaveLength(exp.players);
    expect([m.slotsFree, m.slotsTotal]).toEqual([exp.free, exp.total]);
    expect(m.durationMin).toBe(exp.dur);
  });
});

describe('dedup is robust to different tracking params', () => {
  it('ignores the same match re-shared with a different adj_t', async () => {
    freshDb(); setProviders([]);
    const base = 'https://padelcity.go.link/playtab/play/match/4d00e88b-86d5-4ad9-bd40-f361c92125f1';
    const day = DateTime.now().plus({ days: 3 }).setLocale('en').toFormat('ccc, d LLLL');
    const msg = (q: string) => `*OPEN MATCH*\n📅  ${day}, 16:00 (90 Min.)\n📍 PadelCity Wiesbaden\n✅ Caner (2)\n${base}?adj_t=${q}&deeplink_js=1`;
    const c = { groupId: GROUP, user: user('Caner'), dict: t('en'), settings: getSettings(GROUP) };
    expect(await autoAddFromShare(parseSharedMatch(msg('AAA'), 'Europe/Berlin', DateTime.now())!, c)).toHaveLength(1);
    // same match, different tracking token → must NOT add again
    expect(await autoAddFromShare(parseSharedMatch(msg('ZZZ'), 'Europe/Berlin', DateTime.now())!, c)).toHaveLength(0);
    expect(listUpcoming(GROUP)).toHaveLength(1);
  });
});

