import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelBooking,
  createExternalBooking,
  editBooking,
  findBookingById,
  getRoster,
  joinBooking,
  cancellationDeadline,
} from '../src/domain/bookings.js';
import { settleBooking } from '../src/domain/ledger.js';
import { createPlace } from '../src/domain/places.js';
import { booking, freshDb, inHours, user } from './helpers.js';

beforeEach(() => freshDb());

describe('editing a booking schedule', () => {
  it('moves the start time and reports that the schedule changed', () => {
    const b = booking(user('Alice'), { startsAtIso: inHours(48) });
    const newStart = inHours(72);

    const result = editBooking(b.id, { startsAtIso: newStart });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheduleChanged).toBe(true);
    expect(result.previousStartsAt).toBe(b.starts_at);
    expect(findBookingById(b.id)!.starts_at).toBe(newStart);
  });

  it('moves the free-cancellation deadline with the game', () => {
    const b = booking(user('Alice'), { startsAtIso: inHours(48), cancelLimitHours: 24 });
    const before = cancellationDeadline(b);

    editBooking(b.id, { startsAtIso: inHours(96) });
    const after = cancellationDeadline(findBookingById(b.id)!);

    expect(after).not.toBe(before);
    // Still exactly 24h before the new start.
    const start = DateTime.fromISO(findBookingById(b.id)!.starts_at, { zone: 'utc' });
    expect(DateTime.fromISO(after, { zone: 'utc' }).plus({ hours: 24 }).toISO()).toBe(start.toISO());
  });

  it('says nothing changed when only a note is edited', () => {
    const b = booking(user('Alice'));
    const result = editBooking(b.id, { notes: 'bring balls' });

    expect(result.ok && result.scheduleChanged).toBe(false);
    expect(findBookingById(b.id)!.notes).toBe('bring balls');
  });

  it('refuses to move onto another booking', () => {
    const alice = user('Alice');
    const first = booking(alice, { startsAtIso: inHours(24), durationMin: 90 });
    const second = booking(alice, { startsAtIso: inHours(48), durationMin: 90 });

    const clash = DateTime.fromISO(first.starts_at).plus({ minutes: 30 }).toISO()!;
    const result = editBooking(second.id, { startsAtIso: clash });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'overlap') {
      expect(result.conflict.code).toBe(first.code);
    } else {
      throw new Error('expected an overlap');
    }
    // The failed edit must not have been applied.
    expect(findBookingById(second.id)!.starts_at).toBe(second.starts_at);
  });

  it('does not collide with itself when only the cost changes', () => {
    const b = booking(user('Alice'));
    const result = editBooking(b.id, { totalCostCents: 5000 });

    expect(result.ok).toBe(true);
    expect(findBookingById(b.id)!.total_cost_cents).toBe(5000);
  });

  it('lets a booking keep its own slot while other fields move', () => {
    const b = booking(user('Alice'), { startsAtIso: inHours(48) });
    const result = editBooking(b.id, { startsAtIso: b.starts_at, court: '7' });

    expect(result.ok).toBe(true);
    expect(findBookingById(b.id)!.court).toBe('7');
  });

  it('refuses to move a live booking into the past', () => {
    // Auto-settlement would fire within hours and turn a typo into real debts.
    const b = booking(user('Alice'));
    const result = editBooking(b.id, { startsAtIso: inHours(-5) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('in_past');
  });

  it('refuses to edit a cancelled or settled booking', () => {
    const alice = user('Alice');

    const cancelled = booking(alice, { startsAtIso: inHours(24) });
    cancelBooking(cancelled.code, alice, true);
    const r1 = editBooking(cancelled.id, { startsAtIso: inHours(96) });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('not_editable');

    const settled = booking(alice, { startsAtIso: inHours(200) });
    settleBooking(settled.id);
    const r2 = editBooking(settled.id, { startsAtIso: inHours(300) });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('not_editable');
  });

  it('rejects a maximum below the minimum', () => {
    const b = booking(user('Alice'), { minPlayers: 4, maxPlayers: 4 });
    const result = editBooking(b.id, { maxPlayers: 2 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_players');
  });

  it('pulls the waiting list up when seats are added', () => {
    const alice = user('Alice');
    const b = booking(alice, { maxPlayers: 2 });
    joinBooking(b.code, user('Bob'));
    const carol = user('Carol');
    joinBooking(b.code, carol); // waitlisted, court full

    expect(getRoster(b.id).waitlist).toHaveLength(1);

    editBooking(b.id, { maxPlayers: 4 });

    expect(getRoster(b.id).waitlist).toHaveLength(0);
    expect(getRoster(b.id).confirmed.map((p) => p.user_id)).toContain(carol.id);
  });

  it('can reschedule a Playtomic booking too', () => {
    const created = createExternalBooking({
      creator: user('Alice'),
      provider: 'Playtomic',
      url: 'https://playtomic.io/m/1',
      startsAtIso: inHours(24),
    });
    if (!created.ok) throw new Error('setup failed');

    const result = editBooking(created.booking.id, { startsAtIso: inHours(72) });
    expect(result.ok && result.scheduleChanged).toBe(true);
  });

  it('can move the booking to a different club', () => {
    const b = booking(user('Alice'));
    const other = createPlace({ name: 'Другой Club' });

    const result = editBooking(b.id, { placeId: other.id });
    expect(result.ok).toBe(true);
    expect(findBookingById(b.id)!.place_id).toBe(other.id);
    expect(findBookingById(b.id)!.custom_place).toBeNull();
  });
});
