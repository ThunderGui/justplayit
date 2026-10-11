import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBooking,
  createExternalBooking,
  joinBooking,
  leaveBooking,
  listUpcoming,
} from '../src/domain/bookings.js';
import { balanceFor, settleBooking } from '../src/domain/ledger.js';
import { createPlace } from '../src/domain/places.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

beforeEach(() => freshDb());

function playtomic(creator = user('Alice'), overrides: { startsAtIso?: string; url?: string } = {}) {
  const result = createExternalBooking({
    groupId: GROUP,
    creator,
    provider: 'Playtomic',
    url: overrides.url ?? 'https://playtomic.io/tenant/match/abc123',
    startsAtIso: overrides.startsAtIso ?? inHours(48),
    durationMin: 90,
    customPlace: 'Padel Base',
  });
  if (!result.ok) throw new Error(`external booking failed: ${result.reason}`);
  return result.booking;
}

describe('external (Playtomic) bookings', () => {
  it('stores the provider and link, and carries no cost', () => {
    const b = playtomic();
    expect(b.kind).toBe('EXTERNAL');
    expect(b.external_provider).toBe('Playtomic');
    expect(b.external_url).toBe('https://playtomic.io/tenant/match/abc123');
    expect(b.total_cost_cents).toBe(0);
  });

  it('shows up in the calendar alongside managed bookings', () => {
    const alice = user('Alice');
    booking(alice, { startsAtIso: inHours(24) });
    playtomic(alice, { startsAtIso: inHours(48) });

    const upcoming = listUpcoming(GROUP);
    expect(upcoming).toHaveLength(2);
    expect(upcoming.map((b) => b.kind)).toEqual(['MANAGED', 'EXTERNAL']);
  });

  it('rejects a link that is not a real URL', () => {
    const result = createExternalBooking({
      groupId: GROUP,
      creator: user('Alice'),
      provider: 'Playtomic',
      url: 'playtomic app match 12',
      startsAtIso: inHours(48),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_url');
  });

  it('keeps no roster — joining and leaving are refused', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = playtomic(alice);

    const join = joinBooking(b.code, bob);
    expect(join.ok).toBe(false);
    if (!join.ok) expect(join.reason).toBe('external');

    const leave = leaveBooking(b.code, bob);
    expect(leave.ok).toBe(false);
    if (!leave.ok) expect(leave.reason).toBe('external');
  });

  it('never reaches the ledger', () => {
    const alice = user('Alice');
    const b = playtomic(alice);

    const settle = settleBooking(b.id);
    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.reason).toBe('external');

    expect(balanceFor(alice.id, GROUP)).toEqual([]);
  });

  it('still blocks the time slot against a clashing managed booking', () => {
    const alice = user('Alice');
    const place = createPlace({ groupId: GROUP, name: 'Padel Base' });
    const start = inHours(48);

    playtomic(alice, { startsAtIso: start });

    const clash = createBooking({
      groupId: GROUP,
      creator: alice,
      placeId: place.id,
      startsAtIso: DateTime.fromISO(start).plus({ minutes: 30 }).toISO()!,
      totalCostCents: 4000,
      durationMin: 90,
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.reason).toBe('overlap');
  });

  it('is itself blocked by an existing managed booking at the same time', () => {
    const alice = user('Alice');
    const start = inHours(48);
    booking(alice, { startsAtIso: start, durationMin: 90 });

    const result = createExternalBooking({
      groupId: GROUP,
      creator: alice,
      provider: 'Playtomic',
      url: 'https://playtomic.io/tenant/match/abc123',
      startsAtIso: DateTime.fromISO(start).plus({ minutes: 30 }).toISO()!,
      durationMin: 90,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('overlap');
  });
});
