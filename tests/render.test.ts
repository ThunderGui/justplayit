import { beforeEach, describe, expect, it } from 'vitest';
import { bookingCard, bookingList } from '../src/bot/render.js';
import { createBooking, joinBooking, listUpcoming } from '../src/domain/bookings.js';
import { createPlace } from '../src/domain/places.js';
import { t } from '../src/i18n/index.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

const dict = t('en');

beforeEach(() => freshDb());

describe('per-player estimate on a booking card', () => {
  it('does not claim the whole cost per player on a brand new booking', () => {
    // The reported bug: €40 across a court for 8, one player on the sheet so
    // far, showed "per player ~€40.00".
    const b = booking(user('Guilherme'), {
      totalCostCents: 4000,
      minPlayers: 4,
      maxPlayers: 8,
    });

    const card = bookingCard(b, dict);
    expect(card).toContain('€40.00');
    expect(card).toContain('~€10.00 each at 4 players');
    expect(card).not.toContain('~€40.00 each');
  });

  it('uses the real headcount once it passes the minimum', () => {
    const alice = user('Alice');
    const b = booking(alice, { totalCostCents: 4000, minPlayers: 2, maxPlayers: 8 });
    for (const name of ['Bob', 'Carol', 'Dave']) joinBooking(b.code, user(name));

    // Four confirmed beats the minimum of two, so the split tightens.
    expect(bookingCard(b, dict)).toContain('~€10.00 each at 4 players');
  });

  it('keeps the estimate at the minimum while the game is under-filled', () => {
    const alice = user('Alice');
    const b = booking(alice, { totalCostCents: 6000, minPlayers: 4, maxPlayers: 4 });
    joinBooking(b.code, user('Bob'));

    // Two on the sheet, but the group is planning for four.
    expect(bookingCard(b, dict)).toContain('~€15.00 each at 4 players');
  });
});

describe('list shows who is in', () => {
  it('names the confirmed players under each game', () => {
    const alice = user('Alice');
    const b = booking(alice, { maxPlayers: 4 });
    joinBooking(b.code, user('Bob'));
    joinBooking(b.code, user('Carol'));

    const list = bookingList(listUpcoming(GROUP), dict);
    expect(list).toContain('Alice, Bob, Carol');
  });

  it('says so when nobody has joined yet', () => {
    booking(user('Alice'), { joinAsPlayer: false });
    expect(bookingList(listUpcoming(GROUP), dict)).toContain('nobody yet');
  });

  it('leaves waiting-list players out of the confirmed line', () => {
    const alice = user('Alice');
    const b = booking(alice, { maxPlayers: 2 });
    joinBooking(b.code, user('Bob'));
    joinBooking(b.code, user('Carol')); // waitlisted

    const list = bookingList(listUpcoming(GROUP), dict);
    expect(list).toContain('Alice, Bob');
    expect(list).not.toContain('Carol');
    expect(list).toContain('+1'); // still counted as waiting
  });
});

describe('list shows the venue details', () => {
  it('shows court, address and notes when the booking has them', () => {
    const alice = user('Alice');
    const place = createPlace({
      groupId: GROUP,
      name: 'Ocean Athletics Club',
      address: 'Jean-Gardner-Batten-Straße 1, 60549 Frankfurt am Main',
    });
    const created = createBooking({
      groupId: GROUP,
      creator: alice,
      placeId: place.id,
      startsAtIso: inHours(48),
      totalCostCents: 4000,
      minPlayers: 4,
      maxPlayers: 8,
      court: '2',
      notes: '2 hours booking',
    });
    if (!created.ok) throw new Error('setup failed');

    const list = bookingList(listUpcoming(GROUP), dict);
    expect(list).toContain('Court 2');
    expect(list).toContain('Jean-Gardner-Batten-Straße 1');
    expect(list).toContain('Notes: 2 hours booking');
    expect(list).toContain('Alice');
  });

  it('omits what the booking does not have', () => {
    const alice = user('Alice');
    const place = createPlace({ groupId: GROUP, name: 'Bare Club' });
    const created = createBooking({
      groupId: GROUP,
      creator: alice,
      placeId: place.id,
      startsAtIso: inHours(48),
      totalCostCents: 4000,
    });
    if (!created.ok) throw new Error('setup failed');

    const list = bookingList(listUpcoming(GROUP), dict);
    expect(list).not.toContain('Court');
    expect(list).not.toContain('Notes:');
  });

  it('does not repeat a free-text place as its own address', () => {
    const created = createBooking({
      groupId: GROUP,
      creator: user('Alice'),
      customPlace: 'Some random court',
      startsAtIso: inHours(48),
      totalCostCents: 4000,
    });
    if (!created.ok) throw new Error('setup failed');

    const list = bookingList(listUpcoming(GROUP), dict);
    // Once on the booking row, never echoed back as an address line.
    expect(list.match(/Some random court/g)).toHaveLength(1);
  });
});
