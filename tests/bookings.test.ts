import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelBooking,
  createBooking,
  getRoster,
  joinBooking,
  leaveBooking,
} from '../src/domain/bookings.js';
import { createPlace } from '../src/domain/places.js';
import { setSettings } from '../src/domain/settings.js';
import { parseDate, parseDuration, parseTime } from '../src/util/datetime.js';
import { normaliseCode, randomCode } from '../src/util/ids.js';
import { formatMoney, parseMoneyToCents, splitCents } from '../src/util/money.js';
import { booking, freshDb, inHours, user } from './helpers.js';

beforeEach(() => freshDb());

describe('waiting list', () => {
  it('waitlists players past max and promotes the first in line when a slot frees', () => {
    const alice = user('Alice');
    const players = ['Bob', 'Carol', 'Dave', 'Erin', 'Frank'].map(user);

    const b = booking(alice, { maxPlayers: 4 }); // Alice already occupies slot 1
    expect(joinBooking(b.code, players[0]!).ok).toBe(true);
    expect(joinBooking(b.code, players[1]!).ok).toBe(true);
    expect(joinBooking(b.code, players[2]!).ok).toBe(true);

    const erin = joinBooking(b.code, players[3]!);
    const frank = joinBooking(b.code, players[4]!);
    expect(erin.ok && erin.outcome).toBe('waitlisted');
    expect(erin.ok && erin.outcome === 'waitlisted' && erin.position).toBe(1);
    expect(frank.ok && frank.outcome === 'waitlisted' && frank.position).toBe(2);

    // Bob drops out well before the deadline; Erin should be pulled in, not Frank.
    const leave = leaveBooking(b.code, players[0]!);
    expect(leave.ok && leave.outcome === 'left' && leave.promoted?.user_id).toBe(players[3]!.id);

    const roster = getRoster(b.id);
    expect(roster.confirmed).toHaveLength(4);
    expect(roster.waitlist.map((p) => p.user_id)).toEqual([players[4]!.id]);
  });

  it('lets someone leave the waiting list without any consequence', () => {
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { maxPlayers: 1 });
    joinBooking(b.code, bob);

    const leave = leaveBooking(b.code, bob);
    expect(leave.ok && leave.outcome).toBe('left_waitlist');
    expect(getRoster(b.id).waitlist).toHaveLength(0);
  });

  it('sends a re-joining player to the back of the queue', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');

    const b = booking(alice, { maxPlayers: 2 });
    joinBooking(b.code, bob); // confirmed, court full
    joinBooking(b.code, carol); // waitlisted

    leaveBooking(b.code, bob); // Carol promoted into the free slot
    expect(getRoster(b.id).confirmed.map((p) => p.user_id)).toEqual([alice.id, carol.id]);

    const rejoin = joinBooking(b.code, bob);
    expect(rejoin.ok && rejoin.outcome).toBe('waitlisted');
  });

  it('rejects joining twice', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice);

    expect(joinBooking(b.code, bob).ok).toBe(true);
    const again = joinBooking(b.code, bob);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already_in');
  });
});

describe('double booking', () => {
  it('rejects a booking that overlaps an existing one', () => {
    const alice = user('Alice');
    const place = createPlace({ name: 'Padel Base' });
    const start = inHours(48);

    booking(alice, { startsAtIso: start, durationMin: 90 });

    // Starts 60 minutes in — still inside the first 90-minute slot.
    const overlapping = createBooking({
      creator: alice,
      placeId: place.id,
      startsAtIso: DateTime.fromISO(start).plus({ minutes: 60 }).toISO()!,
      totalCostCents: 4000,
      durationMin: 90,
    });

    expect(overlapping.ok).toBe(false);
    if (!overlapping.ok) expect(overlapping.reason).toBe('overlap');
  });

  it('allows a booking that starts exactly when the previous one ends', () => {
    const alice = user('Alice');
    const place = createPlace({ name: 'Padel Base' });
    const start = inHours(48);

    booking(alice, { startsAtIso: start, durationMin: 90 });

    const adjacent = createBooking({
      creator: alice,
      placeId: place.id,
      startsAtIso: DateTime.fromISO(start).plus({ minutes: 90 }).toISO()!,
      totalCostCents: 4000,
      durationMin: 90,
    });

    expect(adjacent.ok).toBe(true);
  });

  it('frees the slot again once the clashing booking is cancelled', () => {
    const alice = user('Alice');
    const place = createPlace({ name: 'Padel Base' });
    const start = inHours(48);

    const first = booking(alice, { startsAtIso: start });
    cancelBooking(first.code, alice, false);

    const replacement = createBooking({
      creator: alice,
      placeId: place.id,
      startsAtIso: start,
      totalCostCents: 4000,
    });
    expect(replacement.ok).toBe(true);
  });

  it('rejects a booking in the past', () => {
    const alice = user('Alice');
    const place = createPlace({ name: 'Padel Base' });

    const result = createBooking({
      creator: alice,
      placeId: place.id,
      startsAtIso: inHours(-2),
      totalCostCents: 4000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('in_past');
  });
});

describe('permissions', () => {
  it('only lets the creator or an admin cancel a booking', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice);

    const byBob = cancelBooking(b.code, bob, false);
    expect(byBob.ok).toBe(false);
    if (!byBob.ok) expect(byBob.reason).toBe('not_allowed');

    expect(cancelBooking(b.code, bob, true).ok).toBe(true); // admin override
  });

  it('honours the admin lock on per-booking cancellation limits', () => {
    setSettings({ allowPerBookingCancelLimit: false, defaultCancelLimitHours: 24 });
    const alice = user('Alice');
    const place = createPlace({ name: 'Padel Base' });

    const result = createBooking({
      creator: alice,
      placeId: place.id,
      startsAtIso: inHours(72),
      totalCostCents: 4000,
      cancelLimitHours: 48,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cancel_limit_locked');
  });

  it('blocks a free-text place when the admin restricted bookings to the club list', () => {
    setSettings({ allowCustomPlaces: false });
    const alice = user('Alice');

    const result = createBooking({
      creator: alice,
      customPlace: 'Some random court',
      startsAtIso: inHours(72),
      totalCostCents: 4000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('custom_place_not_allowed');
  });
});

describe('money helpers', () => {
  it('parses the shapes people actually type', () => {
    expect(parseMoneyToCents('40')).toBe(4000);
    expect(parseMoneyToCents('40.50')).toBe(4050);
    expect(parseMoneyToCents('40,50')).toBe(4050);
    expect(parseMoneyToCents('€40')).toBe(4000);
    expect(parseMoneyToCents('1200')).toBe(120000);
    expect(parseMoneyToCents('abc')).toBeNull();
  });

  it('rejects ambiguous separator input rather than guessing at the amount', () => {
    // "1.200" could be €1200 or a typo for €1.20; "40.999" is clearly a slip.
    // Both must be refused so the user retypes, never silently interpreted.
    expect(parseMoneyToCents('40.999')).toBeNull();
    expect(parseMoneyToCents('1.200')).toBeNull();
  });

  it('formats with the currency symbol', () => {
    expect(formatMoney(1000)).toBe('€10.00');
    expect(formatMoney(-250)).toBe('-€2.50');
  });

  it('never loses a cent when splitting', () => {
    for (const [total, n] of [
      [4000, 3],
      [1, 4],
      [9999, 7],
      [10, 3],
    ] as const) {
      const shares = splitCents(total, n);
      expect(shares).toHaveLength(n);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
  });
});

describe('date and time parsing', () => {
  const tz = 'Europe/Berlin';
  const now = DateTime.fromISO('2026-08-26T10:00:00', { zone: tz }); // a Wednesday

  it('parses the formats a WhatsApp user would type', () => {
    expect(parseDate('2026-09-03', tz, now)?.toISODate()).toBe('2026-09-03');
    expect(parseDate('03/09', tz, now)?.toISODate()).toBe('2026-09-03');
    expect(parseDate('3.9.', tz, now)?.toISODate()).toBe('2026-09-03');
    expect(parseDate('3/9/26', tz, now)?.toISODate()).toBe('2026-09-03');
    expect(parseDate('today', tz, now)?.toISODate()).toBe('2026-08-26');
    expect(parseDate('tomorrow', tz, now)?.toISODate()).toBe('2026-08-27');
    expect(parseDate('morgen', tz, now)?.toISODate()).toBe('2026-08-27');
  });

  it('rolls a bare day/month forward instead of booking into the past', () => {
    expect(parseDate('01/02', tz, now)?.toISODate()).toBe('2027-02-01');
  });

  it('reads a weekday as the next one, never today', () => {
    expect(parseDate('friday', tz, now)?.toISODate()).toBe('2026-08-28');
    expect(parseDate('wednesday', tz, now)?.toISODate()).toBe('2026-09-02');
    expect(parseDate('sexta', tz, now)?.toISODate()).toBe('2026-08-28');
  });

  it('parses times', () => {
    expect(parseTime('19:00')).toEqual({ hour: 19, minute: 0 });
    expect(parseTime('19h30')).toEqual({ hour: 19, minute: 30 });
    expect(parseTime('7pm')).toEqual({ hour: 19, minute: 0 });
    expect(parseTime('1930')).toEqual({ hour: 19, minute: 30 });
    expect(parseTime('19')).toEqual({ hour: 19, minute: 0 });
    expect(parseTime('25:00')).toBeNull();
  });

  it('parses durations', () => {
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('90m')).toBe(90);
    expect(parseDuration('1h')).toBe(60);
    expect(parseDuration('1h30')).toBe(90);
    expect(parseDuration('1.5h')).toBe(90);
  });
});

describe('booking codes', () => {
  it('avoids glyphs that are easy to mistype', () => {
    for (let i = 0; i < 500; i++) {
      expect(randomCode()).not.toMatch(/[01OIL5S8BUV]/);
    }
  });

  it('accepts sloppy user input', () => {
    expect(normaliseCode(' a7k2 ')).toBe('A7K2');
    expect(normaliseCode('#A7-K2')).toBe('A7K2');
  });
});
